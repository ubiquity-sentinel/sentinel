/** New sessions have no practical streamed-volume ceiling; evidence stays bounded. */
import assert from "node:assert/strict";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { verifyMatrixReceiptV1 } from "../../src/host/matrix-identity.ts";
import { readModelBoundaryDiagnostic } from "../../src/repair/model-port-diagnostics.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { MAX_RESULT_ITEMS } from "../../src/repair/model-port-policy.ts";
import { SHA3 } from "../state/helpers.ts";
import {
  COMPLETED_TERMINAL,
  runtimeRequest,
  ScriptedSession,
} from "./model-port-helpers.ts";

Deno.test("model volume: production policy completes above the old ceiling with bounded evidence", async () => {
  const request = runtimeRequest(createLocalRepositoryConfig().sessionBound!);
  const events = Array.from({ length: 2048 }, (_, i) => ({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: `message-${i}`,
        type: "agentMessage",
        text: "x".repeat(4096),
      },
    },
  }));
  const session = new ScriptedSession(
    {
      thread: { id: "thread-1" },
      model: request.model,
      reasoningEffort: "max",
      modelProvider: "sentinel-host",
    },
    { turn: { id: "turn-1" } },
    [...events, COMPLETED_TERMINAL],
    "interrupted",
  );
  let retainedItems = 0;
  let retainedBytes = 0;
  const port = new CodexImplementationPort({
    checkoutDir: Deno.cwd(),
    openSession: () => Promise.resolve(session),
    modelProvider: "sentinel-host",
    checkout: {
      resolve: () =>
        Promise.resolve({
          head: SHA3,
          checkpointSha: null,
          changedPaths: ["app.ts"],
        }),
    },
    receiptVerifier: (evidence) => {
      retainedItems = evidence.resultItems.length;
      retainedBytes = JSON.stringify(evidence).length;
      return {
        provider: "sentinel-host",
        observedModel: request.model,
        observedReasoning: "max",
      };
    },
  });
  const result = await port.runModel(request);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.outcome, "completed");
  assert.equal(result.value.candidate?.head, SHA3);
  assert.ok(result.value.actual.outputChars > 8_000_000);
  assert.equal(
    session.sent.some((frame) => frame.method === "turn/interrupt"),
    false,
  );
  assert.equal(
    readModelBoundaryDiagnostic(result.value, request)?.interruptCause,
    "none",
  );
  assert.equal(retainedItems, MAX_RESULT_ITEMS);
  assert.ok(
    retainedBytes < 2000,
    `retained evidence was ${retainedBytes} bytes`,
  );
  assert.equal(
    verifyMatrixReceiptV1(result.value, request, "sentinel-host"),
    true,
  );
  assert.equal(session.closeCalls, 1);
});

Deno.test("model volume: projected output counts original volume but cannot certify complete item proof", async () => {
  const { awaitSettlement } = await import(
    "../../src/repair/model-port-settlement.ts"
  );
  const request = runtimeRequest(createLocalRepositoryConfig().sessionBound!);
  const events = [
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "message", type: "agentMessage", text: "prefix" },
      },
      outputVolume: {
        observedParamsChars: 5_000_000,
        truncatedOutputPaths: ["item.text" as const],
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "change",
          type: "fileChange",
          status: "completed",
          changes: [{
            path: "app.ts",
            kind: { type: "update" },
            diff: "prefix",
          }],
        },
      },
      outputVolume: {
        observedParamsChars: 5_000_000,
        truncatedOutputPaths: ["item.changes[].diff" as const],
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "command",
          type: "commandExecution",
          status: "completed",
          command: "deno check app.ts",
          cwd: Deno.cwd(),
          commandActions: [],
          exitCode: 0,
          aggregatedOutput: "prefix",
        },
      },
      outputVolume: {
        observedParamsChars: 5_000_000,
        truncatedOutputPaths: ["item.aggregatedOutput" as const],
      },
    },
    COMPLETED_TERMINAL,
  ];
  const session = new ScriptedSession({}, {}, events, "interrupted");
  await session.send("turn/start", {});
  const capture = await awaitSettlement(
    Deno.cwd(),
    100,
    session,
    request,
    "thread-1",
    "turn-1",
    request.maxOutputChars,
  );
  await session.close();
  const settled = capture();
  assert.deepEqual(settled.resultItems, []);
  assert.ok(settled.outputChars >= 15_000_000);
  assert.equal(settled.terminal?.status, "completed");
  assert.equal(settled.boundaryDiagnostic.interruptCause, "none");
  assert.equal(
    session.sent.some(({ method }) => method === "turn/interrupt"),
    false,
  );
});

Deno.test("model volume: bounded early evidence loss waits for real terminal then refuses proof", async () => {
  const { awaitSettlement } = await import(
    "../../src/repair/model-port-settlement.ts"
  );
  const request = runtimeRequest(createLocalRepositoryConfig().sessionBound!);
  const session = new ScriptedSession(
    {},
    {},
    [COMPLETED_TERMINAL],
    "interrupted",
  );
  await session.send("turn/start", {});
  const getLoss = () => ({
    observedParamsChars: 40_000_000,
    criticalEvidenceLost: true,
  });
  const capture = await awaitSettlement(
    Deno.cwd(),
    100,
    session,
    request,
    "thread-1",
    "turn-1",
    request.maxOutputChars,
    request.maxDurationMs,
    getLoss,
  );
  await session.close();
  const settled = capture();
  assert.equal(settled.terminal?.status, "completed");
  assert.match(
    settled.unavailable?.detail ?? "",
    /early notification evidence/,
  );
  assert.ok(settled.outputChars >= 40_000_000);
  assert.equal(settled.boundaryDiagnostic.interruptCause, "none");
  assert.equal(
    session.sent.some(({ method }) => method === "turn/interrupt"),
    false,
  );
});
