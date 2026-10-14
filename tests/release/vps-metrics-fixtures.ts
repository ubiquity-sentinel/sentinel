import type { VpsMetricsWork } from "../../src/release/vps-metrics.ts";
/** External fake telemetry for tests whose subject is state/settlement rather than collection. */
export const completeMetricsWork = (): VpsMetricsWork => ({
  beginTick: () => {},
  progress: () => Promise.resolve({ state: "complete", reason: null }),
});
