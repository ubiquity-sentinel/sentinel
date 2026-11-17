/**
 * Experimental manual agent-job lane: request validation and packing, then
 * one connected plan -> cell -> publish lifecycle against temporary local Git
 * repositories with a fake agent process. No model, network or credential.
 */
import assert from "node:assert/strict";
import {
  type AgentJobsCellPorts,
  runAgentJobsCell,
} from "../../ops/agent-jobs-cell.ts";
import { gitOk } from "../../ops/agent-jobs-git.ts";
import {
  type AgentJobsPlanV1,
  mergeAgentJobRequests,
  planAgentJobs,
} from "../../ops/agent-jobs-plan.ts";
import { publishAgentJobsCell } from "../../ops/agent-jobs-publish.ts";

const TARGETS = ["ubiquity-sentinel/sentinel", "ubiquity/a", "ubiquity/b"];

function job(id: string, repository = "ubiquity/a", extra = {}) {
  return { id, repository, prompt: `Do ${id}\nmore detail`, ...extra };
}

Deno.test("agent jobs plan spreads jobs across cells before stacking them", () => {
  const jobs = ["j1", "j2", "j3", "j4", "j5"].map((id) => job(id));
  const wide = planAgentJobs({ jobs }, TARGETS);
  assert.equal(wide.cells.length, 5);
  assert.equal(
    planAgentJobs({ jobs }, TARGETS, { maxCells: 1 }).cells.length,
    2,
  );
  assert.ok(wide.cells.every((cell) => cell.jobs.length === 1));

  const stacked = planAgentJobs({ jobs }, TARGETS, {
    agentsPerCell: "3",
    maxCells: "2",
  });
  assert.deepEqual(stacked.cells.map((cell) => cell.jobs.length), [3, 2]);
  assert.equal(stacked.cells[0].timeoutMinutes, 150);
});

Deno.test("agent jobs plan keeps one repository owner per cell", () => {
  const plan = planAgentJobs(
    mergeAgentJobRequests([
      [job("a1"), job("b1", "ubiquity/b")],
      { jobs: [job("s1", "ubiquity-sentinel/sentinel")] },
    ]),
    TARGETS,
    { maxCells: 2 },
  );
  assert.deepEqual(
    plan.cells.map((cell) => [cell.owner, cell.repositories]),
    [["ubiquity", "a,b"], ["ubiquity-sentinel", "sentinel"]],
  );
});

Deno.test("agent jobs plan refuses invalid requests", () => {
  const refuse = (request: unknown, pattern: RegExp, overrides = {}) =>
    assert.throws(() => planAgentJobs(request, TARGETS, overrides), pattern);
  refuse({ jobs: [] }, /at least one job/);
  refuse([job("x", "ubiquity/other")], /not in sentinel.targets.json/);
  refuse([job("x"), job("x")], /unique/);
  refuse([job("Bad Id")], /job id/);
  refuse([job("x", "ubiquity/a", { base: "a..b" })], /base/);
  refuse([job("x", "ubiquity/a", { prompt: " " })], /prompt/);
  refuse([job("x", "ubiquity/a", { minutes: 301 })], /minutes/);
  refuse([job("x", "ubiquity/a", { token: "t" })], /unknown job field/);
  refuse([job("x"), job("y"), job("z")], /need 3 cells/, {
    agentsPerCell: 1,
    maxCells: 2,
  });
  refuse([job("x")], /maxCells/, { maxCells: 21 });
});

Deno.test("agent jobs cell bundles agent work and publish pushes it", async () => {
  const root = await Deno.makeTempDir({ prefix: "agent-jobs-" });
  try {
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

    // The fake agent reads its prompt on stdin and acts on the first word.
    const agent = `${root}/agent.sh`;
    await Deno.writeTextFile(
      agent,
      [
        "set -eu",
        "read -r mode rest || true",
        'test -f setup-ran || { echo "setup did not run" >&2; exit 3; }',
        'test -z "${UOS_AI_TOKEN:-}${GITHUB_TOKEN:-}"',
        'case "$mode" in',
        '  write) echo "$rest" > work.txt; echo "summary: $rest" > "$1";;',
        "  idle) ;;",
        "  fail) exit 7;;",
        "  hang) echo partial > partial.txt; sleep 30;;",
        "  limit)",
        '    if test -f "$TMPDIR/limited-once"; then echo recovered > work.txt',
        '    else touch "$TMPDIR/limited-once"',
        '      echo "ERROR: exceeded retry limit, last status: 429 Too Many Requests" >&2',
        "      exit 1; fi;;",
        "  starve) echo 'exceeded retry limit, last status: 429' >&2; exit 1;;",
        "esac",
      ].join("\n"),
    );
    const base = {
      repository: "ubiquity/a",
      base: null,
      setup: ["touch setup-ran", "echo setup-ran >> .git/info/exclude"],
      minutes: 5,
      model: null,
    };
    const plan: AgentJobsPlanV1 = {
      schema: "sentinel.agent-jobs.plan/v1",
      cells: [{
        cellId: "c01",
        owner: "ubiquity",
        repositories: "a",
        timeoutMinutes: 35,
        jobs: [
          { ...base, id: "writes", prompt: "write hello", pr: true },
          { ...base, id: "idles", prompt: "idle", pr: false },
          { ...base, id: "fails", prompt: "fail", pr: false },
          { ...base, id: "hangs", prompt: "hang", pr: false, minutes: 0.02 },
          { ...base, id: "limited", prompt: "limit", pr: false },
          { ...base, id: "starved", prompt: "starve", pr: false, minutes: 3 },
          {
            ...base,
            id: "nosetup",
            prompt: "idle",
            pr: false,
            setup: ["exit 9"],
          },
        ],
      }],
    };
    const delays: number[] = [];
    const lines: string[] = [];
    const ports: AgentJobsCellPorts = {
      remoteUrl: () => remote,
      agentCommand: (start) => ["bash", agent, start.lastMessageFile],
      prepareClient: (start) =>
        Deno.mkdir(start.clientHome, { recursive: true }),
      sleep: (seconds) => {
        delays.push(seconds);
        return Promise.resolve();
      },
      log: (line) => lines.push(line),
    };
    const outDir = `${root}/out`;
    const cell = await runAgentJobsCell({
      plan,
      cellId: "c01",
      workRoot: `${root}/work`,
      outDir,
      readToken: null,
      defaultModel: "fake",
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
        ["limited", "changed"],
        ["starved", "agent_failed"],
        ["nosetup", "setup_failed"],
      ],
    );
    assert.deepEqual(delays.sort((a, b) => a - b), [
      0,
      6,
      12,
      18,
      24,
      30,
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
    // The client home (model token) is removed once the agent exits.
    await assert.rejects(Deno.stat(`${root}/work/writes/client`));
    assert.deepEqual(
      JSON.parse(await Deno.readTextFile(`${outDir}/result.json`)),
      cell,
    );

    const pulls: Array<Record<string, string>> = [];
    const publications = await publishAgentJobsCell({
      cell,
      artifactDir: outDir,
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
        ["limited", "agent-jobs/limited-77-1"],
        ["starved", null],
        ["nosetup", null],
      ],
    );
    const pushed = (ref: string, path: string) =>
      gitOk(["--git-dir", remote, "show", `${ref}:${path}`]);
    assert.equal(await pushed("agent-jobs/writes-77-1", "work.txt"), "hello");
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
    await Deno.remove(root, { recursive: true });
  }
});
