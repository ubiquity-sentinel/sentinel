/** Hosted hosted-supervisor-lifecycle_test responsibility. */
import assert from "node:assert/strict";
import { GitHubApiClient } from "../../src/github/client.ts";
import type { HttpResponseV1 } from "../../src/github/http.ts";
import type {
  ReleaseStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { runHostedSupervisorPrepare } from "../../src/host/actions-supervisor.ts";
import { sha256Hex } from "../state/helpers.ts";
import {
  CANDIDATE,
  DORMANT_HOSTED_POLICIES,
  LAUNCHER,
  makeRig,
  releaseRequest,
  requireRun,
  reviewReceipt,
  run,
  runProof,
  SELF,
} from "./actions-supervisor-fixture.ts";
import {
  advanceToCandidate,
  bootstrapHealthy,
} from "./actions-supervisor-lifecycle-fixture.ts";

Deno.test("hosted supervisor core: bootstrap is written once, replayed and settled exactly", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    const identity = run(1);
    const first = requireRun(await rig.prepare(identity));
    assert.equal(first.purpose, "bootstrap");
    assert.equal(first.revision, LAUNCHER);
    assert.equal(first.generation, 1);
    // Exact same-run replay returns the same saved decision.
    assert.deepEqual(await rig.prepare(identity), {
      status: "run",
      execution: first,
    });
    // Missing evidence settles nothing.
    const before = await rig.snapshot();
    assert.equal((await rig.finalize(identity)).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
    rig.evidence.settlements.set(first.id, runProof(first, "healthy"));
    assert.equal((await rig.finalize(identity)).status, "idle");
    const after = await rig.snapshot();
    assert.equal(after.hostedRuntimes[0].execution, null);
    assert.equal(
      after.hostedRuntimes[0].lastExecutionProof?.outcome,
      "healthy",
    );
    assert.equal(
      after.hostedRuntimes[0].lastHealthyProof?.execution.id,
      first.id,
    );
    // A settled current run/attempt never schedules a second execution.
    assert.equal((await rig.prepare(identity)).status, "idle");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: ordinary cadence advances on each dispatch with no duplicate execution", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const identity = run(2);
    // No artificial hour cooldown: once the prior execution actually settled,
    // the next scheduled dispatch is immediately due for ordinary work.
    const ordinary = requireRun(await rig.prepare(identity));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, LAUNCHER);
    assert.deepEqual(await rig.prepare(identity), {
      status: "run",
      execution: ordinary,
    });
    const state = await rig.snapshot();
    assert.equal(
      state.hostedRuntimes[0].nextOrdinaryAt,
      ordinary.createdAt,
    );
    rig.evidence.settlements.set(ordinary.id, runProof(ordinary, "healthy"));
    assert.equal((await rig.finalize(identity)).status, "idle");
    // A legacy one-hour due timestamp cannot restore a retired cadence limit.
    // Keep the exact settled proof and pointer while writing that old schema
    // value through the real Git state store, then dispatch before one minute.
    const current = await rig.release.readRelease();
    assert.ok(current.ok && current.value.status === "found");
    if (!current.ok || current.value.status !== "found") {
      throw new Error("missing legacy cadence fixture state");
    }
    rig.clock.advance(1);
    const legacy = parseReleaseStateSnapshotV1({
      ...current.value.snapshot,
      stateHead: current.value.head,
      sequence: current.value.snapshot.sequence + 1,
      updatedAt: rig.clock.now(),
      hostedRuntimes: current.value.snapshot.hostedRuntimes.map((runtime) => ({
        ...runtime,
        nextOrdinaryAt: ordinary.createdAt + 3_600_000,
        updatedAt: rig.clock.now(),
      })),
    });
    const written = await rig.release.writeRelease(legacy, current.value.head);
    assert.ok(written.ok && written.value.status === "applied");
    assert.ok(rig.clock.now() < ordinary.createdAt + 60_000);
    // Same run/attempt cannot start a second execution even when due.
    assert.equal((await rig.prepare(identity)).status, "idle");
    assert.equal(requireRun(await rig.prepare(run(3))).purpose, "ordinary");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor interrupted step: actual client settles ordinary failure without granting health", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const identity = run(2);
    const ordinary = requireRun(await rig.prepare(identity));
    assert.equal(ordinary.purpose, "ordinary");
    const before = await rig.snapshot();
    const repairBefore = await rig.repair.readRepair();
    const startedAt = ordinary.createdAt + 1000;
    const finishedAt = ordinary.createdAt + 4000;
    rig.clock.advance(5000);
    const signedUrl =
      "https://productionresultssa17.blob.core.windows.net/logs/interrupted?sv=1&sig=fixture";
    const log = `${
      new Date(finishedAt).toISOString()
    } ##[error]The runner has received a shutdown signal.\n`;
    let control = "coherent";
    const calls: string[] = [];
    const client = new GitHubApiClient({
      repository: SELF,
      apiBaseUrl: "https://api.github.com",
      clock: rig.clock,
      auth: {
        authorizationHeader: () => Promise.resolve(portOk("Bearer fixture")),
      },
      cooldownGate: {
        beforeRequest: () => Promise.resolve(portOk(undefined)),
        recordRateLimit: () => Promise.resolve(portOk(undefined)),
      },
      http: (request) => {
        assert.equal(request.method, "GET");
        const path = new URL(request.url).pathname;
        calls.push(path);
        let body: unknown;
        let status = 200;
        const headers = new Headers();
        if (path === `/repos/ubiquity/sentinel/actions/runs/2/attempts/1`) {
          body = {
            id: ordinary.runId,
            run_attempt: ordinary.runAttempt,
            workflow_id: 357012162,
            path: ".github/workflows/supervisor.yml",
            head_sha: ordinary.launcherSha,
            head_branch: "sentinel-supervisor",
            event: "workflow_dispatch",
            status: "completed",
            conclusion: "failure",
            repository: { full_name: "ubiquity/sentinel" },
            head_repository: { full_name: "ubiquity/sentinel" },
            run_started_at: new Date(startedAt).toISOString(),
            updated_at: new Date(finishedAt).toISOString(),
          };
        } else if (
          path === `/repos/ubiquity/sentinel/actions/runs/2/attempts/1/jobs`
        ) {
          body = {
            total_count: 1,
            jobs: [{
              id: 7,
              name: "repair",
              run_id: ordinary.runId,
              run_attempt: ordinary.runAttempt,
              head_sha: control === "foreign launcher"
                ? CANDIDATE
                : ordinary.launcherSha,
              status: "completed",
              conclusion: "failure",
              started_at: new Date(startedAt).toISOString(),
              completed_at: new Date(finishedAt).toISOString(),
              steps: [{
                name: "Run selected Sentinel runtime",
                number: 10,
                status: "completed",
                conclusion: "cancelled",
                started_at: control === "missing step start"
                  ? null
                  : new Date(startedAt).toISOString(),
                completed_at: new Date(finishedAt).toISOString(),
              }],
            }],
          };
        } else if (path === "/repos/ubiquity/sentinel/actions/jobs/7/logs") {
          status = 302;
          headers.set("location", signedUrl);
          body = "";
        } else if (request.url === signedUrl) {
          body = control === "terminal-looking log"
            ? `${
              new Date(finishedAt).toISOString()
            } {"kind":"hosted_runtime_terminal","execution":\n`
            : log;
        } else throw new Error(`unscripted fixture path: ${path}`);
        return Promise.resolve(
          {
            status,
            headers,
            bodyText: typeof body === "string" ? body : JSON.stringify(body),
          } satisfies HttpResponseV1,
        );
      },
    });
    rig.evidence.readExecution = (saved) => client.readHostedExecution(saved);
    // Neither native contradictions nor an unrelated finalizer can clear the intent.
    for (
      const bad of [
        "foreign launcher",
        "missing step start",
        "terminal-looking log",
      ]
    ) {
      control = bad;
      assert.equal((await rig.finalize(identity)).status, "pending", bad);
      assert.deepEqual(await rig.snapshot(), before);
    }
    control = "coherent";
    assert.equal((await rig.finalize(run(3))).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
    // A later prepare must settle the still-saved old execution before selecting
    // new ordinary work, just as the protected workflow does after interruption.
    const next = requireRun(await rig.prepare(run(3)));
    assert.equal(next.purpose, "ordinary");
    assert.equal(next.revision, ordinary.revision);
    const after = await rig.snapshot();
    const runtime = after.hostedRuntimes[0];
    assert.deepEqual(runtime.execution, next);
    assert.deepEqual(runtime.lastExecutionProof?.execution, ordinary);
    assert.equal(runtime.lastExecutionProof?.outcome, "failed");
    assert.equal(runtime.lastExecutionProof?.startupReady, false);
    assert.equal(runtime.lastExecutionProof?.baseSha, null);
    assert.equal(runtime.lastExecutionProof?.logDigest, await sha256Hex(log));
    assert.deepEqual(
      runtime.lastHealthyProof,
      before.hostedRuntimes[0].lastHealthyProof,
    );
    assert.equal(
      runtime.activeRevision,
      before.hostedRuntimes[0].activeRevision,
    );
    assert.equal(runtime.generation, before.hostedRuntimes[0].generation);
    assert.deepEqual(after.hostedReleases, before.hostedReleases);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
    assert.ok(calls.includes("/repos/ubiquity/sentinel/actions/jobs/7/logs"));
    assert.ok(calls.includes("/logs/interrupted"));
    assert.equal((await rig.finalize(identity)).status, "pending");
    assert.deepEqual(await rig.snapshot(), after);
    assert.deepEqual(requireRun(await rig.prepare(run(3))), next);
    assert.deepEqual(await rig.snapshot(), after);
    assert.deepEqual(
      (await rig.snapshot()).hostedRuntimes[0].lastHealthyProof,
      before.hostedRuntimes[0].lastHealthyProof,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: a lost write response is reconciled by exact reread", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    let writes = 0;
    const state: StateReadView & ReleaseStateWriter = {
      readRelease: rig.release.readRelease.bind(rig.release),
      readRepair: rig.release.readRepair.bind(rig.release),
      writeRelease: async (next, expectedHead) => {
        writes++;
        const result = await rig.release.writeRelease(next, expectedHead);
        if (writes === 2) {
          return portOk<StateWriteResultV1>({
            status: "ambiguous",
            currentHead: null,
          });
        }
        return result;
      },
    };
    const result = await runHostedSupervisorPrepare({
      ...DORMANT_HOSTED_POLICIES,
      clock: rig.clock,
      state,
      run: run(1),
      evidence: rig.evidence,
    });
    const executionIntent = requireRun(result);
    assert.equal(writes, 2);
    const snapshot = await rig.snapshot();
    assert.equal(snapshot.hostedRuntimes[0].execution?.id, executionIntent.id);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: healthy prior promotes and a healthy candidate is accepted with times preserved", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    const prior = requireRun(await rig.prepare(run(2)));
    let state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "requested");
    assert.equal(state.hostedReleases[0].priorRevision, LAUNCHER);
    const receiptCreatedAt = state.hostedReleases[0].createdAt;
    rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
    const candidate = requireRun(await rig.prepare(run(3)));
    assert.equal(candidate.purpose, "candidate");
    assert.equal(candidate.revision, CANDIDATE);
    assert.equal(candidate.generation, 2);
    state = await rig.snapshot();
    assert.equal(state.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(state.hostedRuntimes[0].generation, 2);
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      prior.id,
    );
    assert.equal(state.hostedReleases[0].phase, "verifying");
    assert.equal(state.hostedReleases[0].priorProof?.execution.id, prior.id);
    rig.evidence.settlements.set(candidate.id, runProof(candidate, "healthy"));
    // The candidate settles into acceptance; with no hour cooldown the same
    // dispatch then starts the next ordinary execution.
    const settledOrdinary = requireRun(await rig.prepare(run(4)));
    assert.equal(settledOrdinary.purpose, "ordinary");
    state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "accepted");
    assert.equal(
      state.hostedReleases[0].candidateProof?.execution.id,
      candidate.id,
    );
    assert.equal(state.hostedReleases[0].priorProof?.execution.id, prior.id);
    assert.equal(state.hostedReleases[0].createdAt, receiptCreatedAt);
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      candidate.id,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: failed candidate rolls back exactly and a later healthy rollback closes", async () => {
  const rig = await makeRig();
  try {
    const { candidate, prior } = await advanceToCandidate(rig);
    const receiptCreatedAt = (await rig.snapshot()).hostedReleases[0].createdAt;
    rig.evidence.settlements.set(candidate.id, runProof(candidate, "failed"));
    const rollback = requireRun(await rig.prepare(run(4)));
    assert.equal(rollback.purpose, "rollback");
    assert.equal(rollback.revision, LAUNCHER);
    assert.equal(rollback.generation, 3);
    let state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "rollback_verifying");
    assert.equal(state.hostedReleases[0].candidateProof?.outcome, "failed");
    assert.equal(state.hostedReleases[0].rollbackProof, null);
    assert.equal(state.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(state.hostedRuntimes[0].generation, 3);
    // A failed rollback keeps the healthy slot and retries on a later run.
    rig.evidence.settlements.set(rollback.id, runProof(rollback, "failed"));
    const retry = requireRun(await rig.prepare(run(5)));
    assert.equal(retry.purpose, "rollback");
    state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "rollback_verifying");
    assert.equal(state.hostedReleases[0].rollbackProof, null);
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      prior.id,
    );
    rig.evidence.settlements.set(retry.id, runProof(retry, "healthy"));
    // The rollback settles; with no hour cooldown the same dispatch then
    // starts the next ordinary execution.
    const settledOrdinary = requireRun(await rig.prepare(run(6)));
    assert.equal(settledOrdinary.purpose, "ordinary");
    state = await rig.snapshot();
    assert.equal(state.hostedReleases[0].phase, "rolled_back");
    assert.equal(
      state.hostedReleases[0].rollbackProof?.execution.id,
      retry.id,
    );
    assert.equal(state.hostedReleases[0].priorProof?.execution.id, prior.id);
    assert.equal(state.hostedReleases[0].createdAt, receiptCreatedAt);
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      retry.id,
    );
  } finally {
    await rig.cleanup();
  }
});
