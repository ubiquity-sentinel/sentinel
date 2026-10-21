import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import { readHostedMaintenanceQueueObservation } from "../../ops/hosted-autonomy-compatibility-queue.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { HOSTED_RUNTIME_ROLLOUT } from "../../src/host/hosted-runtime-rollout.ts";
import { gitRun, testGitEnv } from "../state/helpers.ts";
import { entryWire, snapshotWire } from "../github/merge-queue-fixtures.ts";
import { DEFAULT_APP_INSTALLATION_ID } from "../../src/host/actions-target-cycles.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";
import { darkQueueCoordinatorFixture } from "./hosted-autonomy-dark-queue-fixture.ts";
import {
  failedProof,
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { NOW } from "./owner-install-fixture-constants.ts";
import { nativeWriterFixture } from "./existing-pr-runtime-fixtures.ts";

const PRIOR = "a".repeat(40) as GitSha;
const NEXT = "b".repeat(40) as GitSha;
const OTHER = "c".repeat(40) as GitSha;
const migration = {
  fromRevision: PRIOR,
  fromGeneration: 81,
  toRevision: NEXT,
  toGeneration: 82,
};
const custody = {
  custodyActivated: true,
  revisions: [NEXT],
  ownerInstallMigrations: [migration],
};
const queue = {
  proofActivated: true,
  revisions: [NEXT],
  ownerInstallMigrations: [migration],
};
const rollout = {
  ...HOSTED_RUNTIME_ROLLOUT,
  installs: [{ ...migration, rollbackToPrior: false }],
};

function fixtures(installed = false) {
  const release = releaseSnapshot({
    runtime: runtimeRecord({
      revision: installed ? NEXT : PRIOR,
      generation: installed ? 82 : 81,
      healthyProof: healthyProof(PRIOR, 81, 501),
      executionProof: healthyProof(PRIOR, 81, 501),
    }),
  });
  const repair = repairSnapshot([], []);
  let writes = 0;
  let releaseHead = PRIOR;
  const state = {
    readRelease: () =>
      Promise.resolve(
        portOk({
          status: "found" as const,
          ref: null,
          head: releaseHead,
          snapshot: structuredClone(release),
        }),
      ),
    readRepair: () =>
      Promise.resolve(
        portOk({
          status: "found" as const,
          ref: null,
          head: PRIOR,
          snapshot: structuredClone(repair),
        }),
      ),
    writeRepair: () => {
      writes++;
      throw new Error("unexpected maintenance write");
    },
  };
  return {
    state,
    release,
    repair,
    writes: () => writes,
    moveHead: () => {
      releaseHead = OTHER;
    },
  };
}

function queueTransport(fault = "none") {
  const calls: string[] = [];
  let ruleReads = 0;
  const http: HttpTransportV1 = (request) => {
    const path = new URL(request.url).pathname;
    calls.push(`${request.method} ${path}`);
    const rules = path.includes("/rules/branches/");
    if (rules) assert.equal(request.method, "GET");
    else {
      assert.equal(path, "/graphql");
      assert.equal(request.method, "POST");
      assert.ok(
        JSON.parse(request.body!).query.trimStart().startsWith("query"),
      );
    }
    let body: unknown = rules ? [] : snapshotWire(null);
    if (fault === "busy") {
      body = rules ? [{ type: "merge_queue" }] : snapshotWire([entryWire()]);
    }
    if (fault === "incomplete" && !rules) body = snapshotWire([], 1);
    if (fault === "drift" && rules && ++ruleReads > 1) {
      body = [{ type: "merge_queue" }];
    }
    if (fault === "rule_without_queue" && rules) {
      body = [{ type: "merge_queue" }];
    }
    return Promise.resolve({
      status: fault === "rate" ? 429 : 200,
      headers: new Headers(fault === "rate" ? { "retry-after": "60" } : {}),
      bodyText: JSON.stringify(body),
    });
  };
  return { http, calls };
}

Deno.test("maintenance queue observation: complete dark or busy queue is read only; incomplete, moved rules and limits hold", async (t) => {
  for (
    const fault of [
      "none",
      "busy",
      "incomplete",
      "drift",
      "rule_without_queue",
      "rate",
      "cooldown",
      "expired",
    ]
  ) {
    await t.step(fault, async () => {
      const f = fixtures();
      const transport = queueTransport(fault);
      if (fault === "cooldown") {
        f.repair.githubCooldowns.push({
          installationId: DEFAULT_APP_INSTALLATION_ID,
          retryNotBefore: null,
          observedAt: NOW,
          observationId: "d".repeat(64),
          secondaryBackoff: 0,
        });
      }
      const before = structuredClone(f.repair);
      const result = await readHostedMaintenanceQueueObservation({
        state: f.state,
        clock: { now: () => NOW },
        token: "offline",
        http: transport.http,
        deadline: fault === "expired" ? NOW : NOW + 120_000,
      });
      assert.equal(result, ["none", "busy"].includes(fault));
      assert.equal(f.writes(), 0);
      assert.deepEqual(f.repair, before);
      if (["cooldown", "expired"].includes(fault)) {
        assert.deepEqual(transport.calls, []);
      }
    });
  }
});

Deno.test("maintenance main: installed successor and bootstrap preserve admission and writer custody", async (t) => {
  const original = Deno.cwd();
  const root = await Deno.makeTempDir({
    dir: original,
    prefix: ".sentinel-maintenance-composition-",
  });
  const checkout = `${root}/checkout`;
  await Deno.mkdir(checkout);
  const env = testGitEnv(`${root}/git-home`);
  await Deno.mkdir(`${root}/git-home`);
  for (
    const args of [["init", "-q"], [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "fixture",
    ]]
  ) {
    assert.ok((await gitRun(checkout, args, env)).ok);
  }
  const head = (await gitRun(checkout, ["rev-parse", "HEAD"], env)).stdout
    .trim() as GitSha;
  try {
    for (
      const fault of [
        "migration",
        "installed",
        "old_execution",
        "old_peer",
        "moved_source",
        "moved_state",
        "rate",
        "failed_bootstrap",
        "unproven_ordinary",
        "queue_only",
        "dormant",
        "healthy",
        "installed_successor",
      ]
    ) {
      await t.step(fault, async () => {
        const policy = fault === "dormant"
          ? DORMANT_HOSTED_SUPERVISOR_POLICY
          : {
            queue,
            custody: fault === "queue_only"
              ? { custodyActivated: false, revisions: [] }
              : custody,
            rollout,
          };
        return await withHostedProductionPolicy(policy, async (graph) => {
          const { runHostedAutonomyMain } = await graph.maintenanceMain();
          const installed = [
            "installed",
            "failed_bootstrap",
            "unproven_ordinary",
            "healthy",
            "installed_successor",
          ].includes(fault);
          const f = fixtures(installed);
          const native = nativeWriterFixture({
            runId: 700,
            runAttempt: 1,
            launcherSha: head,
          }, "maintenance");
          const transport = queueTransport(fault);
          let effects = 0;
          let custodyCalls = 0;
          const output = `${root}/output-${fault}`;
          const runtime = f.release.hostedRuntimes[0];
          if (fault === "old_execution") {
            runtime.execution = healthyProof(PRIOR, 81, 600).execution;
          }
          if (fault === "old_peer") {
            native.peers.push({
              ...native.nativeRun,
              id: 701,
              status: "queued",
              head_sha: OTHER,
            });
          }
          if (fault === "migration") {
            native.peers.push({
              ...native.nativeRun,
              id: 701,
              status: "queued",
            });
          }
          if (fault === "failed_bootstrap") {
            runtime.lastExecutionProof = failedProof(NEXT, 82);
          }
          if (fault === "unproven_ordinary") {
            runtime.execution = healthyProof(NEXT, 82, 600).execution;
          }
          if (["healthy", "installed_successor"].includes(fault)) {
            runtime.lastHealthyProof =
              runtime.lastExecutionProof =
                healthyProof(
                  NEXT,
                  82,
                  600,
                );
          }
          const read = async (path: string) => {
            const value = await native.read(path);
            if (fault === "moved_state") f.moveHead();
            if (fault === "moved_source" && path.includes("git/ref/")) {
              return { object: { sha: OTHER } };
            }
            return value;
          };
          const before = structuredClone({
            release: f.release,
            repair: f.repair,
          });
          const githubFor = () => {
            effects++;
            throw new Error("unexpected target surface");
          };
          const deps = {
            state: f.state,
            clock: { now: () => NOW },
            githubFor,
            queue: await darkQueueCoordinatorFixture({
              state: f.state,
              githubFor,
            }),
            onQueueCustodyReady: () => {
              custodyCalls++;
            },
            uncertainMatrix: () => {
              effects++;
              throw new Error("unexpected recovery");
            },
          };
          // Ordinary controls use the normal queue prelude and empty maintenance pass.
          if (
            ["migration", "dormant", "healthy", "installed_successor"].includes(
              fault,
            )
          ) {
            delete (deps as { uncertainMatrix?: unknown }).uncertainMatrix;
          }
          let exit: number;
          Deno.chdir(checkout);
          try {
            exit = await runHostedAutonomyMain({
              env: {
                GITHUB_REPOSITORY: "ubiquity-sentinel/sentinel",
                GITHUB_REF: "refs/heads/sentinel-supervisor",
                GITHUB_JOB: "maintenance",
                GITHUB_RUN_ID: "700",
                GITHUB_RUN_ATTEMPT: "1",
                GITHUB_WORKFLOW_REF:
                  "ubiquity-sentinel/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
                GITHUB_SHA: head,
                GITHUB_WORKFLOW_SHA: head,
                GITHUB_TOKEN: "offline-native-token",
                GITHUB_OUTPUT: output,
              },
              deps,
              ...(fault === "dormant" ? {} : {
                compatibility: {
                  custody: fault === "queue_only"
                    ? { custodyActivated: false, revisions: [] }
                    : custody,
                  queue: fault === "installed_successor"
                    ? {
                      ...queue,
                      revisions: [OTHER],
                      ownerInstallMigrations: [],
                    }
                    : queue,
                  rollout: fault === "installed_successor"
                    ? { ...rollout, installs: [] }
                    : rollout,
                  nativeRead: read,
                  http: transport.http,
                },
              }),
            });
          } finally {
            Deno.chdir(original);
          }
          assert.equal(exit, 0);
          const outputs = new Map(
            (await Deno.readTextFile(output)).trimEnd().split("\n").map((
              line,
            ) => line.split("=", 2) as [string, string]),
          );
          // Historical pointers without an installation journal re-bootstrap
          // model-disabled; fresh journaled installation failures roll back.
          const migrationOnly = ["installed", "failed_bootstrap"]
            .includes(fault);
          assert.equal(
            outputs.get("runtimeMigrationOnly"),
            String(migrationOnly),
          );
          assert.equal(
            outputs.get("runtimeMigrationRevision"),
            migrationOnly ? NEXT : "",
          );
          assert.equal(
            outputs.get("runtimeMigrationGeneration"),
            migrationOnly ? "82" : "",
          );
          const ordinary = [
            "migration",
            "dormant",
            "healthy",
            "installed_successor",
          ].includes(fault);
          assert.equal(outputs.get("queueCustodyReady"), String(ordinary));
          assert.equal(custodyCalls > 0, ordinary);
          assert.equal(effects > 0, ordinary);
          assert.equal(f.writes(), 0);
          assert.deepEqual({ release: f.release, repair: f.repair }, before);
          if (fault === "dormant") assert.deepEqual(transport.calls, []);
        });
      });
    }
  } finally {
    Deno.chdir(original);
    await Deno.remove(root, { recursive: true });
  }
});
