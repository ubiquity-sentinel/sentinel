import type { GitSha } from "./brands.ts";
import {
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  fail,
  MaxText,
} from "./validation.ts";
import type {
  CandidatePreservationV1,
  CandidateStateV1,
  WorkTargetV1,
} from "./work-record-types.ts";

export const TARGET_KEYS = [
  "base",
  "branch",
  "checkpoint",
  "head",
  "pr",
] as const;
export const TARGET_CANDIDATE_KEYS = [
  ...TARGET_KEYS,
  "candidateState",
] as const;
export const CANDIDATE_STATE_KEYS = ["preserved", "publishedHead"] as const;
export const CANDIDATE_PRESERVATION_KEYS = [
  "operationKey",
  "base",
  "head",
  "ref",
] as const;
/** Exact preservation ref identity: one 64-hex digest ref body, no variants. */
export const PRESERVATION_REF_PATTERN =
  /^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/;
/** A producing reservation id is the trusted derived 64-hex SHA-256 id. */
export const CANDIDATE_PRESERVATION_KEY_PATTERN = /^impl:[0-9a-f]{64}$/;
/**
 * Candidate descriptors may also carry the exact base-refresh operation key
 * (the identity `baseRefreshIntentKey` derives). The implementation-reservation
 * form above remains the only key admitted for a candidate_preservation intent.
 */
export const CANDIDATE_DESCRIPTOR_BASE_REFRESH_KEY_PATTERN =
  /^base_refresh:([1-9][0-9]*):[0-9a-f]{40}:[0-9a-f]{40}$/;
export const CHECKPOINT_KEYS = ["branch", "sha"] as const;

export function parseTarget(input: unknown, path: string): WorkTargetV1 {
  const obj = expectRecord(input, path);
  // Absence of `candidateState` is the exact legacy shape. A present key (even
  // `undefined`, which expectExactKeys treats as missing) is the new shape and
  // must carry a complete, exact group — a default is never injected.
  const hasCandidateStateKey = Object.prototype.hasOwnProperty.call(
    obj,
    "candidateState",
  );
  expectExactKeys(
    obj,
    hasCandidateStateKey ? TARGET_CANDIDATE_KEYS : TARGET_KEYS,
    path,
  );
  const base = expectGitSha(obj.base, `${path}.base`);
  const branch = expectNullableString(
    obj.branch,
    `${path}.branch`,
    MaxText.branch,
  );
  const checkpoint = expectNullable(
    obj.checkpoint,
    `${path}.checkpoint`,
    parseCheckpoint,
  );
  const head = expectNullable(obj.head, `${path}.head`, expectGitSha);
  const pr = expectNullable(obj.pr, `${path}.pr`, expectPositiveInt);
  if (!hasCandidateStateKey) return { base, branch, checkpoint, head, pr };
  return {
    base,
    branch,
    checkpoint,
    head,
    pr,
    candidateState: parseCandidateState(
      obj.candidateState,
      `${path}.candidateState`,
      { base, branch, head },
    ),
  };
}

export function parseCandidateState(
  input: unknown,
  path: string,
  target: { base: GitSha; branch: string | null; head: GitSha | null },
): CandidateStateV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CANDIDATE_STATE_KEYS, path);
  if (target.branch === null) {
    fail(
      path,
      "invalid_lifecycle",
      "candidateState requires a nonnull target branch",
    );
  }
  const preserved = expectNullable(
    obj.preserved,
    `${path}.preserved`,
    (value, preservedPath) =>
      parseCandidatePreservation(value, preservedPath, target),
  );
  const publishedHead = expectNullable(
    obj.publishedHead,
    `${path}.publishedHead`,
    expectGitSha,
  );
  // A null candidate head cannot carry preservation evidence or a published
  // head: both would claim an exact SHA the target does not hold.
  if (target.head === null && (preserved !== null || publishedHead !== null)) {
    fail(
      path,
      "invalid_lifecycle",
      "a null target head requires null preserved and publishedHead",
    );
  }
  return { preserved, publishedHead };
}

/**
 * Candidate descriptors may carry either trusted producing-operation key form:
 * the implementation reservation or the exact base-refresh identity. This
 * checks descriptor syntax only; the producing consumer still verifies the full
 * operation/task/repository/reservation/head/base/ref binding before effects,
 * and a candidate_preservation INTENT key stays implementation-only.
 */
export function expectCandidateDescriptorOperationKey(
  value: unknown,
  path: string,
): string {
  const key = expectNonEmptyString(value, path, MaxText.token);
  if (CANDIDATE_PRESERVATION_KEY_PATTERN.test(key)) return key;
  const baseRefresh = CANDIDATE_DESCRIPTOR_BASE_REFRESH_KEY_PATTERN.exec(key);
  if (baseRefresh !== null) {
    // Canonical positive integer PR: the pattern already forbids zero,
    // negatives, signs and leading zeros; the value must also be a safe integer.
    const pr = Number(baseRefresh[1]);
    if (Number.isSafeInteger(pr) && String(pr) === baseRefresh[1]) return key;
  }
  fail(
    path,
    "invalid_pattern",
    "expected impl:<64-hex reservation id> or base_refresh:<PR>:<40-hex old head>:<40-hex new base>",
  );
}

export function parseCandidatePreservation(
  input: unknown,
  path: string,
  target: { base: GitSha; head: GitSha | null },
): CandidatePreservationV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CANDIDATE_PRESERVATION_KEYS, path);
  const operationKey = expectCandidateDescriptorOperationKey(
    obj.operationKey,
    `${path}.operationKey`,
  );
  const base = expectGitSha(obj.base, `${path}.base`);
  const head = expectGitSha(obj.head, `${path}.head`);
  const ref = expectPattern(
    obj.ref,
    `${path}.ref`,
    PRESERVATION_REF_PATTERN,
    "invalid_pattern",
    "expected refs/heads/sentinel-candidates/<64-hex>",
    MaxText.ref,
  );
  // The descriptor must describe THIS target: a preserved candidate bound to
  // another base/head is corrupted state, never silently rebound.
  if (base !== target.base || head !== target.head) {
    fail(
      path,
      "invalid_lifecycle",
      "preserved candidate base/head must equal target base/head",
    );
  }
  return { operationKey, base, head, ref };
}

export function parseCheckpoint(
  input: unknown,
  path: string,
): { branch: string; sha: GitSha } {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CHECKPOINT_KEYS, path);
  return {
    branch: expectNonEmptyString(obj.branch, `${path}.branch`, MaxText.branch),
    sha: expectGitSha(obj.sha, `${path}.sha`),
  };
}
