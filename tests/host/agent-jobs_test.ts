/**
 * Experimental manual agent-job lane: request validation and packing, then
 * one connected plan -> cell -> publish lifecycle against temporary local Git
 * repositories with a fake agent process. No model, network or credential.
 */
import assert from "node:assert/strict";
import { relative } from "node:path";
import {
  type AgentJobsCellPorts,
  codexExecCommand,
  runAgentJobsCell,
} from "../../ops/agent-jobs-cell.ts";
import { gitOk } from "../../ops/agent-jobs-git.ts";
import {
  type AgentJobsPlanV1,
  mergeAgentJobRequests,
  planAgentJobs,
} from "../../ops/agent-jobs-plan.ts";
import { publishAgentJobsCell } from "../../ops/agent-jobs-publish.ts";

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

Deno.test("agent jobs cell bundles agent work and publish pushes it", async () => {
  const root = await Deno.makeTempDir({ prefix: "agent-jobs-" });
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
        "    git -c user.name=a -c user.email=a@b.c commit -q -m own;;",
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
    const cell = await runAgentJobsCell({
      plan: JSON.parse(serializedPlan) as AgentJobsPlanV1,
      cellId: "c01",
      workRoot,
      outDir,
      readToken: null,
      defaultModel: "fake",
      deadlineAtMs: Date.now() + 3_600_000,
      heartbeatSeconds: 0.3,
      ports,
    });

    const byId = Object.fromEntries(cell.results.map((row) => [row.id, row]));
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

    const pulls: Array<Record<string, string>> = [];
    const publications = await publishAgentJobsCell({
      cell,
      // The workflow passes a relative directory; Git runs in another clone.
      artifactDir: relative(Deno.cwd(), outDir),
      workRoot: `${root}/publish`,
      runTag: "77-1",
      writeToken: null,
      ports: {
        remoteUrl: () => remote,
        openPullRequest: (request) => {
          pulls.push(request);
          return Promise.resolve("https://example.invalid/pull/1");
        },
        log: () => {},
      },
    });
    assert.deepEqual(
      publications.map((row) => [row.id, row.branch]),
      [
        ["writes", "agent-jobs/writes-77-1"],
        ["idles", null],
        ["fails", null],
        ["hangs", "agent-jobs/hangs-77-1"],
        ["commits", "agent-jobs/commits-77-1"],
        ["limited", "agent-jobs/limited-77-1"],
        ["starved", null],
        ["dropped", "agent-jobs/dropped-77-1"],
        ["nosetup", null],
        ["bad-effort", null],
      ],
    );
    const pushed = (ref: string, path: string) =>
      gitOk(["--git-dir", remote, "show", `${ref}:${path}`]);
    assert.equal(await pushed("agent-jobs/writes-77-1", "work.txt"), "hello");
    // Work the agent committed itself is published as it stands.
    assert.equal(await pushed("agent-jobs/commits-77-1", "own.txt"), "mine");
    // The restarted agent continued in the checkout its first attempt left.
    assert.equal(
      await pushed("agent-jobs/dropped-77-1", "work.txt"),
      "resumed",
    );
    assert.equal(
      await pushed("agent-jobs/dropped-77-1", "partial.txt"),
      "partial",
    );
    assert.equal(
      await pushed("agent-jobs/hangs-77-1", "partial.txt"),
      "partial",
    );
    assert.equal(
      await gitOk([
        "--git-dir",
        remote,
        "rev-parse",
        "agent-jobs/writes-77-1~1",
      ]),
      baseSha,
    );
    assert.equal(
      await gitOk(["--git-dir", remote, "rev-parse", "main"]),
      baseSha,
    );
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].head, "agent-jobs/writes-77-1");
    assert.equal(pulls[0].base, "main");
    assert.match(pulls[0].body, /summary: hello/);

    // A bundle whose tip is not the recorded commit is refused, not pushed.
    const forged = structuredClone(cell);
    forged.results = [{ ...byId.writes, headSha: baseSha }];
    const refused = await publishAgentJobsCell({
      cell: forged,
      artifactDir: outDir,
      workRoot: `${root}/publish-forged`,
      runTag: "78-1",
      writeToken: null,
      ports: {
        remoteUrl: () => remote,
        openPullRequest: () => Promise.reject(new Error("unreachable")),
        log: () => {},
      },
    });
    assert.match(refused[0].detail, /publish failed: bundle tip/);
    assert.equal(refused[0].branch, null);
  } finally {
    Deno.chdir(originalCwd);
    await Deno.remove(root, { recursive: true });
  }
});
