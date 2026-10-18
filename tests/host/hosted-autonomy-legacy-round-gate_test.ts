/**
 * Generation 80 integration: the launcher hands a legacy ai.ubq.fi record its
 * one final review round (owner decision 2026-10-16: "exactly ONE final
 * current-head review on the green head") only under a proven CI-first
 * runtime, and only once a CI fix charged after the legacy cutoff armed it
 * (`review-round-cap.ts`). Every launcher re-admission counts that round
 * (pin + 1) through `reviewRoundsLeft` under the cutoff; the CI-first gate
 * withholds it from R79, the rollback target, which reviews a head before
 * its CI: the retry table's review, work and conflict re-pend grants, the
 * pre-review CI-first returns and the base-refresh re-admission all withhold
 * it (`legacy_round_requires_ci_first`) until the installed runtime is a
 * proven CI-first one, and then plan it. An unarmed legacy record (no CI fix
 * yet) has no round for any of them; a record with an ordinary round left is
 * unaffected, and a spent never-reviewed head is never returned for review.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  BASE_REFRESH_AUTH_BLOCKERS,
  hostedRepositoryKey,
  planBaseRefreshReadmissions,
  planHostedRetries,
  type RetryDenialV1,
} from "../../ops/hosted-autonomy.ts";
import { ciGreenHeadKey } from "../../ops/hosted-autonomy-ci-retries.ts";
import {
  ciCorrectionPlan,
  GREEN_SPENT_LEFT_TO_DELIVERY,
} from "../../ops/hosted-autonomy-retries.ts";
import {
  LEGACY_ROUND_REQUIRES_CI_FIRST,
  legacyFinalRoundAdmissible,
} from "../../ops/hosted-autonomy-ci-first.ts";
import { reservation, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  blockedRecord,
} from "./hosted-autonomy-fixtures.ts";
import { healthyProof, repairSnapshot } from "./hosted-autonomy-rig.ts";

const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
const NOW = T0 + 10 * 60 * 60_000;
/** The installed runtime revision every plan below runs under. */
const RUNTIME = SHA1;
const TIP = SHA1;
const TIPS = new Map([[hostedRepositoryKey(AI), TIP as string]]);
const RED_PARK = "CI red before review; awaiting a CI fix: validate(failure)";
/** The legacy cutoff: every seeded review admission (at T0) precedes it. */
const CUT = T0 + 1;

function installed(generation: number): HostedRuntimeRecordV1 {
  return {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: RUNTIME,
    generation,
    lastHealthyProof: healthyProof(RUNTIME, generation, "legacy-round"),
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
  } as HostedRuntimeRecordV1;
}

/** A listed (or unlisted) ai.ubq.fi record on its published head. */
function aiRecord(
  issue: number,
  rounds: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  const id = `issue-ubiquity-ai.ubq.fi-${issue}`;
  return parseWorkRecordV1({
    ...blockedRecord(),
    repository: AI,
    id,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    target: {
      base: SHA2,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: SHA3,
      pr: 1000 + issue,
      candidateState: {
        preserved: {
          operationKey: `impl:${"d".repeat(64)}`,
          base: SHA2,
          head: SHA3,
          ref: `refs/heads/sentinel-candidates/${"c".repeat(64)}`,
        },
        publishedHead: SHA3,
      },
    },
    counters: { attempts: 2, retries: 0, reviewRounds: rounds },
    ...overrides,
  });
}

function reviewCharges(record: WorkRecordV1, rounds: number) {
  return Array.from(
    { length: rounds },
    (_, index) =>
      reservation(`${record.id}-review-${index + 1}`, {
        repository: AI,
        taskId: record.id,
        attempt: index + 1,
        head: SHA3,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 10 + index,
      }),
  );
}

/** The CI fix charged after the cutoff that arms the legacy final round. */
function fix(record: WorkRecordV1, attempt = 3) {
  return reservation(`${record.id}-ci-fix`, {
    repository: AI,
    taskId: record.id,
    attempt,
    head: SHA3,
    purpose: "retry",
    outcome: "submitted",
    createdAt: CUT + 5,
    settledAt: CUT + 6,
  });
}

/** One review admission charged after the cutoff (the final review). */
function finalReview(record: WorkRecordV1, attempt: number) {
  return reservation(`${record.id}-review-final`, {
    repository: AI,
    taskId: record.id,
    attempt,
    head: SHA3,
    purpose: "review_request",
    outcome: "submitted",
    createdAt: CUT + 20,
    settledAt: CUT + 21,
  });
}

/**
 * Plans for one record under no proven runtime, a proven CI-first one, or a
 * proven generation-81 CI-first fix runtime (whose re-runs are settled).
 */
function plan(
  record: WorkRecordV1,
  charges: BudgetReservationV1[],
  options: {
    ciFirst?: boolean;
    fix?: boolean;
    tips?: ReadonlyMap<string, string>;
  } = {},
) {
  const denials: RetryDenialV1[] = [];
  const snapshot: RepairStateSnapshotV1 = repairSnapshot(
    [record],
    [],
    [],
    charges,
  );
  const key = ciGreenHeadKey(AI, SHA3);
  const plans = planHostedRetries(
    snapshot,
    NOW,
    RUNTIME as GitSha,
    options.tips ?? TIPS,
    new Set(),
    (denial) => denials.push(denial),
    options.ciFirst === true || options.fix === true
      ? {
        ciRuntime: installed(options.fix === true ? 81 : 80),
        ciAllowlist: new Set([RUNTIME]),
        ciFirstAllowlist: new Set([RUNTIME]),
        ciFirstFixAllowlist: new Set(options.fix === true ? [RUNTIME] : []),
        ciGreenHeads: new Set([key]),
        ciRerunSettled: new Set(options.fix === true ? [key] : []),
        legacyReviewCutoff: CUT,
      }
      : {
        ciGreenHeads: new Set([key]),
        legacyReviewCutoff: CUT,
      },
  );
  return { plans, denials: denials.map((denial) => denial.reason) };
}

Deno.test("legacy round gate: the review grant of a legacy final round waits for a CI-first runtime", () => {
  const record = aiRecord(595, 4, {
    blocker: {
      kind: "other",
      message: "review produced no verdict within the bounded review wait",
      since: T0 + 3000,
    },
  });
  const charges = [...reviewCharges(record, 4), fix(record)];
  assert.deepEqual(plan(record, charges), {
    plans: [],
    denials: [LEGACY_ROUND_REQUIRES_CI_FIRST],
  });
  const proven = plan(record, charges, { ciFirst: true });
  assert.deepEqual(proven.denials, []);
  assert.equal(proven.plans.length, 1);
  assert.equal(proven.plans[0]!.nextStep, "review");
  assert.equal(proven.plans[0]!.reviewRounds, 4);
  // Unarmed (no CI fix yet), the final round is not a review's to spend.
  assert.deepEqual(
    plan(record, reviewCharges(record, 4), { ciFirst: true }).denials,
    ["review_rounds_spent"],
  );
  // Past the pin nothing is planned under any runtime.
  const spent = aiRecord(595, 5, { blocker: record.blocker });
  assert.deepEqual(
    plan(spent, [...charges, finalReview(spent, 5)], { ciFirst: true })
      .denials,
    ["review_rounds_spent"],
  );
});

Deno.test("legacy round gate: a work grant leading to the legacy final round waits for a CI-first runtime", () => {
  const record = aiRecord(605, 3, {
    blocker: {
      kind: "other",
      message: "model run did not complete with a trusted candidate",
      since: T0 + 3000,
    },
  });
  const charges = [...reviewCharges(record, 3), fix(record)];
  const tips = new Map([[hostedRepositoryKey(AI), SHA2 as string]]);
  assert.deepEqual(plan(record, charges, { tips }), {
    plans: [],
    denials: [LEGACY_ROUND_REQUIRES_CI_FIRST],
  });
  const proven = plan(record, charges, { ciFirst: true, tips });
  assert.equal(proven.plans.length, 1, JSON.stringify(proven.denials));
  assert.equal(proven.plans[0]!.nextStep, "work");
  // An ordinary record below the ceiling is planned under any runtime.
  const ordinary = aiRecord(1583, 2, { blocker: record.blocker });
  assert.equal(
    plan(ordinary, reviewCharges(ordinary, 2), { tips }).plans.length,
    1,
  );
});

Deno.test("legacy round gate: a moved-tip conflict re-pend of a legacy record counts its final round only under a CI-first runtime", () => {
  const charge = "ab".repeat(32);
  const base = aiRecord(597, 5);
  const record = aiRecord(597, 5, {
    blocker: {
      kind: "other",
      message: "model run did not complete with a trusted candidate",
      since: T0 + 1000,
    },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(charge),
      startedAt: T0,
      branch: candidateBranch(base.id),
      expectedHead: null,
      observedBase: SHA2,
      pr: null,
      requestId: charge,
      resultId: null,
      failure: conflictMarker(SHA3, T0),
    },
  });
  const charges = [
    ...reviewCharges(record, 5),
    fix(record, 2),
    reservation(charge, {
      repository: AI,
      taskId: record.id,
      head: SHA2,
      attempt: 3,
      purpose: "retry",
      outcome: "ambiguous",
      createdAt: CUT + 10,
      settledAt: CUT + 1000,
    }),
  ];
  assert.deepEqual(plan(record, charges), {
    plans: [],
    denials: [LEGACY_ROUND_REQUIRES_CI_FIRST],
  });
  const proven = plan(record, charges, { ciFirst: true });
  assert.equal(proven.plans.length, 1, JSON.stringify(proven.denials));
  assert.equal(proven.plans[0]!.advanceBase, true);
  // One review past the pin: no resolution under any runtime.
  assert.deepEqual(
    plan(record, [...charges, finalReview(record, 6)], {
      ciFirst: true,
    }).denials,
    ["conflict_resolution_rounds_spent"],
  );
});

Deno.test("legacy round gate: a green pre-review park returns for review only with a round left and, for a legacy final round, a CI-first runtime", () => {
  const parked = (issue: number, rounds: number) =>
    aiRecord(issue, rounds, {
      blocker: { kind: "other", message: RED_PARK, since: T0 + 3000 },
      counters: { attempts: 3, retries: 1, reviewRounds: rounds },
    });
  const tips = new Map([[hostedRepositoryKey(AI), SHA2 as string]]);
  // A legacy record's CI-fixed head, green, on its unchanged base.
  const legacy = parked(668, 4);
  const armed = [...reviewCharges(legacy, 4), fix(legacy)];
  assert.deepEqual(plan(legacy, armed, { tips }).plans, []);
  const proven = plan(legacy, armed, {
    tips,
    ciFirst: true,
  });
  assert.equal(proven.plans.length, 1);
  assert.equal(proven.plans[0]!.nextStep, "work");
  // An ordinary never-reviewed head with every round spent never returns.
  const spent = parked(1583, 3);
  assert.deepEqual(
    plan(spent, reviewCharges(spent, 3), { tips, ciFirst: true }).plans,
    [],
  );
  // One with a round left returns under any runtime, as before.
  const open = parked(1583, 1);
  assert.equal(plan(open, reviewCharges(open, 1), { tips }).plans.length, 1);
});

Deno.test("legacy round gate: a pre-review park on a moved base returns for its refresh only under a CI-first runtime with a review round left", () => {
  const parked = (issue: number, rounds: number, retries: number) =>
    aiRecord(issue, rounds, {
      blocker: { kind: "other", message: RED_PARK, since: T0 + 3000 },
      counters: { attempts: 3, retries, reviewRounds: rounds },
    });
  // The records sit on SHA2; development moved to SHA1 (`TIPS`).
  // A legacy record whose final round its CI fix armed: refreshed for that
  // one review only under a proven CI-first runtime.
  const legacy = parked(668, 4, 1);
  const armed = [...reviewCharges(legacy, 4), fix(legacy)];
  assert.deepEqual(plan(legacy, armed).plans, []);
  const refreshed = plan(legacy, armed, { ciFirst: true }).plans;
  assert.equal(refreshed.length, 1);
  assert.equal(refreshed[0]!.nextStep, "work");
  assert.equal(refreshed[0]!.ciFixMarker, undefined);
  assert.match(refreshed[0]!.detail, /:base-moved$/);
  // A legacy record whose final round is still open (no fix charged since
  // the cutoff) has no review round to refresh for: the runtime's ceiling
  // gate would park it before any refresh. Its fix arms the round, so only a
  // fix runtime returns it, with the CI fix marker.
  const open = parked(673, 4, 0);
  const unarmed = reviewCharges(open, 4);
  assert.deepEqual(plan(open, unarmed, { ciFirst: true }).plans, []);
  const fixed = plan(open, unarmed, { fix: true }).plans;
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0]!.ciFixMarker, true);
  // An ordinary record with a round left: CI-first only, as above.
  const ordinary = parked(1583, 1, 0);
  assert.deepEqual(plan(ordinary, reviewCharges(ordinary, 1)).plans, []);
  assert.equal(
    plan(ordinary, reviewCharges(ordinary, 1), { ciFirst: true }).plans.length,
    1,
  );
});

Deno.test("legacy round gate: a base-refresh re-admission of a legacy final round waits for a CI-first runtime", () => {
  const record = aiRecord(610, 3, {
    target: { ...aiRecord(610, 3).target, pr: null },
    blocker: {
      kind: "other",
      message: [...BASE_REFRESH_AUTH_BLOCKERS][0]!,
      since: T0 + 1000,
    },
    counters: { attempts: 4, retries: 0, reviewRounds: 3 },
  });
  const readmit = (ciFirst: boolean, armed = true) => {
    const denials: string[] = [];
    const candidates = planBaseRefreshReadmissions(
      repairSnapshot(
        [record],
        [],
        [],
        [...reviewCharges(record, 3), ...(armed ? [fix(record)] : [])],
      ),
      SHA1,
      new Set(),
      (denial) => denials.push(denial.reason),
      ciFirst,
      CUT,
    );
    return { candidates: candidates.length, denials };
  };
  assert.deepEqual(readmit(false), {
    candidates: 0,
    denials: [LEGACY_ROUND_REQUIRES_CI_FIRST],
  });
  assert.deepEqual(readmit(true), { candidates: 1, denials: [] });
  assert.deepEqual(readmit(true, false), {
    candidates: 0,
    denials: ["review_rounds_spent"],
  });
});

Deno.test("legacy round gate: the predicate passes every ordinary round and withholds exactly the legacy final ones", () => {
  for (const [issue, pin] of [[595, 4], [618, 7], [645, 6], [1128, 5]]) {
    const record = aiRecord(issue, pin);
    const ledger = { reservations: reviewCharges(record, pin) };
    assert.equal(legacyFinalRoundAdmissible(ledger, record, false), false);
    assert.equal(legacyFinalRoundAdmissible(ledger, record, true), true);
  }
  const ordinary = aiRecord(1583, 2);
  assert.equal(
    legacyFinalRoundAdmissible(
      { reservations: reviewCharges(ordinary, 2) },
      ordinary,
      false,
    ),
    true,
  );
});

Deno.test("legacy round gate: a spent head is a CI correction only when its CI was read and is not green; green, it is never one", () => {
  // Recheck (generation 80 round 1): a green legacy head on a moved base was
  // handed to the runtime as a CI correction. Now a spent head is planned as
  // a correction only from a CI read that is not green; green on its exact
  // base it is the delivery pass's; green on a moved base it returns for the
  // carried refresh only under a CI-first runtime, never as a correction.
  const record = aiRecord(645, 6, {
    blocker: {
      kind: "other",
      message: "CI checks failed: validate(failure)",
      since: T0 + 3000,
    },
  });
  const receipt = authorizingReceipt({
    repository: AI,
    pullRequest: { number: 1645, head: SHA3, base: SHA2 },
  });
  const key = ciGreenHeadKey(AI, SHA3);
  const run = (
    options: {
      green?: boolean;
      read?: boolean;
      base?: string;
      ciFirst?: boolean;
    },
  ) => {
    const denials: RetryDenialV1[] = [];
    const plans = planHostedRetries(
      repairSnapshot([record], [receipt], [], reviewCharges(record, 6)),
      NOW,
      RUNTIME as GitSha,
      new Map([[hostedRepositoryKey(AI), options.base ?? TIP]]),
      new Set(),
      (denial) => denials.push(denial),
      {
        ciRuntime: installed(80),
        ciAllowlist: new Set([RUNTIME]),
        ciFirstAllowlist: new Set(options.ciFirst === false ? [] : [RUNTIME]),
        ciRerunSettled: new Set([key]),
        ciGreenHeads: new Set(options.green === true ? [key] : []),
        ciReadHeads: new Set(options.read === true ? [key] : []),
        legacyReviewCutoff: CUT,
      },
    );
    return { plans, denials: denials.map((denial) => denial.reason) };
  };
  // Read red: the legacy CI fix route (a correction slot).
  const red = run({ read: true });
  assert.equal(red.plans.length, 1);
  assert.equal(red.plans[0]!.nextStep, "delivery");
  assert.equal(ciCorrectionPlan(red.plans[0]!), true);
  // Not read this pass: nothing, never a guess.
  assert.deepEqual(run({}).plans, []);
  // Green on its exact reviewed base: the delivery pass merges it.
  const exact = run({ green: true, read: true, base: SHA2 });
  assert.deepEqual(exact.plans, []);
  assert.deepEqual(exact.denials, [GREEN_SPENT_LEFT_TO_DELIVERY]);
  // Green on a moved base under a CI-first runtime: the carried refresh,
  // which never counts against the correction cap.
  const moved = run({ green: true, read: true });
  assert.equal(moved.plans.length, 1);
  assert.equal(moved.plans[0]!.detail.endsWith(":green"), true);
  assert.equal(ciCorrectionPlan(moved.plans[0]!), false);
  // Green on a moved base under any other runtime: parked, never a correction.
  assert.deepEqual(
    run({ green: true, read: true, ciFirst: false }).plans,
    [],
  );
});
