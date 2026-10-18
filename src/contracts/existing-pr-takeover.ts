/** Trusted transient takeover capabilities. None of these types extends V1 state. */
import type { GitSha, WorkItemId } from "./brands.ts";
import type { PortResultV1 } from "./ports.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import type { RepairStateSnapshotV1 } from "./state-snapshots.ts";
import type { CandidatePreservationV1, WorkRecordV1 } from "./work-record.ts";
import type {
  CandidatePreservationRequestV1,
  MergeRequestV1,
  PrepareBaseRefreshRequestV1,
  PullRequestCreateV1,
  ReviewSubmissionV1,
} from "./ports-github-requests.ts";

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
  | "principal_unavailable"
  | "closed_publication"
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
  | "preserve_successor"
  | "publish"
  | "review"
  | "refresh"
  | "merge"
  | "enqueue";

/** Host-only App authority, bound to the actual REST/Git port and mint/execution. */
export interface TakeoverPrincipalBinding {
  repository: RepositoryIdentityV1;
  taskId: WorkItemId;
  expectedStateHead: GitSha;
  pullRequest: number;
  branch: string;
  head: GitSha;
  base: GitSha;
  operation: TakeoverOperation | "native_preserve" | "preserve_successor";
  phase: "native" | "current" | "prepare" | "preserve" | "publish";
  /** Exact prospective successor when the operation names one; otherwise null. */
  nextHead: GitSha | null;
  deadline: number;
}

/** No structural grant, login, token or environment metadata is accepted as authority. */
export interface TakeoverPrincipalAuthority {
  revalidate(binding: TakeoverPrincipalBinding): Promise<PortResultV1<void>>;
}

/** Verified by trusted producer readers, never inferred from descriptor syntax. */
export type TakeoverCandidateCustody =
  | { kind: "native" }
  | {
    kind: "implementation";
    reservationId: string;
    candidate: CandidatePreservationV1;
  }
  | {
    kind: "base_refresh";
    predecessor: GitSha;
    candidate: CandidatePreservationV1;
  };

/** Only the trusted factory can issue a recognized object; structure grants nothing. */
export interface TakeoverCustodyProof {
  readonly kind: "verified_existing_pr_custody";
}

/** Read-only native/producer custody after merge; never a merge/enqueue authority. */
export interface TakeoverPublicationProof {
  readonly kind: "verified_existing_pr_publication";
}
export interface TakeoverPublicationRequest {
  record: WorkRecordV1;
  snapshot: RepairStateSnapshotV1;
  expectedStateHead: GitSha;
  revision: GitSha;
  deadline: number;
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
  /** Refresh phases are separate authorizations; absence retains preparation compatibility. */
  phase?: "prepare" | "preserve" | "publish";
  /** Exact candidate for successor preservation or prepared refresh, never a producer assertion. */
  candidate?: CandidatePreservationV1;
  /** Actual review submission task digest; absent for read-only admission checks. */
  taskDigest?: string;
  deadline: number;
}

/** Transient only; proof recognition and exact request equality grant authority. */
export type TakeoverEffectAuthorization =
  | {
    kind?: "custody";
    proof: TakeoverCustodyProof;
    request: TakeoverProofRequest;
  }
  | {
    kind: "native_preservation";
    /** Factory-private one-use recognition, issued only inside preserveNativeHead. */
    proof: { readonly kind: "verified_native_preservation_push" };
  };

/** Derived at the concrete method boundary from its actual arguments. */
export type TakeoverEffectBoundary =
  | { kind: "push"; ref: string; head: GitSha; expectedRef: GitSha | null }
  | { kind: "review"; request: ReviewSubmissionV1 }
  | { kind: "merge"; request: MergeRequestV1 }
  | { kind: "refresh"; request: PrepareBaseRefreshRequestV1 }
  | { kind: "preserve"; request: CandidatePreservationRequestV1 }
  | { kind: "create"; request: PullRequestCreateV1 };

export interface TakeoverPreserveRequest {
  binding: TakeoverBinding;
  bindingDigest: string;
  head: GitSha;
  base: GitSha;
  ref: string;
  expectedStateHead: GitSha;
  deadline: number;
}

/** Fresh pre-intent authorization. A successful result grants only the exact intent CAS. */
export interface TakeoverAdoptionRequest {
  record: WorkRecordV1;
  snapshot: RepairStateSnapshotV1;
  expectedStateHead: GitSha;
  candidate: NativeTakeoverObservation;
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
  /** Null means unproved; native heads never pretend to have a model producer. */
  custody: TakeoverCandidateCustody | null;
  currentDescendsFromAnchor: boolean;
  nextHead: GitSha | null;
  nextDescendsFromExpected: boolean;
}

/** Optional only at composition; absence must suppress takeover effects/create fallback. */
export interface ExistingPrTakeoverPort {
  /** Source-policy routing metadata only; never principal or effect authority. */
  readonly coordinationActivated: boolean;
  resolvePublication(
    input: TakeoverPublicationRequest,
  ): Promise<PortResultV1<TakeoverPublicationProof>>;
  /** Authoritative state lookup detects omitted authorization on retained custody. */
  authorizeBoundary(
    boundary: TakeoverEffectBoundary,
    authorization?: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<void>>;
  discover(
    input: { record: WorkRecordV1; deadline: number },
  ): Promise<TakeoverDiscovery>;
  authorizeAdoption(
    input: TakeoverAdoptionRequest,
  ): Promise<PortResultV1<void>>;
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
