import type { PortResultV1 } from "./ports.ts";
import type {
  VpsHealthProof,
  VpsIdentity,
  VpsInferenceProof,
  VpsMetricsSample,
  VpsMutation,
  VpsOperation,
  VpsPrepare,
  VpsReceipt,
  VpsSelector,
  VpsSettlement,
} from "./vps-release-wire.ts";

/** Exact trusted target capability; carries neither repair writer nor model port. */
export interface VpsReleasePortV1 {
  inspectPrior(): Promise<PortResultV1<VpsSelector>>;
  prepare(input: VpsPrepare): Promise<PortResultV1<VpsReceipt>>;
  activate(input: VpsMutation): Promise<PortResultV1<VpsReceipt>>;
  observe(input: VpsOperation): Promise<PortResultV1<VpsReceipt>>;
  restore(input: VpsMutation): Promise<PortResultV1<VpsReceipt>>;
  settle(input: VpsSettlement): Promise<PortResultV1<VpsReceipt>>;
  sampleHealth(
    identity: VpsIdentity,
    surface: "loopback" | "public",
    port?: number,
  ): Promise<PortResultV1<VpsHealthProof>>;
  sampleMetrics(
    input: { identity: VpsIdentity; windowStart: number; windowEnd: number },
  ): Promise<PortResultV1<VpsMetricsSample>>;
  readInferenceProof(
    identity: VpsIdentity,
  ): Promise<PortResultV1<VpsInferenceProof | null>>;
}
