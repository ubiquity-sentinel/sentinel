/**
 * The zero-cell plan diagnostic no longer treats a spent review-round count
 * as a refusal (owner directive 2026-10-30): the count is accounting and the
 * record stays eligible for its next implementation start.
 */
import assert from "node:assert/strict";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import {
  matrixPlanDiagnosticLineOf,
  planDeferredKey,
  planNotReadyKey,
  scanPlanDiagnostic,
} from "../../src/host/matrix-plan-diagnostic.ts";
import { explainMatrixNotReady } from "../../src/host/matrix-planner.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop.ts";
import { reviewRoundCeilingFor } from "../../src/repair/review-round-cap.ts";
import { MaxItems } from "../../src/contracts/validation.ts";
import { T0, workRecord } from "../state/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";

/** The fixture's own ceiling (its records predate the CI-first era: three). */
const CEILING = reviewRoundCeilingFor({ reservations: [] }, record(0));

const CONFIG = {
  sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
} as unknown as RepositoryConfigV1;

function record(reviewRounds: number) {
  return workRecord("issue-159", {
    target: {
      base: "a".repeat(40),
      branch: "sentinel/repair/issue-159",
      checkpoint: null,
      head: null,
      pr: null,
    },
    counters: { attempts: 1, retries: 0, reviewRounds },
  });
}

Deno.test("plan diagnostic: a spent count does not refuse a record at work", () => {
  const spent = record(CEILING);
  const snapshot = seededSnapshot([spent]);
  assert.equal(
    isMatrixImplementationReadyV1(
      spent,
      snapshot,
      CONFIG,
      T0,
      true,
      false,
      false,
      null,
    ),
    true,
    "the spent count is accounting only",
  );
  assert.equal(
    explainMatrixNotReady(spent, CONFIG, snapshot, true, null),
    null,
  );
});

Deno.test("plan diagnostic: a record with a round left is still explained as ready", () => {
  const fresh = record(CEILING - 1);
  const snapshot = seededSnapshot([fresh]);
  assert.equal(
    isMatrixImplementationReadyV1(
      fresh,
      snapshot,
      CONFIG,
      T0,
      true,
      false,
      false,
      null,
    ),
    true,
  );
  assert.equal(
    explainMatrixNotReady(fresh, CONFIG, snapshot, true, null),
    null,
  );
});

Deno.test("plan diagnostic: a live continuation refusal keeps its own key", () => {
  const head = "b".repeat(40);
  const continuation = workRecord("issue-continuation", {
    source: { kind: "issue", id: "1", revision: "a".repeat(40) },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: "a".repeat(40),
      branch: "sentinel/repair/issue-continuation",
      checkpoint: null,
      head,
      pr: 901,
      candidateState: { preserved: null, publishedHead: head },
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
  });
  const snapshot = seededSnapshot([continuation]);
  assert.equal(
    explainMatrixNotReady(continuation, CONFIG, snapshot, true, null),
    "existing_head_continuation_live",
  );
  assert.equal(
    planNotReadyKey("existing_head_continuation_live"),
    "existing_head_continuation_live",
    "the new reason is registered, not collapsed to other",
  );
});

Deno.test("plan diagnostic: a no-test-evidence target keeps its own closed reason", () => {
  const noEvidence = record(0);
  const config = {
    ...CONFIG,
    commands: { test: "no_ci_and_no_local_verify" },
  } as unknown as RepositoryConfigV1;
  assert.equal(
    explainMatrixNotReady(
      noEvidence,
      config,
      seededSnapshot([noEvidence]),
      true,
      null,
    ),
    "no_ci_and_no_local_verify",
  );
  assert.equal(
    planNotReadyKey("no_ci_and_no_local_verify"),
    "no_ci_and_no_local_verify",
    "the planner's own park reason is registered, not collapsed to other",
  );
});

Deno.test("plan diagnostic: attempted/deferred counts carry a closed outcome histogram", () => {
  assert.equal(
    planDeferredKey({ kind: "deferred", detail: "ledger capacity" }),
    "admission_capacity",
  );
  assert.equal(
    planDeferredKey({ kind: "deferred", detail: "synthetic secret xyz" }),
    "deferred",
    "raw details never leak into the closed key",
  );
  const line = matrixPlanDiagnosticLineOf({
    waveId: "w-counts",
    prepared: 0,
    cause: "planner",
    attempted: 4,
    deferred: 4,
    deferredByReason: {
      admission_capacity: 3,
      "invented reason": 1,
    },
    diagnostic: {
      totalRecords: 4,
      skippedByReason: {},
      notReadyByReason: {},
      notReadySamples: {},
    },
  });
  assert.equal(line.attempted, 4);
  assert.equal(line.deferred, 4);
  assert.deepEqual(line.deferredByReason, {
    admission_capacity: 3,
    other: 1,
  });
});

Deno.test("plan diagnostic: a large deferred wave keeps its counts and histogram", () => {
  const count = MaxItems.snapshotRecords;
  const line = matrixPlanDiagnosticLineOf({
    waveId: "w-large",
    prepared: 0,
    cause: "planner",
    attempted: count,
    deferred: count,
    deferredByReason: { admission_capacity: count },
    diagnostic: {
      totalRecords: count,
      skippedByReason: {},
      notReadyByReason: {},
      notReadySamples: {},
    },
  });
  const scanned = scanPlanDiagnostic(JSON.stringify(line), {
    id: "w-large",
  });
  assert.ok(scanned, "a full-record wave is not truncated to null");
  assert.equal(scanned.attempted, count);
  assert.equal(scanned.deferred, count);
  assert.deepEqual(scanned.deferredByReason, { admission_capacity: count });
});

Deno.test("plan diagnostic: a ledger-capacity wait keeps its admission_capacity key", () => {
  assert.equal(
    planDeferredKey({ kind: "progress" }, "ledger_capacity"),
    "admission_capacity",
  );
});

Deno.test("plan diagnostic: an expired ledger-capacity wait does not override the current outcome", () => {
  for (
    const [outcome, expected] of [
      [{
        kind: "deferred",
        detail: "implementation start is past the model cutoff",
      }, "bounds"],
      [{
        kind: "deferred",
        detail: "implementation cannot fit its immutable dispatch artifact",
      }, "artifact"],
      [{ kind: "deferred", detail: "GitHub cooldown" }, "cooldown"],
      [{
        kind: "deferred",
        detail: "implementation admission state is unavailable",
      }, "admission"],
      [{ kind: "deferred", detail: "ledger capacity" }, "admission_capacity"],
      [{ kind: "deferred", detail: "synthetic secret xyz" }, "deferred"],
      [{ kind: "blocked" }, "blocked"],
      [{ kind: "state_error" }, "state_error"],
      [{ kind: "unknown" }, "other"],
    ] as const
  ) {
    assert.equal(planDeferredKey(outcome, "ledger_capacity"), expected);
  }
});
