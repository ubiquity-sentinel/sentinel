/**
 * Bounded hold for the trusted no-change disposition. The runtime's
 * pre-ranking base review (`loop-base-satisfaction.ts`) is its only exit: it
 * closes the issue, returns the task to implementation, or parks the record
 * once `BASE_REVIEW_HOLD_MS` passes without a completed review. Ranking never
 * steps a held record (`baseReviewHeld` in `isWaiting`).
 */
import {
  findReservationV1,
  type RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { ATTEMPT_DETAIL_NO_CHANGE } from "./attempt-policy.ts";
import { candidateBranch } from "./keys.ts";

export function noChangeIssue(record: WorkRecordV1): boolean {
  return record.source.kind === "issue" &&
    record.related.issueNumber !== null &&
    record.source.id === String(record.related.issueNumber) &&
    record.target.head === null && record.target.pr === null &&
    (record.target.branch === null ||
      record.target.branch === candidateBranch(record.id)) &&
    (record.target.candidateState === undefined ||
      (record.target.candidateState.preserved === null &&
        record.target.candidateState.publishedHead === null));
}

/** Exact historic launcher wrapper, never a generic unavailable/owner park. */
function exactNoChangeFailure(record: WorkRecordV1): boolean {
  if (record.blocker?.message === ATTEMPT_DETAIL_NO_CHANGE) return true;
  const prefix =
    /^repeated identical failure; owner action required \(close or edit the issue, or change the model route\): [0-9]{1,9}x [a-z_]{1,32}\|[0-9a-f]{16} issue=(?:[0-9a-f]{12}|none) route=[0-9a-f]{12}(?: prompt=[0-9a-f]{12})?: /;
  return record.blocker?.kind === "other" &&
    record.blocker.message.replace(prefix, "") === ATTEMPT_DETAIL_NO_CHANGE;
}

/**
 * Park of a completed base review that gave neither satisfied acceptance nor
 * "work needed". Until 2026-11-12 it also parked every work-needed review;
 * the launcher's one-time historical re-arm takes those back
 * (`ops/hosted-autonomy-historical-rearms.ts`).
 */
export const BASE_REVIEW_NOT_ESTABLISHED =
  "base review did not establish already-satisfied task acceptance";

/** How long a no-change record waits for its base review before parking. */
export const BASE_REVIEW_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * No-change implementation outcomes from which a base review that finds the
 * task still unsatisfied parks the record instead of returning it to
 * implementation: each return costs one more charged implementation and one
 * more charged base review, so the round trip is bounded.
 */
export const MAX_NO_CHANGE_BASE_REVIEWS = 3;

export function holdNoChange(record: WorkRecordV1, now: number): WorkRecordV1 {
  if (record.intent?.kind !== "implementation") {
    throw new Error("missing no-change admission");
  }
  return {
    ...record,
    nextStep: "work",
    blocker: null,
    wait: { reason: "backoff", since: now, until: now + BASE_REVIEW_HOLD_MS },
    intent: {
      ...record.intent,
      failure: {
        kind: "base_review",
        detail: ATTEMPT_DETAIL_NO_CHANGE,
        atMs: now,
        attempts: 1,
      },
    },
    updatedAt: now,
  };
}

/**
 * A hold written by `holdNoChange`: open-ended (written before the bound
 * existed) or at least `BASE_REVIEW_HOLD_MS` long. A shorter finite wait is
 * some other wait and never this hold.
 */
function noChangeHold(wait: WorkRecordV1["wait"]): boolean {
  return wait?.reason === "backoff" &&
    (wait.until === null || wait.until - wait.since >= BASE_REVIEW_HOLD_MS);
}

/** Held for (or during) the native base review; ranking never steps it. */
export function baseReviewHeld(record: WorkRecordV1): boolean {
  const intent = record.intent;
  return record.nextStep === "work" && record.wait?.reason === "backoff" &&
    ((intent?.kind === "implementation" &&
      intent.failure?.kind === "base_review" && noChangeHold(record.wait)) ||
      (intent?.kind === "issue_closure" &&
        intent.key.startsWith("base-review:")));
}

/** True once a hold's finite bound has passed (an open-ended hold never). */
export function baseReviewHoldExpired(
  record: WorkRecordV1,
  now: number,
): boolean {
  return record.wait !== null && record.wait.until !== null &&
    now >= record.wait.until;
}

/**
 * Durable no-change implementation outcomes of this task across every base
 * (attempt memory is not pruned and its counts never decrease); at least one
 * for a record that reached base review.
 */
export function noChangeOutcomes(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): number {
  let total = 0;
  for (const memory of snapshot.attemptMemory) {
    if (
      memory.taskId !== record.id || memory.purpose !== "implementation" ||
      memory.repository.owner !== record.repository.owner ||
      memory.repository.name !== record.repository.name ||
      memory.repository.installationId !== record.repository.installationId
    ) continue;
    for (const entry of memory.entries) {
      if (entry.detail === ATTEMPT_DETAIL_NO_CHANGE) total += entry.count;
    }
  }
  return Math.max(total, 1);
}

/** Original implementation admission, preserved even after review takes over. */
export function baseReviewOrigin(
  record: WorkRecordV1,
  snapshot: RepairStateSnapshotV1,
): string | null {
  if (!noChangeIssue(record) || record.nextStep === "done") return null;
  const intent = record.intent;
  let origin: string | null = null;
  if (
    intent?.kind === "implementation" && intent.requestId !== null &&
    intent.key === `impl:${intent.requestId}` &&
    ((record.nextStep === "blocked" && exactNoChangeFailure(record)) ||
      (record.nextStep === "work" && noChangeHold(record.wait) &&
        intent.failure?.kind === "base_review" &&
        intent.failure.detail === ATTEMPT_DETAIL_NO_CHANGE))
  ) origin = intent.requestId;
  if (
    intent?.kind === "issue_closure" && record.nextStep === "work" &&
    record.wait?.reason === "backoff" &&
    /^base-review:[0-9a-f]{64}:[0-9a-f]{64}$/.test(intent.key)
  ) origin = intent.key.split(":")[1];
  if (origin === null) return null;
  const charge = findReservationV1(snapshot, origin);
  return charge && charge.taskId === record.id &&
      charge.repository.owner === record.repository.owner &&
      charge.repository.name === record.repository.name &&
      charge.repository.installationId === record.repository.installationId &&
      (charge.purpose === "implementation" || charge.purpose === "retry") &&
      (charge.outcome === "submitted" || charge.outcome === "ambiguous")
    ? origin
    : null;
}
