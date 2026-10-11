/** Public hosted entrypoint; implementation is split by responsibility. */
import {
  readMatrixNativeCarrier,
  runActionsMatrixAggregateCycles,
} from "./matrix-actions.ts";
import { runActionsRepairHost } from "./actions-repair-host.ts";
export {
  ACTIONS_UOS_BASE_URL,
  childRunDeadlineV1,
  parseAppInstallationId,
  runActionsTargetCycles,
  scopeTargetConfigV1,
  targetsDiagnosticV1,
} from "./actions-target-cycles.ts";
export type {
  ActionsRepairHostDepsV1,
  ActionsRepairHostResultV1,
  ActionsTargetCyclesInputV1,
  ActionsTargetCyclesResultV1,
} from "./actions-target-cycles.ts";
export { runActionsRepairHost } from "./actions-repair-host.ts";

if (import.meta.main) {
  const carrier = await readMatrixNativeCarrier(false, true);
  await runActionsRepairHost({
    runTargetCycles: (input) =>
      runActionsMatrixAggregateCycles(input, undefined, carrier),
  });
}
