/**
 * The launcher's private-target gate over contract rows and the real parser
 * (`ops/hosted-autonomy-private-targets.ts`). The contract refuses an empty
 * optional collection (`reservationArchive`, `ownerSuccessorReviews`,
 * `targetCapabilities`), so a view whose every row of one is hidden omits it,
 * exactly as a snapshot that never had one. The view parses, a pass's write
 * through it applies on a store that parses every write (and passes the real
 * store's transition rules), and the hidden rows come back byte-identical.
 * A view the parser refuses is never handed to a pass.
 */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  portOk,
  type PortResultV1,
  type RepairStateWriter,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import type {
  StateReadResultV1,
  StateWriteResultV1,
} from "../../src/contracts/ports-state.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { validateRepairTransition } from "../../src/state/state-repair-transition.ts";
import {
  createPrivateTargetGateV1,
  PRIVATE_TARGET_VIEW_INVALID,
} from "../../ops/hosted-autonomy-private-targets.ts";
import { MemoryState } from "../repair/helpers.ts";
import { reservation, T0 } from "../state/helpers.ts";

const PRIVATE = { owner: "ubiquity", name: "prospector", installationId: 7 };
/** Its visibility read fails: hidden like private. */
const UNREADABLE = { owner: "ubiquity", name: "vault", installationId: 7 };

function snapshot(extra: Record<string, unknown>): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
    ...extra,
  });
}

function settled(id: string, repository: typeof PRIVATE) {
  return reservation(id, {
    repository,
    createdAt: T0 - 10_000,
    outcome: "submitted",
    settledAt: T0 - 5_000,
  });
}

function gate(validateView?: (view: RepairStateSnapshotV1) => unknown) {
  return createPrivateTargetGateV1({
    readVisibility: (repository) =>
      repository.name === PRIVATE.name
        ? Promise.resolve("private")
        : Promise.reject(new Error("read failed")),
    ...(validateView === undefined ? {} : { validateView }),
  });
}

/** A pass that changes nothing but the snapshot's own sequence and time. */
function passWrite(view: RepairStateSnapshotV1): RepairStateSnapshotV1 {
  return { ...view, sequence: view.sequence + 1, updatedAt: T0 + 1_000 };
}

Deno.test("private target gate (contract): every row of an optional collection hidden, the view parses, the write applies and the rows return byte-identical", async (t) => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["reservationArchive", {
      reservationArchive: [
        settled("r:private-archived", PRIVATE),
        settled("r:unreadable-archived", UNREADABLE),
      ],
    }],
    ["targetCapabilities", {
      // Opaque future rows name their repository only through the id.
      targetCapabilities: [
        { id: "target_capability:7/ubiquity/prospector", version: 2, a: [1] },
        { id: "target_capability:7/ubiquity/vault", version: 2, a: [2] },
      ],
    }],
  ];
  for (const [collection, extra] of cases) {
    await t.step(collection, async () => {
      const raw = snapshot(extra);
      // The real parser refuses the empty collection the view used to carry.
      assert.throws(() => snapshot({ [collection]: [] }));
      const store = new MemoryState();
      const seeded = await store.writeRepair(raw, null);
      assert.ok(seeded.ok && seeded.value.status === "applied");
      const state = gate().wrapState(store);
      const read = await state.readRepair();
      assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
      assert.equal(Object.hasOwn(read.value.snapshot, collection), false);
      parseRepairStateSnapshotV1(read.value.snapshot);
      const before = store.repair!;
      const written = await state.writeRepair(
        passWrite(read.value.snapshot),
        read.value.head,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const after = store.repair!;
      assert.equal(
        canonicalStringify(
          (after as unknown as Record<string, unknown>)[
            collection
          ],
        ),
        canonicalStringify(
          (raw as unknown as Record<string, unknown>)[
            collection
          ],
        ),
        "byte-identical, in place",
      );
      assert.equal(after.sequence, 2, "the store parsed and applied it");
      assert.equal(validateRepairTransition(before, after), null);
    });
  }
  await t.step("ownerSuccessorReviews", async () => {
    // A contract owner-successor row needs a full admission journal; the
    // hidden row is opaque to the gate, so this store keeps writes as given
    // while the gate's own view check is the real parser.
    const row = {
      id: "owner-successor:private",
      reservation: settled("r:owner-successor", PRIVATE),
    };
    const raw = {
      ...snapshot({}),
      ownerSuccessorReviews: [row],
    } as unknown as RepairStateSnapshotV1;
    const store = new KeepingState(raw);
    const state = gate().wrapState(store);
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
    assert.equal(
      Object.hasOwn(read.value.snapshot, "ownerSuccessorReviews"),
      false,
    );
    parseRepairStateSnapshotV1(read.value.snapshot);
    const written = await state.writeRepair(
      passWrite(read.value.snapshot),
      read.value.head,
    );
    assert.ok(written.ok && written.value.status === "applied");
    assert.equal(store.snapshot.ownerSuccessorReviews?.[0], row, "the object");
  });
});

/** Keeps exactly what is written; a moved head is a conflict. */
class KeepingState implements StateReadView, RepairStateWriter {
  head = "1".repeat(40) as GitSha;
  constructor(public snapshot: RepairStateSnapshotV1) {}
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
  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    if (expectedHead !== this.head) {
      return Promise.resolve(
        portOk({ status: "conflict" as const, currentHead: this.head }),
      );
    }
    this.snapshot = next;
    this.head = "2".repeat(40) as GitSha;
    return Promise.resolve(portOk({ status: "applied", head: this.head }));
  }
}

Deno.test("private target gate (contract): a hidden view the parser refuses is never handed to a pass", async () => {
  // A store whose state carries what the contract refuses (an empty archive):
  // the gate's default view check is the real parser, so the view is refused.
  const raw = {
    ...snapshot({ reservations: [settled("r:private-live", PRIVATE)] }),
    reservationArchive: [],
  } as unknown as RepairStateSnapshotV1;
  const refusing = gate();
  const read = await refusing.wrapState(new KeepingState(raw)).readRepair();
  assert.equal(read.ok, false);
  assert.equal(!read.ok && read.error.detail, PRIVATE_TARGET_VIEW_INVALID);
  assert.equal(refusing.line()?.invalidViews, 1);
  // The same check, injected: any view the check refuses is refused.
  const valid = snapshot({
    reservations: [settled("r:private-live", PRIVATE)],
  });
  const injected = gate(() => {
    throw new Error("refused");
  });
  const again = await injected.wrapState(new KeepingState(valid)).readRepair();
  assert.equal(!again.ok && again.error.detail, PRIVATE_TARGET_VIEW_INVALID);
  // Nothing hidden: the state is returned as read, unchecked by the gate.
  const open = gate(() => {
    throw new Error("never called");
  });
  const publicOnly = snapshot({});
  const plain = await open.wrapState(new KeepingState(publicOnly))
    .readRepair();
  assert.ok(plain.ok && plain.value.status === "found");
  assert.equal(plain.value.snapshot, publicOnly);
});
