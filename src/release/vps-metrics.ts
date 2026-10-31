/**
 * Bridge-facing VpsJournalMetrics interfaces of the owner-pinned ai.ubq.fi
 * driver (`ops/vps-release-metrics.ts`). The pinned, hash-verified module
 * selects its interface; the VPS sample wire ABI is the same for both.
 */
import type {
  VpsIdentity,
  VpsMetricsSample,
} from "../contracts/vps-release-wire.ts";
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
export type VpsJournalCoverage = {
  complete: true;
  unit: "ai-ubq-fi.service";
  windowStart: number;
  windowEnd: number;
  bootId: string;
  firstCursor: string;
  lastCursor: string;
  digest: string;
};
/** Independent completeness readback; the joined interface also bounds it. */
export type VpsJournalCoverageReader = (
  start: number,
  end: number,
  limits?: VpsQueryLimits,
) => Promise<VpsJournalCoverage | null>;
/** Generic native command runner (driver's runVpsCommand). */
export type VpsCommand = (
  program: string,
  args: string[],
  cwd: string,
) => Promise<string>;
/** #1027 journal runner: fixed journalctl argv with a deadline and size bounds. */
export type VpsBoundedJournalCommand = (
  args: readonly string[],
  limits: VpsQueryLimits,
  cwd: string,
) => Promise<string>;
/** One committed monitoring operation; joins bind to it, never to caller time. */
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
export type VpsJoinCipher = {
  seal(plaintext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>;
  open(ciphertext: Uint8Array, associatedData: Uint8Array): Promise<Uint8Array>;
};
export type VpsJoinStorage = {
  load(scope: VpsMetricsScope): Promise<Uint8Array | null>;
  save(
    scope: VpsMetricsScope,
    expectedSequence: number | null,
    ciphertext: Uint8Array,
  ): Promise<boolean>;
};
export type VpsMetricsProgress = {
  state: "collecting" | "complete" | "unavailable";
  reason: string | null;
};
/** The joined interface's per-tick budget and collection progress. */
export type VpsMetricsWork = {
  beginTick(observedAt: number): void;
  progress(input: VpsJournalRequest): Promise<VpsMetricsProgress>;
};
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
type Sampler = {
  sample(input: VpsJournalRequest): Promise<VpsMetricsSample>;
};
type JournalReader<Limits extends unknown[]> = {
  read(start: number, end: number, ...limits: Limits): Promise<string>;
  coverage(
    start: number,
    end: number,
    ...limits: Limits
  ): Promise<VpsJournalCoverage | null>;
};

/** ai.ubq.fi through 21e4a2a9: one widened read per window, generic runner. */
export interface VpsWindowMetricsModule {
  createVpsJournalReader(
    run: VpsCommand,
    root: string,
    coverage: VpsJournalCoverageReader,
  ): JournalReader<[]>;
  VpsJournalMetrics: new (
    reader: JournalReader<[]>,
    now: () => number,
    lagMs: number,
    timeoutKinds: readonly string[],
    upstreamWideKinds: readonly string[],
  ) => Sampler;
}
/**
 * ubiquity/ai.ubq.fi#1027 (e50c298b): exact 30 s windows inside the monitoring
 * and baseline scope, bounded journal slices per begun tick and a sealed join
 * checkpoint per operation.
 */
export interface VpsJoinedMetricsModule {
  createVpsJournalReader(
    run: VpsBoundedJournalCommand,
    root: string,
    coverage: VpsJournalCoverageReader,
  ): JournalReader<[VpsQueryLimits]>;
  runVpsJournalCommand: VpsBoundedJournalCommand;
  VpsJournalMetrics: new (
    reader: JournalReader<[VpsQueryLimits]>,
    now: () => number,
    lagMs: number,
    timeoutKinds: readonly string[],
    upstreamWideKinds: readonly string[],
    options: VpsMetricsOptions,
  ) => Sampler & VpsMetricsWork;
}
/**
 * The #1027 join storage adapter (`ops/vps-metrics-storage.ts`). Since
 * ubiquity/ai.ubq.fi#1155 it takes an optional `stateReadMs` (default 10 s,
 * a positive safe integer) and prunes `.data/sentinel-vps-metrics` by
 * `policy.evidenceMaxAgeMs` on each save.
 */
export interface VpsJoinStorageModule {
  createVpsJoinFileStorage(
    root: string,
    policy: RetentionPolicyV1,
    cipher: VpsJoinCipher,
    current: (scope: VpsMetricsScope) => Promise<VpsMetricsScope>,
    now?: () => number,
    stateReadMs?: number,
  ): VpsJoinStorage;
}

export type VpsMetricsInterfaceV1 =
  | { kind: "window"; module: VpsWindowMetricsModule }
  | { kind: "joined"; module: VpsJoinedMetricsModule };
const method = (target: unknown, name: string, length?: number): boolean => {
  const value = (target as Record<string, unknown> | null)?.[name];
  return typeof value === "function" &&
    (length === undefined || value.length === length);
};
/** Exactly one known shape, or null: an interface mismatch is never guessed. */
export function vpsMetricsInterface(
  module: unknown,
): VpsMetricsInterfaceV1 | null {
  const exports = module as Record<string, unknown> | null;
  const metrics = exports?.VpsJournalMetrics;
  if (
    typeof metrics !== "function" ||
    !method(exports, "createVpsJournalReader", 3) ||
    !method(metrics.prototype, "sample", 1)
  ) return null;
  const ticks = method(metrics.prototype, "beginTick", 1) &&
    method(metrics.prototype, "progress", 1);
  if (
    metrics.length === 5 && !("beginTick" in metrics.prototype) &&
    !("progress" in metrics.prototype) &&
    !("runVpsJournalCommand" in exports!)
  ) return { kind: "window", module: module as VpsWindowMetricsModule };
  if (
    metrics.length === 6 && ticks &&
    method(exports, "runVpsJournalCommand", 3)
  ) return { kind: "joined", module: module as VpsJoinedMetricsModule };
  return null;
}
/** The pinned storage adapter, or null when its signature changed. */
export function vpsJoinStorageModule(
  module: unknown,
): VpsJoinStorageModule | null {
  return method(module, "createVpsJoinFileStorage", 4)
    ? module as VpsJoinStorageModule
    : null;
}
