/** Trusted transient takeover capabilities. None of these types extends V1 state. */
import type { GitSha, WorkItemId } from "./brands.ts";
import type { PortResultV1 } from "./ports.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import type { RepairStateSnapshotV1 } from "./state-snapshots.ts";
import type { WorkRecordV1 } from "./work-record.ts";

export type TakeoverParkReason =
  | "association_unproven"
  | "ambiguous"
  | "foreign_repository"
  | "fork_head"
  | "unwritable_branch"
  | "protected_path"
  | "candidate_divergent"
  | "head_moved"
  | "source_changed"
  | "queue_custody"
  | "custody_unproven";

/** Native identity from Issue.closedByPullRequestsReferences, fully paginated. */
export interface TakeoverBinding {
  repository: RepositoryIdentityV1;
  taskId: WorkItemId;
  issueNumber: number;
  issueNodeId: string;
  issueDigest: string;
  pullRequest: number;
  pullNodeId: string;
  headRepositoryId: string;
  headRepository: { owner: string; name: string };
  headRef: string;
  baseRef: string;
  /** Original publication author; never a merge/enqueue actor authorization. */
  author: string;
}

/**
 * Fresh observations, not effect authority. Native association must be complete;
 * explicit text references alone never set associated=true. GitHub App
 * Repository.viewerPermission can be null, so writability is a separate trusted
 * target-remote/Contents capability plus branch-rules observation.
 */
export interface NativeTakeoverObservation {
  binding: TakeoverBinding;
  head: GitSha;
  base: GitSha;
  state: "open" | "closed" | "merged";
  issueOpen: boolean;
  associationComplete: boolean;
  associated: boolean;
  /** Complete reciprocal PullRequest.closingIssuesReferences; plain URLs grant nothing. */
  reciprocalComplete: boolean;
  reciprocalIssues: readonly {
    number: number;
    nodeId: string;
    repository: { owner: string; name: string };
  }[];
  openCandidates: readonly { number: number; nodeId: string }[];
  headRefExists: boolean;
  sameRepository: boolean;
  writableBranch: boolean;
  protectedPathsClear: boolean;
  queueCustodyClear: boolean;
}

export type TakeoverDiscovery =
  | { status: "none"; issueDigest: string }
  | { status: "candidate"; candidate: NativeTakeoverObservation }
  | { status: "owner_park"; reason: TakeoverParkReason; prNumbers: number[] }
  | {
    status: "unavailable";
    reason: "source" | "pagination" | "deadline" | "identity";
  };

export type TakeoverOperation =
  | "correct"
  | "publish"
  | "review"
  | "refresh"
  | "merge"
  | "enqueue";

/** Only the trusted factory can issue a recognized object; structure grants nothing. */
export interface TakeoverCustodyProof {
  readonly kind: "verified_existing_pr_custody";
}

export interface TakeoverProofRequest {
  record: WorkRecordV1;
  snapshot: RepairStateSnapshotV1;
  expectedStateHead: GitSha;
  operation: TakeoverOperation;
  /** Exact live PR head before this operation; publication may hold a newer candidate. */
  expectedHead: GitSha;
  /** Refresh preparation only: exact new base in the persisted base_refresh intent. */
  observedBase?: GitSha;
  /** Mandatory only for a prepared publish; must be a proved FF successor. */
  nextHead?: GitSha;
  deadline: number;
}

export interface TakeoverPreserveRequest {
  binding: TakeoverBinding;
  bindingDigest: string;
  head: GitSha;
  base: GitSha;
  ref: string;
  expectedStateHead: GitSha;
  deadline: number;
}

/** Actual trusted Git observations, separate from claims in a V1 descriptor. */
export interface TakeoverCandidateObservation {
  anchorRef: string;
  anchorHead: GitSha;
  /** A fresh object-store read must have fetched the exact anchor ref/head. */
  anchorRestored: boolean;
  currentHead: GitSha;
  currentBase: GitSha;
  /** True only after verifying the real producer's state/reservation or refresh proof. */
  currentProducerVerified: boolean;
  currentDescendsFromAnchor: boolean;
  nextHead: GitSha | null;
  nextDescendsFromExpected: boolean;
}

/** Optional only at composition; absence must suppress takeover effects/create fallback. */
export interface ExistingPrTakeoverPort {
  discover(
    input: { record: WorkRecordV1; deadline: number },
  ): Promise<TakeoverDiscovery>;
  preserveNativeHead(
    input: TakeoverPreserveRequest,
  ): Promise<PortResultV1<void>>;
  resolve(
    input: TakeoverProofRequest,
  ): Promise<PortResultV1<TakeoverCustodyProof>>;
  /** Single-use, operation/state/head/deadline-bound, freshly re-observed authorization. */
  authorizeEffect(
    proof: TakeoverCustodyProof,
    input: TakeoverProofRequest,
  ): Promise<PortResultV1<void>>;
}
