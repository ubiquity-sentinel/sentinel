/** Exact post-merge check observations and the receipt saved before closure. */
import type { GitSha } from "./brands.ts";
import {
  expectArray,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  fail,
  MaxText,
} from "./validation.ts";

export interface DeliveryCheckV1 {
  name: string;
  /** GitHub check-run id, not a name-only aggregate or a backup-CI receipt. */
  runId: number;
  head: GitSha;
  status: string;
  conclusion: string | null;
}

export interface DeliveryReceiptV1 {
  head: GitSha;
  observedAt: number;
  checks: { name: string; runId: number; conclusion: "success" }[];
}

export function parseDeliveryReceiptV1(
  input: unknown,
  path: string,
): DeliveryReceiptV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ["head", "observedAt", "checks"], path);
  const checks = expectArray(obj.checks, `${path}.checks`, 64, (value, at) => {
    const check = expectRecord(value, at);
    expectExactKeys(check, ["name", "runId", "conclusion"], at);
    return {
      name: expectNonEmptyString(check.name, `${at}.name`, MaxText.label),
      runId: expectPositiveInt(check.runId, `${at}.runId`),
      conclusion: expectEnum(check.conclusion, ["success"], `${at}.conclusion`),
    };
  });
  if (
    checks.length === 0 ||
    new Set(checks.map((c) => c.name)).size !== checks.length
  ) {
    fail(
      `${path}.checks`,
      "invalid_lifecycle",
      "expected nonempty unique delivery checks",
    );
  }
  return {
    head: expectGitSha(obj.head, `${path}.head`),
    observedAt: expectTimestamp(obj.observedAt, `${path}.observedAt`),
    checks,
  };
}
