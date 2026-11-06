/**
 * Native `repair_cell` executable (issue #328): one repository's fan-out
 * repair pass under the matrix cell's credential-free boundary. The fixed
 * workflow pipes the native carrier `{planDigest, repairPlanDigest, cellId}`
 * on standard input; the launcher validated it before this child started.
 */
import { runActionsRepairHost } from "./actions-repair-host.ts";
import {
  type ActionsRepairHostDepsV1,
  type ActionsRepairHostResultV1,
  STATIC_PREFLIGHT,
} from "./actions-target-cycles.ts";
import {
  type MatrixNativeCarrierV1,
  parseCarrier,
  readMatrixNativeCarrier,
} from "./matrix-actions-shared.ts";
import { runRepairCellTargetCycles } from "./repair-fanout-host.ts";

/**
 * The cell settled (its delta or refusal record and its one marker are
 * written) while the model-startup probe was unavailable. The probe gates
 * model starts; a repository cell never starts one, so this is a healthy
 * cell, not the hosted startup failure it is for every other job.
 */
export const REPAIR_CELL_SETTLED_WITHOUT_STARTUP =
  "repair cell settled without model startup";

export async function runRepairCellHost(
  deps: ActionsRepairHostDepsV1 & { carrier?: MatrixNativeCarrierV1 } = {},
): Promise<
  ActionsRepairHostResultV1 | typeof REPAIR_CELL_SETTLED_WITHOUT_STARTUP
> {
  const job = deps.env === undefined
    ? Deno.env.get("GITHUB_JOB")
    : deps.env.GITHUB_JOB;
  if (job !== "repair_cell") {
    throw new Error("repair cell executable requires its native job identity");
  }
  const carrier = parseCarrier(
    deps.carrier ?? await readMatrixNativeCarrier(true),
    true,
  );
  if (carrier.repairPlanDigest === undefined) {
    throw new Error("repair cell lacks its fan-out plan digest");
  }
  const { carrier: _carrier, ...host } = deps;
  let settled = false;
  try {
    return await runActionsRepairHost({
      ...host,
      job: "repair_cell",
      issueOnly: deps.issueOnly ?? true,
      runTargetCycles: async (input) => {
        const result = await runRepairCellTargetCycles(input, carrier);
        settled = true;
        return result;
      },
    });
  } catch (error) {
    // Only the post-pass startup verdict is absorbed, and only after this
    // cell wrote its result; every other failure (identity, custody, state,
    // a crash before the result) still fails the cell.
    if (
      settled && error instanceof Error && error.message === STATIC_PREFLIGHT
    ) return REPAIR_CELL_SETTLED_WITHOUT_STARTUP;
    throw error;
  }
}

if (import.meta.main) {
  await runRepairCellHost();
}
