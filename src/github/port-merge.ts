// port merge.

import type {
  MergeOutcomeV1,
  MergeRequestV1,
  PortResultV1,
} from "../contracts/ports.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { SelfMergeExecutionV1 } from "../contracts/self-merge.ts";
import {
  mergedExactlyOnBase,
  queueMayHaveMerged,
} from "../repair/merge-off-tip.ts";
import type { GitHubEffectiveProtectionsV1 } from "./port-contracts.ts";
import type { TakeoverEffectAuthorization } from "../contracts/existing-pr-takeover.ts";
import { executeSelfMerge } from "./port-self-merge.ts";
import { decideCiGate } from "../repair/loop-checks.ts";
import { tryParse } from "../contracts/validation.ts";
import {
  mergeSemanticRefusal,
  parseMergeRequestV1,
} from "../contracts/merge-request.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { completedReviewMatchesReceipt } from "./review-normalize.ts";
import {
  checkReviewTaskStatement,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../contracts/review-receipt.ts";
import { GitHubPortReview } from "./port-review.ts";
import {
  blocked,
  closingIssueNumber,
  noEffectiveProtections,
  requiredChecksState,
} from "./port-merge-policy.ts";

export abstract class GitHubPortMerge extends GitHubPortReview {
  // -------------------------------------------------------------------------
  // mergePullRequest
  // -------------------------------------------------------------------------

  async mergePullRequest(
    request: MergeRequestV1,
    execution?: SelfMergeExecutionV1,
    takeover?: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<MergeOutcomeV1>> {
    // 1. Strict parse against the trusted adapter policy: the request can
    // never name another repository or select the trusted reviewer.
    const parsed = tryParse(
      (value: unknown) =>
        parseMergeRequestV1(value, {
          repository: this.repository,
          expectedReviewer: this.trustedReviewer,
        }),
      request,
    );
    if (!parsed.ok) {
      return portError("invalid", "merge request is malformed");
    }
    const merge = parsed.value;
    const queueInput = {
      operation: "merge" as const,
      pullRequest: merge.pullRequestNumber,
      expectedHead: merge.expectedHead,
    };
    const queued = await this.queueEffect(queueInput);
    if (!queued.ok) return queued;
    if (
      takeover !== undefined && this.repository.owner === "ubiquity-sentinel" &&
      this.repository.name === "sentinel"
    ) {
      return portError("unavailable", "existing PR self merge requires owner");
    }
    const native = async () => {
      const custody = await this.takeoverEffect({
        kind: "merge",
        request: merge,
      }, takeover);
      if (!custody.ok) return custody;
      return await executeSelfMerge(
        {
          client: this.client,
          git: this.git,
          clock: this.clock,
          author: this.trustedPrAuthor,
          gated: (call) => this.gatedRemoteCall(call),
          authorize: (applied) =>
            this.authorizeSelfMerge(merge, execution!, applied),
        },
        merge,
        execution,
      );
    };
    if (
      this.selfMergeEnabled && execution?.proof !== null &&
      execution?.proof !== undefined
    ) return native();
    // 2. Current authoritative PR and exact identities.
    const pull = await this.client.readPullRequest(merge.pullRequestNumber);
    if (!pull.ok) return pull;
    if (pull.value === null) {
      return portError("not_found", "pull request not found");
    }
    if (pull.value.state === "merged") {
      if (pull.value.head !== merge.expectedHead) {
        return blocked("head_mismatch", null);
      }
      const afterQueue = await this.queueEffect(queueInput);
      if (!afterQueue.ok) return afterQueue;
      const custody = await this.takeoverEffect({
        kind: "merge",
        request: merge,
      }, takeover);
      if (!custody.ok) return custody;
      return await this.landedMerge(merge, pull.value.mergeSha!, true);
    }
    if (pull.value.state === "closed") {
      return blocked("conflict", pull.value.head);
    }
    if (pull.value.head !== merge.expectedHead) {
      return blocked("head_mismatch", pull.value.head);
    }
    if (pull.value.base !== merge.expectedBase) {
      return blocked("base_mismatch", pull.value.head);
    }
    // Never merge human-owned/unassigned target work.
    if (pull.value.author !== this.trustedPrAuthor && takeover === undefined) {
      return blocked("conflict", pull.value.head);
    }
    // 3. Re-observe the authoritative current review by exact request id; the
    // caller-supplied receipt never grants authority by itself.
    const normalizedRes = await this.currentReviewEvidence(
      merge.pullRequestNumber,
      merge,
    );
    if (!normalizedRes.ok) {
      // The existing error object is returned as-is: rate-limit metadata
      // must survive every reconstruction.
      return { ok: false, error: normalizedRes.error };
    }
    const normalized = normalizedRes.normalized;
    if (normalized === null) {
      return blocked("review_required", pull.value.head);
    }
    if (!completedReviewMatchesReceipt(normalized, merge.review)) {
      return blocked("review_required", pull.value.head);
    }
    // Human resolution authorization: a trusted authenticated resolver must
    // prove each resolved finding's immutable reference against the exact
    // repo/PR/head/fingerprint/author; a caller-supplied resolved:true with an
    // allowlisted author name is never authentication by itself.
    if (!(await this.resolutionsTrusted(merge.review, pull.value))) {
      return blocked("review_required", pull.value.head);
    }
    // 4. Branch protections are NOT a merge requirement (owner directive
    // 2026-10-24: the only internal policy is that every P0 is resolved). The
    // active branch rules are still read so that required checks and approvals
    // a target does configure are honoured; an unreadable, empty, unsupported
    // or bypassable policy is treated as no protections and never blocks.
    const protectionsRead = await this.readEffectiveProtections(
      pull.value.baseRef,
    );
    if (!protectionsRead.ok) {
      // Bounded operational diagnostic: the PR number and the typed error kind
      // only; never a message, body, URL or credential.
      console.error(JSON.stringify({
        event: "sentinel_merge_protection_unavailable",
        prNumber: merge.pullRequestNumber,
        errorKind: protectionsRead.error.kind,
      }));
    }
    const protections: GitHubEffectiveProtectionsV1 = protectionsRead.ok
      ? protectionsRead.value
      : noEffectiveProtections(pull.value.baseRef);
    const conditionalSelf = this.selfMergeEnabled && execution !== undefined;
    // 5. The checks the target's own rules require must pass on the exact
    // head (none required when the target has no rules); every check that
    // ran is additionally judged by the CI gate below through `decideCiGate`
    // in the self path and by the launcher for foreign targets.
    const checks = await this.client.readChecks(merge.expectedHead);
    if (!checks.ok) return blocked("checks_pending", pull.value.head);
    if (checks.value.head !== merge.expectedHead) {
      return blocked("checks_pending", pull.value.head);
    }
    const checkState = requiredChecksState(
      protections.requiredCheckNames,
      checks.value.checks,
    );
    if (checkState === "pending") {
      return blocked("checks_pending", pull.value.head);
    }
    if (checkState === "failed") {
      return blocked("checks_failed", pull.value.head);
    }
    // 6. Required GitHub approvals (distinct from the review receipt). The
    // REST pull response does not carry the authoritative approval state;
    // read the exact GraphQL field only when branch policy requires it.
    if (protections.requiredApprovingReviewCount > 0) {
      const approval = await this.client.readPullRequestReviewDecision(
        merge.pullRequestNumber,
      );
      if (!approval.ok || approval.value !== "approved") {
        return blocked("review_required", pull.value.head);
      }
    }
    // 7. Candidate ancestry: the candidate must contain the exact integrated
    // validated base as ancestor.
    const ancestor = await this.git.isAncestor(
      merge.expectedBase,
      merge.expectedHead,
    );
    if (!ancestor.ok) return ancestor;
    if (!ancestor.value) {
      return blocked("base_mismatch", pull.value.head);
    }
    // 7b. Semantic task authorization, immediately before the merge mutation.
    // A receipt copy is never fulfillment evidence: the adapter independently
    // reads the live source issue named by the PR's OWN published closing link
    // ("Resolves #N"), rebuilds the bounded canonical statement and requires
    // the receipt's acceptance to be the same positive, exactly bound verdict.
    // An acceptance present without a closing link is verified against its own
    // issue number; incident PRs (no link, no acceptance) keep the change-only
    // contract. A transient issue read failure is a retryable typed error
    // (never a merge); a missing/malformed context or any semantic refusal is
    // a typed refusal.
    const closingIssue = closingIssueNumber(pull.value.body);
    const acceptance = merge.review.taskAcceptance;
    const contextIssueNumber = closingIssue ?? acceptance?.issueNumber ?? null;
    let semanticTask: ReviewTaskStatementV1 | null | "unavailable" = null;
    if (contextIssueNumber !== null) {
      const issue = await this.client.readIssue(contextIssueNumber);
      if (!issue.ok) return issue;
      if (issue.value === null || issue.value.number !== contextIssueNumber) {
        return blocked("review_required", pull.value.head);
      }
      const text = {
        issueNumber: contextIssueNumber,
        title: issue.value.title,
        body: issue.value.body,
      };
      const checked = await checkReviewTaskStatement({
        ...text,
        digest: await reviewTaskStatementDigest(text),
      });
      semanticTask = checked.ok ? checked.statement : "unavailable";
    }
    if (
      mergeSemanticRefusal(merge, {
        issueNumber: contextIssueNumber,
        task: semanticTask,
      }) !== null
    ) {
      return blocked("review_required", pull.value.head);
    }
    if (conditionalSelf) return native();
    // 8. Expected-head merge with a base compare-and-swap. GitHub's merge API
    // guards only the head, the pull request's reported base is not updated
    // when the base branch moves, and branch rules no longer gate a merge
    // (owner directive 2026-10-24): nothing else refuses a base that moved
    // after the review (live: Passport PRs 154 and 171 merged off their
    // reviewed bases). The base branch tip is re-read, uncached, as the last
    // read before the merge call and must still be the reviewed base; the
    // merge commit's parents are then proven below. A rejection is reconciled
    // against the re-observed PR.
    const beforeMerge = await this.queueEffect(queueInput);
    if (!beforeMerge.ok) return beforeMerge;
    const custody = await this.takeoverEffect(
      { kind: "merge", request: merge },
      takeover,
    );
    if (!custody.ok) return custody;
    const tip = await this.client.readRef(`refs/heads/${pull.value.baseRef}`);
    if (!tip.ok) return tip;
    if (tip.value === null || tip.value.sha !== merge.expectedBase) {
      return blocked("base_mismatch", pull.value.head);
    }
    const merged = await this.client.mergePull(
      merge.pullRequestNumber,
      merge.expectedHead,
    );
    if (!merged.ok) return merged;
    if (merged.value.status === "merged") {
      const afterQueue = await this.queueEffect(queueInput);
      if (!afterQueue.ok) return afterQueue;
      return await this.landedMerge(merge, merged.value.mergeSha, false);
    }
    if (merged.value.status === "ambiguous") {
      // The merge response was lost; report ambiguous unless the exact PR
      // proves the merge happened. Never a blind retry, and never pretend
      // "no effect": when the reconcile observation itself is unavailable the
      // effect stays ambiguous.
      const check = await this.client.readPullRequest(merge.pullRequestNumber);
      if (!check.ok) {
        return portOk({ outcome: "ambiguous", head: null, mergeSha: null });
      }
      if (
        check.value !== null && check.value.state === "merged" &&
        check.value.head === merge.expectedHead
      ) {
        const afterQueue = await this.queueEffect(queueInput);
        if (!afterQueue.ok) return afterQueue;
        return await this.landedMerge(merge, check.value.mergeSha!, false);
      }
      return portOk({ outcome: "ambiguous", head: null, mergeSha: null });
    }
    const after = await this.client.readPullRequest(merge.pullRequestNumber);
    if (!after.ok) return after;
    if (after.value === null) return blocked("conflict", null);
    if (after.value.state === "merged") {
      if (after.value.head !== merge.expectedHead) {
        return blocked("head_mismatch", after.value.head);
      }
      const afterQueue = await this.queueEffect(queueInput);
      if (!afterQueue.ok) return afterQueue;
      return await this.landedMerge(merge, after.value.mergeSha!, true);
    }
    if (after.value.state === "closed") {
      return blocked("conflict", after.value.head);
    }
    if (after.value.head !== merge.expectedHead) {
      return blocked("head_mismatch", after.value.head);
    }
    if (after.value.base !== merge.expectedBase) {
      return blocked("base_mismatch", after.value.head);
    }
    const checksAfter = await this.client.readChecks(merge.expectedHead);
    if (checksAfter.ok && checksAfter.value.head === merge.expectedHead) {
      const stateAfter = requiredChecksState(
        protections.requiredCheckNames,
        checksAfter.value.checks,
      );
      if (stateAfter === "pending") {
        return blocked("checks_pending", after.value.head);
      }
      if (stateAfter === "failed") {
        return blocked("checks_failed", after.value.head);
      }
    }
    // A rejection no readable rule, check or review explains: report it as a
    // conflict with the live pull request, never as a missing protection.
    return blocked("conflict", after.value.head);
  }

  /**
   * The bookable outcome of one merge commit: `merged` only when its parents
   * are exactly [reviewed base, reviewed head] (the REST merge makes a merge
   * commit, so that is the tree the review and CI saw), `merged_off_tip`
   * otherwise, and `ambiguous` when the commit cannot be read (the next run
   * reconciles; never booked unproven). `observed` marks a merge this call did
   * not make: one the native queue may have made (`queueMayHaveMerged`) has
   * the queue's parents and keeps its own proof, so it is left as before.
   */
  private async landedMerge(
    merge: MergeRequestV1,
    mergeSha: GitSha,
    observed: boolean,
  ): Promise<PortResultV1<MergeOutcomeV1>> {
    const head = merge.expectedHead;
    if (observed && queueMayHaveMerged(this.repository)) {
      return portOk({ outcome: "merged", head, mergeSha });
    }
    const parents = await this.client.readCommitParents(mergeSha);
    if (!parents.ok || parents.value === null) {
      return portOk({ outcome: "ambiguous", head, mergeSha });
    }
    return portOk(
      mergedExactlyOnBase(parents.value, merge.expectedBase, head)
        ? { outcome: "merged", head, mergeSha }
        : { outcome: "merged_off_tip", head, mergeSha, parents: parents.value },
    );
  }

  private async authorizeSelfMerge(
    merge: MergeRequestV1,
    context: SelfMergeExecutionV1,
    applied: boolean,
  ): Promise<PortResultV1<void>> {
    if (this.clock.now() >= context.deadline) {
      return portError("unavailable", "self merge deadline reached");
    }
    const pull = await this.client.readPullRequest(merge.pullRequestNumber);
    if (!pull.ok) return pull;
    if (
      pull.value === null || pull.value.head !== merge.expectedHead ||
      pull.value.headRef !== context.headRef ||
      pull.value.author !== this.trustedPrAuthor ||
      pull.value.baseRef !== "development" ||
      pull.value.body !== `Resolves #${context.issueNumber}` ||
      (!applied &&
        (pull.value.state !== "open" || pull.value.base !== merge.expectedBase))
    ) return portError("conflict", "self merge current PR identity mismatch");
    // Branch rules are not a merge requirement (owner directive 2026-10-24);
    // the self path needs the exact PR identity, the current native review,
    // green current-head CI and the live task acceptance below.
    const observed = await this.currentReviewEvidence(
      merge.pullRequestNumber,
      merge,
      applied ? merge.expectedBase : undefined,
    );
    if (!observed.ok) return observed;
    if (
      observed.normalized === null ||
      !completedReviewMatchesReceipt(observed.normalized, merge.review) ||
      !(await this.resolutionsTrusted(merge.review, pull.value))
    ) {
      return portError(
        "invalid",
        "self merge current native review unavailable",
      );
    }
    const checks = await this.client.readChecks(merge.expectedHead);
    if (!checks.ok) return checks;
    if (
      checks.value.head !== merge.expectedHead ||
      decideCiGate(checks.value.checks) !== "proceed"
    ) return portError("unavailable", "self merge current CI unavailable");
    const issue = await this.client.readIssue(context.issueNumber!);
    if (!issue.ok) return issue;
    if (issue.value === null || issue.value.number !== context.issueNumber) {
      return portError("invalid", "self merge task unavailable");
    }
    const text = {
      issueNumber: issue.value.number,
      title: issue.value.title,
      body: issue.value.body,
    };
    const task = await checkReviewTaskStatement({
      ...text,
      digest: await reviewTaskStatementDigest(text),
    });
    if (
      !task.ok ||
      mergeSemanticRefusal(merge, {
          issueNumber: issue.value.number,
          task: task.statement,
        }) !== null
    ) {
      return portError(
        "invalid",
        "self merge current task acceptance mismatch",
      );
    }
    return portOk(undefined);
  }
}
