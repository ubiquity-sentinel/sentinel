import {
  expectArray,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectPositiveInt,
  expectRate,
  expectRecord,
  fail,
  MaxItems,
} from "./validation.ts";
import type { RepositoryConfigV1 } from "./repository-config.ts";

export type StabilityMetricV1 =
  | "five_xx_rate"
  | "timeout_rate"
  | "stream_failure_rate";

export interface LiveStartLimitsV1 {
  /**
   * Rolling one-hour model-start cap, or explicit null for no hourly admission
   * cap. Null is never a wildcard and never a permissive fallback: it only
   * bypasses the hourly checks. The `liveStartLimits` record itself stays
   * required before inference is enabled — a null record still means
   * inference is not enabled. Missing/undefined/malformed values stay invalid.
   */
  perHour: number | null;
  /**
   * Rolling seven-day model-start cap, or explicit null for no weekly
   * admission cap. Null is never a wildcard and never a permissive fallback:
   * it only bypasses the weekly checks, and every configured repository must
   * still agree on it. Missing/undefined/malformed values stay invalid.
   */
  perSevenDays: number | null;
}

export interface SessionBoundV1 {
  /** Declared maximum duration of one model session, in milliseconds. */
  maxDurationMs: number;
  /** Declared maximum output characters of one model session. */
  maxOutputChars: number;
}

export interface RetentionPolicyV1 {
  /** Live evidence expiry bound, in milliseconds (owner-approved). */
  evidenceMaxAgeMs: number;
  /** Byte bound on one retained encrypted artifact (restricted storage). */
  evidenceMaxBytes: number;
}

export interface StabilityThresholdV1 {
  metric: StabilityMetricV1;
  /** Owner-approved maximum observed rate; acceptance fails above it. */
  maxRate: number;
  /**
   * Owner-approved allowed rate increase against the baseline (rate points);
   * acceptance fails when observedRate exceeds baselineRate + maxIncrease.
   */
  maxIncrease: number;
}

export interface StabilityPolicyV1 {
  /** Monitoring window for acceptance, in milliseconds. */
  windowMs: number;
  /** Sampling interval, in milliseconds. */
  sampleIntervalMs: number;
  /** Minimum samples that must be collected to count the window as covered. */
  minSamples: number;
  /** Minimum requests per sample; below this telemetry is too sparse to judge. */
  minRequests: number;
  /** Baseline window used to compare current behavior, in milliseconds. */
  baselineWindowMs: number;
  /** Minimum baseline samples; below this the baseline is unusable. */
  baselineMinSamples: number;
  thresholds: StabilityThresholdV1[];
}

export interface AcceptanceIdentityV1 {
  /** Health endpoint path under the deployment domain. */
  healthPath: string;
  /** Metrics endpoint path (5xx/timeouts/stream failures denominators). */
  metricsPath: string;
  /** Marker string that must appear in the managed body. */
  managedBodyMarker: string;
  /** Non-secret managed response headers that must match exactly. */
  managedHeaders: { name: string; value: string }[];
  /** Custom domain to verify; null when no custom domain is configured. */
  domain: string | null;
}
export const LIMITS_KEYS = ["perHour", "perSevenDays"] as const;
export const SESSION_KEYS = ["maxDurationMs", "maxOutputChars"] as const;
export const RETENTION_KEYS = ["evidenceMaxAgeMs", "evidenceMaxBytes"] as const;
export const STABILITY_KEYS = [
  "windowMs",
  "sampleIntervalMs",
  "minSamples",
  "minRequests",
  "baselineWindowMs",
  "baselineMinSamples",
  "thresholds",
] as const;
export const THRESHOLD_KEYS = ["metric", "maxRate", "maxIncrease"] as const;

export function parseLiveStartLimits(
  input: unknown,
  path: string,
): LiveStartLimitsV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, LIMITS_KEYS, path);
  // Explicit null on either cap is the owner's uncapped policy. A missing,
  // undefined or malformed value stays invalid: the frozen key check rejects a
  // missing key and expectCount rejects every non-numeric present value.
  const perHour = obj.perHour === null
    ? null
    : expectCount(obj.perHour, `${path}.perHour`);
  const perSevenDays = obj.perSevenDays === null
    ? null
    : expectCount(obj.perSevenDays, `${path}.perSevenDays`);
  return { perHour, perSevenDays };
}

export function parseSessionBound(
  input: unknown,
  path: string,
): SessionBoundV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, SESSION_KEYS, path);
  return {
    maxDurationMs: expectPositiveInt(
      obj.maxDurationMs,
      `${path}.maxDurationMs`,
    ),
    maxOutputChars: expectPositiveInt(
      obj.maxOutputChars,
      `${path}.maxOutputChars`,
    ),
  };
}

export function parseRetentionPolicy(
  input: unknown,
  path: string,
): RetentionPolicyV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RETENTION_KEYS, path);
  return {
    evidenceMaxAgeMs: expectPositiveInt(
      obj.evidenceMaxAgeMs,
      `${path}.evidenceMaxAgeMs`,
    ),
    evidenceMaxBytes: expectPositiveInt(
      obj.evidenceMaxBytes,
      `${path}.evidenceMaxBytes`,
    ),
  };
}

export function parseStabilityPolicy(
  input: unknown,
  path: string,
): StabilityPolicyV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, STABILITY_KEYS, path);
  const windowMs = expectPositiveInt(obj.windowMs, `${path}.windowMs`);
  const sampleIntervalMs = expectPositiveInt(
    obj.sampleIntervalMs,
    `${path}.sampleIntervalMs`,
  );
  const minSamples = expectPositiveInt(obj.minSamples, `${path}.minSamples`);
  const minRequests = expectPositiveInt(
    obj.minRequests,
    `${path}.minRequests`,
  );
  const baselineWindowMs = expectPositiveInt(
    obj.baselineWindowMs,
    `${path}.baselineWindowMs`,
  );
  const baselineMinSamples = expectPositiveInt(
    obj.baselineMinSamples,
    `${path}.baselineMinSamples`,
  );
  const thresholds = expectArray(
    obj.thresholds,
    `${path}.thresholds`,
    MaxItems.thresholds,
    parseStabilityThreshold,
  );
  if (thresholds.length === 0) {
    fail(
      `${path}.thresholds`,
      "invalid_lifecycle",
      "at least one threshold is required",
    );
  }
  if (sampleIntervalMs > windowMs) {
    fail(path, "invalid_lifecycle", "sampleIntervalMs cannot exceed windowMs");
  }
  return {
    windowMs,
    sampleIntervalMs,
    minSamples,
    minRequests,
    baselineWindowMs,
    baselineMinSamples,
    thresholds,
  };
}

export function parseStabilityThreshold(
  input: unknown,
  path: string,
): StabilityThresholdV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, THRESHOLD_KEYS, path);
  const metric = expectEnum(
    obj.metric,
    ["five_xx_rate", "timeout_rate", "stream_failure_rate"],
    `${path}.metric`,
  );
  const maxRate = expectRate(obj.maxRate, `${path}.maxRate`);
  const maxIncrease = expectRate(obj.maxIncrease, `${path}.maxIncrease`);
  return { metric, maxRate, maxIncrease };
}

/**
 * Global budget policy is one owner configuration across all repositories.
 * This refuses to infer a policy when configured limits conflict; per-repo
 * independent caps are never used. Agreement covers both nullable fields:
 * explicit null (no cap) is one policy, and a null/numeric mix across
 * repositories is a conflict, never a fallback. A wholly null
 * `liveStartLimits` record is not a policy at all: it keeps inference
 * disabled.
 */
export type GlobalLiveStartLimitsV1 =
  | { status: "disabled" }
  | { status: "enabled"; limits: LiveStartLimitsV1 }
  | { status: "conflict"; repositories: string[] };

export function resolveGlobalLiveStartLimits(
  configs: readonly RepositoryConfigV1[],
): GlobalLiveStartLimitsV1 {
  const configured = configs.filter((c) => c.liveStartLimits !== null);
  if (configured.length === 0) return { status: "disabled" };
  const first = configured[0].liveStartLimits;
  if (first === null) return { status: "disabled" };
  const conflicting = configured.some((c) =>
    c.liveStartLimits!.perHour !== first.perHour ||
    c.liveStartLimits!.perSevenDays !== first.perSevenDays
  );
  if (conflicting) {
    return {
      status: "conflict",
      repositories: configured.map((c) =>
        `${c.repository.owner}/${c.repository.name}`
      ),
    };
  }
  return { status: "enabled", limits: first };
}
