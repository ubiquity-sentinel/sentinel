/**
 * One advisory `sentinel_repair_pass` summary line per serial repair pass
 * (issue #326; consumed by the throughput metrics of #338).
 *
 * It counts the live records whose inputs the pass read (`recordsRead`), the
 * distinct records it stepped (`recordsStepped`) and the distinct records it
 * did not step (`recordsSkipped`), with the reason of each skip: unchanged
 * live inputs since the record's last settled step, or an explicit wait that
 * has not elapsed. `batchReads`/`batchUnavailable` count the repositories
 * whose one batched read answered or was unavailable (the pass then used the
 * per-record reads). Like the step line it carries no `status` property, a
 * failure to print is swallowed and nothing reads it back as evidence; it
 * carries only counts (no URL, body or credential).
 */

export const PASS_SUMMARY_LINE_KIND = "sentinel_repair_pass";

/** Upper bound of every count one summary may report. */
export const MAX_PASS_SUMMARY_COUNT = 100_000;

export interface PassSkipReasonsV1 {
  unchanged_inputs: number;
  waiting: number;
}

export interface PassSummaryCountsV1 {
  recordsRead: number;
  recordsStepped: number;
  recordsSkipped: number;
  skipReasons: PassSkipReasonsV1;
  batchReads: number;
  batchUnavailable: number;
}

export interface PassSummaryLineV1 extends PassSummaryCountsV1 {
  kind: typeof PASS_SUMMARY_LINE_KIND;
}

const KEYS = [
  "batchReads",
  "batchUnavailable",
  "kind",
  "recordsRead",
  "recordsSkipped",
  "recordsStepped",
  "skipReasons",
].join();
const REASON_KEYS = ["unchanged_inputs", "waiting"].join();

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= MAX_PASS_SUMMARY_COUNT;
}

/** The strictly re-parsed pass summary, or null for anything else. */
export function parsePassSummaryLine(value: unknown): PassSummaryLineV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const line = value as Record<string, unknown>;
  const reasons = line.skipReasons as Record<string, unknown> | null;
  if (
    Object.keys(line).sort().join() !== KEYS ||
    line.kind !== PASS_SUMMARY_LINE_KIND ||
    typeof reasons !== "object" || reasons === null ||
    Array.isArray(reasons) ||
    Object.keys(reasons).sort().join() !== REASON_KEYS ||
    !count(reasons.unchanged_inputs) || !count(reasons.waiting) ||
    !count(line.recordsRead) || !count(line.recordsStepped) ||
    !count(line.recordsSkipped) || !count(line.batchReads) ||
    !count(line.batchUnavailable) ||
    line.recordsSkipped !== reasons.unchanged_inputs + reasons.waiting
  ) return null;
  return {
    kind: PASS_SUMMARY_LINE_KIND,
    recordsRead: line.recordsRead as number,
    recordsStepped: line.recordsStepped as number,
    recordsSkipped: line.recordsSkipped as number,
    skipReasons: {
      unchanged_inputs: reasons.unchanged_inputs,
      waiting: reasons.waiting,
    },
    batchReads: line.batchReads as number,
    batchUnavailable: line.batchUnavailable as number,
  };
}

/** The summary line for `counts`, or null when it would not re-parse. */
export function passSummaryLine(counts: PassSummaryCountsV1): string | null {
  const line = parsePassSummaryLine({
    kind: PASS_SUMMARY_LINE_KIND,
    ...counts,
  });
  return line === null ? null : JSON.stringify(line);
}
