/**
 * Bounded per-step observability line (2026-10-25 redesign, C5.2).
 *
 * `runRepairCycle` prints one `sentinel_step` line per selected runtime step:
 * the record id, the step it was selected for (`nextStep`), the step result's
 * kind and the elapsed monotonic wall time (never the injected run clock).
 * The line is advisory only: it is printed after the step settled, a failure
 * to print is swallowed, it carries no `status` property (the launcher's
 * child-status scan never reads it) and nothing reads it back as evidence. A cycle prints at most
 * `MAX_STEP_LINES_PER_CYCLE` lines, so the child's bounded stdout capture is
 * never at risk; the launcher re-parses at most `MAX_REEMITTED_STEP_LINES`
 * lines with `parseStepLine` and re-emits them in the job log.
 */
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { StepResultV1 } from "./loop-types.ts";

export const STEP_LINE_KIND = "sentinel_step";

/** Lines one `runRepairCycle` call prints at most. */
export const MAX_STEP_LINES_PER_CYCLE = 1_000;

/** Lines the launcher re-emits at most from one child run. */
export const MAX_REEMITTED_STEP_LINES = 2_000;

/** The record's `nextStep` the step was selected for. */
export const STEP_LINE_STEPS: readonly string[] = [
  "work",
  "review",
  "delivery",
  "blocked",
  "done",
];

/** Every `StepResultV1` kind. */
export const STEP_LINE_OUTCOMES: readonly StepResultV1["kind"][] = [
  "progress",
  "idle",
  "margin",
  "state_error",
  "deferred",
];

export interface StepLineV1 {
  kind: typeof STEP_LINE_KIND;
  recordId: string;
  step: string;
  outcome: StepResultV1["kind"];
  elapsedMs: number;
}

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:#/+-]{0,199}$/;
const MAX_ELAPSED_MS = 24 * 60 * 60_000;
const KEYS = ["elapsedMs", "kind", "outcome", "recordId", "step"].join();

/** The strictly re-parsed line, or null for anything else. */
export function parseStepLine(value: unknown): StepLineV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const line = value as Record<string, unknown>;
  if (
    Object.keys(line).sort().join() !== KEYS ||
    line.kind !== STEP_LINE_KIND ||
    typeof line.recordId !== "string" || !RECORD_ID.test(line.recordId) ||
    typeof line.step !== "string" || !STEP_LINE_STEPS.includes(line.step) ||
    !STEP_LINE_OUTCOMES.includes(line.outcome as StepResultV1["kind"]) ||
    !Number.isSafeInteger(line.elapsedMs) ||
    (line.elapsedMs as number) < 0 ||
    (line.elapsedMs as number) > MAX_ELAPSED_MS
  ) return null;
  return {
    kind: STEP_LINE_KIND,
    recordId: line.recordId,
    step: line.step,
    outcome: line.outcome as StepResultV1["kind"],
    elapsedMs: line.elapsedMs as number,
  };
}

/**
 * One cycle's step logger. Each call prints one line for a settled step until
 * the cycle's bound is reached; it never throws.
 */
export function createStepLog(
  log: (line: string) => void = (line) => console.log(line),
  limit = MAX_STEP_LINES_PER_CYCLE,
): (
  record: Pick<WorkRecordV1, "id" | "nextStep">,
  outcome: StepResultV1["kind"],
  elapsedMs: number,
) => void {
  let printed = 0;
  return (record, outcome, elapsedMs) => {
    if (printed >= limit) return;
    try {
      const line = parseStepLine({
        kind: STEP_LINE_KIND,
        recordId: record.id,
        step: record.nextStep,
        outcome,
        elapsedMs: Math.max(0, Math.min(elapsedMs, MAX_ELAPSED_MS)),
      });
      if (line === null) return;
      printed += 1;
      log(JSON.stringify(line));
    } catch {
      // Advisory only: a failed print never changes the cycle.
    }
  };
}

/** Every valid step line of one child's stdout, in order, bounded. */
export function scanStepLines(stdout: string): StepLineV1[] {
  const lines: StepLineV1[] = [];
  for (const raw of stdout.split("\n")) {
    if (lines.length >= MAX_REEMITTED_STEP_LINES) break;
    if (raw.length > 512 || !raw.includes(STEP_LINE_KIND)) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      continue;
    }
    const line = parseStepLine(value);
    if (line !== null) lines.push(line);
  }
  return lines;
}
