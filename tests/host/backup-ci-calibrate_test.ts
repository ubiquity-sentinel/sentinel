/**
 * Automatic calibration per demanded check (review MUST 2, 3, 4; probes P3,
 * P4, P6): demand comes only from planned stand-ins that are not finally
 * refused; history is one workflow file and event, never-started billing
 * runs are skipped without a read or a leg and sampling pages back; a
 * pull_request run counts only when its own checkout binds a base that is an
 * ancestor of its head; another runner's entries never hide a commit; every
 * leg started counts toward the caps. Fakes only.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  BACKUP_CI_CALIBRATION_LEGS_PATH,
  backupCiCalibrationLegsToday,
  type BackupCiCheckCalibrationV1,
  parseBackupCiCalibrationLegs,
} from "../../src/contracts/backup-ci-trust.ts";
import { backupCiStoreChanges } from "../../ops/backup-ci-dispatch.ts";
import type { BackupCiPassFileV1 } from "../../ops/backup-ci-pass.ts";
import type { BackupCiStoreView } from "../../ops/backup-ci-store-writer.ts";
import {
  backupCiDemandKeys,
  backupCiSamplingBudget,
  sampleBackupCiCheck,
} from "../../ops/backup-ci-calibrate.ts";
import type { BackupCiNativeRunV1 } from "../../ops/backup-ci-history-reads.ts";
import type { BackupCiTargetReadsV1 } from "../../ops/backup-ci-plan-reads.ts";
import {
  CHECK,
  checkCalibration,
  commitFile,
  dispatched,
  key,
  noEvidence,
  REPO,
  REPOSITORY,
  result,
  RUNNER,
  RUNNER2,
  T0,
  unit,
  WORKFLOW,
} from "../github/backup-ci-fixtures.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0") as GitSha;
const PUSH = {
  context: "push" as const,
  workflowPath: WORKFLOW,
  checkName: CHECK,
};
const PR = { ...PUSH, context: "pull_request" as const };

Deno.test("P3: only a planned, not finally refused stand-in is calibration demand", () => {
  const refusalOnly = commitFile([
    noEvidence(key({ context: "pull_request" }), {
      reason: "unsupported:secrets_or_vars",
      final: true,
    } as never),
  ]);
  assert.deepEqual(backupCiDemandKeys([refusalOnly], "on"), []);
  const planned = commitFile([
    dispatched(unit(key({ context: "pull_request" }))),
  ]);
  assert.deepEqual(backupCiDemandKeys([planned], "on"), [PR]);
  // A key finally refused on the same head is no demand either.
  const both = commitFile([
    dispatched(unit(key({ context: "pull_request" }))),
    noEvidence(key({ context: "pull_request", attempt: 2 }), {
      reason: "unsupported:checkout_inputs",
      final: true,
    } as never),
  ]);
  assert.deepEqual(backupCiDemandKeys([both], "on"), []);
  // A shadow-mode entry is no demand of mode on.
  assert.deepEqual(
    backupCiDemandKeys([
      commitFile([dispatched(unit(key(), { mode: "shadow" }))]),
    ], "on"),
    [],
  );
});

function nativeRun(
  n: number,
  conclusion: string,
  over: Partial<BackupCiNativeRunV1> = {},
): BackupCiNativeRunV1 {
  return {
    id: 7000 + n,
    headSha: sha(n),
    event: "push",
    headBranch: "main",
    path: WORKFLOW,
    headRepository: REPO,
    conclusion,
    startedAt: T0,
    updatedAt: T0 + 300_000,
    ...over,
  };
}

function startedJob(runId: number, head: GitSha, conclusion: string) {
  return {
    id: runId + 100_000,
    name: CHECK,
    head_sha: head,
    status: "completed",
    conclusion,
    runner_id: 3,
    steps: [{ name: "Set up job", number: 1, conclusion: "success" }],
  };
}

interface Fake {
  pages: BackupCiNativeRunV1[][];
  jobs: Map<number, Record<string, unknown>[]>;
  logs?: Map<number, string>;
  compare?: { status: string; behindBy: number };
  calls: string[];
}

function fakeReads(f: Fake): BackupCiTargetReadsV1 {
  return {
    workflowRuns: (_p: string, _e: string, _b: string | null, page: number) => {
      f.calls.push(`runs:${page}`);
      return Promise.resolve(f.pages[page - 1] ?? []);
    },
    runJobs: (id: number) => {
      f.calls.push(`jobs:${id}`);
      return Promise.resolve(f.jobs.get(id) ?? []);
    },
    jobLogPrefix: (id: number) => {
      f.calls.push(`log:${id}`);
      return Promise.resolve(f.logs?.get(id) ?? null);
    },
    compare: () => {
      f.calls.push("compare");
      return Promise.resolve(f.compare ?? { status: "ahead", behindBy: 0 });
    },
  } as unknown as BackupCiTargetReadsV1;
}

function sample(
  f: Fake,
  over: {
    checks?: BackupCiCheckCalibrationV1 | null;
    runnerId?: string;
    files?: Map<string, ReturnType<typeof commitFile>>;
    want?: number;
    key?: typeof PUSH | typeof PR;
  } = {},
) {
  return sampleBackupCiCheck({
    key: over.key ?? PUSH,
    repository: REPO,
    defaultBranch: "main",
    runnerId: over.runnerId ?? RUNNER,
    checks: over.checks ?? null,
    reads: fakeReads(f),
    file: (c) => Promise.resolve(over.files?.get(c) ?? null),
    budget: backupCiSamplingBudget(),
    want: over.want ?? 1,
  });
}

Deno.test("MUST 4: never-started billing runs are skipped without a read and sampling pages back", async () => {
  // Page 1: the outage, failed runs that ended within seconds.
  const outage = Array.from(
    { length: 50 },
    (_, i) => nativeRun(100 + i, "failure", { updatedAt: T0 + 4_000 }),
  );
  const history = [nativeRun(1, "success"), nativeRun(2, "failure")];
  const f: Fake = {
    pages: [outage, history],
    jobs: new Map(history.map((r) => [
      r.id,
      [startedJob(r.id, r.headSha, r.conclusion)],
    ])),
    calls: [],
  };
  const out = await sample(f);
  assert.equal(out.reason, "sampling");
  // The row still needs a red: the red comes first.
  assert.deepEqual(out.candidates.map((c) => [c.commit, c.red]), [[
    sha(2),
    true,
  ]]);
  assert.deepEqual(f.calls.filter((c) => c.startsWith("runs")), [
    "runs:1",
    "runs:2",
  ]);
  assert(
    f.calls.filter((c) => c.startsWith("jobs")).every((c) =>
      history.some((r) => c === `jobs:${r.id}`)
    ),
    "no job read was spent on the outage",
  );
});

Deno.test("a job that never started, a fork or another branch is never a sample", async () => {
  const runs = [
    nativeRun(1, "failure"),
    nativeRun(2, "success", { headRepository: "someone/fork" }),
    nativeRun(3, "success", { headBranch: "feature" }),
    nativeRun(4, "success", { path: ".github/workflows/other.yml" }),
  ];
  const f: Fake = {
    pages: [runs],
    jobs: new Map([[runs[0].id, [{
      ...startedJob(runs[0].id, sha(1), "failure"),
      steps: [],
      runner_id: 0,
    }]]]),
    calls: [],
  };
  const out = await sample(f);
  assert.deepEqual(out, { candidates: [], reason: "no_native_history" });
});

Deno.test("P6: another runner's entries never hide a commit; this runner's do", async () => {
  const runs = [nativeRun(1, "failure"), nativeRun(2, "success")];
  const f = (): Fake => ({
    pages: [runs],
    jobs: new Map(runs.map((r) => [
      r.id,
      [startedJob(r.id, r.headSha, r.conclusion)],
    ])),
    calls: [],
  });
  const settled = new Map([[
    sha(1),
    commitFile([{
      ...result(key(), { conclusion: "failure" }),
      purpose: "calibration" as const,
    }], { commit: sha(1) }),
  ]]);
  // A new runner (after a leg revision) samples the same red.
  const fresh = await sample(f(), { runnerId: RUNNER2, files: settled });
  assert.deepEqual(fresh.candidates.map((c) => c.commit), [sha(1)]);
  // The runner that settled it (its row holds that red) moves on to a green.
  const same = await sample(f(), {
    files: settled,
    checks: checkCalibration([{ context: "push", greens: 0, reds: 1 }]),
  });
  assert.deepEqual(same.candidates.map((c) => [c.commit, c.red]), [[
    sha(2),
    false,
  ]]);
  // Without a red in reach, greens are not spent on an uncompletable row.
  const noRed = await sample(f(), { files: settled });
  assert.deepEqual(noRed, { candidates: [], reason: "no_native_red" });
});

Deno.test("a pull_request run counts only when its checkout binds an ancestor base", async () => {
  const head = sha(5);
  const base = sha(6);
  const run = nativeRun(5, "failure", {
    event: "pull_request",
    headBranch: "fix/5",
  });
  const jobId = run.id + 100_000;
  const log = [
    "##[group]Run actions/checkout@v4",
    "/usr/bin/git checkout --progress --force refs/remotes/pull/42/merge",
    `HEAD is now at 1a2b3c4 Merge ${head} into ${base}`,
    "##[group]Run deno test",
  ].join("\n");
  const fake = (over: Partial<Fake> = {}): Fake => ({
    pages: [[run]],
    jobs: new Map([[run.id, [startedJob(run.id, head, "failure")]]]),
    logs: new Map([[jobId, log]]),
    calls: [],
    ...over,
  });
  const bound = await sample(fake(), { key: PR });
  assert.deepEqual(bound.candidates, [{
    commit: head,
    key: { ...PR, base },
    pullRequest: 42,
    nativeCheckRunId: jobId,
    red: true,
  }]);
  // No readable checkout binding: unbound, nothing planned.
  const unbound = await sample(fake({ logs: new Map() }), { key: PR });
  assert.deepEqual(unbound, { candidates: [], reason: "unbound" });
  // The native merge was not the head's tree (base not an ancestor).
  const merged = await sample(
    fake({ compare: { status: "diverged", behindBy: 2 } }),
    { key: PR },
  );
  assert.deepEqual(merged, { candidates: [], reason: "unbound" });
  // A fork's pull request is never sampled.
  const fork = await sample(
    fake({ pages: [[{ ...run, headRepository: "someone/fork" }]] }),
    { key: PR },
  );
  assert.deepEqual(fork, { candidates: [], reason: "no_native_history" });
});

Deno.test("calibrated, unusable and budget-bound checks sample nothing", async () => {
  const f: Fake = { pages: [], jobs: new Map(), calls: [] };
  assert.deepEqual(await sample(f, { checks: checkCalibration() }), {
    candidates: [],
    reason: "calibrated",
  });
  assert.deepEqual(
    await sample(f, {
      checks: checkCalibration([{ context: "push", falseGreens: 1 }]),
    }),
    { candidates: [], reason: "unusable" },
  );
  assert.deepEqual(f.calls, []);
  const many = Array.from(
    { length: 20 },
    (_, i) => nativeRun(i + 1, "success"),
  );
  const busy: Fake = {
    pages: [many],
    jobs: new Map(
      many.map((r) => [r.id, [startedJob(r.id, r.headSha, "success")]]),
    ),
    calls: [],
  };
  // Greens only while a red is needed: the job-read budget ends the search
  // and nothing is planned for a row that cannot finish.
  const out = await sample(busy, { want: 1 });
  assert.deepEqual(out, { candidates: [], reason: "budget" });
  assert.equal(busy.calls.filter((c) => c.startsWith("jobs")).length, 6);
});

Deno.test("P4: every calibration leg started counts toward the caps", () => {
  const ledger = parseBackupCiCalibrationLegs({
    version: 1,
    kind: "sentinel_backup_ci_calibration_legs",
    legs: [
      {
        repository: "ubiquity/prospector",
        runnerId: RUNNER,
        unitId: "a".repeat(24),
        at: T0,
      },
      {
        repository: "ubiquity/prospector",
        runnerId: RUNNER,
        unitId: "b".repeat(24),
        at: T0 + 1,
      },
      {
        repository: "ubiquity/ai.ubq.fi",
        runnerId: RUNNER,
        unitId: "c".repeat(24),
        at: T0 + 2,
      },
      {
        repository: "ubiquity/ai.ubq.fi",
        runnerId: RUNNER,
        unitId: "d".repeat(24),
        at: T0 - 25 * 3_600_000,
      },
    ],
  });
  assert.equal(backupCiCalibrationLegsToday(ledger, T0 + 10), 3);
  assert.equal(
    backupCiCalibrationLegsToday(ledger, T0 + 10, "ubiquity/prospector"),
    2,
  );
  assert.equal(backupCiCalibrationLegsToday(null, T0), 0);
});

Deno.test("the commit step records every admitted calibration leg in the ledger", async () => {
  const calibrating = { ...unit(), purpose: "calibration" as const };
  const old = {
    repository: "ubiquity/prospector",
    runnerId: RUNNER,
    unitId: "e".repeat(24),
    at: T0 - 50 * 3_600_000,
  };
  const view = new Map<string, unknown>([[
    BACKUP_CI_CALIBRATION_LEGS_PATH,
    { version: 1, kind: "sentinel_backup_ci_calibration_legs", legs: [old] },
  ]]);
  const changes = await backupCiStoreChanges(
    {
      version: 1,
      kind: "sentinel_backup_ci_pass",
      runId: 1,
      launcherSha: "e".repeat(40),
      mode: "on",
      runnerId: RUNNER,
      createdAt: T0,
      files: [],
      comparisons: [],
      units: [],
    } as unknown as BackupCiPassFileV1,
    [
      { repository: REPOSITORY, entry: dispatched(calibrating) },
      { repository: REPOSITORY, entry: dispatched(unit()) },
    ],
    [],
    {
      read: (path: string) => Promise.resolve(view.get(path) ?? null),
    } as unknown as BackupCiStoreView,
    T0,
    () => {},
  );
  const ledger = parseBackupCiCalibrationLegs(
    changes.get(BACKUP_CI_CALIBRATION_LEGS_PATH),
  );
  // The stand-in leg is not a calibration leg; the 50-hour-old one expired.
  assert.deepEqual(ledger.legs, [{
    repository: REPO,
    runnerId: RUNNER,
    unitId: calibrating.unitId,
    at: T0,
  }]);
});
