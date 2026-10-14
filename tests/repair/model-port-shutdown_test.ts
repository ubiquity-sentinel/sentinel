/** Cohesive shutdown cases for the unchanged model-port facade. */
import assert from "node:assert/strict";
import {
  CodexImplementationPort,
  createRequestRuntimeReceiptVerifier,
} from "../../src/repair/model-port.ts";
import { SHA3 } from "../state/helpers.ts";
import {
  CHECKOUT,
  COMPLETED_TERMINAL,
  runtimeRequest,
  ScriptedSession,
  SUCCESS_ITEM,
} from "./model-port-helpers.ts";

const THREAD_ACK = {
  thread: { id: "thread-1" },
  model: "gpt-reserve",
  reasoningEffort: "max",
  modelProvider: "sentinel-host",
};
const TURN_ACK = { turn: { id: "turn-1" } };

const OFF_POLICY_LATE_REROUTE = {
  method: "model/rerouted",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    fromModel: "gpt-reserve",
    toModel: "gpt-5.4",
  },
};

const MALFORMED_IDENTITY_LATE_REROUTE = {
  method: "model/rerouted",
  params: {
    threadId: "thread-1",
    fromModel: "gpt-reserve",
    toModel: "gpt-5.4",
  },
};

const MALFORMED_MODELS_LATE_REROUTE = {
  method: "model/rerouted",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    fromModel: "gpt-reserve",
    toModel: 42,
  },
};

/** Port whose verifier/committer/resolver count every invocation. */
function lateReroutePort(
  session: ScriptedSession,
  counters: { verifier: number; commit: number; resolve: number },
): CodexImplementationPort {
  return new CodexImplementationPort({
    openSession: () => Promise.resolve(session),
    checkoutDir: CHECKOUT,
    modelProvider: "sentinel-host",
    receiptVerifier: (evidence) => {
      counters.verifier++;
      return createRequestRuntimeReceiptVerifier("sentinel-host")(evidence);
    },
    commitCandidate: {
      commit: () => {
        counters.commit++;
        return Promise.resolve(true);
      },
    },
    checkout: {
      resolve: () => {
        counters.resolve++;
        return Promise.resolve({
          head: SHA3,
          checkpointSha: null,
          changedPaths: ["src/app.ts"],
        });
      },
    },
  });
}

Deno.test(
  "shutdown routing: off-policy reroute after terminal (sync and during awaited close) is unavailable with zero side effects",
  async () => {
    // Emitted synchronously by the notification script AFTER the completed
    // terminal already settled the run.
    const afterTerminal = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL, OFF_POLICY_LATE_REROUTE],
    );
    const syncCounters = { verifier: 0, commit: 0, resolve: 0 };
    const syncResult = await lateReroutePort(afterTerminal, syncCounters)
      .runModel(runtimeRequest());
    assert.ok(!syncResult.ok, JSON.stringify(syncResult));
    if (!syncResult.ok) {
      assert.equal(syncResult.error.kind, "unavailable");
      assert.equal(
        syncResult.error.detail,
        "run routed off required Luna/max",
      );
    }
    assert.equal(afterTerminal.closeCalls, 1);
    assert.deepEqual(syncCounters, { verifier: 0, commit: 0, resolve: 0 });

    // Emitted synchronously and after an awaited tick from inside close(),
    // i.e. while the port is still completing shutdown.
    const duringClose = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL],
      undefined,
      async (emit) => {
        emit(
          OFF_POLICY_LATE_REROUTE.method,
          OFF_POLICY_LATE_REROUTE.params,
        );
        await Promise.resolve();
        emit(
          OFF_POLICY_LATE_REROUTE.method,
          OFF_POLICY_LATE_REROUTE.params,
        );
      },
    );
    const closeCounters = { verifier: 0, commit: 0, resolve: 0 };
    const closeResult = await lateReroutePort(duringClose, closeCounters)
      .runModel(runtimeRequest());
    assert.ok(!closeResult.ok, JSON.stringify(closeResult));
    if (!closeResult.ok) {
      assert.equal(closeResult.error.kind, "unavailable");
      assert.equal(
        closeResult.error.detail,
        "run routed off required Luna/max",
      );
    }
    assert.equal(duringClose.closeCalls, 1);
    assert.deepEqual(closeCounters, { verifier: 0, commit: 0, resolve: 0 });
  },
);

Deno.test(
  "shutdown routing: malformed reroute after terminal (sync and during awaited close) is unavailable with zero side effects",
  async () => {
    const afterTerminal = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL, MALFORMED_IDENTITY_LATE_REROUTE],
    );
    const syncCounters = { verifier: 0, commit: 0, resolve: 0 };
    const syncResult = await lateReroutePort(afterTerminal, syncCounters)
      .runModel(runtimeRequest());
    assert.ok(!syncResult.ok, JSON.stringify(syncResult));
    if (!syncResult.ok) {
      assert.equal(syncResult.error.kind, "unavailable");
      assert.equal(syncResult.error.detail, "malformed reroute identity");
    }
    assert.equal(afterTerminal.closeCalls, 1);
    assert.deepEqual(syncCounters, { verifier: 0, commit: 0, resolve: 0 });

    const duringClose = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL],
      undefined,
      async (emit) => {
        await Promise.resolve();
        emit(
          MALFORMED_MODELS_LATE_REROUTE.method,
          MALFORMED_MODELS_LATE_REROUTE.params,
        );
      },
    );
    const closeCounters = { verifier: 0, commit: 0, resolve: 0 };
    const closeResult = await lateReroutePort(duringClose, closeCounters)
      .runModel(runtimeRequest());
    assert.ok(!closeResult.ok, JSON.stringify(closeResult));
    if (!closeResult.ok) {
      assert.equal(closeResult.error.kind, "unavailable");
      assert.equal(closeResult.error.detail, "malformed matching reroute");
    }
    assert.equal(duringClose.closeCalls, 1);
    assert.deepEqual(closeCounters, { verifier: 0, commit: 0, resolve: 0 });
  },
);

Deno.test(
  "shutdown routing: unrelated late reroute stays ignored and a clean completed run commits only after close",
  async () => {
    let commitCalls = 0;
    let resolveCalls = 0;
    let closeCallsAtCommit = -1;
    const session = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL],
      undefined,
      async (emit) => {
        // Well-formed but unrelated identities: never correlated, so the
        // completed run stays clean and still commits.
        emit("model/rerouted", {
          threadId: "thread-other",
          turnId: "turn-other",
          fromModel: "gpt-reserve",
          toModel: "gpt-5.4",
        });
        await Promise.resolve();
        emit("model/rerouted", {
          threadId: "thread-2",
          turnId: "turn-2",
          fromModel: "gpt-5.4",
          toModel: "gpt-5.4",
        });
      },
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      commitCandidate: {
        commit: () => {
          commitCalls++;
          closeCallsAtCommit = session.closeCalls;
          return Promise.resolve(true);
        },
      },
      checkout: {
        resolve: () => {
          resolveCalls++;
          return Promise.resolve({
            head: SHA3,
            checkpointSha: null,
            changedPaths: ["src/app.ts"],
          });
        },
      },
    });
    const result = await port.runModel(runtimeRequest());
    assert.ok(result.ok, JSON.stringify(result));
    if (result.ok) {
      assert.equal(result.value.outcome, "completed");
      assert.equal(result.value.actual.observedTerminalStatus, "completed");
    }
    assert.equal(session.closeCalls, 1);
    assert.equal(commitCalls, 1);
    assert.equal(resolveCalls, 1);
    assert.equal(
      closeCallsAtCommit,
      1,
      "the candidate commit runs only after the session closed",
    );
  },
);

Deno.test(
  "shutdown routing: well-formed unrelated routing events during close exceed the request output bound without side effects",
  async () => {
    const session = new ScriptedSession(
      THREAD_ACK,
      TURN_ACK,
      [SUCCESS_ITEM, COMPLETED_TERMINAL],
      undefined,
      async (emit) => {
        // Well-formed but unrelated identities: correlation alone ignores
        // them, while the bounded total must still fail the run closed.
        for (let index = 0; index < 10; index++) {
          emit("model/rerouted", {
            threadId: `thread-other-${index}`,
            turnId: `turn-other-${index}`,
            fromModel: "gpt-reserve",
            toModel: "gpt-5.4",
          });
        }
        await Promise.resolve();
      },
    );
    const counters = { verifier: 0, commit: 0, resolve: 0 };
    const result = await lateReroutePort(session, counters).runModel(
      runtimeRequest({ maxOutputChars: 512 }),
    );
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(
        result.error.detail,
        "routing evidence exceeded output bound",
      );
    }
    assert.equal(session.closeCalls, 1);
    assert.deepEqual(counters, { verifier: 0, commit: 0, resolve: 0 });
  },
);

Deno.test(
  "model-port: notification bytes without actual output never certify a completed run",
  async () => {
    const session = new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [
        // Bytes only: progress notifications counted in the output total, but
        // no command/file-change/agent output item for this thread/turn.
        {
          method: "turn/progress",
          params: { delta: "x".repeat(2_000) },
        },
        {
          method: "turn/progress",
          params: { delta: "x".repeat(2_000) },
        },
        COMPLETED_TERMINAL,
      ],
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
    });
    const result = await port.runModel(runtimeRequest());
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(
        result.error.detail,
        "model receipt unavailable: completed run has no correlated output evidence",
      );
    }
    assert.equal(session.closeCalls, 1);
  },
);

Deno.test(
  "model-port: failed and interrupted receipts are retained without output",
  async () => {
    const cases: {
      status: "failed" | "interrupted";
      turnError?: Record<string, unknown>;
    }[] = [
      { status: "interrupted" },
      { status: "failed", turnError: { message: "synthetic failure" } },
    ];
    for (const item of cases) {
      const session = new ScriptedSession(
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
              status: item.status,
              durationMs: null,
              ...(item.turnError === undefined
                ? {}
                : { error: item.turnError }),
            },
          },
        }],
      );
      const port = new CodexImplementationPort({
        openSession: () => Promise.resolve(session),
        checkoutDir: CHECKOUT,
        modelProvider: "sentinel-host",
      });
      const result = await port.runModel(runtimeRequest());
      assert.ok(result.ok, JSON.stringify(result));
      if (!result.ok) return;
      assert.equal(result.value.outcome, item.status);
      assert.equal(result.value.candidate, null);
      assert.equal(result.value.actual.evidenceKind, "request-runtime");
      assert.equal(result.value.actual.provider, "sentinel-host");
      assert.equal(result.value.actual.threadId, "thread-1");
      assert.equal(result.value.actual.turnId, "turn-1");
      assert.equal(
        result.value.error,
        item.status === "failed" ? "synthetic failure" : null,
      );
      assert.equal(result.value.actual.observedTerminalStatus, item.status);
      assert.equal(session.closeCalls, 1);
    }
  },
);

Deno.test(
  "model-port: a permissive injected verifier cannot bypass reroute or model-policy validation",
  async () => {
    // The injected verifier certifies unconditionally; the port must still
    // reject the off-Luna reroute as unavailable routing uncertainty — before
    // ANY verifier or candidate action, never a certifiable failed receipt.
    const session = new ScriptedSession(
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
        SUCCESS_ITEM,
        COMPLETED_TERMINAL,
      ],
    );
    const port = new CodexImplementationPort({
      openSession: () => Promise.resolve(session),
      checkoutDir: CHECKOUT,
      modelProvider: "sentinel-host",
      receiptVerifier: () => ({
        provider: "sentinel-host",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
      }),
    });
    const result = await port.runModel(runtimeRequest());
    assert.ok(!result.ok, JSON.stringify(result));
    if (!result.ok) {
      assert.equal(result.error.kind, "unavailable");
      assert.equal(
        result.error.detail,
        "run routed off required Luna/max",
        "the port rejects the reroute before the verifier decides",
      );
    }
    assert.equal(session.closeCalls, 1);
  },
);
