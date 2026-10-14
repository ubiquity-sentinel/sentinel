/** Cohesive routing cases for the unchanged model-port facade. */
import assert from "node:assert/strict";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { SHA3 } from "../state/helpers.ts";
import {
  CHECKOUT,
  COMPLETED_TERMINAL,
  runtimeRequest,
  ScriptedSession,
  SUCCESS_ITEM,
} from "./model-port-helpers.ts";

Deno.test(
  "model-port: real concrete producer certifies a correlated completed run (no injected verifier)",
  async () => {
    const session = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [SUCCESS_ITEM, COMPLETED_TERMINAL],
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          }),
      },
    });
    const result = await port.runModel(runtimeRequest());
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "completed");
    assert.equal(result.value.candidate?.head, SHA3);
    assert.equal(result.value.actual.evidenceKind, "request-runtime");
    assert.equal(result.value.actual.provider, "sentinel-host");
    assert.equal(result.value.actual.threadId, "thread-1");
    assert.equal(result.value.actual.turnId, "turn-1");
    assert.equal(result.value.actual.observedModel, "gpt-reserve");
    assert.equal(result.value.actual.observedReasoning, "max");
    assert.equal(result.value.actual.durationMs, 5);
    assert.equal(
      result.value.actual.observedTerminalStatus,
      "completed",
      "the exact observed runtime terminal status is preserved",
    );
    assert.equal(session.closeCalls, 1);
    const threadStart = session.sent.find(
      (frame) => frame.method === "thread/start",
    );
    assert.ok(threadStart, "thread/start was sent");
    assert.equal(
      (threadStart?.params as Record<string, unknown>).modelProvider,
      "sentinel-host",
      "the selected provider is submitted explicitly on thread/start",
    );
    const turnStartIndex = session.sent.findIndex(
      (frame) => frame.method === "turn/start",
    );
    const threadStartIndex = session.sent.findIndex(
      (frame) => frame.method === "thread/start",
    );
    assert.ok(
      turnStartIndex > threadStartIndex,
      "the thread acknowledgment precedes any turn start",
    );
  },
);

Deno.test(
  "model-port: provider/model/effort mismatch in thread acknowledgment fails before any turn starts",
  async () => {
    const mismatches: Record<string, unknown>[] = [
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "other-provider",
      },
      {
        thread: { id: "thread-1" },
        model: "gpt-5.4",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "medium",
        modelProvider: "sentinel-host",
      },
    ];
    for (const threadAck of mismatches) {
      const session = new ScriptedSession(
        threadAck,
        { turn: { id: "turn-1" } },
        [],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) assert.equal(result.error.kind, "unavailable");
      assert.equal(
        session.sent.some((frame) => frame.method === "turn/start"),
        false,
        `no model turn may start after a mismatch (${
          JSON.stringify(threadAck)
        })`,
      );
      assert.equal(
        session.closeCalls,
        1,
        "the session is settled after the fail-closed mismatch",
      );
    }
  },
);

Deno.test(
  "model-port: missing or over-bound session identities fail closed",
  async () => {
    // Missing/empty/over-bound thread id: rejected before any turn starts.
    for (const threadId of ["", "x".repeat(300)]) {
      const session = new ScriptedSession(
        {
          thread: { id: threadId },
          model: "gpt-reserve",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: "turn-1" } },
        [],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) assert.equal(result.error.kind, "unavailable");
      assert.equal(
        session.sent.some((frame) => frame.method === "turn/start"),
        false,
        "a missing/over-bound thread id never spends a turn",
      );
    }
    // Missing/empty turn id: rejected after thread/start, before work begins.
    for (const turnId of ["", "y".repeat(300)]) {
      const session = new ScriptedSession(
        {
          thread: { id: "thread-1" },
          model: "gpt-reserve",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        },
        { turn: { id: turnId } },
        [],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(!result.ok, JSON.stringify(result));
      if (!result.ok) assert.equal(result.error.kind, "unavailable");
      assert.equal(session.closeCalls, 1);
    }
  },
);

Deno.test(
  "model-port: well-formed unrelated reroute is ignored; matching off-Luna fails even when routed back",
  async () => {
    // Unrelated reroute: well-formed thread/turn identity, ignored completely.
    const unrelated = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-other",
            turnId: "turn-other",
            fromModel: "gpt-reserve",
            toModel: "gpt-5.4",
          },
        },
        SUCCESS_ITEM,
        COMPLETED_TERMINAL,
      ],
    );
    const ignoringPort = new CodexImplementationPort({
      openSession: () => Promise.resolve(unrelated),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      checkout: {
        resolve: () =>
          Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          }),
      },
    });
    const ignored = await ignoringPort.runModel(runtimeRequest());
    assert.ok(ignored.ok, JSON.stringify(ignored));
    if (!ignored.ok) return;
    assert.equal(ignored.value.outcome, "completed");

    // Matching reroute off Luna then routed back: the sticky unavailable
    // disposition rejects routing uncertainty before ANY verifier/candidate
    // action — never a certifiable failed runtime receipt, and never a
    // candidate.
    const offAndBack = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            fromModel: "gpt-reserve",
            toModel: "gpt-5.4",
          },
        },
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            fromModel: "gpt-5.4",
            toModel: "gpt-reserve",
          },
        },
        SUCCESS_ITEM,
        COMPLETED_TERMINAL,
      ],
    );
    const failingPort = new CodexImplementationPort({
      openSession: () => Promise.resolve(offAndBack),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
    });
    const result = await failingPort.runModel(runtimeRequest());
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(result.error.detail, "run routed off required Luna/max");
    }
    assert.equal(offAndBack.closeCalls, 1);
  },
);

Deno.test(
  "model-port: malformed matching reroute fails closed",
  async () => {
    // Event missing a turn id: cannot be correlated, evidence is ambiguous.
    const missingTurnId = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            fromModel: "gpt-reserve",
            toModel: "gpt-5.4",
          },
        },
        SUCCESS_ITEM,
        COMPLETED_TERMINAL,
      ],
    );
    const first = new CodexImplementationPort({
      openSession: () => Promise.resolve(missingTurnId),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
    });
    const result = await first.runModel(runtimeRequest());
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(
        result.error.detail,
        "malformed reroute identity",
        result.error.detail ?? "",
      );
    }
    assert.equal(missingTurnId.closeCalls, 1);

    // Matching event with malformed models: fail closed.
    const malformedModels = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            fromModel: "gpt-reserve",
            toModel: 42,
          },
        },
        SUCCESS_ITEM,
        COMPLETED_TERMINAL,
      ],
    );
    const second = new CodexImplementationPort({
      openSession: () => Promise.resolve(malformedModels),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
    });
    const malformed = await second.runModel(runtimeRequest());
    assert.ok(!malformed.ok, JSON.stringify(malformed));
    if (!malformed.ok) {
      assert.equal(malformed.error.kind, "unavailable");
      assert.equal(
        malformed.error.detail,
        "malformed matching reroute",
        malformed.error.detail ?? "",
      );
    }
    assert.equal(malformedModels.closeCalls, 1);
  },
);
