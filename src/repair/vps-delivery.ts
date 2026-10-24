/** Exact gateway delivery binding shared by the repair and maintenance consumers. */
import { hasBlockingSeverity } from "../contracts/review-receipt.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { StateReadView } from "../contracts/ports.ts";
import {
  parseReleaseRequestV1,
  type ReleaseRequestV1,
} from "../contracts/release.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  parseReleaseStateSnapshotV1,
  type ReleaseStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import {
  parseVpsReleaseRecordV1,
  vpsRecordBindsRequest,
  type VpsReleaseRecordV1,
} from "../contracts/vps-release.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  type CarriedReleaseProverV1,
  carriedReleaseReceipt,
  proveCarriedRelease,
} from "./carried-release.ts";
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
      !hasBlockingSeverity(review.unresolvedSeverities) &&
      (record.related.issueNumber === null ||
        review.taskAcceptance?.issueNumber === record.related.issueNumber);
  } catch {
    return false;
  }
}

/**
 * The carried variant of `gatewayRequestBindsDelivery` (Sentinel #152). The
 * durable request of a carried merge names the completed, clean review of an
 * EARLIER head H0 (on B0) of the same pull request and gives the merged
 * refreshed head H1 on tip T as its source (`carriedReleaseReceipt`, by the
 * caller's fixed reviewer). It binds only while the caller's existing patch
 * proof, re-derived between H0/B0 and H1/T, holds (`proveCarriedRelease`); a
 * receipt of the record's own head never binds here, so the exact binder
 * keeps every other request.
 */
export async function carriedGatewayRequestBindsDelivery(
  request: ReleaseRequestV1,
  record: WorkRecordV1,
  review: ReviewReceiptV1 | null,
  carried: CarriedReleaseProverV1,
  revision: string = request.revision,
): Promise<boolean> {
  try {
    const parsed = parseReleaseRequestV1(request);
    return isGatewayVpsRepository(record.repository) &&
      record.repository.installationId > 0 &&
      (record.nextStep === "delivery" || record.nextStep === "review") &&
      parsed.revision === revision &&
      parsed.id === await releaseRequestId(
          record.repository,
          parsed.revision,
          parsed.source.pullRequest,
        ) &&
      carriedReleaseReceipt(parsed, record, review, carried.reviewer) &&
      await proveCarriedRelease(record, review, carried) === "holds";
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

/**
 * Release deferred (JAM B12): the merged delivery's production request is
 * open and the positively read release ref holds no VPS release record for
 * it. Only the release-role controller (`src/release/vps-controller.ts`)
 * writes that record, when it begins the request, so until then
 * `observeGatewayVpsDelivery` can only ever answer `wait` for the request:
 * while the release path is disabled nothing writes it at all. A cancelled
 * or failed request is never deferred: it carries its own terminal reason.
 */
export function gatewayReleaseDeferred(
  release: Pick<ReleaseStateSnapshotV1, "vpsReleases">,
  request: ReleaseRequestV1,
): boolean {
  return request.status === "open" &&
    !(release.vpsReleases ?? []).some((item) => item.request.id === request.id);
}

/**
 * The one stable runtime shape of a deferred release: a Gateway record at
 * `delivery` holding an open-ended `unavailable` wait. Selection skips it
 * (`isWaiting`), so it costs no step and no write; the runtime's once-per-run
 * resume pass (`resumeDeferredRelease`) releases it as soon as the release
 * ref records its request. No generation-80 path writes an open-ended
 * `unavailable` wait, and R80 parses and skips it.
 */
export function isReleaseDeferredWait(record: WorkRecordV1): boolean {
  return isGatewayVpsRepository(record.repository) &&
    record.nextStep === "delivery" &&
    record.wait?.reason === "unavailable" && record.wait.until === null;
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
 * With `carried` (Sentinel #152), a carried request binds through
 * `carriedGatewayRequestBindsDelivery` instead (its patch proof re-derived);
 * without it, and for every request the exact binder binds, nothing changes.
 */
export async function observeGatewayVpsDelivery(
  state: Pick<StateReadView, "readRelease">,
  record: WorkRecordV1,
  request: ReleaseRequestV1,
  review: ReviewReceiptV1 | null,
  carried?: CarriedReleaseProverV1,
): Promise<GatewayVpsAcceptanceV1> {
  if (
    !await gatewayRequestBindsDelivery(request, record, review) &&
    (carried === undefined ||
      !await carriedGatewayRequestBindsDelivery(
        request,
        record,
        review,
        carried,
      ))
  ) {
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
