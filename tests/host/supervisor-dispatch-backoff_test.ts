import assert from "node:assert/strict";
import { runSupervisorDispatch } from "../../src/host/supervisor-dispatch.ts";
import {
  BACKOFF_HOLD_MAX_MS,
  backoffDelayMs,
} from "../../src/host/supervisor-dispatch-backoff.ts";
import {
  FollowFake,
  L,
  NOW,
  OLDER,
  response,
  supervisorRun,
} from "./hosted-runtime-follow-fixtures.ts";

const MINUTE = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A completed run (newest first by id order below) that took `tookMs`. */
function completed(
  id: number,
  head: string,
  conclusion: string,
  completedMs: number,
  tookMs = 2 * MINUTE,
) {
  return supervisorRun(head, id, {
    status: "completed",
    conclusion,
    created_at: iso(completedMs - tookMs),
    run_started_at: iso(completedMs - tookMs),
    updated_at: iso(completedMs),
  });
}

/** `count` fast failures at `head`, the newest completed at `newestMs`. */
function failures(count: number, head = L, newestMs = NOW - MINUTE) {
  return Array.from(
    { length: count },
    (_, index) =>
      completed(800 - index, head, "failure", newestMs - index * 2 * MINUTE),
  );
}

async function hop(
  runs: Record<string, unknown>[],
  options: { successorStatus?: number; listingStatus?: number } = {},
) {
  const api = new FollowFake();
  api.supervisorRuns = runs;
  const successors: unknown[] = [];
  api.intercept = (request, url) => {
    if (
      request.method === "POST" &&
      url.pathname.endsWith(
        "/actions/workflows/supervisor-dispatch.yml/dispatches",
      )
    ) {
      successors.push(JSON.parse(request.body!));
      return response(null, options.successorStatus ?? 204);
    }
    if (
      options.listingStatus !== undefined &&
      url.pathname.endsWith("/actions/workflows/supervisor.yml/runs") &&
      url.searchParams.get("status") === "completed"
    ) return response({ message: "unavailable" }, options.listingStatus);
    return undefined;
  };
  const logs: Record<string, unknown>[] = [];
  const sleeps: number[] = [];
  const result = await runSupervisorDispatch({
    http: api.http,
    token: "fake-token",
    clock: { now: () => NOW },
    log: (line) => logs.push(line),
    pause: () => Promise.resolve(),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    follow: { expectedSha: L, ready: true, pause: () => Promise.resolve() },
  });
  const backoff = logs.filter((line) => line.event === "dispatch_backoff");
  return { api, result, successors, sleeps, backoff };
}

Deno.test("dispatch backoff: the delay is 0 below three fast failures, then 5, 10, 20 and at most 30 minutes", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6, 7, 40].map((streak) =>
      backoffDelayMs(streak) / MINUTE
    ),
    [0, 0, 0, 5, 10, 20, 30, 30, 30],
  );
});

Deno.test("dispatch backoff: a streak chains its successor first, holds within the job and never dispatches the supervisor", async () => {
  const { api, result, successors, sleeps, backoff } = await hop(failures(3));
  assert.equal(result.exitCode, 0);
  assert.equal(result.dispatched, false);
  assert.equal(api.dispatches, 0);
  assert.deepEqual(successors, [{ ref: "development" }]);
  // Due 5 minutes after the newest failure, which completed 1 minute ago.
  assert.deepEqual(sleeps, [BACKOFF_HOLD_MAX_MS]);
  assert.deepEqual(backoff, [{
    event: "dispatch_backoff",
    decision: "held",
    reason: "fast_failure_streak",
    streak: 3,
    delayMs: 5 * MINUTE,
    dueAt: iso(NOW + 4 * MINUTE),
    holdMs: BACKOFF_HOLD_MAX_MS,
  }]);
  const post = api.requests.findIndex((request) => request.method === "POST");
  assert.ok(
    api.requests[post].url.endsWith("/supervisor-dispatch.yml/dispatches"),
  );
  assert.equal(api.requests.filter((r) => r.method === "POST").length, 1);
});

Deno.test("dispatch backoff: longer streaks owe longer delays up to the cap, and an elapsed delay dispatches", async () => {
  for (
    const [streak, newestAgo, held] of [
      [4, 9 * MINUTE, true],
      [4, 11 * MINUTE, false],
      [5, 19 * MINUTE, true],
      [6, 29 * MINUTE, true],
      [9, 29 * MINUTE, true],
      [9, 31 * MINUTE, false],
    ] as const
  ) {
    const { api, result, backoff, sleeps } = await hop(
      failures(streak, L, NOW - newestAgo),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.dispatched, !held, `${streak}/${newestAgo}`);
    assert.equal(api.dispatches, held ? 0 : 1);
    assert.equal(backoff.length, 1);
    assert.equal(backoff[0].streak, Math.min(streak, 10));
    assert.equal(backoff[0].delayMs, backoffDelayMs(streak));
    assert.equal(
      backoff[0].reason,
      held ? "fast_failure_streak" : "backoff_elapsed",
    );
    if (held) {
      assert.deepEqual(sleeps, [
        Math.min(backoffDelayMs(streak) - newestAgo, BACKOFF_HOLD_MAX_MS),
      ]);
    } else assert.deepEqual(sleeps, []);
  }
});

Deno.test("dispatch backoff: one success, a new launcher SHA, a slow failure or a short streak dispatches immediately", async () => {
  const cases = [
    [completed(850, L, "success", NOW - MINUTE), ...failures(5)],
    failures(5, OLDER),
    [completed(850, L, "failure", NOW - MINUTE, 30 * MINUTE), ...failures(5)],
    failures(2),
    [completed(850, L, "cancelled", NOW - MINUTE), ...failures(5)],
    [],
  ];
  for (const runs of cases) {
    const { api, result, successors, sleeps, backoff } = await hop(runs);
    assert.equal(result.exitCode, 0);
    assert.equal(result.dispatched, true);
    assert.equal(api.dispatches, 1);
    assert.deepEqual(successors, []);
    assert.deepEqual(sleeps, []);
    assert.deepEqual(backoff, []);
  }
});

Deno.test("dispatch backoff: only a failure within three minutes of its start is fast", async () => {
  for (const [tookMs, held] of [[3 * MINUTE, true], [3 * MINUTE + 1, false]]) {
    const runs = failures(3).map((run, index) =>
      index === 2
        ? completed(798, L, "failure", NOW - 5 * MINUTE, tookMs as number)
        : run
    );
    const { result, successors } = await hop(runs);
    assert.equal(result.dispatched, !held, `${tookMs}`);
    assert.equal(successors.length, held ? 1 : 0);
  }
});

Deno.test("dispatch backoff: a startup failure counts as a fast failure", async () => {
  const runs = failures(3).map((run, index) =>
    index === 1 ? { ...run, conclusion: "startup_failure" } : run
  );
  const { result, successors } = await hop(runs);
  assert.equal(result.dispatched, false);
  assert.equal(successors.length, 1);
});

Deno.test("dispatch backoff: an unreadable or malformed listing and a refused successor fail open to today's dispatch", async () => {
  const unreadable = await hop(failures(5), { listingStatus: 500 });
  assert.equal(unreadable.result.dispatched, true);
  assert.equal(unreadable.api.dispatches, 1);
  assert.deepEqual(unreadable.backoff.map((line) => line.reason), [
    "listing_unavailable",
  ]);
  const malformed = await hop([
    ...failures(4),
    { ...completed(1, L, "failure", NOW), created_at: "not a time" },
  ]);
  assert.equal(malformed.result.dispatched, true);
  assert.deepEqual(malformed.backoff.map((line) => line.reason), [
    "listing_unavailable",
  ]);
  const refused = await hop(failures(5), { successorStatus: 403 });
  assert.equal(refused.result.exitCode, 0);
  assert.equal(refused.result.dispatched, true);
  assert.equal(refused.api.dispatches, 1);
  assert.deepEqual(refused.sleeps, []);
  assert.deepEqual(refused.backoff.map((line) => line.reason), [
    "successor_unavailable",
  ]);
});

Deno.test("dispatch backoff: an in-flight supervisor never reads the streak", async () => {
  const active = await hop([
    supervisorRun(L, 950, { status: "in_progress" }),
    ...failures(5),
  ]);
  assert.equal(active.result.dispatched, false);
  assert.deepEqual(active.successors, []);
  assert.deepEqual(active.backoff, []);
  assert.equal(
    active.api.requests.some((request) =>
      new URL(request.url).searchParams.get("status") === "completed"
    ),
    false,
  );
});
