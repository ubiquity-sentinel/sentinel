/**
 * The maintenance delivery pass's throughput counts (sentinel #330, #338),
 * carried to finalize the way the upkeep deferral is (#327): the maintenance
 * step writes one closed `deliveryCounts=<trains>,<ci runs>,<merges>` output
 * (or `none`), the workflow hands it to finalize as `SENTINEL_DELIVERY_COUNTS`
 * and finalize adds `trainsBuilt`, `targetCiRunsTriggered` and
 * `mergesCompleted` to the cycle's metrics record. Advisory: anything
 * malformed is unobserved (null), never zero and never a failure.
 */

export const DELIVERY_COUNTS_ENV = "SENTINEL_DELIVERY_COUNTS";

export interface DeliveryCountsV1 {
  readonly trainsBuilt: number;
  readonly targetCiRunsTriggered: number;
  readonly mergesCompleted: number;
}

const SUMMARY =
  /^delivery-summary:trains_built=(\d{1,6}):target_ci_runs=(\d{1,6}):merges=(\d{1,6})$/;
const OUTPUT = /^(\d{1,6}),(\d{1,6}),(\d{1,6})$/;

function counts(match: RegExpExecArray | null): DeliveryCountsV1 | null {
  if (match === null) return null;
  const [trainsBuilt, targetCiRunsTriggered, mergesCompleted] = match.slice(1)
    .map(Number);
  return { trainsBuilt, targetCiRunsTriggered, mergesCompleted };
}

/** The delivery pass's one summary line among a maintenance result's actions. */
export function deliveryCountsFromActions(
  actions: readonly string[],
): DeliveryCountsV1 | null {
  const lines = actions.filter((line) => line.startsWith("delivery-summary:"));
  return lines.length === 1 ? counts(SUMMARY.exec(lines[0])) : null;
}

/** The step output value. */
export function formatDeliveryCounts(value: DeliveryCountsV1 | null): string {
  return value === null
    ? "none"
    : `${value.trainsBuilt},${value.targetCiRunsTriggered},${value.mergesCompleted}`;
}

/** Finalize's strict read of the environment value (null: unobserved). */
export function parseDeliveryCounts(
  value: string | undefined | null,
): DeliveryCountsV1 | null {
  return typeof value === "string" ? counts(OUTPUT.exec(value)) : null;
}

/** Native step output (the maintenance job), appended to `GITHUB_OUTPUT`. */
export async function writeDeliveryCountsOutput(
  path: string | null,
  value: DeliveryCountsV1 | null,
): Promise<void> {
  if (path === null || path.length === 0) return;
  await Deno.writeTextFile(
    path,
    `deliveryCounts=${formatDeliveryCounts(value)}\n`,
    { append: true },
  );
}
