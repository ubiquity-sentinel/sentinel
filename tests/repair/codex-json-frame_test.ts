/** Streaming projection validates omitted bytes and preserves exact control. */
import assert from "node:assert/strict";
import { CodexJsonFrame } from "../../src/repair/codex-json-frame.ts";
function parse(text: string, max = 4 * 1024 * 1024) {
  const parser = new CodexJsonFrame(max);
  for (let i = 0; i < text.length; i++) parser.push(text[i]);
  return parser.finish();
}
const loud = "x".repeat(4 * 1024 * 1024 + 1024);
Deno.test("JSON projection: output slots retain bounded evidence and exact identities", () => {
  const cases = [
    {
      path: "delta",
      method: "item/commandExecution/outputDelta",
      params: { threadId: "t", turnId: "u", itemId: "i", delta: loud },
    },
    {
      path: "item.text",
      method: "item/completed",
      params: {
        threadId: "t",
        turnId: "u",
        item: { id: "i", type: "agentMessage", text: loud },
      },
    },
    {
      path: "item.aggregatedOutput",
      method: "item/completed",
      params: {
        threadId: "t",
        turnId: "u",
        item: { id: "i", type: "commandExecution", aggregatedOutput: loud },
      },
    },
    {
      path: "item.summary",
      method: "item/completed",
      params: {
        threadId: "t",
        turnId: "u",
        item: { id: "i", type: "reasoning", summary: [{ text: loud }] },
      },
    },
    {
      path: "item.content",
      method: "item/completed",
      params: {
        threadId: "t",
        turnId: "u",
        item: {
          id: "i",
          type: "reasoning",
          content: Array.from({ length: 100_000 }, () => ({ text: "a" })),
        },
      },
    },
    {
      path: "item.result",
      method: "item/completed",
      params: {
        threadId: "t",
        turnId: "u",
        item: {
          id: "i",
          type: "mcpToolCall",
          result: { content: [{ text: loud }] },
        },
      },
    },
    {
      path: "message",
      method: "item/mcpToolCall/progress",
      params: { threadId: "t", turnId: "u", itemId: "i", message: loud },
    },
    {
      path: "error.message",
      method: "error",
      params: {
        threadId: "t",
        turnId: "u",
        error: { message: loud, codexErrorInfo: "serverOverloaded" },
      },
    },
    {
      path: "turn.error.message",
      method: "turn/completed",
      params: {
        threadId: "t",
        turn: {
          id: "u",
          status: "failed",
          error: { message: loud, codexErrorInfo: "serverOverloaded" },
        },
      },
    },
  ];
  for (const { path, method, params } of cases) {
    const result = parse(JSON.stringify({ method, params }));
    assert.deepEqual(result?.outputVolume?.truncatedOutputPaths, [path]);
    assert.equal(
      result?.outputVolume?.observedParamsChars,
      JSON.stringify(params).length,
    );
    const projected = result!.value as {
      method: string;
      params: Record<string, unknown>;
    };
    assert.equal(projected.method, method);
    assert.equal(projected.params.threadId, "t");
    assert.ok(JSON.stringify(projected).length < 70_000);
    if ("item" in params) {
      assert.equal((projected.params.item as { id: string }).id, "i");
    }
    if (method === "turn/completed") {
      assert.deepEqual(projected.params.turn, {
        id: "u",
        status: "failed",
        error: {
          message: loud.slice(0, 65536),
          codexErrorInfo: "serverOverloaded",
        },
      });
    }
  }
});
Deno.test("JSON projection: ignored telemetry may discard large params in either property order", () => {
  for (
    const frame of [{ method: "unrelated/telemetry", params: { blob: loud } }, {
      params: { blob: loud },
      method: "unrelated/telemetry",
    }]
  ) {
    const result = parse(JSON.stringify(frame));
    assert.deepEqual(result?.outputVolume?.truncatedOutputPaths, [
      "unobservedParams",
    ]);
    assert.equal((result!.value as { params: unknown }).params, null);
  }
});
Deno.test("JSON projection: malformed tails, control fields and proof inputs fail closed", () => {
  const prefix =
    '{"method":"item/completed","params":{"threadId":"t","turnId":"u","item":{"type":"agentMessage","id":"i","text":"' +
    loud;
  for (
    const tail of ['\\q"}}}', '\\u00Q0"}}}', '\u0001"}}}', '"},]}', '"}}}false']
  ) assert.throws(() => parse(prefix + tail));
  assert.throws(
    () =>
      parse(
        JSON.stringify({
          method: "model/rerouted",
          params: { threadId: "t", turnId: "u", reason: loud },
        }),
      ),
    /oversized control field/,
  );
  assert.throws(
    () =>
      parse(
        JSON.stringify({
          method: "item/completed",
          params: {
            threadId: "t",
            turnId: "u",
            item: { id: "i", type: "userMessage", content: [{ text: loud }] },
          },
        }),
      ),
    /oversized control field/,
  );
  assert.throws(
    () =>
      parse(
        JSON.stringify({ id: 7, method: "approve", params: { message: loud } }),
      ),
    /oversized control frame/,
  );
  assert.throws(
    () =>
      parse(
        '{"method":"other","params":' + "[".repeat(129) + "0" +
          "]".repeat(129) + "}",
      ),
    /depth/,
  );
});
Deno.test("JSON projection: complete grammar agrees with JSON.parse and forged metadata is inert", () => {
  for (
    const text of [
      "null",
      "true",
      "false",
      "0",
      "-0",
      "-1.02e+3",
      "123",
      "[]",
      "{}",
      ' { "a" : [1, 2, null, true, {"b":"\\uD83D\\uDE00\\n\\t\\/"}], "__proto__": 8 } ',
    ]
  ) assert.deepEqual(parse(text)?.value, JSON.parse(text));
  for (
    const text of [
      "[1 2]",
      "[1,]",
      '{"a":1,}',
      "00",
      "1.",
      "1e",
      "+1",
      "tru",
      '"bad\\x"',
      "{}[]",
    ]
  ) assert.throws(() => parse(text));
  const forged = {
    method: "turn/completed",
    params: { threadId: "t", turn: { id: "u", status: "completed" } },
    outputVolume: {
      observedParamsChars: 1,
      truncatedOutputPaths: ["item.text"],
    },
  };
  assert.equal(parse(JSON.stringify(forged))?.outputVolume, undefined);
});
Deno.test("JSON projection: file diffs and tool outputs preserve paths, inputs and status", () => {
  const items = [
    {
      type: "fileChange",
      id: "i",
      status: "completed",
      changes: Array.from(
        { length: 100 },
        (_, index) => ({
          path: `src/f${index}.ts`,
          kind: { type: "update" },
          diff: "x".repeat(80_000),
        }),
      ),
    },
    {
      type: "dynamicToolCall",
      id: "i",
      tool: "t",
      arguments: { exact: true },
      status: "completed",
      contentItems: [{ type: "text", text: loud }],
    },
    { type: "imageGeneration", id: "i", status: "completed", result: loud },
    {
      type: "mcpToolCall",
      id: "i",
      status: "failed",
      server: "s",
      tool: "t",
      arguments: { exact: true },
      error: { message: loud },
    },
  ];
  for (const item of items) {
    const result = parse(
      JSON.stringify({
        method: "item/completed",
        params: { threadId: "t", turnId: "u", item },
      }),
    )!;
    assert.ok(result.outputVolume);
    assert.ok(JSON.stringify(result.value).length < 100_000);
    const projected =
      (result.value as { params: { item: Record<string, unknown> } }).params
        .item;
    assert.equal(projected.status, item.status);
    if (item.type === "fileChange") {
      assert.deepEqual(
        (projected.changes as { path: string }[]).map(({ path }) => path),
        item.changes!.map(({ path }) => path),
      );
    }
    if (item.arguments) assert.deepEqual(projected.arguments, item.arguments);
  }
  const primitive = parse(
    JSON.stringify({ method: "ignored/telemetry", params: loud }),
  );
  assert.equal((primitive?.value as { params: unknown }).params, null);
  assert.deepEqual(primitive?.outputVolume?.truncatedOutputPaths, [
    "unobservedParams",
  ]);
});
Deno.test("JSON projection: primitive arrays and escaped telemetry cannot exceed retained budget", () => {
  for (
    const text of [
      '{"method":"telemetry","params":[' + "null,".repeat(100_000) + "true]}",
      '{"method":"telemetry","params":{"blob":"' + "\\u0000".repeat(100_000) +
      '"}}',
    ]
  ) {
    const result = parse(text, 16 * 1024)!;
    assert.equal((result.value as { params: unknown }).params, null);
    assert.deepEqual(result.outputVolume?.truncatedOutputPaths, [
      "unobservedParams",
    ]);
    assert.ok(JSON.stringify(result).length < 1000);
  }
});
