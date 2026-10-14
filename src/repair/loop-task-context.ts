/** Repair loop internals: task context. */
import type { GitSha } from "../contracts/brands.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import {
  checkReviewTaskStatement,
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { ensureBaseRefreshIntent } from "./loop-base-refresh.ts";
import { configFor } from "./loop-records.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  authorizingReceipt,
  MERGE_WITHOUT_REVIEW_DETAIL,
  TASK_ACCEPTANCE_CONTEXT_DETAIL,
  TASK_ACCEPTANCE_DIGEST_DETAIL,
  TASK_ACCEPTANCE_MISMATCH_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
  taskAcceptanceRefusal,
} from "./review-gate.ts";

/**
 * ONE pre-budget freshness gate for review admission.
 *
 * Returns null ONLY when: the repository/base are configured, the record holds
 * no incompatible intent, the requested PR is the record's exact open PR with
 * the exact branch/head/base refs, the ACTUAL candidate branch head is the
 * target head, a new-format record carries a preserved descriptor whose head
 * equals the published head and the target head, and the configured base ref
 * was observed successfully at the target base. Otherwise it returns an
 * explicit step result: a moved base persists the durable refresh intent (with
 * zero reservation), while a null/failed config, identity, preservation or
 * refresh capability prevents admission outright. It runs BEFORE the review
 * budget reservation; the caller rechecks the run bounds immediately after.
 */
export async function ensureReviewFreshness(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  prNumber: number,
): Promise<StepResultV1 | "closed_unmerged" | null> {
  const config = configFor(deps, record.repository);
  const head = record.target.head;
  const branch = record.target.branch;
  if (
    config === null || head === null || branch === null ||
    record.intent !== null || prNumber !== record.target.pr
  ) {
    return {
      kind: "deferred",
      detail: "review requires an exact published candidate",
    };
  }
  const candidateState = record.target.candidateState;
  if (candidateState !== undefined) {
    const preserved = candidateState.preserved;
    if (
      preserved === null || candidateState.publishedHead !== head ||
      preserved.head !== head || preserved.base !== record.target.base
    ) {
      return {
        kind: "deferred",
        detail: "review requires a preserved published candidate",
      };
    }
  }
  // The base cannot be reconciled without the trusted capability: review
  // admission is refused, never granted against an unproven base.
  if (deps.github.prepareBaseRefresh === undefined) {
    return {
      kind: "deferred",
      detail: "review requires a trusted base-refresh capability",
    };
  }
  // Actual PR observation: exact open PR, branch and head.
  const pr = await deps.github.readPullRequest(prNumber);
  if (!pr.ok) {
    return { kind: "deferred", detail: "review PR observation unavailable" };
  }
  if (
    pr.value === null ||
    pr.value.headRef !== branch ||
    pr.value.baseRef !== config.baseBranch
  ) {
    return { kind: "deferred", detail: "review PR identity mismatch" };
  }
  // The task's own pull request closed unmerged is recoverable even when its
  // frozen head predates the refreshed candidate now published on the task
  // branch: one replacement publication recovers the round, and the caller
  // retires the closed publication identity instead of refusing this review
  // forever. The identity checks above already bound the observation to this
  // task's exact branch and base; a merged close is a different disposition
  // and is never treated as recoverable here.
  if (pr.value.state === "closed") {
    return pr.value.mergeSha === null
      ? "closed_unmerged"
      : { kind: "deferred", detail: "review PR was merged" };
  }
  if (pr.value.head !== head) {
    return { kind: "deferred", detail: "review PR identity mismatch" };
  }
  // Actual candidate branch observation.
  const ref = await deps.github.readRef(`refs/heads/${branch}`);
  if (!ref.ok) {
    return { kind: "deferred", detail: "review candidate ref unavailable" };
  }
  if (ref.value === null || ref.value.sha !== head) {
    return {
      kind: "deferred",
      detail: "review candidate ref identity mismatch",
    };
  }
  // Configured current base observation. A moved base persists the durable
  // refresh intent BEFORE any reservation and returns with no review request;
  // the null result of the shared helper is trusted only because every config
  // and identity precondition above was already satisfied here.
  const base = await deps.github.readRef(`refs/heads/${config.baseBranch}`);
  if (!base.ok || base.value === null) {
    return { kind: "deferred", detail: "review base ref unavailable" };
  }
  if (base.value.sha !== record.target.base) {
    return await ensureBaseRefreshIntent(deps, context, record);
  }
  return null;
}

export async function readIssueForModel(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
): Promise<
  { number: number; title: string; body: string } | null | "unavailable"
> {
  const issueNumber = record.related.issueNumber;
  if (issueNumber === null) return null;
  const read = await deps.github.readIssue(issueNumber);
  if (!read.ok) return "unavailable";
  const issue = read.value;
  // The latest native state is authoritative: a closed issue (or one that no
  // longer exists) can never start model work, even when intake admitted it.
  if (issue === null || issue.state !== "open") return "unavailable";
  // Issue-only github-adapter intake also gates on native dependency
  // relations: unknown relations, a parent issue (sub-issues) or any open
  // native blocker defers admission. Closed blockers are already excluded by
  // the client parser; no completed WorkRecord is synthesized for them.
  const config = configFor(deps, record.repository);
  if (config?.adapter.kind === "github") {
    const relations = issue.relations;
    if (
      relations === undefined ||
      relations.subIssueCount > 0 ||
      relations.openBlockers.length > 0
    ) {
      return "unavailable";
    }
  }
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
  };
}

/**
 * One trusted read-only source-issue context: the bounded canonical statement
 * plus the native state it was read in. `read_failed` is transient; `missing`
 * (the issue no longer exists) and `malformed` (the live text cannot be
 * carried as a bounded statement) fail closed.
 */
export type IssueTaskContextV1 =
  | {
    statement: ReviewTaskStatementV1;
    state: "open" | "closed";
  }
  | null
  | "read_failed"
  | "missing"
  | "malformed";

/**
 * Read the exact live source-issue context WITHOUT requiring an open state.
 *
 * The canonical title/body (and its digest) is the criterion any acceptance
 * must be bound to. Post-merge GitHub auto-closure is expected for the
 * published "Resolves #N" link, so delivery authorization must still be able
 * to read and verify the same text after the issue is closed; only ADMISSION
 * of new review work requires the open state.
 */
export async function readIssueTaskContext(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
): Promise<IssueTaskContextV1> {
  const issueNumber = record.related.issueNumber;
  if (issueNumber === null) return null;
  const read = await deps.github.readIssue(issueNumber);
  if (!read.ok) return "read_failed";
  const issue = read.value;
  if (issue === null || issue.number !== issueNumber) return "missing";
  const text = { issueNumber, title: issue.title, body: issue.body };
  const digest = await reviewTaskStatementDigest(text);
  const checked = await checkReviewTaskStatement({ ...text, digest });
  if (!checked.ok) return "malformed";
  return {
    statement: checked.statement,
    state: issue.state === "open" ? "open" : "closed",
  };
}

/**
 * The trusted delivery authorization context: the same read-only reader, with
 * every non-readable outcome collapsed to `"unavailable"` so callers fail
 * closed without inventing a statement. `null` means work with no source task.
 */
export async function readDeliveryTaskContext(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
): Promise<ReviewTaskStatementV1 | null | "unavailable"> {
  const context = await readIssueTaskContext(deps, record);
  if (
    context === "read_failed" || context === "missing" ||
    context === "malformed"
  ) {
    return "unavailable";
  }
  return context === null ? null : context.statement;
}

/**
 * Read the exact live source-issue task statement one NEW review must judge.
 *
 * Open-only ADMISSION wrapper over the read-only context: returns the bounded
 * digest-bound statement, `null` for work with no source issue, or one static
 * state:
 * - `read_failed`: the issue read failed (transient; the request retries);
 * - `not_open`: the issue is closed or no longer exists, so no task-bound
 *   review may be requested;
 * - `malformed`: the live text cannot be carried as a bounded statement (for
 *   example an over-bound body); a truncated statement would bind the review
 *   to text nobody wrote, so this fails closed instead.
 */
export async function readReviewTaskStatement(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
): Promise<
  ReviewTaskStatementV1 | null | "read_failed" | "not_open" | "malformed"
> {
  const context = await readIssueTaskContext(deps, record);
  if (context === "read_failed") return "read_failed";
  if (context === null) return null;
  if (context === "malformed") return "malformed";
  if (context === "missing" || context.state !== "open") return "not_open";
  return context.statement;
}

/**
 * The exact review receipt one durably persisted merge intent referenced: the
 * intent records the review request id and result id that authorized the merge
 * BEFORE the mutation, so reconciliation re-binds that same evidence instead of
 * re-deriving it from PR/head alone.
 */
export function mergeIntentReceipt(
  reviews: readonly ReviewReceiptV1[],
  record: WorkRecordV1,
): ReviewReceiptV1 | null {
  const intent = record.intent;
  if (intent === null || intent.kind !== "merge") return null;
  if (intent.requestId === null || intent.resultId === null) return null;
  return reviews.find((review) =>
    review.requestId === intent.requestId &&
    review.resultId === intent.resultId
  ) ?? null;
}

/**
 * The exact review receipt one persisted release request references: BOTH the
 * durable receipt id and the review request id must match, so a different
 * completed receipt that merely shares the PR/head can never carry this
 * delivery's proof.
 */
export function releaseRequestReceipt(
  reviews: readonly ReviewReceiptV1[],
  request: ReleaseRequestV1,
): ReviewReceiptV1 | null {
  const receiptId = request.source.reviewReceiptId;
  if (receiptId === null) return null;
  return reviews.find((review) =>
    review.id === receiptId &&
    review.requestId === request.source.reviewRequestId
  ) ?? null;
}

/**
 * Re-verify one record's RECORDED delivery acceptance against the trusted
 * live source-issue context, after the merge and before any release request or
 * issue closure. The issue may already have been auto-closed by the published
 * "Resolves #N" link; the read-only reader still returns the same canonical
 * title/body digest, so a successful merge is never left unreleasable, while a
 * changed context or a non-fulfilled/already-satisfied verdict is an honest
 * no-delivery. Returns the static refusal detail, `"wait"` for a transient
 * context read failure, or null when the exact positive acceptance binds.
 *
 * `referenced` is the EXACT receipt the durable delivery reference names (the
 * merge intent's review request/result identity, or the release request's
 * persisted review receipt id). It must satisfy the shared FULL authorization
 * predicate — exact repository/base/PR/head, trusted unmodified reviewer,
 * zero uncounted findings, no unresolved P0/P1 — and the acceptance must bind
 * the trusted live text. A missing reference, a receipt that only shares
 * PR/head, or a quality-only receipt never authorizes an issue-backed
 * delivery; the specific acceptance refusal is surfaced first so the owner
 * sees why the task proof fails.
 */
export async function deliveryTaskRefusal(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  referenced: ReviewReceiptV1 | null,
): Promise<string | "wait" | null> {
  if (record.related.issueNumber === null) return null;
  const task = await readDeliveryTaskContext(deps, record);
  if (task === "unavailable") return "wait";
  if (referenced === null) return MERGE_WITHOUT_REVIEW_DETAIL;
  const semantic = taskAcceptanceRefusal(referenced, record, task);
  if (semantic !== null) return semantic;
  // The exact reference must ALSO satisfy the shared full authorization
  // predicate (exact identity, trusted reviewer, clean findings) for this same
  // task; a receipt that only shares PR/head never carries the proof.
  const authorized = authorizingReceipt(
    [referenced],
    record,
    deps.github.reviewerIdentity,
    task,
  );
  return authorized === null ? MERGE_WITHOUT_REVIEW_DETAIL : null;
}

/**
 * Durable blocker kind of one static semantic refusal: a missing/changed
 * evidence binding is `missing_evidence`; an explicit verdict that the task is
 * not (or is already) satisfied is `other`.
 */
export function semanticRefusalKind(
  detail: string,
): "missing_evidence" | "other" {
  if (
    detail === TASK_ACCEPTANCE_MISSING_DETAIL ||
    detail === TASK_ACCEPTANCE_MISMATCH_DETAIL ||
    detail === TASK_ACCEPTANCE_DIGEST_DETAIL ||
    detail === TASK_ACCEPTANCE_CONTEXT_DETAIL ||
    detail === MERGE_WITHOUT_REVIEW_DETAIL
  ) {
    return "missing_evidence";
  }
  return "other";
}

export async function readBase(
  deps: RepairCycleDepsV1,
  repository: RepositoryIdentityV1,
): Promise<GitSha | null> {
  const config = configFor(deps, repository);
  if (config === null) return null;
  const ref = await deps.github.readRef(`refs/heads/${config.baseBranch}`);
  return ref.ok && ref.value !== null ? ref.value.sha : null;
}
