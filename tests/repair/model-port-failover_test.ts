/** Cohesive failover cases for the unchanged model-port facade. */
import assert from "node:assert/strict";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { SHA3 } from "../state/helpers.ts";
import {
  CHECKOUT,
  runtimeRequest,
  SCHEMA_FILE_CHANGE_ITEM,
  ScriptedSession,
} from "./model-port-helpers.ts";

Deno.test(
  "model-port: a 429 rate limit on the primary model fails over to the failover model",
  async () => {
    const rateLimited = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [{
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "failed",
            durationMs: 5,
            error: { message: "provider error 429: rate limit exceeded" },
          },
        },
      }],
    );
    const recovered = new ScriptedSession(
      {
        thread: { id: "thread-2" },
        model: "gpt-6-luna",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-2" } },
      [
        {
          method: "item/completed",
          params: {
            threadId: "thread-2",
            turnId: "turn-2",
            item: { ...SCHEMA_FILE_CHANGE_ITEM, id: "ok-output" },
          },
        },
        {
          method: "turn/completed",
          params: {
            threadId: "thread-2",
            turn: { id: "turn-2", status: "completed", durationMs: 5 },
          },
        },
      ],
    );
    const sessions = [rateLimited, recovered];
    let opened = 0;
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(sessions[opened++]),
      checkoutDir: CHECKOUT,
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          }),
      },
      modelProvider: "sentinel-host",
      modelId: "gpt-reserve",
      failoverModelId: "gpt-6-luna",
    });
    assert.equal(port.failoverModelId, "gpt-6-luna");

    const result = await port.runModel(runtimeRequest());
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    // The failover attempt completed: the receipt records the model that was
    // actually requested on the retry.
    assert.equal(result.value.outcome, "completed");
    assert.equal(result.value.actual.observedModel, "gpt-6-luna");
    assert.equal(result.value.actual.observedReasoning, "max");
    assert.equal(result.value.candidate?.head, SHA3);
    assert.equal(opened, 2, "the 429 triggered exactly one failover retry");

    const failoverThreadStart = recovered.sent.find(
      (frame) => frame.method === "thread/start",
    );
    const params = failoverThreadStart?.params as Record<string, unknown>;
    assert.equal(params.model, "gpt-6-luna");
    assert.deepEqual(params.config, { model_reasoning_effort: "max" });
    assert.equal(rateLimited.closeCalls, 1, "the failed session was closed");
    assert.equal(recovered.closeCalls, 1, "the failover session was closed");
  },
);

Deno.test(
  "model-port: a non-429 failure never triggers the failover",
  async () => {
    const failed = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [{
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "failed",
            durationMs: 5,
            error: { message: "synthetic failure" },
          },
        },
      }],
    );
    let opened = 0;
    const port = new CodexImplementationPort({
      openSession: () => {
        opened++;
        return Promise.resolve(failed);
      },
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      modelId: "gpt-reserve",
      failoverModelId: "gpt-6-luna",
    });

    const result = await port.runModel(runtimeRequest());
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "failed");
    assert.equal(result.value.error, "synthetic failure");
    assert.equal(opened, 1, "no retry without a 429 signal");
  },
);

Deno.test(
  "model-port: no failover is configured means no retry on 429",
  async () => {
    const rateLimited = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [{
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: {
            id: "turn-1",
            status: "failed",
            durationMs: 5,
            error: { message: "429 too many requests" },
          },
        },
      }],
    );
    let opened = 0;
    const port = new CodexImplementationPort({
      openSession: () => {
        opened++;
        return Promise.resolve(rateLimited);
      },
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      modelId: "gpt-reserve",
    });
    assert.equal(port.failoverModelId, "");

    const result = await port.runModel(runtimeRequest());
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "failed");
    assert.equal(opened, 1, "an unconfigured failover never retries");
  },
);

Deno.test(
  "model-port: an invalid or duplicate failover model id disables the failover",
  () => {
    const invalid = new CodexImplementationPort({
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      modelId: "gpt-reserve",
      failoverModelId: "  padded  ",
      openSession: () => {
        throw new Error("no session may open");
      },
    });
    assert.equal(invalid.failoverModelId, "");
    const duplicate = new CodexImplementationPort({
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      modelId: "gpt-reserve",
      failoverModelId: "gpt-reserve",
      openSession: () => {
        throw new Error("no session may open");
      },
    });
    assert.equal(duplicate.failoverModelId, "");
  },
);
