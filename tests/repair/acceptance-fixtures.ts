/**
 * Shared JAM B6 fixtures: one issue task whose standing review of its exact
 * published head is a completed `not_fulfilled` verdict bound to the live
 * task text, with the record's counted review rounds also charged in the
 * durable ledger, as the live records are.
 */
import assert from "node:assert/strict";
import type { ReviewTaskAcceptanceV1 } from "../../src/contracts/review-receipt.ts";
import { reviewOperationKey } from "../../src/repair/keys.ts";
import { reservation, SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  acceptedObservation,
  FAKE_ISSUE_TASK_DIGEST,
  reviewWaitIssueRecord,
} from "./loop-review-fixtures.ts";
import { makeRig, seededSnapshot } from "./loop-rig.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

/** Live-shaped statement (ai.ubq.fi 1127's reviewer evidence, PR 1145). */
export const NOT_FULFILLED: ReviewTaskAcceptanceV1 = {
  issueNumber: 1,
  taskDigest: FAKE_ISSUE_TASK_DIGEST,
  verdict: "not_fulfilled",
  evidence: [
    "The pending debounced defaults save is not invalidated by the target-change handler, so the candidate can still queue a POST for the newly selected gateway.",
    'The candidate leaves static/style.css without an expired-row accent rule while static/admin.js assigns data-state="expired".',
  ],
};

/**
 * The record at `review` on PR 7 / head SHA2 after `rounds` counted rounds,
 * its standing observation the completed not-fulfilled verdict. `hosted`
 * runs the cycle as a matrix run does (the correction is a planner cell).
 */
export async function acceptanceRig(
  prefix: string,
  rounds: number,
  hosted = false,
) {
  const rig = await makeRig(prefix, {
    summaries: false,
    github: {
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { "refs/heads/sentinel/repair/issue-1": SHA2 },
        pullRequests: [exactOpenPr(7, SHA2, "sentinel/repair/issue-1")],
      },
    },
    ...(hosted ? { externalImplementations: true } : {}),
  });
  const record = workRecord("issue-1", {
    ...reviewWaitIssueRecord(SHA2),
    counters: { attempts: 1, retries: 0, reviewRounds: rounds },
  });
  const charges = Array.from(
    { length: rounds },
    (_, index) =>
      reservation(`acceptance-review-${index + 1}`, {
        taskId: record.id,
        head: SHA2,
        attempt: index + 1,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 1000,
      }),
  );
  const written = await rig.store.writeRepair(
    seededSnapshot([record], { reservations: charges }),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  rig.clock.advance(3600_000 + 1);
  const operationKey = reviewOperationKey(7, SHA2, rounds);
  rig.github.reviewObservationsByKey.set(
    operationKey,
    acceptedObservation(SHA2, NOT_FULFILLED, rig.clock.now() + 1000),
  );
  return Object.assign(rig, { charges, operationKey });
}
