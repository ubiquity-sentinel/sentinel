/**
 * Advisory timing lines for the hosted planner and the serial repair child,
 * so an idle cycle's time can be attributed from the job log. The launcher
 * re-emits both kinds through `scanStepLines`:
 *
 * - `sentinel_host_phase`: one job-level phase from a fixed set and its
 *   monotonic wall time;
 * - `sentinel_target_timing`: one committed target's monotonic wall time per
 *   phase of the shared multi-target flow, and its advance count.
 *
 * They carry only a closed phase name, a committed repository slug (already
 * public in the job log), integer milliseconds and an integer count: no record
 * id, issue text, URL or credential, and never `status` (the launcher's
 * child-status scan reads any line with its own `status` as a child record).
 * Nothing reads them back as evidence. The parsers accept only the exact key
 * set and bounded values and rebuild the line, so nothing else a child prints
 * is echoed.
 */
export const HOST_PHASE_KIND = "sentinel_host_phase";
export const TARGET_TIMING_KIND = "sentinel_target_timing";

/** The job-level phases a host phase line may name. */
export const HOST_PHASES = [
  /** Child start until the first target work (identity, state, setup). */
  "setup",
  /** The planner's per-target source intake. */
  "intake",
  /** The planner's manifest. */
  "plan",
  /** The planner's repository fan-out plan. */
  "fanout",
  /** The serial job's authenticated artifact scans and ingestion. */
  "scan",
  /** The serial job's target advances. */
  "cycles",
  /** The serial job's wait for its repository cells' hand-backs. */
  "handback",
  /** Drains, continuations and progress comments after the advances. */
  "finish",
] as const;

export type HostPhaseV1 = typeof HOST_PHASES[number];

/** Upper bound of every millisecond value (one day). */
export const MAX_TIMING_MS = 24 * 60 * 60_000;
/** Upper bound of the advance count one target line may report. */
export const MAX_TIMING_ADVANCES = 100_000;

export interface HostPhaseLineV1 {
  kind: typeof HOST_PHASE_KIND;
  phase: HostPhaseV1;
  elapsedMs: number;
}

/** One target's per-phase times in the shared multi-target flow. */
export interface TargetTimingCountsV1 {
  /** Its own mirror preparation (`prepareTarget`). */
  prepareMs: number;
  /** Its bounded pre-merge CI dispatch. */
  premergeMs: number;
  /** Its progress-comment state snapshots and comments. */
  progressMs: number;
  /** Its cycle advances (the authoritative operations). */
  cycleMs: number;
  advances: number;
  /** Its drain and post-drain finish. */
  finishMs: number;
}

export interface TargetTimingLineV1 extends TargetTimingCountsV1 {
  kind: typeof TARGET_TIMING_KIND;
  repository: string;
}

const HOST_PHASE_KEYS = ["elapsedMs", "kind", "phase"].join();
const TARGET_KEYS = [
  "advances",
  "cycleMs",
  "finishMs",
  "kind",
  "premergeMs",
  "prepareMs",
  "progressMs",
  "repository",
].join();
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

function keysOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.keys(value).sort().join();
}

function bounded(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= max;
}

/** The strictly re-parsed host phase line, or null. */
export function parseHostPhaseLine(value: unknown): HostPhaseLineV1 | null {
  if (keysOf(value) !== HOST_PHASE_KEYS) return null;
  const line = value as Record<string, unknown>;
  if (
    line.kind !== HOST_PHASE_KIND ||
    !(HOST_PHASES as readonly unknown[]).includes(line.phase) ||
    !bounded(line.elapsedMs, MAX_TIMING_MS)
  ) return null;
  return {
    kind: HOST_PHASE_KIND,
    phase: line.phase as HostPhaseV1,
    elapsedMs: line.elapsedMs,
  };
}

/** The strictly re-parsed target timing line, or null. */
export function parseTargetTimingLine(
  value: unknown,
): TargetTimingLineV1 | null {
  if (keysOf(value) !== TARGET_KEYS) return null;
  const line = value as Record<string, unknown>;
  if (
    line.kind !== TARGET_TIMING_KIND ||
    typeof line.repository !== "string" || !REPOSITORY.test(line.repository) ||
    !bounded(line.prepareMs, MAX_TIMING_MS) ||
    !bounded(line.premergeMs, MAX_TIMING_MS) ||
    !bounded(line.progressMs, MAX_TIMING_MS) ||
    !bounded(line.cycleMs, MAX_TIMING_MS) ||
    !bounded(line.advances, MAX_TIMING_ADVANCES) ||
    !bounded(line.finishMs, MAX_TIMING_MS)
  ) return null;
  return {
    kind: TARGET_TIMING_KIND,
    repository: line.repository,
    prepareMs: line.prepareMs,
    premergeMs: line.premergeMs,
    progressMs: line.progressMs,
    cycleMs: line.cycleMs,
    advances: line.advances,
    finishMs: line.finishMs,
  };
}

/** Whole non-negative milliseconds, clamped into the parsed bound. */
export function timingMs(ms: number): number {
  return Number.isFinite(ms)
    ? Math.max(0, Math.min(Math.round(ms), MAX_TIMING_MS))
    : 0;
}

/**
 * Print one host phase line; never throws, so a failed print can never
 * change the run.
 */
export function logHostPhase(
  phase: HostPhaseV1,
  elapsedMs: number,
  log: (line: string) => void = (line) => console.log(line),
): void {
  try {
    const line = parseHostPhaseLine({
      kind: HOST_PHASE_KIND,
      phase,
      elapsedMs: timingMs(elapsedMs),
    });
    if (line !== null) log(JSON.stringify(line));
  } catch {
    // Advisory only.
  }
}

/** Print one target timing line; never throws. */
export function logTargetTiming(
  repository: string,
  counts: TargetTimingCountsV1,
  log: (line: string) => void = (line) => console.log(line),
): void {
  try {
    const line = parseTargetTimingLine({
      kind: TARGET_TIMING_KIND,
      repository,
      prepareMs: timingMs(counts.prepareMs),
      premergeMs: timingMs(counts.premergeMs),
      progressMs: timingMs(counts.progressMs),
      cycleMs: timingMs(counts.cycleMs),
      advances: Math.min(counts.advances, MAX_TIMING_ADVANCES),
      finishMs: timingMs(counts.finishMs),
    });
    if (line !== null) log(JSON.stringify(line));
  } catch {
    // Advisory only.
  }
}
