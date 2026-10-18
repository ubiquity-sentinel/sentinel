/** Maintenance must retain the admission the runtime needs for base review. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  ATTEMPT_DETAIL_NO_CHANGE,
  attemptMemorySettlementMutationV1,
} from "../../src/repair/attempt-policy.ts";
import { baseReviewOrigin } from "../../src/repair/base-satisfaction-marker.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy-retries.ts";
import { runHostedAutonomy } from "../../ops/hosted-autonomy.ts";
import {
  failureSignature,
  repeatFailureParkMessage,
  repeatFailureVerdict,
} from "../../ops/hosted-autonomy-repeat-failure.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import {
  BASE,
  blockedRecord,
  SELF_REPO,
  selfTips,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  releaseSnapshot,
  repairSnapshot,
} from "./hosted-autonomy-rig.ts";
import { parseWithR80, R80_RUNTIME, r80Available } from "./r80-contracts.ts";

const R80 = R80_RUNTIME as GitSha;
const CHARGE = "a".repeat(64);
const ROUTE = "b".repeat(12);
const DIGEST = "c".repeat(64);
const NOW = T0 + 60_000;
const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);

function snapshot(
  detail: string = ATTEMPT_DETAIL_NO_CHANGE,
  outcome: "submitted" | "ambiguous" = "ambiguous",
): RepairStateSnapshotV1 {
  const branch = candidateBranch(TARGET);
  const record = blockedRecord({
    target: {
      base: BASE,
      branch,
      checkpoint: null,
      head: null,
      pr: null,
    },
    evidence: [],
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    blocker: { kind: "other", message: detail, since: T0 + 1000 },
    intent: {
      kind: "implementation",
      key: `impl:${CHARGE}`,
      startedAt: T0,
      branch,
      expectedHead: null,
      observedBase: BASE,
      pr: null,
      requestId: CHARGE,
      resultId: null,
    },
  });
  return repairSnapshot([record], [], [], [
    reservation(CHARGE, {
      repository: SELF_REPO,
      taskId: TARGET,
      head: BASE,
      purpose: "implementation",
      outcome,
      settledAt: T0 + 1000,
    }),
  ]);
}

function plan(state: RepairStateSnapshotV1, route = ROUTE, digest = DIGEST) {
  const parks: unknown[] = [];
  const denials: unknown[] = [];
  const plans = planHostedRetries(
    state,
    NOW,
    R80,
    selfTips(BASE),
    new Set(),
    (denial) => denials.push(denial),
    {
      repeatFailure: { route, issueDigests: new Map([[TARGET, digest]]) },
      onRepeatFailurePark: (park) => parks.push(park),
    },
  );
  return { plans, parks, denials };
}

function wrapped(): RepairStateSnapshotV1 {
  return snapshot(repeatFailureParkMessage({
    count: 3,
    signature: failureSignature("other", ATTEMPT_DETAIL_NO_CHANGE),
    issue: DIGEST.slice(0, 12),
    route: ROUTE,
  }, ATTEMPT_DETAIL_NO_CHANGE));
}

Deno.test("base satisfaction maintenance: charged no-change admission is retained under R80", () => {
  for (const outcome of ["submitted", "ambiguous"] as const) {
    const state = snapshot(ATTEMPT_DETAIL_NO_CHANGE, outcome);
    const before = structuredClone(state);
    assert.equal(baseReviewOrigin(state.work[0], state), CHARGE);
    assert.deepEqual(plan(state), { plans: [], parks: [], denials: [] });
    assert.deepEqual(
      state,
      before,
      "planning cannot alter the original admission",
    );
  }
});

Deno.test("base satisfaction maintenance: an eligible repeat park cannot rearm or repark", () => {
  const state = wrapped();
  const before = structuredClone(state);
  assert.equal(baseReviewOrigin(state.work[0], state), CHARGE);
  for (
    const [route, digest] of [
      [ROUTE, DIGEST],
      ["d".repeat(12), DIGEST],
      [ROUTE, "e".repeat(64)],
    ]
  ) {
    assert.deepEqual(plan(state, route, digest), {
      plans: [],
      parks: [],
      denials: [],
    });
  }
  assert.deepEqual(state, before);
});

Deno.test("base satisfaction maintenance: due no-change repetition defers to native review", async () => {
  const state = snapshot();
  for (const offset of [1, 2, 3]) {
    const settle = await attemptMemorySettlementMutationV1({
      record: state.work[0],
      detail: ATTEMPT_DETAIL_NO_CHANGE,
      now: T0 + offset * 1000,
      runtimeSha: R80,
    });
    settle(state);
  }
  // Prove this fixture really would park if the new guard ran too late.
  assert.equal(
    repeatFailureVerdict(state, state.work[0], {
      route: ROUTE,
      issueDigests: new Map([[TARGET, DIGEST]]),
    }).kind,
    "park",
  );
  const before = structuredClone(state);
  assert.deepEqual(plan(state), { plans: [], parks: [], denials: [] });
  assert.deepEqual(state, before);
});

Deno.test("base satisfaction maintenance: generic failures retain ordinary retry authority", () => {
  for (
    const detail of [
      "model run failed (unavailable)",
      `${ATTEMPT_DETAIL_NO_CHANGE}; unrelated diagnostic`,
    ]
  ) {
    const state = snapshot(detail);
    const before = structuredClone(state);
    assert.equal(baseReviewOrigin(state.work[0], state), null);
    const result = plan(state);
    assert.equal(result.plans.length, 1, detail);
    assert.deepEqual(result.parks, []);
    const applied = applyHostedRetries(state, SHA1, result.plans, NOW);
    assert.equal(applied.work[0].nextStep, "work");
    assert.equal(applied.work[0].intent, null);
    assert.deepEqual(applied.reservations, before.reservations);
    assert.deepEqual(state, before);
  }
});

Deno.test("base satisfaction maintenance: real pass preserves admission across route changes", async () => {
  const initial = wrapped();
  const { rig } = await makeRig("base-satisfaction-maintenance", {
    fixtureDir: ROOT,
    repair: initial,
    release: releaseSnapshot([], R80),
    issueTask: (issueNumber) =>
      Promise.resolve({
        issueNumber,
        title: "Existing fix",
        body: "",
        digest: DIGEST,
      }),
  });
  try {
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const before = structuredClone(read.value.snapshot);
    const writes = rig.writes;
    for (const [index, route] of [ROUTE, "d".repeat(12)].entries()) {
      const result = await runHostedAutonomy({
        state: rig.state,
        githubFor: rig.githubFor,
        clock: { now: () => NOW + index * 60_000 },
        modelRoute: route,
      });
      assert.ok(
        !result.actions.some((action) => action.startsWith(`retry:${TARGET}:`)),
        JSON.stringify(result),
      );
    }
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(
      rig.writes,
      writes,
      "maintenance must leave runtime's evidence intact",
    );
    assert.deepEqual(after.value.snapshot, before);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test({
  name:
    "base satisfaction maintenance: retained historical records parse under R80",
  ignore: !await r80Available(),
  async fn() {
    for (const state of [snapshot(), wrapped()]) {
      assert.deepEqual(plan(state), { plans: [], parks: [], denials: [] });
      await parseWithR80(state);
    }
  },
});
