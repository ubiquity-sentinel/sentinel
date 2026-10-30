/** Owner enqueue during awaited reads/admission must stop the final consumer. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import type { NativeQueueGuardV1 } from "../../src/github/native-queue-guard.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  baseRefreshIntentKey,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { executeBaseRefreshIntent } from "../../src/repair/loop-base-refresh.ts";
import {
  executePublishStep,
  reconcileOrphanPublication,
  reconcilePublishIntent,
} from "../../src/repair/loop-publication.ts";
import { requestReviewFor } from "../../src/repair/loop-review-request.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { executeImplementationStep } from "../../src/repair/loop-work.ts";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
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
  exactOpenPr,
  preservedIssueWork,
  PRODUCING_RESERVATION,
} from "./loop-candidate-fixtures.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { seededSnapshot, SHA4 } from "./loop-rig.ts";

function operation(
  kind: "push" | "pull_request" | "base_refresh",
  prepared = false,
): IncompleteOperationV1 {
  const record = preservedIssueWork("issue-1", SHA2);
  return {
    kind,
    key: kind === "base_refresh"
      ? baseRefreshIntentKey(7, SHA2, SHA3)
      : `${kind}:original`,
    startedAt: T0,
    branch: record.target.branch,
    expectedHead: SHA2,
    observedBase: kind === "base_refresh" ? SHA3 : SHA1,
    pr: kind === "base_refresh" ? 7 : null,
    requestId: null,
    resultId: prepared ? SHA4 : null,
    ...(kind === "base_refresh" ? { failure: conflictMarker(SHA3, T0) } : {}),
  };
}
function rigFor(record: WorkRecordV1) {
  let member = false;
  const inspected: Parameters<NativeQueueGuardV1["inspect"]>[0][] = [];
  const inactive = inactiveNativeQueueFixture();
  const nativeQueue: NativeQueueGuardV1 = {
    ...inactive,
    inspect: (input) => {
      inspected.push(structuredClone(input));
      return Promise.resolve(
        member
          ? { status: "hold", reason: "member", pull: null }
          : { status: "allow", basis: "native_absent" },
      );
    },
  };
  const state = new MemoryState();
  const clock = new FakeClock(T0 + 5000);
  const github = new FakeGithub({
    nativeQueue,
    baseSha: record.intent?.kind === "base_refresh" ? SHA3 : SHA1,
    candidateLifecycle: {
      refs: { [`refs/heads/${record.target.branch}`]: SHA2 },
      pullRequests: [exactOpenPr(7, SHA2, record.target.branch!)],
      prepareBaseRefresh: () => Promise.resolve(portOk(SHA4)),
      preserveCandidate: () => Promise.resolve(portOk(undefined)),
    },
  });
  const configs = repairConfigs({
    sessionBound: {
      maxDurationMs: 240_000,
      maxOutputChars: Number.MAX_SAFE_INTEGER,
    },
  });
  const model = new FakeModel({ head: SHA4, changedPaths: ["src/fix.ts"] });
  state.repair = seededSnapshot([record], {
    reservations: [
      reservation(PRODUCING_RESERVATION, {
        taskId: record.id,
        outcome: "submitted",
        settledAt: T0 + 1000,
      }),
    ],
    reviews: [completedReceipt(7, SHA2, SHA1)],
  });
  state.repairHead = SHA1;
  const deps: RepairCycleDepsV1 = {
    clock,
    state,
    github,
    configs,
    model,
    controllerSha: SHA1,
    budget: new RollingStartBudget({ clock, state, configs }),
    githubCooldown: new DurableGitHubCooldownGate({ clock, state }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
  };
  const context: LoopContextV1 = {
    snapshot: state.repair,
    head: SHA1,
    executionBaseline: record,
    bounds: {
      runDeadline: clock.now() + 3600_000,
      modelCutoff: clock.now() + 3600_000,
    },
  };
  return {
    deps,
    state,
    clock,
    github,
    model,
    context,
    record,
    inspected,
    enqueue: () => {
      member = true;
    },
  };
}
type Rig = ReturnType<typeof rigFor>;
function assertPreserved(rig: Rig, before: RepairStateSnapshotV1) {
  const after = rig.state.repair!;
  assert.deepEqual(after.work[0], {
    ...before.work[0],
    wait: { reason: "backoff", since: rig.clock.now(), until: null },
    updatedAt: rig.clock.now(),
  });
  assert.deepEqual(after.reservations, before.reservations);
  assert.deepEqual(after.reviews, before.reviews);
  assert.deepEqual(after.releaseRequests, before.releaseRequests);
  assert.deepEqual(rig.github.pushes, []);
  assert.deepEqual(rig.github.reviewRequestIdentities, []);
  assert.equal(
    rig.github.calls.some((call) =>
      call === "merge" || call.startsWith("createPr") ||
      call.startsWith("close")
    ),
    false,
  );
  assert.equal(rig.model.requests.length, 0);
}
function recordWith(
  intent: IncompleteOperationV1 | null,
  pr: number | null = 7,
) {
  return workRecord("issue-1", {
    ...preservedIssueWork("issue-1", SHA2, { pr }),
    intent,
  });
}

Deno.test("queue membership appearing during publication observations preserves original custody", async (t) => {
  for (
    const boundary of [
      "push",
      "pull_request",
      "orphan",
      "advertised",
      "refresh",
    ] as const
  ) {
    await t.step(boundary, async () => {
      const record = boundary === "advertised"
        ? preservedIssueWork("issue-1", SHA2, { publishedHead: null })
        : recordWith(
          operation(
            boundary === "refresh"
              ? "base_refresh"
              : boundary === "pull_request"
              ? "pull_request"
              : "push",
            boundary === "refresh",
          ),
          boundary === "pull_request" || boundary === "orphan" ? null : 7,
        );
      const rig = rigFor(record);
      if (boundary === "refresh") {
        rig.github.candidateRefs.set(
          `refs/heads/${record.target.branch}`,
          SHA4,
        );
      }
      let crossed = 0;
      if (boundary === "pull_request" || boundary === "orphan") {
        const read = rig.github.findPullRequestByHeadRef.bind(rig.github);
        rig.github.findPullRequestByHeadRef = async (branch) => {
          const result = await read(branch);
          crossed++;
          rig.enqueue();
          return result;
        };
      } else {
        const read = rig.github.readRef.bind(rig.github);
        rig.github.readRef = async (ref) => {
          const result = await read(ref);
          if (ref === `refs/heads/${record.target.branch}`) {
            crossed++;
            rig.enqueue();
          }
          return result;
        };
      }
      const before = structuredClone(rig.state.repair!);
      const result = boundary === "orphan"
        ? await reconcileOrphanPublication(rig.deps, rig.context, new Set())
        : boundary === "advertised"
        ? await executePublishStep(
          rig.deps,
          rig.context,
          record,
          rig.deps.configs[0],
        )
        : boundary === "refresh"
        ? await executeBaseRefreshIntent(rig.deps, rig.context, record)
        : await reconcilePublishIntent(
          rig.deps,
          rig.context,
          record,
          rig.deps.configs[0],
        );
      assert.equal(
        crossed,
        1,
        "the initial guard must allow reaching the actual read",
      );
      assert.deepEqual(result, { kind: "progress" });
      assertPreserved(rig, before);
      if (boundary === "refresh") {
        assert.equal(rig.inspected.at(-1)?.expectedHead, SHA4);
        assert.equal(
          rig.inspected.at(-1)?.record.target.head,
          SHA2,
          "prepared-head observation cannot replace the canonical record",
        );
      }
    });
  }
});

Deno.test("queue custody during admission or intent writes prevents new sessions and keeps the charge", async (t) => {
  for (const kind of ["implementation", "review_request"] as const) {
    for (const barrier of ["reserved", "intended", "before_submit"] as const) {
      await t.step(`${kind}: ${barrier}`, async () => {
        const record = recordWith(
          kind === "implementation" ? operation("base_refresh") : null,
        );
        const rig = rigFor(record);
        let original: RepairStateSnapshotV1 | null = null;
        let crossed = 0;
        const cross = () => {
          if (crossed > 0) return;
          original = structuredClone(rig.state.repair!);
          crossed++;
          rig.enqueue();
        };
        if (barrier === "reserved") {
          const reserve = rig.deps.budget.reserveModelStart.bind(
            rig.deps.budget,
          );
          rig.deps.budget.reserveModelStart = async (request) => {
            const result = await reserve(request);
            assert.equal(result.status, "admitted");
            cross();
            return result;
          };
        } else if (barrier === "intended") {
          const write = rig.state.writeRepair.bind(rig.state);
          rig.state.writeRepair = async (next, expected) => {
            const result = await write(next, expected);
            if (
              result.ok && result.value.status === "applied" &&
              next.work[0].intent?.kind === kind
            ) cross();
            return result;
          };
        } else {
          const before = rig.deps.githubCooldown.beforeRequest.bind(
            rig.deps.githubCooldown,
          );
          rig.deps.githubCooldown.beforeRequest = async (request) => {
            const result = await before(request);
            if (rig.state.repair!.work[0].intent?.kind === kind) cross();
            return result;
          };
        }
        const result = kind === "implementation"
          ? await executeImplementationStep(
            rig.deps,
            rig.context,
            record,
            rig.deps.configs[0],
          )
          : await requestReviewFor(rig.deps, rig.context, record, 7);
        assert.equal(
          crossed,
          1,
          "the real admission must cross the chosen asynchronous barrier",
        );
        assert.ok(original);
        assert.deepEqual(result, { kind: "progress" });
        const admitted = original as RepairStateSnapshotV1;
        assert.equal(admitted.reservations.length, 2);
        assert.equal(admitted.reservations.at(-1)?.outcome, "reserved");
        assert.deepEqual(admitted.work[0].target, record.target);
        if (kind === "implementation") {
          // Admission now counts and binds the implementation in the same CAS.
          const charge = admitted.reservations.at(-1)!;
          assert.equal(charge.taskId, record.id);
          assert.deepEqual(charge.repository, record.repository);
          assert.equal(charge.head, record.target.base);
          assert.equal(charge.attempt, record.counters.attempts + 1);
          assert.deepEqual(admitted.work[0].counters, {
            ...record.counters,
            attempts: charge.attempt,
          });
          assert.deepEqual(admitted.work[0].intent, {
            kind: "implementation",
            key: implementationIntentKey(charge.id),
            startedAt: charge.createdAt,
            branch: record.target.branch,
            expectedHead: null,
            observedBase: charge.head,
            pr: null,
            requestId: charge.id,
            resultId: null,
            failure: conflictMarker(SHA3, charge.createdAt),
          });
        } else if (barrier === "reserved") {
          assert.deepEqual(admitted.work[0].intent, record.intent);
        } else assert.equal(admitted.work[0].intent?.kind, kind);
        assertPreserved(rig, admitted);
      });
    }
  }
});
