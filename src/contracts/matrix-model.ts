import type { WorkItemId } from "./brands.ts";
import {
  ATTEMPT_FAILURE_CLASSES_V1 as PRIOR_ATTEMPT_CLASSES,
  ATTEMPT_STAGES_V1 as PRIOR_ATTEMPT_STAGES,
} from "./attempt-memory.ts";
import type {
  CandidateOutcomeV1,
  ModelRunReceiptV1,
  ModelRunRequestV1,
} from "./ports.ts";
import { parseEvidenceRef, parseRepositoryIdentity } from "./shared.ts";
import {
  expectArray,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectExactKeysWithOptional,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectString,
  expectTimestamp,
  fail,
} from "./validation.ts";
import {
  ACTUAL_KEYS,
  CANDIDATE_KEYS,
  FINDING_KEYS,
  MAX_CHANGED_PATHS,
  MAX_ERROR_CHARS,
  MAX_EVIDENCE_REFS,
  MAX_ID_CHARS,
  MAX_PATH_CHARS,
  MAX_PRIOR_ATTEMPT_DETAIL_CHARS,
  MAX_PRIOR_ATTEMPT_FACTS,
  MAX_REGRESSION_FACTS,
  MAX_REVIEW_FINDINGS,
  MAX_TEXT_CHARS,
  PRIOR_ATTEMPT_KEYS,
  RECEIPT_KEYS,
  REGRESSION_KEYS,
  REQUEST_OPTIONAL,
  REQUEST_REQUIRED,
  TERMINAL_STATUSES,
} from "./matrix-identity.ts";

export function parseFinding(
  input: unknown,
  path: string,
): { severity: string; path: string | null; message: string } {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, FINDING_KEYS, path);
  return {
    severity: expectNonEmptyString(obj.severity, `${path}.severity`, 64),
    path: expectNullable(
      obj.path,
      `${path}.path`,
      (value, at) => expectNonEmptyString(value, at, MAX_PATH_CHARS),
    ),
    message: expectNonEmptyString(
      obj.message,
      `${path}.message`,
      MAX_ERROR_CHARS,
    ),
  };
}

export function parseCandidateOutcome(
  input: unknown,
  path: string,
): CandidateOutcomeV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, CANDIDATE_KEYS, path);
  return {
    head: expectNullable(obj.head, `${path}.head`, expectGitSha),
    checkpointSha: expectNullable(
      obj.checkpointSha,
      `${path}.checkpointSha`,
      expectGitSha,
    ),
    changedPaths: expectArray(
      obj.changedPaths,
      `${path}.changedPaths`,
      MAX_CHANGED_PATHS,
      (value, at) => expectNonEmptyString(value, at, MAX_PATH_CHARS),
    ),
  };
}

/** Strict parse of one bounded model run request. */
export function parseMatrixModelRequestV1(
  input: unknown,
  path: string,
): ModelRunRequestV1 {
  const obj = expectRecord(input, path);
  expectExactKeysWithOptional(obj, REQUEST_REQUIRED, REQUEST_OPTIONAL, path);
  const issue = expectNullable(
    obj.issue,
    `${path}.issue`,
    (value, at) => {
      const item = expectRecord(value, at);
      expectExactKeys(item, ["number", "title", "body"], at);
      return {
        number: expectPositiveInt(item.number, `${at}.number`),
        title: expectString(item.title, `${at}.title`, MAX_TEXT_CHARS),
        body: expectString(item.body, `${at}.body`, MAX_TEXT_CHARS),
      };
    },
  );
  const evidence = expectArray(
    obj.evidence,
    `${path}.evidence`,
    MAX_EVIDENCE_REFS,
    parseEvidenceRef,
  );
  const reviewFindings = obj.reviewFindings === undefined
    ? undefined
    : expectArray(
      obj.reviewFindings,
      `${path}.reviewFindings`,
      MAX_REVIEW_FINDINGS,
      parseFinding,
    );
  const checkoutBase = obj.checkoutBase === undefined
    ? undefined
    : expectGitSha(obj.checkoutBase, `${path}.checkoutBase`);
  const mergeBase = obj.mergeBase === undefined
    ? undefined
    : expectGitSha(obj.mergeBase, `${path}.mergeBase`);
  const base = expectGitSha(obj.base, `${path}.base`);
  // A conflict resolution merges a NEW base into the published candidate it
  // continues: never without that candidate, never the durable base itself
  // and never the candidate.
  if (
    mergeBase !== undefined &&
    (checkoutBase === undefined || mergeBase === base ||
      mergeBase === checkoutBase)
  ) {
    fail(
      `${path}.mergeBase`,
      "invalid_lifecycle",
      "mergeBase requires a distinct checkoutBase and base",
    );
  }
  const scopeNote = obj.scopeNote === undefined
    ? undefined
    : expectNonEmptyString(obj.scopeNote, `${path}.scopeNote`, MAX_TEXT_CHARS);
  const parsePriorAttemptFact = (value: unknown, at: string) => {
    const fact = expectRecord(value, at);
    expectExactKeys(fact, PRIOR_ATTEMPT_KEYS, at);
    return {
      detail: expectNonEmptyString(
        fact.detail,
        `${at}.detail`,
        MAX_PRIOR_ATTEMPT_DETAIL_CHARS,
      ),
      stage: expectEnum(
        fact.stage,
        PRIOR_ATTEMPT_STAGES,
        `${at}.stage`,
      ),
      failureClass: expectEnum(
        fact.failureClass,
        PRIOR_ATTEMPT_CLASSES,
        `${at}.failureClass`,
      ),
      count: expectPositiveInt(fact.count, `${at}.count`),
      lastAtMs: expectTimestamp(fact.lastAtMs, `${at}.lastAtMs`),
    };
  };
  const priorAttempts = obj.priorAttempts === undefined
    ? undefined
    : expectArray(
      obj.priorAttempts,
      `${path}.priorAttempts`,
      MAX_PRIOR_ATTEMPT_FACTS,
      parsePriorAttemptFact,
    );
  const repositoryLessons = obj.repositoryLessons === undefined
    ? undefined
    : expectArray(
      obj.repositoryLessons,
      `${path}.repositoryLessons`,
      MAX_PRIOR_ATTEMPT_FACTS,
      parsePriorAttemptFact,
    );
  const regressions = obj.regressions === undefined ? undefined : expectArray(
    obj.regressions,
    `${path}.regressions`,
    MAX_REGRESSION_FACTS,
    (value, at) => {
      const fact = expectRecord(value, at);
      expectExactKeys(fact, REGRESSION_KEYS, at);
      return {
        detail: expectNonEmptyString(
          fact.detail,
          `${at}.detail`,
          MAX_PRIOR_ATTEMPT_DETAIL_CHARS,
        ),
        priorSuccessRevision: expectGitSha(
          fact.priorSuccessRevision,
          `${at}.priorSuccessRevision`,
        ),
        priorSuccessAtMs: expectTimestamp(
          fact.priorSuccessAtMs,
          `${at}.priorSuccessAtMs`,
        ),
        failuresAtCurrentRevision: expectPositiveInt(
          fact.failuresAtCurrentRevision,
          `${at}.failuresAtCurrentRevision`,
        ),
        lastFailureAtMs: expectTimestamp(
          fact.lastFailureAtMs,
          `${at}.lastFailureAtMs`,
        ),
      };
    },
  );
  if (obj.reasoning !== "max") {
    fail(`${path}.reasoning`, "invalid_enum", "reasoning must be max");
  }
  return {
    taskId: expectPattern(
      obj.taskId,
      `${path}.taskId`,
      /^[A-Za-z0-9._:-]{1,256}$/,
      "invalid_pattern",
      "expected a bounded work id",
      MAX_ID_CHARS,
    ) as WorkItemId,
    repository: parseRepositoryIdentity(obj.repository, `${path}.repository`),
    base,
    ...(checkoutBase === undefined ? {} : { checkoutBase }),
    ...(mergeBase === undefined ? {} : { mergeBase }),
    ...(scopeNote === undefined ? {} : { scopeNote }),
    issue,
    evidence,
    ...(reviewFindings === undefined ? {} : { reviewFindings }),
    ...(priorAttempts === undefined ? {} : { priorAttempts }),
    ...(repositoryLessons === undefined ? {} : { repositoryLessons }),
    ...(regressions === undefined ? {} : { regressions }),
    model: expectNonEmptyString(obj.model, `${path}.model`, MAX_ID_CHARS),
    reasoning: "max",
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

/** Strict parse of one model run receipt projection. */
export function parseMatrixModelReceiptV1(
  input: unknown,
  path: string,
): ModelRunReceiptV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RECEIPT_KEYS, path);
  const actual = expectRecord(obj.actual, `${path}.actual`);
  expectExactKeys(actual, ACTUAL_KEYS, `${path}.actual`);
  if (actual.evidenceKind !== "request-runtime") {
    fail(
      `${path}.actual.evidenceKind`,
      "invalid_enum",
      "evidenceKind must be request-runtime",
    );
  }
  const outcome = expectEnum(
    obj.outcome,
    ["completed", "failed", "interrupted"],
    `${path}.outcome`,
  );
  const terminalOrigin = expectEnum(
    actual.terminalOrigin,
    ["runtime", "host-timeout"],
    `${path}.actual.terminalOrigin`,
  );
  const observedTerminalStatus = expectNullable(
    actual.observedTerminalStatus,
    `${path}.actual.observedTerminalStatus`,
    (value, at) => expectEnum(value, TERMINAL_STATUSES, at),
  );
  // Terminal-origin semantics are preserved exactly: a runtime origin must
  // carry an observed terminal; a host timeout must never claim one.
  if (terminalOrigin === "runtime" && observedTerminalStatus === null) {
    fail(
      `${path}.actual.observedTerminalStatus`,
      "invalid_lifecycle",
      "a runtime terminal origin requires an observed terminal status",
    );
  }
  if (terminalOrigin === "host-timeout" && observedTerminalStatus !== null) {
    fail(
      `${path}.actual.observedTerminalStatus`,
      "invalid_lifecycle",
      "a host timeout cannot claim an observed terminal status",
    );
  }
  if (outcome === "completed" && observedTerminalStatus !== "completed") {
    fail(
      `${path}.outcome`,
      "invalid_lifecycle",
      "a completed outcome requires an observed completed terminal",
    );
  }
  const candidate = expectNullable(
    obj.candidate,
    `${path}.candidate`,
    parseCandidateOutcome,
  );
  if (outcome === "completed" && candidate === null) {
    fail(
      `${path}.candidate`,
      "missing_field",
      "a completed outcome requires a candidate outcome block",
    );
  }
  if (outcome !== "completed" && candidate !== null) {
    fail(
      `${path}.candidate`,
      "invalid_lifecycle",
      "a non-completed outcome cannot carry a candidate",
    );
  }
  return {
    invocationId: expectNonEmptyString(
      obj.invocationId,
      `${path}.invocationId`,
      MAX_ID_CHARS,
    ),
    outcome,
    actual: {
      evidenceKind: "request-runtime",
      provider: expectNonEmptyString(
        actual.provider,
        `${path}.actual.provider`,
        MAX_ID_CHARS,
      ),
      threadId: expectNonEmptyString(
        actual.threadId,
        `${path}.actual.threadId`,
        MAX_ID_CHARS,
      ),
      turnId: expectNonEmptyString(
        actual.turnId,
        `${path}.actual.turnId`,
        MAX_ID_CHARS,
      ),
      terminalOrigin,
      observedTerminalStatus,
      observedModel: expectNonEmptyString(
        actual.observedModel,
        `${path}.actual.observedModel`,
        MAX_ID_CHARS,
      ),
      observedReasoning: expectNonEmptyString(
        actual.observedReasoning,
        `${path}.actual.observedReasoning`,
        64,
      ),
      durationMs: expectCount(actual.durationMs, `${path}.actual.durationMs`),
      outputChars: expectCount(
        actual.outputChars,
        `${path}.actual.outputChars`,
      ),
    },
    candidate,
    error: expectNullable(
      obj.error,
      `${path}.error`,
      (value, at) => expectString(value, at, MAX_ERROR_CHARS),
    ),
  };
}
