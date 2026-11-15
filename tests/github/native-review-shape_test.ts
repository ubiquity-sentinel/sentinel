/**
 * A completed native review whose result is classified malformed prints one
 * text-free shape line (2026-11-14: 4 of 15 charged reviews were recorded
 * `malformed [json_syntax]` or `malformed [unknown]` with nothing saying which
 * parse or repair stage failed). The line names the stage with closed codes
 * and bounded integers only. Synthetic inputs throughout: a private marker
 * sits in every content position and never reaches any printed line, and the
 * classification of every case is exactly what it was before.
 */
import assert from "node:assert/strict";
import {
  NATIVE_REVIEW_CLOSE,
  NATIVE_REVIEW_OPEN,
} from "../../src/github/native-review-result.ts";
import { MAX_JOURNAL_BYTES } from "../../src/github/review-result-contracts.ts";
import {
  CLEAN_RESULT,
  FINDINGS_RESULT,
  MALFORMED_PREFIX,
} from "./codex-reviewer-helpers.ts";
import { nativeReview } from "./native-review-shape-rig.ts";

const PRIVATE = "SYNTHETIC_PRIVATE_SHAPE_SENTINEL";
const EVENT = '"sentinel_review_result_shape"';
const IDS = {
  ownerRunId: "run-1",
  requestId: "request-1",
  invocationId: "invocation-1",
};
const bytes = (text: string) => new TextEncoder().encode(text).length;
const OPEN = NATIVE_REVIEW_OPEN;
const CLOSE = NATIVE_REVIEW_CLOSE;

/** Facts every case shares unless it says otherwise. */
const NOTHING = {
  recovered: false,
  issue: "none",
  field: "none",
  findingsParsed: 0,
  prefixBytes: 0,
  suffixBytes: 0,
  jsonCandidates: 1,
  braces: "balanced",
  openContainers: 0,
  bodyEnd: "object_close",
  syntax: "none",
  syntaxOffset: "none",
  repair: "none",
  repairSyntax: "none",
  repairOffset: "none",
  layer: "none",
};

/** The one shape line: closed values only, no `status`, no review text. */
function onlyShape(printed: string[]): Record<string, unknown> {
  assert.equal(printed.join("\n").includes(PRIVATE), false, "no review text");
  const lines = printed.filter((line) => line.includes(EVENT));
  assert.equal(lines.length, 1, printed.join("\n"));
  const shape = JSON.parse(lines[0]) as Record<string, unknown>;
  assert.equal(Object.hasOwn(shape, "status"), false);
  for (const [key, value] of Object.entries(shape)) {
    if (Object.hasOwn(IDS, key)) continue;
    assert.ok(
      typeof value === "boolean" || Number.isSafeInteger(value) ||
        (typeof value === "string" && /^[a-z][a-z_0-9]{0,39}$/i.test(value)),
      `${key} is a closed code, a boolean or an integer`,
    );
  }
  return shape;
}

function expectShape(
  printed: string[],
  facts: Record<string, unknown>,
): void {
  assert.deepEqual(onlyShape(printed), {
    event: "sentinel_review_result_shape",
    ...IDS,
    ...NOTHING,
    ...facts,
  });
}

const envelope = (binding: unknown, result: unknown) =>
  JSON.stringify({ binding, result });

Deno.test("result shape: an unrecoverable envelope syntax slip names the parser and repair stages", async () => {
  let body = "";
  const { outcome, printed } = await nativeReview((binding) => {
    body = `{"binding":${JSON.stringify(binding)},"result":` +
      `{"verdict":"clean" "summary":"${PRIVATE}","findings":[]}}`;
    return OPEN + body + CLOSE;
  });
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.detail, `${MALFORMED_PREFIX}[json_syntax]`);
  // The strict parser stops at the second string; the quote rewrite merges
  // both strings into one and stops two escapes later, at its colon.
  const at = bytes(body.slice(0, body.indexOf('"summary"')));
  assert.ok(at >= 64 && at + 11 < 256, String(at));
  expectShape(printed, {
    stage: "json_syntax",
    messageBytes: bytes(OPEN + body + CLOSE),
    textStart: "marker",
    openMarkers: 1,
    closeMarkers: 1,
    bodyBytes: bytes(body),
    syntax: "expected_comma_or_brace",
    syntaxOffset: "lt256",
    repair: "refused",
    repairSyntax: "expected_comma_or_brace",
    repairOffset: "lt256",
    layer: "absent",
  });
});

Deno.test("result shape: a body cut after a value and one missing its last brace are told apart", async (t) => {
  // 2026-11-15: one live line read json_syntax, unexpected_end, unclosed, a
  // 2047-byte body, both markers and nothing after the close marker. The same
  // result complete (2063 bytes) is accepted; cut at 2047 bytes after its
  // summary, or missing only its last brace, it is refused and the end of the
  // scan tells the two apart.
  let summary = "";
  const prefix = (binding: unknown) =>
    `{"binding":${JSON.stringify(binding)},"result":` +
    `{"verdict":"clean","summary":"`;
  const cut = (binding: unknown) => {
    const head = prefix(binding);
    summary = PRIVATE.padEnd(2047 - bytes(head) - 1, "x");
    return `${head}${summary}"`;
  };
  const full = (binding: unknown) => `${cut(binding)},"findings":[]}}`;
  await t.step("complete", async () => {
    let body = "";
    const { outcome, printed } = await nativeReview((binding) => {
      body = full(binding);
      return OPEN + body + CLOSE;
    });
    assert.equal(bytes(body), 2063);
    assert.equal(outcome.status, "clean", outcome.detail ?? "");
    assert.deepEqual(outcome.result, { ...CLEAN_RESULT, summary });
    assert.equal(printed.some((line) => line.includes(EVENT)), false);
  });
  const cases = [{
    name: "cut at 2047 bytes",
    build: cut,
    facts: {
      messageBytes: 2102,
      bodyBytes: 2047,
      openContainers: 2,
      bodyEnd: "string",
    },
  }, {
    name: "last brace missing",
    build: (binding: unknown) => full(binding).slice(0, -1),
    facts: {
      messageBytes: 2117,
      bodyBytes: 2062,
      openContainers: 1,
      bodyEnd: "object_close",
    },
  }];
  for (const item of cases) {
    await t.step(item.name, async () => {
      const { outcome, printed } = await nativeReview((binding) =>
        OPEN + item.build(binding) + CLOSE
      );
      assert.equal(outcome.detail, `${MALFORMED_PREFIX}[json_syntax]`);
      expectShape(printed, {
        stage: "json_syntax",
        textStart: "marker",
        openMarkers: 1,
        closeMarkers: 1,
        braces: "unclosed",
        syntax: "unexpected_end",
        syntaxOffset: "end",
        repair: "unchanged",
        layer: "absent",
        ...item.facts,
      });
    });
  }
});

Deno.test("result shape: a well-formed envelope inside a wrapper is reported as wrapped with a parsing body", async () => {
  let text = "";
  let body = "";
  const { outcome, printed } = await nativeReview((binding) => {
    body = envelope(binding, { ...CLEAN_RESULT, summary: PRIVATE });
    text = "```json\n" + OPEN + body + CLOSE + "\n```";
    return text;
  });
  assert.equal(outcome.detail, `${MALFORMED_PREFIX}[unknown]`);
  expectShape(printed, {
    stage: "open_marker_not_first",
    messageBytes: bytes(text),
    textStart: "fence",
    openMarkers: 1,
    closeMarkers: 1,
    prefixBytes: 8,
    bodyBytes: bytes(body),
    suffixBytes: 4,
  });
});

Deno.test("result shape: schema failures name one fixed field and never reflect a key", async (t) => {
  const finding = { ...FINDINGS_RESULT.findings[0], title: PRIVATE };
  const cases = [{
    name: "missing summary",
    category: "summary",
    result: { verdict: "clean", findings: [] },
    facts: { issue: "missing_field", field: "summary" },
  }, {
    // The strict acceptance parser puts an unknown key's name in its issue
    // path; only the fixed field name may leave the reviewer.
    name: "unknown task acceptance key",
    category: "unknown",
    result: {
      ...CLEAN_RESULT,
      summary: PRIVATE,
      taskAcceptance: {
        issueNumber: 1,
        taskDigest: "c".repeat(64),
        verdict: "uncertain",
        evidence: [],
        [PRIVATE]: true,
      },
    },
    facts: { issue: "unknown_key", field: "taskAcceptance" },
  }, {
    name: "second finding range",
    category: "finding_range",
    result: {
      verdict: "findings",
      summary: PRIVATE,
      findings: [finding, { ...finding, lineStart: 5, lineEnd: 4 }],
    },
    facts: { issue: "invalid_value", field: "lineEnd", findingsParsed: 1 },
  }];
  for (const item of cases) {
    await t.step(item.name, async () => {
      let body = "";
      const { outcome, printed } = await nativeReview((binding) => {
        body = envelope(binding, item.result);
        return OPEN + body + CLOSE;
      });
      assert.equal(outcome.detail, `${MALFORMED_PREFIX}[${item.category}]`);
      expectShape(printed, {
        stage: "result_shape",
        messageBytes: bytes(OPEN + body + CLOSE),
        textStart: "marker",
        openMarkers: 1,
        closeMarkers: 1,
        bodyBytes: bytes(body),
        ...item.facts,
      });
    });
  }
});

Deno.test("result shape: a recovered result contradicting its native findings keeps the repair facts", async () => {
  let body = "";
  const { outcome, printed } = await nativeReview((binding) => {
    // A trailing comma the structural rewrite removes; no native findings.
    body = envelope(binding, { ...FINDINGS_RESULT, summary: PRIVATE })
      .slice(0, -1) + ",}";
    return OPEN + body + CLOSE;
  });
  assert.equal(
    outcome.detail,
    `${MALFORMED_PREFIX}[recovered_native_findings]`,
  );
  const at = bytes(body) - 1;
  assert.ok(at >= 256 && at < 1024, String(at));
  expectShape(printed, {
    stage: "native_findings",
    recovered: true,
    issue: "invalid_value",
    field: "root",
    findingsParsed: 1,
    messageBytes: bytes(OPEN + body + CLOSE),
    textStart: "marker",
    openMarkers: 1,
    closeMarkers: 1,
    bodyBytes: bytes(body),
    syntax: "expected_key",
    syntaxOffset: "lt1024",
    repair: "parsed",
    layer: "absent",
  });
});

Deno.test("result shape: marker failures are told apart", async (t) => {
  const prose = `Review complete: ${PRIVATE}`;
  const cases = [{
    name: "no envelope",
    build: () => prose,
    facts: {
      stage: "open_marker_absent",
      messageBytes: bytes(prose),
      textStart: "other",
      openMarkers: 0,
      closeMarkers: 0,
      bodyBytes: 0,
      jsonCandidates: 0,
    },
  }, {
    name: "no close marker",
    build: (binding: unknown) => OPEN + envelope(binding, CLEAN_RESULT),
    facts: { stage: "close_marker_absent", openMarkers: 1, closeMarkers: 0 },
  }, {
    name: "two envelopes",
    build: (binding: unknown) => {
      const one = OPEN + envelope(binding, CLEAN_RESULT) + CLOSE;
      return one + one;
    },
    facts: { stage: "open_marker_repeated", openMarkers: 2, closeMarkers: 2 },
  }];
  for (const item of cases) {
    await t.step(item.name, async () => {
      let text = "";
      const { outcome, printed } = await nativeReview((binding) => {
        text = item.build(binding);
        return text;
      });
      assert.equal(outcome.detail, `${MALFORMED_PREFIX}[unknown]`);
      const shape = onlyShape(printed);
      for (const [key, value] of Object.entries(item.facts)) {
        assert.equal(shape[key], value, key);
      }
      assert.equal(shape.messageBytes, bytes(text));
    });
  }
});

Deno.test("result shape: an accepted or over-bound result prints no shape line", async () => {
  const clean = await nativeReview((binding) =>
    OPEN + envelope(binding, CLEAN_RESULT) + CLOSE
  );
  assert.equal(clean.outcome.status, "clean");
  assert.equal(clean.printed.some((line) => line.includes(EVENT)), false);
  const bound = await nativeReview(() =>
    OPEN + "x".repeat(MAX_JOURNAL_BYTES + 1) + CLOSE
  );
  assert.equal(bound.outcome.status, "unavailable");
  assert.equal(
    bound.outcome.detail,
    "structured review unavailable: the structured result exceeded the accepted bound",
  );
  assert.equal(bound.printed.some((line) => line.includes(EVENT)), false);
});
