/**
 * The pure hard review-round ceiling policy (owner decision 2026-10-16:
 * "44 rounds is insane, 3 round max"): rounds spent from the durable ledger
 * and the counter, the fail-closed one-time legacy table, the fixed park
 * messages and their choice, and the protection of the ceiling itself.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { CI_CORRECTION_REVIEW_ROUNDS } from "../../src/repair/ci-rejection.ts";
import { CONFLICT_RESOLUTION_REVIEW_ROUNDS } from "../../src/repair/conflict-resolution.ts";
import { reviewOperationKey } from "../../src/repair/keys.ts";
import {
  ceilingParkMessage,
  isDeliverableReviewRoundCeilingPark,
  isReviewRoundCeilingPark,
  LEGACY_REVIEW_ROUND_PINS,
  legacyReviewRoundClassPin,
  legacyReviewRoundPin,
  MAX_REVIEW_ROUNDS,
  ordinaryReviewRoundsSpent,
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_DELIVERABLE_MESSAGES,
  REVIEW_ROUND_CEILING_MESSAGES,
  REVIEW_ROUND_CEILING_PREFIX,
  REVIEW_ROUND_CEILING_REJECTED,
  REVIEW_ROUND_CEILING_REVIEWED,
  REVIEW_ROUND_CEILING_UNACCEPTED,
  REVIEW_ROUND_CEILING_UNREVIEWED,
  reviewRoundCeiling,
  reviewRoundsLeft,
  reviewRoundsSpent,
} from "../../src/repair/review-round-cap.ts";
import {
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
} from "../../src/repair/review-gate.ts";
import {
  HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS,
  HOSTED_AUTONOMY_RETRYABLE,
} from "../../ops/hosted-autonomy-policy.ts";
import { BASE_REFRESH_AUTH_BLOCKERS } from "../../ops/hosted-autonomy-base-refresh-retries.ts";
import {
  REPO,
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  CAP_BASE_MOVED,
  CAP_PREFIX,
  CAP_REJECTED,
  CAP_REVIEWED,
  CAP_UNACCEPTED,
  CAP_UNREVIEWED,
  completedReceipt,
  PR,
  reviewCharges,
} from "./review-round-cap-rig.ts";

const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;

function task(
  rounds: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord("issue-1", {
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-1",
      checkpoint: null,
      head: SHA3,
      pr: PR,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: rounds },
    ...overrides,
  });
}

function legacy(issue: number, rounds: number, overrides = {}): WorkRecordV1 {
  const id = `issue-ubiquity-ai.ubq.fi-${issue}`;
  return workRecord(id, {
    repository: AI,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    counters: { attempts: 1, retries: 0, reviewRounds: rounds },
    ...overrides,
  });
}

const ledger = (rows: ReturnType<typeof reviewCharges>) => ({
  reservations: rows,
});

Deno.test("round cap policy: one ceiling of three, every alias equal", () => {
  assert.equal(MAX_REVIEW_ROUNDS, 3);
  assert.equal(CI_CORRECTION_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS);
  assert.equal(CONFLICT_RESOLUTION_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS);
  assert.equal(HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS);
});

Deno.test("round cap policy: the park messages are fixed text under one prefix", () => {
  assert.equal(REVIEW_ROUND_CEILING_PREFIX, CAP_PREFIX);
  assert.equal(REVIEW_ROUND_CEILING_UNREVIEWED, CAP_UNREVIEWED);
  assert.equal(REVIEW_ROUND_CEILING_REJECTED, CAP_REJECTED);
  assert.equal(REVIEW_ROUND_CEILING_UNACCEPTED, CAP_UNACCEPTED);
  assert.equal(REVIEW_ROUND_CEILING_BASE_MOVED, CAP_BASE_MOVED);
  assert.equal(REVIEW_ROUND_CEILING_REVIEWED, CAP_REVIEWED);
  assert.deepEqual(REVIEW_ROUND_CEILING_MESSAGES, [
    CAP_UNREVIEWED,
    CAP_REJECTED,
    CAP_UNACCEPTED,
    CAP_BASE_MOVED,
    CAP_REVIEWED,
  ]);
  for (const message of REVIEW_ROUND_CEILING_MESSAGES) {
    assert.ok(message.startsWith(CAP_PREFIX));
    assert.ok(message.length <= 200, message);
  }
  // No current re-admission, re-arm or recovery rule takes a park.
  for (const message of REVIEW_ROUND_CEILING_MESSAGES) {
    for (const rule of HOSTED_AUTONOMY_RETRYABLE) {
      assert.ok(!message.startsWith(rule.prefix), `${rule.prefix}: ${message}`);
    }
    assert.equal(BASE_REFRESH_AUTH_BLOCKERS.has(message), false);
    assert.notEqual(message, TASK_ACCEPTANCE_MISSING_DETAIL);
    assert.notEqual(message, TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL);
    assert.ok(!message.startsWith("review rounds exhausted"));
  }
});

Deno.test("round cap policy: rounds spent are the larger of the ledger and the counter", () => {
  // The ledger catches a lowered or lagging counter (live 264: 0 vs 3).
  assert.equal(
    reviewRoundsSpent(ledger(reviewCharges("issue-1", 3)), task(0)),
    3,
  );
  assert.equal(
    reviewRoundsLeft(ledger(reviewCharges("issue-1", 3)), task(0)),
    0,
  );
  // The counter catches a round counted without a charge.
  assert.equal(reviewRoundsSpent(ledger([]), task(3)), 3);
  assert.equal(reviewRoundsLeft(ledger([]), task(2)), 1);
  // Charges of any head count; another task or repository never does.
  const mixed = [
    ...reviewCharges("issue-1", 1, { head: SHA1 }),
    ...reviewCharges("issue-1", 2).slice(1),
    ...reviewCharges("issue-2", 3),
    ...reviewCharges("issue-1", 3, {
      repository: { ...REPO, installationId: 8 },
    }).map((row) => ({ ...row, id: `${row.id}-other` })),
  ];
  assert.equal(reviewRoundsSpent(ledger(mixed), task(0)), 2);
  // Other purposes never count.
  const implementation = reservation("impl-1", {
    taskId: "issue-1",
    purpose: "implementation",
    outcome: "submitted",
    settledAt: T0 + 1,
  });
  assert.equal(reviewRoundsSpent(ledger([implementation]), task(0)), 0);
});

Deno.test("round cap policy: ambiguous and in-flight charges are spent, refunds are not", () => {
  const ambiguous = reviewCharges("issue-1", 3, {
    outcome: (attempt) => attempt === 3 ? "ambiguous" : "submitted",
  });
  assert.equal(reviewRoundsSpent(ledger(ambiguous), task(2)), 3);
  // A refund bumped the counter but submitted nothing: it frees its round.
  const refunded = reviewCharges("issue-1", 3, {
    outcome: (attempt) =>
      attempt === 3 ? "confirmed_not_submitted" : "submitted",
  });
  assert.equal(reviewRoundsSpent(ledger(refunded), task(3)), 2);
  assert.equal(reviewRoundsLeft(ledger(refunded), task(3)), 1);
  // An admission in flight (its intent names it) is spent.
  const inFlight = reviewCharges("issue-1", 3, {
    outcome: (attempt) => attempt === 3 ? "reserved" : "submitted",
  });
  const withIntent = task(2, {
    intent: {
      kind: "review_request",
      key: reviewOperationKey(PR, SHA3, 3),
      startedAt: T0,
      branch: "sentinel/repair/issue-1",
      expectedHead: SHA3,
      observedBase: SHA1,
      pr: PR,
      requestId: inFlight[2]!.id,
      resultId: null,
    },
  });
  assert.equal(reviewRoundsSpent(ledger(inFlight), withIntent), 3);
  // The same admission with its intent lost is the round the next request
  // completes (never a second charge), so it is not spent yet.
  assert.equal(reviewRoundsSpent(ledger(inFlight), task(2)), 2);
  assert.equal(reviewRoundsLeft(ledger(inFlight), task(2)), 1);
  // A reserved admission at another attempt or head stays spent.
  const stale = reviewCharges("issue-1", 3, {
    outcome: (attempt) => attempt === 3 ? "reserved" : "submitted",
    head: SHA2,
  });
  assert.equal(reviewRoundsSpent(ledger(stale), task(2)), 3);
  assert.equal(reviewRoundsSpent(ledger(inFlight), task(1)), 3);
});

Deno.test("round cap policy: the one-time legacy table matches exact identities and fails closed", () => {
  assert.deepEqual([...LEGACY_REVIEW_ROUND_PINS.entries()], [
    [137, 5],
    [575, 3],
    [595, 4],
    [597, 5],
    [602, 6],
    [605, 3],
    [610, 3],
    [618, 7],
    [634, 4],
    [638, 5],
    [668, 4],
    [672, 3],
    [673, 7],
    [678, 6],
    [679, 6],
    [680, 4],
    [693, 3],
    [694, 3],
    [698, 9],
    [754, 3],
    [879, 3],
  ]);
  for (const [issue, pin] of LEGACY_REVIEW_ROUND_PINS) {
    const record = legacy(issue, pin);
    assert.equal(legacyReviewRoundPin(record), pin);
    assert.equal(reviewRoundCeiling(record), pin + 1);
    const spent = reviewCharges(record.id, pin, { repository: AI });
    assert.equal(reviewRoundsLeft(ledger(spent), record), 1, `${issue}`);
    // R79 spent the allowance before generation 80 shipped: capped.
    const past = reviewCharges(record.id, pin + 1, { repository: AI });
    assert.equal(reviewRoundsLeft(ledger(past), legacy(issue, pin + 1)), 0);
  }
  // The ordinary ceiling is spent by the ledger-aware count whatever the
  // legacy allowance: the final round is extra.
  assert.equal(ordinaryReviewRoundsSpent(ledger([]), legacy(698, 9)), true);
  assert.equal(ordinaryReviewRoundsSpent(ledger([]), legacy(698, 2)), false);
  assert.equal(
    ordinaryReviewRoundsSpent(
      ledger(reviewCharges("issue-ubiquity-ai.ubq.fi-698", 3, {
        repository: AI,
      })),
      legacy(698, 2),
    ),
    true,
  );
  // Exactly one round even when the record spent less than its pin.
  assert.equal(reviewRoundsLeft(ledger([]), legacy(618, 3)), 1);
  // Any other identity keeps the plain ceiling.
  const unlisted = legacy(596, 6);
  assert.equal(legacyReviewRoundPin(unlisted), null);
  assert.equal(reviewRoundCeiling(unlisted), MAX_REVIEW_ROUNDS);
  assert.equal(reviewRoundsLeft(ledger([]), unlisted), 0);
  const variants: WorkRecordV1[] = [
    legacy(595, 4, { repository: { ...AI, installationId: 7 } }),
    legacy(595, 4, { repository: { ...AI, name: "ai.ubq.fi-fork" } }),
    legacy(595, 4, { source: { kind: "issue", id: "596", revision: SHA1 } }),
    workRecord("issue-595", {
      repository: AI,
      source: { kind: "issue", id: "595", revision: SHA1 },
      related: { incidentId: null, issueNumber: 595 },
      counters: { attempts: 1, retries: 0, reviewRounds: 4 },
    }),
  ];
  for (const record of variants) {
    assert.equal(legacyReviewRoundPin(record), null, record.id);
    assert.equal(reviewRoundsLeft(ledger([]), record), 0, record.id);
  }
});

Deno.test("round cap policy: the legacy table is the owner's class at its pinned state", () => {
  // The owner's twelve (decision-time state, sequence 36388) and the nine
  // more that generation 79 parked the same way by sequence 37449.
  const owners = [595, 597, 605, 610, 618, 668, 672, 673, 680, 694, 698, 879];
  const since = [137, 575, 602, 634, 638, 678, 679, 693, 754];
  assert.deepEqual(
    [...LEGACY_REVIEW_ROUND_PINS.keys()],
    [...owners, ...since].sort((a, b) => a - b),
  );
  const parked = (
    issue: number,
    rounds: number,
    blocker: { kind: string; message: string } = {
      kind: "other",
      message: "CI checks failed: verify-artifact(skipped), validate(failure)",
    },
    overrides: Record<string, unknown> = {},
  ) =>
    legacy(issue, rounds, {
      nextStep: "blocked",
      blocker: { ...blocker, since: T0 },
      ...overrides,
    });
  // Every pinned record, as the pinned state holds it, is a class member at
  // exactly its pin.
  for (const [issue, pin] of LEGACY_REVIEW_ROUND_PINS) {
    assert.equal(
      legacyReviewRoundClassPin(ledger([]), parked(issue, pin)),
      pin,
    );
  }
  // The unattributed CI block is CI red too; the ledger beats a lagging
  // counter, as it does for the ceiling itself.
  assert.equal(
    legacyReviewRoundClassPin(
      ledger([]),
      parked(9001, 3, {
        kind: "other",
        message: "CI checks failed without base evidence: validate(failure)",
      }),
    ),
    3,
  );
  const id = "issue-ubiquity-ai.ubq.fi-9002";
  assert.equal(
    legacyReviewRoundClassPin(
      ledger(reviewCharges(id, 4, { repository: AI })),
      parked(9002, 2),
    ),
    4,
  );
  // Not the class: rounds left, a non-CI blocker (task acceptance, a hand
  // merge, missing evidence, the retired quota block), a record not parked,
  // another repository or identity shape.
  const outside: WorkRecordV1[] = [
    parked(9003, 2),
    parked(112, 8, {
      kind: "other",
      message: "task acceptance not fulfilled: the candidate does not satisfy",
    }),
    parked(421, 4, {
      kind: "other",
      message: "pull request was merged outside the trusted review path",
    }),
    parked(263, 3, {
      kind: "missing_evidence",
      message: "task acceptance missing: a change-only review cannot authorize",
    }),
    parked(9004, 4, {
      kind: "review_quota",
      message: "CI checks failed: validate(failure)",
    }),
    legacy(9005, 4),
    parked(9006, 4, undefined, { repository: { ...AI, installationId: 7 } }),
    parked(9007, 4, undefined, {
      source: { kind: "issue", id: "1", revision: SHA1 },
    }),
  ];
  for (const record of outside) {
    assert.equal(
      legacyReviewRoundClassPin(ledger([]), record),
      null,
      `${record.id} ${record.blocker?.message}`,
    );
  }
});

Deno.test("round cap policy: the latest completed review of the current head picks the park", () => {
  const record = task(3);
  const choose = (reviews: ReturnType<typeof completedReceipt>[]) =>
    ceilingParkMessage({ reviews }, record);
  assert.equal(choose([]), CAP_UNREVIEWED);
  assert.equal(choose([completedReceipt(3, SHA3, "p1")]), CAP_REJECTED);
  assert.equal(
    choose([completedReceipt(3, SHA3, "unaccepted")]),
    CAP_UNACCEPTED,
  );
  assert.equal(choose([completedReceipt(3, SHA3, "clean")]), CAP_REVIEWED);
  // An uncounted finding is never treated as resolved.
  assert.equal(
    choose([{ ...completedReceipt(3, SHA3, "clean"), findingsUncounted: 1 }]),
    CAP_REJECTED,
  );
  // A negative task verdict is no acceptance.
  const notFulfilled = completedReceipt(3, SHA3, "clean");
  assert.equal(
    choose([{
      ...notFulfilled,
      taskAcceptance: {
        ...notFulfilled.taskAcceptance!,
        verdict: "not_fulfilled",
      },
    }]),
    CAP_UNACCEPTED,
  );
  // The LATEST completed review decides, both ways.
  assert.equal(
    choose([
      completedReceipt(2, SHA3, "p1", { completedAt: T0 - 5000 }),
      completedReceipt(3, SHA3, "clean", { completedAt: T0 }),
    ]),
    CAP_REVIEWED,
  );
  assert.equal(
    choose([
      completedReceipt(2, SHA3, "clean", { completedAt: T0 - 5000 }),
      completedReceipt(3, SHA3, "p1", { completedAt: T0 }),
    ]),
    CAP_REJECTED,
  );
  // Reviews of another head, another PR or still pending never decide.
  assert.equal(choose([completedReceipt(3, SHA2, "clean")]), CAP_UNREVIEWED);
  assert.equal(
    choose([{
      ...completedReceipt(3, SHA3, "clean"),
      pullRequest: { number: PR + 1, head: SHA3, base: SHA1 },
    }]),
    CAP_UNREVIEWED,
  );
  assert.equal(
    choose([reviewReceipt("pending", {
      pullRequest: { number: PR, head: SHA3, base: SHA1 },
    })]),
    CAP_UNREVIEWED,
  );
  assert.equal(
    ceilingParkMessage({ reviews: [completedReceipt(3, SHA3, "clean")] }, {
      ...record,
      target: { ...record.target, head: null, pr: null },
    }),
    CAP_UNREVIEWED,
  );
});

Deno.test("round cap policy: only the five fixed blockers are ceiling parks", () => {
  const blocked = (kind: string, message: string) =>
    task(3, {
      nextStep: "blocked",
      blocker: { kind, message, since: T0 },
    });
  for (const message of REVIEW_ROUND_CEILING_MESSAGES) {
    assert.equal(isReviewRoundCeilingPark(blocked("other", message)), true);
    assert.equal(
      isReviewRoundCeilingPark(blocked("unavailable", message)),
      false,
    );
  }
  assert.equal(
    isReviewRoundCeilingPark(blocked("other", `${CAP_PREFIX}anything`)),
    false,
  );
  assert.equal(isReviewRoundCeilingPark(task(3)), false);
});

Deno.test("round cap policy: only the BASE_MOVED and REVIEWED parks are deliverable, by exact message", () => {
  const blocked = (kind: string, message: string) =>
    task(3, { nextStep: "blocked", blocker: { kind, message, since: T0 } });
  assert.deepEqual(REVIEW_ROUND_CEILING_DELIVERABLE_MESSAGES, [
    CAP_BASE_MOVED,
    CAP_REVIEWED,
  ]);
  for (const message of REVIEW_ROUND_CEILING_MESSAGES) {
    const deliverable = message === CAP_BASE_MOVED || message === CAP_REVIEWED;
    assert.equal(
      isDeliverableReviewRoundCeilingPark(blocked("other", message)),
      deliverable,
      message,
    );
    for (
      const variant of [
        blocked("review_quota", message),
        blocked("other", `${message} `),
        blocked("other", `${message}: anything`),
        { ...blocked("other", message), nextStep: "delivery" as const },
      ]
    ) assert.equal(isDeliverableReviewRoundCeilingPark(variant), false);
  }
  assert.equal(
    isDeliverableReviewRoundCeilingPark(blocked("other", CAP_PREFIX)),
    false,
  );
  assert.equal(isDeliverableReviewRoundCeilingPark(task(3)), false);
});

Deno.test("round cap policy: a model-authored candidate can never weaken the ceiling", () => {
  const { protectedPaths } = createLocalRepositoryConfig();
  for (
    const path of [
      "src/repair/review-round-cap.ts",
      "src/repair/loop-review-round-cap.ts",
      "src/repair/loop-review-request.ts",
      "src/repair/loop-review-result.ts",
      "src/repair/loop-work.ts",
      "src/repair/loop-merge.ts",
      "src/repair/loop-eligibility.ts",
      "src/repair/loop-state.ts",
      "ops/hosted-autonomy-retries.ts",
      "ops/hosted-autonomy-policy.ts",
      "ops/hosted-autonomy-refresh-rearm.ts",
      "ops/hosted-autonomy-base-refresh-retries.ts",
    ]
  ) assert.ok(protectedPaths.includes(path), path);
});
