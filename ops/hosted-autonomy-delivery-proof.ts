/** Per-pass delivery capabilities. A map entry or a caller-supplied boolean is not proof. */
import { type GitSha, isGitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type {
  ReviewReceiptV1,
  ReviewTaskStatementV1,
} from "../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import type { EvidenceRefV1 } from "../src/contracts/shared.ts";
import { MaxItems } from "../src/contracts/validation.ts";
import type { QueueBinding } from "../src/github/merge-queue-types.ts";
import {
  latestPullReview,
  reviewedIdentity,
} from "../src/repair/carried-review.ts";
import { reviewAuthorizesMerge } from "../src/repair/review-gate.ts";
import { isGatewayVpsRepository } from "../src/repair/vps-delivery.ts";
import {
  authorizingReceipt,
  readTrustedTask,
  verifiedMergedDelivery,
} from "./hosted-autonomy-delivery.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  isHostedSelf,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import {
  type QueueDeliveryRequest,
  queueRecordProtected,
} from "./hosted-autonomy-queue-context.ts";
import type {
  HostedAutonomyPassContextV1,
  HostedAutonomyScopeV1,
} from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyPullV1 } from "./hosted-autonomy-types.ts";
import { QUEUE_PROOF_ACTIVATED } from "../src/github/queue-runtime-policy.ts";
import { queueDeliveryProvenanceRef } from "../src/github/queue-delivery-provenance.ts";
import { isVerifiedDeliveryProof } from "./hosted-autonomy-queue-proof.ts";

export interface HostedDeliveryProof extends QueueBinding {
  readonly kind: "queue" | "direct" | "legacy";
  readonly revision: GitSha;
  readonly recordId: string;
  readonly receipt: ReviewReceiptV1;
  readonly evidenceRef: EvidenceRefV1 | null;
}
type ProofContext = Pick<
  HostedAutonomyPassContextV1,
  "deps" | "snapshot" | "observedHead"
>;
type Task = ReviewTaskStatementV1 | null | "unavailable";
const minted = new WeakMap<
  object,
  { record: string; receipt: string; task: string }
>();
function recordIdentity(record: WorkRecordV1): string {
  return canonicalStringify({
    id: record.id,
    repository: record.repository,
    source: record.source,
    issue: record.related.issueNumber,
    target: record.target,
  });
}
function taskIdentity(task: Task): string {
  return canonicalStringify(task);
}
function receiptForBinding(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  binding: QueueBinding,
  task: Task,
): ReviewReceiptV1 | null {
  if (
    task === "unavailable" ||
    !sameRepository(binding.repository, record.repository) ||
    binding.pullRequest !== record.target.pr ||
    binding.head !== record.target.head ||
    binding.base !== record.target.base ||
    binding.taskDigest !== (task?.digest ?? "")
  ) return null;
  const receipt = snapshot.reviews.find((row) =>
    row.id === binding.reviewReceiptId &&
    row.requestId === binding.reviewRequestId
  );
  if (
    receipt === undefined ||
    latestPullReview(snapshot, record, HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR)
        ?.id !== receipt.id
  ) return null;
  return reviewAuthorizesMerge(
      receipt,
      reviewedIdentity(record, receipt),
      HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
      task,
    )
    ? receipt
    : null;
}
function mint(
  kind: HostedDeliveryProof["kind"],
  revision: GitSha,
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
  task: Task,
  evidenceRef: EvidenceRefV1 | null = null,
): HostedDeliveryProof {
  const proof = Object.freeze({
    kind,
    revision,
    recordId: record.id,
    repository: Object.freeze({ ...record.repository }),
    pullRequest: record.target.pr!,
    base: record.target.base!,
    head: record.target.head!,
    reviewRequestId: receipt.requestId,
    reviewReceiptId: receipt.id,
    taskDigest: task !== "unavailable" ? task?.digest ?? "" : "",
    receipt: structuredClone(receipt),
    evidenceRef: evidenceRef === null
      ? null
      : Object.freeze({ ...evidenceRef }),
  });
  minted.set(proof, {
    record: recordIdentity(record),
    receipt: canonicalStringify(receipt),
    task: taskIdentity(task),
  });
  return proof;
}

/** Preserve the unique authenticated admission ancestor before clearing custody. */
export function retainHostedDeliveryProvenance(
  record: WorkRecordV1,
  proof: HostedDeliveryProof,
): WorkRecordV1 | null {
  if (minted.get(proof)?.record !== recordIdentity(record)) return null;
  if (proof.evidenceRef === null) return proof.kind === "queue" ? null : record;
  if (
    record.evidence.some((item) =>
      canonicalStringify(item) === canonicalStringify(proof.evidenceRef)
    )
  ) return record;
  return record.evidence.length >= MaxItems.evidenceRefs
    ? null
    : { ...record, evidence: [...record.evidence, proof.evidenceRef] };
}

/** Re-check every binding against the current row, receipt and independently read task. */
export function hostedDeliveryProofMatches(
  proof: unknown,
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  task: Task,
  revision?: string,
): proof is HostedDeliveryProof {
  if (typeof proof !== "object" || proof === null) return false;
  const seal = minted.get(proof);
  if (
    seal === undefined || seal.record !== recordIdentity(record) ||
    seal.task !== taskIdentity(task)
  ) return false;
  const value = proof as HostedDeliveryProof;
  if (revision !== undefined && value.revision !== revision) return false;
  const receipt = snapshot.reviews.find((row) =>
    row.id === value.reviewReceiptId && row.requestId === value.reviewRequestId
  );
  if (
    receipt === undefined || canonicalStringify(receipt) !== seal.receipt ||
    canonicalStringify(value.receipt) !== seal.receipt
  ) return false;
  if (isGatewayVpsRepository(record.repository)) {
    return receiptForBinding(snapshot, record, value, task) !== null;
  }
  return authorizingReceipt(
    { ...snapshot, reviews: [receipt] },
    record,
    task,
  ) !== null;
}

/** Fresh root resolver is mandatory on the gateway, including the dark legacy path. */
export async function resolveHostedDelivery(
  context: ProofContext,
  record: WorkRecordV1,
  scope: HostedAutonomyScopeV1,
  pull: HostedAutonomyPullV1 | null,
  purpose: QueueDeliveryRequest["purpose"],
  expectedRevision: string | null = null,
): Promise<HostedDeliveryProof | null> {
  if (
    isHostedSelf(record.repository) ||
    context.deps.queueCustody?.ready === false || pull === null ||
    !isGitSha(context.observedHead) || !isGitSha(pull.mergeCommitSha) ||
    pull.merged !== true ||
    pull.headSha !== record.target.head ||
    (expectedRevision !== null && pull.mergeCommitSha !== expectedRevision)
  ) return null;
  const task = await readTrustedTask(scope.surface, record);
  if (isGatewayVpsRepository(record.repository)) {
    if (pull.number !== record.target.pr) return null;
    const custody = context.deps.queueCustody;
    if (custody?.ready !== true || custody.resolveDelivery === undefined) {
      return null;
    }
    let resolution;
    try {
      resolution = await custody.resolveDelivery({
        snapshot: context.snapshot,
        observedHead: context.observedHead,
        record,
        expectedRevision: pull.mergeCommitSha,
        purpose,
      });
    } catch {
      return null;
    }
    if (
      resolution.status !== "verified" && resolution.status !== "legacy_direct"
    ) return null;
    if (
      resolution.status === "verified" &&
      !isVerifiedDeliveryProof(resolution.delivery)
    ) return null;
    const binding = resolution.status === "verified"
      ? resolution.delivery
      : resolution.binding;
    const revision = resolution.status === "verified"
      ? resolution.delivery.revision
      : resolution.revision;
    if (revision !== pull.mergeCommitSha) return null;
    const receipt = receiptForBinding(context.snapshot, record, binding, task);
    if (receipt === null) return null;
    if (resolution.status === "legacy_direct") {
      const carried = receipt.pullRequest.base !== record.target.base ||
        receipt.pullRequest.head !== record.target.head;
      if (
        carried
          ? resolution.carried?.reviewedBase !== receipt.pullRequest.base ||
            resolution.carried.reviewedHead !== receipt.pullRequest.head ||
            !/^[0-9a-f]{64}$/.test(resolution.carried.patchDigest)
          : resolution.carried !== undefined
      ) return null;
      if (
        QUEUE_PROOF_ACTIVATED || custody.proofActivated ||
        queueRecordProtected(record, custody) ||
        verifiedMergedDelivery(
            record,
            pull,
            scope.baseBranch,
            custody,
            resolution.publicationProof,
          )
            ?.revision !== revision
      ) return null;
      return mint("legacy", revision, record, receipt, task);
    }
    if (
      resolution.delivery.kind === "direct" &&
      queueRecordProtected(record, custody)
    ) return null;
    const evidenceRef = resolution.delivery.kind === "queue"
      ? queueDeliveryProvenanceRef(
        resolution.delivery,
        record,
        context.observedHead,
      )
      : null;
    if (resolution.delivery.kind === "queue" && evidenceRef === null) {
      return null;
    }
    return mint(
      resolution.delivery.kind,
      revision,
      record,
      receipt,
      task,
      evidenceRef,
    );
  }
  const legacy = verifiedMergedDelivery(record, pull, scope.baseBranch);
  const receipt = authorizingReceipt(context.snapshot, record, task);
  return legacy === null || receipt === null
    ? null
    : mint("legacy", pull.mergeCommitSha, record, receipt, task);
}
