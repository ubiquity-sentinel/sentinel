/**
 * The trusted ingest of finished legs (docs/backup-ci-spec.md §9.2) over a
 * fake Actions API: the leg lookup (0 or 2 matches, wrong ref, SHA, attempt
 * or actor), the job checks (runner group, labels, step order and windows),
 * the marker (missing, duplicated, outside its window, another unit), the
 * artifact (another run, wrong name, oversized, two entries, a
 * decompression bomb, a digest mismatch), the result binding and runner id,
 * the excerpt cut and sanitization, the native comparison, a stuck leg's
 * cancel, per-unit isolation and the per-target budget; then the commit
 * step's calibration counting and suspensions. All synthetic.
 */
import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import {
  BACKUP_CI_LEG_MISSING_MS,
  BACKUP_CI_LEG_STEPS,
  backupCiBytesDigest,
  type BackupCiResultV1,
  backupCiUnitDigest,
  type BackupCiUnitV1,
} from "../../src/contracts/backup-ci.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { backupCiStoreChanges } from "../../ops/backup-ci-dispatch.ts";
import {
  type BackupCiIngestDepsV1,
  ingestBackupCi,
  ingestBackupCiEntry,
} from "../../ops/backup-ci-ingest.ts";
import type { BackupCiLegReadsV1 } from "../../ops/backup-ci-ingest-reads.ts";
import type { BackupCiPassFileV1 } from "../../ops/backup-ci-pass.ts";
import type { BackupCiTargetReadsV1 } from "../../ops/backup-ci-plan-reads.ts";
import type { BackupCiStoreView } from "../../ops/backup-ci-store-writer.ts";
import {
  dispatched,
  H,
  key,
  LAUNCHER,
  legResult,
  REPO,
  REPOSITORY,
  RUNNER,
  T0,
  unit,
} from "../github/backup-ci-fixtures.ts";

const SENTINEL_ID = 999;
const iso = (at: number) => new Date(at).toISOString();
const ts = (at: number) => iso(at).replace(/\.(\d{3})Z$/, ".$10000Z");
const MIN = 60_000;

type Obj = Record<string, unknown>;

async function zip(entries: [string, Uint8Array][]): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const [name, bytes] of entries) {
    await writer.add(name, new Uint8ArrayReader(bytes), { unixMode: 0o100644 });
  }
  return await writer.close();
}

interface Scenario {
  unit: BackupCiUnitV1;
  runs: Obj[];
  attempt: Obj | null;
  jobs: Obj[] | null;
  log: string | "unserved" | null;
  artifact: Obj | null;
  zip: Uint8Array | null;
  cancelled: number[];
  native: {
    runs: Obj[];
    suites: {
      suiteId: number;
      runId: number;
      workflowPath: string;
      event: string;
    }[];
    jobs: Record<number, Obj>;
  };
  now: number;
  result: BackupCiResultV1;
  resultBytes: Uint8Array;
}

const step = (name: string, start: number, end: number, extra: Obj = {}) => ({
  name,
  status: "completed",
  conclusion: "success",
  number: 1,
  started_at: iso(start),
  completed_at: iso(end),
  ...extra,
});

async function scenario(
  u: BackupCiUnitV1 = unit(),
  over: { result?: Partial<BackupCiResultV1>; logLines?: string[] } = {},
): Promise<Scenario> {
  const result = legResult(u, {
    startedAt: T0 + 3 * MIN + 10_000,
    completedAt: T0 + 7 * MIN,
    ...over.result,
  });
  const resultBytes = new TextEncoder().encode(canonicalStringify(result));
  const archive = await zip([["result.json", resultBytes]]);
  const run = {
    id: 5001,
    display_title: `sentinel-backup-ci-leg ${u.unitId}`,
    path: ".github/workflows/backup-ci-leg.yml",
    event: "workflow_dispatch",
    head_branch: "sentinel-backup-legs",
    head_sha: LAUNCHER,
    head_repository: { full_name: "ubiquity-sentinel/sentinel" },
    repository: { full_name: "ubiquity-sentinel/sentinel" },
    triggering_actor: { login: "github-actions[bot]" },
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
  };
  const marker = JSON.stringify({
    kind: "sentinel_backup_ci_leg_result",
    unitId: u.unitId,
    unitDigest: backupCiUnitDigest(u),
    resultDigest: backupCiBytesDigest(resultBytes),
    artifactId: 7001,
  });
  const log = [
    `${
      ts(T0 + 2 * MIN + 1000)
    } ##[group]Run deno run ops/backup-ci-leg.ts prepare`,
    `${ts(T0 + 3 * MIN + 20_000)} │ [1] running tests`,
    `${ts(T0 + 3 * MIN + 30_000)} │ [0] checkout`,
    ...(over.logLines ?? []),
    `${ts(T0 + 6 * MIN)} │ [1] error: :: test failed ##[x`,
    `${ts(T0 + 9 * MIN + 10_000)} ${marker}`,
  ].join("\n");
  return {
    unit: u,
    runs: [run],
    attempt: { ...run },
    jobs: [{
      id: 6001,
      name: "leg",
      run_attempt: 1,
      head_sha: LAUNCHER,
      status: "completed",
      conclusion: "success",
      runner_group_name: "GitHub Actions",
      labels: ["ubuntu-latest"],
      started_at: iso(T0 + MIN),
      completed_at: iso(T0 + 10 * MIN),
      steps: [
        step("Set up job", T0 + MIN, T0 + MIN + 5000),
        step(BACKUP_CI_LEG_STEPS[0], T0 + 2 * MIN, T0 + 3 * MIN),
        step(BACKUP_CI_LEG_STEPS[1], T0 + 3 * MIN, T0 + 8 * MIN),
        step(BACKUP_CI_LEG_STEPS[2], T0 + 8 * MIN, T0 + 9 * MIN),
        step(BACKUP_CI_LEG_STEPS[3], T0 + 9 * MIN, T0 + 9 * MIN + 30_000),
        step("Complete job", T0 + 9 * MIN + 30_000, T0 + 10 * MIN),
      ],
    }],
    log,
    artifact: {
      id: 7001,
      name: `backup-result-${u.unitId}`,
      expired: false,
      size_in_bytes: archive.length,
      workflow_run: {
        id: 5001,
        head_sha: LAUNCHER,
        repository_id: SENTINEL_ID,
      },
    },
    zip: archive,
    cancelled: [],
    native: { runs: [], suites: [], jobs: {} },
    now: T0 + 20 * MIN,
    result,
    resultBytes,
  };
}

function deps(
  s: Scenario,
  over: Partial<BackupCiIngestDepsV1> = {},
): BackupCiIngestDepsV1 {
  const legs: BackupCiLegReadsV1 = {
    legRuns: () => Promise.resolve(s.runs),
    attempt: () => Promise.resolve(s.attempt),
    jobs: () => Promise.resolve(s.jobs),
    log: () => Promise.resolve(s.log),
    artifact: () => Promise.resolve(s.artifact),
    artifactZip: () => Promise.resolve(s.zip),
    cancel: (id) => {
      s.cancelled.push(id);
      return Promise.resolve(true);
    },
    inflight: () => Promise.resolve(0),
    cellsActive: () => Promise.resolve(false),
  };
  const reads = {
    checkRuns: () => Promise.resolve(s.native.runs),
    suites: () => Promise.resolve(s.native.suites),
    job: (id: number) => Promise.resolve(s.native.jobs[id] ?? null),
  } as unknown as BackupCiTargetReadsV1;
  return {
    legs,
    sentinelId: SENTINEL_ID,
    targetReads: () => reads,
    now: () => s.now,
    sleep: () => Promise.resolve(),
    log: () => {},
    ...over,
  };
}

const item = (s: Scenario) => ({
  repository: REPOSITORY,
  commit: H,
  entry: dispatched(s.unit),
});
async function outcome(s: Scenario, over: Partial<BackupCiIngestDepsV1> = {}) {
  return await ingestBackupCiEntry(deps(s, over), item(s));
}
async function reason(s: Scenario) {
  const out = await outcome(s);
  return out.kind === "no_evidence" ? out.event.reason : out.kind;
}

Deno.test("a verified leg becomes a result entry bound to its unit", async () => {
  const s = await scenario();
  const out = await outcome(s);
  assert(out.kind === "result");
  const e = out.entry;
  assert.equal(e.conclusion, "success");
  assert.equal(e.mode, "evidence");
  assert.equal(e.runnerId, RUNNER);
  assert.equal(e.unitDigest, backupCiUnitDigest(s.unit));
  assert.equal(e.resultDigest, backupCiBytesDigest(s.resultBytes));
  assert.deepEqual(e.leg, {
    runId: 5001,
    jobId: 6001,
    artifactId: 7001,
    launcherSha: LAUNCHER,
  });
  assert.deepEqual(e.binding.parents, s.unit.exec.parents);
  assert.equal(e.failure, null);
  assert.equal(out.comparison, null);
  assert.equal(e.ingestedAt, s.now);
});

Deno.test("leg lookup: missing, duplicated or foreign runs", async () => {
  const s = await scenario();
  s.runs = [];
  s.now = T0 + BACKUP_CI_LEG_MISSING_MS - 1;
  assert.equal(await reason(s), "pending");
  s.now = T0 + BACKUP_CI_LEG_MISSING_MS;
  assert.equal(await reason(s), "leg_missing");
  const base = await scenario();
  base.runs = [base.runs[0], { ...base.runs[0], id: 5002 }];
  assert.equal(await reason(base), "binding_mismatch");
  for (
    const change of [
      { head_branch: "sentinel-supervisor" },
      { head_sha: "9".repeat(40) },
      { triggering_actor: { login: "someone" } },
      { path: ".github/workflows/other.yml" },
      { head_repository: { full_name: "fork/sentinel" } },
      { event: "push" },
    ]
  ) {
    const t = await scenario();
    t.runs = [{ ...t.runs[0], ...change }];
    assert.equal(await reason(t), "binding_mismatch", JSON.stringify(change));
  }
  const attempt = await scenario();
  attempt.attempt = { ...attempt.attempt!, run_attempt: 2 };
  assert.equal(await reason(attempt), "binding_mismatch");
  const other = await scenario();
  other.runs = [{
    ...other.runs[0],
    display_title: "sentinel-backup-ci-leg 000000000000000000000000",
  }];
  other.now = T0 + BACKUP_CI_LEG_MISSING_MS;
  assert.equal(await reason(other), "leg_missing");
});

Deno.test("a leg still running past its bound is cancelled as stuck", async () => {
  const s = await scenario();
  s.attempt = { ...s.attempt!, status: "in_progress" };
  s.now = T0 + (60 + 10 + 30) * MIN - 1;
  assert.equal(await reason(s), "pending");
  assert.deepEqual(s.cancelled, []);
  s.now = T0 + (60 + 10 + 30) * MIN;
  assert.equal(await reason(s), "leg_stuck");
  assert.deepEqual(s.cancelled, [5001]);
});

Deno.test("job checks: conclusion, runner group, labels, step order and windows", async () => {
  const cases: [(job: Obj) => unknown, string][] = [
    [(j) => (j.conclusion = "failure"), "leg_failed"],
    [(j) => (j.conclusion = "cancelled"), "leg_cancelled"],
    [(j) => (j.runner_group_name = "Default"), "binding_mismatch"],
    [(j) => (j.labels = ["self-hosted"]), "binding_mismatch"],
    [(j) => (j.labels = ["ubuntu-latest", "x"]), "binding_mismatch"],
    [(j) => {
      const steps = j.steps as Obj[];
      [steps[2], steps[3]] = [steps[3], steps[2]];
    }, "binding_mismatch"],
    [(j) => ((j.steps as Obj[])[3].conclusion = "failure"), "binding_mismatch"],
    [
      (j) => ((j.steps as Obj[])[4].completed_at = iso(T0 + 30 * MIN)),
      "binding_mismatch",
    ],
    [(j) => ((j.steps as Obj[]).splice(4, 1)), "binding_mismatch"],
    [(j) => (j.name = "other"), "binding_mismatch"],
  ];
  for (const [change, expected] of cases) {
    const s = await scenario();
    change(s.jobs![0]);
    assert.equal(await reason(s), expected, change.toString());
  }
  const two = await scenario();
  two.jobs = [two.jobs![0], { ...two.jobs![0], id: 6002 }];
  assert.equal(await reason(two), "binding_mismatch");
});

Deno.test("the marker must be unique, in the report window and for this unit", async () => {
  const s = await scenario();
  const lines = (s.log as string).split("\n");
  const marker = lines.at(-1)!;
  const cases: [string, string][] = [
    [lines.slice(0, -1).join("\n"), "marker_missing"],
    [[...lines, marker].join("\n"), "marker_missing"],
    [
      [
        ...lines.slice(0, -1),
        marker.replace(ts(T0 + 9 * MIN + 10_000), ts(T0 + 5 * MIN)),
      ].join("\n"),
      "marker_missing",
    ],
    [
      [...lines.slice(0, -1), marker.replace(s.unit.unitId, "0".repeat(24))]
        .join("\n"),
      "digest_mismatch",
    ],
    [
      [
        ...lines.slice(0, -1),
        marker.replace('"artifactId"', '"extra":1,"artifactId"'),
      ].join("\n"),
      "marker_missing",
    ],
  ];
  for (const [log, expected] of cases) {
    const t = await scenario();
    t.log = log;
    assert.equal(await reason(t), expected);
  }
  const unserved = await scenario();
  unserved.log = "unserved";
  assert.equal(await reason(unserved), "log_unserved");
  // A marker-shaped line printed by target code carries the step prefix and
  // never counts.
  const prefixed = await scenario(unit(), {
    logLines: [
      `${ts(T0 + 9 * MIN + 1000)} │ [1] ${
        marker.slice(marker.indexOf(" ") + 1)
      }`,
    ],
  });
  assert.equal((await outcome(prefixed)).kind, "result");
});

Deno.test("the artifact is read by the marker's id and bound to the leg run", async () => {
  const cases: [(s: Scenario) => unknown, string][] = [
    [(s) => (s.artifact = null), "artifact_missing"],
    [(s) => ((s.artifact!.workflow_run as Obj).id = 4999), "artifact_invalid"],
    [
      (s) => ((s.artifact!.workflow_run as Obj).head_sha = "9".repeat(40)),
      "artifact_invalid",
    ],
    [
      (s) => ((s.artifact!.workflow_run as Obj).repository_id = 1),
      "artifact_invalid",
    ],
    [(s) => (s.artifact!.name = "backup-result-other"), "artifact_invalid"],
    [(s) => (s.artifact!.expired = true), "artifact_invalid"],
    [(s) => (s.artifact!.size_in_bytes = 64 * 1024 + 1), "artifact_invalid"],
    [(s) => (s.zip = null), "artifact_missing"],
    [
      async (
        s,
      ) => (s.zip = await zip([["result.json", s.resultBytes], [
        "extra.json",
        s.resultBytes,
      ]])),
      "artifact_invalid",
    ],
    [
      async (s) => (s.zip = await zip([["other.json", s.resultBytes]])),
      "artifact_invalid",
    ],
    [
      async (
        s,
      ) => (s.zip = await zip([["result.json", new Uint8Array(70 * 1024)]])),
      "artifact_invalid",
    ],
    [
      async (
        s,
      ) => (s.zip = await zip([[
        "result.json",
        new TextEncoder().encode("{}"),
      ]])),
      "digest_mismatch",
    ],
  ];
  for (const [change, expected] of cases) {
    const s = await scenario();
    await change(s);
    assert.equal(await reason(s), expected, change.toString());
  }
});

Deno.test("the result must bind the unit, the runner and the run window", async () => {
  const other = "9".repeat(40);
  const cases: [Partial<BackupCiResultV1>, string][] = [
    [
      { observed: { ...legResult().observed, head: other as never } },
      "binding_mismatch",
    ],
    [
      { observed: { ...legResult().observed, workflowBlob: other as never } },
      "binding_mismatch",
    ],
    [
      { runner: { runnerId: "f".repeat(16), imageOs: "u", imageVersion: "1" } },
      "binding_mismatch",
    ],
    [{ startedAt: T0 + MIN }, "result_invalid"],
    [{ completedAt: T0 + 9 * MIN }, "result_invalid"],
    [{
      steps: [{ index: 0, result: "success" }, { index: 1, result: "failure" }],
    }, "act_inconsistent"],
    [{ act: { exitCode: 1, jobResults: 1 } }, "act_inconsistent"],
    [{
      outcome: "failure",
      failingStep: 0,
      steps: [{ index: 0, result: "failure" }, { index: 1, result: "missing" }],
      act: { exitCode: 1, jobResults: 1 },
    }, "act_inconsistent"],
    [{ outcome: "timed_out", failingStep: null }, "act_inconsistent"],
    [
      { outcome: "no_evidence", reason: "setup_action_failed" },
      "setup_action_failed",
    ],
  ];
  for (const [change, expected] of cases) {
    const s = await scenario(unit(), { result: change });
    assert.equal(await reason(s), expected, JSON.stringify(change));
  }
  const s = await scenario();
  s.zip = await zip([["result.json", new TextEncoder().encode("not json")]]);
  const marker = (s.log as string).split("\n").at(-1)!;
  s.log = (s.log as string).replace(
    marker,
    marker.replace(
      backupCiBytesDigest(s.resultBytes),
      backupCiBytesDigest(new TextEncoder().encode("not json")),
    ),
  );
  assert.equal(await reason(s), "result_invalid");
});

Deno.test("a red keeps a sanitized excerpt of its failing step only", async () => {
  const s = await scenario(unit(), {
    result: {
      outcome: "failure",
      failingStep: 1,
      steps: [{ index: 0, result: "success" }, { index: 1, result: "failure" }],
      act: { exitCode: 1, jobResults: 1 },
    },
    logLines: [`${ts(T0 + 9 * MIN + 1000)} │ [1] after the run window`],
  });
  const out = await outcome(s);
  assert(out.kind === "result" && out.entry.conclusion === "failure");
  assert.deepEqual(out.entry.failure, {
    stepIndex: 1,
    excerpt: "running tests\nerror: :\u200b: test failed #\u200b#[x",
  });
  assert.equal(out.comparison, null, "attempt 1 red is provisional");
});

Deno.test("a final conclusion is compared with a native started run", async () => {
  const native = (conclusion: string, started: boolean) => ({
    runs: [{
      id: 801,
      name: "deno",
      app: { slug: "github-actions" },
      check_suite: { id: 31 },
      status: "completed",
      conclusion,
      started_at: iso(T0),
    }],
    suites: [{
      suiteId: 31,
      runId: 41,
      workflowPath: ".github/workflows/ci.yml",
      event: "push",
    }],
    jobs: {
      801: {
        id: 801,
        head_sha: H,
        status: "completed",
        conclusion,
        steps: started ? [{}] : [],
        runner_id: started ? 5 : 0,
      },
    },
  });
  const green = await scenario();
  green.native = native("success", true);
  const out = await outcome(green);
  assert(out.kind === "result" && out.comparison !== null);
  assert.deepEqual(out.comparison.sample, {
    commit: H,
    checkName: "deno",
    native: "success",
    backup: "success",
  });
  assert.equal(out.entry.native?.checkRunId, 801);
  const notStarted = await scenario();
  notStarted.native = native("failure", false);
  const skip = await outcome(notStarted);
  assert(
    skip.kind === "result" && skip.comparison === null &&
      skip.entry.native === null,
  );
  const confirm = await scenario(unit(key({ attempt: 2 })), {
    result: {
      outcome: "failure",
      failingStep: 1,
      steps: [{ index: 0, result: "success" }, { index: 1, result: "failure" }],
      act: { exitCode: 1, jobResults: 1 },
    },
  });
  confirm.native = native("success", true);
  const red = await outcome(confirm);
  assert(red.kind === "result" && red.comparison?.sample.backup === "failure");
});

Deno.test("one entry's error is its own; the per-target budget defers the rest", async () => {
  const a = await scenario(unit(key({ checkName: "lint" })));
  const b = await scenario();
  let calls = 0;
  const d = deps(b);
  const items = [
    { ...item(a), entry: { ...dispatched(a.unit), dispatchedAt: T0 - 1 } },
    item(b),
  ];
  const outs = await ingestBackupCi({
    ...d,
    legs: {
      ...d.legs,
      legRuns: () => {
        if (calls++ === 0) throw new Error("boom");
        return Promise.resolve(b.runs);
      },
    },
  }, items);
  assert.equal(outs[0].outcome.kind, "no_evidence");
  assert.equal(
    (outs[0].outcome as { event: { reason: string } }).event.reason,
    "ingest_error",
  );
  assert.equal(outs[1].outcome.kind, "result");
  let clock = T0 + 20 * MIN;
  const slow = await ingestBackupCi({
    ...deps(b),
    now: () => (clock += 40_000),
  }, [item(b), item(b), item(b)]);
  assert.deepEqual(slow.map((o) => o.outcome.kind), [
    "result",
    "pending",
    "pending",
  ]);
  const many = await ingestBackupCi(
    deps(b),
    Array.from({ length: 40 }, () => item(b)),
  );
  assert.equal(many.length, 32);
});

/** A store view holding exactly `files`. */
function view(files: Record<string, unknown> = {}): BackupCiStoreView {
  return {
    read: (path: string) => Promise.resolve(files[path] ?? null),
  } as unknown as BackupCiStoreView;
}

Deno.test("calibration counts agreements; a false green suspends the runner", async () => {
  const comparison = (
    backup: "success" | "failure",
    native: string,
    commit: string,
  ) => ({
    runnerId: RUNNER,
    sample: { commit: commit as never, checkName: "deno", native, backup },
    nativeCheckRunId: 801,
    receipt: `bci1:${REPO}@${commit.slice(0, 12)}:x`,
  });
  const pass = (
    comparisons: ReturnType<typeof comparison>[],
  ): BackupCiPassFileV1 => ({
    version: 1,
    kind: "sentinel_backup_ci_pass",
    runId: 1,
    launcherSha: LAUNCHER,
    mode: "on",
    runnerId: RUNNER,
    createdAt: T0,
    files: [],
    comparisons: [{ repository: REPOSITORY, comparisons }],
    units: [],
  });
  const lines: string[] = [];
  const agree = await backupCiStoreChanges(
    pass([
      comparison("success", "success", "1".repeat(40)),
      comparison("failure", "failure", "2".repeat(40)),
    ]),
    [],
    [],
    view(),
    T0,
    (l) => lines.push(l),
  );
  const calibration = agree.get(`v1/${REPO}/calibration.json`) as {
    runners: { agreements: number; failureAgreements: number }[];
  };
  assert.equal(calibration.runners[0].agreements, 2);
  assert.equal(calibration.runners[0].failureAgreements, 1);
  assert(!agree.has(`v1/${REPO}/suspended.json`));
  const falseGreen = await backupCiStoreChanges(
    pass([comparison("success", "failure", "3".repeat(40))]),
    [],
    [],
    view(),
    T0,
    (l) => lines.push(l),
  );
  const suspension = falseGreen.get(`v1/${REPO}/suspended.json`) as {
    runnerIds: string[];
    reason: string;
    scope: string;
  };
  assert.deepEqual(suspension.runnerIds, [RUNNER]);
  assert.equal(suspension.reason, "false_green");
  assert.equal(suspension.scope, REPO);
  assert(lines.some((l) => l.startsWith("sentinel_backup_ci_suspension")));
  const oneRed = await backupCiStoreChanges(
    pass([comparison("failure", "success", "4".repeat(40))]),
    [],
    [],
    view(),
    T0,
    () => {},
  );
  assert(!oneRed.has(`v1/${REPO}/suspended.json`));
  const twoReds = await backupCiStoreChanges(
    pass([
      comparison("failure", "success", "4".repeat(40)),
      comparison("failure", "success", "5".repeat(40)),
    ]),
    [],
    [],
    view(),
    T0,
    () => {},
  );
  assert.equal(
    (twoReds.get(`v1/${REPO}/suspended.json`) as { reason: string }).reason,
    "false_red",
  );
});
