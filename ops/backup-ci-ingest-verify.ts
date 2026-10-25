/**
 * The pure checks of the backup CI ingest (docs/backup-ci-spec.md §9.2):
 * what makes an UNTRUSTED leg's run, job, log marker, artifact and result
 * count for its stored unit. `backup-ci-ingest.ts` reads GitHub and applies
 * them in order; each refusal is one no-evidence reason.
 */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  BACKUP_CI_LEG_JOB,
  BACKUP_CI_LEG_STEPS,
  BACKUP_CI_LEG_WORKFLOW_PATH,
  BACKUP_CI_MAX_RESULT_BYTES,
  backupCiBytesDigest,
  type BackupCiNoEvidenceReasonV1,
  type BackupCiResultV1,
  type BackupCiUnitV1,
  parseBackupCiResult,
} from "../src/contracts/backup-ci.ts";
import { isSetupAction } from "./backup-ci-act.ts";
import { BACKUP_CI_SENTINEL_REPOSITORY } from "./backup-ci-ingest-reads.ts";
import { backupCiExcerpt } from "./backup-ci-log-sanitize.ts";
export const BACKUP_CI_WINDOW_TOLERANCE_MS = 2_000;
const LEG_ACTOR = "github-actions[bot]";
const MARKER_KEYS = "artifactId,kind,resultDigest,unitDigest,unitId";

type Obj = Record<string, unknown>;
type Reason = BackupCiNoEvidenceReasonV1;
const row = (v: unknown): Obj | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Obj : null;
const posInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;

/** Epoch ms of a GitHub timestamp (any fraction), or null. */
export function backupCiTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/
      .exec(value);
  if (match === null) return null;
  const fraction = (match[2] ?? "").padEnd(3, "0").slice(0, 3);
  const parsed = Date.parse(`${match[1]}.${fraction}${match[3]}`);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface BackupCiWindowV1 {
  start: number;
  end: number;
}
const inside = (t: number, w: BackupCiWindowV1) =>
  t >= w.start - BACKUP_CI_WINDOW_TOLERANCE_MS &&
  t <= w.end + BACKUP_CI_WINDOW_TOLERANCE_MS;

/** Whether a listed or attempt-1 run is the unit's own leg run. */
export function legRunBinds(run: Obj, unit: BackupCiUnitV1): boolean {
  return run.path === BACKUP_CI_LEG_WORKFLOW_PATH &&
    run.event === "workflow_dispatch" &&
    run.head_branch === "sentinel-backup-legs" &&
    run.head_sha === unit.plan.launcherSha &&
    row(run.head_repository)?.full_name === BACKUP_CI_SENTINEL_REPOSITORY &&
    row(run.repository)?.full_name === BACKUP_CI_SENTINEL_REPOSITORY &&
    row(run.triggering_actor)?.login === LEG_ACTOR &&
    run.display_title === `sentinel-backup-ci-leg ${unit.unitId}`;
}

export type BackupCiLegJobV1 =
  | {
    ok: true;
    jobId: number;
    window: BackupCiWindowV1;
    steps: Record<(typeof BACKUP_CI_LEG_STEPS)[number], BackupCiWindowV1>;
  }
  | { ok: false; reason: Reason };

/** §9.2 step 2 over attempt 1's job listing. */
export function verifyLegJob(
  jobs: Obj[],
  unit: BackupCiUnitV1,
): BackupCiLegJobV1 {
  if (jobs.length !== 1 || jobs[0].name !== BACKUP_CI_LEG_JOB) {
    return { ok: false, reason: "binding_mismatch" };
  }
  const job = jobs[0];
  const jobId = posInt(job.id);
  if (
    jobId === null || job.run_attempt !== 1 ||
    job.head_sha !== unit.plan.launcherSha
  ) {
    return { ok: false, reason: "binding_mismatch" };
  }
  if (job.status !== "completed") return { ok: false, reason: "leg_failed" };
  if (job.conclusion === "cancelled") {
    return { ok: false, reason: "leg_cancelled" };
  }
  if (job.conclusion !== "success") return { ok: false, reason: "leg_failed" };
  const labels = job.labels;
  if (
    job.runner_group_name !== "GitHub Actions" || !Array.isArray(labels) ||
    labels.length !== 1 || labels[0] !== unit.job.runsOn
  ) return { ok: false, reason: "binding_mismatch" };
  const start = backupCiTime(job.started_at);
  const end = backupCiTime(job.completed_at);
  if (start === null || end === null || end < start) {
    return { ok: false, reason: "binding_mismatch" };
  }
  const window = { start, end };
  const listed = Array.isArray(job.steps) ? job.steps.map(row) : [];
  const steps: Partial<Record<string, BackupCiWindowV1>> = {};
  let at = 0;
  let previous = start;
  for (const name of BACKUP_CI_LEG_STEPS) {
    const index = listed.findIndex((s, i) => i >= at && s?.name === name);
    if (index < 0) return { ok: false, reason: "binding_mismatch" };
    const step = listed[index]!;
    const s = backupCiTime(step.started_at);
    const e = backupCiTime(step.completed_at);
    if (
      step.status !== "completed" || step.conclusion !== "success" ||
      s === null || e === null || e < s ||
      s < previous - BACKUP_CI_WINDOW_TOLERANCE_MS ||
      !inside(s, window) || !inside(e, window)
    ) return { ok: false, reason: "binding_mismatch" };
    steps[name] = { start: s, end: e };
    previous = e;
    at = index + 1;
  }
  return {
    ok: true,
    jobId,
    window,
    steps: steps as Record<
      (typeof BACKUP_CI_LEG_STEPS)[number],
      BackupCiWindowV1
    >,
  };
}

/** A job log's timestamped lines. */
export function backupCiLogLines(text: string): { at: number; text: string }[] {
  const lines: { at: number; text: string }[] = [];
  for (const raw of text.replace(/^﻿/, "").split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const at = backupCiTime(line.slice(0, space));
    if (at !== null) lines.push({ at, text: line.slice(space + 1) });
  }
  return lines;
}

export interface BackupCiMarkerV1 {
  unitId: string;
  unitDigest: string;
  resultDigest: string;
  artifactId: number;
}

/** §9.2 step 3: exactly one marker, in the report window, for this unit. */
export function findBackupCiMarker(
  lines: { at: number; text: string }[],
  unit: BackupCiUnitV1,
  unitDigest: string,
  report: BackupCiWindowV1,
): BackupCiMarkerV1 | Reason {
  const candidates = lines.filter((l) =>
    l.text.startsWith('{"kind":"sentinel_backup_ci_leg_result"')
  );
  if (candidates.length !== 1) return "marker_missing";
  const [line] = candidates;
  if (!inside(line.at, report)) return "marker_missing";
  let marker: Obj | null;
  try {
    marker = row(JSON.parse(line.text));
  } catch {
    return "marker_missing";
  }
  if (
    marker === null || Object.keys(marker).sort().join(",") !== MARKER_KEYS ||
    typeof marker.unitId !== "string" ||
    typeof marker.unitDigest !== "string" ||
    typeof marker.resultDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(marker.resultDigest) ||
    posInt(marker.artifactId) === null
  ) return "marker_missing";
  if (marker.unitId !== unit.unitId || marker.unitDigest !== unitDigest) {
    return "digest_mismatch";
  }
  return {
    unitId: marker.unitId,
    unitDigest: marker.unitDigest,
    resultDigest: marker.resultDigest,
    artifactId: marker.artifactId as number,
  };
}

/** §9.2 step 4: the artifact's metadata binds the leg run. */
export function artifactBinds(
  meta: Obj,
  marker: BackupCiMarkerV1,
  legRunId: number,
  unit: BackupCiUnitV1,
  sentinelId: number,
): boolean {
  const run = row(meta.workflow_run);
  const size = meta.size_in_bytes;
  return meta.id === marker.artifactId && run !== null && run.id === legRunId &&
    run.head_sha === unit.plan.launcherSha &&
    run.repository_id === sentinelId &&
    meta.name === `backup-result-${unit.unitId}` && meta.expired === false &&
    typeof size === "number" && Number.isSafeInteger(size) && size > 0 &&
    size <= BACKUP_CI_MAX_RESULT_BYTES;
}

/** §10.4 agreement of a leg's outcome with its own step record. */
export function backupCiResultConsistent(
  unit: BackupCiUnitV1,
  result: BackupCiResultV1,
): boolean {
  if (
    canonicalStringify(result.steps.map((s) => s.index)) !==
      canonicalStringify(unit.steps.map((s) => s.index))
  ) return false;
  const byIndex = new Map(unit.steps.map((s) => [s.index, s]));
  if (result.outcome === "success") {
    return result.act.exitCode === 0 && result.act.jobResults === 1 &&
      result.steps.every(({ index, result: r }) => {
        const step = byIndex.get(index)!;
        return r === "success" ||
          (r === "skipped" && step.condition === "status_only") ||
          (r === "failure" && step.continueOnError);
      });
  }
  if (result.outcome === "failure") {
    const step = result.failingStep === null
      ? undefined
      : byIndex.get(result.failingStep);
    const recorded = result.steps.find((s) => s.index === result.failingStep);
    return step !== undefined && recorded?.result === "failure" &&
      !step.continueOnError && result.act.exitCode !== 0 &&
      result.act.jobResults === 1 &&
      !(step.kind === "uses_remote" && isSetupAction(step.uses)) &&
      result.steps.every((s) =>
        s.index >= step.index || s.result !== "failure" ||
        byIndex.get(s.index)!.continueOnError
      );
  }
  if (result.outcome === "timed_out") {
    return unit.job.targetTimeoutMinutes === unit.job.capMinutes;
  }
  return result.reason !== null;
}

/** §9.2 step 5 over the downloaded `result.json` bytes. */
export function verifyBackupCiResult(
  bytes: Uint8Array,
  marker: BackupCiMarkerV1,
  unit: BackupCiUnitV1,
  run: BackupCiWindowV1,
): BackupCiResultV1 | Reason {
  if (backupCiBytesDigest(bytes) !== marker.resultDigest) {
    return "digest_mismatch";
  }
  let result: BackupCiResultV1;
  try {
    result = parseBackupCiResult(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    );
  } catch {
    return "result_invalid";
  }
  if (
    result.unitId !== unit.unitId || result.unitDigest !== marker.unitDigest
  ) {
    return "digest_mismatch";
  }
  const o = result.observed;
  if (
    o.head !== unit.exec.commit || o.tree !== unit.exec.tree ||
    canonicalStringify(o.parents) !== canonicalStringify(unit.exec.parents) ||
    o.workflowBlob !== unit.workflow.blob ||
    result.runner.runnerId !== unit.plan.runnerId
  ) return "binding_mismatch";
  if (!inside(result.startedAt, run) || !inside(result.completedAt, run)) {
    return "result_invalid";
  }
  if (!backupCiResultConsistent(unit, result)) return "act_inconsistent";
  return result;
}

/** The failing step's sanitized lines from the Run window (§9.2 step 6). */
export function backupCiFailureExcerpt(
  lines: { at: number; text: string }[],
  stepIndex: number,
  run: BackupCiWindowV1,
): string {
  const prefix = `│ [${stepIndex}] `;
  return backupCiExcerpt(
    lines.filter((l) => inside(l.at, run) && l.text.startsWith(prefix))
      .map((l) => l.text.slice(prefix.length)),
  );
}
