/** Trusted in-memory queue facts. These are not persisted V1 extensions. */
import type { GitSha } from "../contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";

export type QueueUnavailableReason =
  | "auth"
  | "permission"
  | "rate_limited"
  | "transport"
  | "deadline"
  | "http"
  | "not_found"
  | "incomplete"
  | "resource_bound"
  | "drift"
  | "unsupported";
export type QueueInvalidReason =
  | "malformed"
  | "identity_mismatch"
  | "duplicate"
  | "cursor"
  | "graphql_error"
  | "unsupported_actor";
export type QueueRead<T> =
  | { status: "complete"; value: T }
  | { status: "unavailable"; reason: QueueUnavailableReason }
  | { status: "invalid"; reason: QueueInvalidReason };

export interface QueueActor {
  nodeId: string;
  login: string;
  type: "Bot" | "User";
}
export interface QueuePullIdentity {
  repository: RepositoryIdentityV1;
  number: number;
  nodeId: string;
  baseRef: string;
  headRef: string;
  /** PullRequest.headRefOid, never inferred from the queue group head. */
  head: GitSha;
}
export interface QueueEntry {
  id: string;
  pull: QueuePullIdentity;
  position: number;
  state: "AWAITING_CHECKS" | "LOCKED" | "MERGEABLE" | "QUEUED" | "UNMERGEABLE";
  enqueuer: QueueActor;
  enqueuedAt: number;
  baseCommit: GitSha | null;
  headCommit: GitSha | null;
  jump: boolean;
  solo: boolean;
}
export interface QueueSnapshot {
  repository: RepositoryIdentityV1;
  baseRef: string;
  baseTip: GitSha;
  queueId: string | null;
  entries: readonly QueueEntry[];
  observedAt: number;
}
export interface QueueMembership {
  pull: QueuePullIdentity;
  entry: QueueEntry | null;
  mergedRevision: GitSha | null;
}
export interface QueueAddedEvent {
  id: string;
  at: number;
  actor: QueueActor | null;
}
export interface QueueRemovedEvent extends QueueAddedEvent {
  /** Bounded untrusted input; never emit it verbatim. */
  reason: string | null;
}
export interface QueueEvents {
  pull: QueuePullIdentity;
  added: readonly QueueAddedEvent[];
  removed: readonly QueueRemovedEvent[];
}
export interface QueueCheck {
  id: number;
  suiteId: number;
  head: GitSha;
  name: string;
  appId: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
}
export interface QueueGroupRun {
  id: number;
  attempt: number;
  head: GitSha;
  event: "merge_group";
  workflowId: number;
  workflowPath: ".github/workflows/deno-deploy.yml";
  suiteId: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  checks: readonly QueueCheck[];
}
export interface QueueEvidence extends QueueEvents {
  entry: QueueEntry | null;
  /** An unqueried Actions listing must never be represented as an empty list. */
  mergeGroupRuns: readonly QueueGroupRun[];
}
export type QueueRefusalReason =
  | "not_mergeable"
  | "head_mismatch"
  | "queue_required"
  | "permission"
  | "invalid_request"
  | "unknown";
export type QueueAdmission =
  | { status: "pending"; requestId: string }
  | { status: "hint_enqueued"; requestId: string | null }
  | { status: "hint_merged"; requestId: string | null }
  | { status: "refused"; reason: QueueRefusalReason }
  | { status: "ambiguous"; requestId: string | null }
  | { status: "not_submitted"; reason: QueueUnavailableReason };
export type QueueOperation =
  | { status: "pending" | "enqueued" | "merged"; requestId: string }
  | { status: "failed"; requestId: string; reason: QueueRefusalReason };
export type QueueDequeue =
  | { status: "submitted" }
  | { status: "ambiguous" }
  | { status: "not_submitted"; reason: QueueUnavailableReason };
export interface MergeQueueSurface {
  readQueue(baseRef: string): Promise<QueueRead<QueueSnapshot>>;
  readPullMembership(
    pull: QueuePullIdentity,
  ): Promise<QueueRead<QueueMembership>>;
  readPullEvidence(pull: QueuePullIdentity): Promise<QueueRead<QueueEvidence>>;
  enqueue(pull: QueuePullIdentity): Promise<QueueAdmission>;
  poll(
    pull: QueuePullIdentity,
    requestId: string,
  ): Promise<QueueRead<QueueOperation>>;
  dequeue(
    input: { pull: QueuePullIdentity; entryId: string },
  ): Promise<QueueDequeue>;
}

export type QueueHoldReason =
  | "queued"
  | "queue_unavailable"
  | "ambiguous_admission"
  | "foreign_entry"
  | "proof_unavailable"
  | "unknown_hold";
export type QueueDriftReason =
  | "head_changed"
  | "task_changed"
  | "opted_out"
  | "review_changed"
  | "blocking_review"
  | "path_overlap"
  | "workflow_changed"
  | "rules_changed";
export type QueueOwnerReason =
  | "refusals_exhausted"
  | "admission_unresolved"
  | "repeated_queue_failure"
  | "foreign_entry_drift"
  | "queue_evidence_expired"
  | "historical_direct_evidence_missing";
export interface QueueBinding {
  repository: RepositoryIdentityV1;
  pullRequest: number;
  base: GitSha;
  head: GitSha;
  reviewRequestId: string;
  reviewReceiptId: string;
  taskDigest: string;
}
export type QueuePolicyDecision =
  | { action: "hold"; reason: QueueHoldReason }
  | { action: "enqueue"; binding: QueueBinding }
  | { action: "dequeue_owned"; entryId: string; reason: QueueDriftReason }
  | { action: "reenter"; binding: QueueBinding }
  | { action: "owner_park"; reason: QueueOwnerReason };
export interface VerifiedQueueDelivery extends QueueBinding {
  kind: "queue";
  revision: GitSha;
  firstParent: GitSha;
  proofDigest: string;
  queueEvidenceIds: readonly string[];
  workflowRunId: number;
  workflowAttempt: number;
  checkSuiteId: number;
}
export interface VerifiedDirectDelivery extends QueueBinding {
  kind: "direct";
  revision: GitSha;
  firstParent: GitSha;
  proofDigest: string;
  provenance:
    | { kind: "trusted_success"; operationId: string; witnessDigest: string }
    | {
      kind: "historical_exact";
      manifestDigest: string;
      witnessDigest: string;
    };
}
export type VerifiedDelivery = VerifiedQueueDelivery | VerifiedDirectDelivery;
export type DeliveryProofReason =
  | "queue_evidence_required"
  | "queue_evidence_unavailable"
  | "identity_mismatch"
  | "receipt_mismatch"
  | "task_mismatch"
  | "untrusted_actor"
  | "canary_unaccepted"
  | "not_on_base_branch"
  | "invalid_parents"
  | "base_not_ancestor"
  | "tree_mismatch"
  | "tree_unavailable"
  | "group_ci_missing"
  | "group_ci_unavailable"
  | "group_ci_not_success"
  | "direct_provenance_missing"
  | "direct_provenance_mismatch"
  | "not_merged"
  | "review_blocking"
  | "source_opted_out";
export type DeliveryProofResult =
  | { status: "verified"; delivery: VerifiedDelivery }
  | { status: "rejected"; reason: DeliveryProofReason }
  | { status: "unavailable"; reason: DeliveryProofReason };
