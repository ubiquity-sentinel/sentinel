/**
 * Generation 80 integration of the CI-first pipeline with the hard
 * review-round ceiling (owner decisions 2026-10-16: three review rounds,
 * hard; CI first, then review; CI fixes never count as review rounds; the
 * legacy ai.ubq.fi records get their CI fixes and then exactly ONE final
 * current-head review on the green head).
 *
 * - one legacy rule and one round count: the CI fix admission and the
 *   ceiling read the legacy cutoff through `reviewRoundAvailable` and
 *   `reviewRoundsLeft` over the durable ledger, so a lagging counter never
 *   buys a fix the ceiling would then refuse to review;
 * - a CI fix is a `retry` charge in `counters.retries`, never a review round;
 *   charged after the cutoff it arms the legacy record's one final round;
 * - a legacy record whose CI-fixed head conflicts on its refresh keeps its
 *   one final review for the resolved merge (live 597 and 668 conflict);
 * - rollback: the pending resolution generation 80 writes for such a record
 *   parses under R79, and R79 neither grants a cell nor starts a model for it
 *   (its own shape refuses three or more rounds, so it runs the ordinary
 *   refresh, which blocks on the same conflict uncharged).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { ciCorrectable } from "../../src/repair/ci-rejection.ts";
import {
  CI_FIRST_REVIEW_ROUNDS,
  CI_FIX_ATTEMPTS,
  ciFixesLeft,
  reviewRoundAvailable,
} from "../../src/repair/ci-first-policy.ts";
import {
  conflictMarker,
  conflictResolutionAdmissible,
  conflictResolutionShape,
  pendingConflictRecord,
} from "../../src/repair/conflict-resolution.ts";
import { baseRefreshIntentKey } from "../../src/repair/keys.ts";
import {
  isMatrixImplementationReadyV1,
  isModelStartAction,
} from "../../src/repair/loop-eligibility.ts";
import {
  MAX_REVIEW_ROUNDS,
  reviewRoundsLeft,
} from "../../src/repair/review-round-cap.ts";
import {
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { assertGen79Parses, gen79Available } from "../state/gen77-contracts.ts";
import { loadGen79Modules } from "../host/gen77-runtime-source.ts";
import { repairConfigs } from "./helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";

const AIUBQ = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
const HEAD = "e667676f3b729c8a9199b1793474c2908e31543a" as GitSha;
const TIP = "b479053254d6114ecaf202be6ee5d24c144918f7" as GitSha;
const CI_RED = "CI checks failed: verify-artifact(skipped), validate(failure)";
/** The legacy cutoff: every seeded review admission (at T0) precedes it. */
const CUT = T0 + 1;

/** A published ai.ubq.fi issue record (legacy identity when listed). */
function aiRecord(
  issue: number,
  rounds: number,
  overrides: Partial<WorkRecordV1> = {},
): WorkRecordV1 {
  const id = `issue-ubiquity-ai.ubq.fi-${issue}`;
  return workRecord(id, {
    repository: AIUBQ,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    failingRevision: null,
    target: {
      base: SHA2,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: HEAD,
      pr: 1000 + issue,
      candidateState: {
        preserved: {
          base: SHA2,
          head: HEAD,
          operationKey: `impl:${"d".repeat(64)}`,
          ref: `refs/heads/sentinel-candidates/${"e".repeat(64)}`,
        },
        publishedHead: HEAD,
      },
    },
    nextStep: "blocked",
    blocker: { kind: "other", message: CI_RED, since: T0 + 5000 },
    counters: { attempts: 3, retries: 0, reviewRounds: rounds },
    ...overrides,
  });
}

/** `count` unrefunded review admissions of one task (attempts 1..count). */
function reviewCharges(record: WorkRecordV1, count: number) {
  return Array.from(
    { length: count },
    (_, index) =>
      reservation(`${record.id}-review-${index + 1}`, {
        repository: record.repository,
        taskId: record.id,
        head: HEAD,
        attempt: index + 1,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 10 + index,
      }),
  );
}

/** `count` CI fix charges (`retry` admissions) of one task. */
function ciFixCharges(record: WorkRecordV1, count: number, at = T0) {
  return Array.from(
    { length: count },
    (_, index) =>
      reservation(`${record.id}-ci-fix-${index + 1}`, {
        repository: record.repository,
        taskId: record.id,
        head: HEAD,
        attempt: 4 + index,
        purpose: "retry",
        outcome: "submitted",
        createdAt: at + index,
        settledAt: at + 100 + index,
      }),
  );
}

/** One review admission of `record` charged after the cutoff. */
function lateReview(record: WorkRecordV1, attempt: number) {
  return reservation(`${record.id}-review-late-${attempt}`, {
    repository: record.repository,
    taskId: record.id,
    head: HEAD,
    attempt,
    purpose: "review_request",
    outcome: "submitted",
    createdAt: CUT + 50,
    settledAt: CUT + 60,
  });
}

Deno.test("CI first x round cap: one legacy rule and one ledger count decide the legacy CI fix", () => {
  assert.equal(CI_FIRST_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS);
  // The owner's twelve and the in-flight records the table could never pin
  // (645, 657: in review on red heads at the install) alike.
  for (
    const [issue, pin] of [[595, 4], [597, 5], [618, 7], [645, 6], [657, 6]]
  ) {
    const record = aiRecord(issue, pin);
    const atPin = { reservations: reviewCharges(record, pin) };
    // Spent until a CI fix arms the final round; that fix is admissible.
    assert.equal(reviewRoundsLeft(atPin, record, CUT), 0, `${issue} unarmed`);
    assert.equal(reviewRoundAvailable(atPin, record, CUT), true);
    assert.equal(ciCorrectable(record, atPin, CUT), true, `${issue} fixable`);
    const armed = {
      reservations: [
        ...reviewCharges(record, pin),
        ...ciFixCharges(record, 1, CUT),
      ],
    };
    assert.equal(reviewRoundsLeft(armed, record, CUT), 1, `${issue} armed`);
    // A counter lagging the ledger never buys a fix the ceiling would then
    // refuse to review: a review charged after the cutoff spends the round.
    const past = {
      reservations: [
        ...reviewCharges(record, pin),
        lateReview(record, pin + 1),
      ],
    };
    assert.equal(reviewRoundsLeft(past, record, CUT), 0, `${issue} past pin`);
    assert.equal(ciCorrectable(record, past, CUT), false, `${issue} spent`);
    // A lowered counter still counts the ledger's rounds.
    const lowered = aiRecord(issue, 0);
    assert.equal(ciCorrectable(lowered, atPin, CUT), true);
    // No cutoff (no CI-first runtime): nothing is legacy.
    assert.equal(ciCorrectable(record, atPin, null), false);
  }
  // A record whose rounds all followed the cutoff is new: no legacy fix.
  const fresh = aiRecord(1596, 3);
  const after = {
    reservations: [1, 2, 3].map((attempt) => lateReview(fresh, attempt)),
  };
  assert.equal(ciCorrectable(fresh, after, CUT), false, "new under R80");
});

Deno.test("CI first x round cap: CI fixes are retry charges and never spend a review round", () => {
  const record = aiRecord(1583, 2);
  for (let fixes = 0; fixes <= CI_FIX_ATTEMPTS; fixes++) {
    const fixed = aiRecord(1583, 2, {
      counters: { attempts: 3 + fixes, retries: fixes, reviewRounds: 2 },
    });
    const ledger = {
      reservations: [
        ...reviewCharges(record, 2),
        ...ciFixCharges(record, fixes),
      ],
    };
    assert.equal(reviewRoundsLeft(ledger, fixed, CUT), 1, `${fixes} fixes`);
    assert.equal(
      ciCorrectable(fixed, ledger, CUT),
      fixes < CI_FIX_ATTEMPTS,
      `${fixes} of ${CI_FIX_ATTEMPTS} fixes spent`,
    );
  }
});

Deno.test("CI first x round cap: a row whose retries an older generation raised starts with those fixes spent (#155)", () => {
  // Live at state 719d8f30d: sentinel-61 carries retries 3, sentinel-76
  // retries 2 and sentinel-21 retries 1, none from a CI fix. The budget is
  // the lifetime counter (no post-activation ledger count: every later
  // implementation admission is a `retry` charge, CI fix or not).
  for (const [retries, left] of [[3, 0], [2, 1], [1, 2], [0, 3]] as const) {
    const record = aiRecord(1583, 2, {
      counters: { attempts: 3 + retries, retries, reviewRounds: 2 },
    });
    // No CI fix charged since the cutoff, whatever the counter says.
    const ledger = { reservations: reviewCharges(record, 2) };
    assert.equal(ciFixesLeft(record), left > 0, `retries ${retries}`);
    assert.equal(CI_FIX_ATTEMPTS - record.counters.retries, left);
    assert.equal(ciCorrectable(record, ledger, CUT), left > 0);
  }
});

/** A legacy CI-fixed head at work whose refresh onto `TIP` conflicted. */
function conflicted(issue: number, rounds: number): WorkRecordV1 {
  const record = aiRecord(issue, rounds, {
    nextStep: "work",
    blocker: null,
    counters: { attempts: 4, retries: 1, reviewRounds: rounds },
  });
  const pr = record.target.pr!;
  return pendingConflictRecord(
    record,
    {
      kind: "base_refresh",
      key: baseRefreshIntentKey(pr, HEAD, TIP),
      startedAt: T0 + 6000,
      branch: record.target.branch!,
      expectedHead: HEAD,
      observedBase: TIP,
      pr,
      requestId: null,
      resultId: null,
    },
    TIP,
    T0 + 7000,
  );
}

/**
 * `reviewRounds` old review admissions and one CI fix charged after the
 * cutoff (it armed the legacy final round); `final` adds that final review
 * admission, completed (a receipt of its head) or ended without a verdict.
 */
function snapshotOf(
  record: WorkRecordV1,
  reviewRounds: number,
  final: "completed" | "no_verdict" | null = null,
): RepairStateSnapshotV1 {
  return seededSnapshot([record], {
    reservations: [
      ...reviewCharges(record, reviewRounds),
      ...ciFixCharges(record, 1, CUT),
      ...(final === null ? [] : [lateReview(record, reviewRounds + 1)]),
    ],
    reviews: final === "completed"
      ? [reviewReceipt(`${record.id}-final`, {
        repository: record.repository,
        pullRequest: { number: record.target.pr!, head: HEAD, base: SHA2 },
        outcome: "completed",
        observedReviewer: "chatgpt-codex-connector[bot]",
        resultId: "final-result",
        completedAt: CUT + 70,
        submittedAt: CUT + 55,
        observedAt: CUT + 71,
      })]
      : [],
  });
}

Deno.test("CI first x round cap: a legacy CI-fixed head that conflicts on refresh keeps its one final review", () => {
  // 597 (pin 5) and 668 (pin 4) are mergeable=false live: their refreshed,
  // CI-fixed head conflicts, and the resolved merge needs the final round.
  for (const [issue, pin] of [[597, 5], [668, 4]] as const) {
    const pending = conflicted(issue, pin);
    const snapshot = snapshotOf(pending, pin);
    assert.equal(
      conflictResolutionShape(pending, snapshot, CUT),
      true,
      `${issue}`,
    );
    assert.equal(
      conflictResolutionAdmissible(true, snapshot, pending, CUT),
      TIP,
      `${issue} resolution admissible`,
    );
    const spent = snapshotOf(pending, pin, "completed");
    assert.equal(
      conflictResolutionShape(pending, spent, CUT),
      false,
      "final spent",
    );
    // A final admission that ended without a verdict spends the round too:
    // the one no-verdict re-request #155 item 2 proposed is not implemented.
    assert.equal(
      conflictResolutionShape(
        pending,
        snapshotOf(pending, pin, "no_verdict"),
        CUT,
      ),
      false,
      `${issue} no-verdict final spends the round`,
    );
    // Without a cutoff the record is no legacy record.
    assert.equal(conflictResolutionShape(pending, snapshot, null), false);
  }
  // A record new under the CI-first runtime at the ceiling gets none: its
  // rounds all followed the cutoff, so a CI fix arms nothing.
  const ordinary = conflicted(1583, MAX_REVIEW_ROUNDS);
  const fresh = seededSnapshot([ordinary], {
    reservations: [
      ...[1, 2, 3].map((attempt) => lateReview(ordinary, attempt)),
      ...ciFixCharges(ordinary, 1, CUT + 100),
    ],
  });
  assert.equal(conflictResolutionShape(ordinary, fresh, CUT), false);
  const below = conflicted(1583, 2);
  assert.equal(
    conflictResolutionShape(below, snapshotOf(below, 2), CUT),
    true,
  );
});

Deno.test({
  name:
    "CI first x round cap: R79 parses the legacy pending resolution and grants it no cell or model start",
  ignore: !(await gen79Available()),
  async fn() {
    const pending = conflicted(597, 5);
    const snapshot = snapshotOf(pending, 5);
    await assertGen79Parses(snapshot);
    const loaded = await loadGen79Modules([
      "src/repair/conflict-resolution.ts",
      "src/repair/loop-eligibility.ts",
    ]);
    try {
      const [conflict, eligibility] = loaded.modules as unknown as [
        { conflictResolutionAdmissible: typeof conflictResolutionAdmissible },
        {
          isMatrixImplementationReadyV1: typeof isMatrixImplementationReadyV1;
          isModelStartAction: typeof isModelStartAction;
        },
      ];
      const config = repairConfigs({
        repository: AIUBQ,
        sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
      })[0];
      // R79's own shape refuses three or more rounds: it never admits the
      // resolution, so its work step runs the ordinary refresh, which blocks
      // on the same deterministic conflict with nothing charged.
      assert.equal(
        conflict.conflictResolutionAdmissible(true, snapshot, pending),
        null,
      );
      assert.equal(
        eligibility.isModelStartAction(snapshot, pending, true, true),
        false,
      );
      assert.equal(
        eligibility.isMatrixImplementationReadyV1(
          pending,
          snapshot,
          config,
          T0 + 8000,
          true,
          true,
        ),
        false,
      );
      // This tree admits it under the cutoff (one cell, then the final
      // review), and never without one.
      assert.equal(
        isModelStartAction(snapshot, pending, true, true, false, CUT),
        true,
      );
      assert.equal(isModelStartAction(snapshot, pending, true, true), false);
      assert.equal(
        isMatrixImplementationReadyV1(
          pending,
          snapshot,
          config,
          T0 + 8000,
          true,
          true,
          false,
          CUT,
        ),
        true,
      );
      assert.deepEqual(pending.intent?.failure, conflictMarker(TIP, T0 + 7000));
    } finally {
      await loaded.dispose();
    }
  },
});

Deno.test("CI first x round cap: the CI-first and spent-delivery authority files are protected from model-authored candidates", () => {
  const protectedPaths = createLocalRepositoryConfig().protectedPaths;
  for (
    const path of [
      "src/repair/ci-first-policy.ts",
      "src/repair/loop-ci-first.ts",
      "ops/hosted-autonomy-ci-first.ts",
      "src/repair/review-round-cap.ts",
      "src/repair/loop-review-round-cap.ts",
      "ops/hosted-autonomy-spent-delivery.ts",
      "ops/hosted-autonomy-github-issues.ts",
      "ops/hosted-autonomy-follow-ups.ts",
      "ops/hosted-autonomy-follow-up-pass.ts",
      // The carried merge (option (b)): the launcher pass that makes it, its
      // exact Git tree proof and raw compare read, the runtime half and both
      // patch proofs' sources.
      "ops/hosted-autonomy-delivery-pass.ts",
      "ops/hosted-autonomy-github-trees.ts",
      "ops/hosted-autonomy-github-listing.ts",
      "ops/hosted-autonomy-github.ts",
      "src/repair/carried-review.ts",
      "src/repair/loop-carried-delivery.ts",
      "src/github/git-carried-patch.ts",
      "src/host/legacy-review-cutoff-env.ts",
    ]
  ) assert.ok(protectedPaths.includes(path), path);
});
