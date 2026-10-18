/** Hosted receipt and preservation consumers retain custody after owner enqueue. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import {
  type ModelRunReceiptV1,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { NativeQueueGuardV1 } from "../../src/github/native-queue-guard.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  handleImplementationUncertainty,
  handleModelReceipt,
  settleFailedImplementation,
} from "../../src/repair/loop-implementation-result.ts";
import { executeCandidatePreservation } from "../../src/repair/loop-preservation.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import { reservation, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import {
  preservedIssueWork,
  PRODUCING_RESERVATION,
} from "./loop-candidate-fixtures.ts";
import { seededSnapshot, SHA4 } from "./loop-rig.ts";

const CHARGE = "1".repeat(64);
type Consumer =
  | "conflict"
  | "completed"
  | "incomplete"
  | "failed_start"
  | "uncertain"
  | "preservation";
function receipt(completed = true): ModelRunReceiptV1 {
  return {
    invocationId: "hosted-receipt-1",
    outcome: completed ? "completed" : "failed",
    actual: {
      evidenceKind: "request-runtime",
      provider: "sentinel-host",
      threadId: "thread-1",
      turnId: "turn-1",
      terminalOrigin: "runtime",
      observedTerminalStatus: completed ? "completed" : "failed",
      observedModel: "gpt-6.1-sol",
      observedReasoning: "max",
      durationMs: 500,
      outputChars: 9000,
    },
    candidate: completed
      ? { head: SHA4, checkpointSha: null, changedPaths: ["src/fix.ts"] }
      : null,
    error: completed ? null : "synthetic incomplete receipt",
  };
}
async function rigFor(consumer: Consumer, held = true, legacy = false) {
  const original = preservedIssueWork("issue-1", SHA2);
  const operationKey = implementationIntentKey(CHARGE);
  const preservation = consumer === "preservation";
  const record: WorkRecordV1 = {
    ...original,
    target: preservation
      ? {
        ...original.target,
        head: SHA4,
        candidateState: { preserved: null, publishedHead: SHA2 },
      }
      : legacy
      ? {
        base: original.target.base,
        head: original.target.head,
        branch: original.target.branch,
        pr: original.target.pr,
        checkpoint: original.target.checkpoint,
      }
      : original.target,
    intent: {
      kind: preservation ? "candidate_preservation" : "implementation",
      key: operationKey,
      startedAt: T0,
      branch: preservation
        ? await candidatePreservationRef(
          original.repository,
          original.id,
          operationKey,
        )
        : original.target.branch,
      expectedHead: preservation ? SHA4 : SHA2,
      observedBase: SHA1,
      pr: preservation ? null : 7,
      requestId: CHARGE,
      resultId: null,
      ...(consumer === "conflict" ? { failure: conflictMarker(SHA3, T0) } : {}),
    },
  };
  let member = held;
  const nativeQueue: NativeQueueGuardV1 = {
    ...inactiveNativeQueueFixture(),
    inspect: () =>
      Promise.resolve(
        member
          ? { status: "hold", reason: "member", pull: null }
          : { status: "allow", basis: "native_absent" },
      ),
  };
  const state = new MemoryState();
  const clock = new FakeClock(T0 + 5000);
  const github = new FakeGithub({
    nativeQueue,
    branchRefSha: SHA2,
    candidateLifecycle: {
      preserveCandidate: () => Promise.resolve(portOk(undefined)),
    },
  });
  const model = new FakeModel();
  const configs = repairConfigs();
  state.repair = seededSnapshot([record], {
    reservations: [
      reservation(PRODUCING_RESERVATION, {
        taskId: record.id,
        outcome: "submitted",
        settledAt: T0 + 1000,
      }),
      reservation(CHARGE, {
        taskId: record.id,
        attempt: 2,
        outcome: preservation ? "submitted" : "reserved",
        settledAt: preservation ? T0 + 2000 : null,
      }),
    ],
  });
  state.repairHead = SHA1;
  const budget = new RollingStartBudget({ state, clock, configs });
  const settlementCalls: Parameters<typeof budget.settleModelStart>[0][] = [];
  const settle = budget.settleModelStart.bind(budget);
  budget.settleModelStart = (request) => {
    settlementCalls.push(structuredClone(request));
    return settle(request);
  };
  const deps: RepairCycleDepsV1 = {
    clock,
    state,
    github,
    model,
    configs,
    budget,
    controllerSha: SHA1,
    externalImplementations: true,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
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
  const consume = () =>
    consumer === "preservation"
      ? executeCandidatePreservation(deps, context, record)
      : consumer === "failed_start"
      ? settleFailedImplementation(
        deps,
        context,
        record,
        CHARGE,
        "synthetic failed implementation",
      )
      : consumer === "uncertain"
      ? handleImplementationUncertainty(deps, context, record)
      : handleModelReceipt(
        deps,
        context,
        record,
        CHARGE,
        receipt(consumer !== "incomplete"),
        configs[0],
      );
  return {
    consumer,
    record,
    state,
    clock,
    github,
    model,
    budget,
    settlementCalls,
    deps,
    context,
    consume,
    enqueue: () => {
      member = true;
    },
  };
}
type Rig = Awaited<ReturnType<typeof rigFor>>;
function assertRetained(rig: Rig, before: RepairStateSnapshotV1) {
  const after = rig.state.repair!;
  assert.deepEqual(after.work[0], {
    ...before.work[0],
    wait: { reason: "backoff", since: rig.clock.now(), until: null },
    updatedAt: rig.clock.now(),
  });
  assert.deepEqual(after.reservations, before.reservations);
  assert.deepEqual(after.attemptMemory, before.attemptMemory);
  assert.deepEqual(after.reviews, before.reviews);
  assert.deepEqual(after.releaseRequests, before.releaseRequests);
  assert.equal(rig.model.requests.length, 0);
  assert.equal(rig.github.reviewRequestIdentities.length, 0);
  assert.deepEqual(rig.github.pushes, []);
}

Deno.test("queue member blocks hosted receipt consumption and direct preservation before effects", async (t) => {
  for (
    const consumer of [
      "conflict",
      "completed",
      "incomplete",
      "failed_start",
      "uncertain",
      "preservation",
    ] as const
  ) {
    await t.step(consumer, async () => {
      const rig = await rigFor(consumer);
      const before = structuredClone(rig.state.repair!);
      assert.deepEqual(await rig.consume(), { kind: "progress" });
      assertRetained(rig, before);
      assert.equal(rig.github.preservationRequests.length, 0);
      assert.equal(rig.settlementCalls.length, 0);
      assert.equal(rig.state.repairWrites, 1);
    });
  }
});

Deno.test("owner enqueue during preservation keeps the original intent for every returned outcome", async (t) => {
  for (
    const outcome of ["success", "invalid", "not_found", "unavailable"] as const
  ) {
    await t.step(outcome, async () => {
      const rig = await rigFor("preservation", false);
      const before = structuredClone(rig.state.repair!);
      let preserved = 0;
      rig.github.preserveCandidate = () => {
        preserved++;
        rig.enqueue();
        return Promise.resolve(
          outcome === "success"
            ? portOk(undefined)
            : portError(outcome, "synthetic preservation result"),
        );
      };
      assert.deepEqual(await rig.consume(), { kind: "progress" });
      assert.equal(preserved, 1);
      assertRetained(rig, before);
      assert.equal(rig.settlementCalls.length, 0);
    });
  }
  await t.step("hosted conflict preserved before enqueue", async () => {
    const rig = await rigFor("conflict", false);
    const before = structuredClone(rig.state.repair!);
    let preserved = 0;
    rig.github.preserveCandidate = () => {
      preserved++;
      rig.enqueue();
      return Promise.resolve(portOk(undefined));
    };
    assert.deepEqual(await rig.consume(), { kind: "progress" });
    assert.equal(
      preserved,
      1,
      "the hosted conflict must cross its actual preservation call",
    );
    assertRetained(rig, before);
    assert.equal(rig.settlementCalls.length, 0);
  });
});

Deno.test("owner enqueue during predecessor observation prevents ordinary receipt settlement", async () => {
  const rig = await rigFor("completed", false, true);
  const before = structuredClone(rig.state.repair!);
  const read = rig.github.readRef.bind(rig.github);
  let observed = 0;
  rig.github.readRef = async (ref) => {
    const result = await read(ref);
    observed++;
    rig.enqueue();
    return result;
  };
  assert.deepEqual(await rig.consume(), { kind: "progress" });
  assert.equal(observed, 1);
  assertRetained(rig, before);
  assert.equal(rig.settlementCalls.length, 0);
});

Deno.test("owner enqueue during settlement retains original implementation intent and charged outcome", async (t) => {
  for (
    const consumer of [
      "completed",
      "incomplete",
      "failed_start",
      "uncertain",
    ] as const
  ) {
    await t.step(consumer, async () => {
      const rig = await rigFor(consumer, false);
      const settle = rig.budget.settleModelStart.bind(rig.budget);
      let charged: RepairStateSnapshotV1 | null = null;
      rig.budget.settleModelStart = async (request) => {
        const result = await settle(request);
        assert.equal(result.status, "settled");
        charged = structuredClone(rig.state.repair!);
        rig.enqueue();
        return result;
      };
      assert.deepEqual(await rig.consume(), { kind: "progress" });
      assert.ok(charged);
      const settled = charged as RepairStateSnapshotV1;
      assert.equal(
        settled.reservations.at(-1)?.outcome,
        consumer === "completed" ? "submitted" : "ambiguous",
      );
      assert.deepEqual(settled.work[0], rig.record);
      assertRetained(rig, settled);
      assert.equal(rig.settlementCalls.length, 1);
      assert.equal(rig.github.preservationRequests.length, 0);
    });
  }
});
