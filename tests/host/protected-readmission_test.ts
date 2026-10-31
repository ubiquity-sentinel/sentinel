/**
 * C6 fact exit (redesign 2026-10-25): an open issue's `sentinel:retry` label
 * re-admits its protected-path park ONCE, through the REAL protected
 * maintenance pass over a real Git repair store and a fake label surface.
 * The label is removed first; only a confirmed removal returns the record to
 * `work` (uncharged, the protected candidate dropped); a failed removal and a
 * closed issue re-admit nothing. Sanitized from the live ai.ubq.fi 262 park.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedRetryLabelV1,
} from "../../ops/hosted-autonomy-types.ts";
import {
  dropProtectedCandidates,
  PROTECTED_READMISSION_DETAIL,
  protectedReadmissionShape,
} from "../../ops/hosted-autonomy-protected-readmission.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";

const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
const BASE = "593ef22aa923cef7faf0822708cf049651f76568" as GitSha;
const PROTECTED_HEAD = "ee2d229937abfd3088d72ea6d48d41ac73001e7f" as GitSha;
const PUBLISHED = "7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d7c1d" as GitSha;

/** The fresh park: no PR, no published head, the protected head kept. */
function freshPark(issue = 262): WorkRecordV1 {
  const id = `issue-ubiquity-ai.ubq.fi-${issue}`;
  return parseWorkRecordV1({
    version: "v1",
    kind: "work",
    repository: AI,
    id,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    fingerprint: null,
    failingRevision: null,
    sourceSnapshotDigest: null,
    classification: { severity: "P2", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    dependencies: [],
    controller: { sha: SHA1 },
    target: {
      base: BASE,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: PROTECTED_HEAD,
      pr: null,
      candidateState: { preserved: null, publishedHead: null },
    },
    nextStep: "blocked",
    wait: null,
    blocker: {
      kind: "other",
      message: "candidate touches a protected path",
      since: T0 + 1000,
    },
    counters: { attempts: 4, retries: 0, reviewRounds: 0 },
    evidence: [],
    intent: null,
    firstSeenAt: T0,
    createdAt: T0 + 100,
    updatedAt: T0 + 1000,
  });
}

/** A park over a published pull request (a correction's protected head). */
function publishedPark(): WorkRecordV1 {
  const fresh = freshPark(8);
  return parseWorkRecordV1({
    ...fresh,
    target: {
      ...fresh.target,
      pr: 172,
      candidateState: { preserved: null, publishedHead: PUBLISHED },
    },
  });
}

/** The task's four submitted charges: the re-admission charges nothing. */
function charges(record: WorkRecordV1) {
  return [1, 2, 3, 4].map((attempt) =>
    reservation(`${String(attempt).repeat(8)}-0000-4000-8000-000000000000`, {
      repository: AI,
      taskId: record.id,
      head: BASE,
      attempt,
      purpose: attempt === 1 ? "implementation" : "retry",
      outcome: "submitted",
      settledAt: T0 + 50,
    })
  );
}

interface LabelFake extends HostedRetryLabelV1 {
  listed: number;
  removed: number[];
}

function labelFake(
  labelled: Set<number>,
  removal: (number: number) => boolean = () => true,
): LabelFake {
  const fake: LabelFake = {
    listed: 0,
    removed: [],
    listOpenRetryLabeled: () => {
      fake.listed++;
      return Promise.resolve(new Set(labelled));
    },
    removeRetryLabel: (number: number) => {
      fake.removed.push(number);
      const ok = removal(number);
      if (ok) labelled.delete(number);
      return Promise.resolve(ok);
    },
  };
  return fake;
}

async function rigWith(
  records: WorkRecordV1[],
  label: LabelFake,
  issueOpen = true,
) {
  const { rig, github } = await makeRig("protected-readmit", {
    repair: repairSnapshot(records, [], [], charges(records[0])),
    issueOpen,
  });
  const surface: HostedAutonomyGitHubV1 = { ...github, retryLabel: label };
  return { rig, surface };
}

async function readSnapshot(
  rig: Awaited<ReturnType<typeof rigWith>>["rig"],
): Promise<RepairStateSnapshotV1> {
  const read = await rig.state.readRepair();
  if (!read.ok || read.value.status !== "found") throw new Error("unreadable");
  return read.value.snapshot;
}

Deno.test("an open labelled protected park is re-admitted once, uncharged, with the protected candidate dropped", async () => {
  const park = freshPark();
  const label = labelFake(new Set([262]));
  const { rig, surface } = await rigWith([park], label);
  try {
    const before = await readSnapshot(rig);
    const result = await run(rig, surface);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(rig.writes, 1, "one CAS write");
    assert.deepEqual(label.removed, [262], "the label is removed first");
    assert.ok(
      result.actions.includes(
        `retry:${park.id}:grant=0:${PROTECTED_READMISSION_DETAIL}`,
      ),
      JSON.stringify(result.actions),
    );
    const after = await readSnapshot(rig);
    const resumed = after.work.find((row) => row.id === park.id)!;
    assert.equal(resumed.nextStep, "work");
    assert.equal(resumed.blocker, null);
    assert.equal(resumed.wait, null);
    assert.equal(resumed.intent, null);
    // The protected head never returns to `work`: the target is the fresh
    // shape the next start checks out from the current base.
    assert.deepEqual(resumed.target, {
      base: BASE,
      branch: park.target.branch,
      checkpoint: null,
      head: null,
      pr: null,
    });
    assert.deepEqual(resumed.counters, park.counters, "no history lowered");
    assert.deepEqual(after.reservations, before.reservations, "no charge");

    // The label is consumed: the next pass neither removes nor writes.
    const writes = rig.writes;
    const again = await run(rig, surface);
    assert.deepEqual(label.removed, [262]);
    assert.equal(rig.writes, writes, JSON.stringify(again));
    assert.ok(
      !again.actions.some((action) => action.includes("protected_path")),
      JSON.stringify(again.actions),
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("a failed label removal re-admits nothing", async () => {
  const park = freshPark();
  const label = labelFake(new Set([262]), () => false);
  const { rig, surface } = await rigWith([park], label);
  try {
    const result = await run(rig, surface);
    assert.deepEqual(label.removed, [262]);
    assert.equal(rig.writes, 0, JSON.stringify(result));
    assert.ok(
      result.actions.includes(
        `retry:${park.id}:skipped:retry_label_not_removed`,
      ),
      JSON.stringify(result.actions),
    );
    assert.deepEqual((await readSnapshot(rig)).work, [park]);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("a closed issue re-admits nothing and its label is left alone", async () => {
  // Closed as the pass's own issue read reports it.
  const park = freshPark();
  const closed = labelFake(new Set([262]));
  const first = await rigWith([park], closed, false);
  try {
    await run(first.rig, first.surface);
    assert.deepEqual(closed.removed, []);
    assert.equal(closed.listed, 0, "no label read for a closed issue");
    const work = (await readSnapshot(first.rig)).work;
    assert.equal(work.find((row) => row.id === park.id)?.nextStep, "blocked");
  } finally {
    await Deno.remove(first.rig.tmp, { recursive: true });
  }
  // Absent from the open-issue listing (closed there, or never labelled).
  const unlisted = labelFake(new Set([999]));
  const second = await rigWith([park], unlisted);
  try {
    const result = await run(second.rig, second.surface);
    assert.equal(unlisted.listed, 1);
    assert.deepEqual(unlisted.removed, []);
    assert.equal(second.rig.writes, 0, JSON.stringify(result));
    assert.deepEqual((await readSnapshot(second.rig)).work, [park]);
  } finally {
    await Deno.remove(second.rig.tmp, { recursive: true });
  }
});

Deno.test("a lost state write after the removal re-admits nothing and the label is not reused", async () => {
  const park = freshPark();
  const label = labelFake(new Set([262]));
  const { rig, surface } = await rigWith([park], label);
  const write = rig.state.writeRepair;
  rig.state.writeRepair = () =>
    Promise.resolve({
      ok: true,
      value: { status: "conflict", head: null },
    } as unknown as Awaited<ReturnType<typeof write>>);
  try {
    const result = await run(rig, surface);
    assert.equal(result.reason, "write_conflict", JSON.stringify(result));
    assert.deepEqual(label.removed, [262]);
    rig.state.writeRepair = write;
    const again = await run(rig, surface);
    assert.deepEqual(label.removed, [262], "the owner must label it again");
    assert.equal(rig.writes, 0, JSON.stringify(again));
    assert.deepEqual((await readSnapshot(rig)).work, [park]);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("a park over a published pull request is not this exit's and keeps its label", async () => {
  const park = publishedPark();
  const label = labelFake(new Set([8]));
  const { rig, surface } = await rigWith([park], label);
  try {
    assert.equal(protectedReadmissionShape(park), false);
    await run(rig, surface);
    assert.deepEqual(label.removed, []);
    const row = (await readSnapshot(rig)).work.find((r) => r.id === park.id);
    assert.equal(row?.nextStep, "blocked");
    assert.equal(row?.target.head, PROTECTED_HEAD);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("dropping a candidate refuses a record that lost its park shape", () => {
  const park = freshPark();
  const snapshot = repairSnapshot([park], [], [], []);
  const moved = repairSnapshot(
    [parseWorkRecordV1({ ...park, nextStep: "work", blocker: null })],
    [],
    [],
    [],
  );
  const taken = [{ id: park.id, repository: AI, issueNumber: 262 }];
  assert.equal(
    dropProtectedCandidates(snapshot, taken).work[0].target.head,
    null,
  );
  assert.throws(() => dropProtectedCandidates(moved, taken), TypeError);
  assert.equal(dropProtectedCandidates(snapshot, []), snapshot);
});
