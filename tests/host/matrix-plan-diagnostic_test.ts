/**
 * Issue #159 item 2: the zero-cell plan diagnostic mirrors the readiness
 * predicate's review-round check, so a spent record at `work` is explained
 * as `review_rounds_spent` instead of being counted as ready.
 */
import assert from "node:assert/strict";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { explainMatrixNotReady } from "../../src/host/matrix-planner.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop.ts";
import { reviewRoundCeilingFor } from "../../src/repair/review-round-cap.ts";
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

Deno.test("plan diagnostic: a spent record at work names review_rounds_spent", () => {
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
    false,
    "the predicate refuses a record with no review round left",
  );
  assert.equal(
    explainMatrixNotReady(spent, CONFIG, snapshot, true, null),
    "review_rounds_spent",
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
