import {
  DORMANT_HOSTED_SUPERVISOR_POLICY as dormant,
  runHostedSupervisorWithPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
/** Native completion recovery cases registered once, outside shared fixtures. */
import assert from "node:assert/strict";
import {
  parseHostedNotStartedProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type { runHostedSupervisorHost } from "../../src/host/actions-supervisor.ts";
import { sha256Hex, T0 } from "../state/helpers.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { runActionsTargetCycles } from "../../src/host/actions.ts";
import {
  createLocalRepositoryConfig,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";
import {
  CANDIDATE,
  execution,
  LAUNCHER,
  RECOVERY_OLD_LAUNCHER,
  RECOVERY_REVISION,
  skippedProof,
} from "./actions-supervisor-fixture.ts";
import { recoveryRig } from "./actions-supervisor-recovery-fixture.ts";

for (const nativeCompletion of [false, true]) {
  Deno.test(`same-pointer recovery: ${nativeCompletion ? "native completion transport" : "real protected host"} emits false model permission and honors native source and cursor checks`, async () => {
    const nativeIntent = execution({
      id: "37163248125:1:repair",
      runId: 37163248125,
      launcherSha: RECOVERY_OLD_LAUNCHER,
      revision: RECOVERY_REVISION,
      generation: 59,
      purpose: "ordinary",
      createdAt: T0 + 4000,
    });
    const attempt = {
      id: nativeIntent.runId,
      run_attempt: 1,
      workflow_id: 357012162,
      path: ".github/workflows/supervisor.yml",
      event: "workflow_dispatch",
      head_branch: "sentinel-supervisor",
      head_sha: RECOVERY_OLD_LAUNCHER,
      repository: { id: 1, full_name: "ubiquity/sentinel" },
      head_repository: { id: 1, full_name: "ubiquity/sentinel" },
      status: "completed",
      run_started_at: new Date(T0 + 4000).toISOString(),
      updated_at: new Date(T0 + 4500).toISOString(),
    };
    const jobs = { total_count: 0, jobs: [] };
    const latest = parseHostedNotStartedProofV1({
      ...skippedProof(nativeIntent),
      evidenceDigest: await sha256Hex(canonicalStringify({ attempt, jobs })),
    });
    const rig = await recoveryRig({ lastExecutionProof: latest });
    try {
      const outputs = new Map<string, string>();
      const treeIds = ["a", "b", "c", "d"].map((letter) => letter.repeat(40));
      const http: Parameters<typeof runHostedSupervisorHost>[0]["http"] = (
        request,
      ) => {
        const path = new URL(request.url).pathname;
        let body: unknown;
        if (path.endsWith(`/runs/${nativeIntent.runId}/attempts/1/jobs`)) {
          body = jobs;
        } else if (path.endsWith(`/runs/${nativeIntent.runId}/attempts/1`)) {
          body = attempt;
        } else if (path.endsWith(`/git/commits/${RECOVERY_REVISION}`)) {
          body = { sha: RECOVERY_REVISION, tree: { sha: treeIds[0] } };
        } else {
          const at = treeIds.indexOf(path.split("/").at(-1)!);
          assert.ok(at >= 0 && at < 3, path);
          body = {
            sha: treeIds[at],
            truncated: false,
            tree: [{
              path: ["src", "host", "matrix-actions.ts"][at],
              type: at === 2 ? "blob" : "tree",
              mode: at === 2 ? "100644" : "040000",
              sha: treeIds[at + 1],
            }],
          };
        }
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: JSON.stringify(body),
        });
      };
      const process: Parameters<typeof runHostedSupervisorHost>[0]["process"] =
        {
          run: (input) => {
            assert.ok(
              input.executable === "git" || input.executable === "/usr/bin/git",
            );
            const text = input.args.includes("rev-parse")
              ? `${LAUNCHER}\n`
              : "";
            return Promise.resolve({
              outcome: "exited",
              exitCode: 0,
              signal: null,
              stdout: new TextEncoder().encode(text),
              stderr: new Uint8Array(),
              truncated: false,
              settled: true,
              durationMs: 0,
              detail: "offline source identity",
            });
          },
        };
      const hostInput: Parameters<typeof runHostedSupervisorHost>[0] = {
        sourceDir: rig.root,
        clock: rig.clock,
        state: rig.state,
        http,
        process,
        ...(nativeCompletion ? {} : {
          matrixArtifacts: {
            confirmCompletedExecution: rig.evidence.confirmCompletedExecution
              .bind(rig.evidence),
          },
        }),
        env: {
          GITHUB_REPOSITORY: "ubiquity/sentinel",
          GITHUB_REF: "refs/heads/sentinel-supervisor",
          GITHUB_JOB: "prepare",
          GITHUB_RUN_ID: "72",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_SHA: LAUNCHER,
          GITHUB_WORKFLOW_SHA: LAUNCHER,
          GITHUB_WORKFLOW_REF:
            "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
          GITHUB_TOKEN: "offline-native-token-value",
        },
        writeOutput: (name, value) => {
          outputs.set(name, value);
          return Promise.resolve();
        },
      };
      const originalCwd = Deno.cwd();
      let result: Awaited<ReturnType<typeof runHostedSupervisorHost>>;
      try {
        if (nativeCompletion) Deno.chdir(rig.root);
        result = await runHostedSupervisorWithPolicy(dormant, hostInput);
      } finally {
        if (nativeCompletion) Deno.chdir(originalCwd);
      }
      assert.equal(result.execution?.purpose, "bootstrap");
      assert.equal(outputs.get("modelStartsEnabled"), "false");
      assert.equal(outputs.get("executionPurpose"), "bootstrap");
      assert.equal(outputs.get("generation"), "59");
      assert.equal(outputs.get("revision"), RECOVERY_REVISION);
      assert.equal(result.execution?.generation, 59);
      await assert.rejects(() =>
        runHostedSupervisorWithPolicy(dormant, {
          ...hostInput,
          env: { ...hostInput.env, GITHUB_WORKFLOW_SHA: CANDIDATE },
        })
      );
      await assert.rejects(() =>
        runHostedSupervisorWithPolicy(dormant, {
          ...hostInput,
          env: { ...hostInput.env, GITHUB_JOB: "repair" },
        })
      );
      assert.deepEqual(
        (await rig.read()).snapshot.hostedRuntimes[0].lastHealthyProof,
        rig.prior,
      );
      let cycles = 0;
      let modelStarts = 0;
      const capability = {} as never;
      const aggregate = await runActionsTargetCycles({
        clock: rig.clock,
        state: capability,
        configs: [createLocalRepositoryConfig()],
        controllerSha: RECOVERY_REVISION,
        githubCooldown: capability,
        incidents: unavailableIncidents,
        replay: unavailableReplay,
        model: capability,
        budget: capability,
        deadline: rig.clock.now() + 60000,
        stepLimit: 1,
        modelStartsEnabled: outputs.get("modelStartsEnabled") === "true",
        composeGithub: () => capability,
        runCycle: (_deps, options) => {
          cycles++;
          if (options.modelStartsEnabled) modelStarts++;
          assert.equal(options.modelStartsEnabled, false);
          return Promise.resolve(
            { status: "idle", detail: "offline verification cycle" } as const,
          );
        },
      });
      assert.equal(cycles, 1);
      assert.equal(modelStarts, 0);
      assert.equal(aggregate.addressed.length, 1);
    } finally {
      await rig.cleanup();
    }
  });
}
