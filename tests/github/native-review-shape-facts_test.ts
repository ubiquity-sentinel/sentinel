/**
 * The malformed-result shape facts, case by case, through the real native
 * parser and classifier: every syntax code, the coarse byte-offset classes
 * (UTF-8, not UTF-16), each rewrite outcome, the top-level object scan, and
 * the strict line parser. Synthetic texts only; no fact carries text.
 */
import assert from "node:assert/strict";
import {
  classifyNativeReviewRejection,
  NATIVE_REVIEW_CLOSE,
  NATIVE_REVIEW_OPEN,
  parseNativeReviewResult,
} from "../../src/github/native-review-result.ts";
import {
  nativeReviewResultShape,
  reviewResultShapeLine,
} from "../../src/github/native-review-shape.ts";
import {
  MAX_SHAPE_COUNT,
  parseReviewResultShape,
  type ReviewResultShapeFactsV1,
  SHAPE_BRACES,
  SHAPE_ENDS,
  SHAPE_FIELDS,
  SHAPE_ISSUES,
  SHAPE_LAYERS,
  SHAPE_OFFSETS,
  SHAPE_REPAIRS,
  SHAPE_STAGES,
  SHAPE_STARTS,
  SHAPE_SYNTAX,
} from "../../src/github/native-review-shape-line.ts";
import { SESSION_CWD, snapshotFixture } from "./codex-reviewer-helpers.ts";

const PRIVATE = "SYNTHETIC_PRIVATE_SHAPE_SENTINEL";
const snapshot = await snapshotFixture();
const IDS = {
  ownerRunId: "run-1",
  requestId: "request-1",
  invocationId: "i-1",
};
const CODES: Record<string, readonly string[]> = {
  stage: SHAPE_STAGES,
  issue: SHAPE_ISSUES,
  field: SHAPE_FIELDS,
  textStart: SHAPE_STARTS,
  braces: SHAPE_BRACES,
  bodyEnd: SHAPE_ENDS,
  syntax: SHAPE_SYNTAX,
  syntaxOffset: SHAPE_OFFSETS,
  repair: SHAPE_REPAIRS,
  repairSyntax: SHAPE_SYNTAX,
  repairOffset: SHAPE_OFFSETS,
  layer: SHAPE_LAYERS,
};

/** The facts of one text the real parser refuses; each value is closed. */
function facts(text: string): ReviewResultShapeFactsV1 {
  let refused: unknown = null;
  try {
    parseNativeReviewResult(text, snapshot, null, SESSION_CWD);
  } catch (error) {
    refused = error;
  }
  assert.notEqual(refused, null, "the parser must refuse the text");
  const shape = nativeReviewResultShape(
    text,
    refused,
    classifyNativeReviewRejection(refused),
  );
  for (const [key, value] of Object.entries(shape)) {
    if (typeof value === "string") assert.ok(CODES[key].includes(value), key);
    else if (typeof value === "number") {
      assert.ok(Number.isSafeInteger(value) && value >= 0, key);
    } else assert.equal(typeof value, "boolean", key);
  }
  assert.notEqual(reviewResultShapeLine(IDS, shape), null);
  return shape;
}

const enveloped = (body: string) =>
  NATIVE_REVIEW_OPEN + body + NATIVE_REVIEW_CLOSE;

Deno.test("shape facts: each strict syntax refusal has its own code", () => {
  const cases: [string, string, string][] = [
    ["", "unexpected_end", "end"],
    ['{"a":1} x', "trailing_content", "lt64"],
    ["x", "expected_value", "lt64"],
    ["{1:2}", "expected_key", "lt64"],
    ['{"a" 1}', "expected_colon", "lt64"],
    ['{"a":1,"a":2}', "duplicate_key", "lt64"],
    ['{"a":1 "b":2}', "expected_comma_or_brace", "lt64"],
    ["[1 2]", "expected_comma_or_bracket", "lt64"],
    ['{"a":"b', "unterminated_string", "end"],
    ['{"a":"b\\', "unterminated_escape", "end"],
    ['{"a":"\\u12"}', "invalid_unicode_escape", "lt64"],
    ['{"a":"\\q"}', "invalid_escape", "lt64"],
    ['{"a":"x\ny"}', "control_character", "lt64"],
    ['{"a":-}', "invalid_number", "lt64"],
    ['{"a":tru}', "invalid_literal", "lt64"],
  ];
  for (const [body, syntax, offset] of cases) {
    const shape = facts(enveloped(body));
    assert.equal(shape.syntax, syntax, body);
    assert.equal(shape.syntaxOffset, offset, body);
  }
});

Deno.test("shape facts: the offset class is the UTF-8 byte offset, bucketed", () => {
  const classes: [number, string][] = [
    [0, "lt64"],
    [63, "lt64"],
    [64, "lt256"],
    [255, "lt256"],
    [256, "lt1024"],
    [1023, "lt1024"],
    [1024, "lt4096"],
    [4095, "lt4096"],
    [4096, "lt16384"],
    [16383, "lt16384"],
    [16384, "ge16384"],
  ];
  for (const [at, offset] of classes) {
    const shape = facts(enveloped(" ".repeat(at) + "x"));
    assert.deepEqual([shape.syntax, shape.syntaxOffset], [
      "expected_value",
      offset,
    ], String(at));
  }
  // 46 UTF-16 units but 86 bytes before the refusal.
  const wide = facts(enveloped(`{"${"é".repeat(40)}":1 x}`));
  assert.equal(wide.syntaxOffset, "lt256");
});

Deno.test("shape facts: each deterministic rewrite outcome is reported", () => {
  // Nothing to rewrite.
  assert.deepEqual(pick(facts(enveloped("x"))), ["unchanged", "absent"]);
  // A quote inside an array element is never rewritten.
  assert.deepEqual(
    pick(facts(enveloped('{"a":["x "y" z"]}'))),
    ["ambiguous", "absent"],
  );
  // An escaped layer that parses (then fails its binding) and one that does not.
  const binding = JSON.stringify({
    head: "0".repeat(40),
    base: snapshot.base,
    snapshotDigest: snapshot.digest,
    taskDigest: null,
  });
  const layered = JSON.stringify(
    `{"binding":${binding},"result":{"verdict":"clean","summary":"${PRIVATE}","findings":[]}}`,
  ).slice(1, -1);
  // The structural rewrite reads every `\"` of a layer as a valid escape.
  const parsed = facts(enveloped(layered));
  assert.equal(parsed.stage, "binding_mismatch");
  assert.equal(parsed.recovered, true);
  assert.deepEqual(pick(parsed), ["unchanged", "parsed"]);
  assert.deepEqual([parsed.syntax, parsed.braces], [
    "expected_key",
    "balanced",
  ]);
  const refused = facts(
    enveloped(JSON.stringify('{"a":1 "b":2}').slice(1, -1)),
  );
  assert.equal(refused.stage, "json_syntax");
  assert.deepEqual(pick(refused), ["unchanged", "refused"]);
  // A rewrite that parses keeps the original refusal and no repair refusal.
  const comma = facts(enveloped('{"a":"\\q"}'));
  assert.deepEqual(
    [
      comma.stage,
      comma.recovered,
      comma.syntax,
      comma.repair,
      comma.repairSyntax,
    ],
    ["envelope_shape", true, "invalid_escape", "parsed", "none"],
  );
});

function pick(shape: ReviewResultShapeFactsV1): [string, string] {
  return [shape.repair, shape.layer];
}

Deno.test("shape facts: the object scan counts top-level objects outside strings", () => {
  const cases: [string, number, string][] = [
    ["{} {}", 2, "balanced"],
    ['{"a":{', 1, "unclosed"],
    ["}{}", 1, "stray_close"],
    ['{"a":"}}{{"}', 1, "balanced"],
    ['{\\"a\\":{\\"b\\":1}}', 1, "balanced"],
    ["no object", 0, "balanced"],
  ];
  for (const [body, candidates, braces] of cases) {
    const shape = facts(enveloped(body));
    assert.deepEqual([shape.jsonCandidates, shape.braces], [
      candidates,
      braces,
    ], body);
  }
});

Deno.test("shape facts: the scan reports the containers left open and the last token", () => {
  const cases: [string, number, string][] = [
    ['{"a":{"b":[1]}}', 0, "object_close"],
    ['{"a":{"b":[1]}', 1, "object_close"],
    ['{"a":{"b":[1]', 2, "array_close"],
    ['{"a":{"b":[12', 3, "digit"],
    ['{"a":{"b":["x"', 3, "string"],
    ['{"a":{"b":["x",', 3, "comma"],
    ['{"a":{"b":  \n', 2, "colon"],
    ['{"a":[', 2, "open"],
    ['{"a":{', 2, "open"],
    ['{"a":"x } y', 1, "in_string"],
    ['{"a":"x \\"', 1, "in_string"],
    ['{"a":null', 1, "letter"],
    ["", 0, "none"],
    [" \n\t", 0, "none"],
    // An escaped layer scans by its structure.
    ['{\\"a\\":{\\"b\\":1}', 1, "object_close"],
    [PRIVATE, 0, "letter"],
    ["}x}", 0, "object_close"],
  ];
  for (const [body, open, end] of cases) {
    const shape = facts(enveloped(body));
    assert.deepEqual([shape.openContainers, shape.bodyEnd], [open, end], body);
  }
  // Without a close marker the whole text is scanned.
  const unclosed = facts(NATIVE_REVIEW_OPEN + '{"a":[1,');
  assert.deepEqual(
    [unclosed.stage, unclosed.openContainers, unclosed.bodyEnd],
    ["close_marker_absent", 2, "comma"],
  );
});

Deno.test("shape facts: the text start and an unexpected error are closed codes", () => {
  const starts: [string, string][] = [
    ["", "empty"],
    [" x", "whitespace"],
    ["{}", "brace"],
    ["```json", "fence"],
    [PRIVATE, "other"],
    [NATIVE_REVIEW_OPEN, "marker"],
  ];
  for (const [text, start] of starts) {
    assert.equal(facts(text).textStart, start, text);
  }
  const text = enveloped(PRIVATE);
  const shape = nativeReviewResultShape(text, new Error(PRIVATE), "unknown");
  assert.equal(shape.stage, "exception");
  const line = reviewResultShapeLine(IDS, shape);
  assert.notEqual(line, null);
  assert.equal(line!.includes(PRIVATE), false);
});

Deno.test("shape line: the strict parser accepts only the exact closed record", () => {
  const shape = facts(enveloped("x"));
  const line = JSON.parse(reviewResultShapeLine(IDS, shape)!);
  assert.deepEqual(parseReviewResultShape(line), line);
  assert.equal(Object.hasOwn(line, "status"), false);
  const invalid: unknown[] = [
    null,
    [],
    "line",
    { ...line, status: "ran" },
    { ...line, extra: 1 },
    { ...line, event: "sentinel_review_terminal" },
    { ...line, stage: PRIVATE },
    { ...line, field: "lineend" },
    { ...line, recovered: 0 },
    { ...line, bodyBytes: MAX_SHAPE_COUNT + 1 },
    { ...line, prefixBytes: -1 },
    { ...line, suffixBytes: 0.5 },
    { ...line, openMarkers: "1" },
    { ...line, openContainers: -1 },
    { ...line, bodyEnd: "object close" },
    { ...line, ownerRunId: "" },
    { ...line, requestId: "-leading" },
    { ...line, invocationId: "x".repeat(257) },
  ];
  for (const key of Object.keys(line)) {
    const { [key]: _dropped, ...rest } = line;
    invalid.push(rest);
  }
  for (const value of invalid) {
    assert.equal(parseReviewResultShape(value), null, JSON.stringify(value));
  }
  assert.equal(
    reviewResultShapeLine({ ...IDS, requestId: "a b" }, shape),
    null,
  );
});
