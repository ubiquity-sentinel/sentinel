/**
 * Sentinel issue #192: the head CI read (`readChecks`) folds the head's commit
 * statuses into its check runs. A third-party status left `pending` (a stale
 * integration, a preview deployment that never reports) used to hold every
 * gate reading that list (`decideCiGate`) until the six-hour pre-review park,
 * even with every check run green. A context whose latest status is pending is
 * now advisory once the head reports at least one check run and every check
 * run has completed; failed, errored and successful statuses are read exactly
 * as before, a pending status still waits while a check run runs or when the
 * head has no check run at all, and a name-filtered read returns its statuses
 * as recorded. All fixtures are synthetic, over the real client and a scripted
 * transport.
 */
import assert from "node:assert/strict";
import { decideCiGate } from "../../src/repair/loop-checks.ts";
import {
  checkRunWire,
  checksPageWire,
  commitStatusWire,
  httpRespond,
  makePort,
  SHA1,
  statusesPageWire,
} from "./helpers.ts";

const COMMIT = `/repos/ubiquity-sentinel/sentinel/commits/${SHA1}`;

function read(
  runs: unknown[],
  statuses: unknown[],
  names?: ReadonlySet<string>,
) {
  const { port } = makePort({
    script: [
      httpRespond(
        "GET",
        `${COMMIT}/check-runs?per_page=100&page=1`,
        200,
        checksPageWire(runs),
      ),
      httpRespond(
        "GET",
        `${COMMIT}/statuses?per_page=100&page=1`,
        200,
        statusesPageWire(statuses),
      ),
    ],
  });
  return port.readChecks(SHA1, names);
}

const GREEN_RUNS = [
  checkRunWire({ name: "validate" }),
  checkRunWire({ name: "test", conclusion: "skipped" }),
];

/** A preview status created hours ago that never reported. */
const STALE_PENDING = commitStatusWire({
  context: "preview/deploy",
  state: "pending",
  created_at: "2026-09-07T00:00:00Z",
  updated_at: "2026-09-07T00:00:00Z",
});

Deno.test("readChecks (#192): a stale pending status on a head whose check runs are all green is advisory; the gate proceeds", async () => {
  const result = await read(GREEN_RUNS, [STALE_PENDING]);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value.checks.map((check) => check.name), [
    "validate",
    "test",
  ]);
  assert.equal(decideCiGate(result.value.checks), "proceed");
});

for (const state of ["failure", "error"] as const) {
  Deno.test(`readChecks (#192): ${state === "error" ? "an" : "a"} ${state} status still fails a head whose check runs are green`, async () => {
    const result = await read(GREEN_RUNS, [
      commitStatusWire({
        context: "preview/deploy",
        state,
        created_at: "2026-09-07T01:00:00Z",
        updated_at: "2026-09-07T01:05:00Z",
      }),
      STALE_PENDING,
    ]);
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    const status = result.value.checks.filter((check) =>
      check.name === "preview/deploy"
    );
    assert.equal(status.length, 2, "the whole history is read as before");
    assert.deepEqual(decideCiGate(result.value.checks), {
      blocked: "CI checks failed: preview/deploy(failure)",
    });
  });
}

Deno.test("readChecks (#192): a pending status while a check run still runs is read and waits", async () => {
  const result = await read([
    checkRunWire({ name: "validate" }),
    checkRunWire({
      name: "test",
      status: "in_progress",
      conclusion: null,
      completed_at: null,
    }),
  ], [STALE_PENDING]);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value.checks.map((check) => check.name), [
    "validate",
    "test",
    "preview/deploy",
  ]);
  assert.equal(decideCiGate(result.value.checks), "wait");
});

Deno.test("readChecks (#192): a head without check runs keeps its pending status (a status-only CI still waits)", async () => {
  const result = await read([], [STALE_PENDING]);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value.checks.map((check) => check.name), [
    "preview/deploy",
  ]);
  assert.equal(decideCiGate(result.value.checks), "wait");
});

Deno.test("readChecks (#192): a status never turns a red check run green", async () => {
  const result = await read([
    checkRunWire({ name: "validate", conclusion: "failure" }),
  ], [STALE_PENDING, commitStatusWire({ context: "lint", state: "success" })]);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(decideCiGate(result.value.checks), {
    blocked: "CI checks failed: validate(failure)",
  });
});

Deno.test("readChecks (#192): only a context's latest status decides; a superseded observation never resurfaces", async () => {
  // Newest first, as GitHub returns them. `deploy` reported success after
  // its pending start: read as before. `preview` was re-run after a
  // failure and is pending again: advisory as a whole, so its superseded
  // failure is not read as the head's current state.
  const result = await read(GREEN_RUNS, [
    commitStatusWire({
      context: "preview",
      state: "pending",
      created_at: "2026-09-07T02:00:00Z",
      updated_at: "2026-09-07T02:00:00Z",
    }),
    commitStatusWire({
      context: "deploy",
      state: "success",
      created_at: "2026-09-07T01:00:00Z",
      updated_at: "2026-09-07T01:01:00Z",
    }),
    commitStatusWire({
      context: "preview",
      state: "failure",
      created_at: "2026-09-07T01:00:00Z",
      updated_at: "2026-09-07T01:00:00Z",
    }),
    commitStatusWire({
      context: "deploy",
      state: "pending",
      created_at: "2026-09-07T00:00:00Z",
      updated_at: "2026-09-07T00:00:00Z",
    }),
  ]);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(
    result.value.checks.map((check) => [check.name, check.status]),
    [
      ["validate", "completed"],
      ["test", "completed"],
      ["deploy", "completed"],
      ["deploy", "in_progress"],
    ],
  );
  assert.equal(decideCiGate(result.value.checks), "proceed");
});

Deno.test("readChecks (#192): a name-filtered read returns the named statuses as recorded", async () => {
  // The base attribution of given head failures asks for exact names; it
  // never judges every check run of the commit, so nothing is advisory.
  const result = await read(
    GREEN_RUNS,
    [STALE_PENDING],
    new Set(["validate", "preview/deploy"]),
  );
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(
    result.value.checks.map((check) => [check.name, check.status]),
    [["validate", "completed"], ["preview/deploy", "in_progress"]],
  );
});
