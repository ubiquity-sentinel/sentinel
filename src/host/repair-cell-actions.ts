/**
 * Native `repair_cell` executable (issue #328): one repository's fan-out
 * repair pass under the matrix cell's credential-free boundary. The fixed
 * workflow pipes the native carrier `{planDigest, repairPlanDigest, cellId}`
 * on standard input; the launcher validated it before this child started.
 */
import { runActionsRepairHost } from "./actions-repair-host.ts";
import type {
  ActionsRepairHostDepsV1,
  ActionsRepairHostResultV1,
} from "./actions-target-cycles.ts";
import {
  type MatrixNativeCarrierV1,
  parseCarrier,
  readMatrixNativeCarrier,
} from "./matrix-actions-shared.ts";
import { runRepairCellTargetCycles } from "./repair-fanout-host.ts";

export async function runRepairCellHost(
  deps: ActionsRepairHostDepsV1 & { carrier?: MatrixNativeCarrierV1 } = {},
): Promise<ActionsRepairHostResultV1> {
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
  return await runActionsRepairHost({
    ...host,
    job: "repair_cell",
    issueOnly: deps.issueOnly ?? true,
    runTargetCycles: (input) => runRepairCellTargetCycles(input, carrier),
  });
}

if (import.meta.main) {
  await runRepairCellHost();
}
