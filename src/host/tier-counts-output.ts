/**
 * The maintenance repair-tier step's counts (#324, #338), carried to
 * finalize the same way the delivery counts are (#330): the tier step pushes
 * one closed `tier-summary:` action, the maintenance step writes one
 * `tierCounts=<read>,<demoted>,<promoted>,<movedCold>,<superseded>` output
 * (or `none`), the workflow hands it to finalize as `SENTINEL_TIER_COUNTS`
 * and finalize adds the counts to the cycle's metrics record.
 *
 * `movedCold` and `superseded` are `-` when the step did not observe the
 * release path (they stay null, never zero). The whole value is `none` when
 * the step read nothing. Advisory: anything malformed is unobserved.
 */

export const TIER_COUNTS_ENV = "SENTINEL_TIER_COUNTS";

export interface TierCountsV1 {
  readonly recordsRead: number;
  readonly demoted: number;
  readonly promoted: number;
  readonly releaseRequestsMovedToCold: number | null;
  readonly releaseRequestsSuperseded: number | null;
}

const N = "(\\d{1,7})";
const O = "(\\d{1,7}|-)";
const SUMMARY = new RegExp(
  `^tier-summary:read=${N}:demoted=${N}:promoted=${N}:moved_cold=${O}:superseded=${O}$`,
);
const OUTPUT = new RegExp(`^${N},${N},${N},${O},${O}$`);

const optional = (value: string) => value === "-" ? null : Number(value);
const text = (value: number | null) => value === null ? "-" : String(value);

function counts(match: RegExpExecArray | null): TierCountsV1 | null {
  if (match === null) return null;
  const [read, demoted, promoted, cold, superseded] = match.slice(1);
  return {
    recordsRead: Number(read),
    demoted: Number(demoted),
    promoted: Number(promoted),
    releaseRequestsMovedToCold: optional(cold),
    releaseRequestsSuperseded: optional(superseded),
  };
}

/** The tier step's action line, or null when it read nothing. */
export function tierSummaryAction(outcome: {
  recordsRead: number | null;
  demoted: number;
  promoted: number;
  releaseRequestsMovedToCold: number | null;
  releaseRequestsSuperseded: number | null;
}): string | null {
  if (outcome.recordsRead === null) return null;
  return `tier-summary:read=${outcome.recordsRead}:demoted=${outcome.demoted}` +
    `:promoted=${outcome.promoted}` +
    `:moved_cold=${text(outcome.releaseRequestsMovedToCold)}` +
    `:superseded=${text(outcome.releaseRequestsSuperseded)}`;
}

/** The tier step's one summary line among a maintenance result's actions. */
export function tierCountsFromActions(
  actions: readonly string[],
): TierCountsV1 | null {
  const lines = actions.filter((line) => line.startsWith("tier-summary:"));
  return lines.length === 1 ? counts(SUMMARY.exec(lines[0])) : null;
}

/** The step output value. */
export function formatTierCounts(value: TierCountsV1 | null): string {
  return value === null
    ? "none"
    : `${value.recordsRead},${value.demoted},${value.promoted},${
      text(value.releaseRequestsMovedToCold)
    },${text(value.releaseRequestsSuperseded)}`;
}

/** Finalize's strict read of the environment value (null: unobserved). */
export function parseTierCounts(
  value: string | undefined | null,
): TierCountsV1 | null {
  return typeof value === "string" ? counts(OUTPUT.exec(value)) : null;
}

/** Native step output (the maintenance job), appended to `GITHUB_OUTPUT`. */
export async function writeTierCountsOutput(
  path: string | null,
  value: TierCountsV1 | null,
): Promise<void> {
  if (path === null || path.length === 0) return;
  await Deno.writeTextFile(path, `tierCounts=${formatTierCounts(value)}\n`, {
    append: true,
  });
}
