/** Public native Actions matrix executable and serial aggregate facade. */
import { runActionsMatrixHost } from "./matrix-native-host.ts";

export { HISTORICAL_MATRIX_QUARANTINE } from "./matrix-artifact-port.ts";
export {
  HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE,
  HISTORICAL_NOT_STARTED_DETAIL,
  type HistoricalMatrixQuarantineDepsV1,
  historicalNotStartedProven,
} from "./matrix-quarantine-state.ts";
export { runHistoricalMatrixQuarantine } from "./matrix-quarantine.ts";
export {
  type ActionsMatrixHostDepsV1,
  type MatrixNativeCarrierV1,
  matrixPlanCarrierOf,
  readMatrixNativeCarrier,
} from "./matrix-actions-shared.ts";
export {
  type MatrixAggregateOptionsV1,
  runActionsMatrixAggregateCycles,
} from "./matrix-aggregate.ts";
export { runActionsMatrixHost } from "./matrix-native-host.ts";

if (import.meta.main) {
  await runActionsMatrixHost();
}
