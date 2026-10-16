/**
 * Bounded gateway 429 retry through the real model-port facade: fake sessions,
 * an injected clock and an injected sleep, so every backoff runs instantly.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { CodexImplementationPort } from "../../src/repair/model-port.ts";
import { SHA3 } from "../state/helpers.ts";
import {
  CHECKOUT,
  runtimeRequest,
  SCHEMA_FILE_CHANGE_ITEM,
  ScriptedSession,
} from "./model-port-helpers.ts";

const PRIMARY = "gpt-reserve";
const FAILOVER = "gpt-6-luna";
const T0 = 1_792_105_600_000;
/** The configured 30-minute session bound the hosted cells request. */
const SESSION_MS = 1_800_000;
/** The live gateway text and structured info for a 429 after Codex's retries. */
const THROTTLED_ERROR = {
  message: "exceeded retry limit, last status: 429 Too Many Requests",
  codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
};

function ack(n: number, model: string) {
  return {
    thread: { id: `thread-${n}` },
    model,
    reasoningEffort: "max",
    modelProvider: "sentinel-host",
  };
}

function failedTurn(n: number, error: Record<string, unknown>) {
  return {
    method: "turn/completed",
    params: {
      threadId: `thread-${n}`,
      turn: { id: `turn-${n}`, status: "failed", durationMs: 450, error },
    },
  };
}

function throttled(n: number, model: string): ScriptedSession {
  return new ScriptedSession(ack(n, model), { turn: { id: `turn-${n}` } }, [
    failedTurn(n, THROTTLED_ERROR),
  ]);
}

/** Only the structured CodexErrorInfo names the 429; the prose does not. */
function structuredOnly(n: number, model: string): ScriptedSession {
  return new ScriptedSession(ack(n, model), { turn: { id: `turn-${n}` } }, [
    failedTurn(n, {
      message: "exceeded retry limit",
      codexErrorInfo: {
        responseTooManyFailedAttempts: { httpStatusCode: 429 },
      },
    }),
  ]);
}

function otherFailure(n: number, model: string): ScriptedSession {
  return new ScriptedSession(ack(n, model), { turn: { id: `turn-${n}` } }, [
    failedTurn(n, { message: "synthetic failure" }),
  ]);
}

function succeeded(n: number, model: string): ScriptedSession {
  return new ScriptedSession(ack(n, model), { turn: { id: `turn-${n}` } }, [
    {
      method: "item/completed",
      params: {
        threadId: `thread-${n}`,
        turnId: `turn-${n}`,
        item: { ...SCHEMA_FILE_CHANGE_ITEM, id: `ok-${n}` },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: `thread-${n}`,
        turn: { id: `turn-${n}`, status: "completed", durationMs: 5 },
      },
    },
  ]);
}

interface Harness {
  port: CodexImplementationPort;
  sleeps: number[];
  opened: () => number;
  now: () => number;
  sessions: ScriptedSession[];
}

/**
 * A port with an injected clock and sleep. Each opened attempt costs 450 ms of
 * injected time (the live 429 latency); every sleep advances the same clock.
 */
function harness(
  sessions: ScriptedSession[],
  extra: Record<string, unknown> = {},
): Harness {
  let now = T0;
  let opened = 0;
  const sleeps: number[] = [];
  const options = {
    openSession: () => {
      const session = sessions[opened++];
      if (session === undefined) {
        return Promise.reject(new Error("no further session may open"));
      }
      now += 450;
      return Promise.resolve(session);
    },
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
    modelId: PRIMARY,
    failoverModelId: FAILOVER,
    clock: { now: () => now },
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    ...extra,
  };
  return {
    port: new CodexImplementationPort(options),
    sleeps,
    opened: () => opened,
    now: () => now,
    sessions,
  };
}

function requestedModels(sessions: ScriptedSession[]): unknown[] {
  return sessions.map((session) => {
    const start = session.sent.find((frame) => frame.method === "thread/start");
    return (start?.params as Record<string, unknown> | undefined)?.model;
  });
}

const sessionRequest = (overrides = {}) =>
  runtimeRequest({ maxDurationMs: SESSION_MS, ...overrides });

Deno.test(
  "model-port 429 retry: a primary retry after the double 429 succeeds with its own receipt",
  async () => {
    const h = harness([
      throttled(1, PRIMARY),
      throttled(2, FAILOVER),
      succeeded(3, PRIMARY),
    ]);
    const result = await h.port.runModel(sessionRequest());
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "completed");
    assert.equal(result.value.actual.observedModel, PRIMARY);
    assert.equal(result.value.actual.observedReasoning, "max");
    assert.equal(result.value.actual.threadId, "thread-3");
    assert.equal(result.value.candidate?.head, SHA3);
    assert.equal(h.opened(), 3);
    assert.deepEqual(requestedModels(h.sessions), [PRIMARY, FAILOVER, PRIMARY]);
    assert.equal(h.sleeps.length, 1, "exactly one backoff before the retry");
    assert.ok(
      h.sleeps[0] >= 20_000 && h.sleeps[0] < 40_000,
      `first backoff ${h.sleeps[0]} ms`,
    );
    for (const session of h.sessions) assert.equal(session.closeCalls, 1);
  },
);

Deno.test(
  "model-port 429 retry: retries alternate primary and failover and the failover receipt names the failover",
  async () => {
    const h = harness([
      throttled(1, PRIMARY),
      throttled(2, FAILOVER),
      throttled(3, PRIMARY),
      succeeded(4, FAILOVER),
    ]);
    const result = await h.port.runModel(sessionRequest());
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "completed");
    assert.equal(result.value.actual.observedModel, FAILOVER);
    assert.equal(result.value.actual.threadId, "thread-4");
    assert.deepEqual(requestedModels(h.sessions), [
      PRIMARY,
      FAILOVER,
      PRIMARY,
      FAILOVER,
    ]);
    const failoverStart = h.sessions[3].sent.find((frame) =>
      frame.method === "thread/start"
    )?.params as Record<string, unknown>;
    assert.deepEqual(failoverStart.config, { model_reasoning_effort: "max" });
    assert.equal(h.sleeps.length, 2);
  },
);

Deno.test(
  "model-port 429 retry: at most four bounded retries, then the last self-consistent failed receipt",
  async () => {
    const h = harness([
      throttled(1, PRIMARY),
      throttled(2, FAILOVER),
      throttled(3, PRIMARY),
      throttled(4, FAILOVER),
      throttled(5, PRIMARY),
      throttled(6, FAILOVER),
    ]);
    const result = await h.port.runModel(sessionRequest());
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.equal(result.value.outcome, "failed");
    assert.equal(result.value.candidate, null);
    assert.equal(result.value.actual.observedModel, FAILOVER);
    assert.equal(result.value.actual.threadId, "thread-6");
    assert.match(result.value.error ?? "", /429/);
    assert.equal(h.opened(), 6, "primary, failover and four retries");
    assert.deepEqual(requestedModels(h.sessions), [
      PRIMARY,
      FAILOVER,
      PRIMARY,
      FAILOVER,
      PRIMARY,
      FAILOVER,
    ]);
    assert.equal(h.sleeps.length, 4);
    h.sleeps.forEach((delay, index) => {
      const floor = Math.min(120_000, 20_000 * 2 ** index);
      assert.ok(
        delay >= floor && delay <= 120_000,
        `backoff ${index} = ${delay} ms`,
      );
    });
    assert.ok(
      h.now() - T0 <= SESSION_MS,
      "every retry stays inside the session bound",
    );
  },
);

Deno.test(
  "model-port 429 retry: jitter is deterministic per task identity, never random",
  async () => {
    const run = async (taskId: string) => {
      const h = harness([
        throttled(1, PRIMARY),
        throttled(2, FAILOVER),
        throttled(3, PRIMARY),
        throttled(4, FAILOVER),
        throttled(5, PRIMARY),
        throttled(6, FAILOVER),
      ]);
      await h.port.runModel(sessionRequest({ taskId: asWorkItemId(taskId) }));
      return h.sleeps;
    };
    const first = await run("issue-ubiquity-sentinel-501");
    const again = await run("issue-ubiquity-sentinel-501");
    assert.deepEqual(again, first, "same identity, same schedule");
    const other = await run("issue-ubiquity-sentinel-502");
    assert.equal(other.length, 4);
    assert.notDeepEqual(
      other.slice(0, 3),
      first.slice(0, 3),
      "another task spreads differently",
    );
  },
);

Deno.test(
  "model-port 429 retry: the structured CodexErrorInfo 429 alone also counts as rate limited",
  async () => {
    const h = harness([
      structuredOnly(1, PRIMARY),
      structuredOnly(2, FAILOVER),
      succeeded(3, PRIMARY),
    ]);
    const result = await h.port.runModel(sessionRequest());
    assert.ok(result.ok && result.value.outcome === "completed");
    assert.equal(h.opened(), 3);
  },
);

Deno.test(
  "model-port 429 retry: a non-429 failure is never retried by the backoff loop",
  async () => {
    // The failover attempt fails for another reason: no backoff starts.
    const failover = harness([
      throttled(1, PRIMARY),
      otherFailure(2, FAILOVER),
    ]);
    const first = await failover.port.runModel(sessionRequest());
    assert.ok(first.ok && first.value.outcome === "failed");
    assert.equal(first.value.error, "synthetic failure");
    assert.equal(failover.opened(), 2);
    assert.deepEqual(failover.sleeps, []);

    // A retry that fails for another reason stops the loop at once.
    const retry = harness([
      throttled(1, PRIMARY),
      throttled(2, FAILOVER),
      otherFailure(3, PRIMARY),
    ]);
    const second = await retry.port.runModel(sessionRequest());
    assert.ok(second.ok && second.value.outcome === "failed");
    assert.equal(second.value.error, "synthetic failure");
    assert.equal(retry.opened(), 3);
    assert.equal(retry.sleeps.length, 1);

    // A non-429 primary failure never reaches the failover or the loop.
    const primary = harness([otherFailure(1, PRIMARY)]);
    const third = await primary.port.runModel(sessionRequest());
    assert.ok(third.ok && third.value.error === "synthetic failure");
    assert.equal(primary.opened(), 1);
    assert.deepEqual(primary.sleeps, []);
  },
);

Deno.test(
  "model-port 429 retry: without a configured failover the 429 is returned with no retry",
  async () => {
    const h = harness([throttled(1, PRIMARY)], { failoverModelId: "" });
    const result = await h.port.runModel(sessionRequest());
    assert.ok(result.ok && result.value.outcome === "failed");
    assert.equal(h.opened(), 1);
    assert.deepEqual(h.sleeps, []);
  },
);

Deno.test(
  "model-port 429 retry: a backoff that cannot fit the remaining session budget never starts",
  async () => {
    // A 5-second session: the failover fits its remainder, but no 20-second
    // backoff plus a working window does.
    const short = harness([throttled(1, PRIMARY), throttled(2, FAILOVER)]);
    const tiny = await short.port.runModel(runtimeRequest());
    assert.ok(tiny.ok && tiny.value.outcome === "failed");
    assert.equal(short.opened(), 2);
    assert.deepEqual(short.sleeps, []);

    // The session started 29 minutes before this port ran (the admission
    // anchor): one minute is left, so neither the failover nor a backoff
    // starts.
    const late = harness([throttled(1, PRIMARY), throttled(2, FAILOVER)], {
      sessionStartedAt: T0 - 1_740_000,
    });
    const anchored = await late.port.runModel(sessionRequest());
    assert.ok(anchored.ok && anchored.value.outcome === "failed");
    assert.equal(late.opened(), 1);
    assert.deepEqual(late.sleeps, []);

    // A five-minute session fits some, never all four, backoffs, and the
    // last retry still starts with a working window before the bound.
    const sessions = Array.from(
      { length: 6 },
      (_, index) => throttled(index + 1, index % 2 === 0 ? PRIMARY : FAILOVER),
    );
    const partial = harness(sessions);
    const bounded = await partial.port.runModel(
      runtimeRequest({ maxDurationMs: 300_000 }),
    );
    assert.ok(bounded.ok && bounded.value.outcome === "failed");
    assert.ok(
      partial.sleeps.length >= 1 && partial.sleeps.length < 4,
      `retries ${partial.sleeps.length}`,
    );
    assert.equal(partial.opened(), 2 + partial.sleeps.length);
    assert.ok(partial.now() - T0 <= 300_000);
  },
);
