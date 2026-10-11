import { isGitSha } from "./brands.ts";
import {
  expectEnum,
  expectExactKeys,
  expectExactKeysWithOptional,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  fail,
  MaxText,
} from "./validation.ts";
import type {
  IncompleteOperationV1,
  OperationFailureV1,
} from "./work-record-types.ts";
import {
  CANDIDATE_PRESERVATION_KEY_PATTERN,
  PRESERVATION_REF_PATTERN,
} from "./work-record-target.ts";

export const INTENT_KEYS = [
  "kind",
  "key",
  "startedAt",
  "branch",
  "expectedHead",
  "observedBase",
  "pr",
  "requestId",
  "resultId",
] as const;
/** Additive intent keys absent from rows written before they existed. */
export const INTENT_OPTIONAL_KEYS = ["failure"] as const;

export const OPERATION_FAILURE_KEYS = [
  "kind",
  "detail",
  "atMs",
  "attempts",
] as const;

export function parseOperationFailure(
  input: unknown,
  path: string,
): OperationFailureV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, OPERATION_FAILURE_KEYS, path);
  return {
    kind: expectNonEmptyString(obj.kind, `${path}.kind`, MaxText.token),
    detail: expectNonEmptyString(obj.detail, `${path}.detail`, MaxText.detail),
    atMs: expectTimestamp(obj.atMs, `${path}.atMs`),
    attempts: expectPositiveInt(obj.attempts, `${path}.attempts`),
  };
}

export function parseIntent(
  input: unknown,
  path: string,
): IncompleteOperationV1 {
  const obj = expectRecord(input, path);
  expectExactKeysWithOptional(obj, INTENT_KEYS, INTENT_OPTIONAL_KEYS, path);
  const kind = expectEnum(
    obj.kind,
    [
      "pull_request",
      "review_request",
      "merge",
      "issue_closure",
      "already_satisfied_closure",
      "push",
      "implementation",
      "replay",
      "base_refresh",
      "candidate_preservation",
    ],
    `${path}.kind`,
  );
  const expectedHead = expectNullable(
    obj.expectedHead,
    `${path}.expectedHead`,
    expectGitSha,
  );
  const observedBase = expectNullable(
    obj.observedBase,
    `${path}.observedBase`,
    expectGitSha,
  );
  const pr = expectNullable(obj.pr, `${path}.pr`, expectPositiveInt);
  const branch = expectNullableString(
    obj.branch,
    `${path}.branch`,
    MaxText.branch,
  );
  const requestId = expectNullableString(
    obj.requestId,
    `${path}.requestId`,
    MaxText.recordId,
  );
  const resultId = expectNullableString(
    obj.resultId,
    `${path}.resultId`,
    MaxText.recordId,
  );
  const startedAt = expectTimestamp(obj.startedAt, `${path}.startedAt`);
  const key = expectNonEmptyString(obj.key, `${path}.key`, MaxText.token);

  if (kind === "already_satisfied_closure") {
    if (
      expectedHead === null || observedBase === null || pr === null ||
      branch === null || requestId === null || resultId === null
    ) {
      fail(
        path,
        "invalid_lifecycle",
        "already-satisfied closure requires exact publication and review identities",
      );
    }
    if (key !== `satisfied:${pr}:${expectedHead}:${observedBase}`) {
      fail(
        `${path}.key`,
        "invalid_lifecycle",
        "already-satisfied closure key must bind exact PR/head/base",
      );
    }
  }

  // Fail-closed exact-identity rules per operation kind.
  if (kind === "pull_request" || kind === "push") {
    if (expectedHead === null) {
      fail(
        `${path}.expectedHead`,
        "invalid_lifecycle",
        "push/PR intent requires an expected head",
      );
    }
    if (branch === null) {
      fail(
        `${path}.branch`,
        "invalid_lifecycle",
        "push/PR intent requires a deterministic branch",
      );
    }
    if (kind === "push" && pr !== null) {
      fail(
        `${path}.pr`,
        "invalid_lifecycle",
        "push intent has no PR before creation",
      );
    }
    if (kind === "push" && (requestId !== null || resultId !== null)) {
      fail(
        `${path}.requestId`,
        "invalid_lifecycle",
        "push intent has no external request/result identity",
      );
    }
  }
  if (kind === "review_request" || kind === "merge") {
    if (pr === null) {
      fail(
        `${path}.pr`,
        "invalid_lifecycle",
        "review/merge intent requires a PR number",
      );
    }
    if (expectedHead === null) {
      fail(
        `${path}.expectedHead`,
        "invalid_lifecycle",
        "review/merge intent requires the expected head",
      );
    }
  }
  if (kind === "review_request" && branch === null) {
    fail(
      `${path}.branch`,
      "invalid_lifecycle",
      "review_request intent requires a deterministic branch",
    );
  }
  if (kind === "base_refresh") {
    // Exact old candidate/new base binding plus the exact PR and branch; the
    // prepared commit result id is a Git SHA once it exists, never free text.
    if (branch === null) {
      fail(
        `${path}.branch`,
        "invalid_lifecycle",
        "base_refresh intent requires a deterministic branch",
      );
    }
    if (expectedHead === null) {
      fail(
        `${path}.expectedHead`,
        "invalid_lifecycle",
        "base_refresh intent requires the old candidate head",
      );
    }
    if (observedBase === null) {
      fail(
        `${path}.observedBase`,
        "invalid_lifecycle",
        "base_refresh intent requires the observed new base",
      );
    }
    if (pr === null) {
      fail(
        `${path}.pr`,
        "invalid_lifecycle",
        "base_refresh intent requires a PR number",
      );
    }
    if (requestId !== null) {
      fail(
        `${path}.requestId`,
        "invalid_lifecycle",
        "base_refresh intent has no external request id",
      );
    }
    if (resultId !== null && !isGitSha(resultId)) {
      fail(
        `${path}.resultId`,
        "invalid_lifecycle",
        "base_refresh result id must be an exact git SHA",
      );
    }
  }
  if (kind === "candidate_preservation") {
    // Shape only: this reader never derives the preservation ref or writes it.
    // The key binds one producing reservation (`impl:<requestId>`), `branch`
    // is the full preservation ref (NOT target.branch), and the base/head are
    // exact nonnull SHAs; there is no PR or external result identity.
    if (!CANDIDATE_PRESERVATION_KEY_PATTERN.test(key)) {
      fail(
        `${path}.key`,
        "invalid_lifecycle",
        "candidate_preservation key must be impl:<producing reservation id>",
      );
    }
    if (requestId === null || key !== `impl:${requestId}`) {
      fail(
        `${path}.requestId`,
        "invalid_lifecycle",
        "candidate_preservation requestId must be the producing reservation id",
      );
    }
    if (branch === null || !PRESERVATION_REF_PATTERN.test(branch)) {
      fail(
        `${path}.branch`,
        "invalid_lifecycle",
        "candidate_preservation branch must be the exact preservation ref",
      );
    }
    if (expectedHead === null) {
      fail(
        `${path}.expectedHead`,
        "invalid_lifecycle",
        "candidate_preservation requires the expected candidate head",
      );
    }
    if (observedBase === null) {
      fail(
        `${path}.observedBase`,
        "invalid_lifecycle",
        "candidate_preservation requires the observed base",
      );
    }
    if (pr !== null) {
      fail(
        `${path}.pr`,
        "invalid_lifecycle",
        "candidate_preservation has no PR",
      );
    }
    if (resultId !== null) {
      fail(
        `${path}.resultId`,
        "invalid_lifecycle",
        "candidate_preservation has no external result id",
      );
    }
  }
  return {
    kind,
    key,
    startedAt,
    branch,
    expectedHead,
    observedBase,
    pr,
    requestId,
    resultId,
    ...(obj.failure === undefined ? {} : {
      failure: parseOperationFailure(obj.failure, `${path}.failure`),
    }),
  };
}
