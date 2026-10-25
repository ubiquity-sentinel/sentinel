/**
 * The leg's self-test (docs/backup-ci-spec.md §10.2 step 7, §15): before any
 * target code runs, the fixture `tests/fixtures/backup-ci/selftest/` is
 * copied into a fresh git repository whose remote is
 * `https://github.com/ubiquity-sentinel/backup-ci-selftest`, with every act
 * configuration file planted at its root (`.actrc` with `--env
 * PROBE=planted`, `.env`, `.secrets`, `.vars`, `.input`) and an untracked
 * marker file. It runs through the SAME argv builders as the unit and must
 * classify `success`: none of the planted files applies, the executable bit
 * survives, `git rev-parse HEAD` works, `GITHUB_REPOSITORY` and
 * `GITHUB_EVENT_NAME` are right, and the checkout short-circuited (the
 * untracked marker is there). Anything else is `selftest_failed`, and the
 * target job does not run.
 *
 * The planted files are stored in the fixture as `dot-<name>` (the Sentinel
 * repository ignores `.env*`) and renamed when copied.
 */
import type {
  BackupCiPlannedStepV1,
  BackupCiUnitV1,
} from "../src/contracts/backup-ci.ts";
import {
  type BackupCiActJobV1,
  type BackupCiActPathsV1,
  buildEventPayload,
  classifyActRun,
} from "./backup-ci-act.ts";
import type { BackupCiActRunV1, BackupCiLegDepsV1 } from "./backup-ci-leg.ts";
import { BACKUP_CI_GIT_SAFETY } from "./backup-ci-materialize.ts";

export const BACKUP_CI_SELFTEST_REPOSITORY =
  "ubiquity-sentinel/backup-ci-selftest";
export const BACKUP_CI_SELFTEST_PLANTED = [
  "actrc",
  "env",
  "secrets",
  "vars",
  "input",
] as const;
/** The default checkout when the unit has none (same major as Sentinel). */
const DEFAULT_CHECKOUT = "actions/checkout@v4";

const step = (
  index: number,
  actStepId: string,
  uses: string | null = null,
): BackupCiPlannedStepV1 => ({
  index,
  actStepId,
  kind: uses === null ? "run" : "uses_remote",
  uses,
  condition: "none",
  continueOnError: false,
});

/** The fixture job's planned steps (`workflow.yml`, in order). */
export function selfTestSteps(checkout: string): BackupCiPlannedStepV1[] {
  return [
    step(0, "checkout", checkout),
    step(1, "local"),
    step(2, "env"),
    step(3, "secret"),
    step(4, "var"),
    step(5, "exec"),
    step(6, "head"),
    step(7, "repository"),
    step(8, "event"),
  ];
}

/** The unit's `actions/checkout` reference, or the default. */
export function selfTestCheckout(unit: BackupCiUnitV1): string {
  return unit.steps.find((s) =>
    s.kind === "uses_remote" && /^actions\/checkout@/i.test(s.uses ?? "")
  )?.uses ?? DEFAULT_CHECKOUT;
}

async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const source = `${from}/${entry.name}`;
    if (entry.isDirectory) await copyTree(source, `${to}/${entry.name}`);
    else if (entry.isFile) {
      await Deno.copyFile(source, `${to}/${entry.name}`);
      const mode = (await Deno.stat(source)).mode;
      if (mode !== null) await Deno.chmod(`${to}/${entry.name}`, mode & 0o777);
    }
  }
}

export type BackupCiSelfTestRunV1 = (
  job: BackupCiActJobV1,
  paths: BackupCiActPathsV1,
  unitName: string,
) => Promise<BackupCiActRunV1>;

/** Runs the self-test; true only when it classified `success`. */
export async function runBackupCiSelfTest(
  deps: BackupCiLegDepsV1,
  unit: BackupCiUnitV1,
  run: BackupCiSelfTestRunV1,
): Promise<boolean> {
  const root = `${deps.runTemp}/backup-ci/selftest`;
  const ws = `${root}/ws`;
  const fixture = `${deps.launcherRoot}/tests/fixtures/backup-ci/selftest`;
  await Deno.mkdir(`${ws}/.github/workflows`, { recursive: true });
  const checkout = selfTestCheckout(unit);
  const workflow = (await Deno.readTextFile(`${fixture}/workflow.yml`))
    .replaceAll("__CHECKOUT__", checkout)
    .replaceAll("__RUNS_ON__", unit.job.runsOn);
  await Deno.writeTextFile(`${ws}/.github/workflows/selftest.yml`, workflow);
  await copyTree(`${fixture}/tree`, ws);
  for (const name of BACKUP_CI_SELFTEST_PLANTED) {
    await Deno.copyFile(`${fixture}/dot-${name}`, `${ws}/.${name}`);
  }
  const git = async (args: string[]) => {
    const out = await deps.git.runGit([...BACKUP_CI_GIT_SAFETY, ...args], {
      cwd: ws,
      env: {
        GIT_AUTHOR_NAME: "sentinel-backup-ci",
        GIT_AUTHOR_EMAIL: "sentinel-backup-ci@users.noreply.github.com",
        GIT_COMMITTER_NAME: "sentinel-backup-ci",
        GIT_COMMITTER_EMAIL: "sentinel-backup-ci@users.noreply.github.com",
      },
    });
    return out.ok;
  };
  const ok = await git(["init", "-q", "-b", "main"]) &&
    await git(["add", "-A"]) &&
    await git(["commit", "-q", "-m", "backup CI self-test"]) &&
    await git([
      "remote",
      "add",
      "origin",
      `https://github.com/${BACKUP_CI_SELFTEST_REPOSITORY}`,
    ]);
  if (!ok) return false;
  await Deno.writeTextFile(`${ws}/local-only.txt`, "untracked\n");
  const head = await deps.git.runGit(
    [...BACKUP_CI_GIT_SAFETY, "rev-parse", "HEAD"],
    { cwd: ws },
  );
  const sha = head.stdout.trim();
  if (!head.ok || !/^[0-9a-f]{40}$/.test(sha)) return false;
  const repo = {
    full_name: BACKUP_CI_SELFTEST_REPOSITORY,
    name: "backup-ci-selftest",
    owner: { login: "ubiquity-sentinel" },
  };
  const event = buildEventPayload({
    context: "pull_request",
    repository: {
      owner: "ubiquity-sentinel",
      name: "backup-ci-selftest",
      defaultBranch: "main",
      private: false,
    },
    commit: sha as never,
    ref: "refs/pull/1/merge",
    before: null,
    pull: {
      number: 1,
      draft: false,
      user: "ubiquity-sentinel[bot]",
      head: { sha: sha as never, ref: "selftest", repo },
      base: { sha: sha as never, ref: "main", repo },
    },
  });
  for (
    const dir of ["cwd", "empty", "action-cache", "cache-server", "artifacts"]
  ) {
    await Deno.mkdir(`${root}/${dir}`, { recursive: true });
  }
  const paths: BackupCiActPathsV1 = {
    act: `${deps.runTemp}/backup-ci/bin/act`,
    ws,
    emptyCwd: `${root}/cwd`,
    event: `${root}/event.json`,
    empty: {
      env: `${root}/empty/env`,
      secrets: `${root}/empty/secrets`,
      vars: `${root}/empty/vars`,
      input: `${root}/empty/input`,
    },
    actionCache: `${root}/action-cache`,
    cacheServer: `${root}/cache-server`,
    artifactServer: `${root}/artifacts`,
  };
  for (const file of Object.values(paths.empty)) {
    await Deno.writeTextFile(file, "");
  }
  await Deno.writeTextFile(paths.event, JSON.stringify(event));
  const job: BackupCiActJobV1 = {
    context: "pull_request",
    workflowPath: ".github/workflows/selftest.yml",
    jobKey: "selftest",
    matrix: null,
    runsOn: unit.job.runsOn,
    defaultBranch: "main",
    capMinutes: 10,
  };
  const result = await run(job, paths, "sentinel-backup-act-selftest");
  const verdict = classifyActRun(
    {
      job: {
        key: "selftest",
        matrix: null,
        capMinutes: 10,
        targetTimeoutMinutes: 10,
      },
      steps: selfTestSteps(checkout),
    },
    result.records,
    result,
  );
  return verdict.outcome === "success";
}
