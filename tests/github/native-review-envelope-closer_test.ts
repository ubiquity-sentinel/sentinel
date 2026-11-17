/**
 * The native review envelope's one missing outermost brace (2026-11-17, PR
 * 418 round 1, supervisor run 43998348148): the shape line read json_syntax,
 * unexpected_end at the end of an 1801-byte body, one container open and a
 * last token `}`, with the close marker and 602 bytes of native findings
 * after it, and the same head was charged a second round. Such a body is
 * closed with that one brace only when the closed text parses strictly and
 * carries every contract key; any other loss stays `json_syntax`, and every
 * later check still holds. Synthetic texts only; no line carries review text.
 */
import assert from "node:assert/strict";
import type { ReviewTaskStatementV1 } from "../../src/contracts/review-receipt.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-task-acceptance.ts";
import {
  closedOutermostObject,
  expectEnvelopeJson,
} from "../../src/github/native-review-envelope-repair.ts";
import {
  NATIVE_REVIEW_CLOSE as CLOSE,
  NATIVE_REVIEW_OPEN as OPEN,
  nativeFindingSuffix,
} from "../../src/github/native-review-result.ts";
import type { ReviewResultV1 } from "../../src/github/review-result-contracts.ts";
import { TASK_ACCEPTANCE_MISSING_DETAIL } from "../../src/github/reviewer-policy.ts";
import { MALFORMED_PREFIX, SESSION_CWD } from "./codex-reviewer-helpers.ts";
import { nativeReview } from "./native-review-shape-rig.ts";

const PRIVATE = "SYNTHETIC_PRIVATE_CLOSER_SENTINEL";
const EVENT = '"sentinel_review_result_shape"';

const P0 = {
  priority: 0,
  title: "Deposit drops the amount",
  body: `The amount is never added ${PRIVATE}.\n\nEvery deposit is lost.`,
  path: "account.ts",
  lineStart: 1,
  lineEnd: 3,
} as const;
const P1 = {
  priority: 1,
  title: "Deposit has no upper bound",
  body: "Any amount is accepted.",
  path: "account.ts",
  lineStart: 2,
  lineEnd: 2,
} as const;
const TWO = {
  verdict: "findings",
  summary: `Two defects ${PRIVATE}.`,
  findings: [P0, P1],
  taskAcceptance: null,
} as const;
const CLEAN = {
  verdict: "clean",
  summary: `No defects ${PRIVATE}.`,
  findings: [],
  taskAcceptance: null,
} as const;

const full = (binding: unknown, result: unknown, indent?: number) =>
  JSON.stringify({ binding, result }, null, indent);
const suffix = (result: unknown) =>
  nativeFindingSuffix(result as ReviewResultV1, SESSION_CWD);

/** The body cut just before `marker`'s first occurrence after `from`. */
function cutBefore(body: string, marker: string, from = ""): string {
  const at = body.indexOf(marker, from === "" ? 0 : body.indexOf(from));
  assert.ok(at > 0, marker);
  return body.slice(0, at);
}

/** The one shape line a refused review printed, as closed facts. */
function shapeOf(printed: string[]): Record<string, unknown> {
  assert.equal(printed.join("\n").includes(PRIVATE), false, "no review text");
  const lines = printed.filter((line) => line.includes(EVENT));
  assert.equal(lines.length, 1, printed.join("\n"));
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

async function taskStatement(): Promise<ReviewTaskStatementV1> {
  const text = { issueNumber: 418, title: "Deposit", body: "Add the amount." };
  return { ...text, digest: await reviewTaskStatementDigest(text) };
}

Deno.test("envelope closer: only a strictly parsing outermost object with every contract key closes", () => {
  const binding = {
    head: "a",
    base: "b",
    snapshotDigest: "c",
    taskDigest: null,
  };
  const body = full(binding, TWO);
  assert.deepEqual(expectEnvelopeJson(body.slice(0, -1), "$"), {
    value: JSON.parse(body),
    recovered: true,
  });
  // Whitespace before the missing brace is the reviewer's own.
  const pretty = full(binding, TWO, 2);
  assert.match(pretty.slice(0, -1), /\n$/);
  assert.deepEqual(
    expectEnvelopeJson(pretty.slice(0, -1), "$").value,
    JSON.parse(body),
  );
  const cases: [string, string][] = [
    [body, "refused"],
    [body + "}", "refused"],
    [body.slice(0, -2), "refused"],
    [body.slice(0, -1) + ",", "refused"],
    [body.slice(0, -1) + ' "x"', "refused"],
    [cutBefore(body, ',"result"'), "envelope_keys"],
    [body.slice(0, -1) + ',"note":{}', "envelope_keys"],
    ["{", "envelope_keys"],
    [
      full(binding, { ...TWO, taskAcceptance: undefined }).slice(0, -1),
      "result_keys",
    ],
    [full(binding, null).slice(0, -1), "result_keys"],
    [full(binding, [TWO]).slice(0, -1), "result_keys"],
  ];
  for (const [text, closer] of cases) {
    assert.equal(closedOutermostObject(text).closer, closer, text);
    // Only the intact body parses; nothing else is closed for the reviewer.
    if (text !== body) assert.throws(() => expectEnvelopeJson(text, "$"), text);
  }
});

Deno.test("envelope closer: a review missing only its last brace completes with identical findings", async (t) => {
  const cases = [{
    name: "findings with a P0",
    result: TWO,
    indent: undefined,
    status: "findings",
  }, {
    name: "pretty-printed findings",
    result: TWO,
    indent: 2,
    status: "findings",
  }, {
    name: "clean",
    result: CLEAN,
    indent: undefined,
    status: "clean",
  }];
  for (const item of cases) {
    await t.step(item.name, async () => {
      const { outcome, printed } = await nativeReview((binding) =>
        OPEN + full(binding, item.result, item.indent).slice(0, -1) + CLOSE +
        suffix(item.result)
      );
      assert.equal(outcome.status, item.status, outcome.detail ?? "");
      assert.deepEqual(outcome.result, item.result);
      assert.notEqual(outcome.execution, null);
      assert.equal(printed.some((line) => line.includes(EVENT)), false);
    });
  }
  await t.step("the P0 is kept, bound to the exact task", async () => {
    const task = await taskStatement();
    const result = {
      ...TWO,
      taskAcceptance: {
        issueNumber: task.issueNumber,
        taskDigest: task.digest,
        verdict: "not_fulfilled",
        evidence: ["deposit subtracts the amount"],
      },
    };
    const { outcome } = await nativeReview(
      (binding) =>
        OPEN + full(binding, result).slice(0, -1) + CLOSE + suffix(result),
      "run-1",
      task,
    );
    assert.equal(outcome.status, "findings", outcome.detail ?? "");
    assert.deepEqual(outcome.result, result);
    assert.equal(outcome.result?.findings[0].priority, 0);
  });
});

Deno.test("envelope closer: a body that lost anything else stays json_syntax", async (t) => {
  const NO_ACCEPTANCE = { ...TWO, taskAcceptance: undefined };
  const cases: {
    name: string;
    build: (binding: unknown) => string;
    closer: string;
    open: number;
  }[] = [{
    name: "cut inside a finding",
    build: (binding) => cutBefore(full(binding, TWO), "upper bound"),
    closer: "refused",
    open: 4,
  }, {
    name: "cut after a complete finding",
    build: (binding) => cutBefore(full(binding, TWO), ',{"priority":1'),
    closer: "refused",
    open: 3,
  }, {
    name: "cut between findings",
    build: (binding) => cutBefore(full(binding, TWO), '{"priority":1'),
    closer: "refused",
    open: 3,
  }, {
    name: "cut after the findings array",
    build: (binding) => cutBefore(full(binding, TWO), ',"taskAcceptance"'),
    closer: "refused",
    open: 2,
  }, {
    name: "result closed before its task acceptance",
    build: (binding) => full(binding, NO_ACCEPTANCE).slice(0, -1),
    closer: "result_keys",
    open: 1,
  }, {
    name: "cut before the result",
    build: (binding) => cutBefore(full(binding, TWO), ',"result"'),
    closer: "envelope_keys",
    open: 1,
  }, {
    name: "cut inside a string",
    build: (binding) => cutBefore(full(binding, TWO), "defects"),
    closer: "refused",
    open: 2,
  }, {
    name: "two containers unclosed",
    build: (binding) => full(binding, TWO).slice(0, -2),
    closer: "refused",
    open: 2,
  }, {
    name: "trailing garbage",
    build: (binding) => full(binding, TWO).slice(0, -1) + " x",
    closer: "refused",
    open: 1,
  }, {
    name: "an extra closing brace",
    build: (binding) => full(binding, TWO) + "}",
    closer: "refused",
    open: 0,
  }, {
    name: "an unknown envelope key",
    build: (binding) => full(binding, TWO).slice(0, -1) + ',"note":{}',
    closer: "envelope_keys",
    open: 1,
  }];
  for (const item of cases) {
    await t.step(item.name, async () => {
      const { outcome, printed } = await nativeReview((binding) =>
        OPEN + item.build(binding) + CLOSE + suffix(TWO)
      );
      assert.equal(outcome.status, "unavailable");
      assert.equal(outcome.result, null);
      assert.equal(outcome.detail, `${MALFORMED_PREFIX}[json_syntax]`);
      const shape = shapeOf(printed);
      assert.deepEqual(
        [shape.stage, shape.recovered, shape.closer, shape.openContainers],
        ["json_syntax", false, item.closer, item.open],
      );
    });
  }
});

Deno.test("envelope closer: every later check still holds after the brace", async (t) => {
  await t.step("native findings not mirrored", async () => {
    const { outcome, printed } = await nativeReview((binding) =>
      OPEN + full(binding, TWO).slice(0, -1) + CLOSE
    );
    assert.equal(outcome.result, null);
    assert.equal(
      outcome.detail,
      `${MALFORMED_PREFIX}[recovered_native_findings]`,
    );
    const shape = shapeOf(printed);
    assert.deepEqual(
      [
        shape.stage,
        shape.recovered,
        shape.findingsParsed,
        shape.syntax,
        shape.repair,
        shape.layer,
        shape.closer,
      ],
      [
        "native_findings",
        true,
        2,
        "unexpected_end",
        "unchanged",
        "absent",
        "parsed",
      ],
    );
  });
  await t.step("native findings dropping the P0", async () => {
    const { outcome } = await nativeReview((binding) =>
      OPEN + full(binding, TWO).slice(0, -1) + CLOSE +
      suffix({ ...TWO, findings: [P1] })
    );
    assert.equal(
      outcome.detail,
      `${MALFORMED_PREFIX}[recovered_native_findings]`,
    );
  });
  await t.step("bound to another head", async () => {
    const { outcome } = await nativeReview((binding) =>
      OPEN +
      full({ ...binding as object, head: "0".repeat(40) }, TWO).slice(0, -1) +
      CLOSE + suffix(TWO)
    );
    assert.equal(
      outcome.detail,
      `${MALFORMED_PREFIX}[recovered_native_binding]`,
    );
  });
  await t.step("an unknown result key", async () => {
    const { outcome } = await nativeReview((binding) =>
      OPEN + full(binding, { ...CLEAN, note: 1 }).slice(0, -1) + CLOSE
    );
    assert.equal(outcome.detail, `${MALFORMED_PREFIX}[recovered_result_keys]`);
  });
  await t.step("no acceptance for the exact task", async () => {
    const { outcome } = await nativeReview(
      (binding) => OPEN + full(binding, TWO).slice(0, -1) + CLOSE + suffix(TWO),
      "run-1",
      await taskStatement(),
    );
    assert.equal(outcome.status, "unavailable");
    assert.equal(outcome.detail, TASK_ACCEPTANCE_MISSING_DETAIL);
  });
});
