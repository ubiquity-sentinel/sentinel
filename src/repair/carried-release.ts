/**
 * Carried release acceptance (Sentinel #152; owner decision 2026-10-16 (2),
 * the coordinator's option (b)). A carried merge is booked with a production
 * release request that names the completed, clean review of an EARLIER head
 * H0 (on B0) of the same pull request and gives the merged refreshed head H1
 * on tip T as its source. The exact binders (`gatewayRequestBindsDelivery`,
 * `deliveryTaskRefusal`) need the receipt to name the record's own head and
 * base, so such a delivery could never be accepted or closed.
 *
 * The carried variant accepts that request only after it re-derives the
 * patch proof between H0/B0 and H1/T through the caller's EXISTING proof (the
 * runtime's git proof, `proveCarriedPatch` and `carriedPatchHolds`; the
 * launcher's tree proof, `mergeBaseTreeChanges`), and authorizes the task as
 * of the reviewed identity (`reviewedIdentity`). A request whose patch no
 * longer proves is refused. Every other request keeps the exact binders,
 * unchanged.
 */
import {
  carriedPatchHolds,
  type CarriedPatchRequestV1,
} from "../contracts/ports.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { cleanReview, reviewedIdentity } from "./carried-review.ts";
import {
  releaseRequestMatchesDelivery,
  sameRepositoryIdentity,
} from "./loop-records.ts";
import {
  deliveryTaskRefusal,
  readDeliveryTaskContext,
} from "./loop-task-context.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";
import {
  authorizingReceipt,
  MERGE_WITHOUT_REVIEW_DETAIL,
  taskAcceptanceRefusal,
} from "./review-gate.ts";

/**
 * One re-derived carried patch proof: it holds, the patch changed (or the
 * refreshed head is not on its tip), or no proof could be read.
 */
export type CarriedPatchVerdictV1 = "holds" | "changed" | "unavailable";

/**
 * The caller's carried proof: the fixed reviewer the carried receipt must
 * name (observed and expected) and the existing patch proof, re-derived
 * between the reviewed identity and the merged one. It authorizes nothing by
 * itself.
 */
export interface CarriedReleaseProverV1 {
  readonly reviewer: string;
  prove(request: CarriedPatchRequestV1): Promise<CarriedPatchVerdictV1>;
}

/**
 * True exactly when `review` is the carried receipt `request` names for
 * `record`: the request is the record's own production delivery request (its
 * merged refreshed head and tip), it names exactly this receipt (receipt and
 * review request ids), and the receipt is a completed review of an EARLIER
 * head of the same pull request in the same repository by `reviewer`
 * (observed and expected), with nothing uncounted and no unresolved P0, that
 * accepted the record's own issue. Pure: the patch proof is separate.
 */
export function carriedReleaseReceipt(
  request: ReleaseRequestV1,
  record: WorkRecordV1,
  review: ReviewReceiptV1 | null,
  reviewer: string,
): review is ReviewReceiptV1 {
  return review !== null && record.target.head !== null &&
    releaseRequestMatchesDelivery(request, record) &&
    request.source.reviewReceiptId === review.id &&
    request.source.reviewRequestId === review.requestId &&
    sameRepositoryIdentity(review.repository, record.repository) &&
    review.pullRequest.number === record.target.pr &&
    review.pullRequest.head !== record.target.head &&
    review.outcome === "completed" && review.resultId !== null &&
    review.completedAt !== null &&
    review.observedReviewer === reviewer &&
    review.expectedReviewer === reviewer &&
    cleanReview(review) &&
    (record.related.issueNumber === null ||
      review.taskAcceptance?.issueNumber === record.related.issueNumber);
}

/**
 * Re-derive the patch proof between the receipt's reviewed H0 on B0 and the
 * record's merged H1 on T. A throwing or unknown answer is no proof.
 */
export async function proveCarriedRelease(
  record: WorkRecordV1,
  review: ReviewReceiptV1,
  carried: CarriedReleaseProverV1,
): Promise<CarriedPatchVerdictV1> {
  const head = record.target.head;
  if (head === null) return "unavailable";
  let verdict: unknown;
  try {
    verdict = await carried.prove({
      reviewedBase: review.pullRequest.base,
      reviewedHead: review.pullRequest.head,
      base: record.target.base,
      head,
    });
  } catch {
    return "unavailable";
  }
  return verdict === "holds" || verdict === "changed" ? verdict : "unavailable";
}

/**
 * The runtime's carried proof: its git proof (`proveCarriedPatch`, decided by
 * `carriedPatchHolds`), derived at most once per identity for the prover's
 * lifetime (one delivery step), with the port's trusted reviewer. A failed
 * read is `unavailable`. Undefined when the port cannot prove a carried
 * patch: then no carried request ever binds.
 */
export function gitCarriedReleaseProver(
  deps: Pick<RepairCycleDepsV1, "github">,
): CarriedReleaseProverV1 | undefined {
  const prove = deps.github.proveCarriedPatch?.bind(deps.github);
  if (prove === undefined) return undefined;
  const proofs = new Map<string, Promise<CarriedPatchVerdictV1>>();
  return {
    reviewer: deps.github.reviewerIdentity,
    prove(request) {
      const key =
        `${request.reviewedBase}:${request.reviewedHead}:${request.base}:${request.head}`;
      let verdict = proofs.get(key);
      if (verdict === undefined) {
        verdict = prove(request).then(
          (proof): CarriedPatchVerdictV1 =>
            !proof.ok
              ? "unavailable"
              : carriedPatchHolds(request, proof.value)
              ? "holds"
              : "changed",
          (): CarriedPatchVerdictV1 => "unavailable",
        );
        proofs.set(key, verdict);
      }
      return verdict;
    },
  };
}

/**
 * `deliveryTaskRefusal` for the receipt a release request references, with
 * its carried variant. A carried receipt (`carriedReleaseReceipt`) authorizes
 * the delivery only through the shared predicate as of the reviewed identity
 * (`reviewedIdentity`) and only while the re-derived patch proof holds: an
 * unreadable task or proof waits, and a patch that no longer proves refuses
 * with the exact binder's own `MERGE_WITHOUT_REVIEW_DETAIL`. Every other
 * receipt, and every request when no carried proof is available, goes
 * through `deliveryTaskRefusal` unchanged.
 */
export async function releaseDeliveryTaskRefusal(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  request: ReleaseRequestV1 | undefined,
  referenced: ReviewReceiptV1 | null,
  carried: CarriedReleaseProverV1 | undefined = gitCarriedReleaseProver(deps),
): Promise<string | "wait" | null> {
  if (
    carried === undefined || request === undefined ||
    record.related.issueNumber === null ||
    !carriedReleaseReceipt(request, record, referenced, carried.reviewer)
  ) return await deliveryTaskRefusal(deps, record, referenced);
  const task = await readDeliveryTaskContext(deps, record);
  if (task === "unavailable") return "wait";
  const reviewed = reviewedIdentity(record, referenced);
  const semantic = taskAcceptanceRefusal(referenced, reviewed, task);
  if (semantic !== null) return semantic;
  if (
    authorizingReceipt([referenced], reviewed, carried.reviewer, task) === null
  ) return MERGE_WITHOUT_REVIEW_DETAIL;
  const verdict = await proveCarriedRelease(record, referenced, carried);
  if (verdict === "unavailable") return "wait";
  return verdict === "holds" ? null : MERGE_WITHOUT_REVIEW_DETAIL;
}
