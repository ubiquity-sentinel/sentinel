/**
 * Bounded counts by step kind over the repository cells of one fan-out
 * (#328 widening, owner decision 2026-11-05), for the `sentinel_repair_fanout`
 * line: per kind (`<nextStep>:<wait reason or none>`, a closed set of 50) the
 * steps the cells took, how many they kept as delta transitions, how many
 * they handed back to the trusted serial path, and their summed elapsed time.
 * Advisory measurement only; nothing reads it back as evidence.
 */
import {
  REPAIR_STEP_KINDS,
  type RepairDeltaStepV1,
} from "../contracts/repair-delta-steps.ts";

export interface FanoutStepKindCountsV1 {
  steps: number;
  kept: number;
  deferred: number;
  elapsedMs: number;
}

/** Keyed by step kind, sorted; only kinds that occurred. */
export type FanoutStepKindsV1 = Record<string, FanoutStepKindCountsV1>;

/** Every count and duration is capped here (a week of milliseconds). */
export const MAX_FANOUT_STEP_COUNT = 604_800_000;
const COUNT_KEYS = ["deferred", "elapsedMs", "kept", "steps"].join();

const capped = (value: number) => Math.min(MAX_FANOUT_STEP_COUNT, value);

/** The per-kind counts of every listed step, keys sorted. */
export function fanoutStepKindsV1(
  steps: readonly RepairDeltaStepV1[],
): FanoutStepKindsV1 {
  const counts = new Map<string, FanoutStepKindCountsV1>();
  for (const step of steps) {
    if (!REPAIR_STEP_KINDS.includes(step.kind)) continue;
    const entry = counts.get(step.kind) ??
      { steps: 0, kept: 0, deferred: 0, elapsedMs: 0 };
    entry.steps = capped(entry.steps + 1);
    if (step.disposition === "kept") entry.kept = capped(entry.kept + 1);
    else entry.deferred = capped(entry.deferred + 1);
    entry.elapsedMs = capped(entry.elapsedMs + step.elapsedMs);
    counts.set(step.kind, entry);
  }
  return Object.fromEntries(
    [...counts].sort(([left], [right]) => left < right ? -1 : 1),
  );
}

function bounded(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= MAX_FANOUT_STEP_COUNT;
}

/** The strictly re-parsed per-kind counts, or null for anything else. */
export function parseFanoutStepKindsV1(
  value: unknown,
): FanoutStepKindsV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const out: FanoutStepKindsV1 = {};
  const keys = Object.keys(value);
  if (keys.some((key, index) => index > 0 && keys[index - 1] >= key)) {
    return null;
  }
  for (const key of keys) {
    const entry = (value as Record<string, unknown>)[key];
    if (
      !REPAIR_STEP_KINDS.includes(key) || typeof entry !== "object" ||
      entry === null || Array.isArray(entry) ||
      Object.keys(entry).sort().join() !== COUNT_KEYS
    ) return null;
    const { steps, kept, deferred, elapsedMs } = entry as Record<
      string,
      unknown
    >;
    if (
      !bounded(steps) || !bounded(kept) || !bounded(deferred) ||
      !bounded(elapsedMs) || steps === 0 ||
      (steps < MAX_FANOUT_STEP_COUNT && kept + deferred !== steps)
    ) return null;
    out[key] = { steps, kept, deferred, elapsedMs };
  }
  return out;
}
