/**
 * The text-free shape of a native review result the strict parser refused
 * (the line itself: `native-review-shape-line.ts`).
 *
 * It re-reads the refused text with the parser's own markers, strict JSON
 * parser and deterministic rewrites, in the parser's order, and keeps only
 * closed codes, booleans and counts. It runs after the malformed category is
 * fixed and never changes the classification, the rewrites, the outcome or
 * the charge; the reviewer prints its line and swallows any failure.
 */
import { type ParseIssue, RecordParseError } from "../contracts/validation.ts";
import {
  JsonSyntaxError,
  parseJsonStrict,
  StrictJsonParser,
} from "./journal-json.ts";
import { utf8Length } from "./journal-text.ts";
import {
  envelopeRecoveryCandidates,
  repairedEnvelopeJson,
} from "./native-review-envelope-repair.ts";
import {
  NATIVE_REVIEW_CLOSE as CLOSE,
  NATIVE_REVIEW_OPEN as OPEN,
  type NativeReviewRejectionCategoryV1,
} from "./native-review-result.ts";
import {
  MAX_SHAPE_COUNT,
  parseReviewResultShape,
  REVIEW_RESULT_SHAPE_EVENT,
  type ReviewResultShapeFactsV1,
  SHAPE_ISSUES,
} from "./native-review-shape-line.ts";

type Facts = ReviewResultShapeFactsV1;

/** The strict parser's fixed messages (`journal-json.ts`) and their codes. */
const SYNTAX_BY_MESSAGE: ReadonlyMap<string, Facts["syntax"]> = new Map([
  ["unexpected end of input", "unexpected_end"],
  ["unexpected trailing content", "trailing_content"],
  ["expected JSON value", "expected_value"],
  ["expected object key", "expected_key"],
  ['expected ":"', "expected_colon"],
  ["duplicate object key", "duplicate_key"],
  ["expected comma or closing brace", "expected_comma_or_brace"],
  ["expected comma or closing bracket", "expected_comma_or_bracket"],
  ["unterminated string", "unterminated_string"],
  ["unterminated escape", "unterminated_escape"],
  ["invalid unicode escape", "invalid_unicode_escape"],
  ["invalid string escape", "invalid_escape"],
  ["unescaped control character in string", "control_character"],
  ["invalid number", "invalid_number"],
  ["invalid literal", "invalid_literal"],
]);

/** Fixed parser issue paths and their fixed field names. */
const FIELD_BY_PATH: ReadonlyMap<string, Facts["field"]> = new Map([
  ["$", "root"],
  ["$.binding", "binding"],
  ["$.result", "result"],
  ["$.binding.head", "head"],
  ["$.binding.base", "base"],
  ["$.binding.snapshotDigest", "snapshotDigest"],
  ["$.binding.taskDigest", "taskDigest"],
  ["$.verdict", "verdict"],
  ["$.summary", "summary"],
  ["$.findings", "findings"],
  ["$.taskAcceptance", "taskAcceptance"],
  ["$.taskAcceptance.issueNumber", "acceptanceIssueNumber"],
  ["$.taskAcceptance.taskDigest", "acceptanceTaskDigest"],
  ["$.taskAcceptance.verdict", "acceptanceVerdict"],
  ["$.taskAcceptance.evidence", "acceptanceEvidence"],
]);

const FINDING_FIELDS: ReadonlyMap<string, Facts["field"]> = new Map([
  ["priority", "priority"],
  ["title", "title"],
  ["body", "body"],
  ["path", "path"],
  ["lineStart", "lineStart"],
  ["lineEnd", "lineEnd"],
]);

/** One finding record or field; only the index and the fixed name are read. */
const FINDING_PATH =
  /^\$\.findings\[(\d{1,6})\](?:\.(priority|title|body|path|lineStart|lineEnd))?$/;
const EVIDENCE_ITEM_PATH = /^\$\.taskAcceptance\.evidence\[\d{1,6}\]$/;

/** Stages whose refusal is a strict schema issue of the parsed JSON. */
const SCHEMA_STAGES: ReadonlySet<Facts["stage"]> = new Set([
  "envelope_shape",
  "binding_shape",
  "binding_mismatch",
  "result_shape",
  "native_findings",
]);

const count = (value: number) => Math.min(Math.max(0, value), MAX_SHAPE_COUNT);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The marker refusal `parseNativeReviewResult` applies, in its order. */
function markerStage(text: string): Facts["stage"] | null {
  if (!text.startsWith(OPEN)) {
    return text.includes(OPEN) ? "open_marker_not_first" : "open_marker_absent";
  }
  const end = text.indexOf(CLOSE);
  if (end < 0) return "close_marker_absent";
  if (text.indexOf(OPEN, OPEN.length) >= 0) return "open_marker_repeated";
  if (text.indexOf(CLOSE, end + CLOSE.length) >= 0) {
    return "close_marker_repeated";
  }
  return null;
}

function stageOf(
  text: string,
  error: unknown,
  category: NativeReviewRejectionCategoryV1,
): Facts["stage"] {
  if (!(error instanceof RecordParseError)) return "exception";
  const marker = markerStage(text);
  if (marker !== null) return marker;
  const rejected = category.startsWith("recovered_")
    ? category.slice("recovered_".length)
    : category;
  if (rejected === "json_syntax") return "json_syntax";
  if (rejected === "bound_exceeded") return "other";
  if (rejected === "native_envelope") return "envelope_shape";
  if (rejected === "native_findings") return "native_findings";
  if (rejected === "native_binding") {
    const issue = error.issues[0];
    return issue?.path === "$.binding" && issue.code === "invalid_value"
      ? "binding_mismatch"
      : "binding_shape";
  }
  // Every other category is the strict result parser's own.
  return "result_shape";
}

function fieldOf(path: string): Facts["field"] {
  const exact = FIELD_BY_PATH.get(path);
  if (exact !== undefined) return exact;
  const finding = FINDING_PATH.exec(path);
  if (finding !== null) {
    return finding[2] === undefined
      ? "finding"
      : FINDING_FIELDS.get(finding[2]) ?? "other";
  }
  if (EVIDENCE_ITEM_PATH.test(path)) return "acceptanceEvidence";
  // An unknown acceptance key is reflected into its path: never echo it.
  if (path.startsWith("$.taskAcceptance.")) return "taskAcceptance";
  return "other";
}

function issueOf(issue: ParseIssue): Facts["issue"] {
  return (SHAPE_ISSUES as readonly string[]).includes(issue.code)
    ? issue.code as Facts["issue"]
    : "other";
}

function findingCount(value: unknown): number {
  const result = isRecord(value) ? value.result : undefined;
  const findings = isRecord(result) ? result.findings : undefined;
  return Array.isArray(findings) ? findings.length : 0;
}

/**
 * Findings accepted before the refusal: the failing finding's index, or every
 * finding for a refusal the result parser raises after the findings parsed
 * (duplicates, verdict cardinality, task acceptance, native findings).
 */
function findingsParsed(
  stage: Facts["stage"],
  issue: ParseIssue | undefined,
  value: unknown,
): number {
  if (stage === "native_findings") return findingCount(value);
  if (stage !== "result_shape" || issue === undefined) return 0;
  const finding = FINDING_PATH.exec(issue.path);
  if (finding !== null) return Number(finding[1]);
  if (
    (issue.path === "$.findings" && issue.code === "invalid_array") ||
    (issue.path === "$" && issue.code === "invalid_value") ||
    issue.path === "$.taskAcceptance" ||
    issue.path.startsWith("$.taskAcceptance.")
  ) return findingCount(value);
  return 0;
}

type Read =
  | { ok: true; value: unknown }
  | { ok: false; syntax: Facts["syntax"]; offset: Facts["syntaxOffset"] };

/** One strict parse; a refusal keeps only its fixed code and offset class. */
function strictRead(text: string): Read {
  const parser = new StrictJsonParser(text);
  try {
    return { ok: true, value: parser.parse() };
  } catch (error) {
    return {
      ok: false,
      syntax: error instanceof JsonSyntaxError
        ? SYNTAX_BY_MESSAGE.get(error.message) ?? "other"
        : "other",
      offset: offsetClass(text, parser.position),
    };
  }
}

function offsetClass(text: string, at: number): Facts["syntaxOffset"] {
  if (at >= text.length) return "end";
  const bytes = utf8Length(text.slice(0, at));
  if (bytes < 64) return "lt64";
  if (bytes < 256) return "lt256";
  if (bytes < 1024) return "lt1024";
  if (bytes < 4096) return "lt4096";
  if (bytes < 16384) return "lt16384";
  return "ge16384";
}

type BodyFacts =
  & Pick<
    Facts,
    | "syntax"
    | "syntaxOffset"
    | "repair"
    | "repairSyntax"
    | "repairOffset"
    | "layer"
  >
  & { value: unknown };

const NO_BODY: BodyFacts = {
  syntax: "none",
  syntaxOffset: "none",
  repair: "none",
  repairSyntax: "none",
  repairOffset: "none",
  layer: "none",
  value: undefined,
};

/**
 * The body's strict parse and, when it refused, each deterministic rewrite
 * `expectEnvelopeJson` tries; `value` is what that parser obtained.
 */
function bodyFacts(body: string | null): BodyFacts {
  if (body === null) return NO_BODY;
  const strict = strictRead(body);
  if (strict.ok) return { ...NO_BODY, value: strict.value };
  const facts: BodyFacts = {
    ...NO_BODY,
    syntax: strict.syntax,
    syntaxOffset: strict.offset,
    layer: "absent",
  };
  const structural = repairedEnvelopeJson(body);
  if (structural === null) facts.repair = "ambiguous";
  else if (structural === body) facts.repair = "unchanged";
  else {
    const rewritten = strictRead(structural);
    facts.repair = rewritten.ok ? "parsed" : "refused";
    if (!rewritten.ok) {
      facts.repairSyntax = rewritten.syntax;
      facts.repairOffset = rewritten.offset;
    }
  }
  // An escaped layer and its rewrite are the other candidates (their quotes
  // are unescaped where the structural rewrite keeps `\"`).
  for (const candidate of envelopeRecoveryCandidates(body)) {
    let value: unknown;
    try {
      value = parseJsonStrict(candidate);
    } catch {
      if (candidate !== structural && facts.layer === "absent") {
        facts.layer = "refused";
      }
      continue;
    }
    if (candidate !== structural) facts.layer = "parsed";
    if (facts.value === undefined) facts.value = value;
  }
  return facts;
}

/** The last characters that name their own end class. */
const END_BY_CHAR: ReadonlyMap<string, Facts["bodyEnd"]> = new Map([
  ["}", "object_close"],
  ["]", "array_close"],
  ['"', "string"],
  [",", "comma"],
  [":", "colon"],
  ["{", "open"],
  ["[", "open"],
]);

/** The class of the last character of `scope` that is not JSON whitespace. */
function lastTokenClass(scope: string): Facts["bodyEnd"] {
  let at = scope.length - 1;
  while (at >= 0 && " \t\n\r".includes(scope[at])) at--;
  if (at < 0) return "none";
  const char = scope[at];
  const known = END_BY_CHAR.get(char);
  if (known !== undefined) return known;
  if (char >= "0" && char <= "9") return "digit";
  return /^[A-Za-z]$/.test(char) ? "letter" : "other";
}

/**
 * Top-level `{` objects of `scope`, skipping JSON strings inside containers;
 * outside a string a backslash and its next character are skipped, so an
 * escaped layer (`{\"a\":1}`) scans by its structure. The scan's end state is
 * the containers still open and the class of the scope's last token.
 */
function topLevelObjects(
  scope: string,
): Pick<Facts, "jsonCandidates" | "braces" | "openContainers" | "bodyEnd"> {
  let depth = 0;
  let objects = 0;
  let inString = false;
  let stray = false;
  for (let index = 0; index < scope.length; index++) {
    const char = scope[index];
    if (char === "\\") {
      index++;
      continue;
    }
    if (inString) {
      if (char === '"') inString = false;
    } else if (char === '"') inString = depth > 0;
    else if (char === "{" || char === "[") {
      if (depth === 0 && char === "{") objects++;
      depth++;
    } else if (char === "}" || char === "]") {
      if (depth === 0) stray = true;
      else depth--;
    }
  }
  return {
    jsonCandidates: count(objects),
    braces: stray
      ? "stray_close"
      : depth > 0 || inString
      ? "unclosed"
      : "balanced",
    openContainers: count(depth),
    bodyEnd: inString ? "in_string" : lastTokenClass(scope),
  };
}

function textStart(text: string): Facts["textStart"] {
  if (text.length === 0) return "empty";
  if (text.startsWith(OPEN)) return "marker";
  if (text.startsWith("```")) return "fence";
  if (text[0] === "{") return "brace";
  return /^\s/.test(text) ? "whitespace" : "other";
}

function occurrences(text: string, marker: string): number {
  let found = 0;
  for (
    let at = text.indexOf(marker);
    at >= 0;
    at = text.indexOf(marker, at + marker.length)
  ) found++;
  return count(found);
}

/** The shape facts of one refused final message (no text survives). */
export function nativeReviewResultShape(
  text: string,
  error: unknown,
  category: NativeReviewRejectionCategoryV1,
): ReviewResultShapeFactsV1 {
  const stage = stageOf(text, error, category);
  const openAt = text.indexOf(OPEN);
  const closeAt = openAt < 0 ? -1 : text.indexOf(CLOSE, openAt + OPEN.length);
  const body = closeAt < 0 ? null : text.slice(openAt + OPEN.length, closeAt);
  const read = bodyFacts(body);
  const issue = error instanceof RecordParseError ? error.issues[0] : undefined;
  const schema = SCHEMA_STAGES.has(stage) && issue !== undefined;
  const { value: _value, ...syntax } = read;
  return {
    stage,
    recovered: category.startsWith("recovered_"),
    issue: schema ? issueOf(issue) : "none",
    field: schema ? fieldOf(issue.path) : "none",
    findingsParsed: count(findingsParsed(stage, issue, read.value)),
    messageBytes: count(utf8Length(text)),
    textStart: textStart(text),
    openMarkers: occurrences(text, OPEN),
    closeMarkers: occurrences(text, CLOSE),
    prefixBytes: openAt < 0 ? 0 : count(utf8Length(text.slice(0, openAt))),
    bodyBytes: body === null ? 0 : count(utf8Length(body)),
    suffixBytes: closeAt < 0
      ? 0
      : count(utf8Length(text.slice(closeAt + CLOSE.length))),
    ...topLevelObjects(body ?? text),
    ...syntax,
  };
}

/** The validated line for `facts`, or null when it would not re-parse. */
export function reviewResultShapeLine(
  ids: { ownerRunId: string; requestId: string; invocationId: string },
  facts: ReviewResultShapeFactsV1,
): string | null {
  const line = parseReviewResultShape({
    event: REVIEW_RESULT_SHAPE_EVENT,
    ownerRunId: ids.ownerRunId,
    requestId: ids.requestId,
    invocationId: ids.invocationId,
    ...facts,
  });
  return line === null ? null : JSON.stringify(line);
}
