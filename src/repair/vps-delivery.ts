/** Exact gateway delivery binding shared by the repair and maintenance consumers. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { StateReadView } from "../contracts/ports.ts";
import {
  parseReleaseRequestV1,
  type ReleaseRequestV1,
} from "../contracts/release.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  parseVpsReleaseRecordV1,
  vpsRecordBindsRequest,
  type VpsReleaseRecordV1,
} from "../contracts/vps-release.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { closureIntentKey, releaseRequestId } from "./keys.ts";
import {
  releaseRequestMatchesDelivery,
  sameRepositoryIdentity,
} from "./loop-records.ts";

export function isGatewayVpsRepository(
  repository: RepositoryIdentityV1,
): boolean {
  return repository.owner === "ubiquity" && repository.name === "ai.ubq.fi";
}

/** The durable source request must still name this exact task and review. */
export async function gatewayRequestBindsDelivery(
  request: ReleaseRequestV1,
  record: WorkRecordV1,
  review: ReviewReceiptV1 | null,
  revision: string = request.revision,
): Promise<boolean> {
  try {
    const parsed = parseReleaseRequestV1(request);
    return isGatewayVpsRepository(record.repository) &&
      record.repository.installationId > 0 &&
      (record.nextStep === "delivery" || record.nextStep === "review") &&
      releaseRequestMatchesDelivery(parsed, record) &&
      parsed.revision === revision &&
      parsed.id === await releaseRequestId(
          record.repository,
          parsed.revision,
          parsed.source.pullRequest,
        ) &&
      review !== null &&
      parsed.source.reviewReceiptId === review.id &&
      parsed.source.reviewRequestId === review.requestId &&
      sameRepositoryIdentity(review.repository, record.repository) &&
      review.pullRequest.number === record.target.pr &&
      review.pullRequest.head === record.target.head &&
      review.pullRequest.base === record.target.base &&
      review.outcome === "completed" && review.resultId !== null &&
      review.completedAt !== null && review.observedReviewer !== null &&
      review.observedReviewer === review.expectedReviewer &&
      review.findingsUncounted === 0 &&
      !review.unresolvedSeverities.some((severity) =>
        severity === "P0" || severity === "P1"
      ) &&
      (record.related.issueNumber === null ||
        review.taskAcceptance?.issueNumber === record.related.issueNumber);
  } catch {
    return false;
  }
}

/** A saved closure retry retains the original source/request tuple. */
export function gatewayClosureIntentBindsRequest(
  record: WorkRecordV1,
  request: ReleaseRequestV1,
): boolean {
  const intent = record.intent;
  return intent?.kind === "issue_closure" &&
    record.related.issueNumber !== null &&
    intent.key === closureIntentKey(record.related.issueNumber) &&
    intent.requestId === request.id &&
    intent.expectedHead === record.target.head &&
    intent.observedBase === record.target.base &&
    intent.pr === record.target.pr &&
    intent.branch === null && intent.resultId === null;
}

export type GatewayVpsAcceptanceV1 =
  | { kind: "wait" }
  | { kind: "blocked"; reason: string }
  | { kind: "accepted"; receipt: VpsReleaseRecordV1 };

/**
 * Only the release-role Git state is authority. Reparse its complete snapshot,
 * bind the original request and read the same committed terminal tuple back.
 * Strict r12 parsing preserves candidate/prior/driver/controller, health,
 * telemetry, inference and native settlement provenance; no caller boolean,
 * Deno/hosted receipt or newer descendant revision substitutes for that tuple.
 */
export async function observeGatewayVpsDelivery(
  state: Pick<StateReadView, "readRelease">,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
  review: ReviewReceiptV1 | null,
): Promise<GatewayVpsAcceptanceV1> {
  if (!await gatewayRequestBindsDelivery(request, record, review)) {
    return { kind: "wait" };
  }
  if (request.status === "cancelled" || request.status === "failed") {
    return {
      kind: "blocked",
      reason: request.failureReason ?? `release request ${request.status}`,
    };
  }
  try {
    const read = await state.readRelease();
    if (!read.ok || read.value.status !== "found") return { kind: "wait" };
    const snapshot = parseReleaseStateSnapshotV1(read.value.snapshot);
    const matching = (snapshot.vpsReleases ?? []).filter((item) =>
      item.request.id === request.id
    );
    if (matching.length !== 1) return { kind: "wait" };
    const receipt = parseVpsReleaseRecordV1(matching[0]);
    if (!await vpsRecordBindsRequest(receipt, request)) return { kind: "wait" };
    if (!["accepted", "failed", "rolled_back"].includes(receipt.phase)) {
      return { kind: "wait" };
    }
    const readback = await state.readRelease();
    if (
      !readback.ok || readback.value.status !== "found" ||
      readback.value.head !== read.value.head ||
      canonicalStringify(
          parseReleaseStateSnapshotV1(readback.value.snapshot),
        ) !==
        canonicalStringify(snapshot)
    ) return { kind: "wait" };
    if (receipt.phase !== "accepted") {
      return { kind: "blocked", reason: `release ${receipt.phase}` };
    }
    return { kind: "accepted", receipt };
  } catch {
    return { kind: "wait" };
  }
}
