/**
 * The UNTRUSTED backup CI leg's I/O shell (docs/backup-ci-spec.md §10):
 * `install` (the pinned act), `prepare` (verify the unit and its tree, then
 * the self-test, all before any target code), `run` (act as a clean systemd
 * service; classify; write `result.json`) and `marker` (the one result line
 * the trusted ingest binds). The leg VM holds nothing of value: no
 * environment, no secret, no target token (§13). Everything it reports is
 * re-verified by the trusted ingest (§9.2); it never writes the store.
 *
 * Exit codes: 0 when the step's output was written; 1 on any refusal (a
 * failed leg job is infrastructure, never a verdict). `run` exits 0 once
 * `result.json` is written, whatever the target's verdict.
 */
import { createHash } from "node:crypto";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  backupCiBytesDigest,
  type BackupCiResultV1,
  backupCiUnitDigest,
  type BackupCiUnitV1,
  parseBackupCiResult,
  parseBackupCiUnit,
} from "../src/contracts/backup-ci.ts";
import {
  type BackupCiActJobV1,
  type BackupCiActPathsV1,
  type BackupCiActRecordV1,
  backupCiPinsUsable,
  backupCiRunnerId,
  buildActArgv,
  buildSystemdRunArgv,
  classifyActRun,
  parseActJsonLine,
  parseBackupCiPins,
  parseEtcEnvironment,
  plannedStepIndex,
  recordOfJob,
} from "./backup-ci-act.ts";
import {
  BackupCiLogSanitizer,
  stopCommandsToken,
} from "./backup-ci-log-sanitize.ts";
import {
  BACKUP_CI_GIT_SAFETY,
  type BackupCiGitV1,
  fileSha256,
  readBoundedBody,
} from "./backup-ci-materialize.ts";
import { runBackupCiSelfTest } from "./backup-ci-leg-selftest.ts";

const HEX24 = /^[0-9a-f]{24}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IMAGE_RE = /^[A-Za-z0-9._-]{1,32}$/;
export const BACKUP_CI_MAX_ACT_BYTES = 64 * 2 ** 20;

/** One service run: act's stdout lines as they arrive, then the exit. */
export type BackupCiServiceRunnerV1 = (
  argv: string[],
  onLine: (line: string) => void,
) => Promise<{ code: number | null; elapsedMs: number }>;

export interface BackupCiLegDepsV1 {
  env(name: string): string | undefined;
  runTemp: string;
  /** The launcher checkout (pins and the self-test fixture). */
  launcherRoot: string;
  home: string;
  now(): number;
  print(line: string): void;
  git: BackupCiGitV1;
  /** `tar` argv runner (no shell). */
  tar(args: string[]): Promise<{ code: number; stdout: string }>;
  service: BackupCiServiceRunnerV1;
  etcEnvironment(): Promise<string>;
  /** The directory holding the setup-node `node` (the act JS runtime). */
  nodeDir(): Promise<string | null>;
  /** `<act> --version` output, or null. */
  actVersion(act: string): Promise<string | null>;
  fetch?: typeof fetch;
}

export interface BackupCiLegLayoutV1 {
  root: string;
  input: string;
  bare: string;
  ws: string;
  out: string;
  result: string;
  observed: string;
  paths: BackupCiActPathsV1;
}

export function backupCiLegLayout(runTemp: string): BackupCiLegLayoutV1 {
  const root = `${runTemp}/backup-ci`;
  return {
    root,
    input: `${root}/in`,
    bare: `${root}/bare`,
    ws: `${root}/ws`,
    out: `${root}/out`,
    result: `${root}/out/result.json`,
    observed: `${root}/observed.json`,
    paths: {
      act: `${root}/bin/act`,
      ws: `${root}/ws`,
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
    },
  };
}

class LegRefusal extends Error {}
const refuse = (message: string): never => {
  throw new LegRefusal(message);
};

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function git(
  deps: BackupCiLegDepsV1,
  cwd: string,
  args: string[],
): Promise<string> {
  const out = await deps.git.runGit([...BACKUP_CI_GIT_SAFETY, ...args], {
    cwd,
  });
  if (!out.ok) refuse(`git ${args[0]} failed`);
  return out.stdout;
}

/** The unit in the extracted tree, bound to the dispatch inputs. */
async function readUnit(
  deps: BackupCiLegDepsV1,
  layout: BackupCiLegLayoutV1,
): Promise<BackupCiUnitV1> {
  const unitId = deps.env("BACKUP_UNIT") ?? "";
  const digest = deps.env("BACKUP_UNIT_DIGEST") ?? "";
  if (!HEX24.test(unitId) || !HEX64.test(digest)) refuse("unit inputs");
  let unit: BackupCiUnitV1;
  try {
    unit = parseBackupCiUnit(
      JSON.parse(await Deno.readTextFile(`${layout.bare}/unit.json`)),
    );
  } catch {
    return refuse("unit.json does not parse");
  }
  if (unit.unitId !== unitId || backupCiUnitDigest(unit) !== digest) {
    refuse("unit digest mismatch");
  }
  return unit;
}

/** The act job spec of a unit. */
export function unitActJob(unit: BackupCiUnitV1): BackupCiActJobV1 {
  return {
    context: unit.key.context,
    workflowPath: unit.workflow.path,
    jobKey: unit.job.key,
    matrix: unit.job.matrix,
    runsOn: unit.job.runsOn,
    defaultBranch: unit.repository.defaultBranch,
    capMinutes: unit.job.capMinutes,
  };
}

/** `install`: the pinned act, by sha256, or a refusal. */
export async function legInstall(deps: BackupCiLegDepsV1): Promise<number> {
  const pins = parseBackupCiPins(
    JSON.parse(
      await Deno.readTextFile(`${deps.launcherRoot}/ops/backup-ci-pins.json`),
    ),
  );
  if (pins === null || !backupCiPinsUsable(pins, deps.now())) {
    deps.print("backup-ci: the act pin is not filled or too new; refusing");
    return 1;
  }
  const layout = backupCiLegLayout(deps.runTemp);
  const url = `https://github.com/nektos/act/releases/download/${
    encodeURIComponent(pins.act.version)
  }/${pins.act.asset}`;
  const response = await (deps.fetch ?? fetch)(url, { redirect: "follow" });
  if (response.status !== 200) {
    await response.body?.cancel();
    deps.print("backup-ci: act download failed");
    return 1;
  }
  const bytes = await readBoundedBody(response, BACKUP_CI_MAX_ACT_BYTES);
  if (
    bytes === null ||
    createHash("sha256").update(bytes).digest("hex") !== pins.act.sha256
  ) {
    deps.print("backup-ci: act digest mismatch");
    return 1;
  }
  await Deno.mkdir(`${layout.root}/bin`, { recursive: true });
  const archive = `${layout.root}/act.tar.gz`;
  await Deno.writeFile(archive, bytes);
  const extracted = await deps.tar([
    "-xzf",
    archive,
    "-C",
    `${layout.root}/bin`,
    "--no-same-owner",
    "act",
  ]);
  if (extracted.code !== 0) {
    deps.print("backup-ci: act extraction failed");
    return 1;
  }
  // The release archive carries act as 0755 and tar keeps the mode. No chmod:
  // Deno refuses any write to a path granted in `--allow-run` (live leg,
  // 2026-10-25), so the mode is checked with a read instead.
  const mode = (await Deno.stat(layout.paths.act)).mode;
  if (mode === null || (mode & 0o111) !== 0o111) {
    deps.print("backup-ci: act is not executable");
    return 1;
  }
  const version = await deps.actVersion(layout.paths.act);
  if (version === null || !version.includes(pins.act.version.slice(1))) {
    deps.print("backup-ci: act version mismatch");
    return 1;
  }
  return 0;
}

/** Validates `tar -tvf` output: regular files and directories under bare/. */
export function tarListingSafe(listing: string): boolean {
  const lines = listing.split("\n").filter((l) => l.length > 0);
  return lines.length > 0 && lines.every((line) => {
    const match =
      /^([-d])[rwxsStT-]{9} \d+\/\d+ +\d+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} (bare(?:\/[A-Za-z0-9._-]+)*\/?)$/
        .exec(line);
    return match !== null && !match[2].split("/").includes("..");
  });
}

/** `prepare`: everything that must hold before target code runs. */
export async function legPrepare(deps: BackupCiLegDepsV1): Promise<number> {
  try {
    await prepare(deps);
    return 0;
  } catch (error) {
    deps.print(
      `backup-ci: prepare refused: ${
        error instanceof LegRefusal ? error.message : "unexpected error"
      }`,
    );
    return 1;
  }
}

async function prepare(deps: BackupCiLegDepsV1): Promise<void> {
  const layout = backupCiLegLayout(deps.runTemp);
  const treeSha = deps.env("BACKUP_TREE_SHA256") ?? "";
  if (!HEX64.test(treeSha)) refuse("tree input");
  // download-artifact by artifact id writes `in/<artifact name>/<file>`: the
  // input holds exactly the unit's own artifact directory with one tar.
  const unitId = deps.env("BACKUP_UNIT") ?? "";
  if (!HEX24.test(unitId)) refuse("unit inputs");
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(layout.input)) entries.push(entry);
  if (
    entries.length !== 1 || !entries[0].isDirectory ||
    entries[0].name !== `backup-tree-${unitId}`
  ) refuse("input dir");
  const artifactDir = `${layout.input}/${entries[0].name}`;
  const tars: string[] = [];
  for await (const entry of Deno.readDir(artifactDir)) {
    if (!entry.isFile || !/^[01]\.tar$/.test(entry.name)) refuse("input dir");
    tars.push(`${artifactDir}/${entry.name}`);
  }
  if (tars.length !== 1) refuse("input dir");
  if (await fileSha256(tars[0]) !== treeSha) refuse("tree digest mismatch");
  if (await exists(layout.bare) || await exists(layout.ws)) refuse("not fresh");
  const listing = await deps.tar(["-tvf", tars[0], "--numeric-owner"]);
  if (listing.code !== 0 || !tarListingSafe(listing.stdout)) {
    refuse("tree listing");
  }
  const extracted = await deps.tar([
    "-xf",
    tars[0],
    "-C",
    layout.root,
    "--no-same-owner",
    "--no-same-permissions",
  ]);
  if (extracted.code !== 0) refuse("tree extraction");
  const unit = await readUnit(deps, layout);
  await git(deps, layout.root, [
    "-c",
    "protocol.file.allow=always",
    "clone",
    "-q",
    "--depth",
    "1",
    "--no-tags",
    "--branch",
    "backup-exec",
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.fileMode=true",
    `file://${layout.bare}`,
    layout.ws,
  ]);
  await git(deps, layout.ws, [
    "remote",
    "set-url",
    "origin",
    `https://github.com/${unit.repository.owner}/${unit.repository.name}`,
  ]);
  const head = (await git(deps, layout.ws, ["rev-parse", "HEAD"])).trim();
  const tree = (await git(deps, layout.ws, ["rev-parse", "HEAD^{tree}"]))
    .trim();
  const raw = await git(deps, layout.ws, ["cat-file", "commit", "HEAD"]);
  const parents = raw.split("\n\n")[0].split("\n").filter((l) =>
    l.startsWith("parent ")
  ).map((l) => l.slice(7));
  const listed = (await git(deps, layout.ws, [
    "ls-tree",
    "HEAD",
    "--",
    unit.workflow.path,
  ])).trim();
  const status = await git(deps, layout.ws, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (head !== unit.exec.commit) refuse("HEAD is not the exec commit");
  if (tree !== unit.exec.tree) refuse("tree mismatch");
  if (canonicalStringify(parents) !== canonicalStringify(unit.exec.parents)) {
    refuse("parents mismatch");
  }
  if (listed !== `100644 blob ${unit.workflow.blob}\t${unit.workflow.path}`) {
    refuse("workflow blob mismatch");
  }
  if (status.length !== 0) refuse("workspace is not clean");
  await Deno.writeTextFile(
    layout.observed,
    canonicalStringify({
      head,
      tree,
      parents,
      workflowBlob: unit.workflow.blob,
      clean: true,
    }),
  );
  // act reads `~/.actrc` and `$XDG_CONFIG_HOME/act/actrc` (default
  // `~/.config/act/actrc`). The hosted image always sets XDG_CONFIG_HOME
  // (`$HOME/.config`), and act creates its config directory on every run,
  // so only an actual configuration file refuses.
  const xdg = deps.env("XDG_CONFIG_HOME");
  if (
    await exists(`${deps.home}/.actrc`) ||
    await exists(`${deps.home}/.config/act/actrc`) ||
    (xdg !== undefined && xdg.startsWith("/") &&
      await exists(`${xdg}/act/actrc`))
  ) refuse("act configuration in HOME");
  for (
    const dir of [
      "empty",
      "cwd",
      "action-cache",
      "cache-server",
      "artifacts",
      "out",
    ]
  ) {
    await Deno.mkdir(`${layout.root}/${dir}`, { recursive: true });
  }
  for (const file of Object.values(layout.paths.empty)) {
    await Deno.writeTextFile(file, "");
  }
  await Deno.writeTextFile(layout.paths.event, JSON.stringify(unit.event));
  const passed = await runBackupCiSelfTest(
    deps,
    unit,
    (job, paths, name) => runAct(deps, job, paths, name, null),
  );
  if (!passed) refuse("self-test failed");
}

export interface BackupCiActRunV1 {
  records: BackupCiActRecordV1[];
  code: number | null;
  timedOut: boolean;
}

/** One act service run, its output sanitized into the job log. */
export async function runAct(
  deps: BackupCiLegDepsV1,
  job: BackupCiActJobV1,
  paths: BackupCiActPathsV1,
  unitName: string,
  unit: BackupCiUnitV1 | null,
): Promise<BackupCiActRunV1> {
  const etc = parseEtcEnvironment(await deps.etcEnvironment());
  const nodeDir = await deps.nodeDir();
  if (nodeDir === null) refuse("node runtime missing");
  // A two-line exec shim (a symlink would need unscoped write permission).
  const shim = `${paths.emptyCwd}-node`;
  await Deno.mkdir(shim, { recursive: true });
  if (!/^\/[A-Za-z0-9._/-]+$/.test(nodeDir!)) refuse("node runtime path");
  await Deno.writeTextFile(
    `${shim}/node`,
    `#!/bin/sh\nexec '${nodeDir}/node' "$@"\n`,
    { mode: 0o755 },
  );
  await Deno.chmod(`${shim}/node`, 0o755);
  const image = (name: string) => {
    const value = deps.env(name) ?? "";
    return IMAGE_RE.test(value) ? value : "unknown";
  };
  const argv = buildSystemdRunArgv({
    unitName,
    capMinutes: job.capMinutes,
    emptyCwd: paths.emptyCwd,
    nodeShimDir: shim,
    etcEnvironment: etc,
    imageOs: image("ImageOS"),
    imageVersion: image("ImageVersion"),
    actArgv: buildActArgv(job, paths),
  });
  const sanitizer = new BackupCiLogSanitizer(stopCommandsToken(), deps.print);
  const records: BackupCiActRecordV1[] = [];
  sanitizer.begin();
  const { code, elapsedMs } = await deps.service(argv, (line) => {
    const record = parseActJsonLine(line);
    if (record === null) {
      sanitizer.line(null, line);
      return;
    }
    if (records.length < 200_000) records.push(record);
    if (record.msg === null) return;
    const index = unit !== null && recordOfJob(record, unit.job)
      ? plannedStepIndex(record, unit.steps)
      : null;
    sanitizer.line(index, record.msg);
  });
  sanitizer.end();
  return {
    records,
    code,
    timedOut: code !== 0 && elapsedMs >= job.capMinutes * 60_000 - 1_000,
  };
}

/** `run`: the target job, classified into `result.json`. */
export async function legRun(deps: BackupCiLegDepsV1): Promise<number> {
  try {
    const layout = backupCiLegLayout(deps.runTemp);
    const unit = await readUnit(deps, layout);
    const observed = JSON.parse(await Deno.readTextFile(layout.observed));
    const pins = parseBackupCiPins(
      JSON.parse(
        await Deno.readTextFile(`${deps.launcherRoot}/ops/backup-ci-pins.json`),
      ),
    );
    if (pins === null) refuse("act pin is not filled");
    const runnerId = backupCiRunnerId(pins!);
    if (runnerId !== unit.plan.runnerId) refuse("runner id mismatch");
    const startedAt = deps.now();
    const run = await runAct(
      deps,
      unitActJob(unit),
      layout.paths,
      "sentinel-backup-act-0",
      unit,
    );
    const completedAt = deps.now();
    const verdict = classifyActRun(unit, run.records, run);
    const image = (name: string) => {
      const value = deps.env(name) ?? "";
      return IMAGE_RE.test(value) ? value : "unknown";
    };
    const result: BackupCiResultV1 = parseBackupCiResult({
      version: 1,
      kind: "sentinel_backup_ci_result",
      unitId: unit.unitId,
      unitDigest: backupCiUnitDigest(unit),
      observed,
      selftest: "passed",
      outcome: verdict.outcome,
      reason: verdict.reason,
      act: { exitCode: run.code, jobResults: verdict.jobResults },
      steps: verdict.steps,
      failingStep: verdict.failingStep,
      startedAt,
      completedAt,
      runner: {
        runnerId,
        imageOs: image("ImageOS"),
        imageVersion: image("ImageVersion"),
      },
    });
    await Deno.mkdir(layout.out, { recursive: true });
    await Deno.writeTextFile(layout.result, canonicalStringify(result));
    return 0;
  } catch (error) {
    deps.print(
      `backup-ci: run refused: ${
        error instanceof LegRefusal ? error.message : "unexpected error"
      }`,
    );
    return 1;
  }
}

/** The marker line the trusted ingest binds (§10.6). */
export function backupCiMarkerLine(fields: {
  unitId: string;
  unitDigest: string;
  resultDigest: string;
  artifactId: number;
}): string {
  return JSON.stringify({
    kind: "sentinel_backup_ci_leg_result",
    unitId: fields.unitId,
    unitDigest: fields.unitDigest,
    resultDigest: fields.resultDigest,
    artifactId: fields.artifactId,
  });
}

/** `marker`: exactly one result line. */
export async function legMarker(deps: BackupCiLegDepsV1): Promise<number> {
  const layout = backupCiLegLayout(deps.runTemp);
  const artifact = Number(deps.env("BACKUP_RESULT_ARTIFACT") ?? "");
  let bytes: Uint8Array;
  let result: BackupCiResultV1;
  try {
    bytes = await Deno.readFile(layout.result);
    result = parseBackupCiResult(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    deps.print("backup-ci: no result to report");
    return 1;
  }
  if (
    !Number.isSafeInteger(artifact) || artifact <= 0 ||
    result.unitId !== deps.env("BACKUP_UNIT") ||
    result.unitDigest !== deps.env("BACKUP_UNIT_DIGEST")
  ) {
    deps.print("backup-ci: result does not bind the dispatch inputs");
    return 1;
  }
  deps.print(backupCiMarkerLine({
    unitId: result.unitId,
    unitDigest: result.unitDigest,
    resultDigest: backupCiBytesDigest(bytes),
    artifactId: artifact,
  }));
  return 0;
}

if (import.meta.main) {
  const { productionLegDeps, safeEnv } = await import(
    "./backup-ci-leg-host.ts"
  );
  const { createBackupCiGit } = await import("./backup-ci-materialize.ts");
  const deps = productionLegDeps(
    createBackupCiGit(`${safeEnv("RUNNER_TEMP") ?? "/tmp"}/backup-ci-git-home`),
  );
  const command = Deno.args[0];
  const code = command === "install"
    ? await legInstall(deps)
    : command === "prepare"
    ? await legPrepare(deps)
    : command === "run"
    ? await legRun(deps)
    : command === "marker"
    ? await legMarker(deps)
    : 2;
  Deno.exit(code);
}
