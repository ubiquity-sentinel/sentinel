/** Trusted issue-only review and closure; no pull request capability is used. */
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import {
  type Clock,
  portError,
  portOk,
  type PortResultV1,
  type StateReadView,
} from "../contracts/ports.ts";
import {
  checkReviewTaskStatement,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { decideCiGate } from "../repair/loop-checks.ts";
import {
  baseReviewOrigin,
  noChangeIssue,
} from "../repair/base-satisfaction-marker.ts";
import type { GitHubApiClient } from "./client.ts";
import type { BaseReviewOwnerCustodyV1 } from "./base-review-owner.ts";
import {
  baseReviewCommentBody,
  baseReviewCommentPayload,
} from "./base-review-comments.ts";
import {
  baseResultSatisfied,
  baseReviewEvidenceRef,
  baseReviewRequestId,
  type BaseTaskReviewPortV1,
  parseBaseReviewEvidenceRef,
} from "./base-review-evidence.ts";
import { parseExecution, parseReadyExecution } from "./journal-metadata.ts";
import { parseReviewResultV1 } from "./review-result-parser.ts";
import type {
  CodexReviewPrepareCapabilityV1,
  GitReviewSnapshotCaptureV1,
} from "./review-transport-contracts.ts";

type Client = Pick<
  GitHubApiClient,
  | "readIssue"
  | "readRef"
  | "readBaseReviewChecks"
  | "createBaseReviewComment"
  | "readBaseReviewComment"
  | "closeIssue"
>;

export interface BaseTaskReviewOptionsV1 {
  client: Client;
  repository: RepositoryIdentityV1;
  baseBranch: string;
  publisher: string;
  clock: Clock;
  state: StateReadView;
  ownerRunId: string;
  provider: string;
  model?: string;
  snapshot: GitReviewSnapshotCaptureV1;
  reviewer: CodexReviewPrepareCapabilityV1;
  custody?: BaseReviewOwnerCustodyV1;
}

/** Fixed trusted CI names for the two owner-authorized targets. */
function requiredChecks(repository: RepositoryIdentityV1): readonly string[] {
  if (repository.owner !== "ubiquity") return [];
  if (repository.name === "sentinel") return ["test-local"];
  if (repository.name === "ai.ubq.fi") {
    return ["validate", "verify-artifact", "darwin-native", "mac-containment"];
  }
  return [];
}

export class BaseTaskReviewService implements BaseTaskReviewPortV1 {
  constructor(private readonly options: BaseTaskReviewOptionsV1) {}

  /** Admission and exact record are reread, never inherited from model input. */
  private async admitted(
    record: WorkRecordV1,
    admission: string,
    starting: boolean,
  ): Promise<boolean> {
    const read = await this.options.state.readRepair();
    if (!read.ok || read.value.status !== "found") return false;
    const current = read.value.snapshot.work.find((row) =>
      row.id === record.id
    );
    const charge = read.value.snapshot.reservations.find((row) =>
      row.id === admission
    );
    return current !== undefined &&
      canonicalStringify(current) === canonicalStringify(record) &&
      baseReviewOrigin(record, read.value.snapshot) !== null &&
      canonicalStringify(record.repository) ===
        canonicalStringify(this.options.repository) &&
      record.source.kind === "issue" && record.related.issueNumber !== null &&
      record.source.id === String(record.related.issueNumber) &&
      noChangeIssue(record) &&
      record.nextStep === "work" && record.wait?.reason === "backoff" &&
      record.wait.until === null &&
      record.intent?.kind === "issue_closure" &&
      record.intent.key.startsWith("base-review:") &&
      record.intent.expectedHead === record.target.base &&
      record.intent.observedBase === record.target.base &&
      record.intent.pr === null && record.intent.branch === null &&
      record.intent.requestId === admission &&
      charge !== undefined && charge.purpose === "review_request" &&
      charge.taskId === record.id &&
      canonicalStringify(charge.repository) ===
        canonicalStringify(record.repository) &&
      charge.head === record.target.base &&
      charge.attempt === record.counters.reviewRounds &&
      (starting
        ? charge.outcome === "reserved"
        : charge.outcome === "submitted" || charge.outcome === "ambiguous");
  }

  /** CI first, current base and live issue task, including native dependencies. */
  private async facts(
    record: WorkRecordV1,
    deadline: number,
    expectedDigest?: string,
  ): Promise<PortResultV1<{ task: ReviewTaskStatementV1; closed: boolean }>> {
    if (this.options.clock.now() >= deadline) {
      return portError("unavailable", "base review deadline reached");
    }
    const base = await this.options.client.readRef(
      `refs/heads/${this.options.baseBranch}`,
    );
    if (!base.ok) return base;
    if (base.value?.sha !== record.target.base) {
      return portError("conflict", "base review base moved");
    }
    const issue = await this.options.client.readIssue(
      record.related.issueNumber!,
    );
    if (!issue.ok) return issue;
    if (
      issue.value === null || issue.value.number !== record.related.issueNumber
    ) return portError("conflict", "base review issue unavailable");
    if (
      issue.value.labels.some((label) =>
        label.toLowerCase() === "sentinel:skip"
      ) || /^<!-- sentinel:skip -->(?:\r?\n|$)/.test(issue.value.body)
    ) return portError("conflict", "base review issue opted out");
    const relations = issue.value.relations;
    if (
      !relations || relations.openBlockers.length > 0 ||
      relations.subIssueCount > 0
    ) {
      return portError(
        "unavailable",
        "base review dependencies unavailable or open",
      );
    }
    const task = {
      issueNumber: issue.value.number,
      title: issue.value.title,
      body: issue.value.body,
      digest: await reviewTaskStatementDigest({
        issueNumber: issue.value.number,
        title: issue.value.title,
        body: issue.value.body,
      }),
    };
    const valid = await checkReviewTaskStatement(task);
    if (!valid.ok) {
      return portError("unavailable", "base review task unavailable");
    }
    if (expectedDigest !== undefined && task.digest !== expectedDigest) {
      return portError("conflict", "base review task changed");
    }
    const names = requiredChecks(this.options.repository);
    if (names.length === 0) {
      return portError(
        "unavailable",
        "base review target CI policy unavailable",
      );
    }
    const checks = await this.options.client.readBaseReviewChecks(
      record.target.base,
      names,
    );
    if (!checks.ok) return checks;
    if (
      checks.value.head !== record.target.base ||
      names.some((name) =>
        !checks.value.checks.some((check) => check.name === name)
      ) || decideCiGate(checks.value.checks) !== "proceed"
    ) return portError("unavailable", "base review CI is not green");
    if (this.options.clock.now() >= deadline) {
      return portError("unavailable", "base review deadline reached");
    }
    const finalBase = await this.options.client.readRef(
      `refs/heads/${this.options.baseBranch}`,
    );
    if (!finalBase.ok) return finalBase;
    if (finalBase.value?.sha !== record.target.base) {
      return portError("conflict", "base review base moved");
    }
    return portOk({
      task: valid.statement,
      closed: issue.value.state === "closed",
    });
  }

  async inspect(
    input: Parameters<BaseTaskReviewPortV1["inspect"]>[0],
  ): ReturnType<BaseTaskReviewPortV1["inspect"]> {
    if (!noChangeIssue(input.record)) {
      return portError(
        "invalid",
        "base review requires an issue without a candidate",
      );
    }
    const facts = await this.facts(input.record, input.deadline);
    if (!facts.ok) return facts;
    return facts.value.closed
      ? portError("conflict", "base review source already closed")
      : portOk(facts.value.task);
  }

  private async save(
    issue: number,
    payload: unknown,
  ): Promise<PortResultV1<number>> {
    const body = baseReviewCommentBody(payload);
    const created = await this.options.client.createBaseReviewComment(
      issue,
      body,
    );
    if (!created.ok) return created;
    if (
      created.value.author !== this.options.publisher ||
      created.value.body !== body
    ) return portError("unavailable", "base review comment create unproved");
    const read = await this.options.client.readBaseReviewComment(
      issue,
      created.value.id,
    );
    if (!read.ok) return read;
    if (
      read.value.id !== created.value.id ||
      read.value.author !== this.options.publisher || read.value.body !== body
    ) return portError("unavailable", "base review comment readback unproved");
    return portOk(read.value.id);
  }

  async run(
    input: Parameters<BaseTaskReviewPortV1["run"]>[0],
  ): ReturnType<BaseTaskReviewPortV1["run"]> {
    const { record, admission, latestStartAt, settleBy } = input;
    const requestId = baseReviewRequestId(admission);
    if (!record.intent?.key.endsWith(`:${input.task.digest}`)) {
      return portError("invalid", "base review task intent mismatch");
    }
    if (!await this.admitted(record, admission, true)) {
      return portError("invalid", "base review admission unavailable");
    }
    const facts = await this.facts(record, latestStartAt, input.task.digest);
    if (!facts.ok) return facts;
    if (facts.value.closed) {
      return portError("conflict", "base review source already closed");
    }
    const captured = await this.options.snapshot.capture({
      base: record.target.base,
      head: record.target.base,
    });
    if (!captured.ok) return captured;
    if (
      captured.value.base !== record.target.base ||
      captured.value.head !== record.target.base ||
      captured.value.files.length !== 0
    ) return portError("invalid", "base review snapshot is not the exact base");
    await this.options.custody?.registerBaseReview({
      repository: record.repository,
      base: record.target.base,
      taskDigest: facts.value.task.digest,
      reservationId: admission,
      requestId,
      ownerRunId: this.options.ownerRunId,
    });
    const prepared = await this.options.reviewer.prepare({
      snapshot: captured.value,
      task: facts.value.task,
      requestId,
      invocationId: requestId,
      ownerRunId: this.options.ownerRunId,
      latestStartAt,
      settleBy,
    });
    if (!prepared.ok) return prepared;
    try {
      const execution = parseExecution(prepared.value.execution, "$.execution");
      if (
        execution.invocationId !== requestId ||
        execution.ownerRunId !== this.options.ownerRunId ||
        execution.nativeReview?.mode !== "review/start"
      ) {
        return portError(
          "unavailable",
          "base review prepared identity mismatch",
        );
      }
      const running = await this.save(facts.value.task.issueNumber, execution);
      if (!running.ok) return running;
      const fresh = await this.facts(
        record,
        latestStartAt,
        facts.value.task.digest,
      );
      if (!fresh.ok) return fresh;
      if (fresh.value.closed || !await this.admitted(record, admission, true)) {
        return portError("conflict", "base review admission changed");
      }
      await this.options.custody?.armBaseReview({ requestId, execution });
      if (this.options.clock.now() >= latestStartAt) {
        return portError("unavailable", "base review start deadline reached");
      }
      const completed = await prepared.value.start();
      const closed = await prepared.value.close();
      if (!closed.settled || closed.failure !== null || closed.timedOut) {
        return portError(
          "unavailable",
          "base review native session did not settle",
        );
      }
      await this.options.custody?.settledBaseReview({ requestId });
      if (!completed.ok) return completed;
      const outcome = completed.value;
      if (
        outcome.status === "unavailable" || outcome.result === null ||
        outcome.execution === null || outcome.actual === null
      ) {
        return portError(
          "unavailable",
          "base review native result unavailable",
        );
      }
      const result = parseReviewResultV1(outcome.result);
      const ready = parseReadyExecution(outcome.execution, "$.execution");
      if (
        ready.invocationId !== requestId ||
        ready.threadId !== execution.threadId ||
        ready.ownerRunId !== this.options.ownerRunId ||
        ready.nativeReview?.mode !== "review/start" ||
        ready.actual.terminalOrigin !== "runtime" ||
        ready.actual.observedTerminalStatus !== "completed" ||
        canonicalStringify(ready.actual) !==
          canonicalStringify(outcome.actual) ||
        ready.resultId !== outcome.resultId
      ) {
        return portError(
          "unavailable",
          "base review native binding unavailable",
        );
      }
      if (this.options.clock.now() >= settleBy) {
        return portError(
          "unavailable",
          "base review settlement deadline reached",
        );
      }
      const resultComment = await this.save(
        facts.value.task.issueNumber,
        result,
      );
      if (!resultComment.ok) return resultComment;
      const executionComment = await this.save(
        facts.value.task.issueNumber,
        ready,
      );
      if (!executionComment.ok) return executionComment;
      const ref = baseReviewEvidenceRef({
        issueNumber: facts.value.task.issueNumber,
        base: record.target.base,
        taskDigest: facts.value.task.digest,
        admission,
        resultComment: resultComment.value,
        resultDigest: await canonicalStringifySha256(result),
        executionComment: executionComment.value,
        executionDigest: await canonicalStringifySha256(ready),
      });
      return portOk({ ref, result });
    } catch {
      return portError(
        "unavailable",
        "base review native evidence unavailable",
      );
    } finally {
      await prepared.value.close();
    }
  }

  async close(
    input: Parameters<BaseTaskReviewPortV1["close"]>[0],
  ): ReturnType<BaseTaskReviewPortV1["close"]> {
    const { record, ref, deadline } = input;
    const binding = parseBaseReviewEvidenceRef(ref);
    if (
      !binding || binding.issueNumber !== record.related.issueNumber ||
      binding.base !== record.target.base ||
      record.intent?.requestId !== binding.admission ||
      record.intent.resultId !== binding.resultDigest ||
      !record.intent.key.endsWith(`:${binding.taskDigest}`) ||
      !record.evidence.some((row) =>
        row.kind === "review_receipt" && row.ref === ref
      ) || !await this.admitted(record, binding.admission, false)
    ) return portError("invalid", "base closure binding unavailable");
    try {
      const resultRead = await this.options.client.readBaseReviewComment(
        binding.issueNumber,
        binding.resultComment,
      );
      if (!resultRead.ok) return resultRead;
      const executionRead = await this.options.client.readBaseReviewComment(
        binding.issueNumber,
        binding.executionComment,
      );
      if (!executionRead.ok) return executionRead;
      if (
        resultRead.value.id !== binding.resultComment ||
        executionRead.value.id !== binding.executionComment ||
        resultRead.value.author !== this.options.publisher ||
        executionRead.value.author !== this.options.publisher
      ) return portError("invalid", "base closure evidence author mismatch");
      const result = parseReviewResultV1(
        baseReviewCommentPayload(resultRead.value.body),
      );
      const execution = parseReadyExecution(
        baseReviewCommentPayload(executionRead.value.body),
        "$.execution",
      );
      if (
        await canonicalStringifySha256(result) !== binding.resultDigest ||
        await canonicalStringifySha256(execution) !== binding.executionDigest ||
        !baseResultSatisfied(result, binding) ||
        execution.invocationId !== baseReviewRequestId(binding.admission) ||
        execution.nativeReview?.mode !== "review/start" ||
        execution.actual.terminalOrigin !== "runtime" ||
        execution.actual.observedTerminalStatus !== "completed"
      ) return portError("invalid", "base closure native evidence mismatch");
      const facts = await this.facts(record, deadline, binding.taskDigest);
      if (!facts.ok) return facts;
      if (facts.value.closed) return portOk("already_closed");
      if (
        !await this.admitted(record, binding.admission, false) ||
        this.options.clock.now() >= deadline
      ) return portError("unavailable", "base closure admission changed");
      const closed = await this.options.client.closeIssue(binding.issueNumber);
      if (!closed.ok) return closed;
      const value = closed.value;
      if (
        value.number !== binding.issueNumber || value.state !== "closed" ||
        await reviewTaskStatementDigest({
            issueNumber: value.number,
            title: value.title,
            body: value.body,
          }) !== binding.taskDigest
      ) return portError("conflict", "base closure response identity changed");
      return portOk("closed");
    } catch {
      return portError("invalid", "base closure evidence unavailable");
    }
  }
}
