/**
 * Native review envelope recovery (2026-10-24, PR 211 and ai.ubq.fi 1258).
 * Codex 0.154.0 review mode has no output schema, so the reviewer escapes
 * Sentinel's envelope inside `overall_explanation` by hand; a missed or
 * doubled escape made the review unavailable (`json_syntax`) and spent a
 * round. The recovered slips are parsed through the REAL reviewer outcome
 * path; ambiguous or structurally wrong JSON still refuses with the fixed
 * sanitized category, and the binding and native findings checks still hold.
 */
import assert from "node:assert/strict";
import {
  expectEnvelopeJson,
  repairedEnvelopeJson,
} from "../../src/github/native-review-envelope-repair.ts";
import {
  NATIVE_REVIEW_CLOSE,
  NATIVE_REVIEW_OPEN,
  nativeFindingSuffix,
} from "../../src/github/native-review-result.ts";
import type { ReviewResultV1 } from "../../src/github/review-result-contracts.ts";
import {
  agentMessage,
  CLEAN_RESULT,
  FINDINGS_RESULT,
  MALFORMED_PREFIX,
  rejectedFinalCategory,
  ScriptedCodexSession,
  SESSION_CWD,
  snapshotFixture,
  startReview,
  turnCompleted,
} from "./codex-reviewer-helpers.ts";

/** One review whose exact native text is built from the session's binding. */
async function nativeOutcome(build: (binding: string) => string) {
  const session = new ScriptedCodexSession();
  session.plan = (scripted) => {
    const text = build(JSON.stringify(scripted.nativeBinding));
    scripted.emit(
      "item/completed",
      agentMessage(scripted.turnId, "item-1", text),
    );
    scripted.emit("turn/completed", turnCompleted(scripted.turnId));
  };
  return await startReview(session, await snapshotFixture());
}

function envelope(binding: string, result: string, suffix = ""): string {
  return NATIVE_REVIEW_OPEN + `{"binding":${binding},"result":${result}}` +
    NATIVE_REVIEW_CLOSE + suffix;
}

Deno.test("envelope recovery: each escaping slip parses to the intended value", () => {
  const cases: [string, unknown][] = [
    ['{"a":"line one\nline two"}', { a: "line one\nline two" }],
    ['{"a":"calls "deposit" twice"}', { a: 'calls "deposit" twice' }],
    ['{\\"a\\":\\"b\\"}', { a: "b" }],
    ['{"a":"don\\\'t"}', { a: "don\\'t" }],
    ['{"a":["b",],}', { a: ["b"] }],
  ];
  for (const [text, expected] of cases) {
    assert.throws(() => JSON.parse(text), "each case is invalid strict JSON");
    assert.deepEqual(expectEnvelopeJson(text, "$"), expected, text);
  }
  // Valid JSON is never rewritten.
  const valid = '{"a":"x\\ny","b":[1,2]}';
  assert.equal(repairedEnvelopeJson(valid), valid);
});

Deno.test("envelope recovery: duplicate keys, non-JSON and ambiguous quotes still refuse", () => {
  for (
    const text of [
      '{"a":"b","a":"c"}',
      '{"a":RAW_JSON_SENTINEL not a result}',
      '{"a":"he said "yes", then left"}',
      '{"a":"b"} trailing',
    ]
  ) {
    assert.throws(() => expectEnvelopeJson(text, "$"), text);
  }
});

Deno.test("native review: a summary with a raw line break and inner quotes is a clean review", async () => {
  const outcome = await nativeOutcome((binding) =>
    envelope(
      binding,
      '{"verdict":"clean","summary":"The change matches the "deposit" ' +
        'specification.\nNo defects.","findings":[]}',
    )
  );
  assert.equal(outcome.status, "clean", outcome.detail ?? "");
  assert.equal(
    outcome.result?.summary,
    'The change matches the "deposit" specification.\nNo defects.',
  );
});

Deno.test("native review: a doubly escaped envelope is read as the reviewer wrote it", async () => {
  const outcome = await nativeOutcome((binding) =>
    NATIVE_REVIEW_OPEN +
    JSON.stringify(
      `{"binding":${binding},"result":${JSON.stringify(CLEAN_RESULT)}}`,
    ).slice(1, -1) + NATIVE_REVIEW_CLOSE
  );
  assert.equal(outcome.status, "clean", outcome.detail ?? "");
  assert.deepEqual(outcome.result, CLEAN_RESULT);
});

Deno.test("native review: a recovered findings result still cross-checks the native findings", async () => {
  const result: ReviewResultV1 = FINDINGS_RESULT as unknown as ReviewResultV1;
  // The body's line breaks reach the envelope raw instead of escaped.
  const raw = JSON.stringify(result).replaceAll("\\n", "\n");
  const outcome = await nativeOutcome((binding) =>
    envelope(binding, raw, nativeFindingSuffix(result, SESSION_CWD))
  );
  assert.equal(outcome.status, "findings", outcome.detail ?? "");
  assert.deepEqual(outcome.result, FINDINGS_RESULT);

  // The same recovered result with no native findings mirrored is refused.
  const unmirrored = await nativeOutcome((binding) => envelope(binding, raw));
  assert.equal(unmirrored.status, "unavailable");
  assert.equal(unmirrored.result, null);
});

Deno.test("native review: a recovered envelope bound to another snapshot is refused", async () => {
  const outcome = await nativeOutcome((binding) => {
    const other = binding.replace(
      /"head":"[0-9a-f]+"/,
      `"head":"${"0".repeat(40)}"`,
    );
    assert.notEqual(other, binding);
    return envelope(
      other,
      '{"verdict":"clean","summary":"line one\nline two","findings":[]}',
    );
  });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.result, null);
});

Deno.test("native review: an unrecoverable envelope keeps the fixed json_syntax category", async () => {
  assert.equal(
    await rejectedFinalCategory('{"verdict":"clean","verdict":"clean"}'),
    `${MALFORMED_PREFIX}[json_syntax]`,
  );
});
