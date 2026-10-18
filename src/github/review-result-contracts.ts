// review result contracts.

import { MaxItems, MaxText } from "../contracts/validation.ts";
import {
  MAX_TASK_ACCEPTANCE_EVIDENCE,
  MAX_TASK_ACCEPTANCE_EVIDENCE_CHARS,
  type ReviewTaskAcceptanceV1,
  type ReviewTaskStatementV1,
} from "../contracts/review-receipt.ts";

// ---------------------------------------------------------------------------
// Bounds and frozen runtime identity
// ---------------------------------------------------------------------------

/** Structured result summary bound (chars). */
export const MAX_RESULT_SUMMARY = MaxText.summary;

/** Individual finding title bound (chars; multiline titles are rejected). */
export const MAX_FINDING_TITLE = MaxText.message;

/** Individual finding body bound (chars; full multiline body preserved). */
export const MAX_FINDING_BODY = 8192;

/** Finding path bound (chars). */
export const MAX_FINDING_PATH = MaxText.path;

/** Combined normalized finding message (title + full body + location). */
export const MAX_FINDING_MESSAGE = 8192;

/** One finite maximum finding count (never greater than 256). */
export const MAX_FINDINGS = MaxItems.findings;

/** Full rendered journal bound in UTF-8 bytes; overflow is unavailable. */
export const MAX_JOURNAL_BYTES = 60_000;

/** Runtime implementation model (frozen; no fallback). */
export const REVIEW_MODEL = "gpt-reserve";

/** Runtime reasoning effort (frozen). */
export const REVIEW_REASONING = "max";

// ---------------------------------------------------------------------------
// Structured model result
// ---------------------------------------------------------------------------

export type ReviewVerdictV1 = "clean" | "findings" | "unavailable";

export type FindingPriorityV1 = 0 | 1 | 2 | 3;

export interface ReviewFindingV1 {
  priority: FindingPriorityV1;
  title: string;
  body: string;
  path: string;
  lineStart: number;
  lineEnd: number;
}

export interface ReviewResultV1 {
  verdict: ReviewVerdictV1;
  summary: string;
  findings: ReviewFindingV1[];
  /**
   * The reviewer's positive task acceptance bound to the exact submitted
   * task statement, or null when the review was asked with a task statement
   * and the reviewer explicitly reported no acceptance.
   *
   * PRESENCE IS SEMANTIC: results written before the semantic acceptance
   * boundary omit the key entirely, and the parser preserves that absence so
   * old journals stay byte-verifiable and readable. Every consumer reads
   * `taskAcceptance ?? null`; an absent or null acceptance is "no acceptance"
   * and can never authorize an issue-backed delivery.
   */
  taskAcceptance?: ReviewTaskAcceptanceV1 | null;
}

/**
 * Fixed single-field patterns bound to the strict parsers below.
 *
 * `pattern` is the only supported keyword for the single-field text rules the
 * parser enforces (control characters and relative-path syntax); the
 * cross-field rules have no supported keyword and are pinned by the schema
 * descriptions and the reviewer's submitted instructions instead. Only
 * ordinary regular-expression constructs are used (anchors, classes, groups,
 * alternation and `*`): the official structured-output subset rejects
 * lookaround, and the parser rules need none.
 */
export const MULTILINE_TEXT_PATTERN = "^[^\\x00-\\x08\\x0B-\\x1F\\x7F]*$";

export const SINGLE_LINE_TEXT_PATTERN = "^[^\\x00-\\x1F\\x7F]*$";

/** One allowed path character: no control character, DEL, backslash or slash. */
export const PATH_CHAR = "[^\\x00-\\x1F\\x7F\\\\/]";

/** One allowed path character that is not a dot. */
export const PATH_NON_DOT_CHAR = "[^.\\x00-\\x1F\\x7F\\\\/]";

/** One nonempty path segment that is neither `.` nor `..`. */
export const PATH_SEGMENT =
  `(?:${PATH_CHAR}*${PATH_NON_DOT_CHAR}${PATH_CHAR}*|\\.\\.\\.${PATH_CHAR}*)`;

/**
 * First path segment when at least one `/` follows: any segment except the
 * `[A-Za-z]:` drive form `parseReviewPath` refuses.
 */
export const PATH_FIRST_SEGMENT_NON_DRIVE =
  `(?:${PATH_NON_DOT_CHAR}|[A-Za-z][^:\\x00-\\x1F\\x7F\\\\/]|[^A-Za-z.\\x00-\\x1F\\x7F\\\\/]${PATH_CHAR}|\\.${PATH_NON_DOT_CHAR}|${PATH_CHAR}${PATH_CHAR}${PATH_CHAR}${PATH_CHAR}*)`;

/**
 * Producer-side `pattern` for the relative-path language `parseReviewPath`
 * accepts. The schema narrows what a conforming producer emits; it is not a
 * second authority on the parser contract. Provider regex semantics may differ
 * from the declared ECMAScript pattern language around anchors (a trailing LF
 * is one known divergence: an engine can let `$` match before a final LF even
 * though `PATH_CHAR` excludes LF), and provider support for this pattern
 * (including a DeepSeek-direct route) remains unverified. The strict parser
 * stays authoritative: it still rejects a title or path ending in LF and
 * enforces the cross-field bounds this pattern cannot express.
 */
export const RELATIVE_PATH_PATTERN =
  `^(?:${PATH_SEGMENT}|${PATH_FIRST_SEGMENT_NON_DRIVE}(?:/${PATH_SEGMENT})*)$`;

/** The exact output schema bound to the structured result parsers. */
export const REVIEW_RESULT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "findings", "taskAcceptance"],
  properties: {
    verdict: {
      type: "string",
      enum: ["clean", "findings", "unavailable"],
      description:
        "clean and unavailable require an empty findings array; findings requires at least one finding.",
    },
    summary: {
      type: "string",
      minLength: 1,
      maxLength: MAX_RESULT_SUMMARY,
      pattern: MULTILINE_TEXT_PATTERN,
    },
    findings: {
      type: "array",
      maxItems: MAX_FINDINGS,
      description:
        "Every finding must be distinct, lineStart must be at most lineEnd, and lineEnd must be at most the candidate file line count.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "title", "body", "path", "lineStart", "lineEnd"],
        properties: {
          priority: { type: "integer", enum: [0, 1, 2, 3] },
          title: {
            type: "string",
            minLength: 1,
            maxLength: MAX_FINDING_TITLE,
            pattern: SINGLE_LINE_TEXT_PATTERN,
          },
          body: {
            type: "string",
            maxLength: MAX_FINDING_BODY,
            pattern: MULTILINE_TEXT_PATTERN,
          },
          path: {
            type: "string",
            minLength: 1,
            maxLength: MAX_FINDING_PATH,
            pattern: RELATIVE_PATH_PATTERN,
          },
          lineStart: { type: "integer", minimum: 1 },
          lineEnd: {
            type: "integer",
            minimum: 1,
            description: "Must be at least lineStart.",
          },
        },
      },
    },
    taskAcceptance: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["issueNumber", "taskDigest", "verdict", "evidence"],
      description:
        "Always include this property. Use null when no TASK STATEMENT section was supplied or the assessment is unavailable. Otherwise, copy its issueNumber and taskDigest verbatim and judge the exact candidate change against that task. fulfilled requires concrete evidence that the change implements the task; already_satisfied_at_base requires evidence that the base already meets it; not_fulfilled requires evidence that the change does not; uncertain requires evidence that the exact evidence is insufficient (its evidence array may be empty).",
      properties: {
        issueNumber: { type: "integer", minimum: 1 },
        taskDigest: {
          type: "string",
          minLength: 64,
          maxLength: 64,
          pattern: "^[0-9a-f]{64}$",
        },
        verdict: {
          type: "string",
          enum: [
            "fulfilled",
            "not_fulfilled",
            "already_satisfied_at_base",
            "uncertain",
          ],
        },
        evidence: {
          type: "array",
          maxItems: MAX_TASK_ACCEPTANCE_EVIDENCE,
          items: {
            type: "string",
            minLength: 1,
            maxLength: MAX_TASK_ACCEPTANCE_EVIDENCE_CHARS,
            pattern: SINGLE_LINE_TEXT_PATTERN,
          },
        },
      },
    },
  },
} as const;

/** Constrain model output to the trusted task already validated at preparation. */
export function reviewResultOutputSchema(task: ReviewTaskStatementV1 | null) {
  const schema = structuredClone(REVIEW_RESULT_OUTPUT_SCHEMA);
  if (task === null) return schema;
  const acceptance = schema.properties.taskAcceptance;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      taskAcceptance: {
        ...acceptance,
        properties: {
          ...acceptance.properties,
          issueNumber: {
            ...acceptance.properties.issueNumber,
            enum: [task.issueNumber],
          },
          taskDigest: {
            ...acceptance.properties.taskDigest,
            enum: [task.digest],
          },
        },
      },
    },
  };
}

export const RESULT_KEYS = ["verdict", "summary", "findings"] as const;

/**
 * Additive optional key: a structured result written before the semantic
 * acceptance boundary parses with `taskAcceptance: null`, which can never
 * authorize an issue-backed delivery. It is never defaulted to a verdict.
 */
export const RESULT_OPTIONAL_KEYS = ["taskAcceptance"] as const;

export const FINDING_KEYS = [
  "priority",
  "title",
  "body",
  "path",
  "lineStart",
  "lineEnd",
] as const;

/**
 * Exact static parser messages the rejection classifier distinguishes below.
 * The fail sites use these same constants, so the taxonomy cannot drift from
 * the messages actually thrown.
 */
export const STRICT_JSON_ISSUE_MESSAGE = "expected complete strict JSON";

export const FINDING_RANGE_ISSUE_MESSAGE = "line end precedes line start";

export const FINDINGS_DUPLICATE_ISSUE_MESSAGE =
  "duplicate findings are rejected";

export const CLEAN_FINDINGS_ISSUE_MESSAGE = "clean verdict carries findings";

export const FINDINGS_EMPTY_ISSUE_MESSAGE =
  "findings verdict carries no findings";

export const UNAVAILABLE_FINDINGS_ISSUE_MESSAGE =
  "unavailable verdict carries findings";
