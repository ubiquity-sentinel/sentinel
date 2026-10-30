/** Repair loop internals: a pull request merged outside Sentinel's own path. */
import type { GitSha } from "../contracts/brands.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { GitHubPullRequestV1 } from "../contracts/ports.ts";
import type { EvidenceRefV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { settleReviewCharge } from "./loop-accounting.ts";
import { CHECK_POLL_MS } from "./loop-bounds.ts";
import { persistMergedDelivery } from "./loop-merge.ts";
import { sameRepositoryIdentity } from "./loop-records.ts";
import { loadSnapshot, persistWork } from "./loop-state.ts";
import { readDeliveryTaskContext } from "./loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { mergedOffTipMessage, observedMergeLanding } from "./merge-off-tip.ts";
import { latestCompletedReview } from "./review-round-cap.ts";
import { authorizingReceipt } from "./review-gate.ts";
import { clearIntent, markBlocked, setWait } from "./transitions.ts";

/**
 * Delivery provenance for a pull request merged outside Sentinel's own merge
 * path. The evidence kind and namespace reuse the verified queue-delivery
 * convention; `mergedBy` is the actor GitHub reported for the merge, raw when
 * it already fits the frozen restricted-ref grammar and hex-encoded otherwise.
 */
function humanMergeActorSegment(mergedBy: string | null): string {
  if (mergedBy === null || mergedBy.length === 0) return "unknown";
  if (/^[A-Za-z0-9._-]{1,64}$/.test(mergedBy)) return mergedBy;
  return `hex-${
    [...new TextEncoder().encode(mergedBy)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

export function humanMergeProvenanceRef(
  pullRequest: number,
  head: GitSha,
  mergeSha: GitSha,
  mergedBy: string | null,
): EvidenceRefV1 {
  return {
    kind: "review_receipt",
    ref:
      `artifact:review-receipt/human-merge-v1/${pullRequest}/${head}/${mergeSha}/${
        humanMergeActorSegment(mergedBy)
      }`,
  };
}

/**
 * Release-request review identity for a human merge with no exact authorizing
 * review receipt. It is deterministic and carries only the observed identity.
 */
export function humanMergeRequestId(
  pullRequest: number,
  head: GitSha,
  mergeSha: GitSha,
): string {
  return `human-merge:${pullRequest}:${head}:${mergeSha}`;
}

/**
 * The merge actor when the port observed it (string or `{ login }`). The
 * frozen pull contract currently omits `merged_by`, so a live read that does
 * not carry it records `unknown` rather than guessing from the PR author.
 */
function observedMergedBy(pull: GitHubPullRequestV1): string | null {
  const candidate = pull as GitHubPullRequestV1 & {
    mergedBy?: unknown;
    merged_by?: unknown;
  };
  const value = candidate.mergedBy ?? candidate.merged_by;
  if (typeof value === "string" && value.length > 0) return value;
  if (value === null || typeof value !== "object") return null;
  const login = (value as { login?: unknown }).login;
  return typeof login === "string" && login.length > 0 ? login : null;
}

/**
 * The one review admission still `reserved` for this record's next attempt:
 * named by a saved review intent, or found by its exact task/head/attempt when
 * the intent write was lost. A settled admission is never charged again.
 */
function reservedReviewAdmission(
  record: WorkRecordV1,
  reservations: readonly BudgetReservationV1[],
): BudgetReservationV1 | null {
  const intent = record.intent;
  if (intent !== null && intent.kind !== "review_request") return null;
  if (intent?.kind === "review_request" && intent.requestId !== null) {
    const named = reservations.find((row) => row.id === intent.requestId);
    return named !== undefined && named.outcome === "reserved" ? named : null;
  }
  if (intent !== null || record.target.head === null) return null;
  return reservations.find((row) =>
    row.purpose === "review_request" &&
    row.outcome === "reserved" &&
    row.taskId === record.id &&
    sameRepositoryIdentity(row.repository, record.repository) &&
    row.head === record.target.head &&
    row.attempt === record.counters.reviewRounds + 1
  ) ?? null;
}

/**
 * A pull request merged by a human (or any non-Sentinel actor) is a completed
 * delivery by whoever GitHub reports merged it. The exact outstanding review
 * admission is settled as ambiguous before anything moves; the observed merge
 * SHA and actor become durable evidence; the release request and source-issue
 * bookkeeping are the ordinary post-merge path. The source issue is verified
 * through the same read a trusted delivery uses; no closure or comment write is
 * invented when that path would not make one.
 */
export async function completeHumanMerge(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  pull: GitHubPullRequestV1,
  mergeSha: GitSha,
): Promise<StepResultV1> {
  const admission = reservedReviewAdmission(
    record,
    context.snapshot.reservations,
  );
  const namedAdmission = record.intent?.kind === "review_request"
    ? record.intent.requestId
    : null;
  if (
    namedAdmission !== null && admission === null &&
    !context.snapshot.reservations.some((row) => row.id === namedAdmission)
  ) {
    // A saved review intent names an admission the ledger does not carry: the
    // charge is unaccounted, so completing the record would lose it.
    return {
      kind: "state_error",
      detail: "review admission identity unavailable",
    };
  }
  if (admission !== null) {
    const settled = await settleReviewCharge(
      deps,
      context,
      admission.id,
      "ambiguous",
    );
    if (settled.kind !== "progress") return settled;
  }
  const fresh = admission === null
    ? context
    : await loadSnapshot(deps, context.bounds);
  if (fresh === null) {
    return {
      kind: "state_error",
      detail: "repair state unavailable after human merge settlement",
    };
  }
  const current = fresh.snapshot.work.find((row) => row.id === record.id);
  if (current === undefined) {
    return {
      kind: "state_error",
      detail: "work record vanished after human merge settlement",
    };
  }
  const pr = current.target.pr!;
  const head = current.target.head!;
  const landed = await observedMergeLanding(deps, current, head, mergeSha);
  if (landed === "unavailable") {
    const now = deps.clock.now();
    return persistWork(
      deps,
      fresh,
      setWait(
        current,
        { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }
  if (landed.outcome === "merged_off_tip") {
    const now = deps.clock.now();
    return persistWork(
      deps,
      fresh,
      markBlocked(
        clearIntent(current, now),
        "other",
        mergedOffTipMessage(landed, current.target.base),
        now,
      ),
    );
  }
  if (landed.outcome !== "merged") {
    return {
      kind: "deferred",
      detail: "human merge landing unavailable",
    };
  }
  const provenance = humanMergeProvenanceRef(
    pr,
    head,
    mergeSha,
    observedMergedBy(pull),
  );
  const withProvenance =
    current.evidence.some((item) =>
        item.kind === provenance.kind && item.ref === provenance.ref
      )
      ? current
      : { ...current, evidence: [...current.evidence, provenance] };
  const task = await readDeliveryTaskContext(deps, withProvenance);
  if (task === "unavailable") {
    // The same read-only source-issue verification a trusted delivery needs is
    // not available yet: retry after the existing cooldown instead of claiming
    // a delivery whose source task cannot be read.
    return {
      kind: "deferred",
      detail: "human merge source issue unavailable",
    };
  }
  const latest = latestCompletedReview(fresh.snapshot, withProvenance);
  const receipt = latest === null ? null : authorizingReceipt(
    [latest],
    withProvenance,
    deps.github.reviewerIdentity,
    task,
  );
  return await persistMergedDelivery(
    deps,
    fresh,
    withProvenance,
    landed,
    receipt,
    {
      outsideMerge: {
        requestId: receipt?.requestId ?? admission?.id ?? namedAdmission ??
          humanMergeRequestId(pr, head, mergeSha),
        complete: true,
      },
    },
  );
}
