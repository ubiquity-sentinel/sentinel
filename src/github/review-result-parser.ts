// review result parser.

import {
  expectArray,
  expectEnum,
  expectExactKeys,
  expectExactKeysWithOptional,
  expectNullable,
  expectPositiveInt,
  expectRecord,
  fail,
  RecordParseError,
} from "../contracts/validation.ts";
import { parseReviewTaskAcceptance } from "../contracts/review-receipt.ts";
import { canonicalStringifySha256 } from "../contracts/canonical.ts";
import {
  CLEAN_FINDINGS_ISSUE_MESSAGE,
  FINDING_KEYS,
  FINDING_RANGE_ISSUE_MESSAGE,
  type FindingPriorityV1,
  FINDINGS_DUPLICATE_ISSUE_MESSAGE,
  FINDINGS_EMPTY_ISSUE_MESSAGE,
  MAX_FINDING_BODY,
  MAX_FINDING_MESSAGE,
  MAX_FINDING_TITLE,
  MAX_FINDINGS,
  MAX_JOURNAL_BYTES,
  MAX_RESULT_SUMMARY,
  RESULT_KEYS,
  RESULT_OPTIONAL_KEYS,
  type ReviewFindingV1,
  type ReviewResultV1,
  STRICT_JSON_ISSUE_MESSAGE,
  UNAVAILABLE_FINDINGS_ISSUE_MESSAGE,
} from "./review-result-contracts.ts";
import {
  expectHumanText,
  expectMultilineText,
  expectSingleLineText,
  parseReviewPath,
  utf8Length,
} from "./journal-text.ts";
import { expectStrictJson } from "./journal-json.ts";

/**
 * Narrow exact-key guard used at every journal/result boundary. The global
 * validator reflects an unknown key name into the issue path and therefore
 * into the error message; this local guard rejects unknown keys first with
 * the fixed schema path and a static message, so a hostile unknown key is
 * never echoed into diagnostics. Missing-field diagnosis is delegated to the
 * global validator unchanged.
 */
export function expectJournalExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      fail(path, "unknown_key", "unknown key");
    }
  }
  expectExactKeys(obj, allowed, path);
}

/**
 * Same fixed-path unknown-key rejection as `expectJournalExactKeys`, with the
 * additive optional-key shape: required keys must exist, listed optional keys
 * may be absent, and every other key is rejected with the static path/message.
 */
export function expectJournalExactKeysWithOptional(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      fail(path, "unknown_key", "unknown key");
    }
  }
  expectExactKeysWithOptional(obj, required, optional, path);
}

/** Required location text of one finding (`path:lineStart-lineEnd`). */
export function findingLocation(finding: ReviewFindingV1): string {
  return `${finding.path}:${finding.lineStart}-${finding.lineEnd}`;
}

/** Complete normalized finding message (title + full body + location). */
export function findingMessage(finding: ReviewFindingV1): string {
  return `${finding.title}\n\n${finding.body}\n\n${findingLocation(finding)}`;
}

/**
 * Parse the strict structured result from an already-parsed value. Throws
 * `RecordParseError`; a `bound_exceeded` issue is the unavailable disposition
 * (see `isJournalBoundExceeded`).
 */
export function parseReviewResultV1(input: unknown): ReviewResultV1 {
  const obj = expectRecord(input, "$");
  expectJournalExactKeysWithOptional(
    obj,
    RESULT_KEYS,
    RESULT_OPTIONAL_KEYS,
    "$",
  );
  const verdict = expectEnum(
    obj.verdict,
    ["clean", "findings", "unavailable"],
    "$.verdict",
  );
  const summary = expectHumanText(obj.summary, "$.summary", MAX_RESULT_SUMMARY);
  if (summary.length === 0) {
    fail("$.summary", "invalid_pattern", "expected non-empty summary");
  }
  const findings = expectArray(
    obj.findings,
    "$.findings",
    MAX_FINDINGS,
    parseFinding,
  );
  if (verdict === "clean" && findings.length !== 0) {
    fail("$", "invalid_value", CLEAN_FINDINGS_ISSUE_MESSAGE);
  }
  if (verdict === "findings" && findings.length === 0) {
    fail("$", "invalid_value", FINDINGS_EMPTY_ISSUE_MESSAGE);
  }
  if (verdict === "unavailable" && findings.length !== 0) {
    fail("$", "invalid_value", UNAVAILABLE_FINDINGS_ISSUE_MESSAGE);
  }
  const seen = new Set<string>();
  for (const finding of findings) {
    const key = findingKey(finding);
    if (seen.has(key)) {
      fail("$.findings", "invalid_array", FINDINGS_DUPLICATE_ISSUE_MESSAGE);
    }
    seen.add(key);
  }
  // An absent key (a result written before this boundary) stays ABSENT, so the
  // canonical form of the parsed result is byte-identical to what an older
  // writer digested and rendered: old journals stay readable and verifiable.
  // A present value must be the strict bounded acceptance. Absence is treated
  // as "no acceptance" by every consumer and can never authorize an
  // issue-backed delivery.
  const taskAcceptance = obj.taskAcceptance === undefined
    ? undefined
    : expectNullable(
      obj.taskAcceptance,
      "$.taskAcceptance",
      parseReviewTaskAcceptance,
    );
  // Only a completed structured verdict can carry a task acceptance: an
  // unavailable result claiming one would be completion evidence without a
  // completed review.
  if (verdict === "unavailable" && taskAcceptance != null) {
    fail(
      "$.taskAcceptance",
      "invalid_lifecycle",
      "an unavailable verdict cannot carry a task acceptance",
    );
  }
  return taskAcceptance === undefined
    ? { verdict, summary, findings }
    : { verdict, summary, findings, taskAcceptance };
}

export function parseFinding(input: unknown, path: string): ReviewFindingV1 {
  const obj = expectRecord(input, path);
  expectJournalExactKeys(obj, FINDING_KEYS, path);
  const priority = parsePriority(obj.priority, `${path}.priority`);
  const title = expectSingleLineText(
    obj.title,
    `${path}.title`,
    MAX_FINDING_TITLE,
  );
  if (title.length === 0) {
    fail(`${path}.title`, "invalid_pattern", "expected non-empty title");
  }
  const body = expectMultilineText(obj.body, `${path}.body`, MAX_FINDING_BODY);
  const pathText = parseReviewPath(obj.path, `${path}.path`);
  const lineStart = expectPositiveInt(obj.lineStart, `${path}.lineStart`);
  const lineEnd = expectPositiveInt(obj.lineEnd, `${path}.lineEnd`);
  if (lineEnd < lineStart) {
    fail(
      `${path}.lineEnd`,
      "invalid_value",
      FINDING_RANGE_ISSUE_MESSAGE,
    );
  }
  const finding: ReviewFindingV1 = {
    priority,
    title,
    body,
    path: pathText,
    lineStart,
    lineEnd,
  };
  if (findingMessage(finding).length > MAX_FINDING_MESSAGE) {
    fail(
      path,
      "bound_exceeded",
      `finding message exceeds ${MAX_FINDING_MESSAGE}`,
    );
  }
  return finding;
}

export function parsePriority(value: unknown, path: string): FindingPriorityV1 {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(path, "invalid_enum", "expected one of 0, 1, 2, 3");
  }
  if (value < 0 || value > 3) {
    fail(path, "invalid_enum", "expected one of 0, 1, 2, 3");
  }
  return value as FindingPriorityV1;
}

export function findingKey(finding: ReviewFindingV1): string {
  return [
    String(finding.priority),
    finding.title,
    finding.body,
    finding.path,
    String(finding.lineStart),
    String(finding.lineEnd),
  ].join("\u0000");
}

/**
 * Parse the strict structured result from its exact JSON text (the model
 * output). Rejects prose, fences, trailing content, truncated JSON and
 * duplicate object keys; the text itself is never echoed.
 */
export function parseReviewResultJson(text: string): ReviewResultV1 {
  if (utf8Length(text) > MAX_JOURNAL_BYTES) {
    fail(
      "$",
      "bound_exceeded",
      `result JSON exceeds ${MAX_JOURNAL_BYTES} bytes`,
    );
  }
  const value = expectStrictJson(text, "$");
  return parseReviewResultV1(value);
}

/** Canonical SHA-256 digest over the structured result. */
export function reviewResultDigest(result: ReviewResultV1): Promise<string> {
  return canonicalStringifySha256(result);
}

/**
 * Fixed sanitized rejection categories for a structured result the strict
 * parser refused. A category is derived ONLY from the first existing
 * `RecordParseError` issue: its existing `ParseIssueCode`, its fixed parser
 * path and its existing static message are matched against closed literals.
 * A fixed path pattern may recognize a numeric finding index internally, but
 * only the constant category literal leaves this function. No parser message,
 * path, index, model text or stack is ever surfaced, and an unrecognized
 * failure stays the generic `unknown` category.
 */
export type ReviewResultRejectionCategoryV1 =
  | "bound_exceeded"
  | "json_syntax"
  | "result_keys"
  | "root_shape"
  | "summary"
  | "verdict"
  | "findings_shape"
  | "findings_cardinality"
  | "findings_duplicate"
  | "finding_priority"
  | "finding_title"
  | "finding_body"
  | "finding_path"
  | "finding_range"
  | "unknown";

/** Fixed parser paths of one finding field; the index is never returned. */
export const FINDING_FIELD_ISSUE_PATH =
  /^\$\.findings\[\d+\]\.(priority|title|body|path|lineStart|lineEnd)$/;

/** Fixed parser path of one finding record; the index is never returned. */
export const FINDING_RECORD_ISSUE_PATH = /^\$\.findings\[\d+\]$/;

/** Fixed parser path of the top-level findings array. */
export const FINDINGS_ISSUE_PATH = "$.findings";

/** Fixed top-level result field paths and their constant categories. */
export const RESULT_FIELD_CATEGORIES = new Map<
  string,
  ReviewResultRejectionCategoryV1
>(
  [
    ["$.summary", "summary"],
    ["$.verdict", "verdict"],
  ],
);

/** Exact verdict/findings cardinality messages the parser throws. */
export const CARDINALITY_ISSUE_MESSAGES: readonly string[] = [
  CLEAN_FINDINGS_ISSUE_MESSAGE,
  FINDINGS_EMPTY_ISSUE_MESSAGE,
  UNAVAILABLE_FINDINGS_ISSUE_MESSAGE,
];

/**
 * Classify one rejected structured result. `bound_exceeded` keeps its own
 * category so the producer retains its existing bound disposition, and
 * `json_syntax` separates a strict-JSON failure from a field-shape failure.
 * The remaining categories name the first rejected location: the result key
 * set or root shape, the summary or verdict field, the findings array shape,
 * cardinality or duplicates, or one finding field (priority, title, body,
 * path or line range). An unrecognized issue stays `unknown`.
 */
export function classifyReviewResultRejection(
  error: unknown,
): ReviewResultRejectionCategoryV1 {
  if (!(error instanceof RecordParseError)) return "unknown";
  const issue = error.issues[0];
  if (issue === undefined) return "unknown";
  if (issue.code === "bound_exceeded") return "bound_exceeded";
  if (issue.path === "$") {
    if (issue.code === "invalid_value") {
      if (issue.message === STRICT_JSON_ISSUE_MESSAGE) return "json_syntax";
      if (CARDINALITY_ISSUE_MESSAGES.includes(issue.message)) {
        return "findings_cardinality";
      }
      return "unknown";
    }
    if (issue.code === "unknown_key") return "result_keys";
    if (issue.code === "wrong_type") return "root_shape";
    return "unknown";
  }
  const resultField = RESULT_FIELD_CATEGORIES.get(issue.path);
  if (resultField !== undefined) return resultField;
  if (issue.path === FINDINGS_ISSUE_PATH) {
    return issue.code === "invalid_array" &&
        issue.message === FINDINGS_DUPLICATE_ISSUE_MESSAGE
      ? "findings_duplicate"
      : "findings_shape";
  }
  const findingField = FINDING_FIELD_ISSUE_PATH.exec(issue.path);
  if (findingField !== null) {
    switch (findingField[1]) {
      case "priority":
        return "finding_priority";
      case "title":
        return "finding_title";
      case "body":
        return "finding_body";
      case "path":
        return "finding_path";
      case "lineStart":
      case "lineEnd":
        return "finding_range";
    }
  }
  if (FINDING_RECORD_ISSUE_PATH.test(issue.path)) return "findings_shape";
  return "unknown";
}
