/**
 * AttemptInputV1: the input fingerprint of one implementation attempt that
 * actually produced an outcome, stored on its attempt-memory family record
 * (`AttemptMemoryRecordV1.inputs`, optional).
 *
 * The failure fingerprint (`attemptFingerprintV1`) names an OUTCOME (it binds
 * the closed failure detail), so it can only be compared after a charge. The
 * input fingerprint names what the NEXT attempt would start from, so the
 * trusted admission path can refuse an identical replay BEFORE reservation:
 *
 * - `baseTip`: the exact target base tip the attempt runs against;
 * - `patchDigest`: the candidate patch the attempt continues (domain
 *   `sentinel.memory.attempt-patch.v1` over `{base, head}`; `head: null` for a
 *   fresh implementation with no candidate yet);
 * - `findingsDigest`: the latest persisted review findings the attempt must
 *   address (domain `sentinel.memory.attempt-findings.v1` over the sorted
 *   bounded `{severity, path, message}` triples; `[]` when none);
 * - `controllerSha`: the runtime revision (a new revision is changed evidence,
 *   exactly as for the failure fingerprint).
 *
 * The input fingerprint itself is domain `sentinel.memory.attempt-input.v1`
 * over `{taskId, purpose, controllerSha, baseTip, patchDigest,
 * findingsDigest}`. All three domains are distinct from each other and from
 * `sentinel.memory.attempt-family.v1` / `sentinel.memory.attempt-fingerprint.v1`
 * and are never compared with them.
 *
 * Absence of `inputs` is the exact legacy shape: it is never injected, and a
 * historical record without it matches no input fingerprint (so it never
 * refuses anything). Trusted writers only; every field is a digest, a Git
 * SHA, a bounded reservation id or a count.
 */

import { createHash } from "node:crypto";
import type { GitSha, WorkItemId } from "./brands.ts";
import { canonicalStringify } from "./canonical.ts";
import {
  expectArray,
  expectCount,
  expectExactKeys,
  expectGitSha,
  expectNullable,
  expectPattern,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  fail,
  MaxItems,
} from "./validation.ts";

/** Reason recorded on a record refused for an identical replay. */
export const IDENTICAL_ATTEMPT_REFUSED = "identical_attempt_refused" as const;

/** Prefix of the prior-attempt fact carried into the next distinct attempt. */
export const IDENTICAL_ATTEMPT_FACT_PREFIX =
  "identical attempt refused: " as const;

export const ATTEMPT_INPUT_DOMAINS = {
  patch: "sentinel.memory.attempt-patch.v1",
  findings: "sentinel.memory.attempt-findings.v1",
  input: "sentinel.memory.attempt-input.v1",
} as const;

export interface AttemptInputV1 {
  /** `sentinel.memory.attempt-input.v1` digest (see module doc). */
  fingerprint: string;
  /** Exact reservation id of the attempt that ran with these inputs. */
  attemptId: string;
  controllerSha: GitSha;
  baseTip: GitSha;
  patchDigest: string;
  findingsDigest: string;
  /** Settlement time of the attempt that ran with these inputs. */
  atMs: number;
  /** Identical replays refused before reservation; never decreases. */
  refusals: number;
  lastRefusedAtMs: number | null;
}

export interface AttemptReviewFindingV1 {
  severity: string;
  path: string | null;
  message: string;
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalStringify(value), "utf8")
    .digest("hex");
}

export function attemptPatchDigestV1(
  input: { base: GitSha; head: GitSha | null },
): string {
  return sha256Canonical({
    domain: ATTEMPT_INPUT_DOMAINS.patch,
    base: input.base,
    head: input.head,
  });
}

/** Order-insensitive: the same set of findings always has one digest. */
export function attemptFindingsDigestV1(
  findings: readonly AttemptReviewFindingV1[] | null,
): string {
  const rows = (findings ?? []).map((finding) => ({
    severity: finding.severity,
    path: finding.path,
    message: finding.message,
  }));
  rows.sort((left, right) => {
    const a = canonicalStringify(left);
    const b = canonicalStringify(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return sha256Canonical({
    domain: ATTEMPT_INPUT_DOMAINS.findings,
    findings: rows,
  });
}

export function attemptInputFingerprintV1(input: {
  taskId: WorkItemId;
  purpose: "implementation";
  controllerSha: GitSha;
  baseTip: GitSha;
  patchDigest: string;
  findingsDigest: string;
}): string {
  return sha256Canonical({
    domain: ATTEMPT_INPUT_DOMAINS.input,
    taskId: input.taskId,
    purpose: input.purpose,
    controllerSha: input.controllerSha,
    baseTip: input.baseTip,
    patchDigest: input.patchDigest,
    findingsDigest: input.findingsDigest,
  });
}

const INPUT_KEYS = [
  "fingerprint",
  "attemptId",
  "controllerSha",
  "baseTip",
  "patchDigest",
  "findingsDigest",
  "atMs",
  "refusals",
  "lastRefusedAtMs",
] as const;

export function parseAttemptInputsV1(
  input: unknown,
  path: string,
): AttemptInputV1[] {
  const rows = expectArray(
    input,
    path,
    MaxItems.attemptEntries,
    (value, at) => {
      const obj = expectRecord(value, at);
      expectExactKeys(obj, INPUT_KEYS, at);
      return {
        fingerprint: expectSha256Hex(obj.fingerprint, `${at}.fingerprint`),
        attemptId: expectPattern(
          obj.attemptId,
          `${at}.attemptId`,
          /^[A-Za-z0-9._:-]{1,128}$/,
          "invalid_pattern",
          "expected a bounded reservation id",
          128,
        ),
        controllerSha: expectGitSha(obj.controllerSha, `${at}.controllerSha`),
        baseTip: expectGitSha(obj.baseTip, `${at}.baseTip`),
        patchDigest: expectSha256Hex(obj.patchDigest, `${at}.patchDigest`),
        findingsDigest: expectSha256Hex(
          obj.findingsDigest,
          `${at}.findingsDigest`,
        ),
        atMs: expectTimestamp(obj.atMs, `${at}.atMs`),
        refusals: expectCount(obj.refusals, `${at}.refusals`),
        lastRefusedAtMs: expectNullable(
          obj.lastRefusedAtMs,
          `${at}.lastRefusedAtMs`,
          expectTimestamp,
        ),
      };
    },
  );
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.fingerprint)) {
      fail(path, "invalid_value", "duplicate attempt input fingerprint");
    }
    seen.add(row.fingerprint);
    if ((row.refusals === 0) !== (row.lastRefusedAtMs === null)) {
      fail(
        path,
        "invalid_value",
        "refusals and lastRefusedAtMs must be set together",
      );
    }
  }
  return rows;
}

/**
 * Append one admitted-and-settled attempt's inputs (pure). An already-known
 * fingerprint keeps its original attempt id and counts: the prior charge and
 * its record are never rewritten. Bounded oldest-first; the cap drops the
 * oldest row (the authoritative charges stay in the reservation ledger).
 */
export function appendAttemptInputV1(
  inputs: readonly AttemptInputV1[] | undefined,
  row: Omit<AttemptInputV1, "refusals" | "lastRefusedAtMs">,
): AttemptInputV1[] {
  const rows = [...(inputs ?? [])];
  if (rows.some((existing) => existing.fingerprint === row.fingerprint)) {
    return rows;
  }
  rows.push({ ...row, refusals: 0, lastRefusedAtMs: null });
  return rows.length > MaxItems.attemptEntries
    ? rows.slice(rows.length - MaxItems.attemptEntries)
    : rows;
}
