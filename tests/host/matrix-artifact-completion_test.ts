/** Exact wave and native execution-completion evidence. */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  parseHostedExecutionSettlementV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { SHA3, T0 } from "../state/helpers.ts";
import { fixture, ISO, RUN, WAVE } from "./matrix-artifact-fixtures.ts";

Deno.test("matrix artifacts: authenticated paginated old wave recovers exact bundle after local cells disappeared", async () => {
  const rig = await fixture(true);
  try {
    const before = canonicalStringify([rig.repair, rig.release]);
    const { currentRun: _oldRun, ...input } = rig.input;
    const waves = await rig.transport.recover(input);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].results.length, 1);
    assert.deepEqual(
      await Deno.readFile(`${waves[0].bundlesDir}/${rig.result.bundle!.file}`),
      rig.bundle,
    );
    assert.deepEqual(waves[0].provenance, {
      run: RUN,
      plannerJobId: 401,
      cellJobIds: [402],
    });
    assert.ok(
      rig.calls.some((call) =>
        call.url.includes("artifacts?per_page=100&page=2")
      ),
    );
    assert.ok(
      rig.calls.some((call) => call.url.includes("jobs?per_page=100&page=2")),
    );
    assert.equal(canonicalStringify([rig.repair, rig.release]), before);
    assert.ok(
      rig.calls.every((call) =>
        !call.url.includes("blob.core.windows.net") || !call.auth
      ),
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("matrix skipped completion: no-runner wire timestamps and adverse guards", async () => {
  for (
    const fault of [
      "none",
      "executed",
      "runner",
      "active",
      "incomplete",
      "foreign",
      "duplicate",
      "truncated",
      "before-attempt",
      "after-attempt",
      "future",
      "invalid-start",
    ]
  ) {
    const f = await fixture();
    const previousCwd = Deno.cwd();
    Deno.chdir(`${f.tmp}/checkout`);
    try {
      const execution = {
        ...f.release.hostedRuntimes[0].execution!,
        id: WAVE,
        ...RUN,
        purpose: "bootstrap" as const,
      };
      f.release.hostedRuntimes[0].execution = execution;
      f.attempt.status = "completed";
      f.attempt.updated_at = new Date(T0 + 2_000).toISOString();
      const skipped = {
        ...f.jobs[0],
        id: 111354489906,
        name: "matrix_cell (${{ matrix.cellId }})",
        conclusion: "skipped",
        runner_id: null as number | null,
        runner_name: null as string | null,
        started_at: new Date(T0 + 1_000).toISOString(),
        completed_at: ISO,
        steps: [],
      };
      if (fault === "executed") skipped.conclusion = "success";
      if (fault === "runner") {
        skipped.runner_id = 7;
        skipped.runner_name = "assigned-runner";
      }
      if (fault === "active") skipped.status = "in_progress";
      if (fault === "incomplete") skipped.completed_at = "";
      if (fault === "foreign") skipped.run_id = 99;
      if (fault === "before-attempt") {
        skipped.completed_at = new Date(T0 - 1).toISOString();
      }
      if (fault === "after-attempt") {
        skipped.started_at = new Date(T0 + 3_000).toISOString();
      }
      if (fault === "future") {
        skipped.started_at = new Date(T0 + 120_000).toISOString();
        skipped.completed_at = skipped.started_at;
      }
      if (fault === "invalid-start") skipped.started_at = "not-a-timestamp";
      f.jobs.push(skipped);
      if (fault === "duplicate") f.jobs.push(skipped);
      const transport = createActionsMatrixArtifactTransport({
        state: f.state,
        token: "fake-local-token",
        clock: { now: () => T0 + 10_000 },
        artifactRoot: `${f.tmp}/skipped`,
        http: (request) =>
          fault === "truncated" &&
            new URL(request.url).pathname.endsWith("/jobs")
            ? Promise.resolve({
              status: 200,
              headers: new Headers(),
              bodyText: JSON.stringify({
                total_count: f.jobs.length + 1,
                jobs: f.jobs,
              }),
            })
            : f.http(request),
      });
      if (fault === "none") {
        assert.equal(
          await transport.confirmCompletedExecution!(execution),
          true,
        );
      } else {await assert.rejects(() =>
          transport.confirmCompletedExecution!(execution), fault);}
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.tmp, { recursive: true });
    }
  }
});

Deno.test("matrix verification completion: exact held verification survives pointer advance", async () => {
  for (
    const purpose of ["bootstrap", "prior", "candidate", "rollback"] as const
  ) {
    const f = await fixture();
    const previousCwd = Deno.cwd();
    Deno.chdir(`${f.tmp}/checkout`);
    try {
      const runtime = f.release.hostedRuntimes[0];
      const execution = {
        ...runtime.execution!,
        id: WAVE,
        ...RUN,
        purpose,
        releaseId: purpose === "bootstrap" ? null : "verification-release",
      };
      runtime.execution = null;
      runtime.lastExecutionProof = parseHostedExecutionSettlementV1({
        execution,
        workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
        workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
        repository: "ubiquity-sentinel/sentinel",
        ref: "refs/heads/sentinel-supervisor",
        jobId: 401,
        startedAt: T0,
        finishedAt: T0,
        observedAt: T0 + 10_000,
        outcome: "failed",
        startupReady: false,
        settled: true,
        baseSha: null,
        terminalAt: null,
        logDigest: "a".repeat(64),
      });
      runtime.activeRevision = SHA3;
      runtime.generation++;
      f.attempt.status = "completed";
      const transport = createActionsMatrixArtifactTransport({
        state: f.state,
        token: "fake-local-token",
        http: f.http,
        clock: { now: () => T0 + 10_000 },
        artifactRoot: `${f.tmp}/verification`,
      });
      assert.equal(await transport.confirmCompletedExecution!(execution), true);
      runtime.execution = {
        ...execution,
        id: "99:1:repair",
        runId: 99,
        runAttempt: 1,
        revision: SHA3,
        generation: runtime.generation,
      };
      await assert.rejects(() =>
        transport.confirmCompletedExecution!(execution)
      );
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.tmp, { recursive: true });
    }
  }
});

Deno.test("matrix completion: exact settled latest authenticates and custody failures refuse", async () => {
  for (
    const fault of [
      "none",
      "pending",
      "missing",
      "foreign-owner",
      "generation",
      "revision",
      "truncated",
      "unavailable",
      "drift",
    ]
  ) {
    const f = await fixture();
    const previousCwd = Deno.cwd();
    Deno.chdir(`${f.tmp}/checkout`);
    try {
      const runtime = f.release.hostedRuntimes[0];
      const execution = { ...runtime.execution!, id: WAVE, ...RUN };
      runtime.execution = null;
      runtime.lastExecutionProof = parseHostedExecutionSettlementV1({
        execution,
        workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
        workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
        repository: "ubiquity-sentinel/sentinel",
        ref: "refs/heads/sentinel-supervisor",
        jobId: null,
        finishedAt: T0,
        observedAt: T0 + 10_000,
        outcome: "not_started",
        evidenceDigest: "a".repeat(64),
      });
      f.attempt.status = "completed";
      if (fault === "missing") runtime.lastExecutionProof = null;
      if (fault === "foreign-owner") {
        runtime.execution = {
          ...execution,
          id: "99:1:repair",
          runId: 99,
          runAttempt: 1,
        };
      }
      if (fault === "generation") runtime.generation++;
      if (fault === "revision") runtime.activeRevision = SHA3;
      if (fault === "pending") f.attempt.status = "in_progress";
      const transport = createActionsMatrixArtifactTransport({
        state: f.state,
        token: "fake-local-token",
        clock: { now: () => T0 + 10_000 },
        artifactRoot: `${f.tmp}/completion`,
        http: (request) => {
          if (fault === "unavailable") {
            return Promise.resolve({
              status: 503,
              headers: new Headers(),
              bodyText: "",
            });
          }
          if (
            fault === "truncated" &&
            new URL(request.url).pathname.endsWith("/jobs")
          ) {
            return Promise.resolve({
              status: 200,
              headers: new Headers(),
              bodyText: JSON.stringify({
                total_count: f.jobs.length + 1,
                jobs: f.jobs,
              }),
            });
          }
          if (
            fault === "drift" && new URL(request.url).pathname.endsWith("/jobs")
          ) {
            runtime.execution = {
              ...execution,
              id: "99:1:repair",
              runId: 99,
              runAttempt: 1,
            };
          }
          return f.http(request);
        },
      });
      if (fault === "none") {
        assert.equal(
          await transport.confirmCompletedExecution!(execution),
          true,
        );
      } else {await assert.rejects(() =>
          transport.confirmCompletedExecution!(execution), fault);}
    } finally {
      Deno.chdir(previousCwd);
      await Deno.remove(f.tmp, { recursive: true });
    }
  }
});
