import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import {
  parseHostedExecutionIntentV1,
  parseHostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import { runHistoricalMatrixQuarantine } from "../../src/host/matrix-actions.ts";
import { runHostedSupervisorPrepare } from "../../src/host/actions-supervisor.ts";
import { reservation, workRecord } from "../state/helpers.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import {
  CONCURRENCY_PLANNER_REVISION,
  CONCURRENCY_PRIOR_REVISION,
  CONCURRENCY_RETRY_REVISION,
  DIGEST,
  LAUNCHER,
  NOW,
  STATE_HEAD,
  T0,
  UNRELATED,
} from "./owner-install-fixture-constants.ts";
import {
  acceptedRelease,
  cooldown,
  executionIntent,
  failedProof,
  healthyProof,
  hostedProof,
  notStartedProof,
  releaseSnapshot,
  requestedRelease,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";

Deno.test(
  "owner install runtime60: verified maintenance preserves unrelated admission through installation and rollback",
  async () => {
    for (const failedCandidate of [false, true]) {
      const prior = hostedProof({
        runId: 1200,
        purpose: "bootstrap",
        releaseId: null,
        revision: CONCURRENCY_RETRY_REVISION,
        generation: 59,
        outcome: "healthy",
      });
      const latest = failedCandidate
        ? hostedProof({
          runId: 1201,
          purpose: "bootstrap",
          releaseId: null,
          revision: CONCURRENCY_PLANNER_REVISION,
          generation: 60,
          outcome: "failed",
        })
        : prior;
      const fixture = await concurrencyInstallerFixture(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: failedCandidate
              ? CONCURRENCY_PLANNER_REVISION
              : CONCURRENCY_RETRY_REVISION,
            generation: failedCandidate ? 60 : 59,
            healthyProof: prior,
            executionProof: latest,
          }),
          hostedReleases: [acceptedRelease()],
        }),
        undefined,
        CONCURRENCY_PLANNER_REVISION,
      );
      const remote = `${Deno.cwd()}/remote.git`;
      const repairRef = "refs/heads/sentinel-state/repair";
      const command = async (args: string[]) => {
        const result = await new Deno.Command("git", {
          args: ["--git-dir", remote, ...args],
          stdout: "piped",
          stderr: "piped",
        }).output();
        assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
      };
      try {
        await command(["update-ref", "-d", repairRef, fixture.initialHead]);
        const repair = createRepairStateStore({
          remoteUrl: remote,
          scratchDir: `${Deno.cwd()}/unrelated-repair`,
        });
        const release = createReleaseStateStore({
          remoteUrl: remote,
          scratchDir: `${Deno.cwd()}/prepare-release`,
        });
        const requestId = "e".repeat(64);
        const work = workRecord("unrelated-existing-admission", {
          createdAt: T0 - 2000,
          updatedAt: T0 - 1000,
          target: {
            base: UNRELATED,
            branch: "sentinel/unrelated-existing-admission",
            checkpoint: null,
            head: null,
            pr: null,
          },
          intent: {
            kind: "implementation",
            key: implementationIntentKey(requestId),
            startedAt: T0 - 1000,
            branch: "sentinel/unrelated-existing-admission",
            expectedHead: null,
            observedBase: UNRELATED,
            pr: null,
            requestId,
            resultId: null,
          },
          counters: { attempts: 1, retries: 0, reviewRounds: 0 },
        });
        const charge = reservation(requestId, {
          taskId: work.id,
          head: UNRELATED,
          createdAt: T0 - 1000,
        });
        const seeded = await repair.writeRepair(
          parseRepairStateSnapshotV1({
            version: "v1",
            kind: "repair_state_snapshot",
            stateHead: null,
            sequence: 1,
            updatedAt: T0,
            incidents: [],
            evidence: [],
            work: [work],
            reservations: [charge],
            reviews: [],
            replays: [],
            releaseRequests: [],
            githubCooldowns: [],
            attemptMemory: [],
            lessons: [],
          }),
          null,
        );
        assert(
          seeded.ok && seeded.value.status === "applied",
          JSON.stringify(seeded),
        );
        const originalRepair = await repair.readRepair();
        let nativeReads = 0;
        let completionReads = 0;
        const maintenance = async () => {
          const before = await fixture.read();
          assert(before.ok && before.value.status === "found");
          const saved =
            before.value.snapshot.hostedRuntimes[0].lastExecutionProof;
          assert(saved && saved.outcome !== "not_started");
          const result = await runHistoricalMatrixQuarantine({
            state: {
              readRepair: () => repair.readRepair(),
              readRelease: () => fixture.read(),
              writeRepair: () => {
                throw new Error("verification must not write repair state");
              },
            },
            clock: { now: () => NOW },
            budget: {
              settleModelStart: () => {
                throw new Error(
                  "verification must not settle unrelated admission",
                );
              },
            },
            historicalReleaseWitnesses: [{
              commit: STATE_HEAD,
              executionId: "1199:1:repair",
              logDigest: DIGEST,
              reservationIds: Array.from(
                { length: 55 },
                (_, i) => i.toString(16).padStart(64, "0"),
              ),
              reject: () => {
                throw new Error(
                  "unrelated admission is outside closed legacy55",
                );
              },
            }],
            transport: {
              confirmCompletedExecution: (execution) => {
                assert.deepEqual(execution, saved.execution);
                completionReads++;
                return Promise.resolve(true);
              },
              rejectHistorical: () => {
                throw new Error(
                  "verification proof cannot authorize ordinary quarantine",
                );
              },
              recover: () => {
                throw new Error("verification cannot ingest artifacts");
              },
            },
            readExecution: (execution) => {
              assert.deepEqual(execution, saved.execution);
              nativeReads++;
              return Promise.resolve(portOk({ ...saved, observedAt: NOW }));
            },
          });
          assert.equal(result, 0);
          assert.deepEqual(
            await fixture.read(),
            before,
            "maintenance preserves pointer and both proof slots",
          );
          assert.deepEqual(
            await repair.readRepair(),
            originalRepair,
            "unrelated task, intent and charge remain exact",
          );
        };
        await maintenance();
        assert.equal(await fixture.run(), 0);
        assert.equal(
          fixture.reports.at(-1)?.status,
          failedCandidate ? "rolled_back" : "installed",
        );
        assert.equal(
          fixture.reports.at(-1)?.candidateGeneration,
          failedCandidate ? 61 : 60,
        );
        assert.equal(
          fixture.reports.at(-1)?.candidateRevision,
          failedCandidate
            ? CONCURRENCY_RETRY_REVISION
            : CONCURRENCY_PLANNER_REVISION,
        );
        assert.equal(fixture.patches(), 1);
        await maintenance();
        assert.equal(nativeReads, 2);
        assert.equal(completionReads, 2);
        const prepared = await runHostedSupervisorPrepare({
          queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
          existingPrRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
          runtimeRollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
          state: release,
          clock: { now: () => NOW + 100 },
          run: {
            runId: failedCandidate ? 1203 : 1202,
            runAttempt: 1,
            launcherSha: LAUNCHER,
          },
          evidence: {
            readExecution: () => Promise.resolve(portOk(null)),
            verifyRevision: () => Promise.resolve(portOk(true)),
            verifyRequest: () => Promise.resolve(portOk(false)),
          },
        });
        assert.equal(prepared.status, "run");
        if (prepared.status !== "run") {
          throw new Error("exact installed pointer must admit verification");
        }
        assert.equal(prepared.execution.generation, failedCandidate ? 61 : 60);
        assert.equal(
          prepared.execution.revision,
          failedCandidate
            ? CONCURRENCY_RETRY_REVISION
            : CONCURRENCY_PLANNER_REVISION,
        );
        assert.equal(
          prepared.execution.purpose,
          "bootstrap",
          "verification cannot enable ordinary model starts",
        );
        assert.deepEqual(await repair.readRepair(), originalRepair);
      } finally {
        await command(["update-ref", repairRef, fixture.initialHead]);
        await fixture.close();
      }
    }
  },
);

Deno.test(
  "owner install runtime60: own healthy59 installs the exact planner once with saved bootstrap proof",
  async () => {
    const prior = hostedProof({
      runId: 37134515396,
      purpose: "bootstrap",
      releaseId: null,
      revision: CONCURRENCY_RETRY_REVISION,
      generation: 59,
      outcome: "healthy",
    });
    const state = releaseSnapshot({
      runtime: runtimeRecord({
        revision: CONCURRENCY_RETRY_REVISION,
        generation: 59,
        healthyProof: prior,
        executionProof: prior,
      }),
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const fixture = await concurrencyInstallerFixture(
      state,
      undefined,
      CONCURRENCY_PLANNER_REVISION,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "installed");
      assert.equal(
        fixture.reports.at(-1)?.candidateRevision,
        CONCURRENCY_PLANNER_REVISION,
      );
      assert.equal(fixture.reports.at(-1)?.candidateGeneration, 60);
      assert.equal(fixture.patches(), 1);
      const read = await fixture.read();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing installed planner");
      }
      assert.equal(
        read.value.snapshot.hostedRuntimes[0].activeRevision,
        CONCURRENCY_PLANNER_REVISION,
      );
      assert.equal(read.value.snapshot.hostedRuntimes[0].generation, 60);
      assert.deepEqual(
        read.value.snapshot.hostedRuntimes[0].lastHealthyProof,
        prior,
      );
      assert.deepEqual(
        read.value.snapshot.hostedReleases,
        state.hostedReleases,
      );
      assert.deepEqual(
        read.value.snapshot.githubCooldowns,
        state.githubCooldowns,
      );
      const recorded = JSON.parse(
        (await fixture.message()).trim().split("\n").at(-1)!,
      );
      assert.equal(recorded.stateHead, fixture.beforeHead);
      assert.equal(recorded.priorRevision, CONCURRENCY_RETRY_REVISION);
      assert.equal(recorded.priorGeneration, 59);
      assert.equal(recorded.nextRevision, CONCURRENCY_PLANNER_REVISION);
      assert.equal(recorded.nextGeneration, 60);
      assert.deepEqual(recorded.priorHealthyProof, prior);
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "waiting");
      assert.equal(fixture.patches(), 1);
    } finally {
      await fixture.close();
    }
  },
);

Deno.test(
  "owner install runtime60: exact failed60 restores only saved healthyc79 at terminal61 once",
  async () => {
    const prior = healthyProof(CONCURRENCY_RETRY_REVISION, 59, 37134515396);
    const runtime = runtimeRecord({
      revision: CONCURRENCY_PLANNER_REVISION,
      generation: 60,
      healthyProof: prior,
      executionProof: failedProof(CONCURRENCY_PLANNER_REVISION, 60, 1102),
    });
    const state = releaseSnapshot({
      runtime,
      hostedReleases: [acceptedRelease()],
    });
    const fixture = await concurrencyInstallerFixture(
      state,
      undefined,
      CONCURRENCY_PLANNER_REVISION,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "rolled_back");
      assert.equal(
        fixture.reports.at(-1)?.candidateRevision,
        CONCURRENCY_RETRY_REVISION,
      );
      assert.equal(fixture.reports.at(-1)?.candidateGeneration, 61);
      assert.equal(fixture.patches(), 1);
      assert.ok(
        !fixture.requests.some((request) =>
          request.path.includes("/compare/") ||
          request.path.includes("/check-runs")
        ),
      );
      const read = await fixture.read();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing planner rollback");
      }
      assert.deepEqual(
        read.value.snapshot.hostedRuntimes[0].lastHealthyProof,
        prior,
      );
      assert.deepEqual(
        read.value.snapshot.hostedReleases,
        state.hostedReleases,
      );
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "no_change");
      assert.equal(fixture.patches(), 1);
    } finally {
      await fixture.close();
    }
    for (
      const proof of [
        null,
        healthyProof(CONCURRENCY_PRIOR_REVISION, 58),
        healthyProof(CONCURRENCY_RETRY_REVISION, 58),
        healthyProof(UNRELATED, 59),
        healthyProof(CONCURRENCY_PLANNER_REVISION, 60),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({ runtime: { ...runtime, lastHealthyProof: proof } }),
          NOW,
        ).status,
        "waiting",
      );
    }
    for (
      const proof of [
        null,
        notStartedProof(CONCURRENCY_PLANNER_REVISION, 60),
        failedProof(CONCURRENCY_PLANNER_REVISION, 59),
        failedProof(UNRELATED, 60),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: { ...runtime, lastExecutionProof: proof },
          }),
          NOW,
        ).status,
        "waiting",
      );
    }
  },
);

Deno.test(
  "owner install runtime60: actual consumer refuses current ordinary stale proof CI conflicts and preserves distinct terminal pointers",
  async () => {
    const prior = healthyProof(CONCURRENCY_RETRY_REVISION, 59, 37134515396);
    const runtime = runtimeRecord({
      revision: CONCURRENCY_RETRY_REVISION,
      generation: 59,
      healthyProof: prior,
      executionProof: prior,
    });
    const healthy = releaseSnapshot({ runtime });
    const accepted60 = healthyProof(CONCURRENCY_PLANNER_REVISION, 60, 1103);
    const restored61 = healthyProof(CONCURRENCY_RETRY_REVISION, 61, 1104);
    const cases: {
      state: ReleaseStateSnapshotV1;
      refusal?: Parameters<typeof concurrencyInstallerFixture>[1];
      status: string;
      patches?: number;
    }[] = [
      {
        state: releaseSnapshot({
          runtime: { ...runtime, lastHealthyProof: null },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            lastHealthyProof: healthyProof(CONCURRENCY_PRIOR_REVISION, 58),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: { ...runtime, lastExecutionProof: null },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            lastExecutionProof: failedProof(CONCURRENCY_RETRY_REVISION, 59),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            lastExecutionProof: parseHostedRunProofV1({
              ...prior,
              observedAt: T0 + 2500,
            }),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: {
            ...runtime,
            execution: parseHostedExecutionIntentV1({
              ...executionIntent(CONCURRENCY_RETRY_REVISION, 59),
              id: "37136320870:1:repair",
              runId: 37136320870,
            }),
          },
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime,
          hostedReleases: [requestedRelease()],
        }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({ runtime, cooldowns: [cooldown(null)] }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({ runtime, cooldowns: [cooldown(NOW + 1)] }),
        status: "waiting",
      },
      {
        state: releaseSnapshot({
          runtime: runtimeRecord({
            revision: CONCURRENCY_PLANNER_REVISION,
            generation: 60,
            healthyProof: accepted60,
            executionProof: accepted60,
          }),
        }),
        status: "no_change",
      },
      {
        state: releaseSnapshot({
          runtime: runtimeRecord({
            revision: CONCURRENCY_RETRY_REVISION,
            generation: 61,
            healthyProof: restored61,
            executionProof: restored61,
          }),
        }),
        status: "no_change",
      },
      {
        state: releaseSnapshot({
          runtime: runtimeRecord({
            revision: CONCURRENCY_PRIOR_REVISION,
            generation: 60,
            healthyProof: healthyProof(CONCURRENCY_PRIOR_REVISION, 60),
          }),
        }),
        status: "no_change",
      },
      {
        state: releaseSnapshot({
          runtime: runtimeRecord({
            revision: UNRELATED,
            generation: 62,
            healthyProof: healthyProof(UNRELATED, 62),
          }),
        }),
        status: "no_change",
      },
      { state: healthy, refusal: "ancestry", status: "waiting" },
      { state: healthy, refusal: "ci", status: "waiting" },
      { state: healthy, refusal: "artifact", status: "waiting" },
      { state: healthy, refusal: "parent", status: "failed" },
      { state: healthy, refusal: "readback", status: "failed", patches: 1 },
    ];
    for (const entry of cases) {
      const fixture = await concurrencyInstallerFixture(
        entry.state,
        entry.refusal,
        CONCURRENCY_PLANNER_REVISION,
      );
      try {
        assert.equal(await fixture.run(), 0);
        assert.equal(
          fixture.reports.at(-1)?.status,
          entry.status,
          entry.refusal,
        );
        assert.equal(fixture.patches(), entry.patches ?? 0, entry.refusal);
        if (entry.refusal !== "parent" && entry.refusal !== "readback") {
          assert.equal(await fixture.head(), fixture.beforeHead);
        }
        if (entry.refusal === undefined || entry.refusal === "artifact") {
          assert.equal(fixture.requests.length, 0);
        }
      } finally {
        await fixture.close();
      }
    }
  },
);

// Exact public recovery identities; these never stand in for native execution proof.
