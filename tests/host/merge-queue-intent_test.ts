import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  createQueueIntent,
  parseQueueIntent,
  QUEUE_FAILURE_DETAILS,
  queueIntentBinding,
} from "../../ops/hosted-autonomy-queue-intent.ts";
import { queueHold } from "../../ops/hosted-autonomy-queue-writer.ts";
import { gen80Available, loadGen80Modules } from "./gen77-runtime-source.ts";
import { orchestrationRig } from "./merge-queue-orchestration-fixtures.ts";

Deno.test("queue intent: exact receipt/task binding rejects substitution and duplicate identities", async () => {
  const f = await orchestrationRig();
  const original = f.state.repair!.work[0];
  const intent = await createQueueIntent(original, f.proof.binding, f.now());
  const row = { ...queueHold(original, f.now()), intent };
  assert.ok(await queueIntentBinding(f.state.repair!, row));
  const snapshot = structuredClone(f.state.repair!);
  snapshot.reviews[0].id += "-new";
  assert.equal(await queueIntentBinding(snapshot, row), null);
  snapshot.reviews = [f.proof.receipt, f.proof.receipt];
  assert.equal(await queueIntentBinding(snapshot, row), null);
  assert.equal(
    parseQueueIntent({
      ...row,
      intent: { ...intent, requestId: "not-an-operation-uuid" },
    }),
    null,
  );
  assert.equal(
    parseQueueIntent({ ...row, target: { ...row.target, pr: 8 } }),
    null,
  );
  assert.equal(
    parseQueueIntent({
      ...row,
      intent: { ...intent, key: intent.key + ":a2" },
    }),
    null,
  );
});

async function assertQueueIntentRoundTrips(
  parseSnapshot: typeof parseRepairStateSnapshotV1,
): Promise<void> {
  const f = await orchestrationRig();
  const record = f.state.repair!.work[0];
  const initial = await createQueueIntent(record, f.proof.binding, f.now());
  let cases = 0;
  for (const [detail, bucket] of QUEUE_FAILURE_DETAILS) {
    for (const suffix of ["", ":a1", ":d1", ":a1:d1"]) {
      const row = {
        ...queueHold(record, f.now()),
        intent: {
          ...initial,
          key: initial.key + suffix,
          requestId: "c8bde880-3b8a-4f84-8036-d30a43cf7c12",
          resultId: "MQE_7",
          failure: {
            kind: "merge_queue_v1",
            detail,
            atMs: f.now(),
            attempts: bucket.refusals + bucket.queueFailures + 1,
          },
        },
      };
      if (parseQueueIntent(row) === null) {
        continue;
      }
      const snapshot = parseRepairStateSnapshotV1({
        ...f.state.repair,
        work: [row],
      });
      assert.equal(
        canonicalStringify(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))),
        canonicalStringify(snapshot),
      );
      cases++;
    }
  }
  for (const suffix of ["", ":d1"]) {
    const row = {
      ...queueHold(record, f.now()),
      intent: { ...initial, key: initial.key + suffix },
    };
    const snapshot = parseRepairStateSnapshotV1({
      ...f.state.repair,
      work: [row],
    });
    assert.equal(
      canonicalStringify(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))),
      canonicalStringify(snapshot),
    );
  }
  assert.ok(cases > 200, `only ${cases} codec cases tested`);
}

Deno.test("queue intent: every valid closed stage/bucket and both admission keys round-trip under current codec", async () => {
  await assertQueueIntentRoundTrips(parseRepairStateSnapshotV1);
});

Deno.test({
  name:
    "queue intent: every valid closed stage/bucket and both admission keys round-trip under exact R80",
  // CI checkouts are shallow. Only historical execution depends on the local
  // old Git object; the same complete case matrix above always runs today.
  ignore: !await gen80Available(),
  fn: async () => {
    const old = await loadGen80Modules(["src/contracts/state-snapshots.ts"]);
    try {
      await assertQueueIntentRoundTrips(
        old.modules[0]
          .parseRepairStateSnapshotV1 as typeof parseRepairStateSnapshotV1,
      );
    } finally {
      await old.dispose();
    }
  },
});
