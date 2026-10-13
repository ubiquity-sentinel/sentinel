/** Standalone VPS release records; never a Deno deployment or hosted runtime receipt. */
import { parseReleaseRequestV1, type ReleaseRequestV1 } from "./release.ts";
import {
  parseStabilityPolicy,
  type StabilityPolicyV1,
} from "./repository-policy.ts";
import {
  boundedText,
  canonicalVps,
  count,
  exactObject,
  gitSha,
  isHealthyVps,
  parseVpsReceipt,
  parseVpsSample,
  sameVps,
  sha256,
  type VpsBinding,
  vpsDigest,
  type VpsInferenceProof,
  type VpsMetricsSample,
  type VpsReceipt,
} from "./vps-release-wire.ts";

export const VPS_RECORD_PHASES = [
  "requested",
  "promoting",
  "monitoring",
  "accepted",
  "rollback_pending",
  "rolled_back",
  "failed",
] as const;
export type VpsReleasePhaseV1 = typeof VPS_RECORD_PHASES[number];
export interface VpsReleaseRecordV1 {
  version: "v1";
  kind: "vps_release_record";
  id: string;
  request: ReleaseRequestV1;
  requestDigest: string;
  driver: VpsReceipt;
  phase: VpsReleasePhaseV1;
  intent: {
    action: "promote" | "rollback" | "accept" | "fail";
    persistedAt: number;
  } | null;
  policy: StabilityPolicyV1;
  monitoring: {
    startedAt: number | null;
    lastObservedAt: number | null;
    continuous: boolean;
    baseline: VpsMetricsSample[];
    samples: VpsMetricsSample[];
  };
  acceptance:
    | { passed: boolean; objectiveFailure: boolean; missing: string[] }
    | null;
  inference: VpsInferenceProof | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}
export function evaluateVpsPolicy(
  policy: StabilityPolicyV1,
  baseline: readonly VpsMetricsSample[],
  samples: readonly VpsMetricsSample[],
): { passed: boolean; objectiveFailure: boolean; missing: string[] } {
  const missing: string[] = [];
  if (
    samples.length !== 60 ||
    baseline.length !== policy.baselineWindowMs / 30_000
  ) missing.push("window_incomplete");
  for (const sample of [...baseline, ...samples]) {
    if (
      sample.coverage !== "complete" || sample.requestCount === null ||
      sample.fiveXxCount === null || sample.timeoutCount === null ||
      sample.streamFailureCount === null || sample.upstreamWideFault === null
    ) missing.push("telemetry_incomplete");
    else if (sample.requestCount < policy.minRequests) {
      missing.push("traffic_sparse");
    }
    if (sample.upstreamWideFault === true) missing.push("upstream_wide_fault");
  }
  const rate = (list: readonly VpsMetricsSample[], metric: string): number => {
    const requests = list.reduce(
      (total, item) => total + (item.requestCount ?? 0),
      0,
    );
    const failures = list.reduce(
      (total, item) =>
        total +
        (metric === "five_xx_rate"
          ? item.fiveXxCount ?? 0
          : metric === "timeout_rate"
          ? item.timeoutCount ?? 0
          : item.streamFailureCount ?? 0),
      0,
    );
    return requests > 0 ? failures / requests : Number.POSITIVE_INFINITY;
  };
  const objectiveFailure = missing.length === 0 &&
    policy.thresholds.some((threshold) =>
      rate(samples, threshold.metric) > threshold.maxRate ||
      rate(samples, threshold.metric) >
        rate(baseline, threshold.metric) + threshold.maxIncrease
    );
  return {
    passed: missing.length === 0 && !objectiveFailure,
    objectiveFailure,
    missing: [...new Set(missing)],
  };
}
const invalid = (): never => {
  throw new TypeError("VPS release record is invalid");
};
const bool = (value: unknown): boolean => {
  if (typeof value !== "boolean") return invalid();
  return value;
};
function samples(value: unknown): VpsMetricsSample[] {
  if (!Array.isArray(value) || value.length > 1024) return invalid();
  return value.map(parseVpsSample);
}
export function parseVpsInference(value: unknown): VpsInferenceProof {
  const object = exactObject(value, [
    "revision",
    "observedAt",
    "origin",
    "authenticated",
    "succeeded",
    "proofDigest",
  ]);
  if (
    object.origin !== "mac-direct-vps" || object.authenticated !== true ||
    object.succeeded !== true
  ) return invalid();
  return {
    revision: gitSha(object.revision),
    observedAt: count(object.observedAt),
    origin: "mac-direct-vps",
    authenticated: true,
    succeeded: true,
    proofDigest: sha256(object.proofDigest),
  };
}
export function parseVpsReleaseRecordV1(value: unknown): VpsReleaseRecordV1 {
  const object = exactObject(value, [
    "version",
    "kind",
    "id",
    "request",
    "requestDigest",
    "driver",
    "phase",
    "intent",
    "policy",
    "monitoring",
    "acceptance",
    "inference",
    "error",
    "createdAt",
    "updatedAt",
  ]);
  if (
    object.version !== "v1" || object.kind !== "vps_release_record" ||
    !VPS_RECORD_PHASES.includes(object.phase as VpsReleasePhaseV1)
  ) return invalid();
  const request = parseReleaseRequestV1(object.request),
    driver = parseVpsReceipt(object.driver),
    requestDigest = sha256(object.requestDigest);
  const expectedRepository =
    `${request.target.repository.owner}/${request.target.repository.name}`;
  if (
    driver.binding.requestId !== request.id ||
    driver.binding.requestDigest !== requestDigest ||
    driver.binding.repository !== expectedRepository ||
    driver.binding.installationId !==
      request.target.repository.installationId ||
    driver.binding.environment !== request.target.environment ||
    driver.candidate.gitSha !== request.revision ||
    canonicalVps(driver.binding.source) !== canonicalVps(request.source)
  ) return invalid();
  const policy = parseStabilityPolicy(object.policy, "$.policy");
  if (
    policy.windowMs !== 1_800_000 || policy.sampleIntervalMs !== 30_000 ||
    policy.minSamples !== 60 || policy.baselineWindowMs % 30_000 !== 0
  ) return invalid();
  const monitor = exactObject(object.monitoring, [
    "startedAt",
    "lastObservedAt",
    "continuous",
    "baseline",
    "samples",
  ]);
  const baseline = samples(monitor.baseline),
    candidateSamples = samples(monitor.samples);
  const startedAt = monitor.startedAt === null
      ? null
      : count(monitor.startedAt),
    lastObservedAt = monitor.lastObservedAt === null
      ? null
      : count(monitor.lastObservedAt);
  const continuous = bool(monitor.continuous);
  if (
    lastObservedAt !== null &&
    (startedAt === null || lastObservedAt < startedAt)
  ) return invalid();
  for (const sample of baseline) {
    if (!sameVps(sample.identity, driver.prior.identity)) return invalid();
  }
  for (const [index, sample] of candidateSamples.entries()) {
    if (
      !sameVps(sample.identity, driver.candidate) || startedAt === null ||
      sample.windowStart !== startedAt + index * 30_000 ||
      sample.windowEnd !== sample.windowStart + 30_000
    ) return invalid();
  }
  let intent: VpsReleaseRecordV1["intent"] = null;
  if (object.intent !== null) {
    const entry = exactObject(object.intent, ["action", "persistedAt"]);
    if (
      !["promote", "rollback", "accept", "fail"].includes(String(entry.action))
    ) return invalid();
    intent = {
      action: entry.action as NonNullable<
        VpsReleaseRecordV1["intent"]
      >["action"],
      persistedAt: count(entry.persistedAt),
    };
  }
  let acceptance: VpsReleaseRecordV1["acceptance"] = null;
  if (object.acceptance !== null) {
    const entry = exactObject(object.acceptance, [
      "passed",
      "objectiveFailure",
      "missing",
    ]);
    if (!Array.isArray(entry.missing) || entry.missing.length > 2048) {
      return invalid();
    }
    acceptance = {
      passed: bool(entry.passed),
      objectiveFailure: bool(entry.objectiveFailure),
      missing: entry.missing.map((item) => boundedText(item, 128)),
    };
    if (
      acceptance.passed &&
      (acceptance.objectiveFailure || acceptance.missing.length)
    ) return invalid();
  }
  const inference = object.inference === null
    ? null
    : parseVpsInference(object.inference);
  const createdAt = count(object.createdAt),
    updatedAt = count(object.updatedAt),
    phase = object.phase as VpsReleasePhaseV1;
  if (
    updatedAt < createdAt || driver.createdAt > createdAt ||
    (intent &&
      (intent.persistedAt < createdAt || intent.persistedAt > updatedAt))
  ) return invalid();
  if (phase !== "requested" && intent === null) return invalid();
  if (
    inference &&
    (inference.revision !== request.revision ||
      inference.observedAt < createdAt || inference.observedAt > updatedAt)
  ) return invalid();
  if (acceptance?.passed) {
    if (
      !continuous || candidateSamples.length !== 60 ||
      baseline.length < policy.baselineMinSamples ||
      candidateSamples.some((item) => item.coverage !== "complete") ||
      baseline.some((item) => item.coverage !== "complete")
    ) return invalid();
    if (!evaluateVpsPolicy(policy, baseline, candidateSamples).passed) {
      return invalid();
    }
  }
  if (
    acceptance?.objectiveFailure &&
    !evaluateVpsPolicy(policy, baseline, candidateSamples).objectiveFailure
  ) return invalid();
  if (
    phase === "accepted" &&
    (!acceptance?.passed || !inference || driver.phase !== "accepted" ||
      !driver.loopback || !driver.public || !isHealthyVps(driver.loopback) ||
      !isHealthyVps(driver.public))
  ) return invalid();
  if (
    phase === "rolled_back" &&
    (driver.phase !== "rolled_back" || driver.restoration === null)
  ) return invalid();
  const error = object.error === null ? null : boundedText(object.error, 128);
  if (phase === "failed" && error === null) return invalid();
  return {
    version: "v1",
    kind: "vps_release_record",
    id: boundedText(object.id),
    request,
    requestDigest,
    driver,
    phase,
    intent,
    policy,
    monitoring: {
      startedAt,
      lastObservedAt,
      continuous,
      baseline,
      samples: candidateSamples,
    },
    acceptance,
    inference,
    error,
    createdAt,
    updatedAt,
  };
}
export function vpsRequestDigest(request: ReleaseRequestV1): Promise<string> {
  return vpsDigest({
    domain: "sentinel-vps-request-v1",
    request: parseReleaseRequestV1(request),
  });
}
export async function vpsBindingForRequest(
  request: ReleaseRequestV1,
): Promise<VpsBinding> {
  const parsed = parseReleaseRequestV1(request);
  return {
    requestId: parsed.id,
    requestDigest: await vpsRequestDigest(parsed),
    repository:
      `${parsed.target.repository.owner}/${parsed.target.repository.name}`,
    installationId: parsed.target.repository.installationId,
    environment: parsed.target.environment,
    revision: parsed.revision,
    source: { ...parsed.source },
  };
}
export async function vpsRecordBindsRequest(
  record: VpsReleaseRecordV1,
  request: ReleaseRequestV1,
): Promise<boolean> {
  try {
    const parsed = parseVpsReleaseRecordV1(record);
    return canonicalVps(parsed.request) ===
        canonicalVps(parseReleaseRequestV1(request)) &&
      parsed.requestDigest === await vpsRequestDigest(request);
  } catch {
    return false;
  }
}
export function validateVpsReleaseTransition(
  prior: readonly VpsReleaseRecordV1[],
  next: readonly VpsReleaseRecordV1[],
): string | null {
  const allowed: Record<VpsReleasePhaseV1, readonly VpsReleasePhaseV1[]> = {
    requested: ["requested", "promoting", "failed"],
    promoting: [
      "promoting",
      "monitoring",
      "rollback_pending",
      "rolled_back",
      "failed",
    ],
    monitoring: ["monitoring", "accepted", "rollback_pending", "failed"],
    rollback_pending: ["rollback_pending", "rolled_back", "failed"],
    accepted: ["accepted"],
    rolled_back: ["rolled_back"],
    failed: ["failed"],
  };
  for (const record of next) {
    if (
      !prior.some((item) => item.id === record.id) &&
      (record.phase !== "requested" || record.driver.phase !== "prepared")
    ) return "new VPS release must begin requested";
  }
  for (const previous of prior) {
    const current = next.find((item) => item.id === previous.id);
    if (!current) return "existing VPS release cannot disappear";
    for (
      const key of ["request", "requestDigest", "policy", "createdAt"] as const
    ) {
      if (
        canonicalVps(previous[key]) !== canonicalVps(current[key])
      ) return "VPS release identity changed";
    }
    for (
      const key of [
        "operationId",
        "binding",
        "candidate",
        "prior",
        "controllerSha",
        "driverSha256",
      ] as const
    ) {
      if (
        canonicalVps(previous.driver[key]) !== canonicalVps(current.driver[key])
      ) return "VPS driver identity changed";
    }
    if (
      ["accepted", "rolled_back", "failed"].includes(previous.phase) &&
      canonicalVps(previous) !== canonicalVps(current)
    ) return "terminal VPS release cannot change";
    if (
      current.updatedAt < previous.updatedAt ||
      current.driver.sequence < previous.driver.sequence ||
      !allowed[previous.phase].includes(current.phase)
    ) return "VPS release transition is invalid";
  }
  return null;
}
