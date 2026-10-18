import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portOk, type StateReadView } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { createQueueIntent } from "../../ops/hosted-autonomy-queue-intent.ts";
import {
  type QueueProofPolicy,
  resolveQueueAwareDelivery,
} from "../../ops/hosted-autonomy-queue-proof.ts";
import {
  createQueueProvenanceReader,
  hasQueueDeliveryProvenance,
  queueDeliveryProvenanceRef,
} from "../../src/github/queue-delivery-provenance.ts";
import { reviewReceiptId } from "../../src/repair/keys.ts";
import type { QueueEvidence } from "../../src/github/merge-queue-types.ts";
import { gen80Available, loadGen80Modules } from "./gen77-runtime-source.ts";
import {
  APP,
  directProofFacts,
  GROUP_BOT,
  POLICY,
  queueProofFacts,
  SHA1,
  SHA3,
  SHA4,
  T0,
} from "./merge-queue-proof-fixtures.ts";

async function rig() {
  const facts = await queueProofFacts();
  facts.receipt.id = await reviewReceiptId(
    facts.receipt.requestId,
    facts.binding.head,
  );
  facts.binding.reviewReceiptId = facts.receipt.id;
  facts.latestReceiptId = facts.receipt.id;
  const intent = await createQueueIntent(
    facts.record,
    facts.binding,
    T0 + 2500,
  );
  facts.record = {
    ...facts.record,
    wait: { reason: "backoff", until: null, since: T0 + 2500 },
    intent: { ...intent, resultId: "MQE_7" },
  };
  const snapshot = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 4000,
    incidents: [],
    evidence: [],
    work: [facts.record],
    reviews: [facts.receipt],
    reservations: [],
    releaseRequests: [],
    replays: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  let current = snapshot;
  let head = SHA1;
  let historyAvailable = true;
  let drift = false;
  let reads = 0;
  const state: StateReadView = {
    readRepair: () =>
      Promise.resolve(
        portOk({
          status: "found",
          snapshot: current,
          head: drift && ++reads > 1 ? SHA3 : head,
          ref: "repair",
        }),
      ),
    readRelease: () =>
      Promise.resolve(
        portOk({ status: "absent", currentHead: null, ref: null }),
      ),
    readRepairAt: ({ commit, expectedHead }) => {
      assert.equal(commit, SHA1);
      assert.equal(expectedHead, SHA3);
      return Promise.resolve(
        portOk(
          historyAvailable
            ? { status: "found", snapshot, head: SHA1, ref: "repair" }
            : { status: "absent", currentHead: SHA3, ref: "repair" },
        ),
      );
    },
  };
  const policy: QueueProofPolicy = {
    ...POLICY,
    mergedRemovalReasons: ["CANARY_MERGED"],
    mergedRemovalBeforeCommit: "pull_head" as const,
  };
  const evidence: QueueEvidence = {
    pull: facts.pull,
    entry: null,
    added: [{ id: "EV_ADDED", at: T0 + 2000, actor: APP }],
    removed: [{
      id: "EV_REMOVED",
      at: T0 + 3000,
      actor: GROUP_BOT,
      reason: "CANARY_MERGED",
      beforeCommit: facts.binding.head,
    }],
    mergeGroupRuns: [],
  };
  const reader = createQueueProvenanceReader({
    state,
    clock: { now: () => T0 + 5000 },
    policy,
  });
  const read = () =>
    reader({
      record: current.work[0],
      snapshot: current,
      binding: facts.binding,
      revision: SHA4,
      evidence,
      deadline: T0 + 6000,
    });
  const result = await resolveQueueAwareDelivery(facts, policy);
  assert.equal(result.status, "verified");
  if (result.status !== "verified") throw new Error("fixture proof rejected");
  return {
    facts,
    snapshot,
    evidence,
    result,
    read,
    policy,
    record: () => current.work[0],
    setCurrent: (next: typeof snapshot) => {
      current = next;
      head = SHA3;
    },
    noHistory: () => {
      historyAvailable = false;
    },
    drift: () => {
      drift = true;
    },
  };
}

Deno.test("queue provenance: native receipt ID and exact observed custody survive closure and done", async () => {
  const f = await rig();
  assert.equal((await f.read()).status, "complete");
  const ref = queueDeliveryProvenanceRef(f.result.delivery, f.record(), SHA1);
  assert.ok(ref);
  assert.match(ref.ref, /review-receipt:[a-f0-9]{64}\/[a-f0-9]{40}$/);
  const next = parseRepairStateSnapshotV1({
    ...f.snapshot,
    sequence: 2,
    stateHead: SHA1,
    work: [{
      ...f.record(),
      nextStep: "done",
      wait: null,
      intent: null,
      evidence: [ref],
    }],
  });
  f.setCurrent(next);
  assert.equal((await f.read()).status, "complete");
  assert.deepEqual(
    queueDeliveryProvenanceRef(f.result.delivery, f.record(), SHA3),
    ref,
  );
  assert.equal(hasQueueDeliveryProvenance(f.record()), true);
  f.noHistory();
  assert.equal((await f.read()).status, "unavailable");
});

Deno.test("queue provenance: serialized and mutated capabilities cannot mint admission references", async () => {
  const f = await rig();
  assert.equal(
    queueDeliveryProvenanceRef(
      structuredClone(f.result.delivery),
      f.record(),
      SHA1,
    ),
    null,
  );
  f.result.delivery.proofDigest = "b".repeat(64);
  assert.equal(
    queueDeliveryProvenanceRef(f.result.delivery, f.record(), SHA1),
    null,
  );
});

Deno.test("queue provenance: missing or ambiguous native custody never becomes queue proof", async (t) => {
  const changes: [string, (f: Awaited<ReturnType<typeof rig>>) => void][] = [
    ["UUID hint without native entry", (f) => {
      f.record().intent!.resultId = null;
      f.record().intent!.requestId = "c8bde880-3b8a-4f84-8036-d30a43cf7c12";
    }],
    ["foreign enqueuer", (f) => {
      f.evidence.added = [{ ...f.evidence.added[0], actor: GROUP_BOT }];
    }],
    ["another admission", (f) => {
      f.evidence.added = [...f.evidence.added, {
        ...f.evidence.added[0],
        id: "EV_SECOND",
        at: T0 + 3000,
      }];
    }],
    ["different removal head", (f) => {
      f.evidence.removed = [{ ...f.evidence.removed[0], beforeCommit: SHA3 }];
    }],
    ["missing native removal commit", (f) => {
      f.evidence.removed = [{ ...f.evidence.removed[0], beforeCommit: null }];
    }],
    ["missing canary commit semantics", (f) => {
      delete f.policy.mergedRemovalBeforeCommit;
    }],
    ["unaccepted removal reason", (f) => {
      f.evidence.removed = [{
        ...f.evidence.removed[0],
        reason: "looks merged",
      }];
    }],
    ["missing canary removal pin", (f) => {
      f.policy.mergedRemovalReasons = [];
    }],
    ["dequeue ambiguity", (f) => {
      f.record().intent!.key += ":d1";
    }],
    ["different native head", (f) => {
      f.evidence.pull = { ...f.evidence.pull, head: SHA3 };
    }],
    ["different immutable receipt", (f) => {
      f.snapshot.reviews[0].id += "-changed";
    }],
    ["malformed provenance namespace", (f) => {
      f.record().evidence.push({
        kind: "review_receipt",
        ref: "artifact:review-receipt/merge-queue-v1/invalid",
      });
    }],
    ["state changed during read", (f) => {
      f.drift();
    }],
  ];
  for (const [name, change] of changes) {
    await t.step(name, async () => {
      const f = await rig();
      change(f);
      assert.equal((await f.read()).status, "unavailable");
    });
  }
});

Deno.test({
  name:
    "queue provenance: exact R80 accepts the reference after admission and done",
  ignore: !await gen80Available(),
  fn: async () => {
    const f = await rig();
    const ref = queueDeliveryProvenanceRef(f.result.delivery, f.record(), SHA1);
    assert.ok(ref);
    const old = await loadGen80Modules(["src/contracts/state-snapshots.ts"]);
    try {
      const parseOld = old.modules[0]
        .parseRepairStateSnapshotV1 as typeof parseRepairStateSnapshotV1;
      for (const done of [false, true]) {
        const record = { ...f.record(), evidence: [ref] };
        if (done) {
          record.nextStep = "done";
          record.intent = null;
          record.wait = null;
        }
        const snapshot = parseRepairStateSnapshotV1({
          ...f.snapshot,
          work: [record],
        });
        assert.equal(
          canonicalStringify(parseOld(JSON.parse(JSON.stringify(snapshot)))),
          canonicalStringify(snapshot),
        );
      }
    } finally {
      await old.dispose();
    }
  },
});

Deno.test("queue provenance: completed and malformed references cannot use direct proof", async () => {
  for (
    const ref of [
      `artifact:review-receipt/merge-queue-v1/review-receipt:${
        "a".repeat(64)
      }/${SHA1}`,
      "artifact:review-receipt/merge-queue-v1/broken",
      "artifact:review-receipt/merge-queue-v1",
    ]
  ) {
    const facts = await directProofFacts();
    facts.record.nextStep = "done";
    facts.record.evidence.push({ kind: "review_receipt", ref });
    assert.deepEqual(await resolveQueueAwareDelivery(facts, POLICY), {
      status: "rejected",
      reason: "queue_evidence_required",
    });
  }
});
