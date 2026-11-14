/**
 * The text-free shape line of a malformed native review result (2026-11-14).
 *
 * A completed native review whose result the strict parser refuses is
 * recorded `malformed [<category>]` and charged again on the same head; the
 * category names only the first refusing check. Four of fifteen charged
 * reviews failed that way in one day, and nothing said which parse or repair
 * stage failed or what the output looked like. This line says so without the
 * restricted review text: every value is a closed code from the lists below,
 * a boolean or a bounded non-negative integer (lengths, counts and one finding
 * index). The three ids are the run's own bounded identifiers the review
 * terminal line already carries; no substring, digest or field value of the
 * review output is ever part of it.
 *
 * The line has no `status` property (the launcher's child-status scan never
 * reads it) and no `kind` (no job-log evidence scanner reads it). It is
 * advisory only: nothing reads it back as evidence. The launcher re-emits it
 * through `parseReviewResultShape`, which rebuilds a record field by field
 * from these lists, so nothing else a child prints is echoed.
 */
import type { ParseIssueCode } from "../contracts/validation.ts";

export const REVIEW_RESULT_SHAPE_EVENT = "sentinel_review_result_shape";

/** Where the result was refused, in the strict parser's own order. */
export const SHAPE_STAGES = [
  "open_marker_absent",
  "open_marker_not_first",
  "open_marker_repeated",
  "close_marker_absent",
  "close_marker_repeated",
  "json_syntax",
  "envelope_shape",
  "binding_shape",
  "binding_mismatch",
  "result_shape",
  "native_findings",
  "exception",
  "other",
] as const;

/** The first strict schema issue's existing code, after the JSON parsed. */
export const SHAPE_ISSUES = [
  "none",
  "unknown_key",
  "missing_field",
  "wrong_type",
  "invalid_enum",
  "invalid_version",
  "invalid_sha",
  "invalid_digest",
  "invalid_pattern",
  "bound_exceeded",
  "invalid_number",
  "invalid_timestamp",
  "invalid_count",
  "invalid_boolean",
  "invalid_nullability",
  "invalid_base64",
  "invalid_lifecycle",
  "invalid_array",
  "invalid_value",
  "other",
] as const satisfies readonly (ParseIssueCode | "none" | "other")[];

/**
 * The fixed field that issue names. `root` is the envelope (or, at the result
 * stage, the result) object itself; a key name the model chose is never one.
 */
export const SHAPE_FIELDS = [
  "none",
  "root",
  "binding",
  "result",
  "head",
  "base",
  "snapshotDigest",
  "taskDigest",
  "verdict",
  "summary",
  "findings",
  "finding",
  "priority",
  "title",
  "body",
  "path",
  "lineStart",
  "lineEnd",
  "taskAcceptance",
  "acceptanceIssueNumber",
  "acceptanceTaskDigest",
  "acceptanceVerdict",
  "acceptanceEvidence",
  "other",
] as const;

/** The strict JSON parser's refusal of a text, by its fixed message. */
export const SHAPE_SYNTAX = [
  "none",
  "unexpected_end",
  "trailing_content",
  "expected_value",
  "expected_key",
  "expected_colon",
  "duplicate_key",
  "expected_comma_or_brace",
  "expected_comma_or_bracket",
  "unterminated_string",
  "unterminated_escape",
  "invalid_unicode_escape",
  "invalid_escape",
  "control_character",
  "invalid_number",
  "invalid_literal",
  "other",
] as const;

/** Coarse UTF-8 byte offset of that refusal; `end` is the end of the text. */
export const SHAPE_OFFSETS = [
  "none",
  "end",
  "lt64",
  "lt256",
  "lt1024",
  "lt4096",
  "lt16384",
  "ge16384",
] as const;

/** The structural rewrite of a body the strict parser refused. */
export const SHAPE_REPAIRS = [
  "none",
  "unchanged",
  "ambiguous",
  "refused",
  "parsed",
] as const;

/** The escaped-layer rewrites of that body. */
export const SHAPE_LAYERS = ["none", "absent", "refused", "parsed"] as const;

/** The final message's first characters. */
export const SHAPE_STARTS = [
  "empty",
  "marker",
  "brace",
  "fence",
  "whitespace",
  "other",
] as const;

/** End state of the top-level object scan. */
export const SHAPE_BRACES = ["balanced", "unclosed", "stray_close"] as const;

/** Every count, length and index the line carries is at most this. */
export const MAX_SHAPE_COUNT = 1_000_000;

export interface ReviewResultShapeFactsV1 {
  stage: typeof SHAPE_STAGES[number];
  /** A deterministic rewrite parsed the body (the `recovered_` category). */
  recovered: boolean;
  issue: typeof SHAPE_ISSUES[number];
  field: typeof SHAPE_FIELDS[number];
  /** Findings the strict result parser accepted before it refused. */
  findingsParsed: number;
  messageBytes: number;
  textStart: typeof SHAPE_STARTS[number];
  openMarkers: number;
  closeMarkers: number;
  /** Bytes before the first open marker. */
  prefixBytes: number;
  /** Bytes between it and the next close marker (the envelope body). */
  bodyBytes: number;
  /** Bytes after that close marker (the native findings, or a wrapper). */
  suffixBytes: number;
  /** Top-level `{` objects in the body (the whole text when it has none). */
  jsonCandidates: number;
  braces: typeof SHAPE_BRACES[number];
  /** The strict parse of the body as written. */
  syntax: typeof SHAPE_SYNTAX[number];
  syntaxOffset: typeof SHAPE_OFFSETS[number];
  repair: typeof SHAPE_REPAIRS[number];
  /** The strict parse of the refused structural rewrite. */
  repairSyntax: typeof SHAPE_SYNTAX[number];
  repairOffset: typeof SHAPE_OFFSETS[number];
  layer: typeof SHAPE_LAYERS[number];
}

export interface ReviewResultShapeV1 extends ReviewResultShapeFactsV1 {
  event: typeof REVIEW_RESULT_SHAPE_EVENT;
  ownerRunId: string;
  requestId: string;
  invocationId: string;
}

const IDS = ["ownerRunId", "requestId", "invocationId"] as const;
const FLAGS = ["recovered"] as const;
const CODES: Readonly<Record<string, readonly string[]>> = {
  stage: SHAPE_STAGES,
  issue: SHAPE_ISSUES,
  field: SHAPE_FIELDS,
  textStart: SHAPE_STARTS,
  braces: SHAPE_BRACES,
  syntax: SHAPE_SYNTAX,
  syntaxOffset: SHAPE_OFFSETS,
  repair: SHAPE_REPAIRS,
  repairSyntax: SHAPE_SYNTAX,
  repairOffset: SHAPE_OFFSETS,
  layer: SHAPE_LAYERS,
};
const COUNTS = [
  "findingsParsed",
  "messageBytes",
  "openMarkers",
  "closeMarkers",
  "prefixBytes",
  "bodyBytes",
  "suffixBytes",
  "jsonCandidates",
] as const;

/** The printed key order. */
const KEYS: readonly string[] = [
  "event",
  ...IDS,
  "stage",
  ...FLAGS,
  "issue",
  "field",
  "findingsParsed",
  "messageBytes",
  "textStart",
  "openMarkers",
  "closeMarkers",
  "prefixBytes",
  "bodyBytes",
  "suffixBytes",
  "jsonCandidates",
  "braces",
  "syntax",
  "syntaxOffset",
  "repair",
  "repairSyntax",
  "repairOffset",
  "layer",
];

/** The review terminal line's bounded identifier shape. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * The strictly re-parsed line, or null: the exact key set, the event, bounded
 * ids, a closed code for every code field, a boolean flag and bounded
 * non-negative integers. The result is rebuilt in the fixed key order.
 */
export function parseReviewResultShape(
  value: unknown,
): ReviewResultShapeV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== KEYS.length ||
    !KEYS.every((key) => Object.hasOwn(record, key)) ||
    record.event !== REVIEW_RESULT_SHAPE_EVENT
  ) return null;
  for (const key of IDS) {
    const id = record[key];
    if (typeof id !== "string" || !ID.test(id)) return null;
  }
  for (const [key, allowed] of Object.entries(CODES)) {
    const code = record[key];
    if (typeof code !== "string" || !allowed.includes(code)) return null;
  }
  for (const key of FLAGS) {
    if (typeof record[key] !== "boolean") return null;
  }
  for (const key of COUNTS) {
    const count = record[key];
    if (
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 0 ||
      count > MAX_SHAPE_COUNT
    ) return null;
  }
  return Object.fromEntries(
    KEYS.map((key) => [key, record[key]]),
  ) as unknown as ReviewResultShapeV1;
}
