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
