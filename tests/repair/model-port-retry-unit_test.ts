/** Unit cases for the bounded 429 backoff schedule, loop and predicate. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import {
  type ModelRunReceiptV1,
  portError,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import {
  isProviderThrottledReceiptV1,
  RATE_LIMIT_RETRY_LIMIT,
  RATE_LIMIT_RETRY_MAX_DELAY_MS,
  RATE_LIMIT_RETRY_MIN_WINDOW_MS,
  rateLimitRetryDelayMs,
  retryRateLimitedV1,
  sessionBudgetAnchorV1,
} from "../../src/repair/model-port-retry.ts";
import { awaitSettlement } from "../../src/repair/model-port-settlement.ts";
import {
  CHECKOUT,
  runtimeRequest,
  ScriptedSession,
} from "./model-port-helpers.ts";

const T0 = 1_792_105_600_000;
const SESSION_MS = 1_800_000;

function receipt(
  overrides: Partial<ModelRunReceiptV1> = {},
  actual: Partial<ModelRunReceiptV1["actual"]> = {},
): ModelRunReceiptV1 {
  return {
    invocationId: "codex-unit-1",
    outcome: "failed",
    actual: {
      evidenceKind: "request-runtime",
      provider: "sentinel-host",
      threadId: "thread-1",
      turnId: "turn-1",
      terminalOrigin: "runtime",
      observedTerminalStatus: "failed",
      observedModel: "gpt-reserve",
      observedReasoning: "max",
      durationMs: 450,
      outputChars: 10,
      ...actual,
    },
    candidate: null,
    error: "exceeded retry limit, last status: 429 Too Many Requests",
    ...overrides,
  };
}

Deno.test("429 backoff: bounded exponential floors with identity jitter", () => {
  const request = runtimeRequest();
  const random = Math.random;
  Math.random = () => {
    throw new Error("the backoff must never use Math.random");
  };
  try {
    for (let index = 0; index < RATE_LIMIT_RETRY_LIMIT; index++) {
      const delay = rateLimitRetryDelayMs(request, index);
      const floor = Math.min(
        RATE_LIMIT_RETRY_MAX_DELAY_MS,
        20_000 * 2 ** index,
      );
      assert.ok(Number.isSafeInteger(delay));
      assert.ok(delay >= floor && delay <= RATE_LIMIT_RETRY_MAX_DELAY_MS);
      assert.ok(delay < 2 * floor || delay === RATE_LIMIT_RETRY_MAX_DELAY_MS);
      assert.equal(rateLimitRetryDelayMs(request, index), delay);
    }
  } finally {
    Math.random = random;
  }
  // Sibling cells started in the same second spread across the first window.
  const firsts = new Set(
    Array.from({ length: 17 }, (_, index) =>
      rateLimitRetryDelayMs(
        runtimeRequest({ taskId: asWorkItemId(`issue-ubiquity-x-${index}`) }),
        0,
      )),
  );
  assert.ok(firsts.size >= 15, `distinct first backoffs: ${firsts.size}`);
});

Deno.test("429 backoff: the budget anchor can only move earlier", () => {
  assert.equal(sessionBudgetAnchorV1(T0, undefined), T0);
  assert.equal(sessionBudgetAnchorV1(T0, T0 - 5_000), T0 - 5_000);
  assert.equal(sessionBudgetAnchorV1(T0, T0 + 5_000), T0);
  assert.equal(sessionBudgetAnchorV1(T0, Number.NaN), T0);
});

function loop(
  results: PortResultV1<ModelRunReceiptV1>[],
  input: { budgetEndsAt?: number; maxDurationMs?: number } = {},
) {
  let now = T0;
  const attempts: { model: string; windowMs: number; at: number }[] = [];
  const sleeps: number[] = [];
  const request = runtimeRequest({
    maxDurationMs: input.maxDurationMs ?? SESSION_MS,
  });
  const run = retryRateLimitedV1({
    request,
    models: ["gpt-reserve", "gpt-6-luna"],
    budgetEndsAt: input.budgetEndsAt ?? T0 + SESSION_MS,
    last: portOk(receipt({}, { observedModel: "gpt-6-luna" })),
    now: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    attempt: (model, windowMs) => {
      attempts.push({ model, windowMs, at: now });
      now += 1_000;
      const next = results.shift();
      if (next === undefined) throw new Error("no further attempt expected");
      return Promise.resolve(next);
    },
  });
  return { run, attempts, sleeps, now: () => now };
}

Deno.test("429 backoff: retries alternate models inside the remaining budget", async () => {
  const throttled = () => portOk(receipt());
  const h = loop([throttled(), throttled(), throttled(), throttled()]);
  const result = await h.run;
  assert.ok(result.ok && result.value.outcome === "failed");
  assert.deepEqual(h.attempts.map((attempt) => attempt.model), [
    "gpt-reserve",
    "gpt-6-luna",
    "gpt-reserve",
    "gpt-6-luna",
  ]);
  assert.equal(h.sleeps.length, RATE_LIMIT_RETRY_LIMIT);
  for (const attempt of h.attempts) {
    assert.equal(
      attempt.windowMs,
      Math.min(SESSION_MS, T0 + SESSION_MS - attempt.at),
      "each retry session is bounded by the remaining session budget",
    );
    assert.ok(attempt.windowMs >= RATE_LIMIT_RETRY_MIN_WINDOW_MS);
  }
});

Deno.test("429 backoff: a short budget, a non-429 result or a bad bound stops the loop", async () => {
  // Only the first backoff plus a working window fits this budget.
  const first = rateLimitRetryDelayMs(runtimeRequest(), 0);
  const second = rateLimitRetryDelayMs(runtimeRequest(), 1);
  const tight = loop([portOk(receipt()), portOk(receipt())], {
    budgetEndsAt: T0 + first + 1_000 + second + RATE_LIMIT_RETRY_MIN_WINDOW_MS -
      1,
  });
  await tight.run;
  assert.equal(tight.attempts.length, 1);
  assert.ok(
    tight.attempts[0].at + tight.attempts[0].windowMs <=
      T0 + first + 1_000 + second + RATE_LIMIT_RETRY_MIN_WINDOW_MS,
  );

  const other = loop([portOk(receipt({ error: "synthetic failure" }))]);
  const stopped = await other.run;
  assert.ok(stopped.ok && stopped.value.error === "synthetic failure");
  assert.equal(other.attempts.length, 1);

  const unavailable = loop([
    portError("unavailable", "codex session unavailable"),
  ]);
  const portFailure = await unavailable.run;
  assert.equal(portFailure.ok, false, "a port error is never retried");
  assert.equal(unavailable.attempts.length, 1);

  for (const maxDurationMs of [0, -1, Number.NaN, 1.5]) {
    const bad = loop([], { maxDurationMs });
    await bad.run;
    assert.equal(bad.attempts.length, 0, String(maxDurationMs));
  }
});

Deno.test("429 predicate: only a whole throttled failed runtime turn qualifies", () => {
  assert.equal(isProviderThrottledReceiptV1(receipt()), true);
  assert.equal(
    isProviderThrottledReceiptV1(receipt({ error: "429 too many requests" })),
    true,
  );
  const never: ModelRunReceiptV1[] = [
    // The matrix cell's exported, sanitized projection.
    receipt({ error: "runtime_error" }),
    receipt({ error: "failed_command_loop" }),
    receipt({ error: "usage limit reached for this billing period" }),
    receipt({ error: null }),
    receipt({ outcome: "interrupted" }, {
      observedTerminalStatus: "interrupted",
    }),
    receipt({}, {
      terminalOrigin: "host-timeout",
      observedTerminalStatus: null,
    }),
  ];
  for (const candidate of never) {
    assert.equal(
      isProviderThrottledReceiptV1(candidate),
      false,
      candidate.error ?? "",
    );
  }
});

Deno.test("429 settlement: a retry window only shortens the request bound", async () => {
  const hanging = () =>
    new ScriptedSession(
      {
        thread: { id: "thread-1" },
        model: "gpt-reserve",
        reasoningEffort: "max",
        modelProvider: "sentinel-host",
      },
      { turn: { id: "turn-1" } },
      [],
      "interrupted",
    );
  const request = runtimeRequest({ maxDurationMs: 5_000 });
  const started = Date.now();
  const capture = await awaitSettlement(
    CHECKOUT,
    20,
    hanging(),
    request,
    "thread-1",
    "turn-1",
    request.maxOutputChars,
    30,
  );
  assert.ok(Date.now() - started < 2_000, "interrupted at the 30 ms window");
  const settled = capture();
  assert.equal(settled.terminal?.status, "interrupted");
  assert.equal(settled.boundaryDiagnostic.interruptCause, "duration_limit");
  assert.equal(
    settled.boundaryDiagnostic.maxDurationMs,
    5_000,
    "the diagnostic keeps the request's own bound",
  );

  // A window longer than the request bound never extends it.
  const short = runtimeRequest({ maxDurationMs: 30 });
  const longStarted = Date.now();
  const longCapture = await awaitSettlement(
    CHECKOUT,
    20,
    hanging(),
    short,
    "thread-1",
    "turn-1",
    short.maxOutputChars,
    600_000,
  );
  assert.ok(Date.now() - longStarted < 2_000);
  assert.equal(
    longCapture().boundaryDiagnostic.interruptCause,
    "duration_limit",
  );
});
