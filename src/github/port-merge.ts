// port merge.

import type {
  CarriedMergeV1,
  MergeOutcomeV1,
  MergeRequestV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { isGitSha } from "../contracts/brands.ts";
import type { SelfMergeExecutionV1 } from "../contracts/self-merge.ts";
import { executeSelfMerge } from "./port-self-merge.ts";
import { decideCiGate } from "../repair/loop-checks.ts";
import { tryParse } from "../contracts/validation.ts";
import {
  mergeSemanticRefusal,
  parseMergeRequestV1,
} from "../contracts/merge-request.ts";
import { carriedPatchHolds, portError, portOk } from "../contracts/ports.ts";
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
  evaluateEffectiveProtections,
  requiredChecksState,
} from "./port-merge-policy.ts";

export abstract class GitHubPortMerge extends GitHubPortReview {
  // -------------------------------------------------------------------------
  // mergePullRequest
  // -------------------------------------------------------------------------

  async mergePullRequest(
    request: MergeRequestV1,
    execution?: SelfMergeExecutionV1,
    carried?: CarriedMergeV1,
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
    // A carried merge (owner decision 2026-10-16 (2), option (b)): `merge`
    // names the REVIEWED head and base its receipt binds (strictly parsed
    // above); the pull request is merged at the refreshed head on its base,
    // and only after the patch proof below. Never a self merge.
    if (
      carried !== undefined &&
      (execution !== undefined || !isGitSha(carried.head) ||
        !isGitSha(carried.base) || carried.head === merge.expectedHead ||
        typeof carried.evidence !== "string")
    ) return portError("invalid", "merge request is malformed");
    const head = carried?.head ?? merge.expectedHead;
    const base = carried?.base ?? merge.expectedBase;
    const native = () =>
      executeSelfMerge(
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
      if (pull.value.head !== head) {
        return blocked("head_mismatch", null);
      }
      return portOk({
        outcome: "merged",
        head: pull.value.head,
        mergeSha: pull.value.mergeSha!,
      });
    }
    if (pull.value.state === "closed") {
      return blocked("conflict", pull.value.head);
    }
    if (pull.value.head !== head) {
      return blocked("head_mismatch", pull.value.head);
    }
    if (pull.value.base !== base) {
      return blocked("base_mismatch", pull.value.head);
    }
    // Never merge human-owned/unassigned target work.
    if (pull.value.author !== this.trustedPrAuthor) {
      return blocked("conflict", pull.value.head);
    }
    // 3. Re-observe the authoritative current review by exact request id; the
    // caller-supplied receipt never grants authority by itself.
    const normalizedRes = await this.currentReviewEvidence(
      merge.pullRequestNumber,
      merge,
      undefined,
      carried === undefined ? undefined : merge.expectedHead,
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
    const reviewedPull = carried === undefined
      ? pull.value
      : { ...pull.value, head: merge.expectedHead };
    if (!(await this.resolutionsTrusted(merge.review, reviewedPull))) {
      return blocked("review_required", pull.value.head);
    }
    // 4. Effective protections are the ACTIVE branch rules (branch-rules
    // response plus per-ruleset bypass policy) — classic branch protection
    // alone never proves effective server-enforced strict checks. Unreadable,
    // unsupported, merge-queue or bypassable policies block.
    const protections = await this.readEffectiveProtections(pull.value.baseRef);
    if (!protections.ok) {
      // Bounded operational diagnostic: the PR number and the typed error kind
      // only; never a message, body, URL or credential.
      console.error(JSON.stringify({
        event: "sentinel_merge_protection_unavailable",
        prNumber: merge.pullRequestNumber,
        errorKind: protections.error.kind,
      }));
      return blocked("protection_required", pull.value.head);
    }
    const protectionEvaluation = evaluateEffectiveProtections(
      protections.value,
    );
    const conditionalSelf = this.selfMergeEnabled && execution !== undefined &&
      protections.value.activeRuleTypes.length === 0 &&
      protections.value.unsupportedRuleTypes.length === 0 &&
      !protections.value.bypassUnknown &&
      protections.value.bypassActors.length === 0;
    if (!protectionEvaluation.ok && !conditionalSelf) {
      // Bounded operational diagnostic: the evaluator's own reason plus the
      // normalized protections record; never raw API bodies or messages.
      console.error(JSON.stringify({
        event: "sentinel_merge_protection_blocked",
        prNumber: merge.pullRequestNumber,
        reason: protectionEvaluation.reason,
        protections: protections.value,
      }));
      return blocked("protection_required", pull.value.head);
    }
    // 5. Required checks all passing on the exact head (a carried merge: the
    // refreshed head itself, whose CI ran on exactly the merged tree).
    const checks = await this.client.readChecks(head);
    if (!checks.ok) return blocked("protection_required", pull.value.head);
    if (checks.value.head !== head) {
      return blocked("protection_required", pull.value.head);
    }
    const checkState = requiredChecksState(
      protections.value.requiredCheckNames,
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
    if (protections.value.requiredApprovingReviewCount > 0) {
      const approval = await this.client.readPullRequestReviewDecision(
        merge.pullRequestNumber,
      );
      if (!approval.ok || approval.value !== "approved") {
        return blocked("review_required", pull.value.head);
      }
    }
    // 7. Candidate ancestry: the candidate must contain the exact integrated
    // validated base as ancestor.
    const ancestor = await this.git.isAncestor(base, head);
    if (!ancestor.ok) return ancestor;
    if (!ancestor.value) {
      return blocked("base_mismatch", pull.value.head);
    }
    // 7a. Carried merge: the refreshed head carries the reviewed patch, re-
    // proven from git at merge time (both merge-base patches byte-identical,
    // the refreshed base contained). No proof capability, a typed failure or
    // a differing patch never merges.
    if (carried !== undefined) {
      const proveRequest = {
        reviewedBase: merge.expectedBase,
        reviewedHead: merge.expectedHead,
        base,
        head,
      };
      const proof = await this.git.carriedPatchProof?.(proveRequest);
      if (proof === undefined) {
        return blocked("review_required", pull.value.head);
      }
      if (!proof.ok) return proof;
      if (!carriedPatchHolds(proveRequest, proof.value)) {
        return blocked("review_required", pull.value.head);
      }
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
    // 8. Expected-head merge. REST has no atomic base CAS: the strict
    // up-to-date protection is what rejects a base movement after this last
    // precheck; a rejection is reconciled against the re-observed PR.
    const merged = await this.client.mergePull(
      merge.pullRequestNumber,
      head,
      carried?.evidence,
    );
    if (!merged.ok) return merged;
    if (merged.value.status === "merged") {
      return portOk({
        outcome: "merged",
        head: head,
        mergeSha: merged.value.mergeSha,
      });
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
        check.value.head === head
      ) {
        return portOk({
          outcome: "merged",
          head: check.value.head,
          mergeSha: check.value.mergeSha!,
        });
      }
      return portOk({ outcome: "ambiguous", head: null, mergeSha: null });
    }
    const after = await this.client.readPullRequest(merge.pullRequestNumber);
    if (!after.ok) return after;
    if (after.value === null) return blocked("protection_required", null);
    if (after.value.state === "merged") {
      if (after.value.head !== head) {
        return blocked("head_mismatch", after.value.head);
      }
      return portOk({
        outcome: "merged",
        head: after.value.head,
        mergeSha: after.value.mergeSha!,
      });
    }
    if (after.value.state === "closed") {
      return blocked("conflict", after.value.head);
    }
    if (after.value.head !== head) {
      return blocked("head_mismatch", after.value.head);
    }
    if (after.value.base !== base) {
      return blocked("base_mismatch", after.value.head);
    }
    const checksAfter = await this.client.readChecks(head);
    if (checksAfter.ok && checksAfter.value.head === head) {
      const stateAfter = requiredChecksState(
        protections.value.requiredCheckNames,
        checksAfter.value.checks,
      );
      if (stateAfter === "pending") {
        return blocked("checks_pending", after.value.head);
      }
      if (stateAfter === "failed") {
        return blocked("checks_failed", after.value.head);
      }
    }
    return blocked("protection_required", after.value.head);
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
    const rules = await this.readEffectiveProtections("development");
    if (!rules.ok) return rules;
    if (
      rules.value.activeRuleTypes.length !== 0 ||
      rules.value.unsupportedRuleTypes.length !== 0 ||
      rules.value.bypassUnknown || rules.value.bypassActors.length !== 0
    ) {
      return portError(
        "invalid",
        "self merge requires authenticated empty rules",
      );
    }
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
