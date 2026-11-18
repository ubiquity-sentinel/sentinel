/**
 * MUST 1 of the 2026-11-17 review: a runner with an unexplained false green
 * on ANY target neither stands in nor calibrates on EVERY target until its
 * id changes. Before this rule the Passport-scoped suspension of runner
 * `916ad9eaff49fe9d` left the same runner usable on 28 more targets. Fake
 * reads plus one real temporary git store for the supervisor-side reader.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  backupCiCalibrationPath,
  backupCiCommitPath,
  backupCiSuspensionPath,
} from "../../src/contracts/backup-ci.ts";
import {
  backupCiExcludedRunners,
  isBackupCiRunnerExcluded,
} from "../../src/contracts/backup-ci-trust.ts";
import { createBackupCiReader } from "../../src/github/backup-ci-reader.ts";
import { selectBackupStandIns } from "../../src/github/backup-ci-substitute.ts";
import { DenoGitRunner } from "../../src/state/state-git.ts";
import { readBackupCiExclusion } from "../../ops/backup-ci-enrol.ts";
import {
  backupCiRunnerId,
  parseBackupCiPins,
} from "../../ops/backup-ci-act.ts";
import {
  calibration,
  CHECK,
  checkCalibration,
  checkDefinitions,
  commitFile,
  H,
  key,
  result,
  RUNNER,
  RUNNER2,
  suspension,
  T0,
  WORKFLOW,
} from "../github/backup-ci-fixtures.ts";

const OTHER_REPO = "ubiquity/prospector";
const OTHER_ID = 777;
const OTHER = { owner: "ubiquity", name: "prospector", id: OTHER_ID };

Deno.test("a false green anywhere excludes the runner everywhere", () => {
  // Passport's live suspension: scoped to Passport, false green, one runner.
  const live = backupCiExcludedRunners([suspension()], []);
  assert.deepEqual(live, { all: false, runnerIds: [RUNNER] });
  assert.equal(isBackupCiRunnerExcluded(live, RUNNER), true);
  assert.equal(isBackupCiRunnerExcluded(live, RUNNER2), false);
  // A calibration row with a false green excludes even without a suspension.
  const row = backupCiExcludedRunners([], [
    calibration([{ runnerId: RUNNER2, falseGreens: 1 }]),
  ]);
  assert.deepEqual(row.runnerIds, [RUNNER2]);
  // False reds and operator suspensions keep their own scope.
  assert.deepEqual(
    backupCiExcludedRunners([
      suspension({ reason: "false_red" }),
      suspension({ reason: "operator", runnerIds: "all" }),
    ], []),
    { all: false, runnerIds: [] },
  );
  const all = backupCiExcludedRunners([suspension({ runnerIds: "all" })], []);
  assert.equal(isBackupCiRunnerExcluded(all, RUNNER2), true);
});

function neverStarted(id: number) {
  return {
    checkRunId: id,
    name: CHECK,
    app: "github-actions",
    suiteId: 11,
    status: "completed",
    conclusion: "failure",
    startedAt: T0,
    completedAt: T0 + 1,
    notStarted: true,
  };
}

Deno.test("an excluded runner calibrated on another target stands in for nothing", () => {
  const otherFile = commitFile([result()], { repository: { ...OTHER } });
  const otherCalibration = {
    ...calibration(),
    repository: { ...OTHER },
  };
  const input = {
    target: { repository: OTHER_REPO, id: OTHER_ID } as const,
    commit: H,
    mode: "on" as const,
    latest: [neverStarted(102)],
    all: [neverStarted(102)],
    suites: [{ suiteId: 11, workflowPath: WORKFLOW, event: "push" }],
    statusContexts: new Set<string>(),
    file: otherFile,
    suspensions: [],
    calibration: otherCalibration,
    checks: checkCalibration(undefined, { ...OTHER }),
    definitions: checkDefinitions(undefined, { ...OTHER }),
  };
  // Without the rule this runner stood in on Prospector despite Passport's
  // false green (the reviewer's MUST 1).
  const before = selectBackupStandIns({
    ...input,
    excluded: { all: false, runnerIds: [] },
  });
  assert.deepEqual([...before.standIns.keys()], [102]);
  const after = selectBackupStandIns({
    ...input,
    excluded: backupCiExcludedRunners([suspension()], []),
  });
  assert.equal(after.standIns.size, 0);
  assert.deepEqual(after.refusals, [`runner_excluded:${CHECK}`]);
  // Nor does it attach a peer to a natively started name.
  const started = { ...neverStarted(103), notStarted: false };
  const peer = selectBackupStandIns({
    ...input,
    latest: [started],
    all: [started],
    excluded: backupCiExcludedRunners([suspension()], []),
  });
  assert.equal(peer.peers.size, 0);
});

async function git(cwd: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).output();
  if (!out.success) throw new Error(`git ${args[0]} failed`);
  return new TextDecoder().decode(out.stdout).trim();
}

Deno.test("the store reader reports a runner excluded by another target's false green", async () => {
  const root = await Deno.makeTempDir({ prefix: "backup-ci-exclusion-" });
  try {
    const remote = `${root}/store.git`;
    await git(root, ["init", "-q", "--bare", remote]);
    const work = `${root}/work`;
    await git(root, ["init", "-q", work]);
    const files: Record<string, unknown> = {
      [backupCiSuspensionPath("ubiquity", "passport.ubq.fi")]: suspension(),
      [backupCiCalibrationPath("ubiquity", "prospector")]: {
        ...calibration(),
        repository: { ...OTHER },
      },
      [backupCiCommitPath("ubiquity", "prospector", H)]: commitFile(
        [result(key())],
        { repository: { ...OTHER } },
      ),
    };
    for (const [path, value] of Object.entries(files)) {
      const target = `${work}/${path}`;
      await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(target, JSON.stringify(value));
    }
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-q", "-m", "store"]);
    await git(work, [
      "push",
      "-q",
      remote,
      "HEAD:refs/heads/sentinel-backup-ci",
    ]);
    const reader = createBackupCiReader({
      git: new DenoGitRunner(`${root}/home`),
      scratchRoot: `${root}/scratch`,
      clock: { now: () => T0 },
      targets: [{ repository: OTHER_REPO, id: OTHER_ID }],
      remoteUrl: `file://${remote}`,
    });
    const read = await reader.read(
      { owner: "ubiquity", name: "prospector", installationId: 1 },
      H as GitSha,
    );
    assert.equal(read.kind, "ok");
    if (read.kind !== "ok") return;
    assert.deepEqual(read.excluded, { all: false, runnerIds: [RUNNER] });
    // The prospector-scoped list carries no suspension of its own.
    assert.deepEqual(read.suspensions, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("the pass reads every target's trust files and plans nothing for an excluded runner", async () => {
  const store = new Map<string, unknown>([
    [backupCiSuspensionPath("ubiquity", "passport.ubq.fi"), suspension()],
    [backupCiCalibrationPath("ubiquity", "prospector"), {
      ...calibration(),
      repository: { ...OTHER },
    }],
  ]);
  const grep = (fixed: string) =>
    Promise.resolve(
      [...store.entries()].filter(([, v]) => JSON.stringify(v).includes(fixed))
        .map(([p]) => p),
    );
  const excluded = await readBackupCiExclusion({
    read: (path) => Promise.resolve(store.get(path) ?? null),
    pathsContaining: (fixed) => grep(fixed),
  });
  assert.deepEqual(excluded, { all: false, runnerIds: [RUNNER] });
  await assert.rejects(() =>
    readBackupCiExclusion({
      read: () => Promise.resolve({ not: "a suspension" }),
      pathsContaining: (fixed) =>
        Promise.resolve(
          fixed.includes("suspension") ? ["v1/suspended.json"] : [],
        ),
    })
  );
});

Deno.test("an excluded runner's pass ingests but plans nothing on any target", async () => {
  const { passDeps, passWorld, targetReadCount } = await import(
    "./backup-ci-pass-fakes.ts"
  );
  const { runBackupCiPass } = await import("../../ops/backup-ci-pass.ts");
  const world = passWorld();
  world.store.set(
    backupCiSuspensionPath("ubiquity", "passport.ubq.fi"),
    suspension(),
  );
  const pass = await runBackupCiPass(
    passDeps(world, [{ repository: OTHER_REPO, id: OTHER_ID }], {
      snapshot: {
        work: [],
        reservations: [],
        reviews: [],
        releaseRequests: [],
      } as never,
    }),
  );
  assert.equal(pass.units.length, 0);
  assert(
    world.lines.includes(
      `sentinel_backup_ci_runner ${
        JSON.stringify({ runnerId: RUNNER, state: "excluded" })
      }`,
    ),
  );
  assert(world.lines.includes("backup-ci:plan:skipped"));
  assert.equal(targetReadCount(world), 0);
});

Deno.test("2026-11-18: the leg revision gives a new runner; the false green keeps the old one excluded", async () => {
  const pins = parseBackupCiPins(
    JSON.parse(await Deno.readTextFile("ops/backup-ci-pins.json")),
  );
  assert(pins !== null);
  const current = backupCiRunnerId(pins);
  // Passport's stored suspension and pooled row, as they are in the store.
  const excluded = backupCiExcludedRunners(
    [suspension({
      scope: "ubiquity/passport.ubq.fi",
      runnerIds: ["916ad9eaff49fe9d"],
      reason: "false_green",
    })],
    [calibration([{ runnerId: "916ad9eaff49fe9d", falseGreens: 1 }])],
  );
  assert.equal(isBackupCiRunnerExcluded(excluded, "916ad9eaff49fe9d"), true);
  assert.notEqual(current, "916ad9eaff49fe9d");
  assert.equal(isBackupCiRunnerExcluded(excluded, current), false);
});
