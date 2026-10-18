/** Queue delivery proof is consumed atomically with durable release custody. */
import assert from "node:assert/strict";
import { createQueueIntent } from "../../ops/hosted-autonomy-queue-intent.ts";
import {
  isVerifiedDeliveryProof,
  resolveQueueAwareDelivery,
} from "../../ops/hosted-autonomy-queue-proof.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { NativeQueueGuardV1 } from "../../src/github/native-queue-guard.ts";
import {
  hasQueueDeliveryProvenance,
  queueDeliveryProvenanceRef,
} from "../../src/github/queue-delivery-provenance.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { handleMergeOutcome } from "../../src/repair/loop-merge.ts";
import { guardQueueDelivery } from "../../src/repair/loop-queue-guard.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import {
  APP,
  POLICY,
  queueProofFacts,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  T0,
} from "../host/merge-queue-proof-fixtures.ts";
import { parseWithR80, r80Available } from "../host/r80-contracts.ts";
import { reservation } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
} from "./helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";

class QueueGithub extends FakeGithub {
  override readonly reviewerIdentity = APP.login;
}

async function bookingRig() {
  const facts = await queueProofFacts();
  assert.ok(facts.task !== null && facts.task !== "unavailable");
  const record: WorkRecordV1 = {
    ...facts.record,
    intent: {
      ...await createQueueIntent(facts.record, facts.binding, T0),
      requestId: "12345678-1234-4234-8234-123456789abc",
      resultId: "MQE_7",
    },
  };
  facts.record = record;
  const proof = await resolveQueueAwareDelivery(facts, POLICY);
  if (proof.status !== "verified" || proof.delivery.kind !== "queue") {
    throw new Error("Expected a genuine queue delivery proof");
  }
  assert.equal(isVerifiedDeliveryProof(proof.delivery), true);
  const nativeQueue: NativeQueueGuardV1 = {
    ...inactiveNativeQueueFixture(),
    proveDelivery: () => Promise.resolve(proof),
  };
  const clock = new FakeClock(T0 + 5000);
  const state = new MemoryState();
  state.repair = seededSnapshot([record], {
    reviews: [facts.receipt],
    reservations: [reservation("original-charge", {
      repository: record.repository,
      taskId: record.id,
      outcome: "reserved",
      settledAt: null,
    })],
  });
  state.repairHead = SHA1;
  const writes: {
    next: RepairStateSnapshotV1;
    expectedHead: GitSha | null;
  }[] = [];
  const write = state.writeRepair.bind(state);
  state.writeRepair = (next, expectedHead) => {
    writes.push({ next: structuredClone(next), expectedHead });
    return write(next, expectedHead);
  };
  const github = new QueueGithub({
    nativeQueue,
    issues: [{
      number: 1,
      title: facts.task.title,
      body: facts.task.body,
    }],
  });
  const model = new FakeModel();
  const configs = [repositoryConfig(undefined, undefined, {
    repository: record.repository,
  })];
  const deps: RepairCycleDepsV1 = {
    clock,
    state,
    github,
    model,
    configs,
    controllerSha: SHA1,
    budget: new RollingStartBudget({ state, clock, configs }),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    replay: new FakeReplay(),
    incidents: new FakeIncidents({ summaries: [] }),
  };
  const context: LoopContextV1 = {
    snapshot: state.repair,
    head: SHA1,
    executionBaseline: record,
    bounds: {
      runDeadline: clock.now() + 60_000,
      modelCutoff: clock.now() + 60_000,
    },
  };
  return {
    facts,
    record,
    proof,
    nativeQueue,
    clock,
    state,
    writes,
    github,
    model,
    deps,
    context,
  };
}
type Rig = Awaited<ReturnType<typeof bookingRig>>;
const MERGED = { outcome: "merged" as const, head: SHA2, mergeSha: SHA4 };
function assertNoEffects(rig: Rig) {
  assert.equal(rig.model.requests.length, 0);
  assert.deepEqual(rig.github.pushes, []);
  assert.deepEqual(rig.github.reviewRequestIdentities, []);
  assert.equal(
    rig.github.calls.some((call) =>
      call === "merge" || call.startsWith("createPr") ||
      call.startsWith("close")
    ),
    false,
  );
}
function assertHeld(rig: Rig, before: RepairStateSnapshotV1) {
  const after = rig.state.repair!;
  assert.deepEqual(after.work[0], {
    ...before.work[0],
    wait: { reason: "backoff", since: rig.clock.now(), until: null },
    updatedAt: rig.clock.now(),
  });
  assert.deepEqual(after.reservations, before.reservations);
  assert.deepEqual(after.reviews, before.reviews);
  assert.deepEqual(after.releaseRequests, before.releaseRequests);
  assert.equal(hasQueueDeliveryProvenance(after.work[0]), false);
  assertNoEffects(rig);
}
async function book(
  rig: Rig,
  record = rig.record,
  revision = SHA4,
  receipt = rig.facts.receipt,
) {
  return await handleMergeOutcome(
    rig.deps,
    rig.context,
    record,
    { ...MERGED, mergeSha: revision },
    receipt,
  );
}

Deno.test("genuine queue proof books release and retained provenance in the same CAS", async () => {
  const rig = await bookingRig();
  const before = structuredClone(rig.state.repair!);
  const ref = {
    kind: "review_receipt",
    ref:
      `artifact:review-receipt/merge-queue-v1/${rig.facts.receipt.id}/${SHA1}`,
  };
  assert.deepEqual(
    queueDeliveryProvenanceRef(rig.proof.delivery, rig.record, SHA1),
    ref,
  );
  assert.deepEqual(await book(rig), { kind: "progress" });
  assert.equal(rig.writes.length, 1);
  assert.equal(rig.writes[0].expectedHead, SHA1);
  const written = rig.writes[0].next;
  assert.deepEqual(written.work[0].evidence, [...rig.record.evidence, ref]);
  assert.equal(written.work[0].intent, null);
  assert.equal(hasQueueDeliveryProvenance(written.work[0]), true);
  assert.deepEqual(written.work[0].target, rig.record.target);
  assert.deepEqual(written.reservations, before.reservations);
  assert.equal(written.releaseRequests.length, 1);
  assert.equal(written.releaseRequests[0].revision, SHA4);
  assert.equal(
    written.releaseRequests[0].source.reviewReceiptId,
    rig.facts.receipt.id,
  );
  assertNoEffects(rig);

  // A resumed consumer after intent clearing retains the ancestor reference;
  // it cannot silently repoint custody to the new state head or book twice.
  assert.notEqual(rig.context.head, SHA1);
  assert.deepEqual(await book(rig, rig.state.repair!.work[0]), {
    kind: "progress",
  });
  assert.deepEqual(
    rig.state.repair!.work[0].evidence,
    written.work[0].evidence,
  );
  assert.deepEqual(rig.state.repair!.releaseRequests, written.releaseRequests);
  assert.deepEqual(rig.state.repair!.reservations, before.reservations);
});

Deno.test("serialized and subsequently mutated queue proofs cannot mint provenance or book", async (t) => {
  for (const variant of ["serialized", "mutated"] as const) {
    await t.step(variant, async () => {
      const rig = await bookingRig();
      const delivery = variant === "serialized"
        ? JSON.parse(
          JSON.stringify(rig.proof.delivery),
        ) as typeof rig.proof.delivery
        : rig.proof.delivery;
      if (variant === "mutated") delivery.proofDigest = "f".repeat(64);
      assert.equal(isVerifiedDeliveryProof(delivery), false);
      assert.equal(
        queueDeliveryProvenanceRef(delivery, rig.record, SHA1),
        null,
      );
      rig.nativeQueue.proveDelivery = () =>
        Promise.resolve({ status: "verified", delivery });
      const before = structuredClone(rig.state.repair!);
      assert.deepEqual(await book(rig), { kind: "progress" });
      assertHeld(rig, before);
      assert.equal(rig.writes.length, 1);
    });
  }
});

Deno.test("wrong queue binding or revision is refused before the booking callback", async (t) => {
  for (
    const mismatch of [
      "repository",
      "pull",
      "base",
      "head",
      "request",
      "receipt",
      "task",
      "revision",
    ] as const
  ) {
    await t.step(mismatch, async () => {
      const rig = await bookingRig();
      let record = rig.record;
      let receipt: ReviewReceiptV1 = rig.facts.receipt;
      let revision = SHA4;
      if (mismatch === "repository") {
        record = {
          ...record,
          repository: {
            ...record.repository,
            installationId: record.repository.installationId + 1,
          },
        };
      }
      if (mismatch === "pull") {
        record = { ...record, target: { ...record.target, pr: 8 } };
      }
      if (mismatch === "base") {
        record = { ...record, target: { ...record.target, base: SHA3 } };
      }
      if (mismatch === "head") {
        record = { ...record, target: { ...record.target, head: SHA3 } };
      }
      if (mismatch === "request") {
        receipt = { ...receipt, requestId: "other-request" };
      }
      if (mismatch === "receipt") {
        receipt = { ...receipt, id: "other-receipt" as ReviewReceiptV1["id"] };
      }
      if (mismatch === "task") {
        receipt = {
          ...receipt,
          taskAcceptance: {
            ...receipt.taskAcceptance!,
            taskDigest: "f".repeat(64),
          },
        };
      }
      if (mismatch === "revision") revision = SHA3;
      rig.state.repair!.work[0] = record;
      const before = structuredClone(rig.state.repair!);
      let callbacks = 0;
      const stopped = await guardQueueDelivery(
        rig.deps,
        rig.context,
        record,
        receipt,
        revision,
        () => {
          callbacks++;
          return true;
        },
      );
      assert.deepEqual(stopped, { kind: "progress" });
      assert.equal(callbacks, 0);
      assertHeld(rig, before);
      const result = await book(
        rig,
        rig.state.repair!.work[0],
        revision,
        receipt,
      );
      assert.equal(result.kind, "deferred");
      assertHeld(rig, before);
      assert.equal(rig.writes.length, 1);
    });
  }
});

Deno.test({
  name:
    "actual R80 parser accepts queue provenance written by native release booking",
  ignore: !await r80Available(),
  fn: async () => {
    const rig = await bookingRig();
    assert.deepEqual(await book(rig), { kind: "progress" });
    assert.equal(rig.writes.length, 1);
    const written = rig.state.repair!;
    assert.equal(hasQueueDeliveryProvenance(written.work[0]), true);
    assert.deepEqual(await parseWithR80(written), written);
  },
});
