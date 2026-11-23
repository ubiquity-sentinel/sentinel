/** Native review of a pinned operator job before any publication authority. */
import { isGitSha } from "../src/contracts/brands.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../src/contracts/canonical.ts";
import {
  BLOCKING_SEVERITIES,
  hasBlockingSeverity,
} from "../src/contracts/review-receipt.ts";
import {
  checkReviewTaskStatement,
  MAX_REVIEW_TASK_BODY,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../src/contracts/review-task-acceptance.ts";
import {
  CodexStructuredReviewer,
  type CodexStructuredReviewerOptionsV1,
  finalizeReviewCompletion,
  MAX_REVIEW_TOTAL_MS,
} from "../src/github/codex-reviewer.ts";
import {
  parseReadyExecution,
  type ReviewJournalReadyExecutionV1,
} from "../src/github/journal-metadata.ts";
import { prioritySeverity } from "../src/github/review-normalize.ts";
import {
  findingMessage,
  parseReviewResultV1,
  reviewResultDigest,
} from "../src/github/review-result-parser.ts";
import type { ReviewResultV1 } from "../src/github/review-result-contracts.ts";
import {
  GitReviewSnapshot,
  MAX_SNAPSHOT_TOTAL_MS,
} from "../src/github/review-snapshot.ts";
import { asRecord } from "../src/github/reviewer-support.ts";
import { resolveExecutable } from "../src/host/actions-host-io.ts";
import { codexChildEnv, ensureReviewClient } from "../src/host/local-client.ts";
import {
  ensurePrivateDir,
  joinPath,
  trustedGitPath,
} from "../src/host/local-io.ts";
import { prepareReviewCheckout } from "../src/host/local-review-checkout.ts";
import { GATEWAY_PROVIDER } from "../src/host/model-route.ts";
import { acceptanceFindingMessage } from "../src/repair/acceptance-correction.ts";
import { CodexSubprocessSession } from "../src/repair/codex-transport.ts";
import { decideReviewDisposition } from "../src/repair/review-disposition.ts";
import {
  boundedCorrectionFindings,
  MAX_CORRECTION_HISTORY_RECEIPTS,
  renderCorrectionFeedback,
} from "../src/repair/review-feedback.ts";
import type { AgentJobV1 } from "./agent-jobs-plan.ts";

// Native task acceptance requires a positive issueNumber. This is an opaque
// protocol slot in the operator-job namespace, independent of any GitHub issue.
const OPERATOR_JOB_TASK_SLOT = 1;
const REVIEW_PROFILE = "sentinel-review";
const SHA256 = /^[0-9a-f]{64}$/;
type AgentJobAtBase = AgentJobV1 & { baseSha?: string };

export interface AgentJobReviewRound {
  round: number;
  headSha: string;
  baseSha: string;
  taskDigest: string;
  disposition: "accepted" | "already_satisfied" | "correct" | "blocked";
  feedback: string;
  result: ReviewResultV1 | null;
  requestId: string;
  snapshotDigest: string | null;
  resultSha256: string | null;
  execution: ReviewJournalReadyExecutionV1 | null;
  detail: string;
}

export interface ReviewAgentJobHeadInput {
  job: AgentJobAtBase;
  runTag: string;
  sourcePath: string;
  headSha: string;
  workRoot: string;
  deadlineAtMs: number;
  round: number;
  history: readonly AgentJobReviewRound[];
  modelToken: string;
  baseUrl: string;
}

export async function agentJobTask(
  job: AgentJobAtBase,
  runTag: string,
): Promise<ReviewTaskStatementV1> {
  if (
    !isGitSha(job.baseSha) || !job.base ||
    !/^[1-9]\d*-[1-9]\d*$/.test(runTag) ||
    runTag.length > 48 || job.prompt.length > MAX_REVIEW_TASK_BODY
  ) throw new Error("operator job review task is unpinned or over bound");
  const identity = canonicalStringify({
    domain: "sentinel-operator-job-review-v1",
    id: job.id,
    repository: job.repository,
    base: job.base,
    baseSha: job.baseSha,
    runTag,
  });
  const statement = {
    issueNumber: OPERATOR_JOB_TASK_SLOT,
    title: `Operator job (issueNumber is a protocol slot): ${identity}`,
    body: job.prompt,
  };
  const task = await checkReviewTaskStatement({
    ...statement,
    digest: await reviewTaskStatementDigest(statement),
  });
  if (!task.ok) throw new Error(task.detail);
  return task.statement;
}

function hasBlockingFindings(result: ReviewResultV1): boolean {
  return hasBlockingSeverity(
    result.findings.map((finding) => prioritySeverity(finding.priority)),
  );
}

function dispositionFor(
  result: ReviewResultV1,
  binding: Pick<AgentJobReviewRound, "baseSha" | "headSha" | "taskDigest">,
): AgentJobReviewRound["disposition"] {
  const acceptance = result.taskAcceptance;
  // The native reviewer requires a binding even when a P0 is present.
  if (
    result.verdict !== "unavailable" && (
      !acceptance || acceptance.issueNumber !== OPERATOR_JOB_TASK_SLOT ||
      acceptance.taskDigest !== binding.taskDigest
    )
  ) return "blocked";
  const decision = decideReviewDisposition({
    outcome: result.verdict === "unavailable" ? "unavailable" : "completed",
    findingsUncounted: 0,
    unresolvedSeverities: result.findings.map(({ priority }) =>
      prioritySeverity(priority)
    ),
  }, {
    issueNumber: OPERATOR_JOB_TASK_SLOT,
    task: { issueNumber: OPERATOR_JOB_TASK_SLOT, digest: binding.taskDigest },
    acceptance,
  });
  switch (decision.kind) {
    case "accept":
      return binding.headSha === binding.baseSha ? "blocked" : "accepted";
    case "already_satisfied":
    case "correct":
      return decision.kind;
    case "hold":
      return "blocked";
  }
}

function correctionGroup(result: ReviewResultV1) {
  const findings = result.findings.map((finding) => ({
    severity: prioritySeverity(finding.priority),
    path: finding.path as string | null,
    message: findingMessage(finding),
    resolved: false,
  }));
  // Put blockers first before the shared prompt drops overflow findings.
  findings.sort((left, right) =>
    Number(BLOCKING_SEVERITIES.includes(right.severity)) -
    Number(BLOCKING_SEVERITIES.includes(left.severity))
  );
  if (
    !hasBlockingFindings(result) &&
    result.taskAcceptance?.verdict === "not_fulfilled"
  ) {
    findings.unshift({
      severity: "P1",
      path: null,
      message: acceptanceFindingMessage(result.taskAcceptance, "operator-job"),
      resolved: false,
    });
  }
  return findings;
}

function correctionFeedback(
  result: ReviewResultV1,
  binding: Pick<AgentJobReviewRound, "baseSha" | "taskDigest">,
  history: readonly AgentJobReviewRound[],
): string {
  const previous = history.filter((item) =>
    item.disposition === "correct" && item.result !== null &&
    item.baseSha === binding.baseSha && item.taskDigest === binding.taskDigest
  ).slice(-MAX_CORRECTION_HISTORY_RECEIPTS).reverse();
  return renderCorrectionFeedback(boundedCorrectionFindings([
    correctionGroup(result),
    ...previous.map((item) => correctionGroup(item.result!)),
  ]));
}

async function reviewRequestId(
  input: Pick<
    AgentJobReviewRound,
    "round" | "headSha" | "baseSha" | "taskDigest"
  >,
): Promise<string> {
  const { baseSha, headSha, taskDigest, round } = input;
  return `agent-job-review:${await canonicalStringifySha256({
    domain: "sentinel-operator-job-review-request-v1",
    baseSha,
    headSha,
    taskDigest,
    round,
  })}`;
}

/** Re-derive the disposition before trusting a serialized review round. */
export async function agentJobReviewRoundVerdict(
  input: unknown,
  expected: {
    baseSha: string;
    headSha: string;
    taskDigest: string;
    snapshotDigest?: string;
  },
): Promise<"accepted" | "already_satisfied" | "correct" | null> {
  const row = asRecord(input);
  const round = row?.round;
  if (
    !row || !isGitSha(expected.baseSha) || !isGitSha(expected.headSha) ||
    !SHA256.test(expected.taskDigest) || typeof round !== "number" ||
    !Number.isSafeInteger(round) || round < 1 ||
    row.baseSha !== expected.baseSha || row.headSha !== expected.headSha ||
    row.taskDigest !== expected.taskDigest ||
    typeof row.snapshotDigest !== "string" ||
    !SHA256.test(row.snapshotDigest) ||
    (expected.snapshotDigest !== undefined &&
      row.snapshotDigest !== expected.snapshotDigest)
  ) return null;
  try {
    const requestId = await reviewRequestId({ ...expected, round });
    if (row.requestId !== requestId) return null;
    const execution = parseReadyExecution(row.execution, "$.execution");
    if (
      execution.invocationId !== requestId ||
      execution.nativeReview?.mode !== "review/start" ||
      execution.actual.observedTerminalStatus !== "completed"
    ) return null;
    const result = parseReviewResultV1(row.result);
    if (await reviewResultDigest(result) !== row.resultSha256) return null;
    const disposition = dispositionFor(result, expected);
    return disposition !== "blocked" && disposition === row.disposition
      ? disposition
      : null;
  } catch {
    return null;
  }
}

/** A single settled review of a scratch checkout, with no GitHub mutation. */
export async function reviewAgentJobHead(
  input: ReviewAgentJobHeadInput,
  openTestSession?: CodexStructuredReviewerOptionsV1["openSession"],
): Promise<AgentJobReviewRound> {
  const { job, headSha, deadlineAtMs, round, runTag } = input;
  if (
    !isGitSha(job.baseSha) || !isGitSha(headSha) ||
    !Number.isSafeInteger(round) || round < 1
  ) throw new Error("operator job review identity is invalid");
  const baseSha = job.baseSha;
  const task = await agentJobTask(job, runTag);
  const binding = { round, headSha, baseSha, taskDigest: task.digest };
  const requestId = await reviewRequestId(binding);
  let snapshotDigest: string | null = null;
  const blocked = (detail: string): AgentJobReviewRound => ({
    ...binding,
    requestId,
    snapshotDigest,
    disposition: "blocked",
    feedback: "",
    result: null,
    resultSha256: null,
    execution: null,
    detail,
  });
  if (!Number.isSafeInteger(deadlineAtMs) || Date.now() >= deadlineAtMs) {
    return blocked("operator job review deadline elapsed");
  }

  try {
    const trustedPath = Deno.env.get("PATH");
    if (!trustedPath) return blocked("operator job review PATH is unavailable");
    await ensurePrivateDir(input.workRoot);
    const reviewCheckout = joinPath(input.workRoot, "checkout");
    const checkout = await prepareReviewCheckout({
      sourcePath: input.sourcePath,
      reviewCheckout,
      base: baseSha,
      head: headSha,
      scratch: input.workRoot,
      trustedPath,
    });
    if (!checkout.ok) return blocked(checkout.error.detail);
    const remaining = deadlineAtMs - Date.now();
    if (remaining < 1) return blocked("operator job review deadline elapsed");
    const captured = await new GitReviewSnapshot({
      repositoryDir: reviewCheckout,
      gitExecutable: trustedGitPath(trustedPath),
      trustedPath,
      totalDeadlineMs: Math.min(remaining, MAX_SNAPSHOT_TOTAL_MS),
    }).capture({ base: baseSha, head: headSha });
    if (!captured.ok) return blocked(captured.error.detail);
    snapshotDigest = captured.value.digest;
    const openSession = openTestSession ??
      await openReviewSession(input, reviewCheckout, trustedPath);
    const ownerRunId = `agent-job:${runTag}:${job.id}`;
    const reviewer = new CodexStructuredReviewer({
      provider: GATEWAY_PROVIDER,
      sessionCwd: reviewCheckout,
      permissionProfile: REVIEW_PROFILE,
      openSession,
    });
    const prepared = await reviewer.prepare({
      snapshot: captured.value,
      task,
      requestId,
      invocationId: requestId,
      ownerRunId,
      latestStartAt: deadlineAtMs,
      settleBy: deadlineAtMs,
    });
    if (!prepared.ok) return blocked(prepared.error.detail);
    let started, closed;
    try {
      await Deno.writeTextFile(
        joinPath(input.workRoot, "review-running.json"),
        JSON.stringify({
          ...binding,
          requestId,
          snapshotDigest,
          execution: prepared.value.execution,
        }),
        { mode: 0o600, createNew: true },
      );
      started = await prepared.value.start();
    } finally {
      closed = await prepared.value.close();
    }
    const finalized = finalizeReviewCompletion(started, closed);
    if (!finalized.ok) return blocked(finalized.error.detail);
    const outcome = finalized.value;
    if (
      !outcome.execution || !outcome.result || outcome.status === "unavailable"
    ) {
      return blocked(
        outcome.detail ??
          "native operator review did not produce a settled result",
      );
    }
    const { result, execution } = outcome;
    const disposition = dispositionFor(result, binding);
    return {
      ...binding,
      requestId,
      snapshotDigest,
      result,
      resultSha256: await reviewResultDigest(result),
      execution,
      disposition,
      feedback: disposition === "correct"
        ? correctionFeedback(result, binding, input.history)
        : "",
      detail: disposition === "blocked"
        ? "native operator review did not establish task acceptance"
        : "",
    };
  } catch {
    return blocked("native operator review setup or settlement failed");
  }
}

async function openReviewSession(
  input: ReviewAgentJobHeadInput,
  reviewCheckout: string,
  trustedPath: string,
): Promise<CodexStructuredReviewerOptionsV1["openSession"]> {
  const codexExecutable = await resolveExecutable("codex", trustedPath);
  const reviewClientHome = joinPath(input.workRoot, "client");
  const reviewTmpDir = joinPath(input.workRoot, "tmp");
  const reviewDenoDir = joinPath(input.workRoot, "deno");
  await ensureReviewClient({
    reviewCheckout,
    reviewClientHome,
    reviewTmpDir,
    reviewDenoDir,
    token: input.modelToken,
    codexExecutable,
    denoExecutable: Deno.execPath(),
    trustedPath,
    baseUrl: input.baseUrl,
  });
  return ({ cwd }) =>
    new CodexSubprocessSession({
      command: [codexExecutable, "app-server"],
      cwd,
      env: codexChildEnv(
        reviewClientHome,
        reviewTmpDir,
        reviewDenoDir,
        trustedPath,
      ),
      operationDeadlineMs: MAX_REVIEW_TOTAL_MS,
    });
}
