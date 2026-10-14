/** Private trusted telemetry interfaces; the VPS sample wire ABI stays unchanged. */
import type { VpsIdentity } from "../contracts/vps-release-wire.ts";
import type { RetentionPolicyV1 } from "../contracts/repository-policy.ts";
export type VpsJournalRequest = {
  identity: VpsIdentity;
  windowStart: number;
  windowEnd: number;
};
export type VpsQueryLimits = {
  deadline: number;
  maxBytes: number;
  maxEntries: number;
};
export type VpsMetricsProgress = {
  state: "collecting" | "complete" | "unavailable";
  reason: string | null;
};
export type VpsMetricsWork = {
  beginTick(observedAt: number): void;
  progress(input: VpsJournalRequest): Promise<VpsMetricsProgress>;
};
export type VpsMetricsScope = {
  operationId: string;
  requestDigest: string;
  controllerSha: string;
  driverSha256: string;
  candidate: VpsIdentity;
  prior: VpsIdentity;
  monitoringStartedAt: number;
  baselineStart: number;
  baselineEnd: number;
  stateHead: string;
  stateSequence: number;
};
export type VpsJoinStorage = {
  load(scope: VpsMetricsScope): Promise<Uint8Array | null>;
  save(
    scope: VpsMetricsScope,
    expectedSequence: number | null,
    ciphertext: Uint8Array,
  ): Promise<boolean>;
};
export type VpsJoinCipher = {
  seal(plaintext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>;
  open(ciphertext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>;
};
export type VpsBoundedJournalCommand = (
  args: readonly string[],
  limits: VpsQueryLimits,
  cwd: string,
) => Promise<string>;
export type VpsMetricsOptions = {
  retention: RetentionPolicyV1;
  context(
    input: VpsJournalRequest,
    saved?: { stateHead: string; stateSequence: number },
  ): Promise<VpsMetricsScope>;
  storage: VpsJoinStorage;
  cipher: VpsJoinCipher;
  deadline: number;
};
