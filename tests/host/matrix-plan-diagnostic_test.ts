/**
 * The zero-cell plan diagnostic no longer treats a spent review-round count
 * as a refusal (owner directive 2026-10-30): the count is accounting and the
 * record stays eligible for its next implementation start.
 */
import assert from "node:assert/strict";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { planNotReadyKey } from "../../src/host/matrix-plan-diagnostic.ts";
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
