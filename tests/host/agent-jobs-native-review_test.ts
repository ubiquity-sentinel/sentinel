import assert from "node:assert/strict";
import {
  agentJobReviewRoundVerdict,
  agentJobTask,
  reviewAgentJobHead,
  type ReviewAgentJobHeadInput,
} from "../../ops/agent-jobs-native-review.ts";
import { gitOk } from "../../ops/agent-jobs-git.ts";
import { prioritySeverity } from "../../src/github/review-normalize.ts";
import type { ReviewResultV1 } from "../../src/github/review-result-contracts.ts";
import {
  classifyReviewTerminalDisposition,
  type ReviewTerminalDispositionV1,
  TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
} from "../../src/repair/review-gate.ts";
import {
  agentMessage,
  ScriptedCodexSession,
  turnCompleted,
} from "../github/codex-reviewer-helpers.ts";
import { reviewReceipt, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const job = {
  id: "review-fixture",
  repository: "operator/public-fixture",
  base: "main",
  baseSha: "a".repeat(40),
  prompt: "Update the visible title",
  minutes: 5,
  model: null,
  setup: [],
  pr: false,
  runner: "linux-x64" as const,
};
const runTag = "120-2";

Deno.test("operator job native task preserves the original prompt and binds every dispatch field", async () => {
  const task = await agentJobTask(job, runTag);
  assert.equal(task.body, job.prompt);
  assert.match(task.title, /protocol slot/);
  assert.equal(task.digest, (await agentJobTask(job, runTag)).digest);
  for (
    const changed of [
      { ...job, id: "another-job" },
      { ...job, repository: "operator/other-fixture" },
      { ...job, base: "release" },
      { ...job, baseSha: "b".repeat(40) },
      { ...job, prompt: job.prompt + "\n" },
    ]
  ) assert.notEqual(task.digest, (await agentJobTask(changed, runTag)).digest);
  assert.notEqual(task.digest, (await agentJobTask(job, "120-1")).digest);
  await assert.rejects(agentJobTask({ ...job, baseSha: undefined }, runTag));
  await assert.rejects(
    agentJobTask({ ...job, prompt: "x".repeat(16_385) }, runTag),
  );
});

async function fixture(run: (input: ReviewAgentJobHeadInput) => Promise<void>) {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "agent-job-native-review-",
  });
  const sourcePath = `${root}/repo`;
  try {
    await gitOk(["init", "--quiet", "-b", "main", sourcePath]);
    await Deno.writeTextFile(`${sourcePath}/title.txt`, "Before\n");
    await gitOk(["add", "title.txt"], { cwd: sourcePath });
    await gitOk(["commit", "--quiet", "-m", "base"], { cwd: sourcePath });
    const baseSha = await gitOk(["rev-parse", "HEAD"], { cwd: sourcePath });
    await Deno.writeTextFile(`${sourcePath}/title.txt`, "After\n");
    await gitOk(["commit", "--quiet", "-am", "candidate"], { cwd: sourcePath });
    const headSha = await gitOk(["rev-parse", "HEAD"], { cwd: sourcePath });
    await run({
      job: { ...job, baseSha },
      sourcePath,
      headSha,
      runTag,
      workRoot: `${root}/review-1`,
      deadlineAtMs: Date.now() + 60_000,
      round: 1,
      history: [],
      baseUrl: "http://127.0.0.1:1",
      modelToken: "fixture",
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function nativeSession(result: ReviewResultV1): ScriptedCodexSession {
  const session = new ScriptedCodexSession();
  session.plan = (scripted) => {
    scripted.emit(
      "item/completed",
      agentMessage(scripted.turnId, "review-result", JSON.stringify(result)),
    );
    scripted.emit("turn/completed", turnCompleted(scripted.turnId));
  };
  return session;
}

async function expectedBinding(input: ReviewAgentJobHeadInput) {
  return {
    baseSha: input.job.baseSha!,
    headSha: input.headSha,
    taskDigest: (await agentJobTask(input.job, input.runTag)).digest,
  };
}

function assertIssueDecision(
  result: ReviewResultV1,
  expected: ReviewTerminalDispositionV1,
) {
  const reviewer = "sentinel-fixture";
  const record = workRecord("native-review-parity", {
    target: {
      base: SHA2,
      branch: "sentinel/parity",
      head: SHA1,
      pr: 12,
      checkpoint: null,
    },
    nextStep: "delivery",
  });
  const acceptance = result.taskAcceptance;
  const completed = result.verdict !== "unavailable";
  const findings = result.findings.map(({ priority, path, body }, index) => ({
    id: `finding-${index}`,
    severity: prioritySeverity(priority),
    path,
    message: body,
    fingerprint: "a".repeat(64),
    resolved: false,
    resolutionEvidence: null,
  }));
  const receipt = reviewReceipt("native-parity", {
    expectedReviewer: reviewer,
    observedReviewer: completed ? reviewer : null,
    outcome: completed ? "completed" : "unavailable",
    resultId: completed ? "native-result" : null,
    completedAt: completed ? T0 + 1_500 : null,
    findings,
    unresolvedSeverities: [
      ...new Set(findings.map(({ severity }) => severity)),
    ],
    taskAcceptance: acceptance,
  });
  const task = {
    issueNumber: 1,
    title: job.prompt,
    body: "",
    digest: acceptance?.taskDigest ?? "f".repeat(64),
  };
  assert.deepEqual(
    classifyReviewTerminalDisposition(receipt, record, reviewer, task),
    expected,
  );
}

async function reviewResult(
  input: ReviewAgentJobHeadInput,
  verdict:
    | "fulfilled"
    | "not_fulfilled"
    | "already_satisfied_at_base"
    | "uncertain",
  priority?: 0 | 1,
): Promise<ReviewResultV1> {
  const task = await agentJobTask(input.job, input.runTag);
  return {
    verdict: priority === undefined ? "clean" : "findings",
    summary: "Observed the exact committed title",
    findings: priority === undefined ? [] : [{
      priority,
      path: "title.txt",
      lineStart: 1,
      lineEnd: 1,
      title: "Fix incorrect candidate title",
      body: "Keep the title consistent with the request.",
    }],
    taskAcceptance: {
      issueNumber: task.issueNumber,
      taskDigest: task.digest,
      verdict,
      evidence: ["Read the committed title"],
    },
  };
}

Deno.test("operator job retains native settled current-head evidence and permits P1", async () => {
  await fixture(async (input) => {
    const session = nativeSession(await reviewResult(input, "fulfilled", 1));
    const receipt = await reviewAgentJobHead(input, () => session);
    const binding = await expectedBinding(input);
    assert.deepEqual(session.sent, [
      "initialize",
      "thread/start",
      "review/start",
    ]);
    assert.equal(session.closed, 1);
    assert.equal(receipt.disposition, "accepted");
    assert.equal(receipt.result?.findings[0].priority, 1);
    assert.equal(receipt.execution?.resultId, "review-result");
    assert.equal(receipt.execution?.invocationId, receipt.requestId);
    assert.equal(
      receipt.execution?.actual.nativeReview?.reviewThreadId,
      "thread-1",
    );
    assert.equal(
      await agentJobReviewRoundVerdict(receipt, binding),
      "accepted",
    );
    assertIssueDecision(receipt.result!, { kind: "qualified_new_repair" });
    assert.equal(
      await agentJobReviewRoundVerdict({
        ...receipt,
        resultSha256: "0".repeat(64),
      }, binding),
      null,
    );
    assert.equal(
      await agentJobReviewRoundVerdict(
        { ...receipt, execution: null },
        binding,
      ),
      null,
    );
    assert.equal(
      await agentJobReviewRoundVerdict(receipt, {
        ...binding,
        headSha: job.baseSha,
      }),
      null,
    );
  });
});

Deno.test("operator job feeds P0 and exact task rejection back through bounded issue-mode feedback", async () => {
  await fixture(async (input) => {
    const p0 = nativeSession(await reviewResult(input, "fulfilled", 0));
    const first = await reviewAgentJobHead(input, () => p0);
    assert.equal(first.disposition, "correct");
    assertIssueDecision(first.result!, {
      kind: "refused",
      reason: "blocking findings",
    });
    assert.match(
      first.feedback,
      /\[P0\] title.txt: Fix incorrect candidate title/,
    );
    await Deno.writeTextFile(`${input.sourcePath}/title.txt`, "Other title\n");
    await gitOk(["commit", "--quiet", "-am", "correction"], {
      cwd: input.sourcePath,
    });
    const next = {
      ...input,
      headSha: await gitOk(["rev-parse", "HEAD"], { cwd: input.sourcePath }),
      workRoot: input.workRoot + "-next",
      round: 2,
      history: [first],
    };
    const notFulfilled = nativeSession(
      await reviewResult(next, "not_fulfilled"),
    );
    const second = await reviewAgentJobHead(next, () => notFulfilled);
    assert.equal(second.disposition, "correct");
    assertIssueDecision(second.result!, {
      kind: "refused",
      reason: TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
    });
    assert.match(
      second.feedback,
      /Task acceptance not fulfilled.*original operator job/,
    );
    assert.match(second.feedback, /\[P0\] title.txt/);
    const binding = await expectedBinding(next);
    assert.equal(await agentJobReviewRoundVerdict(second, binding), "correct");
    assert.equal(
      await agentJobReviewRoundVerdict(
        { ...second, disposition: "accepted" },
        binding,
      ),
      null,
    );
  });
});

Deno.test("operator base assessment and unsettled or inconsistent native reviews fail safely", async () => {
  await fixture(async (input) => {
    const base = { ...input, headSha: input.job.baseSha! };
    const satisfied = nativeSession(
      await reviewResult(base, "already_satisfied_at_base"),
    );
    const assessment = await reviewAgentJobHead(base, () => satisfied);
    assert.equal(assessment.disposition, "already_satisfied");
    assertIssueDecision(assessment.result!, {
      kind: "qualified_already_satisfied",
    });
    assert.equal(
      await agentJobReviewRoundVerdict(assessment, await expectedBinding(base)),
      "already_satisfied",
    );

    const baseFulfilled = nativeSession(await reviewResult(base, "fulfilled"));
    const received = await reviewAgentJobHead({
      ...base,
      workRoot: input.workRoot + "-base-fulfilled",
    }, () => baseFulfilled);
    assert.equal(received.disposition, "blocked");

    const unsettled = nativeSession(await reviewResult(input, "fulfilled"));
    unsettled.settled = false;
    const closed = await reviewAgentJobHead({
      ...input,
      workRoot: input.workRoot + "-unsettled",
    }, () => unsettled);
    assert.equal(closed.disposition, "blocked");
    assert.equal(closed.execution, null);

    const wrong = await reviewResult(input, "fulfilled", 0);
    const unbound = nativeSession({ ...wrong, taskAcceptance: null });
    const rejected = await reviewAgentJobHead({
      ...input,
      workRoot: input.workRoot + "-invalid-task",
    }, () => unbound);
    assert.equal(rejected.disposition, "blocked");
    assert.equal(rejected.feedback, "");

    const unavailable: ReviewResultV1 = {
      verdict: "unavailable",
      summary: "Evidence was insufficient",
      findings: [],
      taskAcceptance: null,
    };
    const incomplete = await reviewAgentJobHead({
      ...input,
      workRoot: input.workRoot + "-unavailable",
    }, () => nativeSession(unavailable));
    assert.equal(incomplete.disposition, "blocked");
    assertIssueDecision(unavailable, {
      kind: "refused",
      reason: "incomplete receipt",
    });
  });
});
