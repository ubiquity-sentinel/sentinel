/**
 * Generation 80 integration of the CI-first pipeline with the hard
 * review-round ceiling (owner decisions 2026-10-16: three review rounds,
 * hard; CI first, then review; CI fixes never count as review rounds; the
 * listed legacy ai.ubq.fi records get their CI fixes and then exactly ONE
 * final current-head review on the green head).
 *
 * - one legacy table and one round count: the CI fix admission and the
 *   ceiling read `LEGACY_REVIEW_ROUND_PINS` through `reviewRoundsLeft` over
 *   the durable ledger, so a lagging counter never buys a fix the ceiling
 *   would then refuse to review;
 * - a CI fix is a `retry` charge in `counters.retries`, never a review round;
 * - a listed legacy record whose CI-fixed head conflicts on its refresh keeps
 *   its one final review for the resolved merge (live 597 and 668 conflict);
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
  LEGACY_REVIEW_ROUND_PINS,
  MAX_REVIEW_ROUNDS,
  reviewRoundsLeft,
} from "../../src/repair/review-round-cap.ts";
import { reservation, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
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
function ciFixCharges(record: WorkRecordV1, count: number) {
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
        settledAt: T0 + 100 + index,
      }),
  );
}

Deno.test("CI first x round cap: one legacy table and one ledger count decide the legacy CI fix", () => {
  assert.equal(CI_FIRST_REVIEW_ROUNDS, MAX_REVIEW_ROUNDS);
  assert.equal(LEGACY_REVIEW_ROUND_PINS.size, 21);
  for (const [issue, pin] of LEGACY_REVIEW_ROUND_PINS) {
    const record = aiRecord(issue, pin);
    const atPin = { reservations: reviewCharges(record, pin) };
    assert.equal(reviewRoundsLeft(atPin, record), 1, `${issue} at its pin`);
    assert.equal(reviewRoundAvailable(atPin, record), true);
    assert.equal(ciCorrectable(record, atPin), true, `${issue} may be fixed`);
    // A counter lagging the ledger never buys a fix the ceiling would then
    // refuse to review: one charge past the pin spends the final round.
    const past = { reservations: reviewCharges(record, pin + 1) };
    assert.equal(reviewRoundsLeft(past, record), 0, `${issue} past its pin`);
    assert.equal(ciCorrectable(record, past), false, `${issue} spent`);
    // A lowered counter still counts the ledger's rounds: one final review.
    const lowered = aiRecord(issue, 0);
    assert.equal(reviewRoundsLeft(atPin, lowered), 1);
    assert.equal(ciCorrectable(lowered, atPin), true);
  }
  const unlisted = aiRecord(596, 6);
  assert.equal(
    ciCorrectable(unlisted, { reservations: reviewCharges(unlisted, 6) }),
    false,
    "596 is not listed",
  );
});

Deno.test("CI first x round cap: CI fixes are retry charges and never spend a review round", () => {
  const record = aiRecord(583, 2);
  for (let fixes = 0; fixes <= CI_FIX_ATTEMPTS; fixes++) {
    const fixed = aiRecord(583, 2, {
      counters: { attempts: 3 + fixes, retries: fixes, reviewRounds: 2 },
    });
    const ledger = {
      reservations: [
        ...reviewCharges(record, 2),
        ...ciFixCharges(record, fixes),
      ],
    };
    assert.equal(reviewRoundsLeft(ledger, fixed), 1, `${fixes} fixes`);
    assert.equal(
      ciCorrectable(fixed, ledger),
      fixes < CI_FIX_ATTEMPTS,
      `${fixes} of ${CI_FIX_ATTEMPTS} fixes spent`,
    );
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

function snapshotOf(
  record: WorkRecordV1,
  reviewRounds: number,
): RepairStateSnapshotV1 {
  return seededSnapshot([record], {
    reservations: reviewCharges(record, reviewRounds),
  });
}

Deno.test("CI first x round cap: a legacy CI-fixed head that conflicts on refresh keeps its one final review", () => {
  // 597 (pin 5) and 668 (pin 4) are mergeable=false live: their refreshed,
  // CI-fixed head conflicts, and the resolved merge needs the final round.
  for (const [issue, pin] of [[597, 5], [668, 4]] as const) {
    const pending = conflicted(issue, pin);
    const snapshot = snapshotOf(pending, pin);
    assert.equal(conflictResolutionShape(pending, snapshot), true, `${issue}`);
    assert.equal(
      conflictResolutionAdmissible(true, snapshot, pending),
      TIP,
      `${issue} resolution admissible`,
    );
    const spent = snapshotOf(pending, pin + 1);
    assert.equal(conflictResolutionShape(pending, spent), false, "final spent");
  }
  // An unlisted record at the ordinary ceiling gets no resolution.
  const ordinary = conflicted(583, MAX_REVIEW_ROUNDS);
  assert.equal(
    conflictResolutionShape(ordinary, snapshotOf(ordinary, MAX_REVIEW_ROUNDS)),
    false,
  );
  const below = conflicted(583, 2);
  assert.equal(conflictResolutionShape(below, snapshotOf(below, 2)), true);
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
      // This tree admits it (one cell, then the final review).
      assert.equal(isModelStartAction(snapshot, pending, true, true), true);
      assert.equal(
        isMatrixImplementationReadyV1(
          pending,
          snapshot,
          config,
          T0 + 8000,
          true,
          true,
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
    ]
  ) assert.ok(protectedPaths.includes(path), path);
});
