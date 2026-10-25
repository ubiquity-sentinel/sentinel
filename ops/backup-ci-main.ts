/**
 * Entry point of the trusted `backup_ci` job (docs/backup-ci-spec.md §9):
 * `pass` (identity, ingest, plan, materialize; writes `pass.json` and the
 * unit trees) and `commit` (one store CAS commit, then the leg dispatches).
 *
 * Fail closed throughout: an identity mismatch, mode `off`, an unfilled act
 * pin (no runner id: ingest only), an unreadable state or store plans
 * nothing. Only hex, enum and integer values reach `GITHUB_OUTPUT`, the
 * step summary and the log.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import {
  BACKUP_CI_RUN_REF,
  BACKUP_CI_STORE_REMOTE,
  BACKUP_CI_WORKFLOW_PATH,
  backupCiBytesDigest,
  parseBackupCiMode,
  parseBackupCiTargets,
} from "../src/contracts/backup-ci.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { HOSTED_CONTROLLER_REMOTE } from "../src/contracts/hosted-controller-deployment.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { createRepairStateStore, DenoGitRunner } from "../src/state/mod.ts";
import { backupCiRunnerId, parseBackupCiPins } from "./backup-ci-act.ts";
import { rawGithubActionSource } from "./backup-ci-actions.ts";
import { commitBackupCiPass } from "./backup-ci-dispatch.ts";
import {
  BACKUP_CI_SENTINEL_REPOSITORY,
  createBackupCiLegReads,
} from "./backup-ci-ingest-reads.ts";
import {
  backupCiFetchAuthEnv,
  backupCiTokenNeedles,
  createBackupCiGit,
  fetchBackupCiBare,
} from "./backup-ci-materialize.ts";
import { type BackupCiPassFileV1, runBackupCiPass } from "./backup-ci-pass.ts";
import {
  createBackupCiApi,
  createBackupCiTargetReads,
} from "./backup-ci-plan-reads.ts";
import {
  openBackupCiStore,
  writeBackupCiStore,
} from "./backup-ci-store-writer.ts";
import { readRepairSafely } from "./hosted-autonomy-state.ts";

const SHA_RE = /^[0-9a-f]{40}$/;

/** `ops/backup-ci-calibration.json`: exact calibration commits per target. */
export function parseBackupCiCalibrationCommits(
  input: unknown,
): Map<string, GitSha[]> {
  const out = new Map<string, GitSha[]>();
  const o = input as { version?: unknown; targets?: unknown } | null;
  if (
    o === null || typeof o !== "object" || o.version !== 1 ||
    typeof o.targets !== "object" || o.targets === null ||
    Object.keys(o).sort().join(",") !== "targets,version"
  ) throw new Error("backup CI calibration commits do not parse");
  for (
    const [repo, list] of Object.entries(o.targets as Record<string, unknown>)
  ) {
    if (
      !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo) || !Array.isArray(list) ||
      list.length > 64 || list.some((s) =>
        typeof s !== "string" || !SHA_RE.test(s)
      )
    ) throw new Error("backup CI calibration commits do not parse");
    out.set(repo, [...new Set(list as GitSha[])]);
  }
  return out;
}

/** The trusted run's own identity (§9.1); its repository id, or null. */
export async function backupCiIdentity(
  api: ReturnType<typeof createBackupCiApi>,
  env: (name: string) => string | undefined,
): Promise<number | null> {
  const runId = env("GITHUB_RUN_ID") ?? "";
  if (
    !/^[1-9][0-9]{0,18}$/.test(runId) || env("GITHUB_RUN_ATTEMPT") !== "1" ||
    env("GITHUB_REPOSITORY") !== BACKUP_CI_SENTINEL_REPOSITORY ||
    env("GITHUB_REF") !== BACKUP_CI_RUN_REF ||
    !SHA_RE.test(env("GITHUB_SHA") ?? "")
  ) return null;
  const run = await api.get(
    `/repos/${BACKUP_CI_SENTINEL_REPOSITORY}/actions/runs/${runId}/attempts/1`,
  ) as Record<string, unknown> | null;
  const repo = run?.repository as Record<string, unknown> | undefined;
  const head = run?.head_repository as Record<string, unknown> | undefined;
  if (
    run === null || run.path !== BACKUP_CI_WORKFLOW_PATH ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "sentinel-supervisor" ||
    run.head_sha !== env("GITHUB_SHA") ||
    repo?.full_name !== BACKUP_CI_SENTINEL_REPOSITORY ||
    head?.full_name !== BACKUP_CI_SENTINEL_REPOSITORY ||
    typeof repo?.id !== "number" || !Number.isSafeInteger(repo.id)
  ) return null;
  return repo.id as number;
}

function output(lines: Record<string, string>): void {
  const path = Deno.env.get("GITHUB_OUTPUT");
  const text = Object.entries(lines).map(([k, v]) => `${k}=${v}\n`).join("");
  if (path !== undefined) Deno.writeTextFileSync(path, text, { append: true });
}

function summary(title: string, counts: Record<string, number>): void {
  const path = Deno.env.get("GITHUB_STEP_SUMMARY");
  if (path === undefined) return;
  const rows = Object.entries(counts).sort().map(([k, v]) =>
    `| ${k.replace(/[^a-z0-9_:.-]/gi, "")} | ${v} |`
  );
  Deno.writeTextFileSync(
    path,
    `### ${title}\n\n| outcome | count |\n| --- | --- |\n${rows.join("\n")}\n`,
    { append: true },
  );
}

async function pass(): Promise<number> {
  const env = (name: string) => Deno.env.get(name);
  output({ hasWork: "false", slot0: "false", slot1: "false" });
  const mode = parseBackupCiMode(env("SENTINEL_BACKUP_CI"));
  if (mode === "off") return 0;
  const token = env("GITHUB_TOKEN") ?? "";
  const targetToken = env("SENTINEL_TARGET_READ_TOKEN") ?? "";
  const runTemp = env("RUNNER_TEMP") ?? "";
  if (token === "" || targetToken === "" || !runTemp.startsWith("/")) return 1;
  const sentinel = createBackupCiApi(token);
  const sentinelId = await backupCiIdentity(sentinel, env);
  if (sentinelId === null) {
    console.log("backup-ci:identity_refused");
    return 1;
  }
  const workDir = `${runTemp}/backup-ci`;
  await Deno.mkdir(workDir, { recursive: true, mode: 0o700 });
  const targets = parseBackupCiTargets(
    JSON.parse(await Deno.readTextFile("sentinel.backup-ci-targets.json")),
  );
  const pins = parseBackupCiPins(
    JSON.parse(await Deno.readTextFile("ops/backup-ci-pins.json")),
  );
  const calibration = parseBackupCiCalibrationCommits(
    JSON.parse(await Deno.readTextFile("ops/backup-ci-calibration.json")),
  );
  const git = createBackupCiGit(`${workDir}/git-home`);
  const state = createRepairStateStore({
    scratchDir: `${workDir}/state`,
    remoteUrl: HOSTED_CONTROLLER_REMOTE,
    runner: new DenoGitRunner(
      `${workDir}/git-home`,
      backupCiFetchAuthEnv(token),
    ),
  });
  const read = await readRepairSafely(state);
  const snapshot: RepairStateSnapshotV1 | null =
    read !== null && read.ok && read.value.status === "found"
      ? read.value.snapshot
      : null;
  const store = await openBackupCiStore({
    git,
    scratch: `${workDir}/store`,
    remote: BACKUP_CI_STORE_REMOTE,
  });
  const targetApi = createBackupCiApi(targetToken);
  const passFile = await runBackupCiPass({
    runId: Number(env("GITHUB_RUN_ID")),
    launcherSha: env("GITHUB_SHA") as GitSha,
    mode,
    runnerId: pins === null ? null : backupCiRunnerId(pins),
    now: () => Date.now(),
    targets,
    calibrationCommits: (repo) => calibration.get(repo) ?? [],
    snapshot,
    store,
    legs: createBackupCiLegReads(sentinel),
    sentinelId,
    targetReads: (owner, name) =>
      createBackupCiTargetReads(targetApi, owner, name),
    materialize: (owner, name, commits, dir) =>
      fetchBackupCiBare({
        git,
        dir,
        remoteUrl: `https://github.com/${owner}/${name}`,
        token: targetToken,
        commits,
      }),
    actionSource: (local) => rawGithubActionSource(local),
    workDir,
    tokenNeedles: [
      ...backupCiTokenNeedles(token),
      ...backupCiTokenNeedles(targetToken),
    ],
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const bytes = new TextEncoder().encode(canonicalStringify(passFile));
  await Deno.writeFile(`${workDir}/pass.json`, bytes);
  const hasWork = passFile.files.length > 0 || passFile.units.length > 0 ||
    passFile.comparisons.length > 0;
  const lines: Record<string, string> = {
    passDigest: backupCiBytesDigest(bytes),
    hasWork: String(hasWork),
  };
  for (const slot of [0, 1]) {
    const unit = passFile.units.find((u) => u.slot === slot);
    lines[`slot${slot}`] = String(unit !== undefined);
    lines[`unit${slot}`] = unit?.unit.unitId ?? "";
  }
  output(lines);
  summary("sentinel-backup-ci pass", {
    units: passFile.units.length,
    files: passFile.files.length,
    comparisons: passFile.comparisons.reduce(
      (n, c) => n + c.comparisons.length,
      0,
    ),
  });
  return 0;
}

async function commit(): Promise<number> {
  const env = (name: string) => Deno.env.get(name);
  if (parseBackupCiMode(env("SENTINEL_BACKUP_CI")) === "off") return 0;
  const token = env("GITHUB_TOKEN") ?? "";
  const runTemp = env("RUNNER_TEMP") ?? "";
  const sha = env("GITHUB_SHA") ?? "";
  const digest = env("SENTINEL_BACKUP_PASS_DIGEST") ?? "";
  if (
    token === "" || !runTemp.startsWith("/") || !SHA_RE.test(sha) ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    env("GITHUB_REPOSITORY") !== BACKUP_CI_SENTINEL_REPOSITORY
  ) return 1;
  const workDir = `${runTemp}/backup-ci`;
  const git = createBackupCiGit(`${workDir}/git-home`);
  const runId = Number(env("GITHUB_RUN_ID"));
  const result = await commitBackupCiPass({
    passBytes: await Deno.readFile(`${workDir}/pass.json`),
    expectedDigest: digest,
    trees: [env("SENTINEL_BACKUP_TREE0"), env("SENTINEL_BACKUP_TREE1")],
    githubSha: sha as GitSha,
    runId,
    now: () => Date.now(),
    api: createBackupCiApi(token),
    repository: BACKUP_CI_SENTINEL_REPOSITORY,
    writeStore: (mutate) =>
      writeBackupCiStore({
        git,
        scratch: `${workDir}/store-write`,
        remote: BACKUP_CI_STORE_REMOTE,
        pushEnv: backupCiFetchAuthEnv(token),
        runId,
        now: () => Date.now(),
        mutate,
        log: (line) => console.log(line),
      }),
    log: (line) => console.log(line),
  });
  summary("sentinel-backup-ci commit", result.counts);
  return result.code;
}

if (import.meta.main) {
  const command = Deno.args[0];
  const code = command === "pass"
    ? await pass()
    : command === "commit"
    ? await commit()
    : 2;
  Deno.exit(code);
}

export type { BackupCiPassFileV1 };
