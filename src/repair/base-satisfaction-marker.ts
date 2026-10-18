/** R80-compatible hold for the trusted no-change disposition; never selectable by R80. */
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
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
    /^repeated identical failure; owner action required \(close or edit the issue, or change the model route\): [0-9]{1,9}x [a-z_]{1,32}\|[0-9a-f]{16} issue=(?:[0-9a-f]{12}|none) route=[0-9a-f]{12}: /;
  return record.blocker?.kind === "other" &&
    record.blocker.message.replace(prefix, "") === ATTEMPT_DETAIL_NO_CHANGE;
}

export function holdNoChange(record: WorkRecordV1, now: number): WorkRecordV1 {
  if (record.intent?.kind !== "implementation") {
    throw new Error("missing no-change admission");
  }
  return {
    ...record,
    nextStep: "work",
    blocker: null,
    wait: { reason: "backoff", since: now, until: null },
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
      (record.nextStep === "work" && record.wait?.reason === "backoff" &&
        record.wait.until === null && intent.failure?.kind === "base_review" &&
        intent.failure.detail === ATTEMPT_DETAIL_NO_CHANGE))
  ) origin = intent.requestId;
  if (
    intent?.kind === "issue_closure" && record.nextStep === "work" &&
    record.wait?.reason === "backoff" && record.wait.until === null &&
    /^base-review:[0-9a-f]{64}:[0-9a-f]{64}$/.test(intent.key)
  ) origin = intent.key.split(":")[1];
  if (origin === null) return null;
  const charge = snapshot.reservations.find((row) => row.id === origin);
  return charge && charge.taskId === record.id &&
      charge.repository.owner === record.repository.owner &&
      charge.repository.name === record.repository.name &&
      charge.repository.installationId === record.repository.installationId &&
      (charge.purpose === "implementation" || charge.purpose === "retry") &&
      (charge.outcome === "submitted" || charge.outcome === "ambiguous")
    ? origin
    : null;
}
