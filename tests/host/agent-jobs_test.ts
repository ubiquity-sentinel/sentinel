/**
 * Experimental manual agent-job lane: request validation and packing, then
 * one connected plan -> cell -> reviewed publication lifecycle against local
 * Git repositories with a fake agent process and native-review receipts.
 */
import assert from "node:assert/strict";
import { relative } from "node:path";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import type { ReviewResultV1 } from "../../src/github/review-result-contracts.ts";
import { reviewResultDigest } from "../../src/github/review-result-parser.ts";
import {
  agentHeartbeat,
  type AgentJobResultV1,
  type AgentJobsCellPorts,
  codexExecCommand,
  runAgentJobsCell,
} from "../../ops/agent-jobs-cell.ts";
import { gitOk } from "../../ops/agent-jobs-git.ts";
import {
  type AgentJobsPlanV1,
  type AgentJobV1,
  mergeAgentJobRequests,
  planAgentJobs,
} from "../../ops/agent-jobs-plan.ts";
import {
  type AgentJobReviewRound,
  agentJobReviewRoundVerdict,
  agentJobTask,
  unavailableAgentJobReviewRound,
} from "../../ops/agent-jobs-native-review.ts";
import {
  agentJobsPublicationRunTag,
  type AgentJobsPublishInput,
  publishAgentJobsCell,
} from "../../ops/agent-jobs-publish.ts";
import {
  AGENT_JOB_REVIEW_COMMENT,
  githubAgentJobsPublishPorts,
} from "../../ops/agent-jobs-publish-github.ts";
import type { ReviewedAgentJobResultV1 } from "../../ops/agent-jobs-review-contract.ts";
import { reviewAgentJobsCell } from "../../ops/agent-jobs-review.ts";

function job(id: string, repository = "ubiquity/a", extra = {}) {
  return { id, repository, prompt: `Do ${id}\nmore detail`, ...extra };
}

Deno.test("agent jobs plan spreads jobs across cells before stacking them", () => {
  const jobs = ["j1", "j2", "j3", "j4", "j5"].map((id) => job(id));
  const wide = planAgentJobs({ jobs });
  assert.equal(wide.cells.length, 5);
  assert.equal(
    planAgentJobs({ jobs }, { maxCells: 2 }).cells.length,
    2,
  );
  assert.ok(wide.cells.every((cell) => cell.jobs.length === 1));

  const stacked = planAgentJobs({ jobs }, {
    agentsPerCell: "3",
    maxCells: "2",
  });
  assert.deepEqual(stacked.cells.map((cell) => cell.jobs.length), [3, 2]);
  assert.equal(stacked.cells[0].timeoutMinutes, 360);
});

Deno.test("agent jobs plan keeps one repository owner per cell", () => {
  const plan = planAgentJobs(
    mergeAgentJobRequests([
      [job("a1"), job("b1", "ubiquity/b")],
      { jobs: [job("s1", "ubiquity-sentinel/sentinel")] },
    ]),
    { maxCells: 2 },
  );
  assert.deepEqual(
    plan.cells.map((cell) => [cell.owner, cell.repositories]),
    [["ubiquity", "a,b"], ["ubiquity-sentinel", "sentinel"]],
  );
});

Deno.test("agent jobs plan gives each runner kind its own cells", () => {
  const plan = planAgentJobs({
    jobs: [
      job("x1"),
      job("m1", "ubiquity/a", { runner: "macos-arm64" }),
      job("a1", "ubiquity/b", { runner: "linux-arm64" }),
      job("m2", "ubiquity/b", { runner: "macos-arm64" }),
    ],
  }, { maxCells: 3 });
  assert.deepEqual(
    plan.cells.map((cell) => [
      cell.owner,
      cell.runner,
      cell.jobs.map((item) => item.id).join(","),
    ]),
    [
      ["ubiquity", "ubuntu-latest", "x1"],
      ["ubiquity", "macos-latest", "m1,m2"],
      ["ubiquity", "ubuntu-24.04-arm", "a1"],
    ],
  );
  assert.equal(plan.cells[0].jobs[0].runner, "linux-x64");
  assert.throws(
    () =>
      planAgentJobs({ jobs: [job("w1", "ubiquity/a", { runner: "windows" })] }),
    /runner must be one of linux-x64, linux-arm64, linux-arm64-26, macos-arm64/,
  );
});

Deno.test("agent jobs plan refuses invalid requests", () => {
  const refuse = (request: unknown, pattern: RegExp, overrides = {}) =>
    assert.throws(() => planAgentJobs(request, overrides), pattern);
  refuse({ jobs: [] }, /at least one job/);
  refuse([job("x", "not a repository")], /owner\/name/);
  refuse([job("x"), job("x")], /unique/);
  refuse([job("Bad Id")], /job id/);
  refuse([job("x", "ubiquity/a", { base: "a..b" })], /base/);
  refuse([job("x", "ubiquity/a", { prompt: " " })], /prompt/);
  refuse([job("x", "ubiquity/a", { minutes: 351 })], /minutes/);
  refuse([job("x", "ubiquity/a", { token: "t" })], /unknown job field/);
  for (const model of ["/a", "a/", "a//b", "a/../b", "a b", "a;b", "-a"]) {
    refuse([job("x", "ubiquity/a", { model })], /plain model id/);
  }
  assert.equal(
    planAgentJobs([
      job("x", "ubiquity/a", {
        model: "deepseek-ai/DeepSeek-V4.1-Flash-ultra",
      }),
    ]).cells[0].jobs[0].model,
    "deepseek-ai/DeepSeek-V4.1-Flash-ultra",
  );
  refuse([job("x"), job("y"), job("z")], /need 3 cells/, {
    agentsPerCell: 1,
    maxCells: 2,
  });
  refuse([job("x")], /maxCells/, { maxCells: 257 });
});

Deno.test("agent jobs plan persists supported reasoning efforts and defaults to max", () => {
  const efforts = [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ];
  const request = [
    job("old-inbox"),
    ...efforts.map((reasoningEffort) =>
      job(reasoningEffort, "ubiquity/a", { reasoningEffort })
    ),
  ];
  const plan = planAgentJobs(request);
  const serialized = JSON.parse(JSON.stringify(plan)) as AgentJobsPlanV1;
  assert.deepEqual(
    serialized.cells.flatMap((cell) =>
      cell.jobs.map((item) => item.reasoningEffort)
    ),
    ["max", ...efforts],
  );
});

Deno.test("agent jobs plan refuses invalid reasoning efforts", () => {
  for (
    const reasoningEffort of [
      null,
      false,
      1,
      ["ultra"],
      {},
      "",
      "ULTRA",
      "ultra ",
      "extra-high",
      'max"\nmodel="other',
    ]
  ) {
    assert.throws(
      () =>
        planAgentJobs([job("bad-effort", "ubiquity/a", { reasoningEffort })]),
      /job bad-effort: reasoningEffort must be one of/,
    );
  }
});

Deno.test("agent job heartbeat reports uncommitted work without refreshing the Git index", async () => {
  const checkout = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".agent-jobs-test-",
  });
  const repo = { cwd: checkout };
  try {
    await gitOk(["init", "--quiet"], repo);
    const tracked = `${checkout}/tracked.txt`;
    await Deno.writeTextFile(tracked, "base\n");
    await gitOk(["add", "tracked.txt"], repo);
    await gitOk(["commit", "--quiet", "-m", "base"], repo);
    // Stale stat data makes an ordinary git status rewrite the index.
    await Deno.utime(tracked, 1, 1);
    const index = `${checkout}/.git/index`;
    const before = await Deno.readFile(index);
    await Deno.writeTextFile(`${checkout}/partial.txt`, "partial\n");
    const line = await agentHeartbeat({
      id: "probe",
      checkout,
      baseSha: await gitOk(["rev-parse", "HEAD"], repo),
      logFile: `${checkout}/.git/agent.log`,
      startedAtMs: Date.now(),
      restarts: 0,
    });
    assert.match(line, /uncommitted files 1,/);
    assert.deepEqual(
      await Deno.readFile(index),
      before,
      "heartbeat rewrote the Git index",
    );
  } finally {
    await Deno.remove(checkout, { recursive: true });
  }
});

async function reviewedRow(
  row: AgentJobResultV1,
  job: AgentJobV1 & { base: string; baseSha: string },
  verdict: ReviewedAgentJobResultV1["review"]["verdict"],
  runTag = "77-1",
  round = 1,
): Promise<ReviewedAgentJobResultV1> {
  const task = await agentJobTask(job, runTag);
  const headSha = verdict === "accepted" ? row.headSha! : job.baseSha;
  const rounds: AgentJobReviewRound[] = [];
  if (verdict === "accepted" || verdict === "already_satisfied") {
    const binding = {
      baseSha: job.baseSha,
      headSha,
      taskDigest: task.digest,
      round,
    };
    const requestId = `agent-job-review:${await canonicalStringifySha256({
      domain: "sentinel-operator-job-review-request-v1",
      ...binding,
    })}`;
    const result: ReviewResultV1 = {
      verdict: "clean",
      summary: "Task checked",
      findings: [],
      taskAcceptance: {
        issueNumber: task.issueNumber,
        taskDigest: task.digest,
        verdict: verdict === "accepted"
          ? "fulfilled"
          : "already_satisfied_at_base",
        evidence: ["Fixture evidence"],
      },
    };
    const targetDigest = "b".repeat(64);
    rounds.push({
      ...binding,
      requestId,
      result,
      resultSha256: await reviewResultDigest(result),
      disposition: verdict,
      detail: "",
      feedback: "",
      snapshotDigest: "c".repeat(64),
      execution: {
        ownerRunId: `agent-job:${runTag}:${job.id}`,
        invocationId: requestId,
        threadId: "thread-1",
        submittedProvider: "uos",
        model: null,
        reasoning: null,
        nativeReview: { mode: "review/start", targetDigest },
        startMayOccur: true,
        turnId: "turn-1",
        resultId: "result-1",
        actual: {
          evidenceKind: "native-review",
          provider: "uos",
          threadId: "thread-1",
          turnId: "turn-1",
          terminalOrigin: "runtime",
          observedTerminalStatus: "completed",
          observedModel: null,
          observedReasoning: null,
          nativeReview: {
            targetDigest,
            reviewThreadId: "thread-1",
            enteredItemId: "entered-review-1",
            exitedItemId: "result-1",
          },
          durationMs: 5,
          outputChars: 10,
        },
      },
    });
  }
  return {
    ...row,
    base: job.base,
    baseSha: job.baseSha,
    headSha: verdict === "accepted" ? headSha : null,
    bundle: verdict === "accepted" ? row.bundle : null,
    review: {
      id: job.id,
      repository: job.repository,
      base: job.base,
      baseSha: job.baseSha,
      headSha,
      taskDigest: task.digest,
      runTag,
      verdict,
      rounds,
      detail: "",
    },
  };
}

Deno.test("agent jobs cell bundles agent work and publishes only reviewed heads", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: ".agent-jobs-test-",
  });
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(root);
    // A bare "GitHub" repository with one base commit on `main`.
    const remote = `${root}/remote.git`;
    const seed = `${root}/seed`;
    await gitOk(["init", "--quiet", "--bare", "-b", "main", remote]);
    await gitOk(["init", "--quiet", "-b", "main", seed]);
    await Deno.writeTextFile(`${seed}/README.md`, "base\n");
    await gitOk(["add", "--all"], { cwd: seed });
    await gitOk(["commit", "--quiet", "-m", "base"], { cwd: seed });
    await gitOk(["push", "--quiet", remote, "main"], { cwd: seed });
    const baseSha = await gitOk(["rev-parse", "HEAD"], { cwd: seed });

    // The fake Codex records its arguments and acts on the first prompt word.
    await Deno.writeTextFile(
      `${root}/codex`,
      [
        "#!/usr/bin/env bash",
        "set -eu",
        'printf "%s\\n" "$@"',
        "read -r mode rest || true",
        'test -f setup-ran || { echo "setup did not run" >&2; exit 3; }',
        'test -z "${UOS_AI_TOKEN:-}${GITHUB_TOKEN:-}"',
        'case "$mode" in',
        '  write) echo "$rest" > work.txt; echo "summary: $rest" > "${10}";;',
        "  idle) ;;",
        "  fail) echo 'working' >&2",
        "    echo 'ERROR: unexpected status 400: flagged token sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD end' >&2; exit 7;;",
        "  hang) echo partial > partial.txt; sleep 30;;",
        "  own) echo mine > own.txt; git add own.txt",
        "    git commit -q -m own;;",
        "  limit)",
        '    if test -f "$TMPDIR/limited-once"; then echo recovered > work.txt',
        '    else touch "$TMPDIR/limited-once"',
        '      echo "ERROR: exceeded retry limit, last status: 429 Too Many Requests" >&2',
        "      exit 1; fi;;",
        "  starve) echo 'exceeded retry limit, last status: 429' >&2; exit 1;;",
        "  drop)",
        '    if test -f "$TMPDIR/dropped-once"; then echo resumed > work.txt',
        '    else touch "$TMPDIR/dropped-once"; echo partial > partial.txt',
        '      echo "ERROR: stream disconnected before completion: stream closed before response.completed" >&2',
        "      exit 1; fi;;",
        "esac",
      ].join("\n"),
      { mode: 0o700 },
    );
    const base = {
      repository: "ubiquity/a",
      base: null,
      setup: ["touch setup-ran", "echo setup-ran >> .git/info/exclude"],
      minutes: 5,
      model: null,
      runner: "linux-x64" as const,
    };
    const serializedPlan = JSON.stringify({
      schema: "sentinel.agent-jobs.plan/v1",
      cells: [{
        cellId: "c01",
        owner: "ubiquity",
        repositories: "a",
        runner: "ubuntu-latest",
        timeoutMinutes: 35,
        jobs: [
          { ...base, id: "writes", prompt: "write hello", pr: true },
          { ...base, id: "idles", prompt: "idle", pr: false },
          { ...base, id: "fails", prompt: "fail", pr: false },
          { ...base, id: "hangs", prompt: "hang", pr: false, minutes: 0.02 },
          { ...base, id: "commits", prompt: "own", pr: false },
          {
            ...base,
            id: "limited",
            prompt: "limit",
            pr: false,
            model: "gpt-6.2-astra",
            reasoningEffort: "ultra",
          },
          { ...base, id: "starved", prompt: "starve", pr: false, minutes: 3 },
          {
            ...base,
            id: "dropped",
            prompt: "drop",
            pr: false,
            reasoningEffort: "low",
          },
          {
            ...base,
            id: "nosetup",
            prompt: "idle",
            pr: false,
            setup: ["exit 9"],
          },
          {
            ...base,
            id: "bad-effort",
            prompt: "idle",
            pr: false,
            reasoningEffort: null,
          },
        ],
      }],
    });
    const delays: number[] = [];
    const lines: string[] = [];
    const published: { jobId: string; sequence: number; text: string }[] = [];
    const ports: AgentJobsCellPorts = {
      remoteUrl: () => remote,
      agentCommand: codexExecCommand,
      prepareClient: (start) =>
        Deno.mkdir(start.clientHome, { recursive: true }),
      agentEnv: () => ({
        PATH: `${root}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.useConfigOnly",
        GIT_CONFIG_VALUE_0: "true",
      }),
      sleep: (seconds) => {
        delays.push(seconds);
        return Promise.resolve();
      },
      log: (line) => lines.push(line),
      publishProgress: (jobId, sequence, text) => {
        published.push({ jobId, sequence, text });
        return Promise.resolve();
      },
    };
    const outDir = `${root}/out`;
    const workRoot = `${root}/work`;
    const plan = JSON.parse(serializedPlan) as AgentJobsPlanV1;
    const pinned = plan.cells[0].jobs.map((item) => ({
      ...item,
      base: "main",
      baseSha,
      review: !["idles", "limited"].includes(item.id),
    }));
    plan.cells[0].jobs = pinned;
    const cell = await runAgentJobsCell({
      plan,
      cellId: "c01",
      workRoot,
      outDir,
      readToken: null,
      defaultModel: "fake",
      deadlineAtMs: Date.now() + 3_600_000,
      heartbeatSeconds: 0.3,
      ports,
    });

    assert.deepEqual(
      cell.results.map((row) => [row.id, row.status]),
      [
        ["writes", "changed"],
        ["idles", "no_changes"],
        ["fails", "agent_failed"],
        ["hangs", "timed_out"],
        ["commits", "changed"],
        ["limited", "changed"],
        ["starved", "agent_failed"],
        ["dropped", "changed"],
        ["nosetup", "setup_failed"],
        ["bad-effort", "host_failed"],
      ],
      cell.results.map(({ id, status, detail }) => `${id}: ${status} ${detail}`)
        .join("\n"),
    );
    const byId = Object.fromEntries(cell.results.map((row) => [row.id, row]));
    const workerCheckout = { cwd: `${workRoot}/commits/checkout` };
    assert.equal(
      await gitOk(["log", "-1", "--format=%s"], workerCheckout),
      "own",
    );
    const identities = ["log", "-1", "--format=%an <%ae>%n%cn <%ce>"];
    assert.equal(
      await gitOk(identities, workerCheckout),
      await gitOk(identities, { cwd: `${workRoot}/writes/checkout` }),
    );
    assert.match(
      byId["bad-effort"].detail,
      /job bad-effort: reasoningEffort must be one of/,
    );
    await assert.rejects(
      Deno.stat(`${workRoot}/bad-effort`),
      Deno.errors.NotFound,
    );

    const assertAttempt = async (
      id: string,
      attempt: number,
      model: string,
      reasoningEffort: string,
    ) => {
      const jobRoot = `${workRoot}/${id}`;
      const log = await Deno.readTextFile(`${jobRoot}/agent-${attempt}.log`);
      assert.deepEqual(log.trimEnd().split("\n"), [
        "exec",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        `${jobRoot}/checkout`,
        "-m",
        model,
        "-c",
        `model_reasoning_effort="${reasoningEffort}"`,
        "-o",
        `${jobRoot}/last-message.md`,
        "-",
      ]);
    };
    await assertAttempt("writes", 0, "fake", "max");
    for (const attempt of [0, 1]) {
      await assertAttempt("limited", attempt, "gpt-6.2-astra", "ultra");
      await assertAttempt("dropped", attempt, "fake", "low");
    }

    assert.equal(
      byId.fails.detail,
      "exit 7: ERROR: unexpected status 400: flagged token <redacted> end",
    );
    assert.deepEqual(delays.sort((a, b) => a - b), [
      0,
      3,
      6,
      9,
      12,
      15,
      15,
      18,
      21,
      60,
      60,
    ]);
    assert.equal(byId.writes.base, "main");
    assert.equal(byId.writes.baseSha, baseSha);
    assert.equal(byId.writes.title, "write hello");
    assert.ok(byId.writes.bundle && byId.hangs.bundle);
    assert.equal(byId.idles.bundle, null);
    // A 429 exit is retried after a backoff; one that never clears stops
    // at the job deadline (3 min: 60 s fits, the next 120 s does not).
    assert.match(
      byId.starved.detail,
      /rate limited \(429\) through 2 attempts/,
    );
    assert.ok(lines.includes("limited: model 429, restarting in 60s"));
    // A running agent reports liveness: commits, uncommitted files, output.
    assert.ok(
      lines.some((line) =>
        /^hangs: alive 0m, restarts 0, commits 0 \(last none\), uncommitted files \d+, agent output \d+ KiB, quiet \d+s$/
          .test(line)
      ),
      lines.join("\n"),
    );
    // Each job leaves a telemetry record: attempts with their client error
    // lines (tokens redacted) and the liveness lines it printed.
    const telemetryOf = async (id: string) =>
      JSON.parse(await Deno.readTextFile(`${outDir}/${id}.telemetry.json`));
    const droppedTelemetry = await telemetryOf("dropped");
    assert.deepEqual(
      droppedTelemetry.attempts.map((row: { cause: string }) => row.cause),
      ["disconnect", "exit"],
    );
    assert.equal(
      droppedTelemetry.attempts[0].errors[0].line,
      "ERROR: stream disconnected before completion: stream closed before response.completed",
    );
    const failsTelemetry = await telemetryOf("fails");
    assert.equal(
      failsTelemetry.attempts[0].errors[0].line,
      "ERROR: unexpected status 400: flagged token <redacted> end",
    );
    assert.ok((await telemetryOf("hangs")).heartbeats.length > 0);
    const hangs = published.filter((row) => row.jobId === "hangs");
    assert.equal(hangs[0].sequence, 1);
    assert.ok(hangs[0].text.includes("hangs: alive "));
    assert.ok(hangs[0].text.includes("commits since the base"));
    assert.ok(
      lines.some((line) =>
        line.startsWith("::notice title=agent hangs::hangs: alive ")
      ),
    );
    assert.ok(
      lines.some((line) =>
        /^dropped: attempt 0 ended after \d+s, exit 1, 1 client error or reconnect lines, most frequent x1: ERROR: stream disconnected/
          .test(line)
      ),
    );
    // A dropped model stream restarts the agent in the same checkout.
    assert.ok(
      lines.includes("dropped: model stream dropped, restart 1 in 15s"),
    );
    // The client home (model token) is removed once the agent exits.
    await assert.rejects(Deno.stat(`${root}/work/writes/client`));
    assert.deepEqual(
      JSON.parse(await Deno.readTextFile(`${outDir}/result.json`)),
      cell,
    );

    const reviewed = {
      ...cell,
      results: await Promise.all(pinned.map((item) =>
        reviewedRow(
          byId[item.id],
          item,
          ["writes", "commits", "limited", "dropped", "hangs"].includes(item.id)
            ? "accepted"
            : item.id === "idles"
            ? "skipped_no_diff"
            : "blocked",
        )
      )),
      modelStarts: [],
    };
    const comments = new Map<string, {
      id: number;
      body: string;
      commit_id: string;
      user: { login: string; type: string };
    }>();
    const pullRequests: Array<Record<string, unknown>> = [];
    const fetchResponse: typeof fetch = (url, options) => {
      const response = (body: unknown) => Promise.resolve(Response.json(body));
      const endpoint = new URL(String(url));
      const path = endpoint.pathname;
      assert.match(path, /^\/repos\/ubiquity\/a(?:\/|$)/);
      const method = options?.method;
      if (path === "/repos/ubiquity/a") {
        return response({
          full_name: "ubiquity/a",
          private: false,
          visibility: "public",
        });
      }
      const head = /\/commits\/([0-9a-f]{40})\/comments$/.exec(path)?.[1];
      if (head && method === "GET") {
        const row = comments.get(head);
        if (
          head === byId.writes.headSha &&
          endpoint.searchParams.get("page") === "1"
        ) {
          // An unrelated user can copy the marker. Only the App's own exact
          // comment, on the following page, can reconcile publication.
          return Promise.resolve(Response.json(
            row
              ? [{ ...row, user: { login: "contributor", type: "User" } }]
              : [],
            { headers: { link: '<https://api.github.com/next>; rel="next"' } },
          ));
        }
        return response(row ? [row] : []);
      }
      if (head && method === "POST") {
        assert.equal(
          comments.has(head),
          false,
          "the App writes one comment per head",
        );
        assert.equal(
          new Headers(options?.headers).get("authorization"),
          "Bearer fixture-token",
        );
        const comment = {
          id: comments.size + 1,
          commit_id: head,
          body: JSON.parse(String(options?.body)).body,
          user: { login: "ubiquity-sentinel[bot]", type: "Bot" },
        };
        comments.set(head, comment);
        if (head === byId.writes.headSha) {
          return Promise.reject(new TypeError("local fixture response lost"));
        }
        return response(comment);
      }
      assert.equal(path, "/repos/ubiquity/a/pulls");
      if (method === "GET") return response(pullRequests);
      assert.equal(method, "POST");
      const body = JSON.parse(String(options?.body));
      const pull = {
        number: 1,
        state: "open",
        draft: body.draft,
        title: body.title,
        body: body.body,
        user: { login: "ubiquity-sentinel[bot]", type: "Bot" },
        head: {
          sha: byId.writes.headSha,
          ref: body.head,
          repo: { full_name: "ubiquity/a" },
        },
        base: {
          sha: baseSha,
          ref: body.base,
          repo: { full_name: "ubiquity/a" },
        },
      };
      pullRequests.push(pull);
      // The first response was lost after the effect. The publisher must
      // reconcile the existing exact draft without submitting a second POST.
      return Promise.reject(new TypeError("local fixture response lost"));
    };
    const publishInput: AgentJobsPublishInput = {
      plan,
      cellId: "c01",
      reviewed,
      // The workflow passes a relative directory; Git runs in another clone.
      artifactDir: relative(Deno.cwd(), outDir),
      workRoot: `${root}/publish`,
      runTag: agentJobsPublicationRunTag("77", "2", "77-1"),
      writeToken: null,
      ports: githubAgentJobsPublishPorts(
        "fixture-token",
        () => remote,
        fetchResponse,
      ),
    };
    const publications = await publishAgentJobsCell(publishInput);
    assert.deepEqual(
      publications.map((row) => [row.id, row.status, row.branch]),
      [
        ["writes", "published", "agent-jobs/writes-77-1"],
        ["idles", "skipped_no_diff", null],
        ["fails", "blocked", null],
        ["hangs", "blocked", null],
        ["commits", "published", "agent-jobs/commits-77-1"],
        ["limited", "blocked", null],
        ["starved", "blocked", null],
        ["dropped", "published", "agent-jobs/dropped-77-1"],
        ["nosetup", "blocked", null],
        ["bad-effort", "blocked", null],
      ],
    );
    const pushed = (ref: string, path: string) =>
      gitOk(["--git-dir", remote, "show", `${ref}:${path}`]);
    assert.equal(await pushed("agent-jobs/writes-77-1", "work.txt"), "hello");
    assert.equal(await pushed("agent-jobs/commits-77-1", "own.txt"), "mine");
    assert.equal(
      await pushed("agent-jobs/dropped-77-1", "work.txt"),
      "resumed",
    );
    assert.equal(
      await pushed("agent-jobs/dropped-77-1", "partial.txt"),
      "partial",
    );
    await assert.rejects(pushed("agent-jobs/hangs-77-1", "partial.txt"));
    assert.equal(
      await gitOk(["--git-dir", remote, "rev-parse", "main"]),
      baseSha,
    );
    assert.deepEqual([...comments.keys()], [
      byId.writes.headSha,
      byId.commits.headSha,
      byId.dropped.headSha,
    ]);
    assert.ok(
      [...comments.values()].every(({ body }) =>
        body.includes(AGENT_JOB_REVIEW_COMMENT) &&
        body.includes("verdict: **accepted**")
      ),
    );
    assert.equal(
      publications[0].reviewCommentUrl,
      `https://github.com/ubiquity/a/commit/${byId.writes.headSha}#commitcomment-1`,
    );
    assert.equal(
      publications[0].pullRequest,
      "https://github.com/ubiquity/a/pull/1",
    );
    assert.equal(pullRequests.length, 1);
    assert.match(
      String(pullRequests[0].body),
      /Native review verdict: \*\*accepted\*\*/,
    );
    assert.deepEqual(await publishAgentJobsCell(publishInput), publications);
    assert.equal(pullRequests.length, 1);

    const one = {
      ...publishInput,
      plan: { ...plan, cells: [{ ...plan.cells[0], jobs: [pinned[0]] }] },
      reviewed: { ...reviewed, results: [reviewed.results[0]] },
    };
    const deniedFetch: typeof fetch = (url, options) => {
      if (new URL(String(url)).pathname.endsWith("/comments")) {
        return Promise.resolve(
          options?.method === "POST"
            ? new Response(null, { status: 403 })
            : Response.json([]),
        );
      }
      return fetchResponse(url, options);
    };
    const [deniedComment] = await publishAgentJobsCell({
      ...one,
      ports: githubAgentJobsPublishPorts(
        "fixture-token",
        () => remote,
        deniedFetch,
      ),
    });
    assert.equal(deniedComment.status, "blocked");
    assert.equal(
      deniedComment.detail,
      "review commit comment refused (HTTP 403)",
    );
    assert.equal(deniedComment.branch, "agent-jobs/writes-77-1");
    assert.equal(deniedComment.reviewCommentUrl, null);
    const forged = structuredClone(one.reviewed);
    forged.results[0].review.rounds[0].headSha = baseSha;
    const [refused] = await publishAgentJobsCell({ ...one, reviewed: forged });
    assert.match(refused.detail, /native review evidence/);
    assert.equal(refused.branch, null);

    const retryJob = pinned.find((item) => item.id === "dropped")!;
    const retryPlan = {
      ...plan,
      cells: [{ ...plan.cells[0], jobs: [retryJob] }],
      createdAtMs: Date.now(),
    };
    const runTag = "79-1";
    const retryInput = `${root}/retry-input`;
    const reviewedDir = `${root}/retry-reviewed`;
    await Deno.mkdir(retryInput);
    await Deno.copyFile(
      `${outDir}/dropped.bundle`,
      `${retryInput}/dropped.bundle`,
    );
    await Deno.writeTextFile(
      `${retryInput}/result.json`,
      JSON.stringify({ ...cell, results: [byId.dropped] }),
    );
    const withRetries = await reviewAgentJobsCell({
      plan: retryPlan,
      cellId: "c01",
      runTag,
      artifactDir: retryInput,
      reviewedDir,
      workRoot: `${root}/retry-work`,
      modelToken: "",
      defaultModel: "fixture",
      baseUrl: "https://example.invalid/v1",
      ports: {
        publicRepository: () => Promise.resolve(),
        remoteUrl: () => remote,
        task: agentJobTask,
        verdict: agentJobReviewRoundVerdict,
        correct: () => assert.fail("unavailable review requested correction"),
        sleep: () => Promise.resolve(),
        log: () => {},
        review: async ({ headSha, round }) => {
          if (round === 1) throw new Error("fixture transport failure");
          const receipt = (await reviewedRow(
            { ...byId.dropped, headSha },
            retryJob,
            "accepted",
            runTag,
            round,
          )).review.rounds[0];
          return round === 2
            ? await unavailableAgentJobReviewRound(
              receipt,
              "fixture unavailable review",
              receipt.snapshotDigest,
            )
            : receipt;
        },
      },
    });
    const retryPublication = {
      ...one,
      plan: retryPlan,
      runTag,
      artifactDir: reviewedDir,
      reviewed: withRetries,
    };
    const [retried] = withRetries.results;
    const [recovered] = await publishAgentJobsCell(retryPublication);
    assert.equal(recovered.status, "published", recovered.detail);
    assert.equal(recovered.headSha, retried.review.headSha);
    assert.equal(recovered.branch, "agent-jobs/dropped-79-1");
    assert.equal(await pushed(recovered.branch, "work.txt"), "resumed");
    assert.deepEqual(
      withRetries.modelStarts.map(({ headSha, kind, round }) => [
        headSha,
        kind,
        round,
      ]),
      [1, 2, 3].map((round) => [recovered.headSha, "review", round]),
    );

    const missingStart = structuredClone(withRetries);
    missingStart.modelStarts.shift();
    const [unaccounted] = await publishAgentJobsCell({
      ...retryPublication,
      reviewed: missingStart,
    });
    assert.equal(unaccounted.branch, null);
    assert.match(unaccounted.detail, /retry accounting/);

    const unavailableFinal = structuredClone(withRetries);
    unavailableFinal.results[0].review.rounds[2] =
      await unavailableAgentJobReviewRound(
        retried.review.rounds[2],
        "fixture unavailable final review",
      );
    const [unsettled] = await publishAgentJobsCell({
      ...retryPublication,
      reviewed: unavailableFinal,
    });
    assert.equal(unsettled.branch, null);
    assert.match(unsettled.detail, /native review evidence/);

    assert.throws(
      () => agentJobsPublicationRunTag("77", "1", "77-2"),
      /workflow run/,
    );
    assert.throws(
      () => agentJobsPublicationRunTag("78", "2", "77-1"),
      /workflow run/,
    );

    await gitOk([
      "--git-dir",
      remote,
      "update-ref",
      "refs/heads/agent-jobs/writes-77-1",
      baseSha,
    ]);
    const [collision] = await publishAgentJobsCell(one);
    assert.equal(collision.status, "blocked");
    assert.match(collision.detail, /different commit/);
    assert.equal(
      await gitOk(["--git-dir", remote, "rev-parse", "agent-jobs/writes-77-1"]),
      baseSha,
    );

    await gitOk([
      "--git-dir",
      remote,
      "update-ref",
      "refs/heads/main",
      byId.commits.headSha!,
    ]);
    const [stale] = await publishAgentJobsCell(one);
    assert.equal(stale.status, "blocked");
    assert.match(stale.detail, /base changed since review/);

    const [hidden] = await publishAgentJobsCell({
      ...one,
      ports: {
        ...one.ports,
        repositoryVisibility: () => Promise.resolve("private"),
      },
    });
    assert.equal(hidden.status, "blocked");
    assert.match(hidden.detail, /visibility is private or unavailable/);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(root, { recursive: true });
  }
});
