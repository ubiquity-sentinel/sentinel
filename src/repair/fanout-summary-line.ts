/**
 * One advisory `sentinel_repair_fanout` summary line per delta application
 * (issue #328; for the throughput metrics collector of #338).
 *
 * It carries the wall time of each repository pass whose delta was opened
 * (descending, at most `MAX_FANOUT_REPOSITORIES` entries, no repository name),
 * the trusted writer's apply time and the applied/rejected counts by reason,
 * the records the plan delegated and the live records it left with the
 * serial pass, and the cells' steps counted by step kind (kept, handed back,
 * elapsed; `fanout-step-kinds.ts`). The fan-out's own acceptance compares the
 * repair phase's wall time with `max(repositoryWallMs) + applyMs`. Like the
 * pass summary it has no `status` property, a failure to print is swallowed,
 * nothing reads it back as evidence, and it carries only counts and
 * durations.
 */
import type { RepairDeltaApplyResultV1 } from "./repair-delta-apply.ts";
import {
  type FanoutStepKindsV1,
  parseFanoutStepKindsV1,
} from "./fanout-step-kinds.ts";

export const FANOUT_SUMMARY_LINE_KIND = "sentinel_repair_fanout";
export const MAX_FANOUT_REPOSITORIES = 32;
/** A day in milliseconds bounds every reported duration. */
const MAX_DURATION_MS = 86_400_000;
const MAX_COUNT = 100_000;

export interface FanoutRejectionsV1 {
  missing: number;
  refused: number;
  unauthenticated: number;
  invalid: number;
  duplicate: number;
  base_moved: number;
  transition_refused: number;
}

export interface FanoutSummaryLineV1 {
  kind: typeof FANOUT_SUMMARY_LINE_KIND;
  deltasApplied: number;
  transitionsApplied: number;
  deltasRejected: FanoutRejectionsV1;
  repositoryWallMs: number[];
  applyMs: number;
  recordsHandedBack: number;
  recordsDelegated: number;
  /** Null when the application never read the repair state. */
  recordsSerialOwned: number | null;
  stepKinds: FanoutStepKindsV1;
}

const KEYS = [
  "applyMs",
  "deltasApplied",
  "deltasRejected",
  "kind",
  "recordsDelegated",
  "recordsHandedBack",
  "recordsSerialOwned",
  "repositoryWallMs",
  "stepKinds",
  "transitionsApplied",
].join();
const REASONS = [
  "base_moved",
  "duplicate",
  "invalid",
  "missing",
  "refused",
  "transition_refused",
  "unauthenticated",
] as const;

function bounded(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= max;
}

/** The strictly re-parsed fan-out summary, or null for anything else. */
export function parseFanoutSummaryLine(
  value: unknown,
): FanoutSummaryLineV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const line = value as Record<string, unknown>;
  const reasons = line.deltasRejected as Record<string, unknown> | null;
  const walls = line.repositoryWallMs;
  const stepKinds = parseFanoutStepKindsV1(line.stepKinds);
  if (
    stepKinds === null || !bounded(line.recordsDelegated, MAX_COUNT) ||
    (line.recordsSerialOwned !== null &&
      !bounded(line.recordsSerialOwned, MAX_COUNT)) ||
    Object.keys(line).sort().join() !== KEYS ||
    line.kind !== FANOUT_SUMMARY_LINE_KIND ||
    typeof reasons !== "object" || reasons === null ||
    Array.isArray(reasons) ||
    Object.keys(reasons).sort().join() !== REASONS.join() ||
    !REASONS.every((reason) => bounded(reasons[reason], MAX_COUNT)) ||
    !bounded(line.deltasApplied, MAX_COUNT) ||
    !bounded(line.transitionsApplied, MAX_COUNT) ||
    !bounded(line.applyMs, MAX_DURATION_MS) ||
    !bounded(line.recordsHandedBack, MAX_COUNT) ||
    !Array.isArray(walls) || walls.length > MAX_FANOUT_REPOSITORIES ||
    !walls.every((wall) => bounded(wall, MAX_DURATION_MS)) ||
    walls.some((wall, index) => index > 0 && walls[index - 1] < wall)
  ) return null;
  return {
    kind: FANOUT_SUMMARY_LINE_KIND,
    deltasApplied: line.deltasApplied as number,
    transitionsApplied: line.transitionsApplied as number,
    deltasRejected: Object.fromEntries(
      REASONS.map((reason) => [reason, reasons[reason] as number]),
    ) as unknown as FanoutRejectionsV1,
    repositoryWallMs: [...walls] as number[],
    applyMs: line.applyMs as number,
    recordsHandedBack: line.recordsHandedBack as number,
    recordsDelegated: line.recordsDelegated as number,
    recordsSerialOwned: line.recordsSerialOwned as number | null,
    stepKinds,
  };
}

/** The summary of one application, or null when it would not re-parse. */
export function fanoutSummaryLine(
  result: RepairDeltaApplyResultV1,
): string | null {
  const rejected: FanoutRejectionsV1 = {
    missing: 0,
    refused: 0,
    unauthenticated: 0,
    invalid: 0,
    duplicate: 0,
    base_moved: 0,
    transition_refused: 0,
  };
  for (const entry of result.rejected) rejected[entry.reason]++;
  const line = parseFanoutSummaryLine({
    kind: FANOUT_SUMMARY_LINE_KIND,
    deltasApplied: result.applied.length,
    transitionsApplied: result.applied.reduce(
      (total, entry) => total + entry.transitions,
      0,
    ),
    deltasRejected: rejected,
    repositoryWallMs: result.repositoryWallMs.slice(0, MAX_FANOUT_REPOSITORIES),
    applyMs: result.applyMs,
    recordsHandedBack: result.handedBack,
    recordsDelegated: result.recordsDelegated,
    recordsSerialOwned: result.recordsSerialOwned,
    stepKinds: result.stepKinds,
  });
  return line === null ? null : JSON.stringify(line);
}

/** Print the summary of one application; advisory only, never throws. */
export function logFanoutSummary(result: RepairDeltaApplyResultV1): void {
  try {
    const line = fanoutSummaryLine(result);
    if (line !== null) console.log(line);
  } catch { /* advisory only */ }
}
