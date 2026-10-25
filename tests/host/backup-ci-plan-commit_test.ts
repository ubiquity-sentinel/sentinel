/**
 * The per-commit planner and the whole trusted pass
 * (docs/backup-ci-spec.md §9.3 steps 1-5, §9.4) with real git against a
 * temporary target remote and fake GitHub reads: a pull request unit runs
 * on M = [B, H]; a push unit on the commit; `head_not_on_base`,
 * `pr_not_open` and `pr_moved` refuse; the billing annotation is required;
 * started groups plan nothing for a stand-in but calibration and peer
 * units; a confirmation re-plans its key as attempt 2; dedupe skips a final
 * key; coverage rows are recorded. The pass bounds commit reads per target,
 * selects `free` units and writes their deterministic trees. Synthetic.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  backupCiCommitPath,
  backupCiUnitDigest,
  parseBackupCiUnit,
} from "../../src/contracts/backup-ci.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  createBackupCiGit,
  fetchBackupCiBare,
  fileSha256,
} from "../../ops/backup-ci-materialize.ts";
import {
  type BackupCiCommitInputV1,
  planBackupCiCommit,
} from "../../ops/backup-ci-pass-commit.ts";
import {
  BackupCiPassChanges,
  type BackupCiPassDepsV1,
  runBackupCiPass,
} from "../../ops/backup-ci-pass.ts";
import type { BackupCiCandidateV1 } from "../../ops/backup-ci-plan.ts";
import type {
  BackupCiPullV1,
  BackupCiTargetReadsV1,
} from "../../ops/backup-ci-plan-reads.ts";
import { workRecord } from "../state/helpers.ts";
import { commitFile, result, RUNNER } from "../github/backup-ci-fixtures.ts";
import {
  PASSPORT_WORKFLOW,
  targetRepo,
  type TargetRepoV1,
  WORKFLOW_PATH,
} from "./backup-ci-test-repo.ts";

const T0 = Date.parse("2026-10-25T08:00:00Z");
const BILLING =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";
const REPO = { owner: "ubiquity", name: "passport.ubq.fi", id: 812345678 };
const INFO = { id: REPO.id, defaultBranch: "main", private: true };
const NODE_ACTION = new TextEncoder().encode(
  "runs:\n  using: node24\n  main: index.js\n",
);

type Obj = Record<string, unknown>;

interface World {
  repo: TargetRepoV1;
  base: GitSha;
  head: GitSha;
  runs: Map<string, Obj[]>;
  suites: Map<
    string,
    { suiteId: number; runId: number; workflowPath: string; event: string }[]
  >;
  jobs: Map<number, Obj>;
  annotations: Map<number, string[]>;
  pull: BackupCiPullV1 | null;
  compare: { status: string; behindBy: number } | null;
  merge: { parents: string[]; tree: string } | "absent";
  calls: string[];
}

function neverStarted(
  id: number,
  sha: GitSha,
  suite: number,
  name = "deno",
): Obj {
  return {
    id,
    name,
    head_sha: sha,
    status: "completed",
    conclusion: "failure",
    app: { slug: "github-actions" },
    check_suite: { id: suite },
    started_at: new Date(T0).toISOString(),
  };
}

async function world(): Promise<World> {
  const repo = await targetRepo("backup-ci-plan-");
  const base = await repo.commit({
    [WORKFLOW_PATH]: PASSPORT_WORKFLOW,
    "src/a.ts": "export const a = 1;\n",
  });
  const head = await repo.commit({ "src/a.ts": "export const a = 2;\n" });
  const w: World = {
    repo,
    base,
    head,
    runs: new Map([[head, [
      neverStarted(101, head, 31),
      neverStarted(102, head, 32),
    ]]]),
    suites: new Map([[head, [
      { suiteId: 31, runId: 41, workflowPath: WORKFLOW_PATH, event: "push" },
      {
        suiteId: 32,
        runId: 42,
        workflowPath: WORKFLOW_PATH,
        event: "pull_request",
      },
    ]]]),
    jobs: new Map([
      [101, {
        id: 101,
        head_sha: head,
        status: "completed",
        conclusion: "failure",
        steps: [],
        runner_id: 0,
      }],
      [102, {
        id: 102,
        head_sha: head,
        status: "completed",
        conclusion: "failure",
        steps: [],
        runner_id: 0,
      }],
    ]),
    annotations: new Map([[101, [BILLING]], [102, [BILLING]]]),
    pull: {
      number: 7,
      state: "open",
      draft: false,
      user: "ubiquity-sentinel[bot]",
      head: {
        sha: head,
        ref: "sentinel/fix-7",
        repo: {
          full_name: "ubiquity/passport.ubq.fi",
          name: "passport.ubq.fi",
          owner: { login: "ubiquity" },
        },
      },
      base: {
        sha: base,
        ref: "main",
        repo: {
          full_name: "ubiquity/passport.ubq.fi",
          name: "passport.ubq.fi",
          owner: { login: "ubiquity" },
        },
      },
    },
    compare: { status: "ahead", behindBy: 0 },
    merge: "absent",
    calls: [],
  };
  return w;
}

function reads(w: World): BackupCiTargetReadsV1 {
  return {
    repository: () => Promise.resolve(INFO),
    branchTip: () => Promise.resolve(w.base),
    checkRuns(sha, filter) {
      w.calls.push(`checkRuns:${filter}:${sha.slice(0, 7)}`);
      return Promise.resolve(w.runs.get(sha) ?? []);
    },
    suites: (sha) => Promise.resolve(w.suites.get(sha) ?? []),
    statusContexts: () => Promise.resolve(new Set<string>()),
    job: (id) => Promise.resolve(w.jobs.get(id) ?? null),
    annotations: (id) => Promise.resolve(w.annotations.get(id) ?? []),
    pull: () => Promise.resolve(w.pull),
    compare: () => Promise.resolve(w.compare),
    pullMerge: () => Promise.resolve(w.merge),
  };
}

function passDeps(
  w: World,
  over: Partial<BackupCiPassDepsV1> = {},
): BackupCiPassDepsV1 {
  const git = createBackupCiGit(`${w.repo.root}/home`);
  return {
    runId: 9001,
    launcherSha: "e".repeat(40) as GitSha,
    mode: "on",
    runnerId: RUNNER,
    now: () => T0,
    targets: [{ repository: "ubiquity/passport.ubq.fi", id: REPO.id }],
    calibrationCommits: () => [],
    snapshot: null,
    store: {
      read: () => Promise.resolve(null),
      pathsContaining: () => Promise.resolve([]),
    },
    legs: {
      legRuns: () => Promise.resolve([]),
      attempt: () => Promise.resolve(null),
      jobs: () => Promise.resolve(null),
      log: () => Promise.resolve(null),
      artifact: () => Promise.resolve(null),
      artifactZip: () => Promise.resolve(null),
      cancel: () => Promise.resolve(false),
      inflight: () => Promise.resolve(0),
      cellsActive: () => Promise.resolve(false),
    },
    sentinelId: 1,
    targetReads: () => reads(w),
    materialize: (_o, _n, commits, dir) =>
      fetchBackupCiBare({
        git,
        dir,
        remoteUrl: w.repo.url,
        token: null,
        commits,
        protocols: ["file"],
      }),
    actionSource: (local) => ({
      local,
      remote: () => Promise.resolve(NODE_ACTION),
    }),
    workDir: `${w.repo.root}/work`,
    tokenNeedles: [],
    log: () => {},
    sleep: () => Promise.resolve(),
    ...over,
  };
}

function candidate(
  w: World,
  over: Partial<BackupCiCandidateV1> = {},
): BackupCiCandidateV1 {
  return {
    priority: 5,
    commit: w.head,
    purpose: "stand_in",
    recordId: "r1",
    pullRequest: 7,
    base: w.base,
    branch: "sentinel/fix-7",
    key: null,
    attempt: 1,
    ...over,
  };
}

async function plan(
  w: World,
  over: Partial<BackupCiCandidateV1> = {},
  extra: Partial<BackupCiCommitInputV1> = {},
) {
  const changes = new BackupCiPassChanges();
  const units = await planBackupCiCommit({
    deps: passDeps(w),
    repo: REPO,
    info: INFO,
    reads: reads(w),
    candidate: candidate(w, over),
    file: null,
    files: new Map(),
    changes,
    ...extra,
  });
  return {
    units,
    changes,
    file: changes.files.get(
      `ubiquity/passport.ubq.fi@${over.commit ?? w.head}`,
    ),
  };
}

Deno.test("a pull request unit runs on M = [B, H] and covers its push observations", async () => {
  const w = await world();
  try {
    const { units, file } = await plan(w);
    assert.equal(units.length, 1);
    const unit = parseBackupCiUnit(JSON.parse(JSON.stringify(units[0].unit)));
    assert.deepEqual(unit.key, {
      context: "pull_request",
      workflowPath: WORKFLOW_PATH,
      checkName: "deno",
      base: w.base,
      attempt: 1,
    });
    assert.equal(unit.exec.synthetic, true);
    assert.deepEqual(unit.exec.parents, [w.base, w.head]);
    assert.equal(unit.exec.tree, await units[0].bare.treeOf(w.head));
    assert.deepEqual(await units[0].bare.rawParents(unit.exec.commit), [
      w.base,
      w.head,
    ]);
    assert.equal(unit.ref, "refs/pull/7/merge");
    assert.deepEqual(unit.pullRequest, {
      number: 7,
      base: w.base,
      baseRef: "main",
      headRef: "sentinel/fix-7",
    });
    assert.deepEqual(unit.neverStarted, {
      checkRunIds: [101, 102],
      runIds: [41, 42],
      cause: "account_billing",
    });
    assert.equal(unit.native, null);
    assert.equal(unit.job.capMinutes, 30);
    assert.equal((unit.event.pull_request as Obj).number, 7);
    assert.deepEqual(unit.plan, {
      runId: 9001,
      launcherSha: "e".repeat(40),
      plannedAt: T0,
      mode: "on",
      runnerId: RUNNER,
    });
    assert.deepEqual(
      file?.coverage.map((c) => [c.event, c.supported, c.expected]),
      [
        ["pull_request", true, ["deno"]],
        ["push", true, ["deno"]],
      ],
    );
    assert.equal(file?.noEvidence.length, 0);
  } finally {
    await w.repo.close();
  }
});

Deno.test("a push unit runs on the commit itself", async () => {
  const w = await world();
  try {
    const { units } = await plan(w, {
      pullRequest: null,
      base: null,
      branch: "main",
    });
    assert.equal(units.length, 1);
    const unit = units[0].unit;
    assert.equal(unit.key.context, "push");
    assert.deepEqual(unit.exec, {
      commit: w.head,
      parents: [w.base],
      tree: unit.exec.tree,
      synthetic: false,
    });
    assert.equal(unit.ref, "refs/heads/main");
    assert.equal(unit.event.before, w.base);
    assert.equal(unit.event.after, w.head);
  } finally {
    await w.repo.close();
  }
});

Deno.test("pull request refusals: not open, moved, head not on base", async () => {
  const w = await world();
  try {
    const reasons = async () => {
      const { units, file } = await plan(w);
      assert.equal(units.length, 0);
      return file?.noEvidence.map((e) => e.reason) ?? [];
    };
    w.pull = { ...w.pull!, state: "closed" };
    assert.deepEqual(await reasons(), ["pr_not_open"]);
    w.pull = {
      ...w.pull!,
      state: "open",
      head: { ...w.pull!.head, sha: "9".repeat(40) },
    };
    assert.deepEqual(await reasons(), ["pr_moved"]);
    w.pull = {
      ...w.pull!,
      head: { ...w.pull!.head, sha: w.head },
      base: { ...w.pull!.base, ref: "develop" },
    };
    assert.deepEqual(await reasons(), ["pr_moved"]);
    w.pull = { ...w.pull!, base: { ...w.pull!.base, ref: "main" } };
    w.compare = { status: "diverged", behindBy: 3 };
    assert.deepEqual(await reasons(), ["unsupported:head_not_on_base"]);
    w.compare = { status: "ahead", behindBy: 0 };
    w.merge = { parents: [w.base, w.head], tree: "0".repeat(40) };
    assert.deepEqual(await reasons(), ["pr_moved"]);
  } finally {
    await w.repo.close();
  }
});

Deno.test("the billing annotation is required for a stand-in", async () => {
  const w = await world();
  try {
    w.annotations = new Map([[101, ["Some other failure"]], [102, []]]);
    const { units, file } = await plan(w);
    assert.equal(units.length, 0);
    assert.deepEqual(file?.noEvidence.map((e) => e.reason), [
      "unsupported:not_account_cause",
    ]);
    assert.equal(file?.noEvidence[0].unitDigest, null);
  } finally {
    await w.repo.close();
  }
});

Deno.test("started checks plan no stand-in, but calibration and peer units", async () => {
  const w = await world();
  try {
    w.runs.set(w.head, [{
      ...neverStarted(101, w.head, 31),
      conclusion: "success",
    }]);
    w.suites.set(w.head, [{
      suiteId: 31,
      runId: 41,
      workflowPath: WORKFLOW_PATH,
      event: "push",
    }]);
    assert.equal(
      (await plan(w, { pullRequest: null, base: null })).units.length,
      0,
    );
    const calibration = await plan(w, {
      purpose: "calibration",
      pullRequest: null,
      base: null,
      branch: "main",
      recordId: null,
    });
    assert.equal(calibration.units.length, 1);
    assert.equal(calibration.units[0].unit.purpose, "calibration");
    assert.deepEqual(calibration.units[0].unit.native, {
      checkRunId: 101,
      conclusion: "success",
    });
    assert.equal(calibration.units[0].unit.neverStarted, null);
    // A peer of the base: the head holds a backup result for (P, N).
    const snapshot = {
      work: [workRecord("r1", {
        repository: {
          owner: "ubiquity",
          name: "passport.ubq.fi",
          installationId: 7,
        },
        target: {
          base: w.head,
          branch: "x",
          checkpoint: null,
          head: w.base,
          pr: null,
        },
      })],
    } as unknown as RepairStateSnapshotV1;
    const files = new Map([[
      w.base,
      commitFile([result()], { commit: w.base }),
    ]]);
    const changes = new BackupCiPassChanges();
    const peers = await planBackupCiCommit({
      deps: passDeps(w, { snapshot }),
      repo: REPO,
      info: INFO,
      reads: reads(w),
      candidate: candidate(w, {
        purpose: "peer",
        pullRequest: null,
        base: null,
        branch: "main",
      }),
      file: null,
      files,
      changes,
    });
    assert.equal(peers.length, 1);
    assert.equal(peers[0].unit.purpose, "peer");
    assert.equal(peers[0].unit.native?.conclusion, "success");
  } finally {
    await w.repo.close();
  }
});

Deno.test("a confirmation re-plans its key as attempt 2; a final key is skipped", async () => {
  const w = await world();
  try {
    const key = {
      context: "pull_request" as const,
      workflowPath: WORKFLOW_PATH,
      checkName: "deno",
      base: w.base,
    };
    const confirm = await plan(w, {
      priority: 0,
      purpose: "confirm",
      key,
      attempt: 2,
    });
    assert.equal(confirm.units.length, 1);
    assert.equal(confirm.units[0].unit.purpose, "confirm");
    assert.deepEqual(confirm.units[0].unit.key, { ...key, attempt: 2 });
    const final = commitFile([
      result({ ...key, attempt: 1 }, { commit: w.head }),
    ], { commit: w.head });
    const skipped = await plan(w, {}, { file: final });
    assert.equal(skipped.units.length, 0);
  } finally {
    await w.repo.close();
  }
});

Deno.test("an unsupported job and a root act config file are final refusals", async () => {
  const w = await world();
  try {
    const head = await w.repo.commit({ ".actrc": "--env X=1\n" });
    w.runs.set(head, [neverStarted(201, head, 51)]);
    w.suites.set(head, [{
      suiteId: 51,
      runId: 61,
      workflowPath: WORKFLOW_PATH,
      event: "push",
    }]);
    w.jobs.set(201, {
      id: 201,
      head_sha: head,
      status: "completed",
      conclusion: "failure",
      steps: [],
      runner_id: 0,
    });
    w.annotations.set(201, [BILLING]);
    const { units, file } = await plan(w, {
      commit: head,
      pullRequest: null,
      base: null,
    });
    assert.equal(units.length, 0);
    assert.deepEqual(file?.noEvidence.map((e) => e.reason), [
      "unsupported:act_config_file",
    ]);
    const docker = await w.repo.commit({
      [WORKFLOW_PATH]: PASSPORT_WORKFLOW.replace(
        "- run: bun install --frozen-lockfile",
        "- uses: docker://alpine:3",
      ),
    }, { remove: [".actrc"] });
    w.runs.set(docker, [neverStarted(202, docker, 52)]);
    w.suites.set(docker, [{
      suiteId: 52,
      runId: 62,
      workflowPath: WORKFLOW_PATH,
      event: "push",
    }]);
    w.jobs.set(202, {
      id: 202,
      head_sha: docker,
      status: "completed",
      conclusion: "failure",
      steps: [],
      runner_id: 0,
    });
    w.annotations.set(202, [BILLING]);
    const out = await plan(w, {
      commit: docker,
      pullRequest: null,
      base: null,
    });
    assert.deepEqual(out.file?.noEvidence.map((e) => e.reason), [
      "unsupported:docker_action",
    ]);
  } finally {
    await w.repo.close();
  }
});

Deno.test("the pass bounds commit reads and writes the selected unit's tree", async () => {
  const w = await world();
  try {
    const records = Array.from({ length: 20 }, (_, i) =>
      workRecord(`r${i}`, {
        repository: {
          owner: "ubiquity",
          name: "passport.ubq.fi",
          installationId: 7,
        },
        nextStep: "work",
        target: {
          base: w.base,
          branch: `b${i}`,
          checkpoint: null,
          head: i === 9
            ? w.head
            : `${(i + 10).toString(16).padStart(2, "0")}`.repeat(20),
          pr: i === 9 ? 7 : null,
        },
      }));
    const snapshot = {
      work: records,
      reservations: [],
      reviews: [],
      releaseRequests: [],
    } as unknown as RepairStateSnapshotV1;
    const pass = await runBackupCiPass(passDeps(w, { snapshot }));
    const latest = w.calls.filter((c) => c.startsWith("checkRuns:latest"));
    assert.equal(latest.length, 12, latest.join(" "));
    // Run 9001 rotates the head class to start at r1: the base tip and 11
    // heads (r1, r10-r19) are read, r9 (the never-started head) is not.
    assert.equal(
      pass.units.length,
      0,
      "the never-started head is beyond the read bound",
    );
    // With the head first in line, one unit is planned and tarred into slot 0.
    w.calls.length = 0;
    const one = await runBackupCiPass(passDeps(w, {
      snapshot: {
        ...snapshot,
        work: [records[9]],
      } as unknown as RepairStateSnapshotV1,
      legs: { ...passDeps(w).legs, inflight: () => Promise.resolve(1) },
    }));
    assert.equal(one.units.length, 1);
    assert.equal(one.units[0].slot, 0);
    assert.equal(
      one.units[0].unitDigest,
      backupCiUnitDigest(one.units[0].unit),
    );
    assert.equal(
      await fileSha256(`${w.repo.root}/work/trees/0.tar`),
      one.units[0].treeSha256,
    );
    assert.equal(one.files.length, 1);
    assert.equal(one.files[0].commit, w.head);
    assert.equal(
      backupCiCommitPath(
        one.files[0].repository.owner,
        one.files[0].repository.name,
        one.files[0].commit,
      ),
      `v1/ubiquity/passport.ubq.fi/${w.head.slice(0, 2)}/${w.head}.json`,
    );
    // No free slot: nothing is planned at all.
    w.calls.length = 0;
    const busy = await runBackupCiPass(passDeps(w, {
      snapshot,
      legs: { ...passDeps(w).legs, inflight: () => Promise.resolve(2) },
    }));
    assert.equal(busy.units.length, 0);
    assert.equal(w.calls.length, 0);
    // An unfilled pin (no runner id) ingests only.
    const unpinned = await runBackupCiPass(
      passDeps(w, { snapshot, runnerId: null }),
    );
    assert.equal(unpinned.units.length, 0);
  } finally {
    await w.repo.close();
  }
});
