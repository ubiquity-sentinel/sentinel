import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  runHostedSupervisorWithPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import { hostedRuntimeBootstrapDisposition } from "../../src/host/hosted-runtime-bootstrap.ts";
import {
  CANDIDATE,
  LAUNCHER,
  makeRig,
  releaseRequest,
  requireRun,
  reviewReceipt,
  run,
  runProof,
} from "./actions-supervisor-fixture.ts";
import {
  failedProof,
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { NOW } from "./owner-install-fixture-constants.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-install-plan.ts";
import { buildOwnerDevelopmentInstallSnapshot } from "../../src/host/owner-install-snapshot.ts";
import { futureNativeSettlement } from "./owner-install-future-recovery-fixtures.ts";

const OTHER = "f".repeat(40) as GitSha;
const pin = {
  fromRevision: LAUNCHER,
  fromGeneration: 81,
  toRevision: CANDIDATE,
  toGeneration: 82,
  rollbackToPrior: false,
};
const rollout = {
  ...DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
  installs: [pin],
};
const custody = { custodyActivated: true, revisions: [CANDIDATE] };
const queue = { proofActivated: true, revisions: [CANDIDATE] };
function installed() {
  return runtimeRecord({
    revision: CANDIDATE,
    generation: 82,
    healthyProof: healthyProof(LAUNCHER, 81, 501),
    executionProof: healthyProof(LAUNCHER, 81, 501),
  });
}

Deno.test("future rollback actual controller: restored bootstrap precedes unrelated source selection", async (t) => {
  for (const outcome of ["healthy", "failed"] as const) {
    await t.step(outcome, async () => {
      const rig = await makeRig();
      try {
        rig.clock.advance(NOW - rig.clock.now());
        const pins = {
          ...DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
          installs: [{
            fromRevision: CANDIDATE,
            fromGeneration: 82,
            toRevision: OTHER,
            toGeneration: 83,
            rollbackToPrior: true,
          }],
        };
        const floors = {
          queue: {
            proofActivated: true,
            revisions: [CANDIDATE, OTHER, LAUNCHER],
          },
          custody: {
            custodyActivated: true,
            revisions: [CANDIDATE, OTHER, LAUNCHER],
          },
        };
        const failed = releaseSnapshot({
          runtime: runtimeRecord({
            revision: OTHER,
            generation: 83,
            healthyProof: healthyProof(CANDIDATE, 82),
            executionProof: failedProof(OTHER, 83),
          }),
        });
        const plan = planOwnerDevelopmentInstall(
          failed,
          NOW,
          undefined,
          undefined,
          floors.queue,
          floors.custody,
          pins,
        );
        assert.equal(plan.status, "rollback");
        assert.ok(plan.status === "rollback");
        const restored = buildOwnerDevelopmentInstallSnapshot(
          failed,
          "a".repeat(40) as GitSha,
          plan.move,
          NOW,
          undefined,
          undefined,
          floors.queue,
          floors.custody,
        );
        assert.equal(
          restored.hostedRuntimes[0].lastHealthyProof?.execution.generation,
          82,
        );
        await rig.seedCapturedRelease({
          ...restored,
          stateHead: null,
          sequence: 1,
        });
        const request = releaseRequest({
          revision: LAUNCHER,
          source: {
            pullRequest: 5,
            reviewRequestId: "review-req-1",
            reviewReceiptId: "review-receipt-1",
            head: LAUNCHER,
            base: CANDIDATE,
          },
        });
        await rig.seedRepair([request], [reviewReceipt(request)]);
        rig.evidence.requests.add(request.id);
        const core = {
          clock: rig.clock,
          state: rig.release,
          evidence: rig.evidence,
          run: run(902),
          queueRuntimeCapability: floors.queue,
          existingPrRuntimeCapability: floors.custody,
          runtimeRollout: pins,
        };
        const prepared = await runHostedSupervisorPrepare(core);
        assert.equal(
          rig.evidence.taskCalls,
          0,
          "restored own-health must precede unrelated source reads",
        );
        const execution = requireRun(prepared);
        assert.equal(execution.purpose, "bootstrap");
        assert.equal(execution.revision, CANDIDATE);
        assert.equal(execution.generation, 84);
        assert.equal(
          (await rig.snapshot()).hostedRuntimes[0].lastHealthyProof?.execution
            .generation,
          82,
        );
        rig.evidence.settlements.set(
          execution.id,
          await futureNativeSettlement(execution, outcome),
        );
        rig.clock.advance(10_000);
        await runHostedSupervisorFinalize(core);
        const settled = await rig.snapshot();
        const active = settled.hostedRuntimes[0];
        assert.equal(active.execution, null);
        if (outcome === "healthy") {
          assert.equal(active.lastHealthyProof?.execution.generation, 84);
          assert.equal(
            planOwnerDevelopmentInstall(
              settled,
              rig.clock.now(),
              undefined,
              undefined,
              floors.queue,
              floors.custody,
              pins,
            ).status,
            "no_change",
          );
        } else {
          assert.equal(active.lastHealthyProof?.execution.generation, 82);
          assert.equal(
            hostedRuntimeBootstrapDisposition(
              active,
              floors.queue,
              floors.custody,
              pins,
            ),
            "hold",
          );
          const held = await runHostedSupervisorPrepare({
            ...core,
            run: run(903),
          });
          assert.equal(held.status, "pending");
          assert.deepEqual(await rig.snapshot(), settled);
          assert.equal(rig.evidence.taskCalls, 0);
        }
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("future bootstrap source priority: only exact healthy-predecessor target admits; unhealthy or unrelated tuples never gain bootstrap authority", () => {
  const runtime = installed();
  const disposition = (value = runtime, data = rollout) =>
    hostedRuntimeBootstrapDisposition(value, queue, custody, data);
  assert.equal(disposition(), "bootstrap");
  assert.equal(
    hostedRuntimeBootstrapDisposition(
      runtime,
      DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
      DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
      DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
    ),
    "ordinary",
  );
  assert.equal(disposition(runtime, { ...rollout, installs: [] }), "ordinary");
  assert.equal(disposition({ ...runtime, generation: 83 }), "ordinary");
  assert.equal(disposition({ ...runtime, lastHealthyProof: null }), "hold");
  assert.equal(
    disposition({ ...runtime, lastExecutionProof: failedProof(CANDIDATE, 82) }),
    "hold",
  );
  assert.equal(
    disposition({ ...runtime, lastHealthyProof: healthyProof(CANDIDATE, 82) }),
    "ordinary",
  );
  assert.equal(
    disposition(runtime, {
      ...rollout,
      installs: [{ ...pin, toGeneration: 84 }],
    }),
    "hold",
  );
});

Deno.test("future bootstrap actual controller: source-pinned own-health wins over a ready unrelated self-release; dormant source preserves selection", async (t) => {
  for (const active of [false, true]) {
    await t.step(
      active ? "future own-health priority" : "dormant selection unchanged",
      async () => {
        const rig = await makeRig();
        try {
          rig.clock.advance(NOW - rig.clock.now());
          await rig.seedCapturedRelease({
            ...releaseSnapshot({ runtime: installed() }),
            stateHead: null,
            sequence: 1,
          });
          const request = releaseRequest({
            revision: OTHER,
            source: {
              pullRequest: 5,
              reviewRequestId: "review-req-1",
              reviewReceiptId: "review-receipt-1",
              head: OTHER,
              base: CANDIDATE,
            },
          });
          await rig.seedRepair([request], [reviewReceipt(request)]);
          rig.evidence.requests.add(request.id);
          const core = {
            clock: rig.clock,
            state: rig.release,
            evidence: rig.evidence,
            run: run(700),
            queueRuntimeCapability: queue,
            existingPrRuntimeCapability: active
              ? custody
              : { custodyActivated: false, revisions: [] },
            runtimeRollout: rollout,
          };
          const before = await rig.snapshot();
          const outcome = await runHostedSupervisorPrepare(core);
          if (!active) {
            assert.equal(outcome.status, "pending");
            assert.deepEqual(await rig.snapshot(), before);
            assert.ok(rig.evidence.taskCalls > 0);
            return;
          }
          const execution = requireRun(outcome);
          assert.equal(execution.purpose, "bootstrap");
          assert.equal(execution.revision, CANDIDATE);
          assert.equal(execution.generation, 82);
          assert.equal(rig.evidence.taskCalls, 0);
          assert.deepEqual((await rig.snapshot()).hostedReleases, []);
          // A different dispatch cannot bypass the genuine pending execution.
          assert.equal(
            (await runHostedSupervisorPrepare({ ...core, run: run(701) }))
              .status,
            "pending",
          );
          const outputs = new Map<string, string>();
          const host = await runHostedSupervisorWithPolicy({
            queue,
            custody,
            rollout,
          }, {
            sourceDir: Deno.cwd(),
            clock: rig.clock,
            state: rig.release,
            http: () => {
              throw new Error("saved bootstrap must not select a new request");
            },
            process: {
              run: (input) =>
                Promise.resolve({
                  outcome: "exited",
                  exitCode: 0,
                  signal: null,
                  truncated: false,
                  settled: true,
                  durationMs: 0,
                  detail: "offline source identity",
                  stdout: new TextEncoder().encode(
                    input.args.includes("rev-parse") ? `${LAUNCHER}\n` : "",
                  ),
                  stderr: new Uint8Array(),
                }),
            },
            env: {
              GITHUB_REPOSITORY: "ubiquity/sentinel",
              GITHUB_REF: "refs/heads/sentinel-supervisor",
              GITHUB_JOB: "prepare",
              GITHUB_RUN_ID: "700",
              GITHUB_RUN_ATTEMPT: "1",
              GITHUB_SHA: LAUNCHER,
              GITHUB_WORKFLOW_SHA: LAUNCHER,
              GITHUB_WORKFLOW_REF:
                "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
              GITHUB_TOKEN: "offline-native-token-value",
            },
            writeOutput: (key, value) => {
              outputs.set(key, value);
              return Promise.resolve();
            },
          });
          assert.equal(host.execution?.id, execution.id);
          assert.equal(outputs.get("executionPurpose"), "bootstrap");
          assert.equal(outputs.get("generation"), "82");
          assert.equal(outputs.get("modelStartsEnabled"), "false");
          assert.equal(outputs.get("revision"), CANDIDATE);
          // Finalize remains the actual settlement path; maintenance invents none.
          rig.evidence.settlements.set(
            execution.id,
            runProof(execution, "healthy"),
          );
          assert.equal(
            (await runHostedSupervisorFinalize(core)).status,
            "idle",
          );
          const settled = await rig.snapshot();
          assert.equal(settled.hostedRuntimes[0].execution, null);
          assert.equal(
            settled.hostedRuntimes[0].lastHealthyProof?.execution.id,
            execution.id,
          );
          assert.equal(
            hostedRuntimeBootstrapDisposition(
              settled.hostedRuntimes[0],
              queue,
              custody,
              rollout,
            ),
            "ordinary",
          );
          // The unrelated release resumes its normal refusal after health exists.
          assert.equal(
            (await runHostedSupervisorPrepare({ ...core, run: run(701) }))
              .status,
            "pending",
          );
          assert.ok(rig.evidence.taskCalls > 0);
        } finally {
          await rig.cleanup();
        }
      },
    );
  }
});

Deno.test("future bootstrap actual controller: failed candidate and cursor conflict do not write a new execution", async (t) => {
  for (
    const fault of ["failed", "cursor", "stalled_install", "moved_runtime"]
  ) {
    await t.step(fault, async () => {
      const rig = await makeRig();
      try {
        rig.clock.advance(NOW - rig.clock.now());
        const runtime = installed();
        if (fault === "stalled_install") {
          runtime.activeRevision = LAUNCHER;
          runtime.generation = 81;
        }
        if (fault === "moved_runtime") runtime.activeRevision = OTHER;
        if (fault === "failed") {
          runtime.lastExecutionProof = failedProof(CANDIDATE, 82);
        }
        await rig.seedCapturedRelease({
          ...releaseSnapshot({ runtime }),
          stateHead: null,
          sequence: 1,
        });
        await rig.seedRepair([], []);
        const before = await rig.snapshot();
        let writes = 0;
        const state = fault === "cursor"
          ? {
            readRelease: () => rig.release.readRelease(),
            readRepair: () => rig.release.readRepair(),
            writeRelease: () => {
              writes++;
              return Promise.resolve({
                ok: true as const,
                value: { status: "conflict" as const, currentHead: OTHER },
              });
            },
          }
          : rig.release;
        const result = await runHostedSupervisorPrepare({
          clock: rig.clock,
          state,
          evidence: rig.evidence,
          run: run(700),
          queueRuntimeCapability: queue,
          existingPrRuntimeCapability: custody,
          runtimeRollout: rollout,
        });
        assert.equal(result.status, "pending");
        assert.deepEqual(await rig.snapshot(), before);
        assert.equal(writes, fault === "cursor" ? 1 : 0);
      } finally {
        await rig.cleanup();
      }
    });
  }
});
