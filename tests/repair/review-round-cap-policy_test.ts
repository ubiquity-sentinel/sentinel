/**
 * The pure hard review-round ceiling policy (owner decision 2026-10-16:
 * "44 rounds is insane, 3 round max"): rounds spent from the durable ledger
 * and the counter, the fail-closed one-time legacy rule, the fixed park
 * messages and their choice, and the protection of the ceiling itself.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { CI_CORRECTION_REVIEW_ROUNDS } from "../../src/repair/ci-rejection.ts";
import { CONFLICT_RESOLUTION_REVIEW_ROUNDS } from "../../src/repair/conflict-resolution.ts";
import { reviewRoundAvailable } from "../../src/repair/ci-first-policy.ts";
import { reviewOperationKey } from "../../src/repair/keys.ts";
import {
  ceilingParkMessage,
  isDeliverableReviewRoundCeilingPark,
  isReviewRoundCeilingPark,
  LEGACY_REVIEW_CUTOFF,
  LEGACY_REVIEW_ROUND_CEILING,
  legacyFinalRoundArmed,
  legacyFinalRoundOpen,
  legacyReviewRoundClassDrift,
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
  reviewRoundCeilingFor,
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

/**
 * A completed receipt of `head` rejected by one unresolved P0 finding. Owner
 * directive 2026-10-24 ("the only internal policy is resolve all P0"): only an
 * unresolved P0 rejects a head; the rig's own "p1" verdict is a clean review
 * under that rule.
 */
function rejectedReceipt(
  round: number,
  head: GitSha,
  options: { base?: GitSha; completedAt?: number } = {},
) {
  const receipt = completedReceipt(round, head, "p1", options);
  return {
    ...receipt,
    findings: receipt.findings.map((finding) => ({
      ...finding,
      severity: "P0" as const,
      message: "P0 finding",
    })),
    unresolvedSeverities: ["P0" as const],
  };
}

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

Deno.test("round cap policy: five for the CI-first era, three before it, every alias equal", () => {
  // Owner decision 2026-10-24 raised the ordinary ceiling from three to five;
  // the legacy class keeps the 2026-10-16 ceiling.
  assert.equal(MAX_REVIEW_ROUNDS, 5);
  assert.equal(LEGACY_REVIEW_ROUND_CEILING, 3);
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

/** The legacy cutoff of these cases: every seeded charge precedes it. */
const CUT = T0;

/** One counted charge of `purpose` created at `at`. */
function charge(
  record: WorkRecordV1,
  attempt: number,
  purpose: "review_request" | "retry",
  at: number,
  outcome: "submitted" | "confirmed_not_submitted" = "submitted",
) {
  return reservation(`${record.id}-${purpose}-${attempt}-${at}`, {
    repository: record.repository,
    taskId: record.id,
    attempt,
    head: SHA3,
    purpose,
    createdAt: at,
    outcome,
    settledAt: at + 1,
    proofRef: outcome === "confirmed_not_submitted"
      ? `artifact:refund/${record.id}-${attempt}`
      : null,
  });
}

Deno.test("round cap policy: the one-time legacy class is a rule over the cutoff and fails closed", () => {
  // 645 as live (sequence 39670): six rounds admitted by R79 before CI, all
  // before the CI-first runtime's activation.
  const record = legacy(645, 6);
  const old = reviewCharges(record.id, 6, { repository: AI });
  // Without a cutoff nothing is legacy.
  for (const cutoff of [null, undefined, 0, -1, 1.5]) {
    assert.equal(legacyReviewRoundPin(ledger(old), record, cutoff), null);
    assert.equal(reviewRoundsLeft(ledger(old), record, cutoff), 0);
    assert.equal(reviewRoundAvailable(ledger(old), record, cutoff), false);
  }
  // Under the cutoff it is pinned at its six old rounds; the final round is
  // open (its CI fix is admissible) but not armed (no review yet).
  assert.equal(legacyReviewRoundPin(ledger(old), record, CUT), 6);
  assert.equal(legacyFinalRoundOpen(ledger(old), record, CUT), true);
  assert.equal(legacyFinalRoundArmed(ledger(old), record, CUT), false);
  assert.equal(reviewRoundsLeft(ledger(old), record, CUT), 0);
  // A pre-era record keeps the 2026-10-16 ceiling.
  assert.equal(
    reviewRoundCeiling(ledger(old), record, CUT),
    LEGACY_REVIEW_ROUND_CEILING,
  );
  assert.equal(reviewRoundAvailable(ledger(old), record, CUT), true);
  // An old retry (R79's own correction, before the cutoff) arms nothing; a
  // refunded fix after it neither.
  const oldFix = charge(record, 2, "retry", CUT - 1);
  const refunded = charge(
    record,
    3,
    "retry",
    CUT + 1,
    "confirmed_not_submitted",
  );
  assert.equal(
    reviewRoundsLeft(ledger([...old, oldFix, refunded]), record, CUT),
    0,
  );
  // A CI fix charged at or after the cutoff arms exactly one final round.
  const fix = charge(record, 4, "retry", CUT);
  assert.equal(legacyFinalRoundArmed(ledger([...old, fix]), record, CUT), true);
  assert.equal(reviewRoundsLeft(ledger([...old, fix]), record, CUT), 1);
  assert.equal(reviewRoundCeiling(ledger([...old, fix]), record, CUT), 7);
  // The final review spends it: nothing more, ever.
  const final = charge(record, 7, "review_request", CUT + 5);
  const done = ledger([...old, fix, final]);
  assert.equal(legacyReviewRoundPin(done, legacy(645, 7), CUT), 6);
  assert.equal(legacyFinalRoundOpen(done, legacy(645, 7), CUT), false);
  assert.equal(reviewRoundsLeft(done, legacy(645, 7), CUT), 0);
  assert.equal(reviewRoundAvailable(done, legacy(645, 7), CUT), false);
  // The ordinary ceiling is spent whatever the legacy allowance.
  assert.equal(ordinaryReviewRoundsSpent(ledger(old), record), true);
});

Deno.test("round cap policy: a record new under the CI-first runtime never gets a fourth round", () => {
  // Three rounds all admitted after the activation, a red head, even a CI
  // fix after its third review: never legacy, never a round left.
  const fresh = legacy(1200, 3);
  const after = [1, 2, 3].map((attempt) =>
    charge(fresh, attempt, "review_request", CUT + attempt)
  );
  const fix = charge(fresh, 2, "retry", CUT + 10);
  for (const rows of [after, [...after, fix]]) {
    assert.equal(legacyReviewRoundPin(ledger(rows), fresh, CUT), null);
    assert.equal(legacyFinalRoundOpen(ledger(rows), fresh, CUT), false);
    assert.equal(reviewRoundsLeft(ledger(rows), fresh, CUT), 0);
    assert.equal(reviewRoundAvailable(ledger(rows), fresh, CUT), false);
  }
  // A counter that claims old rounds without any admission before the
  // cutoff is no evidence of the old order.
  assert.equal(legacyReviewRoundPin(ledger([]), legacy(1201, 9), CUT), null);
  assert.equal(
    legacyReviewRoundPin(ledger(after), legacy(1200, 9), CUT),
    null,
  );
  // Fewer than three old rounds (live 661: two before, one after) is not
  // the class: the ordinary ceiling of three holds.
  const mixed = legacy(661, 3);
  const rows = [
    ...reviewCharges(mixed.id, 2, { repository: AI }),
    charge(mixed, 3, "review_request", CUT + 1),
  ];
  assert.equal(legacyReviewRoundPin(ledger(rows), mixed, CUT), null);
  assert.equal(reviewRoundsLeft(ledger(rows), mixed, CUT), 0);
  // A round the old runtime admitted after the cutoff (between the pin
  // commit and the install) spends the final round: fails closed.
  const late = legacy(646, 7);
  const lateRows = [
    ...reviewCharges(late.id, 6, { repository: AI }),
    charge(late, 7, "review_request", CUT + 1),
    charge(late, 3, "retry", CUT + 2),
  ];
  assert.equal(legacyReviewRoundPin(ledger(lateRows), late, CUT), 6);
  assert.equal(legacyFinalRoundOpen(ledger(lateRows), late, CUT), false);
  assert.equal(reviewRoundsLeft(ledger(lateRows), late, CUT), 0);
  // Only exact ai.ubq.fi issue identities are legacy.
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
    const rows = reviewCharges(record.id, 4, {
      repository: record.repository,
    });
    assert.equal(legacyReviewRoundPin(ledger(rows), record, CUT), null);
    assert.equal(reviewRoundAvailable(ledger(rows), record, CUT), false);
  }
});

Deno.test("round cap policy: the owner's class shape is CI-red parks with three spent rounds", () => {
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
  for (const [issue, rounds] of [[595, 4], [618, 7], [1128, 5]]) {
    assert.equal(
      legacyReviewRoundClassPin(ledger([]), parked(issue, rounds)),
      rounds,
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
  // Not the shape: rounds left, a non-CI blocker, a record not parked,
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

Deno.test("round cap policy: the class drift names every class-shaped record the rule leaves without its final round", () => {
  const blocked = (issue: number, rounds: number, message: string) =>
    legacy(issue, rounds, {
      nextStep: "blocked",
      blocker: { kind: "other", message, since: T0 },
    });
  const red = "CI checks failed: verify-artifact(skipped), validate(failure)";
  const covered = blocked(595, 4, red);
  const coveredRows = reviewCharges(covered.id, 4, { repository: AI });
  // A round admitted after the cutoff (the old runtime, before the install).
  const past = blocked(597, 6, red);
  const pastRows = [
    ...reviewCharges(past.id, 5, { repository: AI }),
    charge(past, 6, "review_request", CUT + 1),
  ];
  // Every round after the cutoff: a record new under the CI-first runtime.
  const fresh = blocked(1500, 3, red);
  const freshRows = [1, 2, 3].map((attempt) =>
    charge(fresh, attempt, "review_request", CUT + attempt)
  );
  const unrelated = [
    blocked(1501, 2, red), // rounds left: not the class shape
    blocked(1502, 4, "task acceptance not fulfilled: the candidate"),
    legacy(1503, 4), // not parked
  ];
  const snapshot = {
    work: [covered, past, fresh, ...unrelated],
    reservations: [...coveredRows, ...pastRows, ...freshRows],
  };
  assert.deepEqual(legacyReviewRoundClassDrift(snapshot, CUT), [
    { id: past.id, issue: 597, kind: "pin_mismatch", pin: 5, spent: 6 },
    { id: fresh.id, issue: 1500, kind: "unpinned", pin: null, spent: 3 },
  ]);
  // No cutoff (no CI-first runtime installed): nothing is reported here.
  assert.deepEqual(legacyReviewRoundClassDrift(snapshot, null), []);
});

Deno.test("round cap policy: the latest completed review of the current head picks the park", () => {
  const record = task(3);
  const choose = (reviews: ReturnType<typeof completedReceipt>[]) =>
    ceilingParkMessage({ reviews }, record);
  assert.equal(choose([]), CAP_UNREVIEWED);
  assert.equal(choose([rejectedReceipt(3, SHA3)]), CAP_REJECTED);
  assert.equal(
    choose([completedReceipt(3, SHA3, "unaccepted")]),
    CAP_UNACCEPTED,
  );
  assert.equal(choose([completedReceipt(3, SHA3, "clean")]), CAP_REVIEWED);
  // Owner directive 2026-10-24: only an unresolved P0 rejects. The same review
  // with an unresolved P1 is clean: without a task acceptance it parks
  // UNACCEPTED, with one it parks REVIEWED (deliverable), never REJECTED.
  const p1Only = completedReceipt(3, SHA3, "p1");
  assert.deepEqual(p1Only.unresolvedSeverities, ["P1"]);
  assert.equal(choose([p1Only]), CAP_UNACCEPTED);
  assert.equal(
    choose([{
      ...p1Only,
      taskAcceptance: completedReceipt(3, SHA3, "clean").taskAcceptance,
    }]),
    CAP_REVIEWED,
  );
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
      rejectedReceipt(2, SHA3, { completedAt: T0 - 5000 }),
      completedReceipt(3, SHA3, "clean", { completedAt: T0 }),
    ]),
    CAP_REVIEWED,
  );
  assert.equal(
    choose([
      completedReceipt(2, SHA3, "clean", { completedAt: T0 - 5000 }),
      rejectedReceipt(3, SHA3, { completedAt: T0 }),
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

Deno.test("round cap policy: the fixed blockers and every carried-delivery park are ceiling parks", () => {
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
  // The carried-delivery parks carry their evidence after the fixed prefix:
  // ceiling parks all the same (none of them deliverable).
  assert.equal(
    isReviewRoundCeilingPark(blocked("other", `${CAP_PREFIX}anything`)),
    true,
  );
  assert.equal(
    isDeliverableReviewRoundCeilingPark(
      blocked("other", `${CAP_PREFIX}anything`),
    ),
    false,
  );
  assert.equal(
    isReviewRoundCeilingPark(blocked("other", `x ${CAP_PREFIX}anything`)),
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
      "src/repair/delivery-queue.ts",
      "src/repair/loop-delivery-queue.ts",
      "src/repair/loop-base-refresh.ts",
      "src/repair/loop-review-request.ts",
      "src/repair/loop-review-result.ts",
      "src/repair/loop-work.ts",
      "src/repair/loop-merge.ts",
      "src/repair/loop-eligibility.ts",
      "src/repair/loop-state.ts",
      "ops/hosted-autonomy-retries.ts",
      "ops/hosted-autonomy-retry-pass.ts",
      "ops/hosted-autonomy-policy.ts",
      "ops/hosted-autonomy-refresh-rearm.ts",
      "ops/hosted-autonomy-base-refresh-retries.ts",
    ]
  ) assert.ok(protectedPaths.includes(path), path);
});

Deno.test("round cap policy: a CI-first-era record may spend five rounds (owner decision 2026-10-24)", () => {
  const era = LEGACY_REVIEW_CUTOFF.activatedNotBefore!;
  const record = {
    ...legacy(1249, 3),
    createdAt: era + 60_000,
  };
  const charges = reviewCharges(record.id, 3, { repository: AI }).map(
    (charge, index) => ({ ...charge, createdAt: era + 120_000 + index }),
  );
  assert.equal(reviewRoundCeilingFor(ledger(charges), record), 5);
  assert.equal(reviewRoundsLeft(ledger(charges), record, null), 2);
  // One review admitted before the era keeps the old ceiling.
  const mixed = [{ ...charges[0], createdAt: era - 1 }, ...charges.slice(1)];
  assert.equal(reviewRoundCeilingFor(ledger(mixed), record), 3);
  assert.equal(reviewRoundsLeft(ledger(mixed), record, null), 0);
  // An unknown creation time keeps the old ceiling.
  const { createdAt: _unknown, ...unknown } = record;
  assert.equal(reviewRoundCeilingFor(ledger(charges), unknown), 3);
});
