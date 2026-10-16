/**
 * The immediate 429 failover runs inside what remains of the session budget,
 * and the throttle predicate reads the status code exactly: a definite
 * structured status outranks the prose, and "429" only counts standalone.
 */
import assert from "node:assert/strict";
import { isRateLimitMessage } from "../../src/repair/model-port-policy.ts";
import { failoverWindowMsV1 } from "../../src/repair/model-port-retry.ts";
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
const SESSION_MS = 1_800_000;

function ack(n: number, model: string) {
  return {
    thread: { id: `thread-${n}` },
    model,
    reasoningEffort: "max",
    modelProvider: "sentinel-host",
  };
}

function failed(n: number, model: string, error: Record<string, unknown>) {
  return new ScriptedSession(ack(n, model), { turn: { id: `turn-${n}` } }, [{
    method: "turn/completed",
    params: {
      threadId: `thread-${n}`,
      turn: { id: `turn-${n}`, status: "failed", durationMs: 450, error },
    },
  }]);
}

const THROTTLED = {
  message: "exceeded retry limit, last status: 429 Too Many Requests",
  codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
};

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

/** Opening session `i` costs `costs[i]` ms of injected time. */
function harness(sessions: ScriptedSession[], costs: number[]) {
  let now = T0;
  let opened = 0;
  const port = new CodexImplementationPort({
    openSession: () => {
      const session = sessions[opened];
      if (session === undefined) {
        return Promise.reject(new Error("no further session may open"));
      }
      now += costs[opened++] ?? 450;
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
      now += ms;
      return Promise.resolve();
    },
  });
  return { port, opened: () => opened };
}

const request = () => runtimeRequest({ maxDurationMs: SESSION_MS });

Deno.test("failover budget: the window is what remains of the session, or none", () => {
  assert.equal(failoverWindowMsV1(SESSION_MS, T0 + SESSION_MS, T0), SESSION_MS);
  assert.equal(
    failoverWindowMsV1(SESSION_MS, T0 + SESSION_MS, T0 + 600_000),
    1_200_000,
  );
  // Less than the minimum useful window: the failover is not started.
  assert.equal(
    failoverWindowMsV1(SESSION_MS, T0 + SESSION_MS, T0 + 1_700_000),
    null,
  );
  // A window never exceeds the request's own bound.
  assert.equal(failoverWindowMsV1(60_000, T0 + SESSION_MS, T0), 60_000);
  // A short bound needs half of itself left, not the full retry minimum.
  assert.equal(failoverWindowMsV1(5_000, T0 + 5_000, T0 + 450), 4_550);
  assert.equal(failoverWindowMsV1(5_000, T0 + 5_000, T0 + 2_600), null);
  assert.equal(failoverWindowMsV1(0, T0 + SESSION_MS, T0), null);
  assert.equal(failoverWindowMsV1(SESSION_MS, Number.NaN, T0), null);
});

Deno.test("failover budget: a primary that spent the session budget never starts the failover", async () => {
  // The primary ran 29 minutes before its 429: 60 s remain, under the minimum.
  const h = harness(
    [failed(1, PRIMARY, THROTTLED), succeeded(2, FAILOVER)],
    [SESSION_MS - 60_000],
  );
  const result = await h.port.runModel(request());
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.outcome, "failed");
  assert.equal(result.value.actual.observedModel, PRIMARY);
  assert.equal(h.opened(), 1, "no failover past the session budget");
});

Deno.test("failover budget: a primary that left enough budget still fails over", async () => {
  const h = harness(
    [failed(1, PRIMARY, THROTTLED), succeeded(2, FAILOVER)],
    [SESSION_MS - 600_000],
  );
  const result = await h.port.runModel(request());
  assert.ok(result.ok && result.value.outcome === "completed");
  assert.equal(result.value.actual.observedModel, FAILOVER);
  assert.equal(h.opened(), 2);
});

Deno.test("throttle predicate: a definite non-429 structured status outranks rate-limit prose", async () => {
  const h = harness([
    failed(1, PRIMARY, {
      message: "upstream rate limit exceeded",
      codexErrorInfo: {
        responseTooManyFailedAttempts: { httpStatusCode: 503 },
      },
    }),
    succeeded(2, FAILOVER),
  ], []);
  const result = await h.port.runModel(request());
  assert.ok(result.ok && result.value.outcome === "failed");
  assert.equal(h.opened(), 1, "a 503 is not a rate limit");
});

Deno.test("throttle predicate: 429 counts only as a standalone number", () => {
  assert.equal(isRateLimitMessage("last status: 429 Too Many Requests"), true);
  assert.equal(isRateLimitMessage("provider error 429: slow down"), true);
  assert.equal(isRateLimitMessage("HTTP/429"), true);
  assert.equal(isRateLimitMessage("429"), true);
  assert.equal(isRateLimitMessage("context used 14290 tokens"), false);
  assert.equal(isRateLimitMessage("request id 4291a"), false);
  assert.equal(isRateLimitMessage("synthetic failure"), false);
  assert.equal(isRateLimitMessage("Too Many Requests"), true);
});
