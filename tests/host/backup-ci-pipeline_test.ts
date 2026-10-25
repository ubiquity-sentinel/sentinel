/**
 * The WP3 backup CI pipeline end to end on one machine
 * (docs/backup-ci-spec.md §9-§11.1), with real git and tar, a temporary
 * target remote and store remote, a fake Actions API and a fake act: the
 * trusted pass plans a pull request unit for a never-started check and
 * tars its tree; the commit step records it `dispatched` and dispatches the
 * leg; the leg prepares, self-tests, runs and reports; the next pass ingests
 * the leg's run, log marker and artifact into a `result`; and the WP1
 * reader and stand-in rule accept that receipt, but only once the runner is
 * calibrated. The runtime and launcher consumers (readChecks, the CI-first
 * gate, the merge port) are WP2's and are not exercised here.
 */
import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  BACKUP_CI_LEG_STEPS,
  backupCiBytesDigest,
  backupCiCalibrationPath,
  backupCiReceiptId,
} from "../../src/contracts/backup-ci.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { createBackupCiReader } from "../../src/github/backup-ci-reader.ts";
import { mergeCalibration } from "../../src/github/backup-ci-store.ts";
import { selectBackupStandIns } from "../../src/github/backup-ci-substitute.ts";
import { DenoGitRunner } from "../../src/state/state-git.ts";
import {
  type BackupCiPinsV1,
  backupCiRunnerId,
} from "../../ops/backup-ci-act.ts";
import { commitBackupCiPass } from "../../ops/backup-ci-dispatch.ts";
import type { BackupCiLegReadsV1 } from "../../ops/backup-ci-ingest-reads.ts";
import {
  type BackupCiLegDepsV1,
  backupCiLegLayout,
  legMarker,
  legPrepare,
  legRun,
} from "../../ops/backup-ci-leg.ts";
import {
  createBackupCiGit,
  fetchBackupCiBare,
} from "../../ops/backup-ci-materialize.ts";
import {
  type BackupCiPassDepsV1,
  runBackupCiPass,
} from "../../ops/backup-ci-pass.ts";
import type {
  BackupCiApiV1,
  BackupCiTargetReadsV1,
} from "../../ops/backup-ci-plan-reads.ts";
import {
  openBackupCiStore,
  writeBackupCiStore,
} from "../../ops/backup-ci-store-writer.ts";
import { workRecord } from "../state/helpers.ts";
import {
  fixtureGit,
  PASSPORT_WORKFLOW,
  targetRepo,
  testDir,
  WORKFLOW_PATH,
} from "./backup-ci-test-repo.ts";

const T0 = Date.parse("2026-10-25T08:00:00Z");
const MIN = 60_000;
const ID = 812345678;
const TARGET = { repository: "ubiquity/passport.ubq.fi" as const, id: ID };
const PINS: BackupCiPinsV1 = {
  act: {
    version: "v0.2.82",
    releasedAt: "2026-09-01",
    asset: "act_Linux_x86_64.tar.gz",
    sha256: "c".repeat(64),
  },
  node: "24.19.0",
};
const RUNNER = backupCiRunnerId(PINS);
const LAUNCHER = "e".repeat(40) as GitSha;
const BILLING =
  "The job was not started because recent account payments have failed or your spending limit needs to be increased.";
const iso = (at: number) => new Date(at).toISOString();
type Obj = Record<string, unknown>;

/** act-style records of the Passport job, all green. */
function greenAct(job: string, ids: string[]): string[] {
  return [
    ...ids.flatMap((id) => [
      JSON.stringify({
        jobID: job,
        matrix: {},
        stage: "Main",
        stepID: [id],
        msg: `step ${id} output`,
      }),
      JSON.stringify({
        jobID: job,
        matrix: {},
        stage: "Main",
        stepID: [id],
        stepResult: "success",
        msg: "ok",
      }),
    ]),
    JSON.stringify({
      jobID: job,
      matrix: {},
      jobResult: "success",
      msg: "done",
    }),
  ];
}

Deno.test("plan, dispatch, leg, ingest, store: a receipt the stand-in rule accepts once calibrated", async () => {
  const repo = await targetRepo("backup-ci-pipeline-");
  const storeRoot = await testDir("backup-ci-pipeline-store-");
  try {
    // The target: a reviewed base B and a pull request head H whose `deno`
    // job never started (an account billing stop), on push and pull_request.
    const base = await repo.commit({
      [WORKFLOW_PATH]: PASSPORT_WORKFLOW,
      "src/a.ts": "export const a = 1;\n",
    });
    const head = await repo.commit({ "src/a.ts": "export const a = 2;\n" });
    const runs = [101, 102].map((id, i) => ({
      id,
      name: "deno",
      head_sha: head,
      status: "completed",
      conclusion: "failure",
      app: { slug: "github-actions" },
      check_suite: { id: 31 + i },
      started_at: iso(T0),
      completed_at: iso(T0 + 1000),
    }));
    const suites = [
      { suiteId: 31, runId: 41, workflowPath: WORKFLOW_PATH, event: "push" },
      {
        suiteId: 32,
        runId: 42,
        workflowPath: WORKFLOW_PATH,
        event: "pull_request",
      },
    ];
    const side = (sha: GitSha, ref: string) => ({
      sha,
      ref,
      repo: {
        full_name: TARGET.repository,
        name: "passport.ubq.fi",
        owner: { login: "ubiquity" },
      },
    });
    const reads: BackupCiTargetReadsV1 = {
      repository: () =>
        Promise.resolve({ id: ID, defaultBranch: "main", private: true }),
      branchTip: () => Promise.resolve(base),
      checkRuns: (sha) => Promise.resolve(sha === head ? runs : []),
      suites: (sha) => Promise.resolve(sha === head ? suites : []),
      statusContexts: () => Promise.resolve(new Set<string>()),
      job: (id) =>
        Promise.resolve({
          id,
          head_sha: head,
          status: "completed",
          conclusion: "failure",
          steps: [],
          runner_id: 0,
        }),
      annotations: () => Promise.resolve([BILLING]),
      pull: () =>
        Promise.resolve({
          number: 7,
          state: "open",
          draft: false,
          user: "ubiquity-sentinel[bot]",
          head: side(head, "sentinel/fix-7"),
          base: side(base, "main"),
        }),
      compare: () => Promise.resolve({ status: "ahead", behindBy: 0 }),
      pullMerge: () => Promise.resolve("absent" as const),
    };
    const record = workRecord("issue-7", {
      repository: {
        owner: "ubiquity",
        name: "passport.ubq.fi",
        installationId: 7,
      },
      nextStep: "delivery",
      target: { base, branch: "sentinel/fix-7", checkpoint: null, head, pr: 7 },
    });
    const snapshot = {
      work: [record],
      reservations: [],
      reviews: [],
      releaseRequests: [],
    } as unknown as RepairStateSnapshotV1;
    const storeBare = `${storeRoot}/store.git`;
    await fixtureGit(storeRoot, ["init", "-q", "--bare", storeBare]);
    const storeUrl = `file://${storeBare}`;
    const git = createBackupCiGit(`${repo.root}/home`);
    const storeInput = {
      git,
      scratch: `${storeRoot}/scratch`,
      remote: storeUrl,
      protocols: ["file"],
    };
    let ingestLegs: BackupCiLegReadsV1 = {
      legRuns: () => Promise.resolve([]),
      attempt: () => Promise.resolve(null),
      jobs: () => Promise.resolve(null),
      log: () => Promise.resolve(null),
      artifact: () => Promise.resolve(null),
      artifactZip: () => Promise.resolve(null),
      cancel: () => Promise.resolve(false),
      inflight: () => Promise.resolve(0),
      cellsActive: () => Promise.resolve(false),
    };
    const workDir = `${repo.root}/trusted`;
    const passDeps = async (now: number): Promise<BackupCiPassDepsV1> => ({
      runId: 9001,
      launcherSha: LAUNCHER,
      mode: "on",
      runnerId: RUNNER,
      now: () => now,
      targets: [TARGET],
      calibrationCommits: () => [],
      snapshot,
      store: await openBackupCiStore(storeInput),
      legs: ingestLegs,
      sentinelId: 4242,
      targetReads: () => reads,
      materialize: (_o, _n, commits, dir) =>
        fetchBackupCiBare({
          git,
          dir,
          remoteUrl: repo.url,
          token: null,
          commits,
          protocols: ["file"],
        }),
      actionSource: (local) => ({
        local,
        remote: () =>
          Promise.resolve(
            new TextEncoder().encode("runs:\n  using: node24\n  main: x.js\n"),
          ),
      }),
      workDir,
      tokenNeedles: [],
      log: () => {},
      sleep: () => Promise.resolve(),
    });
    const dispatches: Obj[] = [];
    const api: BackupCiApiV1 = {
      get: (path) =>
        Promise.resolve(
          path.endsWith("/git/ref/heads/sentinel-backup-legs")
            ? { object: { sha: LAUNCHER } }
            : null,
        ),
      send: (_m, path, body) => {
        if (path.endsWith("/dispatches")) dispatches.push(body as Obj);
        return Promise.resolve({ status: 204, body: null });
      },
      redirected: () => Promise.resolve(null),
    };
    const commit = async (
      passFile: Awaited<ReturnType<typeof runBackupCiPass>>,
      now: number,
    ) => {
      const bytes = new TextEncoder().encode(JSON.stringify(passFile));
      return await commitBackupCiPass({
        passBytes: bytes,
        expectedDigest: backupCiBytesDigest(bytes),
        trees: ["3001"],
        githubSha: LAUNCHER,
        runId: 9001,
        now: () => now,
        api,
        repository: "ubiquity-sentinel/sentinel",
        writeStore: (mutate) =>
          writeBackupCiStore({
            ...storeInput,
            runId: 9001,
            now: () => now,
            mutate,
          }),
        log: () => {},
      });
    };

    // 1. Plan and dispatch.
    const planned = await runBackupCiPass(await passDeps(T0 + MIN));
    assert.equal(planned.units.length, 1);
    const unit = planned.units[0].unit;
    assert.equal(unit.key.context, "pull_request");
    assert.equal((await commit(planned, T0 + MIN)).code, 0);
    assert.equal(dispatches.length, 1);
    const inputs = dispatches[0].inputs as Record<string, string>;
    assert.equal(inputs.unit, unit.unitId);

    // 2. The leg, on its own "VM".
    const runTemp = `${repo.root}/leg`;
    const layout = backupCiLegLayout(runTemp);
    // Where download-artifact by artifact id puts it: in/<artifact name>/.
    const artifactDir = `${layout.input}/backup-tree-${unit.unitId}`;
    await Deno.mkdir(artifactDir, { recursive: true });
    await Deno.copyFile(`${workDir}/trees/0.tar`, `${artifactDir}/0.tar`);
    const launcher = `${repo.root}/launcher`;
    await Deno.mkdir(`${launcher}/ops`, { recursive: true });
    await Deno.mkdir(`${launcher}/tests/fixtures/backup-ci`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${launcher}/ops/backup-ci-pins.json`,
      JSON.stringify(PINS),
    );
    await new Deno.Command("cp", {
      args: [
        "-a",
        "tests/fixtures/backup-ci/selftest",
        `${launcher}/tests/fixtures/backup-ci/`,
      ],
    }).output();
    await Deno.mkdir(`${repo.root}/leg-home`, { recursive: true });
    const printed: { phase: string; line: string }[] = [];
    let phase = "prepare";
    let clock = T0 + 3 * MIN + 5000;
    const env: Record<string, string> = {
      BACKUP_UNIT: inputs.unit,
      BACKUP_UNIT_DIGEST: inputs.unit_digest,
      BACKUP_TREE_SHA256: inputs.tree_sha256,
      ImageOS: "ubuntu24",
      ImageVersion: "20261020.1.0",
      BACKUP_RESULT_ARTIFACT: "7001",
    };
    const legDeps: BackupCiLegDepsV1 = {
      env: (name) => env[name],
      runTemp,
      launcherRoot: launcher,
      home: `${repo.root}/leg-home`,
      now: () => (clock += 1000),
      print: (line) => printed.push({ phase, line }),
      git: createBackupCiGit(`${repo.root}/leg-git-home`),
      async tar(args) {
        const out = await new Deno.Command("tar", {
          args,
          stdout: "piped",
          stderr: "null",
        }).output();
        return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
      },
      service(argv, onLine) {
        const act = argv.slice(argv.indexOf("--") + 1);
        const selftest = act.includes("selftest");
        const ids = selftest
          ? [
            "checkout",
            "local",
            "env",
            "secret",
            "var",
            "exec",
            "head",
            "repository",
            "event",
          ]
          : unit.steps.map((s) => s.actStepId);
        for (
          const line of greenAct(selftest ? "selftest" : unit.job.key, ids)
        ) onLine(line);
        return Promise.resolve({ code: 0, elapsedMs: 1000 });
      },
      etcEnvironment: () => Promise.resolve("PATH=/usr/bin:/bin\n"),
      nodeDir: () => Promise.resolve("/usr/bin"),
      actVersion: () => Promise.resolve("act version 0.2.82"),
    };
    assert.equal(
      await legPrepare(legDeps),
      0,
      printed.map((p) => p.line).join("\n"),
    );
    phase = "run";
    assert.equal(
      await legRun(legDeps),
      0,
      printed.map((p) => p.line).join("\n"),
    );
    phase = "report";
    assert.equal(await legMarker(legDeps), 0);
    const resultBytes = await Deno.readFile(layout.result);

    // 3. The next pass ingests the leg through the fake Actions API.
    const stamp = (at: number, line: string) =>
      `${iso(at).replace("Z", "0000Z")} ${line}`;
    const log = [
      ...printed.filter((p) => p.phase === "prepare").map((p) =>
        stamp(T0 + 2 * MIN + 1000, p.line)
      ),
      ...printed.filter((p) => p.phase === "run").map((p) =>
        stamp(T0 + 4 * MIN, p.line)
      ),
      ...printed.filter((p) => p.phase === "report").map((p) =>
        stamp(T0 + 9 * MIN + 1000, p.line)
      ),
    ].join("\n");
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
    });
    await writer.add("result.json", new Uint8ArrayReader(resultBytes), {
      unixMode: 0o100644,
    });
    const archive = await writer.close();
    const run = {
      id: 5001,
      display_title: `sentinel-backup-ci-leg ${unit.unitId}`,
      path: ".github/workflows/backup-ci-leg.yml",
      event: "workflow_dispatch",
      head_branch: "sentinel-backup-legs",
      head_sha: LAUNCHER,
      head_repository: { full_name: "ubiquity-sentinel/sentinel" },
      repository: { full_name: "ubiquity-sentinel/sentinel" },
      triggering_actor: { login: "github-actions[bot]" },
      status: "completed",
      run_attempt: 1,
    };
    const windows = [[2, 3], [3, 8], [8, 9], [9, 9.5]];
    ingestLegs = {
      ...ingestLegs,
      legRuns: () => Promise.resolve([run]),
      attempt: () => Promise.resolve(run),
      jobs: () =>
        Promise.resolve([{
          id: 6001,
          name: "leg",
          run_attempt: 1,
          head_sha: LAUNCHER,
          status: "completed",
          conclusion: "success",
          runner_group_name: "GitHub Actions",
          labels: [unit.job.runsOn],
          started_at: iso(T0 + MIN),
          completed_at: iso(T0 + 10 * MIN),
          steps: BACKUP_CI_LEG_STEPS.map((name, i) => ({
            name,
            status: "completed",
            conclusion: "success",
            started_at: iso(T0 + windows[i][0] * MIN),
            completed_at: iso(T0 + windows[i][1] * MIN),
          })),
        }]),
      log: () => Promise.resolve(log),
      artifact: () =>
        Promise.resolve({
          id: 7001,
          name: `backup-result-${unit.unitId}`,
          expired: false,
          size_in_bytes: archive.length,
          workflow_run: { id: 5001, head_sha: LAUNCHER, repository_id: 4242 },
        }),
      artifactZip: () => Promise.resolve(archive),
      inflight: () => Promise.resolve(2),
    };
    const ingested = await runBackupCiPass(await passDeps(T0 + 20 * MIN));
    assert.equal(
      ingested.files[0].results.length,
      1,
      JSON.stringify(ingested.files),
    );
    assert.equal(ingested.files[0].results[0].conclusion, "success");
    assert.equal((await commit(ingested, T0 + 20 * MIN)).code, 0);

    // 4. The consumers' reader and stand-in rule (WP1).
    let now = T0 + 21 * MIN;
    const reader = createBackupCiReader({
      git: new DenoGitRunner(`${storeRoot}/reader-home`),
      scratchRoot: `${storeRoot}/reader`,
      clock: { now: () => now },
      targets: [TARGET],
      remoteUrl: storeUrl,
    });
    const identity = {
      owner: "ubiquity",
      name: "passport.ubq.fi",
      installationId: 7,
    };
    const observations = runs.map((r) => ({
      checkRunId: r.id,
      name: "deno",
      app: "github-actions",
      suiteId: r.check_suite.id,
      status: "completed",
      conclusion: "failure",
      startedAt: T0,
      completedAt: T0 + 1000,
      notStarted: true,
    }));
    const select = async () => {
      const read = await reader.read(identity, head);
      assert.equal(read.kind, "ok");
      if (read.kind !== "ok") throw new Error("unreachable");
      return selectBackupStandIns({
        target: TARGET,
        commit: head,
        mode: "on",
        latest: observations,
        all: observations,
        suites: suites.map(({ suiteId, workflowPath, event }) => ({
          suiteId,
          workflowPath,
          event,
        })),
        statusContexts: new Set(),
        file: read.file,
        suspensions: read.suspensions,
        calibration: read.calibration,
      });
    };
    assert.equal(
      (await select()).standIns.size,
      0,
      "an uncalibrated runner stands in for nothing",
    );
    await writeBackupCiStore({
      ...storeInput,
      runId: 9002,
      now: () => now,
      mutate: () => {
        const samples = ["1", "2", "3", "4", "5"].map((c, i) => ({
          runnerId: RUNNER,
          sample: {
            commit: c.repeat(40) as GitSha,
            checkName: "deno",
            native: i === 0 ? "failure" : "success",
            backup: (i === 0 ? "failure" : "success") as "failure" | "success",
          },
          nativeCheckRunId: 900 + i,
          receipt: "bci1:x",
        }));
        const { calibration } = mergeCalibration(
          null,
          { owner: "ubiquity", name: "passport.ubq.fi", id: ID },
          samples,
          now,
        );
        return Promise.resolve(
          new Map([[
            backupCiCalibrationPath("ubiquity", "passport.ubq.fi"),
            calibration,
          ]]),
        );
      },
    });
    now += 11_000;
    const selection = await select();
    assert.equal(selection.standIns.size, 2);
    for (const standIn of selection.standIns.values()) {
      assert.equal(standIn.conclusion, "success");
      assert.equal(
        standIn.backup.receipt,
        backupCiReceiptId(TARGET.repository, head, unit.key),
      );
      assert.equal(standIn.backup.context, "pull_request");
      assert.equal(standIn.backup.legRunId, 5001);
      assert.equal(standIn.backup.runnerId, RUNNER);
    }
  } finally {
    await repo.close();
    await Deno.remove(storeRoot, { recursive: true });
  }
});
