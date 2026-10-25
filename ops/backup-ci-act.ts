/**
 * The act invocation, event payloads and run classification of a backup CI
 * leg (docs/backup-ci-spec.md §4, §9.4, §10.3, §10.4). Pure: the leg shell
 * (`backup-ci-leg.ts`) supplies paths, the runner environment and act's
 * structured output; the trusted planner builds event payloads here.
 *
 * act runs in host mode (`-P <label>=-self-hosted`) as a clean systemd
 * service with the private-runner size and kill-on-exit. Nothing from the
 * target reaches its argv except the parsed job key, matrix values and the
 * event file; no Docker, privileged or host-environment flag is ever built.
 * Classification reads only act's JSON records (`jobID`, `matrix`, `stage`,
 * `stepID`, `stepResult`, `jobResult`) and the service exit, and every
 * disagreement between them is `act_inconsistent`, never a verdict.
 */
import { createHash } from "node:crypto";
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  BACKUP_CI_LEG_REVISION,
  BACKUP_CI_RUNNER_LIMITS,
  BACKUP_CI_SETUP_ACTIONS,
  type BackupCiConclusionV1,
  type BackupCiContextV1,
  type BackupCiMatrixV1,
  type BackupCiPlannedStepV1,
  type BackupCiRunsOnV1,
  type BackupCiStepResultV1,
} from "../src/contracts/backup-ci.ts";

export const BACKUP_CI_ACTOR = "ubiquity-sentinel[bot]";
const ZERO_SHA = "0".repeat(40);

/** `ops/backup-ci-pins.json`. */
export interface BackupCiPinsV1 {
  act: { version: string; releasedAt: string; asset: string; sha256: string };
  node: string;
}

export const BACKUP_CI_PIN_MIN_AGE_MS = 14 * 86_400_000;

/**
 * The pins, or null when any value is missing, malformed or a placeholder:
 * an unfilled pin fails closed (the leg refuses to install act and the
 * trusted pass plans nothing, since there is no runner id).
 */
export function parseBackupCiPins(input: unknown): BackupCiPinsV1 | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const o = input as Record<string, unknown>;
  const act = o.act as Record<string, unknown> | undefined;
  if (
    Object.keys(o).sort().join(",") !== "act,node" ||
    typeof act !== "object" || act === null ||
    Object.keys(act).sort().join(",") !== "asset,releasedAt,sha256,version"
  ) return null;
  const { version, releasedAt, asset, sha256 } = act;
  if (
    typeof version !== "string" ||
    !/^v[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}$/.test(version) ||
    typeof releasedAt !== "string" ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(releasedAt) ||
    !Number.isFinite(Date.parse(`${releasedAt}T00:00:00Z`)) ||
    asset !== "act_Linux_x86_64.tar.gz" ||
    typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) ||
    typeof o.node !== "string" ||
    !/^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(o.node)
  ) return null;
  return { act: { version, releasedAt, asset, sha256 }, node: o.node };
}

/** A pin is usable once its release is at least 14 days old at `now`. */
export function backupCiPinsUsable(pins: BackupCiPinsV1, now: number): boolean {
  return now - Date.parse(`${pins.act.releasedAt}T00:00:00Z`) >=
    BACKUP_CI_PIN_MIN_AGE_MS;
}

/** `hex16(sha256(canonical({act, node, legRevision})))`. */
export function backupCiRunnerId(pins: BackupCiPinsV1): string {
  return createHash("sha256").update(
    canonicalStringify({
      act: pins.act,
      node: pins.node,
      legRevision: BACKUP_CI_LEG_REVISION,
    }),
    "utf8",
  ).digest("hex").slice(0, 16);
}

/** What act needs to select and run one job (a unit, or the self-test). */
export interface BackupCiActJobV1 {
  context: BackupCiContextV1;
  workflowPath: string;
  jobKey: string;
  matrix: BackupCiMatrixV1;
  runsOn: BackupCiRunsOnV1;
  defaultBranch: string;
  capMinutes: number;
}

export interface BackupCiActPathsV1 {
  act: string;
  ws: string;
  emptyCwd: string;
  event: string;
  empty: { env: string; secrets: string; vars: string; input: string };
  actionCache: string;
  cacheServer: string;
  artifactServer: string;
}

/** act's argv (§10.3). */
export function buildActArgv(
  job: BackupCiActJobV1,
  paths: BackupCiActPathsV1,
): string[] {
  const matrix = Object.entries(job.matrix ?? {}).flatMap(([axis, value]) => [
    "--matrix",
    `${axis}:${String(value)}`,
  ]);
  return [
    paths.act,
    job.context,
    "-C",
    paths.ws,
    "-W",
    `${paths.ws}/${job.workflowPath}`,
    "-j",
    job.jobKey,
    ...matrix,
    "-e",
    paths.event,
    "-P",
    `${job.runsOn}=-self-hosted`,
    "--actor",
    BACKUP_CI_ACTOR,
    "--defaultbranch",
    job.defaultBranch,
    "--remote-name",
    "origin",
    "--use-gitignore=false",
    "--env-file",
    paths.empty.env,
    "--secret-file",
    paths.empty.secrets,
    "--var-file",
    paths.empty.vars,
    "--input-file",
    paths.empty.input,
    "--container-daemon-socket",
    "-",
    "--action-cache-path",
    paths.actionCache,
    "--cache-server-path",
    paths.cacheServer,
    "--artifact-server-path",
    paths.artifactServer,
    "--json",
  ];
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\x00-\x1f]/;
/** Runner variables that never reach the act service from `/etc/environment`. */
const SERVICE_DENIED =
  /^(?:HOME|PATH|CI|ACT|ImageOS|ImageVersion|RUNNER_.*|GITHUB_.*|ACTIONS_.*|INPUT_.*|STATE_.*|AGENT_TOOLSDIRECTORY)$/;

/** `/etc/environment` as `KEY=VALUE` lines (quotes removed, others dropped). */
export function parseEtcEnvironment(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    let value = line.slice(eq + 1);
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) {
      value = value.slice(1, -1);
    }
    if (!ENV_KEY_RE.test(key) || CONTROL_CHARS.test(value)) continue;
    out[key] = value;
  }
  return out;
}

export interface BackupCiServiceInputV1 {
  unitName: string;
  capMinutes: number;
  emptyCwd: string;
  nodeShimDir: string;
  etcEnvironment: Record<string, string>;
  imageOs: string;
  imageVersion: string;
  actArgv: string[];
}

/** The clean `systemd-run` service around act (§10.3), as `sudo` argv. */
export function buildSystemdRunArgv(input: BackupCiServiceInputV1): string[] {
  const path = [input.nodeShimDir, input.etcEnvironment.PATH ?? "/usr/bin:/bin"]
    .join(":");
  const extra = Object.entries(input.etcEnvironment)
    .filter(([key]) => !SERVICE_DENIED.test(key))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `--setenv=${key}=${value}`);
  return [
    "systemd-run",
    `--unit=${input.unitName}`,
    "--pipe",
    "--wait",
    "--collect",
    "--quiet",
    "--uid=runner",
    "--gid=runner",
    `--working-directory=${input.emptyCwd}`,
    "-p",
    `MemoryMax=${BACKUP_CI_RUNNER_LIMITS.memoryGiB}G`,
    "-p",
    `CPUQuota=${BACKUP_CI_RUNNER_LIMITS.cpus * 100}%`,
    "-p",
    "TasksMax=8192",
    "-p",
    "KillMode=control-group",
    "-p",
    `RuntimeMaxSec=${input.capMinutes * 60}`,
    "-p",
    "TimeoutStopSec=30",
    "--setenv=HOME=/home/runner",
    `--setenv=PATH=${path}`,
    `--setenv=ImageOS=${input.imageOs}`,
    `--setenv=ImageVersion=${input.imageVersion}`,
    "--setenv=RUNNER_TOOL_CACHE=/opt/hostedtoolcache",
    "--setenv=AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache",
    "--setenv=CI=true",
    ...extra,
    "--",
    ...input.actArgv,
  ];
}

type RepoPayload = {
  full_name: string;
  name: string;
  owner: { login: string };
};

export interface BackupCiEventInputV1 {
  context: BackupCiContextV1;
  repository: {
    owner: string;
    name: string;
    defaultBranch: string;
    private: boolean;
  };
  commit: GitSha;
  ref: string;
  /** Push only: the first parent, or null for a root commit. */
  before: GitSha | null;
  /** pull_request only: fields copied from the pull request API object. */
  pull: {
    number: number;
    draft: boolean;
    user: string;
    head: { sha: GitSha; ref: string; repo: RepoPayload };
    base: { sha: GitSha; ref: string; repo: RepoPayload };
  } | null;
}

/** The synthetic event payload (§9.4); nothing else is copied. */
export function buildEventPayload(
  input: BackupCiEventInputV1,
): Record<string, unknown> {
  const { owner, name, defaultBranch } = input.repository;
  const repository = {
    full_name: `${owner}/${name}`,
    name,
    owner: { login: owner },
    default_branch: defaultBranch,
    private: input.repository.private,
  };
  const sender = { login: BACKUP_CI_ACTOR };
  if (input.context === "pull_request") {
    const pull = input.pull;
    if (pull === null) throw new Error("pull_request payload needs the pull");
    const side = (s: { sha: GitSha; ref: string; repo: RepoPayload }) => ({
      sha: s.sha,
      ref: s.ref,
      repo: {
        full_name: s.repo.full_name,
        name: s.repo.name,
        owner: { login: s.repo.owner.login },
      },
    });
    return {
      action: "synchronize",
      number: pull.number,
      pull_request: {
        number: pull.number,
        state: "open",
        draft: pull.draft,
        head: side(pull.head),
        base: side(pull.base),
        user: { login: pull.user },
      },
      repository,
      sender,
    };
  }
  return {
    ref: input.ref,
    before: input.before ?? ZERO_SHA,
    after: input.commit,
    repository,
    pusher: { name: BACKUP_CI_ACTOR },
    sender,
    head_commit: { id: input.commit },
  };
}

/** One structured act record (unknown fields dropped). */
export interface BackupCiActRecordV1 {
  jobID: string | null;
  matrix: Record<string, unknown> | null;
  stage: string | null;
  stepID: string[] | null;
  stepResult: string | null;
  jobResult: string | null;
  msg: string | null;
}

/** One act JSON line, or null when it is not a JSON object. */
export function parseActJsonLine(line: string): BackupCiActRecordV1 | null {
  if (!line.startsWith("{")) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const o = value as Record<string, unknown>;
  const text = (v: unknown) => typeof v === "string" ? v : null;
  const stepID = Array.isArray(o.stepID) &&
      o.stepID.every((s) => typeof s === "string")
    ? o.stepID as string[]
    : null;
  const matrix = typeof o.matrix === "object" && o.matrix !== null &&
      !Array.isArray(o.matrix)
    ? o.matrix as Record<string, unknown>
    : null;
  return {
    jobID: text(o.jobID),
    matrix,
    stage: text(o.stage),
    stepID,
    stepResult: text(o.stepResult),
    jobResult: text(o.jobResult),
    msg: text(o.msg),
  };
}

function sameMatrix(
  recorded: Record<string, unknown> | null,
  planned: BackupCiMatrixV1,
): boolean {
  const a = recorded ?? {};
  const b = planned ?? {};
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length &&
    ka.every((k, i) => k === kb[i] && String(a[k]) === String(b[k]));
}

/** Whether a record belongs to the planned (job, combination). */
export function recordOfJob(
  record: BackupCiActRecordV1,
  job: { key: string; matrix: BackupCiMatrixV1 },
): boolean {
  return record.jobID === job.key && sameMatrix(record.matrix, job.matrix);
}

/** The planned step index an act record's main-stage step id maps to. */
export function plannedStepIndex(
  record: BackupCiActRecordV1,
  steps: readonly BackupCiPlannedStepV1[],
): number | null {
  if (record.stepID === null || record.stepID.length === 0) return null;
  const step = steps.find((s) => s.actStepId === record.stepID![0]);
  return step === undefined ? null : step.index;
}

export interface BackupCiClassificationV1 {
  outcome: BackupCiConclusionV1 | "no_evidence";
  reason:
    | "setup_action_failed"
    | "act_internal"
    | "act_inconsistent"
    | "skipped_in_backup"
    | "runner_timeout"
    | null;
  jobResults: number;
  steps: { index: number; result: BackupCiStepResultV1 }[];
  failingStep: number | null;
}

export interface BackupCiClassifyJobV1 {
  job: {
    key: string;
    matrix: BackupCiMatrixV1;
    capMinutes: number;
    targetTimeoutMinutes: number | null;
  };
  steps: readonly BackupCiPlannedStepV1[];
}

const SETUP = new Set<string>(BACKUP_CI_SETUP_ACTIONS);

/** Whether a remote step is an allowlisted setup action (`owner/repo`). */
export function isSetupAction(uses: string | null): boolean {
  if (uses === null) return false;
  const [owner, repo] = uses.split("@")[0].split("/");
  return SETUP.has(`${owner}/${repo}`.toLowerCase());
}

const STEP_RESULTS = new Set(["success", "failure", "skipped", "cancelled"]);

/** The §10.4 classification of one act run. */
export function classifyActRun(
  unit: BackupCiClassifyJobV1,
  records: readonly BackupCiActRecordV1[],
  exit: { code: number | null; timedOut: boolean },
): BackupCiClassificationV1 {
  const mine = records.filter((r) => recordOfJob(r, unit.job));
  const results = new Map<number, Set<string>>();
  let preOrPostFailure: BackupCiPlannedStepV1 | null = null;
  for (const record of mine) {
    if (record.stepResult === null) continue;
    const index = plannedStepIndex(record, unit.steps);
    if (index === null || record.stepID!.length !== 1) continue;
    if (record.stage !== "Main") {
      if (record.stepResult === "failure") {
        preOrPostFailure ??= unit.steps.find((s) => s.index === index) ?? null;
      }
      continue;
    }
    const set = results.get(index) ?? new Set<string>();
    results.set(index, set.add(record.stepResult));
  }
  let conflicting = false;
  const steps = unit.steps.map((step) => {
    const set = results.get(step.index);
    if (set === undefined || set.size === 0) {
      return { index: step.index, result: "missing" as BackupCiStepResultV1 };
    }
    const [only] = [...set];
    if (set.size > 1 || !STEP_RESULTS.has(only)) conflicting = true;
    return {
      index: step.index,
      result:
        (STEP_RESULTS.has(only) ? only : "missing") as BackupCiStepResultV1,
    };
  });
  const jobResults = mine.filter((r) => r.jobResult !== null);
  const out = (
    outcome: BackupCiClassificationV1["outcome"],
    reason: BackupCiClassificationV1["reason"],
    failingStep: number | null = null,
  ): BackupCiClassificationV1 => ({
    outcome,
    reason,
    jobResults: jobResults.length,
    steps,
    failingStep,
  });
  if (exit.timedOut) {
    const running = steps.find((s) => s.result === "missing")?.index ?? null;
    return unit.job.targetTimeoutMinutes === unit.job.capMinutes
      ? out("timed_out", null, running)
      : out("no_evidence", "runner_timeout");
  }
  if (mine.length === 0) return out("no_evidence", "act_internal");
  if (jobResults.length !== 1) return out("no_evidence", "skipped_in_backup");
  const jobResult = jobResults[0].jobResult;
  if (jobResult === "skipped") return out("no_evidence", "skipped_in_backup");
  if (conflicting) return out("no_evidence", "act_inconsistent");
  const byIndex = new Map(unit.steps.map((s) => [s.index, s]));
  if (jobResult === "success") {
    const ok = exit.code === 0 && steps.every(({ index, result }) => {
      const step = byIndex.get(index)!;
      return result === "success" ||
        (result === "skipped" && step.condition === "status_only") ||
        (result === "failure" && step.continueOnError);
    });
    return ok ? out("success", null) : out("no_evidence", "act_inconsistent");
  }
  if (jobResult !== "failure" || exit.code === 0) {
    return out("no_evidence", "act_inconsistent");
  }
  const failing = steps.find(({ index, result }) =>
    result === "failure" && !byIndex.get(index)!.continueOnError
  );
  if (failing === undefined) {
    return preOrPostFailure !== null && isSetupAction(preOrPostFailure.uses)
      ? out("no_evidence", "setup_action_failed")
      : out("no_evidence", "act_inconsistent");
  }
  const step = byIndex.get(failing.index)!;
  if (step.kind === "uses_remote" && isSetupAction(step.uses)) {
    return out("no_evidence", "setup_action_failed");
  }
  return out("failure", null, failing.index);
}
