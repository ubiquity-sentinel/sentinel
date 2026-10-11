import { parseDeploymentIdentity, parseMetricsSample } from "./shared.ts";
import type { DeploymentIdentityV1 } from "./shared.ts";
import {
  describeValue,
  expectArray,
  expectEnum,
  expectExactKeys,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  fail,
  MaxItems,
  MaxText,
} from "./validation.ts";
import type {
  AcceptanceResultV1,
  AcceptanceThresholdResultV1,
  ReleaseErrorV1,
  ReleaseIntentV1,
  ReleaseMonitoringV1,
  ReleaseObservedV1,
  ReleaseReceiptV1,
  ReleaseRecordV1,
} from "./release-types.ts";

export const INTENT_KEYS = ["action", "key", "persistedAt"] as const;
export const OBSERVED_KEYS = ["identity", "domain", "verified", "at"] as const;
export const MONITORING_KEYS = [
  "startedAt",
  "samples",
  "continuous",
  "lastSampleAt",
] as const;
export const ACCEPTANCE_KEYS = [
  "identity",
  "windowMs",
  "sampleIntervalMs",
  "continuous",
  "baseline",
  "samples",
  "thresholdResults",
  "passed",
] as const;
export const THRESHOLD_KEYS = [
  "metric",
  "observedRate",
  "baselineRate",
  "maxRate",
  "maxIncrease",
  "passed",
] as const;
export const RECEIPT_KEYS = [
  "action",
  "ok",
  "statusCode",
  "observedIdentity",
  "observedDomain",
  "at",
  "detail",
] as const;
export const ERROR_KEYS = ["at", "kind", "detail", "recovered"] as const;
export const RECEIPTS_KEYS = ["promote", "rollback", "error"] as const;

export function sameIdentity(
  a: DeploymentIdentityV1,
  b: DeploymentIdentityV1,
): boolean {
  return a.gitSha === b.gitSha && a.revisionId === b.revisionId;
}

export function parseIntent(input: unknown, path: string): ReleaseIntentV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, INTENT_KEYS, path);
  return {
    action: expectEnum(obj.action, ["promote", "rollback"], `${path}.action`),
    key: expectNonEmptyString(obj.key, `${path}.key`, MaxText.token),
    persistedAt: expectTimestamp(obj.persistedAt, `${path}.persistedAt`),
  };
}

export function parseObserved(input: unknown, path: string): ReleaseObservedV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, OBSERVED_KEYS, path);
  const identity = expectNullable(
    obj.identity,
    `${path}.identity`,
    parseDeploymentIdentity,
  );
  const domain = expectNullableString(
    obj.domain,
    `${path}.domain`,
    MaxText.url,
  );
  const verified = expectBooleanOf(obj.verified, `${path}.verified`);
  const at = expectNullable(obj.at, `${path}.at`, expectTimestamp);
  if (verified && identity === null) {
    fail(
      `${path}.identity`,
      "invalid_lifecycle",
      "verified observation requires an identity",
    );
  }
  if (verified && at === null) {
    fail(
      `${path}.at`,
      "invalid_lifecycle",
      "verified observation requires a timestamp",
    );
  }
  return { identity, domain, verified, at };
}

export function parseMonitoring(
  input: unknown,
  path: string,
): ReleaseMonitoringV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, MONITORING_KEYS, path);
  const startedAt = expectNullable(
    obj.startedAt,
    `${path}.startedAt`,
    expectTimestamp,
  );
  const samples = expectCountOf(obj.samples, `${path}.samples`);
  const continuous = expectBooleanOf(obj.continuous, `${path}.continuous`);
  const lastSampleAt = expectNullable(
    obj.lastSampleAt,
    `${path}.lastSampleAt`,
    expectTimestamp,
  );
  if (
    samples > 0 &&
    (lastSampleAt === null || startedAt === null || lastSampleAt < startedAt)
  ) {
    fail(
      `${path}.lastSampleAt`,
      "invalid_lifecycle",
      "sampled monitoring requires startedAt <= lastSampleAt",
    );
  }
  return { startedAt, samples, continuous, lastSampleAt };
}

export function parseAcceptance(
  input: unknown,
  path: string,
  candidateIdentity: DeploymentIdentityV1,
  priorIdentity: DeploymentIdentityV1,
): AcceptanceResultV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ACCEPTANCE_KEYS, path);
  const identity = parseDeploymentIdentity(obj.identity, `${path}.identity`);
  const windowMs = expectPositiveInt(obj.windowMs, `${path}.windowMs`);
  const sampleIntervalMs = expectPositiveInt(
    obj.sampleIntervalMs,
    `${path}.sampleIntervalMs`,
  );
  const continuous = expectBooleanOf(obj.continuous, `${path}.continuous`);
  const baseline = expectArray(
    obj.baseline,
    `${path}.baseline`,
    MaxItems.metricsSamples,
    parseMetricsSample,
  );
  const samples = expectArray(
    obj.samples,
    `${path}.samples`,
    MaxItems.metricsSamples,
    parseMetricsSample,
  );
  const thresholdResults = expectThresholdResults(
    obj.thresholdResults,
    `${path}.thresholdResults`,
  );
  const passed = expectBooleanOf(obj.passed, `${path}.passed`);
  if (!sameIdentity(identity, candidateIdentity)) {
    fail(
      `${path}.identity`,
      "invalid_lifecycle",
      "acceptance must reference the exact candidate identity",
    );
  }
  if (baseline.length < 1) {
    fail(path, "invalid_lifecycle", "acceptance requires baseline evidence");
  }
  if (samples.length < 1) {
    fail(
      path,
      "invalid_lifecycle",
      "acceptance requires at least one sample",
    );
  }
  // Telemetry proves an exact identity: every acceptance sample must record
  // the exact candidate identity and every baseline sample the exact recorded
  // prior identity. A wrong Git SHA OR Deno revision id is binding, never an
  // approximation; a diagnostic under the wrong identity is not this release's
  // evidence.
  for (const [index, sample] of samples.entries()) {
    if (!sameIdentity(sample.identity, identity)) {
      fail(
        `${path}.samples[${index}].identity`,
        "invalid_lifecycle",
        "acceptance samples must record the exact acceptance identity",
      );
    }
  }
  for (const [index, sample] of baseline.entries()) {
    if (!sameIdentity(sample.identity, priorIdentity)) {
      fail(
        `${path}.baseline[${index}].identity`,
        "invalid_lifecycle",
        "baseline samples must record the exact recorded prior identity",
      );
    }
  }
  // A passing acceptance is only supportable by complete coverage; a
  // diagnostic acceptance (passed: false) persists its failure evidence even
  // with incomplete coverage instead of discarding it.
  if (passed) {
    for (
      const [listName, list] of [
        ["baseline", baseline],
        ["samples", samples],
      ] as const
    ) {
      for (const [index, sample] of list.entries()) {
        if (sample.coverage.status !== "complete") {
          fail(
            `${path}.${listName}[${index}].coverage`,
            "invalid_lifecycle",
            "incomplete coverage cannot support acceptance",
          );
        }
      }
    }
  }
  return {
    identity,
    windowMs,
    sampleIntervalMs,
    continuous,
    baseline,
    samples,
    thresholdResults,
    passed,
  };
}

export function expectThresholdResults(
  input: unknown,
  path: string,
): AcceptanceThresholdResultV1[] {
  if (!Array.isArray(input)) fail(path, "wrong_type", "expected array");
  if (input.length < 1 || input.length > MaxItems.thresholds) {
    fail(path, "bound_exceeded", "expected 1-8 threshold results");
  }
  return input.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    const obj = expectRecord(item, itemPath);
    expectExactKeys(obj, THRESHOLD_KEYS, itemPath);
    const metric = expectEnum(
      obj.metric,
      ["five_xx_rate", "timeout_rate", "stream_failure_rate"],
      `${itemPath}.metric`,
    );
    const observedRate = expectNullableRate(
      obj.observedRate,
      `${itemPath}.observedRate`,
    );
    const baselineRate = expectNullableRate(
      obj.baselineRate,
      `${itemPath}.baselineRate`,
    );
    const maxRate = expectRateOf(obj.maxRate, `${itemPath}.maxRate`);
    const maxIncrease = expectRateOf(
      obj.maxIncrease,
      `${itemPath}.maxIncrease`,
    );
    const passed = expectBooleanOf(obj.passed, `${itemPath}.passed`);
    return {
      metric,
      observedRate,
      baselineRate,
      maxRate,
      maxIncrease,
      passed,
    };
  });
}

export function parseReceipts(
  input: unknown,
  path: string,
): ReleaseRecordV1["receipts"] {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RECEIPTS_KEYS, path);
  return {
    promote: expectNullable(obj.promote, `${path}.promote`, parseReceipt),
    rollback: expectNullable(obj.rollback, `${path}.rollback`, parseReceipt),
    error: expectNullable(obj.error, `${path}.error`, parseError),
  };
}

export function parseReceipt(input: unknown, path: string): ReleaseReceiptV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RECEIPT_KEYS, path);
  const action = expectEnum(
    obj.action,
    ["promote", "rollback"],
    `${path}.action`,
  );
  const ok = expectBooleanOf(obj.ok, `${path}.ok`);
  const statusCode = expectNullable(
    obj.statusCode,
    `${path}.statusCode`,
    expectStatusCode,
  );
  const observedIdentity = expectNullable(
    obj.observedIdentity,
    `${path}.observedIdentity`,
    parseDeploymentIdentity,
  );
  const observedDomain = expectNullableString(
    obj.observedDomain,
    `${path}.observedDomain`,
    MaxText.url,
  );
  const at = expectTimestamp(obj.at, `${path}.at`);
  const detail = expectNullableString(
    obj.detail,
    `${path}.detail`,
    MaxText.detail,
  );
  if (ok && statusCode === null && action === "promote") {
    fail(
      `${path}.statusCode`,
      "invalid_lifecycle",
      "ok promote receipt requires a status code",
    );
  }
  return {
    action,
    ok,
    statusCode,
    observedIdentity,
    observedDomain,
    at,
    detail,
  };
}

export function parseError(input: unknown, path: string): ReleaseErrorV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ERROR_KEYS, path);
  return {
    at: expectTimestamp(obj.at, `${path}.at`),
    kind: expectNonEmptyString(obj.kind, `${path}.kind`, MaxText.label),
    detail: expectNonEmptyString(obj.detail, `${path}.detail`, MaxText.detail),
    recovered: expectBooleanOf(obj.recovered, `${path}.recovered`),
  };
}

export function expectBooleanOf(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(
      path,
      "invalid_boolean",
      `expected boolean, got ${describeValue(value)}`,
    );
  }
  return value;
}

export function expectCountOf(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(
      path,
      "invalid_count",
      `expected nonnegative safe integer, got ${describeValue(value)}`,
    );
  }
  return value;
}

export function expectStatusCode(value: unknown, path: string): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 100 ||
    value > 599
  ) {
    fail(
      path,
      "invalid_value",
      `expected HTTP status code, got ${describeValue(value)}`,
    );
  }
  return value;
}

export function expectRateOf(value: unknown, path: string): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
    value > 1
  ) {
    fail(
      path,
      "invalid_value",
      `expected rate in [0,1], got ${describeValue(value)}`,
    );
  }
  return value;
}

export function expectNullableRate(
  value: unknown,
  path: string,
): number | null {
  if (value === null) return null;
  return expectRateOf(value, path);
}
