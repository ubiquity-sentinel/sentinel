/**
 * Bounds of the one-time historical re-arms (`hosted-autonomy-historical-rearms.ts`)
 * through the real retry planner and writer: the carried-patch park of a
 * spent, cleanly reviewed record (sentinel PRs 304 and 307) and the base-review
 * park of a review whose work-needed verdict was recovered (sentinel issues
 * 198, 218, 239, 270, 277 and 322). Each re-arm is a plain uncharged return to
 * `work`; every other shape, a park written at or after the cutoff and a task
 * at its no-change bound stay parked.
 */
import assert from "node:assert/strict";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { baseReviewEvidenceRef } from "../../src/github/base-review-evidence.ts";
import {
  ATTEMPT_DETAIL_NO_CHANGE,
  attemptMemorySettlementMutationV1,
} from "../../src/repair/attempt-policy.ts";
import {
  BASE_REVIEW_NOT_ESTABLISHED,
  MAX_NO_CHANGE_BASE_REVIEWS,
} from "../../src/repair/base-satisfaction-marker.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import {
  REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
} from "../../src/repair/review-round-cap.ts";
import {
  applyHostedRetries,
  planHostedRetries,
  type RetryDenialV1,
} from "../../ops/hosted-autonomy-retries.ts";
import {
  HISTORICAL_PARK_REARM_CUTOFF_MS,
  hostedIssueKey,
} from "../../ops/hosted-autonomy-policy.ts";
import {
  baseReviewVerdictKey,
  HISTORICAL_REARM_NO_CHANGE_BOUND,
  HISTORICAL_REARM_SHAPE,
  HISTORICAL_REARM_VERDICT_UNVERIFIED,
} from "../../ops/hosted-autonomy-historical-rearms.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { completedReceipt } from "../repair/loop-review-fixtures.ts";
import { createReadIssueComment } from "../../ops/hosted-autonomy-base-review-verdicts.ts";
import { seedSnapshot } from "./matrix-runtime-fixtures.ts";
import { finding } from "./hosted-autonomy-fixtures.ts";

const SELF = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};
const RUNTIME = "1ad85317e2e681b9deb5a2f4c7b653df34a691b7" as GitSha;
/** The refreshed head the park names, and the head the review approved. */
const H1 = SHA3;
const H0 = SHA1;
const BEFORE = HISTORICAL_PARK_REARM_CUTOFF_MS - 1;

function snapshotOf(
  work: WorkRecordV1[],
  rest: Partial<RepairStateSnapshotV1> = {},
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({ ...seedSnapshot(work), ...rest });
}

function plan(
  snapshot: RepairStateSnapshotV1,
  options: { workNeeded?: Set<string>; closed?: Set<string>; now?: number } =
    {},
) {
  const denials: RetryDenialV1[] = [];
  const plans = planHostedRetries(
    snapshot,
    options.now ?? HISTORICAL_PARK_REARM_CUTOFF_MS + 60_000,
    RUNTIME,
    new Map(),
    options.closed ?? new Set(),
    (denial) => denials.push(denial),
    { baseReviewWorkNeeded: options.workNeeded ?? new Set() },
  );
  return { plans, denials: denials.map((row) => row.reason) };
}

// ---------------------------------------------------------------------------
// Group A: the carried-patch park.
// ---------------------------------------------------------------------------

const CARRIED_ID = "issue-ubiquity-sentinel-285" as WorkItemId;
const CARRIED_PARK =
  `${REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX}reviewed ${H0} on ${SHA2} sha256:${
    "a".repeat(64)
  }, refreshed ${H1} on ${SHA2} (merge base ${SHA2}) sha256:${"b".repeat(64)}`;

function carriedPark(overrides: Record<string, unknown> = {}): WorkRecordV1 {
  return workRecord(CARRIED_ID, {
    repository: SELF,
    source: { kind: "issue", id: "285", revision: SHA1 },
    related: { incidentId: null, issueNumber: 285 },
    target: {
      base: SHA2,
      branch: candidateBranch(CARRIED_ID),
      checkpoint: null,
      head: H1,
      pr: 304,
    },
    nextStep: "blocked",
    blocker: { kind: "other", message: CARRIED_PARK, since: BEFORE },
    counters: { attempts: 2, retries: 1, reviewRounds: 5 },
    ...overrides,
  });
}

function carriedCharges(rounds: number): BudgetReservationV1[] {
  return [
    reservation("impl-285", {
      repository: SELF,
      taskId: CARRIED_ID,
      attempt: 2,
      purpose: "retry",
      outcome: "submitted",
      settledAt: T0 + 1,
    }),
    ...Array.from(
      { length: rounds },
      (_, index) =>
        reservation(`review-285-${index + 1}`, {
          repository: SELF,
          taskId: CARRIED_ID,
          attempt: index + 1,
          head: H0,
          purpose: "review_request",
          outcome: "submitted",
          settledAt: T0 + 2,
        }),
    ),
  ];
}

function cleanReceipt(head: GitSha, overrides: Record<string, unknown> = {}) {
  return completedReceipt(304, head, SHA2, {
    id: `review-receipt:304:${head}`,
    repository: SELF,
    ...overrides,
  });
}

function carriedState(
  record = carriedPark(),
  rounds = 5,
  receipt = cleanReceipt(H0),
): RepairStateSnapshotV1 {
  return snapshotOf([record], {
    reservations: carriedCharges(rounds),
    reviews: [receipt],
  });
}

Deno.test("historical re-arm: a carried-patch park returns once to the carried work step, uncharged", () => {
  const state = carriedState();
  const { plans } = plan(state);
  assert.equal(plans.length, 1);
  assert.deepEqual(plans[0], {
    id: CARRIED_ID,
    repository: SELF,
    grant: 0,
    nextStep: "work",
    reviewRounds: null,
    advanceBase: false,
    observedBase: null,
    detail: "other:historical_rearm:carried_patch",
  });
  const now = HISTORICAL_PARK_REARM_CUTOFF_MS + 60_000;
  const applied = applyHostedRetries(state, SHA2, plans, now);
  const [record] = applied.work;
  assert.equal(record.nextStep, "work");
  assert.equal(record.blocker, null);
  assert.equal(record.intent, null);
  assert.equal(record.wait, null);
  // Target, counters, reviews and every charge stay exactly as they were.
  assert.deepEqual(record.target, state.work[0].target);
  assert.deepEqual(record.counters, state.work[0].counters);
  assert.deepEqual(applied.reservations, state.reservations);
  assert.deepEqual(applied.reviews, state.reviews);
});

Deno.test("historical re-arm: the carried-patch re-arm is bounded to historical parks of the exact carried shape", () => {
  const at = (since: number) =>
    carriedPark({
      blocker: { kind: "other", message: CARRIED_PARK, since },
    });
  // Written at or after the cutoff (a re-armed record parked again included).
  assert.equal(
    plan(carriedState(at(HISTORICAL_PARK_REARM_CUTOFF_MS))).plans.length,
    0,
  );
  assert.equal(
    plan(carriedState(at(HISTORICAL_PARK_REARM_CUTOFF_MS + 5))).plans.length,
    0,
  );
  // Another carried park class is not this re-arm.
  const red = carriedPark({
    blocker: {
      kind: "other",
      message: `${REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX}validate`,
      since: BEFORE,
    },
  });
  assert.equal(plan(carriedState(red)).plans.length, 0);
  // A retained intent keeps its owner.
  const intent = carriedPark({
    intent: {
      kind: "base_refresh",
      key: `base_refresh:304:${H1}:${SHA1}`,
      startedAt: T0,
      branch: candidateBranch(CARRIED_ID),
      expectedHead: H1,
      observedBase: SHA1,
      pr: 304,
      requestId: null,
      resultId: null,
    },
  });
  let result = plan(carriedState(intent));
  assert.deepEqual(result, { plans: [], denials: [HISTORICAL_REARM_SHAPE] });
  // The latest review is of the current head: nothing is carried.
  result = plan(carriedState(carriedPark(), 5, cleanReceipt(H1)));
  assert.deepEqual(result, { plans: [], denials: [HISTORICAL_REARM_SHAPE] });
  // A review with an unresolved P0, or without task acceptance, carries nothing.
  result = plan(carriedState(
    carriedPark(),
    5,
    cleanReceipt(H0, {
      findings: [finding("P0")],
      unresolvedSeverities: ["P0"],
    }),
  ));
  assert.deepEqual(result, { plans: [], denials: [HISTORICAL_REARM_SHAPE] });
  result = plan(carriedState(
    carriedPark(),
    5,
    cleanReceipt(H0, {
      taskAcceptance: {
        issueNumber: 285,
        taskDigest: "d".repeat(64),
        verdict: "not_fulfilled",
        evidence: ["missing"],
      },
    }),
  ));
  assert.deepEqual(result, { plans: [], denials: [HISTORICAL_REARM_SHAPE] });
  // Rounds not spent: the runtime would not enter the carried delivery.
  const unspent = carriedPark({
    counters: { attempts: 2, retries: 1, reviewRounds: 1 },
  });
  result = plan(carriedState(unspent, 1));
  assert.deepEqual(result, { plans: [], denials: [HISTORICAL_REARM_SHAPE] });
  // No published pull request, or a foreign branch.
  const unpublished = carriedPark({
    target: { ...carriedPark().target, pr: null },
  });
  assert.equal(plan(carriedState(unpublished)).plans.length, 0);
  const foreign = carriedPark({
    target: { ...carriedPark().target, branch: "feature/other" },
  });
  assert.equal(plan(carriedState(foreign)).plans.length, 0);
  // A closed source issue is never re-armed.
  assert.equal(
    plan(carriedState(), { closed: new Set([hostedIssueKey(SELF, 285)]) })
      .plans.length,
    0,
  );
});

// ---------------------------------------------------------------------------
// Group B: the base-review park.
// ---------------------------------------------------------------------------

const BASE_ID = "issue-ubiquity-sentinel-198" as WorkItemId;
const ORIGIN = "4".repeat(64);
const ADMISSION = "a".repeat(64);
const TASK = "7".repeat(64);
const RESULT = "e".repeat(64);
const REF = baseReviewEvidenceRef({
  issueNumber: 198,
  base: SHA2,
  taskDigest: TASK,
  admission: ADMISSION,
  resultComment: 6381395416,
  resultDigest: RESULT,
  executionComment: 6381395561,
  executionDigest: "f".repeat(64),
});

function basePark(overrides: Record<string, unknown> = {}): WorkRecordV1 {
  return workRecord(BASE_ID, {
    repository: SELF,
    source: { kind: "issue", id: "198", revision: SHA2 },
    related: { incidentId: null, issueNumber: 198 },
    target: {
      base: SHA2,
      branch: candidateBranch(BASE_ID),
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "blocked",
    blocker: {
      kind: "missing_evidence",
      message: BASE_REVIEW_NOT_ESTABLISHED,
      since: BEFORE,
    },
    intent: {
      kind: "issue_closure",
      key: `base-review:${ORIGIN}:${TASK}`,
      startedAt: T0,
      branch: null,
      expectedHead: SHA2,
      observedBase: SHA2,
      pr: null,
      requestId: ADMISSION,
      resultId: RESULT,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    evidence: [{ kind: "review_receipt", ref: REF }],
    ...overrides,
  });
}

function baseCharges(
  review: Record<string, unknown> = {},
): BudgetReservationV1[] {
  return [
    reservation(ORIGIN, {
      repository: SELF,
      taskId: BASE_ID,
      head: SHA1,
      purpose: "implementation",
      outcome: "ambiguous",
      settledAt: T0 + 1,
    }),
    reservation(ADMISSION, {
      repository: SELF,
      taskId: BASE_ID,
      head: SHA2,
      purpose: "review_request",
      outcome: "submitted",
      settledAt: T0 + 2,
      ...review,
    }),
  ];
}

/** `count` durable no-change outcomes of the task, as the runtime records them. */
async function withNoChange(
  state: RepairStateSnapshotV1,
  count: number,
): Promise<RepairStateSnapshotV1> {
  const draft = structuredClone(state);
  for (let index = 0; index < count; index++) {
    (await attemptMemorySettlementMutationV1({
      record: {
        ...draft.work[0],
        target: { ...draft.work[0].target, base: SHA1 },
      },
      detail: ATTEMPT_DETAIL_NO_CHANGE,
      now: T0 + index,
      runtimeSha: SHA1,
    }))(draft);
  }
  return parseRepairStateSnapshotV1(draft);
}

function baseState(
  record = basePark(),
  options: { review?: Record<string, unknown>; outcomes?: number } = {},
): Promise<RepairStateSnapshotV1> {
  return withNoChange(
    snapshotOf([record], { reservations: baseCharges(options.review) }),
    options.outcomes ?? 1,
  );
}

const verifiedKey = () => {
  const record = basePark();
  return baseReviewVerdictKey(record, {
    issueNumber: 198,
    base: SHA2,
    taskDigest: TASK,
    admission: ADMISSION,
    resultComment: 6381395416,
    resultDigest: RESULT,
    executionComment: 6381395561,
    executionDigest: "f".repeat(64),
  });
};

Deno.test("historical re-arm: a base-review park with a recovered work-needed verdict returns to implementation as the runtime does", async () => {
  const state = await baseState();
  const { plans } = plan(state, { workNeeded: new Set([verifiedKey()]) });
  assert.equal(plans.length, 1);
  assert.equal(
    plans[0].detail,
    "missing_evidence:historical_rearm:base_review_work_needed",
  );
  const applied = applyHostedRetries(state, SHA2, plans, T0 + 9);
  const [record] = applied.work;
  // The runtime's own work-needed return: intent, wait and blocker cleared,
  // the reviewed base and the review evidence kept, no charge touched.
  assert.deepEqual(record, {
    ...state.work[0],
    nextStep: "work",
    blocker: null,
    intent: null,
    wait: null,
    updatedAt: T0 + 9,
  });
  assert.deepEqual(applied.reservations, state.reservations);
});

Deno.test("historical re-arm: the launcher's comment reader returns only the exact comment of the named issue", async () => {
  const paths: string[] = [];
  const wire = (issue: number) => ({
    id: 6381395416,
    body: "~~~json\n{}\n~~~",
    user: { login: "ubiquity-sentinel[bot]" },
    issue_url:
      `https://api.github.com/repos/ubiquity-sentinel/sentinel/issues/${issue}`,
  });
  let served: unknown = wire(198);
  const read = createReadIssueComment((_method, path) => {
    paths.push(path);
    return Promise.resolve(served);
  }, "ubiquity-sentinel/sentinel");
  assert.deepEqual(await read(198, 6381395416), {
    id: 6381395416,
    body: "~~~json\n{}\n~~~",
    author: "ubiquity-sentinel[bot]",
  });
  assert.deepEqual(paths, [
    "/repos/ubiquity-sentinel/sentinel/issues/comments/6381395416",
  ]);
  // A comment of another issue, an unreadable answer or a malformed id.
  served = wire(199);
  assert.equal(await read(198, 6381395416), null);
  served = null;
  assert.equal(await read(198, 6381395416), null);
  served = wire(198);
  assert.equal(await read(198, 0), null);
  assert.equal(await read(0, 6381395416), null);
  assert.equal(paths.length, 3);
});

Deno.test("historical re-arm: a base-review park stays parked without a recovered verdict, at its bound or after the cutoff", async () => {
  const workNeeded = new Set([verifiedKey()]);
  // No recovered verdict: "review unavailable / no acceptance" is never guessed.
  assert.deepEqual(plan(await baseState()), {
    plans: [],
    denials: [HISTORICAL_REARM_VERDICT_UNVERIFIED],
  });
  // The runtime's no-change bound (issue 218 holds 16 such outcomes).
  for (const outcomes of [MAX_NO_CHANGE_BASE_REVIEWS, 16]) {
    assert.deepEqual(
      plan(await baseState(basePark(), { outcomes }), { workNeeded }),
      { plans: [], denials: [HISTORICAL_REARM_NO_CHANGE_BOUND] },
    );
  }
  assert.equal(
    plan(
      await baseState(basePark(), { outcomes: MAX_NO_CHANGE_BASE_REVIEWS - 1 }),
      { workNeeded },
    ).plans.length,
    1,
  );
  // Written at or after the cutoff.
  const late = basePark({
    blocker: {
      kind: "missing_evidence",
      message: BASE_REVIEW_NOT_ESTABLISHED,
      since: HISTORICAL_PARK_REARM_CUTOFF_MS,
    },
  });
  assert.equal(plan(await baseState(late), { workNeeded }).plans.length, 0);
  // A closed issue.
  assert.equal(
    plan(await baseState(), {
      workNeeded,
      closed: new Set([hostedIssueKey(SELF, 198)]),
    }).plans.length,
    0,
  );
  // The binding must be exact: its review charge settled `submitted` at the
  // reviewed base, the evidence naming the intent's admission and result, a
  // record without head or pull request, both charges present.
  const intent = basePark().intent!;
  for (
    const state of [
      await baseState(basePark(), { review: { outcome: "ambiguous" } }),
      await baseState(basePark(), { review: { head: SHA1 } }),
      await baseState(basePark({ evidence: [] })),
      await baseState(
        basePark({ intent: { ...intent, resultId: "0".repeat(64) } }),
      ),
      await baseState(
        basePark({
          intent: { ...intent, key: `base-review:${ORIGIN}:${RESULT}` },
        }),
      ),
      await baseState(basePark({
        target: { ...basePark().target, head: H1, pr: 9 },
      })),
      await baseState(basePark({ intent: null })),
      await withNoChange(snapshotOf([basePark()]), 1),
    ]
  ) {
    assert.deepEqual(plan(state, { workNeeded }), {
      plans: [],
      denials: [HISTORICAL_REARM_SHAPE],
    });
  }
});
