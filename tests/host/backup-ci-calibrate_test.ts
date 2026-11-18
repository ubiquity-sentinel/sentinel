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
  backupCiDemandDefinitions,
  backupCiDemandKeys,
  backupCiSamplingBudget,
  backupCiTrustedSamplePull,
  sampleBackupCiCheck,
} from "../../ops/backup-ci-calibrate.ts";
import { backupCiPinnedCheckout } from "../../ops/backup-ci-compare.ts";
import type { BackupCiNativeRunV1 } from "../../ops/backup-ci-history-reads.ts";
import type {
  BackupCiPullV1,
  BackupCiTargetReadsV1,
} from "../../ops/backup-ci-plan-reads.ts";
import {
  CHECK,
  checkCalibration,
  checkDefinitions,
  commitFile,
  definitionOf,
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
  /** Pull requests by number (absent: a merged same-repository one). */
  pulls?: Map<number, BackupCiPullV1 | null>;
  calls: string[];
}

function pullOf(
  number: number,
  over: Partial<BackupCiPullV1> = {},
): BackupCiPullV1 {
  const side = (sha: string) => ({
    sha,
    ref: "fix",
    repo: {
      full_name: REPO,
      name: REPO.split("/")[1],
      owner: { login: REPO.split("/")[0] },
    },
  });
  return {
    number,
    state: "closed",
    draft: false,
    user: "someone",
    userId: 99,
    merged: true,
    head: side(sha(5)),
    base: side(sha(6)),
    ...over,
  };
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
    pull: (number: number) => {
      f.calls.push(`pull:${number}`);
      return Promise.resolve(
        f.pulls === undefined ? pullOf(number) : f.pulls.get(number) ?? null,
      );
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

/** One pull_request run of `head` whose checkout log binds `base` and #42. */
function prFake(checkout: string, over: Partial<Fake> = {}): Fake {
  const run = nativeRun(5, "failure", {
    event: "pull_request",
    headBranch: "fix/5",
  });
  const log = [
    `##[group]Run ${checkout}`,
    "/usr/bin/git checkout --progress --force refs/remotes/pull/42/merge",
    `HEAD is now at 1a2b3c4 Merge ${sha(5)} into ${sha(6)}`,
    "##[group]Run deno test",
  ].join("\n");
  return {
    pages: [[run]],
    jobs: new Map([[run.id, [startedJob(run.id, sha(5), "failure")]]]),
    logs: new Map([[run.id + 100_000, log]]),
    calls: [],
    ...over,
  };
}

Deno.test("2026-11-18: a pull_request sample needs a merged pull request or the owner's or App's own", async () => {
  const OWNER = { user: "0x4007", userId: 4975670 };
  const APP = { user: "ubiquity-sentinel[bot]", userId: 319834869 };
  const open = { state: "open", merged: false };
  const cases: [string, BackupCiPullV1 | null, string][] = [
    ["merged, any same-repository author", pullOf(42), "sampling"],
    [
      "the owner's open pull request",
      pullOf(42, { ...open, ...OWNER }),
      "sampling",
    ],
    [
      "the App's open pull request",
      pullOf(42, { ...open, ...APP }),
      "sampling",
    ],
    ["another author's open pull request", pullOf(42, open), "untrusted_pull"],
    [
      "the owner's login under another id (renamed account)",
      pullOf(42, { ...open, user: "0x4007", userId: 1 }),
      "untrusted_pull",
    ],
    [
      "the App's login without an answered id",
      pullOf(42, { ...open, user: APP.user, userId: null }),
      "untrusted_pull",
    ],
    [
      "a merged pull request whose head is another repository",
      {
        ...pullOf(42),
        head: {
          ...pullOf(42).head,
          repo: { ...pullOf(42).head.repo, full_name: "someone/fork" },
        },
      },
      "untrusted_pull",
    ],
    ["an unreadable pull request", null, "untrusted_pull"],
  ];
  for (const [name, pull, reason] of cases) {
    const f = prFake("actions/checkout@v4", { pulls: new Map([[42, pull]]) });
    const out = await sample(f, { key: PR });
    assert.equal(out.reason, reason, name);
    assert.equal(out.candidates.length, reason === "sampling" ? 1 : 0, name);
    // The pull request is read before the compare, and never twice.
    assert.equal(f.calls.filter((c) => c === "pull:42").length, 1, name);
    assert.equal(f.calls.includes("compare"), reason === "sampling", name);
  }
  assert.equal(backupCiTrustedSamplePull(pullOf(7), REPO, 8), false);
});

Deno.test("2026-11-18: the native checkout must be actions/checkout at a release tag or full SHA", async () => {
  for (
    const ok of [
      "actions/checkout@v4",
      "actions/checkout@v4.2",
      "actions/checkout@v4.2.2",
      `actions/checkout@${"ab".repeat(20)}`,
    ]
  ) {
    assert.equal(backupCiPinnedCheckout(ok), true, ok);
    const out = await sample(prFake(ok), { key: PR });
    assert.equal(out.reason, "sampling", ok);
  }
  for (
    const refused of [
      "actions/checkout@main",
      "actions/checkout@releases/v4",
      "actions/checkout@v4-beta",
      `actions/checkout@${"ab".repeat(10)}`,
      "someone/checkout@v4",
    ]
  ) {
    assert.equal(backupCiPinnedCheckout(refused), false, refused);
    const f = prFake(refused);
    const out = await sample(f, { key: PR });
    assert.deepEqual(out, { candidates: [], reason: "unbound" }, refused);
    assert(!f.calls.some((c) => c.startsWith("pull:")), refused);
  }
});

Deno.test("2026-11-18: pull request reads are bounded per pass", async () => {
  const runs = [6, 7].map((n) =>
    nativeRun(n, "failure", { event: "pull_request", headBranch: `fix/${n}` })
  );
  const log = (n: number) =>
    [
      "##[group]Run actions/checkout@v4",
      `/usr/bin/git checkout --progress --force refs/remotes/pull/${n}/merge`,
      `HEAD is now at 1a2b3c4 Merge ${sha(n)} into ${sha(1)}`,
      "##[group]Run deno test",
    ].join("\n");
  const f: Fake = {
    pages: [runs],
    jobs: new Map(runs.map((r) => [
      r.id,
      [startedJob(r.id, r.headSha, "failure")],
    ])),
    logs: new Map(runs.map((r, i) => [r.id + 100_000, log(6 + i)])),
    pulls: new Map([[6, pullOf(6, { merged: false })], [7, pullOf(7)]]),
    calls: [],
  };
  const budget = { ...backupCiSamplingBudget(), pullReads: 1 };
  const out = await sampleBackupCiCheck({
    key: PR,
    repository: REPO,
    defaultBranch: "main",
    runnerId: RUNNER,
    checks: null,
    reads: fakeReads(f),
    file: () => Promise.resolve(null),
    budget,
    want: 1,
  });
  assert.deepEqual(out, { candidates: [], reason: "budget" });
  assert.deepEqual(f.calls.filter((c) => c.startsWith("pull:")), ["pull:6"]);
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

Deno.test("2026-11-18: a check calibrated only under an older definition keeps sampling", async () => {
  // The demand head plans a stand-in of the current definition (BLOB).
  const head = commitFile([dispatched(unit(key()))]);
  const demanded = backupCiDemandDefinitions([head], "on", PUSH);
  assert.deepEqual(demanded, [definitionOf()]);
  const runs = [nativeRun(1, "failure"), nativeRun(2, "success")];
  const fake = (): Fake => ({
    pages: [runs],
    jobs: new Map(runs.map((r) => [
      r.id,
      [startedJob(r.id, r.headSha, r.conclusion)],
    ])),
    calls: [],
  });
  const run = (file: ReturnType<typeof checkDefinitions> | null) =>
    sampleBackupCiCheck({
      key: PUSH,
      repository: REPO,
      defaultBranch: "main",
      runnerId: RUNNER,
      // Five agreements with a red on the check, whatever the definition.
      checks: checkCalibration([{ context: "push" }]),
      definitions: { file, demanded },
      reads: fakeReads(fake()),
      file: () => Promise.resolve(null),
      budget: backupCiSamplingBudget(),
      want: 1,
    });
  // All agreements were made under another workflow blob: sample again,
  // and the current definition still needs its red first.
  const older = await run(checkDefinitions([{
    context: "push",
    definition: definitionOf(sha(0xdead)),
  }]));
  assert.equal(older.reason, "sampling");
  assert.deepEqual(older.candidates.map((c) => [c.commit, c.red]), [[
    sha(1),
    true,
  ]]);
  assert.equal((await run(null)).reason, "sampling");
  // Calibrated under the demanded definition: nothing to sample.
  assert.deepEqual(await run(checkDefinitions([{ context: "push" }])), {
    candidates: [],
    reason: "calibrated",
  });
  // A result names its binding's definition, as a planned unit does.
  assert.deepEqual(
    backupCiDemandDefinitions([commitFile([result(key())])], "on", PUSH),
    [definitionOf()],
  );
});
