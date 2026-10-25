import type { GitSha, WorkItemId } from "./brands.ts";
import type { SelfMergeProofV1 } from "./self-merge.ts";
import type {
  ReviewFindingV1,
  ReviewReceiptV1,
  ReviewStatusV1,
  ReviewTaskAcceptanceV1,
  ReviewTaskStatementV1,
} from "./review-receipt.ts";
import type { CandidatePreservationV1, WorkRecordV1 } from "./work-record.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import type { WriteOutcomeV1 } from "./ports.ts";

/**
 * Native GitHub issue dependency metadata as observed at read time.
 *
 * `openBlockers` contains only blockers whose native state is currently open
 * (closed blockers are excluded because closed native state is authoritative
 * for the dependency) and retains cross-repository blockers: an open blocker
 * in another repository still blocks this issue. `subIssueCount` is the total
 * native sub-issue count, not a page slice.
 */
export interface GitHubIssueRelationsV1 {
  openBlockers: {
    owner: string;
    name: string;
    number: number;
  }[];
  subIssueCount: number;
}

export interface GitHubIssueV1 {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  author: string | null;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  /**
   * Native dependency relations. Absence means unknown, NOT empty: a caller
   * that requires dependency gating must treat a missing value as a source
   * failure rather than an unblocked issue.
   */
  relations?: GitHubIssueRelationsV1;
}

export interface GitHubPullRequestV1 {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed" | "merged";
  head: GitSha;
  base: GitSha;
  /** Delivered merge SHA; temporary unmerged test-merge SHAs are discarded. */
  mergeSha: GitSha | null;
  headRef: string;
  baseRef: string;
  author: string | null;
  createdAt: number;
  updatedAt: number;
  mergedAt: number | null;
  reviewDecision: GitHubReviewDecisionV1;
}

export type GitHubReviewDecisionV1 =
  | "approved"
  | "changes_requested"
  | "review_required"
  | "none";

export interface GitHubCheckV1 {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion:
    | "success"
    | "failure"
    | "cancelled"
    | "skipped"
    | "timed_out"
    | "neutral"
    | "action_required"
    | null;
  head: GitSha;
  startedAt: number | null;
  completedAt: number | null;
}

export interface GitHubChecksV1 {
  head: GitSha;
  /** Empty means no checks recorded — a real state, distinct from unavailable. */
  checks: GitHubCheckV1[];
}

/**
 * The check runs of one commit reduced to what the required-CI coverage rule
 * reads of a base (`missingExpectedChecks`): each run's name and the check
 * suite GitHub reports it in (`check_suite.id`, one per workflow run for
 * GitHub Actions; null when absent). Never a CI verdict, never persisted.
 */
export interface GitHubCheckSuitesV1 {
  head: GitSha;
  checks: { name: string; suite: number | null }[];
}

export interface GitHubBranchProtectionsV1 {
  branch: string;
  protected: boolean;
  requiredStatusChecks: string[];
  requiredApprovingReviewCount: number;
  requireBranchUpToDate: boolean;
  enforceAdmins: boolean;
}

export interface GitHubRefV1 {
  ref: string;
  sha: GitSha;
}

/**
 * Trusted deterministic candidate-base integration request.
 *
 * `expectedHead`/`previousBase` are the exact durable candidate bindings that
 * still stand while the refreshed candidate is being prepared (`target` is
 * never advanced before the external publication succeeded); `expectedBase` is
 * the exact current configured base the candidate must be integrated with.
 * `preparedHead` is present ONLY on recovery of an already persisted intent:
 * the remote head may then already be that exact deterministic commit, and a
 * regenerated commit must be byte-identical to it.
 */
export interface PrepareBaseRefreshRequestV1 {
  pullRequestNumber: number;
  /** Exact deterministic candidate branch the trusted PR must carry. */
  branch: string;
  /** Exact candidate head the prepared commit must contain as first parent. */
  expectedHead: GitSha;
  /** Candidate base the durable record still points at (restore binding). */
  previousBase: GitSha;
  /** Exact current configured base the prepared commit must contain. */
  expectedBase: GitSha;
  /** Exact previously persisted prepared commit; recovery only. */
  preparedHead?: GitSha;
}

/**
 * One carried-review patch proof request (owner decision 2026-10-16 (2),
 * option (b)): the reviewed identity (`reviewedHead` on `reviewedBase`) whose
 * completed review authorized the merge, and the mechanically refreshed
 * identity (`head` on `base`) that would carry that authorization.
 */
export interface CarriedPatchRequestV1 {
  reviewedBase: GitSha;
  reviewedHead: GitSha;
  base: GitSha;
  head: GitSha;
}

/**
 * The patch proof, derived from git: each side's unique merge base and the
 * SHA-256 (lowercase hex) of the exact bytes of its merge-base raw listing
 * (`git diff --raw --no-abbrev -z --no-renames <merge base> <head>`) and patch
 * (`git diff --binary --full-index --no-renames <merge base> <head>`), every
 * rendering option fixed. The listing names both modes and full blob ids of
 * every changed path (a mode-only change has no index line in the patch,
 * #156), so equal digests mean equal contents, modes, renames (as delete and
 * add) and binary payloads. It authorizes nothing by itself
 * (`carriedPatchHolds`).
 */
export interface CarriedPatchProofV1 {
  reviewedMergeBase: GitSha;
  reviewedPatch: string;
  refreshedMergeBase: GitSha;
  refreshedPatch: string;
  /**
   * The refreshed head's first parent: the head the deterministic refresh
   * merged the tip into (null for a root commit). A pull request still
   * reporting it lags the push; any other head is foreign.
   */
  refreshedFrom: GitSha | null;
  /**
   * Commits on the refreshed head's first-parent chain back to the reviewed
   * head (`git rev-list --first-parent --count reviewed..refreshed`): the
   * mechanical refreshes the reviewed patch was carried through. It bounds
   * them across base moves with no state field (each refresh commit's first
   * parent is the head it refreshed).
   */
  refreshes: number;
}

/**
 * True exactly when the refreshed head carries the reviewed patch: both
 * digests are equal and the refreshed head contains the refreshed base (its
 * merge base is that base), so merging it onto that base yields its own,
 * CI-tested tree.
 */
export function carriedPatchHolds(
  request: CarriedPatchRequestV1,
  proof: CarriedPatchProofV1,
): boolean {
  return /^[0-9a-f]{64}$/.test(proof.reviewedPatch) &&
    proof.reviewedPatch === proof.refreshedPatch &&
    proof.refreshedMergeBase === request.base &&
    request.head !== request.reviewedHead;
}

/**
 * Bounded static detail of a KNOWN deterministic integration conflict (the
 * two exact commits cannot be merged). It is the only base-refresh failure
 * that is a durable blocker; every other failure (identity mismatch, moved
 * base, bounds, missing object) keeps the intent and waits bounded.
 */
export const BASE_REFRESH_CONFLICT_DETAIL = "base refresh contains conflicts";

export interface PullRequestCreateV1 {
  title: string;
  headRef: string;
  baseRef: string;
  body: string;
  /**
   * Base head the trusted caller observed as the integration precondition.
   * GitHub REST has no atomic base CAS: this is not an in-API guarantee
   * against base movement — the precondition is re-observed both before and
   * after publication, and the final merge rechecks the current base/head
   * against effective strict protections. A created PR after an ambiguous
   * response stays reconcilable and can never merge without exact current
   * validation.
   */
  expectedBase: GitSha;
  /** Expected head of the new branch; null means the branch must not exist. */
  expectedHeadRef: GitSha | null;
}

export interface PullRequestPublishV1 {
  outcome: WriteOutcomeV1;
  number: number | null;
  head: GitSha | null;
}

/**
 * Review submission carries the exact PR/head/base identity plus a
 * deterministic operation key, so recovery works even when the request
 * response (and its request id) is lost. `latestStartAt` is the last absolute
 * instant at which the single model start may be admitted and `settleBy` the
 * absolute instant by which the whole review (including interrupt and close)
 * must settle; both are bounded by the original run's model cutoff and the
 * loop deadline minus the full review bound and finalization margin.
 */
export interface ReviewSubmissionV1 {
  prNumber: number;
  expectedHead: GitSha;
  expectedBase: GitSha;
  expectedReviewer: string;
  operationKey: string;
  latestStartAt: number;
  settleBy: number;
  /**
   * Exact source-issue task statement the independent review must judge the
   * candidate against, or null for work with no issue acceptance. It is
   * bounded, digested and treated as untrusted data by the reviewer. Optional
   * so existing change-only callers stay valid; the production repair loop
   * always supplies the live issue statement, and a missing statement can
   * never authorize an issue-backed delivery.
   */
  task?: ReviewTaskStatementV1 | null;
}

export interface ReviewRequestOutcomeV1 {
  outcome: WriteOutcomeV1;
  requestId: string | null;
  requestedAt: number;
}

// ---------------------------------------------------------------------------
// Review drain: bounded lifecycle finalization of every owned review
// operation. A `ready` durable journal awaiting publication is
// restart-recoverable; an operation whose owned producer process was not
// proved settled, or whose durable fault is sanitized below, is faulted.
// ---------------------------------------------------------------------------

export type ReviewDrainOutcomeV1 = "settled" | "recoverable" | "faulted";

export interface ReviewDrainOperationV1 {
  operationKey: string;
  outcome: ReviewDrainOutcomeV1;
  /** True when no owned producer process for this operation remains live. */
  processSettled: boolean;
  /** True when a durable ready journal records the operation's result. */
  durable: boolean;
  /** Journalled lifecycle phase observed at drain time. */
  phase: "none" | "intent" | "running" | "ready" | "published";
  /** Static sanitized fault code; null unless the outcome is faulted. */
  fault: string | null;
}

export interface ReviewDrainReportV1 {
  /** True only when no owned operation is faulted. */
  ok: boolean;
  operations: ReviewDrainOperationV1[];
  /** Bounded static sanitized fault codes (never raw transport detail). */
  faults: string[];
  /** Absolute deadline the drain was bounded by. */
  deadline: number;
  interrupted: boolean;
  completedAt: number;
}

export interface ReviewDrainRequestV1 {
  /** Absolute deadline; the drain never exceeds it. */
  deadline: number;
  /** Interrupt owned producer sessions that are still running. */
  interrupt: boolean;
}

/** Review observation is addressed by operation key + PR/head, never by id alone. */
export interface ReviewObservationRequestV1 {
  operationKey: string;
  prNumber: number;
  head: GitSha;
}

export interface ReviewObservationV1 {
  status: ReviewStatusV1;
  requestId: string;
  /** Actual reviewer identity observed; binds the receipt to who reviewed. */
  reviewer: string | null;
  resultId: string | null;
  completedAt: number | null;
  observedHead: GitSha | null;
  observedBase: GitSha | null;
  /** Full findings exactly as delivered; never trimmed. */
  findings: ReviewFindingV1[];
  summary: string | null;
  /**
   * The reviewer's positive task acceptance, bound to the exact task
   * statement the review was requested with; null for a change-only or legacy
   * observation, which never authorizes an issue-backed delivery.
   */
  taskAcceptance: ReviewTaskAcceptanceV1 | null;
  /** When the observation was made; completion is never inferred later. */
  receivedAt: number;
}

export type MergeOutcomeV1 =
  | {
    outcome: "merged";
    head: GitSha;
    mergeSha: GitSha;
    selfMerge?: SelfMergeProofV1;
  }
  | { outcome: "ambiguous"; head: GitSha | null; mergeSha: GitSha | null }
  /**
   * The pull request merged, but its merge commit's parents are not exactly
   * [the reviewed base, the reviewed head]: the merged tree is one no CI ran
   * on. Never booked as a delivery; the loop parks the record.
   */
  | {
    outcome: "merged_off_tip";
    head: GitSha;
    mergeSha: GitSha;
    parents: GitSha[];
  }
  | {
    outcome: "blocked";
    reason:
      | "conflict"
      | "checks_pending"
      | "checks_failed"
      | "protection_required"
      | "head_mismatch"
      | "base_mismatch"
      | "review_required";
    head: GitSha | null;
  };

/**
 * Exact-identity merge authorization, trusted-controller-only. The request
 * carries the PR number, the exact head, the exact integrated validated base
 * and a completed ReviewReceiptV1 binding the same PR/head/base.
 *
 * REST has no atomic base CAS: `expectedBase` is a precondition the adapter
 * re-validates immediately before an expected-head merge, not an API
 * guarantee. Branch rules are not a merge requirement (owner directive
 * 2026-10-24), so the adapter re-reads the base branch tip as the last read
 * before the merge call and refuses (base_mismatch) unless it is exactly
 * `expectedBase`; candidate ancestry containing `expectedBase` is required,
 * and a merge whose commit's parents are not exactly [`expectedBase`,
 * `expectedHead`] is reported `merged_off_tip`, never `merged`. The review
 * receipt is identity/cleanliness evidence only — it is never current CI,
 * protection or authenticity evidence, so the adapter must re-observe the
 * authoritative review by exact identifiers and verify trusted resolution
 * authorization and repository/reviewer binding against its configuration
 * before merging; a caller-supplied receipt never grants authority.
 */
export interface MergeRequestV1 {
  pullRequestNumber: number;
  /** Exact head required; a mismatch must fail closed, never merge stale work. */
  expectedHead: GitSha;
  /** Exact integrated validated base the candidate must contain as ancestor. */
  expectedBase: GitSha;
  /** Completed review receipt; no unresolved P0/P1, zero uncounted findings. */
  review: ReviewReceiptV1;
}

export type IssueCloseOutcomeV1 = "closed" | "already_closed";

export interface AlreadySatisfiedClosureRequestV1 {
  record: WorkRecordV1;
  review: ReviewReceiptV1;
  deadline: number;
}

/**
 * Trusted candidate-preservation request.
 *
 * `candidate` is the exact operation-bound descriptor the trusted host derived
 * from durable state: its `base`/`head` are the exact candidate commits, its
 * `operationKey` is the producing operation identity and its `ref` is the
 * deterministic create-only destination derived from repository/task/operation.
 * `publishedHead` is the exact previously verified task-branch head, or null.
 * The repository identity is fixed by the port instance, never by the request.
 */
export interface CandidatePreservationRequestV1 {
  taskId: WorkItemId;
  candidate: CandidatePreservationV1;
  publishedHead: GitSha | null;
}

/**
 * Transient proof of ONE exact scoped legacy candidate loss.
 *
 * It binds the durable task/repository identity, the authoritative state head
 * the proof was established at (`StateReadResultV1.head`, NEVER the snapshot's
 * prior `stateHead` — a moved state head refuses the proof) and the exact
 * commits: `lostHead` H1 was recorded as the produced candidate, `predecessor`
 * H0 is the exact task-branch/PR head that still exists, and `lostBase` B0 is
 * the original validated target base the lost candidate was produced against.
 * The proof is a runtime value only: it is never serialized into state, and it
 * does not claim global remote-object absence.
 */
export interface LegacyBaseRefreshLossProofV1 {
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  stateHead: GitSha;
  shape: "legacy_base_refresh";
  lostBase: GitSha;
  lostHead: GitSha;
  predecessorHead: GitSha;
  branch: string;
  /** Exact PR that owned the historical reviewed predecessor head. */
  pr: number;
  /** Original unprepared base-refresh intent key bound to pr/H1/observedBase. */
  intentKey: string;
  /** Deterministic id of the historical completed H0 correction review. */
  reviewId: string;
}
