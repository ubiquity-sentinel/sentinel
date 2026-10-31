/**
 * Launcher side of review-round accounting after the owner directive
 * 2026-10-30 retired the review-round ceiling and the legacy
 * `legacy_round_requires_ci_first` gate: a spent count never denies a
 * re-admission under any runtime. Counters, ledger charges and refunds remain
 * accounting and are never reset or reinterpreted here.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  applyHostedRetries,
  BASE_REFRESH_AUTH_BLOCKERS,
  hostedRepositoryKey,
  planBaseRefreshReadmissions,
  planHostedRetries,
  type RetryDenialV1,
} from "../../ops/hosted-autonomy.ts";
import { reservation, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  BASE,
  blockedRecord,
  HEAD,
  SELF_REPO,
  selfTips,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import { healthyProof, repairSnapshot } from "./hosted-autonomy-rig.ts";
import { deliveryEligible } from "../../ops/hosted-autonomy-policy.ts";
import {
  isDeliverableReviewRoundCeilingPark,
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_MESSAGES,
} from "../../src/repair/review-round-cap.ts";

const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
const NOW = T0 + 10 * 60 * 60_000;
const REVIEW_BLOCKERS = [
  {
    kind: "other",
    message: "review produced no verdict within the bounded review wait",
  },
  {
    kind: "review_quota",
    message:
      "review rounds exhausted without an accepted verdict (structured review unavailable)",
  },
  {
    kind: "other",
    message: "review admission already settled without an intent",
  },
] as const;

/** Unrefunded review charges for attempts 1..n of one task. */
function reviewCharges(
  taskId: string,
  rounds: number,
  head: GitSha = HEAD,
  repository: unknown = SELF_REPO,
): BudgetReservationV1[] {
  return Array.from(
    { length: rounds },
    (_, index) =>
      reservation(`${taskId}-review-${index + 1}`, {
        repository,
        taskId,
        attempt: index + 1,
        head,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 10 + index,
      }),
  );
}

function reviewBlocked(
  blocker: (typeof REVIEW_BLOCKERS)[number],
  reviewRounds: number,
): WorkRecordV1 {
  return blockedRecord({
    blocker: { ...blocker, since: T0 + 3000 },
    counters: { attempts: 2, retries: 0, reviewRounds },
  });
}

/** A proven CI-first runtime at SHA1 (generation 80) for the retry table. */
const CI_FIRST_OPTIONS = {
  ciRuntime: {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: SHA1,
    generation: 80,
    lastHealthyProof: healthyProof(SHA1, 80, "round-cap"),
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
  } as HostedRuntimeRecordV1,
  ciAllowlist: new Set<string>([SHA1]),
  ciFirstAllowlist: new Set<string>([SHA1]),
};

function plan(
  records: WorkRecordV1[],
  reservations: unknown[],
  tips: ReadonlyMap<string, string | null> = selfTips(SHA2),
  options: Parameters<typeof planHostedRetries>[6] = {},
) {
  const denials: RetryDenialV1[] = [];
  const snapshot = repairSnapshot(records, [], [], reservations);
  const plans = planHostedRetries(
    snapshot,
    NOW,
    SHA1,
    tips,
    new Set(),
    (denial) => denials.push(denial),
    options,
  );
  return { snapshot, plans, denials: denials.map((denial) => denial.reason) };
}

Deno.test("launcher round cap: a spent count never denies a review grant under the CI-first runtime", () => {
  for (const blocker of REVIEW_BLOCKERS) {
    for (const rounds of [3, 14]) {
      const ciFirst = plan(
        [reviewBlocked(blocker, rounds)],
        reviewCharges(TARGET, rounds),
        selfTips(SHA2),
        CI_FIRST_OPTIONS,
      );
      assert.deepEqual(ciFirst.denials, [], `${blocker.message} at ${rounds}`);
      assert.equal(ciFirst.plans.length, 1);
      assert.equal(ciFirst.plans[0]!.nextStep, "review");
      // R79 (not proven CI-first) plans the same review: the retired legacy
      // compatibility gate no longer withholds it.
      const legacyRuntime = plan(
        [reviewBlocked(blocker, rounds)],
        reviewCharges(TARGET, rounds),
      );
      assert.deepEqual(legacyRuntime.denials, []);
      assert.equal(legacyRuntime.plans.length, 1);
      assert.equal(legacyRuntime.plans[0]!.nextStep, "review");
      // The grant only returns the record to `review`: no counter moves, no
      // budget round is admitted here and no charge is written.
      const applied = applyHostedRetries(
        legacyRuntime.snapshot,
        SHA1,
        legacyRuntime.plans,
        NOW,
      );
      assert.equal(applied.work[0]!.nextStep, "review");
      assert.deepEqual(
        applied.work[0]!.counters,
        legacyRuntime.snapshot.work[0]!.counters,
      );
      assert.deepEqual(
        applied.reservations,
        legacyRuntime.snapshot.reservations,
      );
    }
  }
});

Deno.test("launcher round cap: a review grant below the ceiling keeps its unused identity and plans no base advance", () => {
  for (const blocker of REVIEW_BLOCKERS) {
    const { plans, denials } = plan(
      [reviewBlocked(blocker, 2)],
      reviewCharges(TARGET, 2),
    );
    assert.deepEqual(denials, []);
    assert.equal(plans.length, 1, blocker.message);
    assert.equal(plans[0]!.nextStep, "review");
    assert.equal(plans[0]!.reviewRounds, 2);
    assert.equal(plans[0]!.advanceBase, false);
  }
});

Deno.test("launcher round cap: ledger charges and counter lag stay accounting, never a denial", () => {
  // Counter 2, three unrefunded review admissions durable (live 293 / 647).
  const charged = reviewCharges(TARGET, 3);
  const review = reviewBlocked(REVIEW_BLOCKERS[0], 2);
  const reviewPlan = plan(
    [review],
    charged,
    selfTips(SHA2),
    CI_FIRST_OPTIONS,
  );
  assert.deepEqual(reviewPlan.denials, []);
  assert.equal(reviewPlan.plans.length, 1);
  assert.equal(reviewPlan.plans[0]!.nextStep, "review");
  // A work grant is never withheld because a counter or the ledger has spent
  // its old allowance.
  const work = blockedRecord({
    counters: { attempts: 2, retries: 0, reviewRounds: 2 },
  });
  for (const charges of [[], charged]) {
    const planned = plan(
      [work],
      charges,
      selfTips(BASE),
      CI_FIRST_OPTIONS,
    );
    assert.deepEqual(planned.denials, []);
    assert.equal(planned.plans.length, 1);
    assert.equal(planned.plans[0]!.nextStep, "work");
  }
  // A lowered counter (live 264: counter 0, three charges) is accounting
  // only, never a reason to withhold the next review.
  const lowered = blockedRecord({
    counters: { attempts: 2, retries: 0, reviewRounds: 0 },
  });
  const loweredPlan = plan(
    [lowered],
    charged,
    selfTips(BASE),
    CI_FIRST_OPTIONS,
  );
  assert.deepEqual(loweredPlan.denials, []);
  assert.equal(loweredPlan.plans.length, 1);
  // A refund still frees its accounting round without being required to.
  const refunded = [
    ...reviewCharges(TARGET, 2),
    reservation(`${TARGET}-review-3`, {
      repository: SELF_REPO,
      taskId: TARGET,
      attempt: 3,
      head: HEAD,
      purpose: "review_request",
      outcome: "confirmed_not_submitted",
      settledAt: T0 + 20,
      proofRef: "artifact:review-refund/3",
    }),
  ];
  const freed = blockedRecord({
    counters: { attempts: 2, retries: 0, reviewRounds: 3 },
  });
  assert.equal(
    plan([freed], refunded, selfTips(BASE), CI_FIRST_OPTIONS).plans.length,
    1,
  );
});

Deno.test("launcher round cap: a legacy-class record gets its one current-head review once a CI fix armed it, a post-cutoff record none", () => {
  // The rule's cutoff: every review charge below is created at T0, before it.
  const CUT = T0 + 1;
  const legacy = (issue: number, rounds: number) =>
    parseWorkRecordV1({
      ...reviewBlocked(REVIEW_BLOCKERS[0], rounds),
      repository: AI,
      id: `issue-ubiquity-ai.ubq.fi-${issue}`,
      source: { kind: "issue", id: String(issue), revision: SHA1 },
      related: { incidentId: null, issueNumber: issue },
      target: {
        base: SHA2,
        branch: `sentinel/repair/issue-ubiquity-ai.ubq.fi-${issue}`,
        checkpoint: null,
        head: SHA3,
        pr: 1000 + issue,
      },
    });
  // The CI fix admitted at or after the cutoff that arms the final round.
  const fix = (record: WorkRecordV1) =>
    reservation(`${record.id}-ci-fix`, {
      repository: AI,
      taskId: record.id,
      attempt: 3,
      head: SHA3,
      purpose: "retry",
      outcome: "submitted",
      createdAt: CUT + 5,
      settledAt: CUT + 6,
    });
  const run = (
    record: WorkRecordV1,
    charges: BudgetReservationV1[],
    ciFirst = true,
  ) =>
    plan(
      [record],
      charges,
      new Map([[hostedRepositoryKey(AI), SHA1]]),
      ciFirst
        ? { ...CI_FIRST_OPTIONS, legacyReviewCutoff: CUT }
        : { legacyReviewCutoff: CUT },
    );
  const armed = legacy(595, 4);
  const armedCharges = [...reviewCharges(armed.id, 4, SHA3, AI), fix(armed)];
  // The review is granted under any runtime: neither the retired legacy
  // gate nor a spent count withholds it.
  assert.deepEqual(run(armed, armedCharges, false).denials, []);
  const granted = run(armed, armedCharges);
  assert.deepEqual(granted.denials, []);
  assert.equal(granted.plans.length, 1);
  assert.equal(granted.plans[0]!.nextStep, "review");
  assert.equal(granted.plans[0]!.reviewRounds, 4);
  assert.equal(granted.plans[0]!.advanceBase, false, "the current head");
  // A review no longer needs the final round armed to be requested: the
  // ordinary count is unbounded after the owner directive.
  assert.equal(
    run(armed, reviewCharges(armed.id, 4, SHA3, AI)).plans.length,
    1,
    "an unarmed final round no longer blocks the review",
  );
  // A review admitted after the cutoff already spent the old final round;
  // it is still accounting, not a park.
  const spent = legacy(595, 5);
  assert.equal(
    run(spent, [
      ...reviewCharges(spent.id, 4, SHA3, AI),
      fix(spent),
      reservation(`${spent.id}-review-final`, {
        repository: AI,
        taskId: spent.id,
        attempt: 5,
        head: SHA3,
        purpose: "review_request",
        outcome: "submitted",
        createdAt: CUT + 20,
        settledAt: CUT + 21,
      }),
    ]).plans.length,
    1,
    "a spent final round no longer parks the record",
  );
  // Without a pinned cutoff nothing is legacy, but the ordinary review is
  // still admitted: there is no ceiling to run out of.
  assert.equal(
    plan(
      [armed],
      armedCharges,
      new Map([[hostedRepositoryKey(AI), SHA1]]),
      { ...CI_FIRST_OPTIONS, legacyReviewCutoff: null },
    ).plans.length,
    1,
    "cutoff unpinned",
  );
  // A record whose rounds were all charged after the cutoff is never legacy;
  // its review is admitted anyway.
  const fresh = legacy(1600, 3);
  assert.equal(
    run(fresh, [
      ...reviewCharges(fresh.id, 3, SHA3, AI).map((charge) => ({
        ...charge,
        createdAt: CUT + 1,
      })),
      fix(fresh),
    ]).plans.length,
    1,
    "a generation-80 record keeps iterating",
  );
});

Deno.test("launcher round cap: a moved-tip conflict re-pend counts the ledger", () => {
  const charge = "ab".repeat(32);
  const marked = blockedRecord({
    blocker: {
      kind: "other",
      message: "model run did not complete with a trusted candidate",
      since: T0 + 1000,
    },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(charge),
      startedAt: T0,
      branch: candidateBranch(TARGET),
      expectedHead: null,
      observedBase: BASE,
      pr: null,
      requestId: charge,
      resultId: null,
      failure: conflictMarker(SHA1, T0),
    },
  });
  const spentCharge = reservation(charge, {
    repository: SELF_REPO,
    taskId: TARGET,
    head: BASE,
    attempt: 2,
    purpose: "retry",
    outcome: "ambiguous",
    settledAt: T0 + 1000,
  });
  const below = plan([marked], [spentCharge], selfTips(SHA2));
  assert.equal(below.plans.length, 1, JSON.stringify(below.denials));
  const spent = plan(
    [marked],
    [spentCharge, ...reviewCharges(TARGET, 3)],
    selfTips(SHA2),
    CI_FIRST_OPTIONS,
  );
  assert.deepEqual(spent.denials, []);
  assert.equal(spent.plans.length, 1);
  assert.equal(spent.plans[0]!.nextStep, "work");
  // Without a proven CI-first runtime the resolution is planned the same way:
  // neither the retired legacy gate nor a spent count withholds it.
  const legacyRuntime = plan(
    [marked],
    [spentCharge, ...reviewCharges(TARGET, 3)],
    selfTips(SHA2),
  );
  assert.deepEqual(legacyRuntime.denials, []);
  assert.equal(legacyRuntime.plans.length, 1);
  assert.equal(legacyRuntime.plans[0]!.nextStep, "work");
});

function authBlocked(reviewRounds: number): WorkRecordV1 {
  const id = "issue-ubiquity-ai.ubq.fi-641";
  return parseWorkRecordV1({
    ...blockedRecord(),
    repository: AI,
    id,
    source: { kind: "issue", id: "641", revision: SHA1 },
    related: { incidentId: null, issueNumber: 641 },
    target: {
      base: SHA2,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: SHA3,
      pr: null,
      candidateState: {
        preserved: {
          operationKey: `impl:${"0641".repeat(16)}`,
          base: SHA2,
          head: SHA3,
          ref: `refs/heads/sentinel-candidates/${"0641".repeat(16)}`,
        },
        publishedHead: SHA3,
      },
    },
    blocker: {
      kind: "other",
      message: [...BASE_REFRESH_AUTH_BLOCKERS][0]!,
      since: T0 + 1000,
    },
    counters: { attempts: 4, retries: 0, reviewRounds },
  });
}

Deno.test("launcher round cap: a base-refresh re-admission no longer needs a round left", () => {
  const readmit = (
    record: WorkRecordV1,
    charges: unknown[] = [],
  ) => {
    const denials: string[] = [];
    const candidates = planBaseRefreshReadmissions(
      repairSnapshot([record], [], [], charges),
      SHA1,
      new Set(),
      (denial) => denials.push(denial.reason),
    );
    return { candidates, denials };
  };
  assert.equal(readmit(authBlocked(2)).candidates.length, 1);
  assert.equal(readmit(authBlocked(3)).candidates.length, 1);
  assert.deepEqual(readmit(authBlocked(3)).denials, []);
  assert.equal(readmit(authBlocked(3)).candidates.length, 1);
  const record = authBlocked(2);
  const charged = reviewCharges(record.id, 3, SHA3, AI);
  assert.equal(readmit(record, charged).candidates.length, 1);
  assert.equal(
    readmit(record, charged).candidates.length,
    1,
    "the ledger is accounting, not a re-admission gate",
  );
  assert.deepEqual(readmit(record, charged).denials, []);
});

Deno.test("launcher round cap: a parked record is a delivery candidate once its ordinary rounds are spent by the ledger", () => {
  const eligible = (record: WorkRecordV1, charges: unknown[]) =>
    deliveryEligible(record, repairSnapshot([], [], [], charges));
  const parked = (reviewRounds: number, message: string) =>
    blockedRecord({
      blocker: { kind: "other", message, since: T0 + 3000 },
      counters: { attempts: 2, retries: 0, reviewRounds },
    });
  // Counter and ledger agree on three spent rounds. Of the ceiling parks only
  // REVIEWED and BASE_MOVED are ever delivered (and a CI-red park is the
  // spent rule's own); the others never reach a merge gate.
  for (const message of REVIEW_ROUND_CEILING_MESSAGES) {
    const record = parked(3, message);
    assert.equal(
      eligible(record, reviewCharges(TARGET, 3)),
      isDeliverableReviewRoundCeilingPark(record),
      message,
    );
  }
  assert.equal(
    eligible(parked(3, "CI checks failed: test"), reviewCharges(TARGET, 3)),
    true,
  );
  // The counter lags the ledger (live 264 / 293): spent all the same.
  const lagging = parked(2, REVIEW_ROUND_CEILING_BASE_MOVED);
  assert.equal(isDeliverableReviewRoundCeilingPark(lagging), true);
  assert.equal(eligible(lagging, reviewCharges(TARGET, 3)), true);
  // A proven refund leaves a round: not yet a spent-round candidate.
  const refunded = [
    ...reviewCharges(TARGET, 2),
    reservation(`${TARGET}-review-3`, {
      repository: SELF_REPO,
      taskId: TARGET,
      attempt: 3,
      head: HEAD,
      purpose: "review_request",
      outcome: "confirmed_not_submitted",
      settledAt: T0 + 20,
      proofRef: "artifact:review-refund/3",
    }),
  ];
  assert.equal(eligible(parked(3, "CI checks failed: test"), refunded), false);
  // A listed legacy record qualifies on its ordinary rounds: a clean latest
  // review of its current head merges once that head is green, and its one
  // final round is only for a CI-fixed new head.
  const legacy = (rounds: number) =>
    parseWorkRecordV1({
      ...parked(rounds, "CI checks failed: validate(failure)"),
      repository: AI,
      id: "issue-ubiquity-ai.ubq.fi-698",
      source: { kind: "issue", id: "698", revision: SHA1 },
      related: { incidentId: null, issueNumber: 698 },
    });
  const legacyCharges = (rounds: number) =>
    reviewCharges("issue-ubiquity-ai.ubq.fi-698", rounds, SHA3, AI);
  assert.equal(eligible(legacy(9), legacyCharges(9)), true);
  assert.equal(eligible(legacy(10), legacyCharges(10)), true);
  assert.equal(eligible(legacy(2), legacyCharges(2)), false);
  // review and delivery stay candidates whatever the count; no other step.
  for (const nextStep of ["review", "delivery"]) {
    const record = blockedRecord({ nextStep, blocker: null });
    assert.equal(eligible(record, []), true, nextStep);
  }
  for (const nextStep of ["work", "blocked"]) {
    const record = blockedRecord({
      nextStep,
      ...(nextStep === "blocked" ? {} : { blocker: null }),
      counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    });
    assert.equal(eligible(record, reviewCharges(TARGET, 1)), false, nextStep);
  }
  const done = blockedRecord({ nextStep: "done", blocker: null });
  assert.equal(eligible(done, reviewCharges(TARGET, 3)), false);
});
