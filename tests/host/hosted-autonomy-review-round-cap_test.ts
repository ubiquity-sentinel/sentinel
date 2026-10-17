/**
 * Launcher side of the hard review-round ceiling (owner decision 2026-10-16:
 * "3 round max"). The protected maintenance planners only ever WITHHOLD a
 * re-admission: none of them may hand the runtime a record that would spend a
 * review round past its ceiling (three, or the one documented legacy round),
 * counted from the durable ledger as well as the counter. These rules are
 * pure and launcher-only, so they can ship before the runtime that carries
 * the ceiling; the denials are reported through the existing denial channel
 * and nothing is written for a denied record.
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

Deno.test("launcher round cap: no review grant once the rounds are spent, even after a base move", () => {
  for (const blocker of REVIEW_BLOCKERS) {
    for (const rounds of [3, 14]) {
      const { snapshot, plans, denials } = plan(
        [reviewBlocked(blocker, rounds)],
        reviewCharges(TARGET, rounds),
      );
      assert.deepEqual(plans, [], `${blocker.message} at ${rounds}`);
      assert.deepEqual(denials, ["review_rounds_spent"]);
      // Nothing to apply: no base_refresh intent, no review step, no write.
      const applied = applyHostedRetries(snapshot, SHA1, plans, NOW);
      assert.deepEqual(applied.work, snapshot.work);
      assert.deepEqual(applied.reservations, snapshot.reservations);
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

Deno.test("launcher round cap: charges the counter missed spend the allowance; refunds do not", () => {
  // Counter 2, three unrefunded review admissions durable (live 293 / 647).
  const charged = reviewCharges(TARGET, 3);
  const review = reviewBlocked(REVIEW_BLOCKERS[0], 2);
  assert.deepEqual(plan([review], charged).denials, ["review_rounds_spent"]);
  // A work grant would only buy a candidate no review could ever accept.
  const work = blockedRecord({
    counters: { attempts: 2, retries: 0, reviewRounds: 2 },
  });
  assert.equal(plan([work], [], selfTips(BASE)).plans.length, 1);
  const spent = plan([work], charged, selfTips(BASE));
  assert.deepEqual(spent.plans, []);
  assert.deepEqual(spent.denials, ["review_rounds_spent"]);
  // A lowered counter (live 264: counter 0, three charges) is no exception.
  const lowered = blockedRecord({
    counters: { attempts: 2, retries: 0, reviewRounds: 0 },
  });
  assert.deepEqual(plan([lowered], charged, selfTips(BASE)).plans, []);
  // A refund bumped the counter but submitted nothing: the round is free.
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
  assert.equal(plan([freed], refunded, selfTips(BASE)).plans.length, 1);
});

Deno.test("launcher round cap: a listed legacy record gets its one current-head review, an unlisted one none", () => {
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
  const run = (record: WorkRecordV1, rounds: number, ciFirst = true) =>
    plan(
      [record],
      reviewCharges(record.id, rounds, SHA3, AI),
      new Map([[hostedRepositoryKey(AI), SHA1]]),
      ciFirst ? CI_FIRST_OPTIONS : {},
    );
  // The final round is a review of a green head, so it is granted only under
  // a proven CI-first runtime (generation 80 integration with the CI-first
  // lane); R79 would review the head before its CI.
  assert.deepEqual(run(legacy(595, 4), 4, false).denials, [
    "legacy_round_requires_ci_first",
  ]);
  const listed = run(legacy(595, 4), 4);
  assert.deepEqual(listed.denials, []);
  assert.equal(listed.plans.length, 1);
  assert.equal(listed.plans[0]!.nextStep, "review");
  assert.equal(listed.plans[0]!.reviewRounds, 4);
  assert.equal(listed.plans[0]!.advanceBase, false, "the current head");
  assert.deepEqual(run(legacy(595, 5), 5).plans, [], "the one round is spent");
  assert.deepEqual(run(legacy(596, 6), 6).plans, [], "596 is not listed");
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
  );
  assert.deepEqual(spent.plans, []);
  assert.deepEqual(spent.denials, ["conflict_resolution_rounds_spent"]);
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

Deno.test("launcher round cap: a base-refresh re-admission is withheld once no round is left", () => {
  const readmit = (record: WorkRecordV1, charges: unknown[] = []) => {
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
  assert.deepEqual(readmit(authBlocked(3)), {
    candidates: [],
    denials: ["review_rounds_spent"],
  });
  const record = authBlocked(2);
  assert.deepEqual(readmit(record, reviewCharges(record.id, 3, SHA3, AI)), {
    candidates: [],
    denials: ["review_rounds_spent"],
  }, "the ledger counts too");
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
