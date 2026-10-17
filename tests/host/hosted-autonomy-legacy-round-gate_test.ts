/**
 * Generation 80 integration: the launcher hands a listed legacy ai.ubq.fi
 * record its one final review round (owner decision 2026-10-16: "exactly ONE
 * final current-head review on the green head") only under a proven CI-first
 * runtime. The round-cap lane counts that round (pin + 1) in every launcher
 * re-admission; the CI-first lane gates its own legacy rule on the CI-first
 * runtime because R79, the rollback target, reviews a head before its CI.
 * Integrated, no re-admission may lead R79 to that review: the retry table's
 * review, work and conflict re-pend grants, the pre-review CI-first returns,
 * and the base-refresh re-admission all withhold it
 * (`legacy_round_requires_ci_first`) until the installed runtime is a proven
 * CI-first one, and then plan it. A record with an ordinary round left is
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
import { LEGACY_REVIEW_ROUND_PINS } from "../../src/repair/review-round-cap.ts";
import {
  BASE_REFRESH_AUTH_BLOCKERS,
  hostedRepositoryKey,
  planBaseRefreshReadmissions,
  planHostedRetries,
  type RetryDenialV1,
} from "../../ops/hosted-autonomy.ts";
import { ciGreenHeadKey } from "../../ops/hosted-autonomy-ci-retries.ts";
import {
  LEGACY_ROUND_REQUIRES_CI_FIRST,
  legacyFinalRoundAdmissible,
} from "../../ops/hosted-autonomy-ci-first.ts";
import { reservation, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { blockedRecord } from "./hosted-autonomy-fixtures.ts";
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

/** Plans for one record under no proven runtime, or a proven CI-first one. */
function plan(
  record: WorkRecordV1,
  charges: BudgetReservationV1[],
  options: { ciFirst?: boolean; tips?: ReadonlyMap<string, string> } = {},
) {
  const denials: RetryDenialV1[] = [];
  const snapshot: RepairStateSnapshotV1 = repairSnapshot(
    [record],
    [],
    [],
    charges,
  );
  const plans = planHostedRetries(
    snapshot,
    NOW,
    RUNTIME as GitSha,
    options.tips ?? TIPS,
    new Set(),
    (denial) => denials.push(denial),
    options.ciFirst === true
      ? {
        ciRuntime: installed(80),
        ciAllowlist: new Set([RUNTIME]),
        ciFirstAllowlist: new Set([RUNTIME]),
        ciGreenHeads: new Set([ciGreenHeadKey(AI, SHA3)]),
      }
      : { ciGreenHeads: new Set([ciGreenHeadKey(AI, SHA3)]) },
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
  const charges = reviewCharges(record, 4);
  assert.deepEqual(plan(record, charges), {
    plans: [],
    denials: [LEGACY_ROUND_REQUIRES_CI_FIRST],
  });
  const proven = plan(record, charges, { ciFirst: true });
  assert.deepEqual(proven.denials, []);
  assert.equal(proven.plans.length, 1);
  assert.equal(proven.plans[0]!.nextStep, "review");
  assert.equal(proven.plans[0]!.reviewRounds, 4);
  // Past the pin nothing is planned under any runtime.
  const spent = aiRecord(595, 5, { blocker: record.blocker });
  assert.deepEqual(
    plan(spent, reviewCharges(spent, 5), { ciFirst: true }).denials,
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
  const charges = reviewCharges(record, 3);
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
    reservation(charge, {
      repository: AI,
      taskId: record.id,
      head: SHA2,
      attempt: 2,
      purpose: "retry",
      outcome: "ambiguous",
      settledAt: T0 + 1000,
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
    plan(record, [...charges, ...reviewCharges(record, 6).slice(5)], {
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
  assert.deepEqual(plan(legacy, reviewCharges(legacy, 4), { tips }).plans, []);
  const proven = plan(legacy, reviewCharges(legacy, 4), {
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
  const readmit = (ciFirst: boolean) => {
    const denials: string[] = [];
    const candidates = planBaseRefreshReadmissions(
      repairSnapshot([record], [], [], reviewCharges(record, 3)),
      SHA1,
      new Set(),
      (denial) => denials.push(denial.reason),
      ciFirst,
    );
    return { candidates: candidates.length, denials };
  };
  assert.deepEqual(readmit(false), {
    candidates: 0,
    denials: [LEGACY_ROUND_REQUIRES_CI_FIRST],
  });
  assert.deepEqual(readmit(true), { candidates: 1, denials: [] });
});

Deno.test("legacy round gate: the predicate passes every ordinary round and withholds exactly the legacy final ones", () => {
  for (const [issue, pin] of LEGACY_REVIEW_ROUND_PINS) {
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
