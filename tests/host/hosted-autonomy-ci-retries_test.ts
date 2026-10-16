/**
 * Launcher re-admission of reviewed heads parked on the runtime's merge-gate
 * CI failure: the exact eligible shape returns to `delivery` with nothing
 * charged, refreshed or counted, and every other shape stays parked.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import {
  ciCorrectionRuntimeProven,
  ciRedeliveryEligible,
  HOSTED_AUTONOMY_CI_CORRECTION_MIN_GENERATION,
  HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES,
} from "../../ops/hosted-autonomy-ci-retries.ts";
import { HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS } from "../../ops/hosted-autonomy-policy.ts";
import {
  CI_CORRECTION_REVIEW_ROUNDS,
  ciCorrectable,
} from "../../src/repair/ci-rejection.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_REVISION,
} from "../../src/host/owner-install-runtime-pins.ts";
import {
  releaseRequest,
  reservation,
  SHA1,
  SHA2,
  T0,
} from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  finding,
  HEAD,
  SELF_REPO,
  selfTips,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import { healthyProof, repairSnapshot } from "./hosted-autonomy-rig.ts";

/** An installed runtime that carries the CI correction route. */
const RUNTIME = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as GitSha;
/** Test allowlist naming RUNTIME as a CI-correction runtime. */
const ALLOWLIST: ReadonlySet<string> = new Set([RUNTIME]);

/** The authenticated installed runtime record with its own healthy proof. */
function installed(
  overrides: Partial<HostedRuntimeRecordV1> = {},
  proof: { revision?: string; generation?: number } | null = {},
): HostedRuntimeRecordV1 {
  const revision = overrides.activeRevision ?? RUNTIME;
  const generation = overrides.generation ?? 77;
  return {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: revision,
    generation,
    lastHealthyProof: proof === null ? null : healthyProof(
      proof.revision ?? revision,
      proof.generation ?? generation,
      "ci-correction-release",
    ),
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as HostedRuntimeRecordV1;
}
const CI_BLOCKER = {
  kind: "other",
  message: "CI checks failed: verify-artifact(skipped), validate(failure)",
  since: T0 + 5000,
};

function ciBlocked(overrides: Record<string, unknown> = {}) {
  return blockedRecord({
    blocker: CI_BLOCKER,
    counters: { attempts: 4, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

const CHARGES = [
  reservation("ci-impl", {
    repository: SELF_REPO,
    taskId: TARGET,
    head: BASE,
    attempt: 4,
    purpose: "retry",
    outcome: "submitted",
    settledAt: T0 + 2000,
  }),
  reservation("ci-review", {
    repository: SELF_REPO,
    taskId: TARGET,
    head: HEAD,
    attempt: 1,
    purpose: "review_request",
    outcome: "submitted",
    settledAt: T0 + 2500,
  }),
];

Deno.test("hosted autonomy: a reviewed head parked on its CI gate returns to delivery uncharged", () => {
  const snapshot = repairSnapshot(
    [ciBlocked()],
    [authorizingReceipt()],
    [],
    CHARGES,
  );
  // A newer base is the runtime's to reconcile: the grant never refreshes.
  const plans = planHostedRetries(
    snapshot,
    T0 + 9000,
    RUNTIME,
    selfTips(SHA2),
    new Set(),
    undefined,
    { ciRuntime: installed(), ciAllowlist: ALLOWLIST },
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].nextStep, "delivery");
  assert.equal(plans[0].advanceBase, false);
  assert.equal(plans[0].observedBase, null);
  assert.equal(plans[0].reviewRounds, null);
  assert.equal(plans[0].detail, "other:CI checks failed:");
  const next = applyHostedRetries(snapshot, SHA1, plans, T0 + 9000);
  const record = next.work[0];
  assert.equal(record.nextStep, "delivery");
  assert.equal(record.blocker, null);
  assert.equal(record.wait, null);
  assert.equal(record.intent, null, "no refresh intent is written");
  assert.deepEqual(record.counters, snapshot.work[0].counters);
  assert.deepEqual(record.target, snapshot.work[0].target);
  assert.deepEqual(next.reservations, snapshot.reservations, "nothing charged");
  assert.deepEqual(next.reviews, snapshot.reviews);
});

Deno.test("hosted autonomy: only the exact reviewed, unreleased CI-gate shape is re-admitted", async (t) => {
  const plan = (
    records = [ciBlocked()],
    reviews: unknown[] = [authorizingReceipt()],
    releaseRequests: unknown[] = [],
  ) =>
    planHostedRetries(
      repairSnapshot(records, reviews, releaseRequests, CHARGES),
      T0 + 9000,
      RUNTIME,
      new Map(),
      new Set(),
      undefined,
      { ciRuntime: installed(), ciAllowlist: ALLOWLIST },
    );
  assert.equal(plan().length, 1, "control");
  await t.step("spent review rounds keep the terminal block", () => {
    assert.equal(
      plan([
        ciBlocked({ counters: { attempts: 4, retries: 0, reviewRounds: 3 } }),
      ])
        .length,
      0,
    );
  });
  await t.step("a retained closure intent is never replaced", () => {
    const closure = {
      kind: "already_satisfied_closure",
      key: `satisfied:51:${HEAD}:${BASE}`,
      startedAt: T0 + 3000,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      expectedHead: HEAD,
      observedBase: BASE,
      pr: 51,
      requestId: "review-req-1",
      resultId: "msg_0123456789abcdef",
    };
    assert.equal(plan([ciBlocked({ intent: closure })]).length, 0);
  });
  await t.step("the head must hold its own clean completed review", () => {
    assert.equal(plan(undefined, []).length, 0, "no receipt");
    assert.equal(
      plan(undefined, [authorizingReceipt({
        findings: [finding("P1")],
        unresolvedSeverities: ["P1"],
      })]).length,
      0,
      "a rejecting receipt",
    );
    assert.equal(
      plan(undefined, [authorizingReceipt({
        pullRequest: { number: 51, head: HEAD, base: SHA2 },
      })]).length,
      0,
      "a receipt for another base",
    );
  });
  await t.step("a release-phase CI block belongs to a merged delivery", () => {
    const released = releaseRequest("ci-release", {
      target: { repository: SELF_REPO, environment: "production" },
      revision: SHA2,
      source: {
        pullRequest: 51,
        reviewRequestId: "review-req-1",
        reviewReceiptId: null,
        head: HEAD,
        base: BASE,
      },
    });
    assert.equal(plan(undefined, undefined, [released]).length, 0);
  });
  await t.step("an undescribed candidate cannot resume a correction", () => {
    const record = ciBlocked();
    assert.equal(
      plan([blockedRecord({
        blocker: CI_BLOCKER,
        counters: record.counters,
        target: {
          ...record.target,
          candidateState: { preserved: null, publishedHead: HEAD },
        },
      })]).length,
      0,
    );
  });
  await t.step(
    "the runtime's own unattributed block is not this rule's",
    () => {
      assert.equal(
        plan([ciBlocked({
          blocker: {
            ...CI_BLOCKER,
            message: "CI checks failed without base evidence: lint(failure)",
          },
        })]).length,
        0,
      );
    },
  );
});

Deno.test("hosted autonomy: the CI re-admission activates only for an allowlisted, healthy generation-77+ runtime", async (t) => {
  const snapshot = repairSnapshot([ciBlocked()], [authorizingReceipt()], [], [
    ...CHARGES,
  ]);
  const plan = (
    ciRuntime: HostedRuntimeRecordV1 | null | undefined,
    ciAllowlist: ReadonlySet<string> | undefined = ALLOWLIST,
    runtimeSha: GitSha = RUNTIME,
  ) =>
    planHostedRetries(
      snapshot,
      T0 + 9000,
      runtimeSha,
      new Map(),
      new Set(),
      undefined,
      ciRuntime === undefined ? undefined : { ciRuntime, ciAllowlist },
    ).length;
  assert.equal(plan(installed()), 1, "control");
  await t.step("no runtime proof at all keeps the rule inert", () => {
    assert.equal(plan(undefined), 0);
    assert.equal(plan(null), 0);
  });
  await t.step("a runtime outside the allowlist is inert", () => {
    assert.equal(plan(installed(), new Set()), 0);
    // The production allowlist is pinned by the integration owner once the
    // reviewed generation-77 revision exists; it never names 74/75/76. With
    // no test allowlist the planner reads exactly that pinned set.
    assert.equal(
      planHostedRetries(
        snapshot,
        T0 + 9000,
        RUNTIME,
        new Map(),
        new Set(),
        undefined,
        { ciRuntime: installed() },
      ).length,
      HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES.has(RUNTIME) ? 1 : 0,
    );
    assert.equal(ciCorrectionRuntimeProven(installed()), false);
    for (
      const [revision, generation] of [
        [OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_REVISION, 74],
        [OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_REVISION, 75],
        [OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_REVISION, 76],
      ] as const
    ) {
      assert.equal(HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES.has(revision), false);
      const legacy = installed({
        activeRevision: revision as GitSha,
        generation,
      });
      assert.equal(
        plan(legacy, new Set([revision]), revision as GitSha),
        0,
        "a pre-77 generation never activates the rule",
      );
    }
  });
  await t.step(
    "a pre-77 generation of an allowlisted revision is inert",
    () => {
      assert.equal(
        plan(installed({
          generation: HOSTED_AUTONOMY_CI_CORRECTION_MIN_GENERATION - 1,
        })),
        0,
      );
    },
  );
  await t.step("the healthy proof must bind this exact pointer", () => {
    assert.equal(plan(installed({}, null)), 0, "no healthy proof");
    assert.equal(
      plan(installed({}, { revision: "6".repeat(40) })),
      0,
      "a proof for another revision",
    );
    assert.equal(
      plan(installed({ generation: 78 }, { generation: 77 })),
      0,
      "a proof for another generation",
    );
    const failedProof = installed();
    failedProof.lastHealthyProof = {
      ...failedProof.lastHealthyProof!,
      outcome: "failed",
    };
    assert.equal(plan(failedProof), 0, "a failed run is never health");
    assert.equal(
      ciCorrectionRuntimeProven(installed({ generation: 79 }), ALLOWLIST),
      true,
      "a later proven generation of the same revision stays active",
    );
  });
  await t.step(
    "the proven runtime must be the authenticated installed one",
    () => {
      assert.equal(plan(installed(), ALLOWLIST, "6".repeat(40) as GitSha), 0);
    },
  );
});

Deno.test("hosted autonomy: the CI re-admission and the runtime correction share one review-round ceiling", () => {
  // The launcher may only re-admit a head the runtime can still correct: a
  // re-admitted head the runtime cannot correct is blocked again at once and
  // would be re-admitted on every pass. Both sides read one ceiling, which
  // also mirrors the hosted delivery ceiling for spent records.
  assert.equal(CI_CORRECTION_REVIEW_ROUNDS, HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS);
  const reviews = [authorizingReceipt()];
  for (
    let rounds = 0;
    rounds <= HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS + 1;
    rounds++
  ) {
    const record = ciBlocked({
      counters: { attempts: 4, retries: 0, reviewRounds: rounds },
    });
    const snapshot = repairSnapshot([record], reviews, [], CHARGES);
    assert.equal(
      ciRedeliveryEligible(snapshot, snapshot.work[0]),
      ciCorrectable(snapshot.work[0]),
      `review rounds ${rounds}`,
    );
  }
});
