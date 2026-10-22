import assert from "node:assert/strict";
import { runSupervisorDispatch } from "../../src/host/supervisor-dispatch.ts";
import { dispatchFollowedSupervisor } from "../../src/host/hosted-runtime-follow-dispatch.ts";
import {
  D,
  FollowFake,
  L,
  NOW,
  OLDER,
  response,
  supervisorRun,
} from "./hosted-runtime-follow-fixtures.ts";

const ACTIVE_ISO = new Date(NOW).toISOString();
const STALE_ISO = new Date(NOW - 31 * 60_000).toISOString();

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    status: "queued",
    conclusion: null,
    created_at: STALE_ISO,
    started_at: STALE_ISO,
    completed_at: null,
    runner_id: null,
    runner_name: null,
    ...overrides,
  };
}

const dispatch = async (api: FollowFake, expectedSha = L, ready = true) => {
  const logs: Record<string, unknown>[] = [];
  const result = await runSupervisorDispatch({
    http: api.http,
    token: "fake-token",
    clock: { now: () => NOW },
    log: (line) => logs.push(line),
    follow: { expectedSha, ready, pause: () => Promise.resolve() },
  });
  return { result, logs };
};

Deno.test("follow and the real dispatcher connect advance, exact-ref dispatch and native github.sha verification", async () => {
  const api = new FollowFake();
  const followed = await api.follow();
  const { result, logs } = await dispatch(
    api,
    followed.launcherSha!,
    followed.safeToDispatch,
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.dispatched, true);
  assert.equal(api.dispatches, 1);
  assert.ok(
    logs.some((line) =>
      line.event === "follow_dispatch" && line.decision === "verified" &&
      line.githubSha === OLDER
    ),
  );
  const mutationIndex = api.requests.findIndex((request) =>
    request.url.endsWith("/graphql")
  );
  const dispatchIndex = api.requests.findIndex((request) =>
    request.method === "POST" && request.url.endsWith("/dispatches")
  );
  assert.ok(mutationIndex < dispatchIndex);
  assert.ok(
    api.requests.slice(mutationIndex + 1, dispatchIndex).some((request) =>
      request.url.endsWith("/git/ref/heads/sentinel-supervisor")
    ),
  );
});

Deno.test("follow dispatcher prevents a duplicate when the previous dispatch is queued or running", async () => {
  const api = new FollowFake();
  assert.equal((await dispatch(api)).result.dispatched, true);
  assert.equal((await dispatch(api)).result.dispatched, false);
  api.supervisorRuns[0].status = "in_progress";
  assert.equal((await dispatch(api)).result.dispatched, false);
  assert.equal(api.dispatches, 1);
});

Deno.test("follow dispatcher keeps a scan-positive active run when the later filtered listing is empty", async () => {
  const api = new FollowFake();
  const activeId = 80;
  api.supervisorRuns = [supervisorRun(L, activeId, {
    status: "in_progress",
    created_at: ACTIVE_ISO,
    updated_at: ACTIVE_ISO,
  })];
  let filteredActiveChecks = 0;
  api.intercept = (request, url) => {
    if (
      request.method === "GET" &&
      url.pathname.endsWith(`/actions/runs/${activeId}/jobs`)
    ) {
      return response({
        total_count: 1,
        jobs: [job({
          status: "in_progress",
          started_at: ACTIVE_ISO,
          runner_id: 1,
          runner_name: "runner-1",
        })],
      });
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith("/actions/workflows/supervisor.yml/runs") &&
      url.searchParams.get("event") === "workflow_dispatch" &&
      url.searchParams.has("status")
    ) {
      filteredActiveChecks += 1;
      return response({ total_count: 0, workflow_runs: [] });
    }
    return undefined;
  };

  const { result, logs } = await dispatch(api);
  assert.equal(filteredActiveChecks, 5);
  assert.equal(result.dispatched, false);
  assert.equal(result.exitCode, 0);
  assert.equal(result.cancelledRunId, null);
  assert.equal(api.dispatches, 0);
  assert.ok(
    logs.some((line) =>
      line.event === "follow_dispatch" && line.decision === "skipped" &&
      line.reason === "supervisor_in_flight"
    ),
  );
});

Deno.test("follow dispatcher dispatches when the same pass observed no active run", async () => {
  const api = new FollowFake();
  const { result } = await dispatch(api);
  assert.equal(result.dispatched, true);
  assert.equal(result.exitCode, 0);
  assert.equal(api.dispatches, 1);
});

Deno.test("follow dispatcher allows dispatch after the pass cancels its only observed stale run", async () => {
  const api = new FollowFake();
  const staleId = 81;
  api.supervisorRuns = [supervisorRun(L, staleId, {
    created_at: STALE_ISO,
    updated_at: STALE_ISO,
  })];
  api.intercept = (request, url) => {
    if (
      request.method === "GET" &&
      url.pathname.endsWith(`/actions/runs/${staleId}/jobs`)
    ) {
      return response({ total_count: 1, jobs: [job()] });
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith(`/actions/runs/${staleId}/pending_deployments`)
    ) {
      return response([]);
    }
    if (
      request.method === "POST" &&
      url.pathname.endsWith(`/actions/runs/${staleId}/force-cancel`)
    ) {
      return response({}, 202);
    }
    if (
      request.method === "GET" &&
      url.pathname.endsWith("/actions/workflows/supervisor.yml/runs") &&
      url.searchParams.get("event") === "workflow_dispatch" &&
      url.searchParams.has("status")
    ) {
      return response({ total_count: 0, workflow_runs: [] });
    }
    return undefined;
  };

  const { result } = await dispatch(api);
  assert.equal(result.recovery, "recovered");
  assert.equal(result.cancelledRunId, staleId);
  assert.equal(result.dispatched, true);
  assert.equal(api.dispatches, 1);
  assert.equal(
    api.requests.filter((request) =>
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith(
        `/actions/runs/${staleId}/force-cancel`,
      )
    ).length,
    1,
  );
});

Deno.test("follow dispatcher refuses ref drift and a failed follow readback before POST", async () => {
  const api = new FollowFake();
  api.launcher = D;
  const moved = await dispatch(api);
  assert.equal(moved.result.exitCode, 1);
  assert.equal(api.dispatches, 0);
  api.launcher = L;
  const blocked = await dispatch(api, L, false);
  assert.equal(blocked.result.exitCode, 1);
  assert.equal(api.dispatches, 0);
});

Deno.test("follow dispatcher rejects the wrong dispatched SHA and ambiguous new run identities", async () => {
  for (const mode of ["wrong_sha", "ambiguous"] as const) {
    const api = new FollowFake();
    api.dispatch = mode;
    const { result, logs } = await dispatch(api);
    assert.equal(result.exitCode, 1);
    assert.equal(api.dispatches, 1);
    assert.ok(
      logs.some((line) =>
        line.decision === "failed" &&
        line.reason === (mode === "wrong_sha"
            ? "dispatch_sha_mismatch"
            : "dispatch_identity_ambiguous")
      ),
    );
  }
});

Deno.test("follow dispatcher reconciles a lost dispatch acknowledgement without a second POST", async () => {
  const api = new FollowFake();
  api.dispatch = "lost";
  assert.equal((await dispatch(api)).result.exitCode, 0);
  assert.equal(api.dispatches, 1);
  assert.equal((await dispatch(api)).result.dispatched, false);
  assert.equal(api.dispatches, 1);
});

Deno.test("follow dispatcher fails an unobserved dispatch after bounded injected propagation polls", async () => {
  const api = new FollowFake();
  api.dispatch = "invisible";
  let pauses = 0;
  const result = await runSupervisorDispatch({
    http: api.http,
    token: "fake-token",
    clock: { now: () => NOW },
    log: () => {},
    follow: {
      expectedSha: L,
      ready: true,
      pause: () => {
        pauses++;
        return Promise.resolve();
      },
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(api.dispatches, 1);
  assert.equal(pauses, 5);
});

Deno.test("follow dispatcher refuses incomplete active listings without dispatching", async () => {
  const api = new FollowFake();
  api.intercept = (_request, url) =>
    url.pathname.endsWith("/supervisor.yml/runs") &&
      url.searchParams.get("status") === "queued"
      ? response({ total_count: 1, workflow_runs: [] })
      : undefined;
  const { result } = await dispatch(api);
  assert.equal(result.exitCode, 1);
  assert.equal(api.dispatches, 0);
});

Deno.test("follow dispatcher scans all active statuses before considering a duplicate-free POST", async () => {
  for (const status of ["requested", "waiting", "pending"]) {
    const api = new FollowFake();
    api.supervisorRuns = [supervisorRun(L, 80, { status })];
    const result = await dispatchFollowedSupervisor({
      http: api.http,
      token: "fake-token",
      clock: { now: () => NOW },
      expectedSha: L,
      ready: true,
      log: () => {},
    }, () => Promise.reject(new Error("a duplicate POST must not run")));
    assert.equal(result.valid, true);
    assert.ok(result.valid && result.skipped);
  }
});

Deno.test("follow dry-run still dispatches the existing exact launcher", async () => {
  const api = new FollowFake();
  const followed = await api.follow("off");
  assert.equal(followed.journal.candidateSha, OLDER);
  assert.equal(api.mutations, 0);
  const { result, logs } = await dispatch(
    api,
    followed.launcherSha!,
    followed.safeToDispatch,
  );
  assert.equal(result.dispatched, true);
  assert.ok(logs.some((line) => line.githubSha === L));
});
