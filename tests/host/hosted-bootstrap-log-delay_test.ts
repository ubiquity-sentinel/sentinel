import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { HostedSupervisorGitHubClient } from "../../src/host/actions-supervisor-install-api.ts";
import { runHostedSupervisorPrepare } from "../../src/host/actions-supervisor.ts";
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
import {
  DORMANT_HOSTED_POLICIES,
  requireRun,
} from "./actions-supervisor-fixture.ts";
import { liveInstallRig, SUCCESSOR } from "./hosted-self-install-fixtures.ts";

for (
  const mode of ["finalize", "later prepare", "new launcher prepare"] as const
) {
  Deno.test(`hosted bootstrap: delayed authenticated terminal settles through ${mode}`, async () => {
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
      const client = new HostedSupervisorGitHubClient({
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

      let next;
      const newerLauncher = "e".repeat(40) as GitSha;
      if (mode === "finalize") {
        assert.equal((await rig.finalize(1)).status, "idle");
      } else {
        const saved = await rig.release.readRelease();
        assert.equal((await rig.finalize(2)).status, "pending");
        assert.deepEqual(await rig.release.readRelease(), saved);
        assert.equal(
          http.calls.length,
          0,
          "foreign finalizer never reads old proof",
        );
        if (mode === "later prepare") {
          next = requireRun(await rig.prepare(2));
        } else {
          http.on(
            "GET",
            `/repos/ubiquity/sentinel/commits/${newerLauncher}`,
            () => response(200, { sha: newerLauncher }),
          );
          http.on(
            "GET",
            `/repos/ubiquity/sentinel/compare/${SUCCESSOR}...${newerLauncher}`,
            () =>
              response(200, {
                status: "ahead",
                base_commit: { sha: SUCCESSOR },
                merge_base_commit: { sha: SUCCESSOR },
                ahead_by: 1,
                behind_by: 0,
                total_commits: 1,
              }),
          );
          http.on(
            "GET",
            `/repos/ubiquity/sentinel/commits/${newerLauncher}/check-runs`,
            () =>
              response(200, {
                total_count: 1,
                check_runs: [{
                  id: 92,
                  name: "test-local",
                  head_sha: newerLauncher,
                  status: "completed",
                  conclusion: "success",
                  app: { slug: "github-actions" },
                }],
              }),
          );
          rig.evidence.verifyAncestor = client.verifyAncestor.bind(client);
          rig.evidence.verifyLauncherCi = client.verifyLauncherCi.bind(client);
          next = requireRun(
            await runHostedSupervisorPrepare({
              ...DORMANT_HOSTED_POLICIES,
              clock: rig.clock,
              state: rig.release,
              evidence: rig.evidence,
              run: { runId: 2, runAttempt: 1, launcherSha: newerLauncher },
            }),
          );
        }
      }
      const after = await rig.snapshot();
      const runtime = after.hostedRuntimes[0];
      assert.deepEqual(runtime.execution, next ?? null);
      assert.deepEqual(runtime.lastHealthyProof?.execution, bootstrap);
      assert.deepEqual(runtime.lastExecutionProof, runtime.lastHealthyProof);
      assert.equal(runtime.lastHealthyProof?.terminalAt, emittedAt);
      assert.equal(runtime.lastHealthyProof?.outcome, "healthy");
      assert.equal(
        runtime.activeRevision,
        mode === "new launcher prepare" ? newerLauncher : SUCCESSOR,
      );
      assert.equal(
        runtime.generation,
        mode === "new launcher prepare" ? 84 : 83,
      );
      const installation = after.hostedInstallations!.find((r) =>
        r.candidateRevision === SUCCESSOR
      )!;
      assert.equal(installation.phase, "accepted");
      assert.equal(installation.pointerIntent, null);
      assert.deepEqual(installation.bootstrapProof, runtime.lastHealthyProof);

      if (mode === "finalize") {
        const settled = await rig.release.readRelease();
        assert.equal((await rig.finalize(1)).status, "idle");
        assert.deepEqual(await rig.release.readRelease(), settled);
        next = requireRun(await rig.prepare(2));
      }
      assert.equal(next!.runId, 2);
      assert.equal(
        next!.purpose,
        mode === "new launcher prepare" ? "bootstrap" : "ordinary",
      );
      assert.equal(next!.generation, mode === "new launcher prepare" ? 84 : 83);
      assert.equal(
        next!.revision,
        mode === "new launcher prepare" ? newerLauncher : SUCCESSOR,
      );
      if (mode === "new launcher prepare") {
        const advance = after.hostedInstallations!.find((r) =>
          r.candidateRevision === newerLauncher
        )!;
        assert.equal(advance.phase, "bootstrapping");
        assert.equal(advance.previousRevision, SUCCESSOR);
        assert.equal(advance.previousGeneration, 83);
        assert.deepEqual(
          advance.previousHealthyProof,
          installation.bootstrapProof,
        );
        assert.equal(advance.bootstrapExecutionId, next!.id);
        assert.deepEqual(advance.ci, {
          revision: newerLauncher,
          checkRunId: 92,
        });
      }
      assert.deepEqual(await rig.repair.readRepair(), repairBefore);
      assert.equal(http.callsTo("/logs/bootstrap").length, 1);
    } finally {
      await rig.close();
    }
  });
}
