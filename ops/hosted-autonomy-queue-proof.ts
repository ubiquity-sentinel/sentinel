import type { TakeoverPublicationProof } from "../src/contracts/existing-pr-takeover.ts";
import { hasTakeoverCustody } from "../src/github/existing-pr-takeover-provenance.ts";
import { takeoverPublicationMatches } from "../src/github/existing-pr-publication-proof.ts";
/** One queue-first proof constructor. Inputs are authenticated coordinator facts. */
import { type GitSha, isGitSha } from "../src/contracts/brands.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../src/contracts/canonical.ts";
import type {
  ReviewReceiptV1,
  ReviewTaskStatementV1,
} from "../src/contracts/review-receipt.ts";
import { checkReviewTaskStatement } from "../src/contracts/review-task-acceptance.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { MaxItems } from "../src/contracts/validation.ts";
import type {
  DeliveryProofReason,
  DeliveryProofResult,
  QueueActor,
  QueueBinding,
  QueueGroupRun,
  QueuePullIdentity,
  QueueRead,
  VerifiedDelivery,
  VerifiedDirectDelivery,
} from "../src/github/merge-queue-types.ts";
import { reviewAuthorizesMerge } from "../src/repair/review-gate.ts";
import {
  type HostedTreeChangeV1,
  sameTreeChanges,
} from "./hosted-autonomy-github-trees.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
} from "./hosted-autonomy-policy.ts";
import {
  hasQueueDeliveryProvenance,
  hasQueueIntentNamespace,
  isQueueHeld,
} from "./hosted-autonomy-queue-policy.ts";

export interface QueueTreePatchFact {
  base: GitSha;
  head: GitSha;
  mergeBase: GitSha;
  changes: readonly HostedTreeChangeV1[];
}
export interface QueueProvenanceFact {
  binding: QueueBinding;
  enqueuer: QueueActor;
  /** Native evidence IDs AND exact-head intent/group reconciliation, not a queue ref. */
  evidenceIds: readonly string[];
}
export interface DirectMergeWitness {
  binding: QueueBinding;
  revision: GitSha;
  /** Authenticated successful exact-head operation or immutable preactivation manifest. */
  provenance: VerifiedDirectDelivery["provenance"];
}
export interface QueueProofPolicy {
  /** No accepted canary means no queue proof. This is trusted configuration. */
  canaryDigest: string | null;
  appActor: QueueActor | null;
  mergedActors: readonly QueueActor[];
  workflowId: number | null;
  /** Reviewed canonical workflow bytes at the actual tested merge revision. */
  workflowSha256?: string | null;
  /** Exact native removal values established by the accepted canary; no text inference. */
  mergedRemovalReasons?: readonly string[];
  /** Exact beforeCommit semantics demonstrated by the accepted merge canary. */
  mergedRemovalBeforeCommit?: "pull_head" | "merged_revision";
  historicalDirectManifestDigest: string | null;
  /** Finite immutable preactivation grants, loaded with the pinned manifest. */
  historicalDirectWitnesses: readonly {
    binding: QueueBinding;
    revision: GitSha;
    witnessDigest: string;
  }[];
}
export interface QueueDeliveryFacts {
  binding: QueueBinding;
  record: WorkRecordV1;
  receipt: ReviewReceiptV1;
  latestReceiptId: string | null;
  task: ReviewTaskStatementV1 | null | "unavailable";
  optedOut: boolean | null;
  pull: QueuePullIdentity;
  publicationAuthor: string;
  publicationProof?: TakeoverPublicationProof;
  revision: GitSha | null;
  mergedBy: QueueActor | null;
  commit:
    | { sha: GitSha; parents: readonly GitSha[]; author: QueueActor | null }
    | null;
  reachable: QueueRead<
    { revision: GitSha; branch: string; reachable: boolean }
  >;
  ancestry: QueueRead<
    { ancestor: GitSha; descendant: GitSha; isAncestor: boolean }
  >;
  reviewedPatch: QueueRead<QueueTreePatchFact>;
  integratedPatch: QueueRead<QueueTreePatchFact>;
  /** Required only when the receipt names the original carried B0/H0. */
  originalPatch: QueueRead<QueueTreePatchFact> | null;
  /** Complete null means no native queue evidence, never merely no indexed run. */
  queue: QueueRead<QueueProvenanceFact | null>;
  /** Additional native evidence found by another trusted reader dominates direct proof. */
  anyQueueEvidence: boolean;
  groupRuns: QueueRead<readonly QueueGroupRun[]>;
  workflow?: QueueRead<{
    revision: GitSha;
    path: ".github/workflows/deno-deploy.yml";
    sha256: string;
  }>;
  directWitness: DirectMergeWitness | null;
}
const REQUIRED_CHECKS = [
  "validate",
  "verify-artifact",
  "darwin-native",
  "mac-containment",
] as const;
const DIGEST = /^[0-9a-f]{64}$/;
const verifiedDeliveries = new WeakMap<object, string>();

/** A decoded or caller-constructed object is never a live proof capability. */
export function isVerifiedDeliveryProof(
  value: unknown,
): value is VerifiedDelivery {
  return value !== null && typeof value === "object" &&
    verifiedDeliveries.get(value) === canonicalStringify(value);
}

function verified(delivery: VerifiedDelivery): DeliveryProofResult {
  verifiedDeliveries.set(delivery, canonicalStringify(delivery));
  return { status: "verified", delivery };
}
const reject = (reason: DeliveryProofReason): DeliveryProofResult => ({
  status: "rejected",
  reason,
});
const unavailable = (reason: DeliveryProofReason): DeliveryProofResult => ({
  status: "unavailable",
  reason,
});
function sameActor(a: QueueActor | null, b: QueueActor | null): boolean {
  return a !== null && b !== null && a.nodeId === b.nodeId &&
    a.login === b.login && a.type === b.type;
}
function sameBinding(a: QueueBinding, b: QueueBinding): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}
function safeIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    [...value].every((character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    );
}
function validBinding(value: QueueBinding): boolean {
  return value !== null && typeof value === "object" &&
    value.repository !== null && typeof value.repository === "object" &&
    value.repository.owner === "ubiquity" &&
    value.repository.name === "ai.ubq.fi" &&
    Number.isSafeInteger(value.repository.installationId) &&
    value.repository.installationId > 0 &&
    Number.isSafeInteger(value.pullRequest) && value.pullRequest > 0 &&
    isGitSha(value.base) && isGitSha(value.head) &&
    safeIdentity(value.reviewRequestId) &&
    safeIdentity(value.reviewReceiptId) &&
    typeof value.taskDigest === "string" && DIGEST.test(value.taskDigest);
}
function validChanges(changes: readonly HostedTreeChangeV1[]): boolean {
  const modes = new Set(["100644", "100755", "120000", "160000"]);
  return changes.every((change, index) => {
    const path = change.path;
    if (
      typeof path !== "string" || path.length === 0 || path.startsWith("/") ||
      path.split("/").some((part) =>
        part === "" || part === "." || part === ".."
      ) ||
      (index > 0 && changes[index - 1].path >= path)
    ) return false;
    const side = (mode: string | null, sha: string | null) =>
      mode === null ? sha === null : modes.has(mode) && isGitSha(sha);
    return side(change.oldMode, change.oldSha) &&
      side(change.newMode, change.newSha) &&
      (change.oldMode !== change.newMode || change.oldSha !== change.newSha);
  });
}
function patchAt(
  patch: QueueTreePatchFact,
  base: GitSha,
  head: GitSha,
): boolean {
  return patch.base === base && patch.head === head &&
    isGitSha(patch.mergeBase) && validChanges(patch.changes);
}

async function commonProof(
  facts: QueueDeliveryFacts,
): Promise<DeliveryProofResult | null> {
  const { binding: b, record, receipt, pull, revision, commit } = facts;
  if (
    !validBinding(b) ||
    canonicalStringify(record.repository) !==
      canonicalStringify(b.repository) ||
    canonicalStringify(pull.repository) !== canonicalStringify(b.repository) ||
    record.target.pr !== b.pullRequest || record.target.base !== b.base ||
    record.target.head !== b.head ||
    pull.number !== b.pullRequest || pull.head !== b.head ||
    pull.baseRef !== "development"
  ) return reject("identity_mismatch");
  if (
    hasTakeoverCustody(record)
      ? revision === null ||
        !takeoverPublicationMatches(
          facts.publicationProof,
          record,
          revision,
          facts.publicationAuthor,
        )
      : !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(facts.publicationAuthor)
  ) {
    return reject("untrusted_actor");
  }
  if (!isGitSha(revision) || commit === null || commit.sha !== revision) {
    return reject("not_merged");
  }
  if (
    commit.parents.length !== 2 || commit.parents[1] !== b.head ||
    !isGitSha(commit.parents[0])
  ) return reject("invalid_parents");
  if (facts.reachable.status !== "complete") {
    return unavailable("not_on_base_branch");
  }
  if (
    facts.reachable.value.revision !== revision ||
    facts.reachable.value.branch !== "development" ||
    facts.reachable.value.reachable !== true
  ) return reject("not_on_base_branch");
  const parent = commit.parents[0];
  if (parent !== b.base) {
    if (facts.ancestry.status !== "complete") {
      return unavailable("base_not_ancestor");
    }
    if (
      facts.ancestry.value.ancestor !== b.base ||
      facts.ancestry.value.descendant !== parent ||
      facts.ancestry.value.isAncestor !== true
    ) return reject("base_not_ancestor");
  }
  if (facts.optedOut === null || facts.task === "unavailable") {
    return unavailable("task_mismatch");
  }
  if (facts.optedOut !== false) return reject("source_opted_out");
  if (facts.task !== null) {
    const checked = await checkReviewTaskStatement(facts.task);
    if (!checked.ok || checked.statement.digest !== b.taskDigest) {
      return reject("task_mismatch");
    }
  } else if (record.related.issueNumber !== null) {
    return reject("task_mismatch");
  }
  if (
    receipt.id !== b.reviewReceiptId ||
    receipt.requestId !== b.reviewRequestId ||
    facts.latestReceiptId !== receipt.id
  ) return reject("receipt_mismatch");
  if (
    facts.reviewedPatch.status !== "complete" ||
    facts.integratedPatch.status !== "complete"
  ) return unavailable("tree_unavailable");
  const reviewed = facts.reviewedPatch.value,
    integrated = facts.integratedPatch.value;
  if (
    !patchAt(reviewed, b.base, b.head) ||
    !patchAt(integrated, parent, revision) ||
    integrated.mergeBase !== parent ||
    !sameTreeChanges(reviewed.changes, integrated.changes)
  ) return reject("tree_mismatch");
  const carried = receipt.pullRequest.base !== b.base ||
    receipt.pullRequest.head !== b.head;
  if (carried) {
    if (facts.originalPatch?.status !== "complete") {
      return unavailable("tree_unavailable");
    }
    const original = facts.originalPatch.value;
    if (
      !patchAt(original, receipt.pullRequest.base, receipt.pullRequest.head) ||
      !sameTreeChanges(original.changes, reviewed.changes)
    ) return reject("tree_mismatch");
  }
  const reviewedRecord = carried
    ? {
      ...record,
      target: {
        ...record.target,
        base: receipt.pullRequest.base,
        head: receipt.pullRequest.head,
      },
    }
    : record;
  if (
    !reviewAuthorizesMerge(
      receipt,
      reviewedRecord,
      HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
      facts.task,
    )
  ) return reject("review_blocking");
  return null;
}

function successfulGroupRun(
  facts: QueueDeliveryFacts,
  policy: QueueProofPolicy,
): QueueGroupRun | DeliveryProofResult {
  if (facts.groupRuns.status !== "complete") {
    return unavailable("group_ci_unavailable");
  }
  const runs = facts.groupRuns.value.filter((run) =>
    run.workflowId === policy.workflowId &&
    run.workflowPath === ".github/workflows/deno-deploy.yml" &&
    run.event === "merge_group" && run.head === facts.revision
  );
  if (runs.length === 0) return reject("group_ci_missing");
  const ids = new Set<number>();
  for (const run of runs) {
    if (
      !Number.isSafeInteger(run.id) || run.id < 1 || ids.has(run.id) ||
      !Number.isSafeInteger(run.attempt) || run.attempt < 1 ||
      !Number.isSafeInteger(run.suiteId) || run.suiteId < 1
    ) return unavailable("group_ci_unavailable");
    ids.add(run.id);
    if (
      new Set(run.checks.map((check) => check.id)).size !== run.checks.length ||
      run.checks.some((check) =>
        !Number.isSafeInteger(check.id) || check.id < 1
      )
    ) {
      return unavailable("group_ci_unavailable");
    }
    if (run.status !== "completed" || run.conclusion !== "success") {
      return reject("group_ci_not_success");
    }
    for (const name of REQUIRED_CHECKS) {
      const checks = run.checks.filter((check) => check.name === name);
      if (checks.length !== 1) return reject("group_ci_not_success");
      const check = checks[0];
      if (
        check.appId !== 15368 || check.head !== facts.revision ||
        check.suiteId !== run.suiteId ||
        check.status !== "completed" || check.conclusion !== "success"
      ) return reject("group_ci_not_success");
    }
  }
  return runs.reduce((a, b) => a.id > b.id ? a : b);
}

/**
 * The only exported constructor of VerifiedDelivery. Any queue evidence or
 * custody forces queue proof; an unavailable/failed queue proof cannot fall
 * through to direct proof. No absence-of-merge_group or timestamp shortcut.
 */
export async function resolveQueueAwareDelivery(
  facts: QueueDeliveryFacts,
  policy: QueueProofPolicy,
): Promise<DeliveryProofResult> {
  const held = isQueueHeld(facts.record) ||
    hasQueueIntentNamespace(facts.record) ||
    hasQueueDeliveryProvenance(facts.record);
  const queueEvidence = facts.anyQueueEvidence ||
    (facts.groupRuns.status === "complete" && facts.groupRuns.value.length > 0);
  if (facts.queue.status !== "complete") {
    return unavailable("queue_evidence_unavailable");
  }
  const queue = facts.queue.value;
  const queuePath = held || queueEvidence || queue !== null;
  if (queuePath && queue === null) return reject("queue_evidence_required");
  const common = await commonProof(facts);
  if (common !== null) return common;
  const revision = facts.revision!;
  const firstParent = facts.commit!.parents[0];
  if (queuePath && queue !== null) {
    if (
      policy.canaryDigest === null || !DIGEST.test(policy.canaryDigest) ||
      policy.appActor === null ||
      policy.appActor.type !== "Bot" ||
      policy.appActor.login !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
      policy.workflowId === null ||
      policy.workflowSha256 == null || !DIGEST.test(policy.workflowSha256)
    ) return unavailable("canary_unaccepted");
    if (
      !sameBinding(queue.binding, facts.binding) ||
      queue.evidenceIds.length === 0 ||
      queue.evidenceIds.some((id) =>
        typeof id !== "string" || id.length === 0 || id.length > 256
      ) ||
      new Set(queue.evidenceIds).size !== queue.evidenceIds.length
    ) return reject("identity_mismatch");
    if (
      !sameActor(queue.enqueuer, policy.appActor) ||
      !sameActor(facts.commit!.author, policy.appActor) ||
      !policy.mergedActors.some((actor) => sameActor(actor, facts.mergedBy))
    ) return reject("untrusted_actor");
    if (facts.workflow?.status !== "complete") {
      return unavailable("workflow_unavailable");
    }
    if (
      facts.workflow.value.revision !== revision ||
      facts.workflow.value.path !== ".github/workflows/deno-deploy.yml" ||
      facts.workflow.value.sha256 !== policy.workflowSha256
    ) return reject("workflow_mismatch");
    const run = successfulGroupRun(facts, policy);
    if (
      "status" in run &&
      (run.status === "rejected" || run.status === "unavailable")
    ) return run;
    const verifiedRun = run as QueueGroupRun;
    const proofDigest = await canonicalStringifySha256({
      domain: "sentinel.queue-delivery.v1",
      binding: facts.binding,
      revision,
      firstParent,
      queue,
      canary: policy.canaryDigest,
      run: verifiedRun,
      workflow: facts.workflow,
      reviewed: facts.reviewedPatch,
      integrated: facts.integratedPatch,
      original: facts.originalPatch,
    });
    return verified({
      ...facts.binding,
      kind: "queue",
      revision,
      firstParent,
      proofDigest,
      queueEvidenceIds: [...queue.evidenceIds],
      workflowRunId: verifiedRun.id,
      workflowAttempt: verifiedRun.attempt,
      checkSuiteId: verifiedRun.suiteId,
    });
  }
  if (facts.groupRuns.status !== "complete") {
    return unavailable("queue_evidence_unavailable");
  }
  const witness = facts.directWitness;
  if (witness === null) return reject("direct_provenance_missing");
  if (
    !sameBinding(witness.binding, facts.binding) ||
    witness.revision !== revision ||
    firstParent !== facts.binding.base ||
    facts.mergedBy?.login !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
    facts.mergedBy.type !== "Bot" ||
    facts.commit!.author?.login !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
    facts.commit!.author.type !== "Bot" ||
    !sameActor(facts.mergedBy, facts.commit!.author) ||
    !DIGEST.test(witness.provenance.witnessDigest)
  ) return reject("direct_provenance_mismatch");
  if (witness.provenance.kind === "historical_exact") {
    const entries = policy.historicalDirectWitnesses;
    if (
      !Array.isArray(entries) || entries.length > MaxItems.snapshotRecords ||
      entries.some((entry) =>
        entry === null || typeof entry !== "object" ||
        !isGitSha(entry.revision) ||
        typeof entry.witnessDigest !== "string" ||
        !DIGEST.test(entry.witnessDigest) || !validBinding(entry.binding)
      ) ||
      new Set(entries.map((entry) =>
          canonicalStringify({
            binding: entry.binding,
            revision: entry.revision,
          })
        )).size !== entries.length
    ) {
      return reject("direct_provenance_mismatch");
    }
    const digest = await canonicalStringifySha256({
      domain: "sentinel.queue-historical-direct.v1",
      witnesses: entries,
    });
    if (
      policy.historicalDirectManifestDigest !== digest ||
      witness.provenance.manifestDigest !== digest ||
      !entries.some((entry) =>
        sameBinding(entry.binding, witness.binding) &&
        entry.revision === revision &&
        entry.witnessDigest === witness.provenance.witnessDigest
      )
    ) return reject("direct_provenance_mismatch");
  }
  if (
    witness.provenance.kind === "trusted_success" &&
    !safeIdentity(witness.provenance.operationId)
  ) return reject("direct_provenance_mismatch");
  const proofDigest = await canonicalStringifySha256({
    domain: "sentinel.direct-delivery.v1",
    binding: facts.binding,
    revision,
    firstParent,
    witness,
    reviewed: facts.reviewedPatch,
    integrated: facts.integratedPatch,
    original: facts.originalPatch,
  });
  return verified({
    ...facts.binding,
    kind: "direct",
    revision,
    firstParent,
    proofDigest,
    provenance: witness.provenance,
  });
}
