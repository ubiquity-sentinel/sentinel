/**
 * The act invocation, event payloads, log sanitizer and run classification
 * (docs/backup-ci-spec.md §9.4, §10.3-§10.5): the exact act and
 * `systemd-run` argv (no Docker, privileged or host-environment flag; the
 * empty files; the actor; the empty cwd), the two event payloads, the
 * sanitizer (`::`, `##[`, marker-shaped lines, ANSI, chunking, the cap, the
 * stop-commands token) and every row of the classification table. Pins:
 * placeholders and young releases are refused. All synthetic.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BackupCiPlannedStepV1 } from "../../src/contracts/backup-ci.ts";
import {
  BACKUP_CI_ACTOR,
  type BackupCiActPathsV1,
  type BackupCiActRecordV1,
  backupCiPinsUsable,
  backupCiRunnerId,
  buildActArgv,
  buildEventPayload,
  buildSystemdRunArgv,
  classifyActRun,
  parseActJsonLine,
  parseBackupCiPins,
  parseEtcEnvironment,
} from "../../ops/backup-ci-act.ts";
import {
  BACKUP_CI_LOG_CAP_BYTES,
  BACKUP_CI_LOG_TRUNCATED,
  backupCiExcerpt,
  BackupCiLogSanitizer,
  neutralizeLogText,
  stopCommandsToken,
} from "../../ops/backup-ci-log-sanitize.ts";

const PATHS: BackupCiActPathsV1 = {
  act: "/rt/backup-ci/bin/act",
  ws: "/rt/backup-ci/ws",
  emptyCwd: "/rt/backup-ci/cwd",
  event: "/rt/backup-ci/event.json",
  empty: {
    env: "/rt/backup-ci/empty/env",
    secrets: "/rt/backup-ci/empty/secrets",
    vars: "/rt/backup-ci/empty/vars",
    input: "/rt/backup-ci/empty/input",
  },
  actionCache: "/rt/backup-ci/action-cache",
  cacheServer: "/rt/backup-ci/cache-server",
  artifactServer: "/rt/backup-ci/artifacts",
};
const JOB = {
  context: "pull_request" as const,
  workflowPath: ".github/workflows/ci.yml",
  jobKey: "deno",
  matrix: { node: 24, os: "linux" },
  runsOn: "ubuntu-latest" as const,
  defaultBranch: "main",
  capMinutes: 30,
};

Deno.test("the act argv is exact and carries nothing else from the target", () => {
  assert.deepEqual(buildActArgv(JOB, PATHS), [
    "/rt/backup-ci/bin/act",
    "pull_request",
    "-C",
    "/rt/backup-ci/ws",
    "-W",
    "/rt/backup-ci/ws/.github/workflows/ci.yml",
    "-j",
    "deno",
    "--matrix",
    "node:24",
    "--matrix",
    "os:linux",
    "-e",
    "/rt/backup-ci/event.json",
    "-P",
    "ubuntu-latest=-self-hosted",
    "--actor",
    BACKUP_CI_ACTOR,
    "--defaultbranch",
    "main",
    "--remote-name",
    "origin",
    "--use-gitignore=false",
    "--env-file",
    "/rt/backup-ci/empty/env",
    "--secret-file",
    "/rt/backup-ci/empty/secrets",
    "--var-file",
    "/rt/backup-ci/empty/vars",
    "--input-file",
    "/rt/backup-ci/empty/input",
    "--container-daemon-socket",
    "-",
    "--action-cache-path",
    "/rt/backup-ci/action-cache",
    "--cache-server-path",
    "/rt/backup-ci/cache-server",
    "--artifact-server-path",
    "/rt/backup-ci/artifacts",
    "--json",
  ]);
  const argv = buildActArgv({ ...JOB, matrix: null }, PATHS).join(" ");
  for (
    const flag of [
      "--privileged",
      "--bind",
      "--container-options",
      "--userns",
      "-s ",
      "--secret ",
      "--env ",
      "--var ",
    ]
  ) {
    assert(!argv.includes(flag), flag);
  }
});

Deno.test("the systemd service is clean, limited and kill-on-exit", () => {
  const etc = parseEtcEnvironment(
    'PATH="/usr/local/sbin:/usr/bin"\nJAVA_HOME_17_X64=/opt/java\nGITHUB_TOKEN=leak\nRUNNER_TEMP=/x\nHOME=/root\n# c\nBAD-KEY=1\n',
  );
  assert.deepEqual(etc, {
    PATH: "/usr/local/sbin:/usr/bin",
    JAVA_HOME_17_X64: "/opt/java",
    GITHUB_TOKEN: "leak",
    RUNNER_TEMP: "/x",
    HOME: "/root",
  });
  const argv = buildSystemdRunArgv({
    unitName: "sentinel-backup-act-0",
    capMinutes: 30,
    emptyCwd: PATHS.emptyCwd,
    nodeShimDir: "/rt/backup-ci/cwd-node",
    etcEnvironment: etc,
    imageOs: "ubuntu24",
    imageVersion: "20261020.1.0",
    actArgv: ["/act", "push"],
  });
  assert.deepEqual(argv.slice(0, 29), [
    "systemd-run",
    "--unit=sentinel-backup-act-0",
    "--pipe",
    "--wait",
    "--collect",
    "--quiet",
    "--uid=runner",
    "--gid=runner",
    "--working-directory=/rt/backup-ci/cwd",
    "-p",
    "MemoryMax=7G",
    "-p",
    "CPUQuota=200%",
    "-p",
    "TasksMax=8192",
    "-p",
    "KillMode=control-group",
    "-p",
    "RuntimeMaxSec=1800",
    "-p",
    "TimeoutStopSec=30",
    "--setenv=HOME=/home/runner",
    "--setenv=PATH=/rt/backup-ci/cwd-node:/usr/local/sbin:/usr/bin",
    "--setenv=ImageOS=ubuntu24",
    "--setenv=ImageVersion=20261020.1.0",
    "--setenv=RUNNER_TOOL_CACHE=/opt/hostedtoolcache",
    "--setenv=AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache",
    "--setenv=CI=true",
    "--setenv=JAVA_HOME_17_X64=/opt/java",
  ]);
  assert.deepEqual(argv.slice(29), ["--", "/act", "push"]);
  assert(
    !argv.some((a) => a.includes("GITHUB_TOKEN") || a.includes("RUNNER_TEMP")),
  );
  assert(!argv.some((a) => a.includes("HOME=/root")));
});

const REPO = {
  full_name: "ubiquity/passport.ubq.fi",
  name: "passport.ubq.fi",
  owner: { login: "ubiquity" },
};
const H = "a".repeat(40) as GitSha;
const B = "b".repeat(40) as GitSha;

Deno.test("event payloads copy only the allowlisted fields", () => {
  const repository = {
    owner: "ubiquity",
    name: "passport.ubq.fi",
    defaultBranch: "main",
    private: true,
  };
  const push = buildEventPayload({
    context: "push",
    repository,
    commit: H,
    ref: "refs/heads/main",
    before: B,
    pull: null,
  });
  assert.deepEqual(Object.keys(push), [
    "ref",
    "before",
    "after",
    "repository",
    "pusher",
    "sender",
    "head_commit",
  ]);
  assert.equal(push.before, B);
  assert.equal(
    buildEventPayload({
      context: "push",
      repository,
      commit: H,
      ref: "refs/heads/main",
      before: null,
      pull: null,
    }).before,
    "0".repeat(40),
  );
  const pr = buildEventPayload({
    context: "pull_request",
    repository,
    commit: H,
    ref: "refs/pull/7/merge",
    before: null,
    pull: {
      number: 7,
      draft: false,
      user: "ubiquity-sentinel[bot]",
      head: { sha: H, ref: "fix/7", repo: REPO },
      base: { sha: B, ref: "main", repo: REPO },
    },
  });
  assert.deepEqual(Object.keys(pr), [
    "action",
    "number",
    "pull_request",
    "repository",
    "sender",
  ]);
  assert.deepEqual(pr.pull_request, {
    number: 7,
    state: "open",
    draft: false,
    head: { sha: H, ref: "fix/7", repo: REPO },
    base: { sha: B, ref: "main", repo: REPO },
    user: { login: "ubiquity-sentinel[bot]" },
  });
  assert.deepEqual(pr.sender, { login: BACKUP_CI_ACTOR });
});

Deno.test("the sanitizer neutralizes workflow commands, controls and volume", () => {
  const token = stopCommandsToken(new Uint8Array(16).fill(171));
  assert.equal(token, "ab".repeat(16));
  const lines: string[] = [];
  const s = new BackupCiLogSanitizer(token, (l) => lines.push(l));
  s.begin();
  s.line(1, "::add-mask::secret");
  s.line(1, "##[error]boom ###[x");
  s.line(2, '{"kind":"sentinel_backup_ci_leg_result","unitId":"x"}');
  s.line(null, "\x1b[31mred\x1b[0m \x1b]0;title\x07\x1b[2Kclear\x07bell\r");
  s.line(3, ":::");
  s.end();
  assert.equal(lines[0], `::stop-commands::${token}`);
  assert.equal(lines.at(-1), `::${token}::`);
  assert.equal(lines[1], "│ [1] :\u200b:add-mask:\u200b:secret");
  assert.equal(lines[2], "│ [1] #\u200b#[error]boom ##\u200b#[x");
  assert(lines[3].startsWith("│ [2] {"));
  assert.equal(lines[4], "│ [-] \x1b[31mred\x1b[0m clearbell");
  assert.equal(lines[5], "│ [3] :\u200b:\u200b:");
  for (const line of lines.slice(1, -1)) {
    assert(!line.includes("::") && !line.includes("##["), line);
    assert(line.startsWith("│ ["));
  }
  assert.equal(neutralizeLogText("a\u2028b\u0085c\u009bd"), "abcd");
});

Deno.test("long lines are chunked at 4 KiB and the stream is capped at 4 MiB", () => {
  const lines: string[] = [];
  const s = new BackupCiLogSanitizer("0".repeat(32), (l) => lines.push(l));
  s.line(4, "é".repeat(5000));
  const chunks = lines.slice(1);
  assert(chunks.length >= 3);
  for (const chunk of chunks) {
    assert(chunk.startsWith("│ [4] "));
    assert(new TextEncoder().encode(chunk.slice(6)).length <= 4096);
  }
  assert.equal(chunks.map((c) => c.slice(6)).join(""), "é".repeat(5000));
  const big: string[] = [];
  const capped = new BackupCiLogSanitizer("1".repeat(32), (l) => big.push(l));
  for (let i = 0; i < 2000; i++) capped.line(0, "x".repeat(4000));
  capped.end();
  const bytes = big.slice(1, -2).reduce(
    (n, l) => n + new TextEncoder().encode(l).length + 1,
    0,
  );
  assert(bytes <= BACKUP_CI_LOG_CAP_BYTES);
  assert.equal(big.at(-2), BACKUP_CI_LOG_TRUNCATED);
  assert.equal(big.filter((l) => l === BACKUP_CI_LOG_TRUNCATED).length, 1);
  assert.throws(() => new BackupCiLogSanitizer("not-hex", () => {}));
});

Deno.test("an excerpt keeps the tail within 8 KiB, re-neutralized", () => {
  const lines = Array.from(
    { length: 400 },
    (_, i) => `line ${i} ${"-".repeat(30)} ::x \x1b]0;t\x07`,
  );
  const excerpt = backupCiExcerpt(lines);
  assert(new TextEncoder().encode(excerpt).length <= 8192);
  assert(excerpt.startsWith("[... earlier lines cut ...]"));
  assert(excerpt.endsWith(`line 399 ${"-".repeat(30)} :\u200b:x `));
  assert(!excerpt.includes("::") && !excerpt.includes("\x1b]"));
});

const step = (
  index: number,
  over: Partial<BackupCiPlannedStepV1> = {},
): BackupCiPlannedStepV1 => ({
  index,
  actStepId: String(index),
  kind: "run",
  uses: null,
  condition: "none",
  continueOnError: false,
  ...over,
});
const UNIT = {
  job: { key: "deno", matrix: null, capMinutes: 30, targetTimeoutMinutes: 30 },
  steps: [
    step(0, { kind: "uses_remote", uses: "actions/checkout@v6" }),
    step(1, { kind: "uses_remote", uses: "acme/lint@v1" }),
    step(2),
    step(3, { condition: "status_only" }),
    step(4, { continueOnError: true }),
  ],
};
const rec = (over: Partial<BackupCiActRecordV1>): BackupCiActRecordV1 => ({
  jobID: "deno",
  matrix: {},
  stage: "Main",
  stepID: null,
  stepResult: null,
  jobResult: null,
  msg: null,
  ...over,
});
const stepRec = (id: string, result: string, stage = "Main") =>
  rec({ stepID: [id], stepResult: result, stage });
const job = (result: string) => rec({ jobResult: result });
const ok = (results: string[]) => results.map((r, i) => stepRec(String(i), r));

Deno.test("classification: success needs every planned step and exit 0", () => {
  const green = [
    ...ok(["success", "success", "success", "skipped", "failure"]),
    job("success"),
  ];
  assert.deepEqual(
    classifyActRun(UNIT, green, { code: 0, timedOut: false }).outcome,
    "success",
  );
  // A success that disagrees with the exit status or misses a step.
  assert.equal(
    classifyActRun(UNIT, green, { code: 1, timedOut: false }).reason,
    "act_inconsistent",
  );
  const missing = [
    ...ok(["success", "success", "success", "skipped"]),
    job("success"),
  ];
  assert.equal(
    classifyActRun(UNIT, missing, { code: 0, timedOut: false }).reason,
    "act_inconsistent",
  );
  // A skipped step without a status-only condition, or a failure alongside success.
  const skipped = [
    ...ok(["success", "success", "skipped", "skipped", "success"]),
    job("success"),
  ];
  assert.equal(
    classifyActRun(UNIT, skipped, { code: 0, timedOut: false }).reason,
    "act_inconsistent",
  );
  const failed = [
    ...ok(["success", "success", "failure", "success", "success"]),
    job("success"),
  ];
  assert.equal(
    classifyActRun(UNIT, failed, { code: 0, timedOut: false }).reason,
    "act_inconsistent",
  );
});

Deno.test("classification: a target failure is red (127 included)", () => {
  const red = [...ok(["success", "success", "failure"]), job("failure")];
  const out = classifyActRun(UNIT, red, { code: 127, timedOut: false });
  assert.equal(out.outcome, "failure");
  assert.equal(out.failingStep, 2);
  assert.deepEqual(out.steps.map((s) => s.result), [
    "success",
    "success",
    "failure",
    "missing",
    "missing",
  ]);
  const lint = [...ok(["success", "failure"]), job("failure")];
  assert.equal(
    classifyActRun(UNIT, lint, { code: 1, timedOut: false }).failingStep,
    1,
  );
  assert.equal(
    classifyActRun(UNIT, red, { code: 0, timedOut: false }).reason,
    "act_inconsistent",
  );
});

Deno.test("classification: an allowlisted setup action failing is no evidence", () => {
  const setup = [...ok(["failure"]), job("failure")];
  assert.equal(
    classifyActRun(UNIT, setup, { code: 1, timedOut: false }).reason,
    "setup_action_failed",
  );
  const post = [
    ...ok(["success", "success", "success", "skipped", "success"]),
    stepRec("0", "failure", "Post"),
    job("failure"),
  ];
  assert.equal(
    classifyActRun(UNIT, post, { code: 1, timedOut: false }).reason,
    "setup_action_failed",
  );
});

Deno.test("classification: timeouts, act errors, skipped jobs and stray records", () => {
  assert.equal(
    classifyActRun(UNIT, ok(["success"]), { code: 1, timedOut: true }).outcome,
    "timed_out",
  );
  const longer = {
    ...UNIT,
    job: { ...UNIT.job, capMinutes: 60, targetTimeoutMinutes: null },
  };
  assert.equal(
    classifyActRun(longer, [], { code: 1, timedOut: true }).reason,
    "runner_timeout",
  );
  assert.equal(
    classifyActRun(UNIT, [], { code: 1, timedOut: false }).reason,
    "act_internal",
  );
  const other = [rec({ jobID: "lint", jobResult: "success" })];
  assert.equal(
    classifyActRun(UNIT, other, { code: 0, timedOut: false }).reason,
    "act_internal",
  );
  assert.equal(
    classifyActRun(UNIT, [job("skipped")], { code: 0, timedOut: false }).reason,
    "skipped_in_backup",
  );
  assert.equal(
    classifyActRun(UNIT, ok(["success"]), { code: 0, timedOut: false }).reason,
    "skipped_in_backup",
  );
  const twice = [
    ...ok(["success", "success", "success", "skipped", "success"]),
    job("success"),
    job("success"),
  ];
  assert.equal(
    classifyActRun(UNIT, twice, { code: 0, timedOut: false }).reason,
    "skipped_in_backup",
  );
  const conflict = [
    ...ok(["success", "success", "success", "skipped", "success"]),
    stepRec("2", "failure"),
    job("success"),
  ];
  assert.equal(
    classifyActRun(UNIT, conflict, { code: 0, timedOut: false }).reason,
    "act_inconsistent",
  );
  const matrixUnit = { ...UNIT, job: { ...UNIT.job, matrix: { os: "linux" } } };
  const wrongMatrix = [
    ...ok(["success", "success", "success", "skipped", "success"]),
    job("success"),
  ].map((r) => ({ ...r, matrix: { os: "mac" } }));
  assert.equal(
    classifyActRun(matrixUnit, wrongMatrix, { code: 0, timedOut: false })
      .reason,
    "act_internal",
  );
});

Deno.test("act JSON lines parse to the structured fields only", () => {
  assert.deepEqual(
    parseActJsonLine(
      '{"level":"info","jobID":"deno","matrix":{},"stage":"Main","stepID":["1"],"stepResult":"success","msg":"ok","time":"t"}',
    ),
    {
      jobID: "deno",
      matrix: {},
      stage: "Main",
      stepID: ["1"],
      stepResult: "success",
      jobResult: null,
      msg: "ok",
    },
  );
  assert.equal(parseActJsonLine("plain text"), null);
  assert.equal(parseActJsonLine("{broken"), null);
  assert.equal(parseActJsonLine("[1]"), null);
});

Deno.test("pins: placeholders and young releases are refused", async () => {
  const committed = JSON.parse(
    await Deno.readTextFile("ops/backup-ci-pins.json"),
  );
  const valid = {
    act: {
      version: "v0.2.82",
      releasedAt: "2026-09-01",
      asset: "act_Linux_x86_64.tar.gz",
      sha256: "c".repeat(64),
    },
    node: "24.19.0",
  };
  const pins = parseBackupCiPins(valid);
  assert(pins !== null);
  assert.match(backupCiRunnerId(pins), /^[0-9a-f]{16}$/);
  assert.notEqual(
    backupCiRunnerId(pins),
    backupCiRunnerId({ ...pins, node: "24.20.0" }),
  );
  const now = Date.parse("2026-10-25T00:00:00Z");
  assert.equal(backupCiPinsUsable(pins, now), true);
  assert.equal(
    backupCiPinsUsable({
      ...pins,
      act: { ...pins.act, releasedAt: "2026-10-20" },
    }, now),
    false,
  );
  for (
    const bad of [
      { ...valid, act: { ...valid.act, version: "vX.Y.Z" } },
      { ...valid, act: { ...valid.act, sha256: "<64 hex>" } },
      { ...valid, act: { ...valid.act, releasedAt: "YYYY-MM-DD" } },
      { ...valid, act: { ...valid.act, asset: "act_Darwin.tar.gz" } },
      { ...valid, extra: 1 },
    ]
  ) assert.equal(parseBackupCiPins(bad), null);
  // The committed file is either a filled pin at least 14 days old or the
  // marked placeholder, which fails closed (the leg refuses to install act
  // and the trusted pass plans nothing).
  const parsed = parseBackupCiPins(committed);
  if (parsed === null) {
    assert.match(committed.act.version, /^UNFILLED/);
    assert.match(committed.act.sha256, /^UNFILLED/);
  } else assert.equal(backupCiPinsUsable(parsed, Date.now()), true);
});
