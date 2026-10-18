/** In-memory base-task review contract and references to existing native payloads. */
import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import type { ReviewTaskStatementV1 } from "../contracts/review-receipt.ts";
import { expectRestrictedRef } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { ReviewResultV1 } from "./review-result-contracts.ts";

export interface BaseReviewBindingV1 {
  issueNumber: number;
  base: GitSha;
  taskDigest: string;
  admission: string;
}

export interface BaseReviewEvidenceV1 extends BaseReviewBindingV1 {
  resultComment: number;
  resultDigest: string;
  executionComment: number;
  executionDigest: string;
}

/** No durable wrapper: each referenced payload uses an existing R80 parser. */
export interface BaseTaskReviewPortV1 {
  inspect(input: {
    record: WorkRecordV1;
    deadline: number;
  }): Promise<PortResultV1<ReviewTaskStatementV1>>;
  run(input: {
    record: WorkRecordV1;
    task: ReviewTaskStatementV1;
    admission: string;
    latestStartAt: number;
    settleBy: number;
  }): Promise<PortResultV1<{ ref: string; result: ReviewResultV1 }>>;
  close(input: {
    record: WorkRecordV1;
    ref: string;
    deadline: number;
  }): Promise<PortResultV1<"closed" | "already_closed">>;
}

export function baseReviewRequestId(admission: string): string {
  return `base-review-${admission}`;
}

export function baseReviewEvidenceRef(value: BaseReviewEvidenceV1): string {
  return expectRestrictedRef(
    `artifact:base-review/${value.issueNumber}/${value.base}/${value.taskDigest}/${value.admission}/${value.resultComment}/${value.resultDigest}/${value.executionComment}/${value.executionDigest}`,
    "$.ref",
  );
}

export function parseBaseReviewEvidenceRef(
  ref: string,
): BaseReviewEvidenceV1 | null {
  const match =
    /^artifact:base-review\/([1-9][0-9]*)\/([0-9a-f]{40})\/([0-9a-f]{64})\/([0-9a-f]{64})\/([1-9][0-9]*)\/([0-9a-f]{64})\/([1-9][0-9]*)\/([0-9a-f]{64})$/
      .exec(ref);
  if (!match) return null;
  const issueNumber = Number(match[1]);
  const resultComment = Number(match[5]);
  const executionComment = Number(match[7]);
  if (
    ![issueNumber, resultComment, executionComment].every(Number.isSafeInteger)
  ) return null;
  return {
    issueNumber,
    base: match[2] as GitSha,
    taskDigest: match[3],
    admission: match[4],
    resultComment,
    resultDigest: match[6],
    executionComment,
    executionDigest: match[8],
  };
}

export function baseResultSatisfied(
  result: ReviewResultV1,
  binding: Pick<BaseReviewBindingV1, "issueNumber" | "taskDigest">,
): boolean {
  const task = result.taskAcceptance;
  return result.verdict !== "unavailable" &&
    !result.findings.some((finding) => finding.priority <= 1) &&
    task?.verdict === "already_satisfied_at_base" &&
    task.issueNumber === binding.issueNumber &&
    task.taskDigest === binding.taskDigest &&
    task.evidence.length > 0;
}
