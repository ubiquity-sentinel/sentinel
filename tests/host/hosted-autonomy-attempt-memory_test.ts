import { SHA1 as ATTEMPT_RUNTIME } from "../state/helpers.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE,
  isDeferredCurrentMatrixHistoryBudget,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import {
  attemptFingerprintV1,
  attemptMemoryIdV1,
} from "../../src/contracts/attempt-memory.ts";
import type { AttemptMemoryRecordV1 } from "../../src/contracts/attempt-memory.ts";
import {
  ATTEMPT_DETAIL_INCOMPLETE,
  ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
  ATTEMPT_TRANSIENT_DECAY_MS,
} from "../../src/repair/attempt-policy.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";
import {
  BASE,
  blockedRecord,
  SELF_REPO,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  releaseSnapshot,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

async function attemptMemoryFixture(
  input: {
    base?: GitSha;
    controllerSha?: GitSha;
    detail?: string;
    count?: number;
    failureClass?: AttemptMemoryRecordV1["entries"][number]["failureClass"];
    lastAtMs?: number;
  } = {},
): Promise<AttemptMemoryRecordV1> {
  const base = input.base ?? BASE;
  const controllerSha = input.controllerSha ?? SHA1;
  const detail = input.detail ?? ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT;
  const id = await attemptMemoryIdV1({
    repository: SELF_REPO,
    taskId: TARGET,
    base,
    purpose: "implementation",
  });
  const fingerprint = await attemptFingerprintV1({
    taskId: TARGET,
    base,
    purpose: "implementation",
    controllerSha,
    detail,
  });
  return {
    version: "v1",
    kind: "attempt_memory",
    id,
    repository: SELF_REPO,
    taskId: TARGET,
    base,
    purpose: "implementation",
    entries: [
      {
        fingerprint,
        stage: "model",
        failureClass: input.failureClass ?? "transient_infrastructure",
        detail,
        controllerSha,
        count: input.count ?? 1,
        firstAtMs: T0,
        lastAtMs: input.lastAtMs ?? T0 + 1000,
      },
    ],
  };
}

function withAttemptMemory(
  snapshot: RepairStateSnapshotV1,
  memory: AttemptMemoryRecordV1[],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({ ...snapshot, attemptMemory: memory });
}

Deno.test(
  "attempt memory: exhausted equivalent transient retries are refused and reported",
  async () => {
    const record = blockedRecord({
      counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    });
    const base = repairSnapshot([record]);
    // One reservation below the cap permits the ordinary grant...
    assert.equal(planHostedRetries(base, T0 + 5000, ATTEMPT_RUNTIME).length, 1);

    // ...but four equivalent transient outcomes at the same base and runtime
    // revision exhaust the tolerated count: the grant is refused and reported.
    const denials: { id: string; reason: string }[] = [];
    const refused = withAttemptMemory(base, [
      await attemptMemoryFixture({ count: 4 }),
    ]);
    assert.equal(
      planHostedRetries(
        refused,
        T0 + 5000,
        ATTEMPT_RUNTIME,
        new Map(),
        new Set(),
        (denial) => {
          denials.push({ id: denial.id, reason: denial.reason });
        },
      ).length,
      0,
    );
    assert.equal(denials.length, 1);
    assert.equal(denials[0].id, TARGET);
    assert.match(denials[0].reason, /^equivalent_attempt_refused:/);

    // The transient decay window re-opens exactly one more attempt.
    const decayed = withAttemptMemory(base, [
      await attemptMemoryFixture({ count: 4, lastAtMs: T0 + 1000 }),
    ]);
    assert.equal(
      planHostedRetries(
        decayed,
        T0 + 1000 + ATTEMPT_TRANSIENT_DECAY_MS,
        ATTEMPT_RUNTIME,
      )
        .length,
      1,
    );

    // Changed evidence re-opens the grant: a new runtime revision or a moved
    // base is exactly what the refusal message demands.
    assert.equal(planHostedRetries(refused, T0 + 5000, SHA2).length, 1);
    assert.equal(refused.work[0].controller.sha, record.controller.sha);
    const otherBase = withAttemptMemory(base, [
      await attemptMemoryFixture({
        count: 4,
        base: "0123456789abcdef0123456789abcdef01234567" as GitSha,
      }),
    ]);
    assert.equal(
      planHostedRetries(otherBase, T0 + 5000, ATTEMPT_RUNTIME).length,
      1,
    );
  },
);

Deno.test("hosted autonomy: retry memory uses the authenticated installed pointer and refuses missing runtime", async () => {
  const record = blockedRecord({
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    target: {
      base: BASE,
      branch: null,
      checkpoint: null,
      head: null,
      pr: null,
    },
  });
  const repair = withAttemptMemory(repairSnapshot([record]), [
    await attemptMemoryFixture({ count: 4 }),
  ]);
  for (const runtime of [SHA1, SHA2, null]) {
    const { rig } = await makeRig("runtime-attempt-pointer", {
      repair,
      release: releaseSnapshot([], runtime),
    });
    try {
      const result = await run(rig);
      const after = await rig.state.readRepair();
      assert.ok(after.ok && after.value.status === "found");
      assert.equal(
        after.value.snapshot.work[0].controller.sha,
        record.controller.sha,
      );
      assert.deepEqual(
        after.value.snapshot.attemptMemory,
        repair.attemptMemory,
      );
      if (runtime === SHA2) {
        assert.equal(result.status, "applied");
        assert.equal(after.value.snapshot.work[0].nextStep, "work");
      } else {
        assert.equal(rig.writes, 0);
        assert.equal(after.value.snapshot.work[0].nextStep, "blocked");
      }
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  }
});

Deno.test(
  "hosted autonomy: a transient model-run failure is retried under the attempt-memory gate",
  async () => {
    const detail = "model run failed (unavailable)";
    const record = blockedRecord({
      blocker: { kind: "other", message: detail, since: T0 + 3000 },
      counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    });
    const snapshot = repairSnapshot([record]);
    // The family is retryable: a work-returning grant is planned.
    const plans = planHostedRetries(snapshot, T0 + 5000, ATTEMPT_RUNTIME);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].id, TARGET);
    assert.equal(plans[0].nextStep, "work");

    // The same attempt memory that bounds every other transient outcome still
    // bounds this family: four equivalents refuse, the six-hour decay reopens.
    const denials: { reason: string }[] = [];
    const refused = withAttemptMemory(snapshot, [
      await attemptMemoryFixture({ detail, count: 4 }),
    ]);
    assert.equal(
      planHostedRetries(
        refused,
        T0 + 5000,
        ATTEMPT_RUNTIME,
        new Map(),
        new Set(),
        (denial) => {
          denials.push({ reason: denial.reason });
        },
      ).length,
      0,
    );
    assert.equal(denials.length, 1);
    assert.match(denials[0].reason, /^equivalent_attempt_refused:/);
    const decayed = withAttemptMemory(snapshot, [
      await attemptMemoryFixture({
        detail,
        count: 4,
        lastAtMs: T0 + 1000,
      }),
    ]);
    assert.equal(
      planHostedRetries(
        decayed,
        T0 + 1000 + ATTEMPT_TRANSIENT_DECAY_MS,
        ATTEMPT_RUNTIME,
      )
        .length,
      1,
    );
  },
);

Deno.test(
  "hosted autonomy: a run-window scheduling refusal returns to work",
  () => {
    const record = blockedRecord({
      blocker: {
        kind: "other",
        message:
          "implementation start is past the model cutoff or no longer fits the run bounds",
        since: T0 + 3000,
      },
      counters: { attempts: 2, retries: 0, reviewRounds: 0 },
    });
    const plans = planHostedRetries(
      repairSnapshot([record]),
      T0 + 5000,
      ATTEMPT_RUNTIME,
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].id, TARGET);
    assert.equal(plans[0].nextStep, "work");
  },
);

Deno.test(
  "attempt memory: repeated no-progress outcomes refuse sooner than transient ones",
  async () => {
    const record = blockedRecord({
      blocker: {
        kind: "other",
        message: ATTEMPT_DETAIL_INCOMPLETE,
        since: T0 + 3000,
      },
      counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    });
    const base = repairSnapshot([record]);
    assert.equal(planHostedRetries(base, T0 + 5000, ATTEMPT_RUNTIME).length, 1);
    // One prior no-progress outcome is tolerated; two are not.
    assert.equal(
      planHostedRetries(
        withAttemptMemory(base, [
          await attemptMemoryFixture({
            detail: ATTEMPT_DETAIL_INCOMPLETE,
            failureClass: "semantic_no_progress",
            count: 1,
          }),
        ]),
        T0 + 5000,
        ATTEMPT_RUNTIME,
      ).length,
      1,
    );
    assert.equal(
      planHostedRetries(
        withAttemptMemory(base, [
          await attemptMemoryFixture({
            detail: ATTEMPT_DETAIL_INCOMPLETE,
            failureClass: "semantic_no_progress",
            count: 2,
          }),
        ]),
        T0 + 5000,
        ATTEMPT_RUNTIME,
      ).length,
      0,
    );
  },
);

Deno.test(
  "hosted autonomy: an exhausted current-matrix history budget classifies as a bounded deferral",
  () => {
    // The walk itself stays fail-closed and rejects; the hosted entry point
    // is what converts this exact availability condition into a non-fatal
    // deferral so one oversized history walk never fails the maintenance job
    // and skips prepare, matrix_plan and delivery.
    assert.equal(
      isDeferredCurrentMatrixHistoryBudget(
        new Error(CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE),
      ),
      true,
    );
    assert.equal(
      isDeferredCurrentMatrixHistoryBudget(
        new Error("current matrix history cycle"),
      ),
      false,
    );
    assert.equal(isDeferredCurrentMatrixHistoryBudget("exhausted"), false);
    assert.equal(isDeferredCurrentMatrixHistoryBudget(undefined), false);
  },
);
