/**
 * The launcher's private-target gate (`ops/hosted-autonomy-private-targets.ts`)
 * round-trips every write: hidden rows of every collection the repair
 * snapshot contract names a repository in come back byte-identical and in
 * place; a write naming a hidden repository, or one that would compact a
 * ledger holding hidden reservations, is refused with a closed reason and
 * nothing is written; visibility is one read per repository per run, unknown
 * is hidden, and Sentinel's own repository is never read or hidden.
 */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  portError,
  portOk,
  type PortResultV1,
  type RepairStateWriter,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import type { StateReadResultV1 } from "../../src/contracts/ports-state.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { MaxItems } from "../../src/contracts/validation.ts";
import type { TargetVisibilityV1 } from "../../src/repair/target-visibility.ts";
import {
  createPrivateTargetGateV1,
  REPOSITORY_COLLECTIONS,
  SNAPSHOT_FIELDS,
} from "../../ops/hosted-autonomy-private-targets.ts";

const PUBLIC = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 };
const PRIVATE = { owner: "ubiquity", name: "prospector", installationId: 7 };
const SELF = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 5,
};
const HEAD0 = "1".repeat(40) as GitSha;

/** One row of `collection` naming `repository`, distinct by `tag`. */
function row(
  collection: string,
  repository: typeof PUBLIC,
  tag: string,
): Record<string, unknown> {
  const id = `${collection}-${repository.name}-${tag}`;
  if (collection === "releaseRequests") {
    return { id, target: { repository, environment: "production" }, tag };
  }
  if (collection === "ownerSuccessorReviews") {
    return { id, reservation: { id: `${id}-r`, repository }, tag };
  }
  return { id, taskId: `task-${repository.name}-${tag}`, repository, tag };
}

/** Every repository-bearing collection: public, PRIVATE (middle), public. */
function seeded(): RepairStateSnapshotV1 {
  const snapshot: Record<string, unknown> = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: 1,
    githubCooldowns: [],
    tierScans: [],
  };
  for (const collection of Object.keys(REPOSITORY_COLLECTIONS)) {
    snapshot[collection] = [
      row(collection, PUBLIC, "a"),
      row(collection, PRIVATE, "hidden-1"),
      row(collection, PUBLIC, "b"),
      row(collection, PRIVATE, "hidden-2"),
      row(collection, SELF, "c"),
    ];
  }
  return snapshot as unknown as RepairStateSnapshotV1;
}

/** A store that keeps exactly what is written (no parse, no compaction). */
class RecordingState implements StateReadView, RepairStateWriter {
  writes = 0;
  constructor(public snapshot: RepairStateSnapshotV1, public head = HEAD0) {}
  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    return Promise.resolve(portOk({
      status: "found",
      snapshot: this.snapshot,
      head: this.head,
      ref: "refs/heads/sentinel-state/repair",
    }));
  }
  readRelease(): never {
    throw new Error("unused");
  }
  writeRepair(next: RepairStateSnapshotV1, expectedHead: GitSha | null) {
    if (expectedHead !== this.head) {
      return Promise.resolve(portError("unavailable", "conflict"));
    }
    this.writes++;
    this.snapshot = structuredClone(next);
    this.head = String(this.writes).padStart(40, "a") as GitSha;
    return Promise.resolve(
      portOk({ status: "applied" as const, head: this.head }),
    );
  }
}

function gate(answers: Record<string, TargetVisibilityV1 | Error>) {
  const reads: string[] = [];
  const instance = createPrivateTargetGateV1({
    readVisibility: (repository) => {
      reads.push(repository.name);
      const answer = answers[repository.name];
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer ?? "unknown");
    },
  });
  return { gate: instance, reads };
}

function hiddenRows(snapshot: RepairStateSnapshotV1) {
  const out: string[] = [];
  for (const collection of Object.keys(REPOSITORY_COLLECTIONS)) {
    const list = (snapshot as unknown as Record<string, unknown[]>)[collection];
    list.forEach((entry, index) => {
      if (canonicalStringify(entry).includes("prospector")) {
        out.push(`${collection}[${index}]=${canonicalStringify(entry)}`);
      }
    });
  }
  return out;
}

Deno.test("private target gate: the contract's every field is classified, and every repository-bearing collection has a reader", () => {
  const repository = Object.entries(SNAPSHOT_FIELDS)
    .filter(([, kind]) => kind === "repository").map(([field]) => field)
    .sort();
  assert.deepEqual(repository, Object.keys(REPOSITORY_COLLECTIONS).sort());
  assert.deepEqual(
    Object.entries(SNAPSHOT_FIELDS).filter(([, kind]) => kind === "free")
      .map(([field]) => field).sort(),
    ["githubCooldowns", "tierScans"],
  );
});

Deno.test("private target gate: reads hide every hidden row; a pass's write gets them back byte-identical and in place", async () => {
  const input = seeded();
  const before = hiddenRows(input);
  assert.equal(before.length, Object.keys(REPOSITORY_COLLECTIONS).length * 2);
  const store = new RecordingState(structuredClone(input));
  const { gate: g, reads } = gate({
    "ai.ubq.fi": "public",
    prospector: "private",
  });
  const state = g.wrapState(store);
  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  assert.deepEqual(hiddenRows(read.value.snapshot), [], "the view hides them");
  assert.deepEqual(
    reads.sort(),
    ["ai.ubq.fi", "prospector"],
    "self is never read",
  );
  // A pass edits every visible row in place (same count, same order).
  const next = structuredClone(read.value.snapshot) as unknown as Record<
    string,
    Record<string, unknown>[]
  >;
  for (const collection of Object.keys(REPOSITORY_COLLECTIONS)) {
    for (const entry of next[collection]) entry.tag = `${entry.tag}-edited`;
  }
  const written = await state.writeRepair(
    next as unknown as RepairStateSnapshotV1,
    read.value.head,
  );
  assert.ok(written.ok, JSON.stringify(written));
  assert.deepEqual(
    hiddenRows(store.snapshot),
    before,
    "byte-identical, same index",
  );
  for (const collection of Object.keys(REPOSITORY_COLLECTIONS)) {
    const list = (store.snapshot as unknown as Record<
      string,
      Record<string, unknown>[]
    >)[collection];
    assert.deepEqual(
      list.map((entry) => entry.tag),
      ["a-edited", "hidden-1", "b-edited", "hidden-2", "c-edited"],
      collection,
    );
  }
  // A pass that appends and removes visible rows: hidden rows stay after the
  // same number of visible rows, still byte-identical.
  const again = await state.readRepair();
  assert.ok(again.ok && again.value.status === "found");
  const grown = structuredClone(again.value.snapshot) as unknown as Record<
    string,
    Record<string, unknown>[]
  >;
  for (const collection of Object.keys(REPOSITORY_COLLECTIONS)) {
    grown[collection].push(row(collection, PUBLIC, "new"));
  }
  assert.ok(
    (await state.writeRepair(
      grown as unknown as RepairStateSnapshotV1,
      again.value.head,
    )).ok,
  );
  assert.deepEqual(
    hiddenRows(store.snapshot).map((entry) => entry.replace(/\[\d+\]/, "")),
    before.map((entry) => entry.replace(/\[\d+\]/, "")),
  );
  assert.equal(reads.length, 2, "one visibility read per repository per run");
});

Deno.test("private target gate: a write naming a hidden repository or compacting its ledger is refused, nothing written", async () => {
  const store = new RecordingState(seeded());
  const { gate: g } = gate({ "ai.ubq.fi": "public", prospector: "private" });
  const state = g.wrapState(store);
  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const added = structuredClone(read.value.snapshot) as unknown as Record<
    string,
    unknown[]
  >;
  added.work.push(row("work", PRIVATE, "new"));
  const refused = await state.writeRepair(
    added as unknown as RepairStateSnapshotV1,
    read.value.head,
  );
  assert.equal(refused.ok, false);
  assert.match(
    !refused.ok ? refused.error.detail : "",
    /^private_repository: private_repository_row:work$/,
  );
  // A ledger past its bound would be compacted by the store: refused.
  const full = structuredClone(read.value.snapshot) as unknown as Record<
    string,
    unknown[]
  >;
  for (let index = 0; index < MaxItems.snapshotRecords; index++) {
    full.reservations.push(row("reservations", PUBLIC, `bulk-${index}`));
  }
  const compacting = await state.writeRepair(
    full as unknown as RepairStateSnapshotV1,
    read.value.head,
  );
  assert.equal(compacting.ok, false);
  assert.match(
    !compacting.ok ? compacting.error.detail : "",
    /private_repository_compaction:reservations$/,
  );
  assert.equal(store.writes, 0, "nothing was written");
  assert.deepEqual(g.line(), {
    kind: "sentinel_private_targets_hidden",
    reason: "private_repository",
    repositories: 1,
    rows: Object.keys(REPOSITORY_COLLECTIONS).length * 2,
    refusedWrites: 2,
  });
});

Deno.test("private target gate: unknown or unreadable visibility hides; surfaces exist only for proven-public repositories and self", async () => {
  for (const answer of ["unknown", new Error("read failed")] as const) {
    const store = new RecordingState(seeded());
    const { gate: g } = gate({ "ai.ubq.fi": "public", prospector: answer });
    const state = g.wrapState(store);
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.deepEqual(hiddenRows(read.value.snapshot), []);
    const githubFor = g.githubFor((repository) => repository.name);
    assert.equal(githubFor(PUBLIC), "ai.ubq.fi");
    assert.equal(githubFor(PRIVATE), null);
    assert.equal(githubFor(SELF), "sentinel");
    assert.equal(
      githubFor({ owner: "ubiquity", name: "never-read", installationId: 7 }),
      null,
      "a repository not proven public this run has no surface",
    );
  }
  // Self is never read and never hidden, even when every read fails.
  const { gate: failing, reads } = gate({});
  assert.equal(await failing.workable(SELF), true);
  assert.deepEqual(reads, []);
  // A run whose state names no hidden repository is a pure pass-through.
  const publicOnly = structuredClone(seeded()) as unknown as Record<
    string,
    unknown[]
  >;
  for (const collection of Object.keys(REPOSITORY_COLLECTIONS)) {
    publicOnly[collection] = publicOnly[collection].filter((entry) =>
      !canonicalStringify(entry).includes("prospector")
    );
  }
  const store = new RecordingState(
    publicOnly as unknown as RepairStateSnapshotV1,
  );
  const { gate: open } = gate({ "ai.ubq.fi": "public" });
  const read = await open.wrapState(store).readRepair();
  assert.ok(read.ok && read.value.status === "found");
  assert.equal(read.value.snapshot, store.snapshot, "the same object");
  assert.equal(open.line(), null);
});
