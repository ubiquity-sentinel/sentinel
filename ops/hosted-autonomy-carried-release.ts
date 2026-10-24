/**
 * Launcher half of carried release acceptance (Sentinel #152): the closure
 * pass accepts and closes a Gateway delivery the delivery pass merged under a
 * CARRIED review (a production request naming the completed, clean App
 * review of an earlier head H0 on B0, with the merged refreshed head H1 on
 * tip T as its source, `carriedRequestReceipt`) only through the shared
 * carried binder (`carriedGatewayRequestBindsDelivery`), whose patch proof is
 * the launcher's exact tree proof (`carriedPatchRefusal` over
 * `mergeBaseTreeChanges`), re-derived once per pass, and authorizes the task
 * as of the reviewed identity (`reviewedIdentity`). Every other record keeps
 * the exact authorization (`authorizingReceipt`) unchanged.
 */
import type {
  ReviewReceiptV1,
  ReviewTaskStatementV1,
} from "../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { reviewedIdentity } from "../src/repair/carried-review.ts";
import type {
  CarriedPatchVerdictV1,
  CarriedReleaseProverV1,
} from "../src/repair/carried-release.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";
import { reviewAuthorizesMerge } from "../src/repair/review-gate.ts";
import { isGatewayVpsRepository } from "../src/repair/vps-delivery.ts";
import { authorizingReceipt } from "./hosted-autonomy-delivery.ts";
import { HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR } from "./hosted-autonomy-policy.ts";
import {
  carriedPatchRefusal,
  carriedRequestReceipt,
} from "./hosted-autonomy-spent-delivery.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyRecordV1,
} from "./hosted-autonomy-types.ts";

/** Tree proofs already derived in one pass, keyed by the pass context. */
const passProofs = new WeakMap<
  object,
  Map<string, Promise<CarriedPatchVerdictV1>>
>();

/**
 * The launcher's carried proof for `receipt` in one pass (`pass` is the pass
 * context): the fixed App reviewer and the exact tree proof of the delivery
 * pass's carried merge (`carriedPatchRefusal`: equal change sets of
 * merge-base(B0, H0) -> H0 and T -> H1 by path, mode and full blob id from
 * GitHub's Git trees, T the refreshed side's own merge base, no protected
 * path), derived at most once per identity per pass. An unreadable tree is
 * `unavailable`; every other refusal is `changed`.
 */
export function treeCarriedReleaseProver(
  pass: object,
  surface: HostedAutonomyGitHubV1 | null,
  receipt: ReviewReceiptV1,
): CarriedReleaseProverV1 {
  let proofs = passProofs.get(pass);
  if (proofs === undefined) {
    proofs = new Map();
    passProofs.set(pass, proofs);
  }
  const memo = proofs;
  return {
    reviewer: HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
    prove(request) {
      if (
        surface === null ||
        request.reviewedBase !== receipt.pullRequest.base ||
        request.reviewedHead !== receipt.pullRequest.head
      ) return Promise.resolve("unavailable");
      const key = JSON.stringify([
        receipt.repository.owner,
        receipt.repository.name,
        receipt.repository.installationId,
        request.reviewedBase,
        request.reviewedHead,
        request.base,
        request.head,
      ]);
      let verdict = memo.get(key);
      if (verdict === undefined) {
        verdict = carriedPatchRefusal(
          surface,
          receipt,
          request.head,
          request.base,
        ).then(
          ({ refusal }): CarriedPatchVerdictV1 =>
            refusal === null
              ? "holds"
              : refusal === "carried_proof_unavailable"
              ? "unavailable"
              : "changed",
          (): CarriedPatchVerdictV1 => "unavailable",
        );
        memo.set(key, verdict);
      }
      return verdict;
    },
  };
}

/**
 * The receipt that authorizes one delivery's release closure: the exact one
 * (`authorizingReceipt`), or, for a carried Gateway delivery only (a record
 * at `delivery` beside exactly one production request that names the carried
 * receipt, `carriedRequestReceipt`), that receipt through the shared
 * predicate as of the reviewed identity (`reviewedIdentity`), the fixed App
 * reviewer and the trusted live task. No patch proof is read here: every
 * Gateway closure write is preceded by `gatewayClosureGate`, which re-derives
 * it through the carried binder.
 */
export function releaseAuthorizingReceipt(
  snapshot: RepairStateSnapshotV1,
  record: HostedAutonomyRecordV1,
  task: ReviewTaskStatementV1 | null | "unavailable",
): ReviewReceiptV1 | null {
  const exact = authorizingReceipt(snapshot, record, task);
  if (
    exact !== null || !isGatewayVpsRepository(record.repository) ||
    record.nextStep !== "delivery"
  ) return exact;
  const requests = snapshot.releaseRequests.filter((request) =>
    releaseRequestMatchesDelivery(request, record)
  );
  if (requests.length !== 1) return null;
  const receipt = carriedRequestReceipt(snapshot.reviews, requests[0]);
  return receipt !== null &&
      reviewAuthorizesMerge(
        receipt,
        reviewedIdentity(record, receipt),
        HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
        task,
      )
    ? receipt
    : null;
}
