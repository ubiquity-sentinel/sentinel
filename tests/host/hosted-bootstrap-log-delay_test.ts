import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import {
  iso,
  jobBody,
  jobsBody,
  logText,
  response,
  runtimeStep,
  ScriptedHttp,
  terminalRecord,
} from "../github/hosted-execution-helpers.ts";
import { requireRun } from "./actions-supervisor-fixture.ts";
import { liveInstallRig, SUCCESSOR } from "./hosted-self-install-fixtures.ts";

Deno.test("hosted bootstrap: delayed authenticated terminal clears intent and accepts the installation", async () => {
  const rig = await liveInstallRig();
  try {
    const repairBefore = await rig.repair.readRepair();
    const bootstrap = requireRun(await rig.prepare(1));
    assert.equal(bootstrap.purpose, "bootstrap");
    assert.equal(bootstrap.generation, 83);
    const before = await rig.snapshot();
    assert.equal(before.hostedInstallations![0].phase, "bootstrapping");
    const startedAt = bootstrap.createdAt + 1_000;
    const finishedAt = bootstrap.createdAt + 3_000;
    const emittedAt = finishedAt + 1_227;
    const jobFinishedAt = bootstrap.createdAt + 5_500;
    rig.clock.advance(6_000);

    const http = new ScriptedHttp();
    const attemptPath = "/repos/ubiquity/sentinel/actions/runs/1/attempts/1";
    http.on("GET", attemptPath, () =>
      response(200, {
        id: bootstrap.runId,
        run_attempt: bootstrap.runAttempt,
        workflow_id: 357012162,
        path: ".github/workflows/supervisor.yml",
        event: "workflow_dispatch",
        head_branch: "sentinel-supervisor",
        head_sha: bootstrap.launcherSha,
        status: "completed",
        conclusion: "success",
        repository: { full_name: "ubiquity/sentinel" },
        head_repository: { full_name: "ubiquity/sentinel" },
        run_started_at: iso(startedAt),
        updated_at: iso(jobFinishedAt),
      }));
    http.on("GET", `${attemptPath}/jobs`, () =>
      response(
        200,
        jobsBody([
          jobBody({
            runId: bootstrap.runId,
            attempt: bootstrap.runAttempt,
            headSha: bootstrap.launcherSha,
            startedAt,
            completedAt: jobFinishedAt,
            steps: [
              runtimeStep({
                started_at: iso(startedAt),
                completed_at: iso(bootstrap.createdAt + 5_000),
              }),
            ],
          }),
        ]),
      ));
    http.on(
      "GET",
      "/repos/ubiquity/sentinel/actions/jobs/901/logs",
      () =>
        response(302, "", {
          location:
            "https://productionresultssa18.blob.core.windows.net/logs/bootstrap",
        }),
    );
    http.on("GET", "/logs/bootstrap", () =>
      response(
        200,
        logText([
          terminalRecord(bootstrap, {
            controllerSha: SUCCESSOR,
            startedAt,
            finishedAt,
            baseSha: SUCCESSOR,
          }),
        ], emittedAt),
      ));
    const client = new GitHubApiClient({
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      apiBaseUrl: "https://api.github.com",
      clock: rig.clock,
      auth: {
        authorizationHeader: () => Promise.resolve(portOk("Bearer fixture")),
      },
      cooldownGate: {
        beforeRequest: () => Promise.resolve(portOk(undefined)),
        recordRateLimit: () => Promise.resolve(portOk(undefined)),
      },
      http: http.transport,
    });
    rig.evidence.readExecution = (saved) => client.readHostedExecution(saved);

    assert.equal((await rig.finalize(1)).status, "idle");
    const after = await rig.snapshot();
    const runtime = after.hostedRuntimes[0];
    assert.equal(runtime.execution, null);
    assert.deepEqual(runtime.lastHealthyProof?.execution, bootstrap);
    assert.deepEqual(runtime.lastExecutionProof, runtime.lastHealthyProof);
    assert.equal(runtime.lastHealthyProof?.terminalAt, emittedAt);
    assert.equal(runtime.lastHealthyProof?.outcome, "healthy");
    assert.equal(runtime.activeRevision, SUCCESSOR);
    assert.equal(runtime.generation, 83);
    const installation = after.hostedInstallations![0];
    assert.equal(installation.phase, "accepted");
    assert.equal(installation.pointerIntent, null);
    assert.deepEqual(installation.bootstrapProof, runtime.lastHealthyProof);

    const settled = await rig.release.readRelease();
    assert.equal((await rig.finalize(1)).status, "idle");
    assert.deepEqual(await rig.release.readRelease(), settled);
    const next = requireRun(await rig.prepare(2));
    assert.equal(next.purpose, "ordinary");
    assert.equal(next.generation, 83);
    assert.equal(next.revision, SUCCESSOR);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
    assert.equal(http.callsTo("/logs/bootstrap").length, 1);
  } finally {
    await rig.close();
  }
});
