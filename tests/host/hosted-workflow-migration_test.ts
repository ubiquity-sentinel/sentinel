import { runHostedSupervisorWithPolicy } from "./hosted-supervisor-policy-fixture.ts";
/** Exercise the actual job predicates with the controller's migration outputs. */
import assert from "node:assert/strict";
import { runOwnerDevelopmentInstallMain } from "../../src/host/owner-install-run.ts";
import { runHostedRuntimeLauncher } from "../../src/host/hosted-runtime-launcher.ts";
import { hostedRuntimeBootstrapDisposition } from "../../src/host/hosted-runtime-bootstrap.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { FakeEvidence } from "./actions-supervisor-fixture.ts";
import {
  BorderRuntime,
  childLine,
  exited,
  hostedEnv,
} from "./hosted-runtime-fixture.ts";
import {
  futureNativeSettlement,
  futureRecoveryFixture,
  RECOVERY_NOW,
} from "./owner-install-future-recovery-fixtures.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION as R80,
  OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION as R81,
} from "../../src/host/owner-install-runtime-pins.ts";

const workflow = await Deno.readTextFile(".github/workflows/supervisor.yml");
const jobs = new Map(
  [...workflow.matchAll(
    /^ {2}([a-z_]+):\n([\s\S]*?)(?=^ {2}[a-z_]+:\n|$(?![\s\S]))/gm,
  )].map((match) => [match[1], match[2]]),
);

function context() {
  return {
    maintenance: {
      result: "success",
      outputs: {
        queueCustodyReady: "false",
        runtimeMigrationOnly: "true",
        runtimeMigrationRevision: "a".repeat(40),
        runtimeMigrationGeneration: "82",
      } as Record<string, string>,
    },
    prepare: {
      result: "success",
      outputs: {
        run: "true",
        modelStartsEnabled: "false",
        executionPurpose: "bootstrap",
        revision: "a".repeat(40),
        generation: "82",
      } as Record<string, string>,
    },
    matrix_plan: { result: "skipped", outputs: { hasCells: "true" } },
  };
}

function allows(
  job: string,
  needs: ReturnType<typeof context>,
  ref = "refs/heads/sentinel-supervisor",
  cancelled = false,
): boolean {
  const condition = /^ {4}if: (.*)$/m.exec(jobs.get(job)!)?.[1];
  assert.ok(condition, job);
  // This fixed workflow subset uses only string comparisons and boolean
  // operators shared with JavaScript; it contains no untrusted expression.
  const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  return Boolean(
    new Function(
      "needs",
      "github",
      "always",
      "cancelled",
      `return (${expression});`,
    )(
      needs,
      { ref },
      () => true,
      () => cancelled,
    ),
  );
}

Deno.test("hosted migration workflow: only exact model-disabled bootstrap crosses the maintenance hold", () => {
  const needs = context();
  assert.equal(allows("prepare", needs), true);
  assert.equal(allows("repair", needs), true);
  for (const job of ["matrix_plan", "matrix_cell"]) {
    assert.equal(allows(job, needs), false, job);
  }
  for (
    const [field, value] of [
      ["revision", "b".repeat(40)],
      ["generation", "83"],
      ["executionPurpose", "ordinary"],
      ["modelStartsEnabled", "true"],
      ["modelStartsEnabled", ""],
      ["run", "false"],
    ]
  ) {
    const changed = context();
    changed.prepare.outputs[field] = value;
    assert.equal(allows("repair", changed), false, `${field}=${value}`);
  }
  for (
    const field of [
      "runtimeMigrationOnly",
      "runtimeMigrationRevision",
      "runtimeMigrationGeneration",
    ]
  ) {
    const changed = context();
    delete changed.maintenance.outputs[field];
    assert.equal(allows("repair", changed), false, `missing ${field}`);
  }
  for (const job of ["prepare", "repair"]) {
    assert.equal(allows(job, needs, "refs/heads/development"), false, job);
    const failed = context();
    failed.maintenance.result = "failure";
    assert.equal(allows(job, failed), false, job);
    failed.maintenance.result = "skipped";
    assert.equal(allows(job, failed), false, job);
  }
  assert.equal(allows("repair", needs, undefined, true), false);
  const failed = context();
  failed.prepare.result = "failure";
  assert.equal(allows("repair", failed), false);
});

Deno.test("hosted migration workflow: ordinary queue gates and final settlement retain their route", () => {
  const needs = context();
  needs.maintenance.outputs.runtimeMigrationOnly = "false";
  for (const job of ["prepare", "matrix_plan", "matrix_cell", "repair"]) {
    assert.equal(allows(job, needs), false, job);
  }
  needs.maintenance.outputs.queueCustodyReady = "true";
  needs.prepare.outputs.executionPurpose = "ordinary";
  needs.prepare.outputs.modelStartsEnabled = "true";
  assert.equal(allows("repair", needs), false);
  needs.matrix_plan.result = "success";
  for (const job of ["prepare", "matrix_plan", "matrix_cell", "repair"]) {
    assert.equal(allows(job, needs), true, job);
  }
  needs.maintenance.result = "failure";
  assert.equal(allows("finalize", needs), true);
  assert.equal(allows("finalize", needs, "refs/heads/development"), false);
  for (
    const name of [
      "runtimeMigrationOnly",
      "runtimeMigrationRevision",
      "runtimeMigrationGeneration",
    ]
  ) {
    assert.ok(
      jobs.get("maintenance")!.includes(
        `${name}: \${{ steps.autonomy.outputs.${name} }}`,
      ),
    );
  }
  for (const name of ["executionPurpose", "generation"]) {
    assert.ok(
      jobs.get("prepare")!.includes(
        `${name}: \${{ steps.prepare.outputs.${name} }}`,
      ),
    );
  }
});

Deno.test("hosted migration workflow: actual failed-legacy maintenance App CAS same-prepare child and native settlement", async (t) => {
  for (const outcome of ["healthy", "failed"] as const) {
    await t.step(outcome, async () => {
      const rig = await futureRecoveryFixture({ legacyFirst: true });
      try {
        const before = await rig.current();
        const repairBefore = await rig.repair.readRepair();
        const maintenance = await rig.maintenance();
        const needs = context();
        needs.maintenance.outputs = maintenance.outputs;
        assert.equal(maintenance.effects, 0);
        assert.equal(maintenance.outputs.queueCustodyReady, "false");
        assert.equal(allows("prepare", needs), true);
        for (const job of ["matrix_plan", "matrix_cell"]) {
          assert.equal(allows(job, needs), false);
        }
        await runOwnerDevelopmentInstallMain({
          queueRuntimeCapability: rig.queue,
          existingPrRuntimeCapability: rig.custody,
          rollout: rig.rollout,
        });
        assert.equal(rig.reports.at(-1)?.status, "installed");
        assert.equal(rig.patches(), 1);
        const installed = await rig.current();
        const runtime = installed.snapshot.hostedRuntimes[0];
        assert.equal(runtime.activeRevision, rig.successor);
        assert.equal(runtime.generation, 82);
        assert.equal(installed.snapshot.sequence, before.snapshot.sequence + 1);
        assert.deepEqual(runtime.lastHealthyProof, rig.healthy);
        assert.deepEqual(runtime.lastExecutionProof, rig.failed);
        assert.deepEqual(await rig.repair.readRepair(), repairBefore);
        const evidence = new FakeEvidence();
        const core = {
          state: rig.state,
          clock: { now: () => RECOVERY_NOW },
          evidence,
          run: rig.run,
          queueRuntimeCapability: rig.queue,
          existingPrRuntimeCapability: rig.custody,
          runtimeRollout: rig.rollout,
        };
        const prepared = await runHostedSupervisorPrepare(core);
        assert.ok(prepared.status === "run");
        assert.deepEqual(prepared.execution, runtime.execution);
        assert.equal(
          prepared.execution.id,
          `${rig.run.runId}:${rig.run.runAttempt}:repair`,
        );
        assert.equal(prepared.execution.purpose, "bootstrap");
        assert.equal(prepared.execution.releaseId, null);
        assert.equal(evidence.taskCalls, 0);
        assert.equal(evidence.matrixCalls.length, 0);
        const outputs = new Map<string, string>();
        const env = {
          ...hostedEnv(rig.run.launcherSha),
          GITHUB_RUN_ID: String(rig.run.runId),
          GITHUB_RUN_ATTEMPT: String(rig.run.runAttempt),
          GITHUB_TOKEN: "offline-native-token-value",
          SENTINEL_MERGE_QUEUE: "off",
        };
        await runHostedSupervisorWithPolicy({
          queue: rig.queue,
          custody: rig.custody,
          rollout: rig.rollout,
        }, {
          sourceDir: rig.source.launcher,
          state: rig.state,
          clock: core.clock,
          process: new DenoReplayRuntime(
            Deno.env.get("PATH") ?? "/usr/bin:/bin",
          ),
          http: () => {
            throw new Error("saved bootstrap must precede source/model reads");
          },
          env: { ...env, GITHUB_JOB: "prepare" },
          writeOutput: (key, value) => {
            outputs.set(key, value);
            return Promise.resolve();
          },
        });
        needs.prepare.outputs = Object.fromEntries(outputs);
        assert.equal(outputs.get("modelStartsEnabled"), "false");
        assert.equal(allows("repair", needs), true);
        for (
          const [field, value] of [
            ["revision", R81],
            ["generation", "83"],
            ["executionPurpose", "ordinary"],
            ["modelStartsEnabled", "true"],
            ["run", "false"],
          ]
        ) {
          const changed = structuredClone(needs);
          changed.prepare.outputs[field] = value;
          assert.equal(allows("repair", changed), false, field);
        }
        const process = new BorderRuntime();
        process.child = exited(childLine(prepared.execution));
        const child = await runHostedRuntimeLauncher(
          {
            state: rig.state,
            clock: core.clock,
            env,
            launcherDir: rig.source.launcher,
            runtimeDir: rig.source.runtime,
            denoExecutable: Deno.execPath(),
            process,
          },
          rig.queue,
          rig.custody,
        );
        assert.equal(child.status, "healthy");
        assert.equal(process.childCalls().length, 1);
        assert.equal(process.childCalls()[0].cwd, rig.source.runtime);
        assert.equal(child.terminal?.execution.revision, rig.successor);
        assert.deepEqual(
          (await rig.current()).snapshot.hostedRuntimes[0].lastHealthyProof,
          rig.healthy,
          "child output alone never changes authoritative own health",
        );
        for (const old of [R80, R81]) {
          const deniedProcess = new BorderRuntime();
          const denied = await runHostedRuntimeLauncher(
            {
              state: {
                readRepair: () => rig.state.readRepair(),
                readRelease: async () => {
                  const read = await rig.current();
                  return {
                    ok: true as const,
                    value: {
                      ...read,
                      snapshot: {
                        ...read.snapshot,
                        hostedRuntimes: [{
                          ...runtime,
                          activeRevision: old,
                          generation: 81,
                          execution: {
                            ...prepared.execution,
                            revision: old,
                            generation: 81,
                          },
                        }],
                      },
                    },
                  };
                },
              },
              clock: core.clock,
              env,
              launcherDir: rig.source.launcher,
              runtimeDir: rig.source.runtime,
              denoExecutable: Deno.execPath(),
              process: {
                run: (command) =>
                  command.cwd === rig.source.runtime &&
                    command.args.includes("rev-parse")
                    ? Promise.resolve(exited(old + "\n"))
                    : deniedProcess.run(command),
              },
            },
            { proofActivated: false, revisions: [] },
            rig.custody,
          );
          assert.equal(denied.status, "unavailable");
          assert.equal(
            deniedProcess.childCalls().length,
            0,
            "old runtime stays fenced with queue off and empty",
          );
        }
        evidence.settlements.set(
          prepared.execution.id,
          await futureNativeSettlement(prepared.execution, outcome),
        );
        await runHostedSupervisorFinalize({
          ...core,
          clock: { now: () => RECOVERY_NOW + 10_000 },
        });
        const settled = await rig.current();
        const active = settled.snapshot.hostedRuntimes[0];
        assert.equal(active.execution, null);
        assert.equal(active.lastExecutionProof?.outcome, outcome);
        assert.equal(
          active.lastHealthyProof?.execution.revision,
          outcome === "healthy" ? rig.successor : R81,
        );
        assert.equal(
          active.lastHealthyProof?.execution.generation,
          outcome === "healthy" ? 82 : 81,
        );
        assert.equal(
          hostedRuntimeBootstrapDisposition(
            active,
            rig.queue,
            rig.custody,
            rig.rollout,
          ),
          outcome === "healthy" ? "ordinary" : "hold",
        );
        rig.setNow(RECOVERY_NOW + 10_000);
        if (outcome === "failed") {
          await runOwnerDevelopmentInstallMain({
            queueRuntimeCapability: rig.queue,
            existingPrRuntimeCapability: rig.custody,
            rollout: rig.rollout,
          });
          assert.equal(
            rig.patches(),
            1,
            "consumed R81 recovery never retries or rolls back",
          );
          assert.equal(
            (await rig.current()).snapshot.hostedRuntimes[0].activeRevision,
            rig.successor,
          );
          const held = await runHostedSupervisorPrepare({
            ...core,
            run: { ...rig.run, runId: rig.run.runId + 1 },
            clock: { now: () => RECOVERY_NOW + 10_000 },
          });
          assert.equal(held.status, "pending");
          assert.deepEqual(await rig.current(), settled);
        }
        assert.equal(evidence.taskCalls, 0);
        assert.equal(evidence.matrixCalls.length, 0);
        assert.deepEqual(await rig.repair.readRepair(), repairBefore);
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("hosted migration workflow: routing without full native issuance publishes and runs nothing", async () => {
  const rig = await futureRecoveryFixture({
    legacyFirst: true,
    fault: "source_ci_rate_limit",
  });
  try {
    const before = await rig.current();
    const maintenance = await rig.maintenance();
    const needs = context();
    needs.maintenance.outputs = maintenance.outputs;
    assert.equal(allows("prepare", needs), true);
    await runOwnerDevelopmentInstallMain({
      queueRuntimeCapability: rig.queue,
      existingPrRuntimeCapability: rig.custody,
      rollout: rig.rollout,
    });
    assert.equal(rig.patches(), 0);
    assert.deepEqual(await rig.current(), before);
    const evidence = new FakeEvidence();
    const prepared = await runHostedSupervisorPrepare({
      state: rig.state,
      clock: { now: () => RECOVERY_NOW },
      evidence,
      run: rig.run,
      queueRuntimeCapability: rig.queue,
      existingPrRuntimeCapability: rig.custody,
      runtimeRollout: rig.rollout,
    });
    assert.equal(prepared.status, "pending");
    const outputs = new Map<string, string>();
    await runHostedSupervisorWithPolicy({
      queue: rig.queue,
      custody: rig.custody,
      rollout: rig.rollout,
    }, {
      sourceDir: rig.source.launcher,
      state: rig.state,
      clock: { now: () => RECOVERY_NOW },
      process: new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin"),
      http: () =>
        Promise.resolve({
          status: 404,
          headers: new Headers(),
          bodyText: "{}",
        }),
      env: {
        ...hostedEnv(rig.run.launcherSha),
        GITHUB_RUN_ID: String(rig.run.runId),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: "prepare",
        GITHUB_TOKEN: "offline-native-token-value",
      },
      writeOutput: (key, value) => {
        outputs.set(key, value);
        return Promise.resolve();
      },
    });
    needs.prepare.outputs = Object.fromEntries(outputs);
    assert.equal(outputs.get("run"), "false");
    assert.equal(allows("repair", needs), false);
    assert.equal(evidence.taskCalls, 0);
    assert.deepEqual(await rig.current(), before);
    assert.equal(maintenance.effects, 0);
  } finally {
    await rig.close();
  }
});
