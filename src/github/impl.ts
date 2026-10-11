/**
 * GitHubPort implementation (m01).
 *
 * Composition: an authenticated GitHub REST client (default HTTP path),
 * a trusted bounded Git executor (push publication + ancestry), an injected
 * review-service transport (model starts remain caller-budgeted; this module
 * only submits/observes), an injected Clock, and trusted adapter policy
 * (expected reviewer, trusted PR author, trusted human resolution authors).
 *
 * Safety invariants implemented here:
 * - Every write is exact-identity checked before and reconciled after an
 *   ambiguous response; nothing is retried blindly.
 * - Pushes are ordinary fast-forwards only, never forced; a new deterministic
 *   branch cannot overwrite an existing ref.
 * - PR creation reuses only the exact own PR; foreign/human-owned PRs block.
 * - Review completion is never inferred from silence, reactions, other bots,
 *   bare approvals or clean text without machine-verifiable terminal
 *   provenance; stale heads, wrong authors and missing findings fail closed.
 * - Merges re-observe the authoritative current PR/review/checks/protections,
 *   require the candidate to contain the exact expected base as ancestor and
 *   require effective strict server-enforced up-to-date protections with no
 *   applicable bypass; REST's non-atomic base handling is compensated by
 *   those protections plus the exact pre-merge re-observation, and a rejected
 *   merge is reconciled against the re-observed PR.
 * - Issue closure is idempotent.
 */

import type {
  AlreadySatisfiedClosureRequestV1,
  GitHubPort,
  IssueCloseOutcomeV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { tryParse } from "../contracts/validation.ts";
import { parseWorkRecordV1 } from "../contracts/work-record.ts";
import { parseReviewReceiptV1 } from "../contracts/review-receipt.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { GitHubPullRequestV1 } from "../contracts/ports.ts";
import {
  checkReviewTaskStatement,
  reviewTaskStatementDigest,
} from "../contracts/review-receipt.ts";
import { classifyReviewTerminalDisposition } from "../repair/review-gate.ts";
import { completedReviewMatchesReceipt } from "./review-normalize.ts";
import { decideCiGate } from "../repair/loop.ts";
import { GitHubPortMerge } from "./port-merge.ts";
import { closingIssueNumber } from "./port-merge-policy.ts";
import type { GitHubPortOptionsV1 } from "./port-contracts.ts";

export class GitHubPortImpl extends GitHubPortMerge implements GitHubPort {
  // -------------------------------------------------------------------------
  // closeIssue
  // -------------------------------------------------------------------------

  async closeAlreadySatisfiedTask(
    request: AlreadySatisfiedClosureRequestV1,
  ): Promise<PortResultV1<IssueCloseOutcomeV1>> {
    const parsed = tryParse(
      (value: unknown) => parseWorkRecordV1(value),
      request.record,
    );
    const parsedReview = tryParse(
      (value: unknown) => parseReviewReceiptV1(value),
      request.review,
    );
    if (
      !parsed.ok || !parsedReview.ok || !Number.isSafeInteger(request.deadline)
    ) {
      return portError(
        "invalid",
        "already-satisfied closure request is malformed",
      );
    }
    const record = parsed.value;
    const review = parsedReview.value;
    const intent = record.intent;
    const { pr, head, base, branch } = record.target;
    const issueNumber = record.related.issueNumber;
    if (
      record.repository.owner !== this.repository.owner ||
      record.repository.name !== this.repository.name ||
      record.repository.installationId !== this.repository.installationId ||
      record.nextStep !== "delivery" ||
      intent?.kind !== "already_satisfied_closure" || issueNumber === null ||
      pr === null || head === null || branch === null ||
      intent.requestId !== review.requestId ||
      intent.resultId !== review.resultId
    ) {
      return portError(
        "invalid",
        "already-satisfied closure identity mismatch",
      );
    }
    const verify = async (): Promise<PortResultV1<GitHubPullRequestV1>> => {
      if (this.clock.now() >= request.deadline) {
        return portError(
          "unavailable",
          "already-satisfied closure deadline reached",
        );
      }
      const pull = await this.client.readPullRequest(pr);
      if (!pull.ok) return pull;
      if (
        pull.value === null || pull.value.number !== pr ||
        pull.value.head !== head || pull.value.base !== base ||
        pull.value.headRef !== branch ||
        pull.value.author !== this.trustedPrAuthor ||
        pull.value.mergeSha !== null || pull.value.state === "merged" ||
        closingIssueNumber(pull.value.body) !== issueNumber
      ) return portError("conflict", "already-satisfied PR identity mismatch");
      const candidate = await this.client.readRef(`refs/heads/${branch}`);
      if (!candidate.ok) return candidate;
      // An own pull that is already closed unmerged is a historical
      // confirmation: the base branch legitimately advances after the pull
      // closes, and the pull object's own exact base field still binds the
      // reviewed base. Keep the strict tip equality only while the closure
      // could still mutate an open pull.
      const historical = pull.value.state === "closed" &&
        pull.value.mergeSha === null;
      if (candidate.value?.sha !== head) {
        return portError(
          "conflict",
          "already-satisfied candidate/base identity mismatch",
        );
      }
      if (!historical) {
        const currentBase = await this.client.readRef(
          `refs/heads/${pull.value.baseRef}`,
        );
        if (!currentBase.ok) return currentBase;
        if (currentBase.value?.sha !== base) {
          return portError(
            "conflict",
            "already-satisfied candidate/base identity mismatch",
          );
        }
      }
      const issue = await this.client.readIssue(issueNumber);
      if (!issue.ok) return issue;
      if (issue.value === null || issue.value.number !== issueNumber) {
        return portError(
          "conflict",
          "already-satisfied source issue unavailable",
        );
      }
      const text = {
        issueNumber,
        title: issue.value.title,
        body: issue.value.body,
      };
      const task = await checkReviewTaskStatement({
        ...text,
        digest: await reviewTaskStatementDigest(text),
      });
      if (
        !task.ok ||
        classifyReviewTerminalDisposition(
            review,
            record,
            this.trustedReviewer,
            task.statement,
          ).kind !== "qualified_already_satisfied"
      ) {
        return portError(
          "conflict",
          "already-satisfied review/task authorization refused",
        );
      }
      const currentReview = await this.currentReviewEvidence(pr, {
        expectedHead: head,
        review,
      });
      if (!currentReview.ok) return { ok: false, error: currentReview.error };
      if (
        currentReview.normalized === null ||
        !completedReviewMatchesReceipt(currentReview.normalized, review) ||
        !(await this.resolutionsTrusted(review, pull.value))
      ) {
        return portError(
          "conflict",
          "already-satisfied native review authorization refused",
        );
      }
      const checks = await this.client.readChecks(head);
      if (!checks.ok) return checks;
      if (
        checks.value.head !== head ||
        checks.value.checks.some((check) => check.head !== head) ||
        decideCiGate(checks.value.checks) !== "proceed"
      ) {
        return portError(
          "unavailable",
          "already-satisfied current CI has not passed",
        );
      }
      const ancestry = await this.git.isAncestor(base, head);
      if (!ancestry.ok) return ancestry;
      if (!ancestry.value) {
        return portError(
          "conflict",
          "already-satisfied candidate ancestry mismatch",
        );
      }
      if (this.clock.now() >= request.deadline) {
        return portError(
          "unavailable",
          "already-satisfied closure deadline reached",
        );
      }
      const immediate = await this.client.readPullRequest(pr);
      if (!immediate.ok) return immediate;
      if (
        immediate.value === null || immediate.value.head !== head ||
        immediate.value.base !== base || immediate.value.headRef !== branch ||
        immediate.value.baseRef !== pull.value.baseRef ||
        immediate.value.author !== this.trustedPrAuthor ||
        immediate.value.mergeSha !== null ||
        immediate.value.state === "merged" ||
        closingIssueNumber(immediate.value.body) !== issueNumber
      ) {
        return portError(
          "conflict",
          "already-satisfied PR changed before closure",
        );
      }
      if (this.clock.now() >= request.deadline) {
        return portError(
          "unavailable",
          "already-satisfied closure deadline reached",
        );
      }
      return portOk(immediate.value);
    };
    const before = await verify();
    if (!before.ok) return before;
    if (before.value.state === "open") {
      const closed = await this.client.closePullRequest(pr);
      if (!closed.ok) {
        const reconciled = await verify();
        if (!reconciled.ok) return reconciled;
        if (reconciled.value.state !== "closed") return closed;
      } else if (
        closed.value.state !== "closed" || closed.value.head !== head ||
        closed.value.base !== base || closed.value.mergeSha !== null
      ) {
        return portError(
          "conflict",
          "already-satisfied PR closure was not applied exactly",
        );
      }
    }
    const beforeIssue = await verify();
    if (!beforeIssue.ok) return beforeIssue;
    if (beforeIssue.value.state !== "closed") {
      return portError("conflict", "already-satisfied PR is not closed");
    }
    const issue = await this.client.readIssue(issueNumber);
    if (!issue.ok) return issue;
    if (issue.value === null || issue.value.number !== issueNumber) {
      return portError(
        "conflict",
        "already-satisfied source issue unavailable",
      );
    }
    const text = {
      issueNumber,
      title: issue.value.title,
      body: issue.value.body,
    };
    const task = await checkReviewTaskStatement({
      ...text,
      digest: await reviewTaskStatementDigest(text),
    });
    if (
      !task.ok ||
      classifyReviewTerminalDisposition(
          review,
          record,
          this.trustedReviewer,
          task.statement,
        ).kind !== "qualified_already_satisfied"
    ) {
      return portError(
        "conflict",
        "already-satisfied task changed before closure",
      );
    }
    if (issue.value.state === "closed") return portOk("already_closed");
    if (this.clock.now() >= request.deadline) {
      return portError(
        "unavailable",
        "already-satisfied closure deadline reached",
      );
    }
    const closedIssue = await this.client.closeIssue(issueNumber);
    if (!closedIssue.ok) {
      const reconciled = await this.client.readIssue(issueNumber);
      if (!reconciled.ok) return reconciled;
      if (
        reconciled.value === null || reconciled.value.state !== "closed" ||
        reconciled.value.title !== text.title ||
        reconciled.value.body !== text.body
      ) return closedIssue;
    } else if (
      closedIssue.value.number !== issueNumber ||
      closedIssue.value.state !== "closed" ||
      closedIssue.value.title !== text.title ||
      closedIssue.value.body !== text.body
    ) {
      return portError(
        "conflict",
        "already-satisfied issue closure was not applied exactly",
      );
    }
    return portOk("closed");
  }

  async closeIssue(
    issueNumber: number,
  ): Promise<PortResultV1<IssueCloseOutcomeV1>> {
    const current = await this.client.readIssue(issueNumber);
    if (!current.ok) return current;
    if (current.value === null) {
      return portError("not_found", "issue not found");
    }
    if (current.value.state === "closed") {
      return portOk("already_closed");
    }
    const closed = await this.client.closeIssue(issueNumber);
    if (!closed.ok) {
      // The patch may still have applied (lost response): reconcile.
      const after = await this.client.readIssue(issueNumber);
      if (!after.ok) return after;
      if (after.value !== null && after.value.state === "closed") {
        return portOk("closed");
      }
      return closed;
    }
    if (closed.value.state !== "closed") {
      return portError("conflict", "issue closure was not applied");
    }
    return portOk("closed");
  }

  // -------------------------------------------------------------------------
  // assignIssue
  // -------------------------------------------------------------------------

  /**
   * Assigns the trusted publication identity to the source issue. The issue
   * must exist and be open; a closed or missing issue is a typed refusal, not
   * a successful assignment. The remote call is idempotent.
   */
  async assignIssue(issueNumber: number): Promise<PortResultV1<void>> {
    const current = await this.client.readIssue(issueNumber);
    if (!current.ok) return current;
    if (current.value === null) {
      return portError("not_found", "issue not found");
    }
    if (current.value.state !== "open") {
      return portError("conflict", "issue is not open");
    }
    return await this.client.assignIssue(issueNumber, this.trustedPrAuthor);
  }
}

export function createGitHubPort(options: GitHubPortOptionsV1): GitHubPort {
  return new GitHubPortImpl(options);
}
export type { GitHubPortOptionsV1 } from "./port-contracts.ts";
export type { GitHubEffectiveProtectionsV1 } from "./port-contracts.ts";
export { evaluateEffectiveProtections } from "./port-merge-policy.ts";
export { requiredChecksState } from "./port-merge-policy.ts";
export { closingIssueNumber } from "./port-merge-policy.ts";
