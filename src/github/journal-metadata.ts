// journal metadata.

import type { GitSha } from "../contracts/brands.ts";
import { parseHostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import {
  expectBoolean,
  expectCount,
  expectEnum,
  expectGitSha,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectString,
  expectTimestamp,
  fail,
  MaxText,
} from "../contracts/validation.ts";
import {
  REVIEW_REASONING,
  type ReviewResultV1,
} from "./review-result-contracts.ts";
import { expectStrictJson } from "./journal-json.ts";
import {
  expectJournalExactKeys,
  expectJournalExactKeysWithOptional,
  parseReviewResultV1,
} from "./review-result-parser.ts";
import { expectBoundedId, expectModelId } from "./journal-text.ts";

// ---------------------------------------------------------------------------
// Journal phases
// ---------------------------------------------------------------------------

export type ReviewJournalPhaseV1 = "intent" | "running" | "ready";

export interface ReviewJournalRepositoryV1 {
  owner: string;
  name: string;
}

export interface ReviewJournalExecutionV1 {
  ownerRunId: string;
  invocationId: string;
  threadId: string;
  submittedProvider: string;
  /**
   * Trusted configured runtime model id for this review. The frozen
   * `REVIEW_MODEL` is only the omitted-caller default, so a route-selected
   * model round-trips as its own bounded identity (never a hardcoded literal).
   */
  model: string | null;
  reasoning: typeof REVIEW_REASONING | null;
  /** Absent only on retained historical generic-turn records. */
  nativeReview?: { mode: "review/start"; targetDigest: string };
  /** Explicit durable marker: a model start may occur after running readback. */
  startMayOccur: true;
}

export interface ReviewJournalRuntimeActualV1 {
  /** Request/runtime evidence class — never a backend provider attestation. */
  evidenceKind: "request-runtime" | "native-review";
  provider: string;
  threadId: string;
  turnId: string;
  terminalOrigin: "runtime" | "host-timeout";
  observedTerminalStatus: "completed" | "interrupted" | "failed" | null;
  /**
   * Bounded observed runtime model id, exactly equal to the submitted
   * `execution.model`; the default literal is never assumed.
   */
  observedModel: string | null;
  observedReasoning: typeof REVIEW_REASONING | null;
  nativeReview?: {
    targetDigest: string;
    reviewThreadId: string;
    enteredItemId: string | null;
    exitedItemId: string | null;
  };
  durationMs: number;
  outputChars: number;
}

export interface ReviewJournalReadyExecutionV1
  extends ReviewJournalExecutionV1 {
  turnId: string;
  resultId: string;
  actual: ReviewJournalRuntimeActualV1;
}

export interface ReviewJournalIntentV1 {
  version: "v1";
  phase: "intent";
  repository: ReviewJournalRepositoryV1;
  prNumber: number;
  expectedHead: GitSha;
  expectedBase: GitSha;
  operationKey: string;
  publisher: string;
  requestId: string;
  requestedAt: number;
  /** Trusted future owner binding; absence is preserved for old journals. */
  ownerExecution?: HostedExecutionIntentV1;
}

export interface ReviewJournalRunningV1
  extends Omit<ReviewJournalIntentV1, "phase"> {
  phase: "running";
  reviewId: number;
  execution: ReviewJournalExecutionV1;
}

export interface ReviewJournalReadyV1
  extends Omit<ReviewJournalIntentV1, "phase"> {
  phase: "ready";
  reviewId: number;
  completedAt: number;
  result: ReviewResultV1;
  resultDigest: string;
  execution: ReviewJournalReadyExecutionV1 | null;
}

export type ReviewJournalV1 =
  | ReviewJournalIntentV1
  | ReviewJournalRunningV1
  | ReviewJournalReadyV1;

export const INTENT_KEYS = [
  "version",
  "phase",
  "repository",
  "prNumber",
  "expectedHead",
  "expectedBase",
  "operationKey",
  "publisher",
  "requestId",
  "requestedAt",
] as const;

export const RUNNING_EXTRA_KEYS = ["reviewId", "execution"] as const;

export const READY_EXTRA_KEYS = [
  "reviewId",
  "completedAt",
  "result",
  "resultDigest",
  "execution",
] as const;

export const EXECUTION_KEYS = [
  "ownerRunId",
  "invocationId",
  "threadId",
  "submittedProvider",
  "model",
  "reasoning",
  "startMayOccur",
] as const;

export const READY_EXECUTION_KEYS = [
  ...EXECUTION_KEYS,
  "turnId",
  "resultId",
  "actual",
] as const;

export const ACTUAL_KEYS = [
  "evidenceKind",
  "provider",
  "threadId",
  "turnId",
  "terminalOrigin",
  "observedTerminalStatus",
  "observedModel",
  "observedReasoning",
  "durationMs",
  "outputChars",
] as const;

/**
 * Parse the strict journal record from its canonical JSON text (metadata
 * only; the whole-body parser is `parseReviewJournalBody`). Throws
 * `RecordParseError`; `bound_exceeded` is the unavailable disposition.
 */
export function parseReviewJournalMetadata(json: string): ReviewJournalV1 {
  const value = expectStrictJson(json, "$");
  return parseReviewJournalValue(value);
}

export function parseReviewJournalValue(input: unknown): ReviewJournalV1 {
  const obj = expectRecord(input, "$");
  const phase = expectEnum(
    obj.phase,
    ["intent", "running", "ready"],
    "$.phase",
  );
  if (phase === "intent") {
    expectJournalExactKeysWithOptional(
      obj,
      INTENT_KEYS,
      ["ownerExecution"],
      "$",
    );
    return { ...parseCommon(obj), phase: "intent" };
  }
  if (phase === "running") {
    expectJournalExactKeysWithOptional(
      obj,
      [...INTENT_KEYS, ...RUNNING_EXTRA_KEYS],
      ["ownerExecution"],
      "$",
    );
    const common = parseCommon(obj);
    const execution = parseExecution(obj.execution, "$.execution");
    checkOwnerExecution(common, execution);
    return {
      ...common,
      phase: "running",
      reviewId: expectPositiveInt(obj.reviewId, "$.reviewId"),
      execution,
    };
  }
  expectJournalExactKeysWithOptional(
    obj,
    [...INTENT_KEYS, ...READY_EXTRA_KEYS],
    ["ownerExecution"],
    "$",
  );
  const common = parseCommon(obj);
  const completedAt = expectTimestamp(obj.completedAt, "$.completedAt");
  if (completedAt < common.requestedAt) {
    fail(
      "$.completedAt",
      "invalid_lifecycle",
      "completion precedes request time",
    );
  }
  const result = parseReviewResultV1(obj.result);
  const resultDigest = expectSha256Hex(obj.resultDigest, "$.resultDigest");
  const execution = obj.execution === null
    ? null
    : parseReadyExecution(obj.execution, "$.execution");
  if (execution !== null) checkOwnerExecution(common, execution);
  if (result.verdict !== "unavailable") {
    if (execution === null) {
      fail(
        "$.execution",
        "invalid_lifecycle",
        "completed verdict requires execution evidence",
      );
    }
    if (
      execution.actual.terminalOrigin !== "runtime" ||
      execution.actual.observedTerminalStatus !== "completed"
    ) {
      fail(
        "$.execution",
        "invalid_lifecycle",
        "completed verdict requires observed runtime completion",
      );
    }
  }
  return {
    ...common,
    phase: "ready",
    reviewId: expectPositiveInt(obj.reviewId, "$.reviewId"),
    completedAt,
    result,
    resultDigest,
    execution,
  };
}

export function parseCommon(
  obj: Record<string, unknown>,
): ReviewJournalIntentV1 {
  const version = expectEnum(obj.version, ["v1"], "$.version");
  const repository = expectRecord(obj.repository, "$.repository");
  expectJournalExactKeys(repository, ["owner", "name"], "$.repository");
  const owner = expectString(
    repository.owner,
    "$.repository.owner",
    MaxText.owner,
  );
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    fail("$.repository.owner", "invalid_pattern", "expected GitHub owner name");
  }
  const name = expectString(repository.name, "$.repository.name", MaxText.name);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    fail(
      "$.repository.name",
      "invalid_pattern",
      "expected GitHub repository name",
    );
  }
  const ownerExecution = Object.hasOwn(obj, "ownerExecution")
    ? parseHostedExecutionIntentV1(obj.ownerExecution, "$.ownerExecution")
    : undefined;
  if (ownerExecution !== undefined && ownerExecution.purpose !== "ordinary") {
    fail(
      "$.ownerExecution",
      "invalid_lifecycle",
      "review owner requires ordinary execution",
    );
  }
  return {
    version,
    phase: "intent",
    repository: { owner, name },
    prNumber: expectPositiveInt(obj.prNumber, "$.prNumber"),
    expectedHead: expectGitSha(obj.expectedHead, "$.expectedHead"),
    expectedBase: expectGitSha(obj.expectedBase, "$.expectedBase"),
    operationKey: expectBoundedId(
      obj.operationKey,
      "$.operationKey",
      MaxText.recordId,
    ),
    publisher: expectBoundedId(obj.publisher, "$.publisher", MaxText.login),
    requestId: expectBoundedId(obj.requestId, "$.requestId", MaxText.recordId),
    requestedAt: expectTimestamp(obj.requestedAt, "$.requestedAt"),
    ...(ownerExecution === undefined ? {} : { ownerExecution }),
  };
}

function checkOwnerExecution(
  journal: ReviewJournalIntentV1,
  execution: ReviewJournalExecutionV1,
): void {
  if (
    journal.ownerExecution !== undefined &&
    execution.ownerRunId !== journal.ownerExecution.id
  ) {
    fail(
      "$.execution.ownerRunId",
      "invalid_lifecycle",
      "review execution owner does not bind the native execution",
    );
  }
}

export function parseExecution(
  input: unknown,
  path: string,
): ReviewJournalExecutionV1 {
  const obj = expectRecord(input, path);
  expectJournalExactKeysWithOptional(
    obj,
    EXECUTION_KEYS,
    ["nativeReview"],
    path,
  );
  return parseExecutionFields(obj, path);
}

export function parseExecutionFields(
  obj: Record<string, unknown>,
  path: string,
): ReviewJournalExecutionV1 {
  let nativeReview: ReviewJournalExecutionV1["nativeReview"];
  if (Object.hasOwn(obj, "nativeReview")) {
    const native = expectRecord(obj.nativeReview, `${path}.nativeReview`);
    expectJournalExactKeys(
      native,
      ["mode", "targetDigest"],
      `${path}.nativeReview`,
    );
    nativeReview = {
      mode: expectEnum(
        native.mode,
        ["review/start"],
        `${path}.nativeReview.mode`,
      ),
      targetDigest: expectSha256Hex(
        native.targetDigest,
        `${path}.nativeReview.targetDigest`,
      ),
    };
    if (obj.model !== null || obj.reasoning !== null) {
      fail(path, "invalid_value", "native reviewer selection belongs to Codex");
    }
  }
  const model = nativeReview ? null : expectModelId(obj.model, `${path}.model`);
  const reasoning = nativeReview ? null : expectEnum(
    obj.reasoning,
    [REVIEW_REASONING],
    `${path}.reasoning`,
  );
  const startMayOccur = expectBoolean(
    obj.startMayOccur,
    `${path}.startMayOccur`,
  );
  if (startMayOccur !== true) {
    fail(`${path}.startMayOccur`, "invalid_value", "start marker must be true");
  }
  return {
    ownerRunId: expectBoundedId(
      obj.ownerRunId,
      `${path}.ownerRunId`,
      MaxText.recordId,
    ),
    invocationId: expectBoundedId(
      obj.invocationId,
      `${path}.invocationId`,
      MaxText.recordId,
    ),
    threadId: expectBoundedId(
      obj.threadId,
      `${path}.threadId`,
      MaxText.recordId,
    ),
    submittedProvider: expectBoundedId(
      obj.submittedProvider,
      `${path}.submittedProvider`,
      MaxText.token,
    ),
    model,
    reasoning,
    ...(nativeReview ? { nativeReview } : {}),
    startMayOccur,
  };
}

export function parseReadyExecution(
  input: unknown,
  path: string,
): ReviewJournalReadyExecutionV1 {
  const obj = expectRecord(input, path);
  expectJournalExactKeysWithOptional(obj, READY_EXECUTION_KEYS, [
    "nativeReview",
  ], path);
  const execution = parseExecutionFields(obj, path);
  const turnId = expectBoundedId(
    obj.turnId,
    `${path}.turnId`,
    MaxText.recordId,
  );
  const resultId = expectBoundedId(
    obj.resultId,
    `${path}.resultId`,
    MaxText.recordId,
  );
  const actual = parseActual(obj.actual, `${path}.actual`, execution, turnId);
  if (
    execution.nativeReview && actual.nativeReview?.exitedItemId !== resultId
  ) fail(path, "invalid_value", "native exit result identity mismatch");
  return { ...execution, turnId, resultId, actual };
}

export function parseActual(
  input: unknown,
  path: string,
  execution: ReviewJournalExecutionV1,
  turnId: string,
): ReviewJournalRuntimeActualV1 {
  const obj = expectRecord(input, path);
  expectJournalExactKeysWithOptional(obj, ACTUAL_KEYS, ["nativeReview"], path);
  const evidenceKind = expectEnum(
    obj.evidenceKind,
    ["request-runtime", "native-review"],
    `${path}.evidenceKind`,
  );
  const provider = expectBoundedId(
    obj.provider,
    `${path}.provider`,
    MaxText.token,
  );
  const threadId = expectBoundedId(
    obj.threadId,
    `${path}.threadId`,
    MaxText.recordId,
  );
  const actualTurnId = expectBoundedId(
    obj.turnId,
    `${path}.turnId`,
    MaxText.recordId,
  );
  if (provider !== execution.submittedProvider) {
    fail(
      `${path}.provider`,
      "invalid_value",
      "provider does not match submitted configuration",
    );
  }
  if (threadId !== execution.threadId) {
    fail(
      `${path}.threadId`,
      "invalid_value",
      "thread identity does not match execution",
    );
  }
  if (actualTurnId !== turnId) {
    fail(
      `${path}.turnId`,
      "invalid_value",
      "turn identity does not match execution",
    );
  }
  const terminalOrigin = expectEnum(
    obj.terminalOrigin,
    ["runtime", "host-timeout"],
    `${path}.terminalOrigin`,
  );
  const observedTerminalStatus = obj.observedTerminalStatus === null
    ? null
    : expectEnum(
      obj.observedTerminalStatus,
      ["completed", "interrupted", "failed"],
      `${path}.observedTerminalStatus`,
    );
  if (terminalOrigin === "runtime" && observedTerminalStatus === null) {
    fail(
      `${path}.observedTerminalStatus`,
      "invalid_value",
      "runtime terminal requires an observed status",
    );
  }
  if (terminalOrigin === "host-timeout" && observedTerminalStatus !== null) {
    fail(
      `${path}.observedTerminalStatus`,
      "invalid_value",
      "host timeout carries no observed runtime terminal",
    );
  }
  let nativeReview: ReviewJournalRuntimeActualV1["nativeReview"];
  if (execution.nativeReview) {
    const native = expectRecord(obj.nativeReview, `${path}.nativeReview`);
    expectJournalExactKeys(native, [
      "targetDigest",
      "reviewThreadId",
      "enteredItemId",
      "exitedItemId",
    ], `${path}.nativeReview`);
    nativeReview = {
      targetDigest: expectSha256Hex(
        native.targetDigest,
        `${path}.nativeReview.targetDigest`,
      ),
      reviewThreadId: expectBoundedId(
        native.reviewThreadId,
        `${path}.nativeReview.reviewThreadId`,
        MaxText.recordId,
      ),
      enteredItemId: expectBoundedId(
        native.enteredItemId,
        `${path}.nativeReview.enteredItemId`,
        MaxText.recordId,
      ),
      exitedItemId: expectBoundedId(
        native.exitedItemId,
        `${path}.nativeReview.exitedItemId`,
        MaxText.recordId,
      ),
    };
    if (
      evidenceKind !== "native-review" ||
      nativeReview.targetDigest !== execution.nativeReview.targetDigest ||
      nativeReview.reviewThreadId !== threadId ||
      nativeReview.enteredItemId === nativeReview.exitedItemId ||
      obj.observedModel !== null || obj.observedReasoning !== null
    ) fail(path, "invalid_value", "native lifecycle evidence mismatch");
  } else if (
    evidenceKind !== "request-runtime" || Object.hasOwn(obj, "nativeReview")
  ) fail(path, "invalid_value", "legacy evidence cannot carry native proof");
  const observedModel = nativeReview ? null : expectModelId(
    obj.observedModel,
    `${path}.observedModel`,
  );
  const observedReasoning = nativeReview ? null : expectEnum(
    obj.observedReasoning,
    [REVIEW_REASONING],
    `${path}.observedReasoning`,
  );
  if (observedModel !== execution.model) {
    fail(
      `${path}.observedModel`,
      "invalid_value",
      "model does not match submitted configuration",
    );
  }
  if (observedReasoning !== execution.reasoning) {
    fail(
      `${path}.observedReasoning`,
      "invalid_value",
      "reasoning does not match submitted configuration",
    );
  }
  return {
    evidenceKind,
    provider,
    threadId,
    turnId: actualTurnId,
    terminalOrigin,
    observedTerminalStatus,
    observedModel,
    observedReasoning,
    ...(nativeReview ? { nativeReview } : {}),
    durationMs: expectCount(obj.durationMs, `${path}.durationMs`),
    outputChars: expectCount(obj.outputChars, `${path}.outputChars`),
  };
}

// ---------------------------------------------------------------------------
// Rendering / full-body parsing
// ---------------------------------------------------------------------------

export const METADATA_MARKER = "<!--sentinel-review-journal-v1";

export const METADATA_TERMINATOR = "-->";
