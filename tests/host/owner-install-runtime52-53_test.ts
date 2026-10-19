import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedReleaseRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  buildOwnerDevelopmentInstallSnapshot
    as productionBuildOwnerDevelopmentInstallSnapshot,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
  planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall,
} from "../../src/host/owner-development-install.ts";
import {
  AGGREGATE,
  CHILD_DEADLINE_GENERATION,
  CHILD_DEADLINE_REVISION,
  NOW,
  ORIGINAL,
  OWNER_REPAIR53_GENERATION,
  OWNER_REPAIR53_REVISION,
  RUNTIME52_GENERATION,
  RUNTIME52_REVISION,
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
  notStartedProof,
  releaseSnapshot,
  requestedRelease,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";

Deno.test(
  "owner install runtime52: a healthy generation 51 plans the exact one-generation install of the 80cc rung",
  () => {
    const childDeadlineHealthy = healthyProof(
      CHILD_DEADLINE_REVISION,
      CHILD_DEADLINE_GENERATION,
      501,
    );
    const state = releaseSnapshot({
      runtime: runtimeRecord({
        revision: CHILD_DEADLINE_REVISION,
        generation: CHILD_DEADLINE_GENERATION,
        healthyProof: childDeadlineHealthy,
        executionProof: childDeadlineHealthy,
      }),
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const before = canonicalStringify(state);
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.equal(plan.status, "install");
    if (plan.status !== "install") throw new Error("expected install");
    assert.equal(plan.move.action, "install");
    assert.equal(plan.move.priorRevision, CHILD_DEADLINE_REVISION);
    assert.equal(plan.move.priorGeneration, CHILD_DEADLINE_GENERATION);
    assert.equal(plan.move.nextRevision, RUNTIME52_REVISION);
    assert.equal(plan.move.nextGeneration, RUNTIME52_GENERATION);
    assert.equal(plan.move.nextGeneration, plan.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(plan.move.priorHealthyProof),
      canonicalStringify(childDeadlineHealthy),
    );
    // The planned install applies as exactly one generation movement and
    // leaves every release, cooldown and history record unchanged.
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );
    const priorRuntime = state.hostedRuntimes[0];
    const nextRuntime = planned.hostedRuntimes[0];
    assert.equal(planned.sequence, state.sequence + 1);
    assert.equal(planned.stateHead, STATE_HEAD);
    assert.equal(planned.updatedAt, NOW);
    assert.equal(
      canonicalStringify(planned.releases),
      canonicalStringify(state.releases),
    );
    assert.equal(
      canonicalStringify(planned.hostedReleases),
      canonicalStringify(state.hostedReleases),
    );
    assert.equal(
      canonicalStringify(planned.githubCooldowns),
      canonicalStringify(state.githubCooldowns),
    );
    assert.equal(nextRuntime.id, priorRuntime.id);
    assert.equal(nextRuntime.activeRevision, RUNTIME52_REVISION);
    assert.equal(nextRuntime.generation, RUNTIME52_GENERATION);
    assert.equal(
      canonicalStringify(nextRuntime.lastHealthyProof),
      canonicalStringify(priorRuntime.lastHealthyProof),
    );
    assert.equal(
      canonicalStringify(nextRuntime.lastExecutionProof),
      canonicalStringify(priorRuntime.lastExecutionProof),
    );
    assert.equal(canonicalStringify(state), before);

    // No proof, or a proof bound to another revision or generation, never
    // authorizes the new rung.
    for (
      const healthy of [
        healthyProof(CHILD_DEADLINE_REVISION, 50, 502),
        healthyProof(UNRELATED, 51, 503),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: CHILD_DEADLINE_REVISION,
              generation: CHILD_DEADLINE_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }
  },
);

Deno.test(
  "owner install runtime52: an exact failed generation 52 rolls back to the recorded 1f90 generation 51 predecessor",
  () => {
    const childDeadlineHealthy = healthyProof(
      CHILD_DEADLINE_REVISION,
      CHILD_DEADLINE_GENERATION,
      511,
    );
    const state = releaseSnapshot({
      runtime: runtimeRecord({
        revision: RUNTIME52_REVISION,
        generation: RUNTIME52_GENERATION,
        healthyProof: childDeadlineHealthy,
        executionProof: failedProof(
          RUNTIME52_REVISION,
          RUNTIME52_GENERATION,
          512,
        ),
      }),
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const before = canonicalStringify(state);
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.equal(plan.status, "rollback");
    if (plan.status !== "rollback") throw new Error("expected rollback");
    assert.equal(plan.move.action, "rollback");
    assert.equal(plan.move.priorRevision, RUNTIME52_REVISION);
    assert.equal(plan.move.priorGeneration, RUNTIME52_GENERATION);
    assert.equal(plan.move.nextRevision, CHILD_DEADLINE_REVISION);
    assert.equal(plan.move.nextGeneration, RUNTIME52_GENERATION + 1);
    assert.equal(plan.move.nextGeneration, plan.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(plan.move.priorHealthyProof),
      canonicalStringify(childDeadlineHealthy),
    );
    // The rollback applies as exactly one generation movement to the recorded
    // healthy predecessor and leaves every unrelated record unchanged.
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );
    const priorRuntime = state.hostedRuntimes[0];
    const nextRuntime = planned.hostedRuntimes[0];
    assert.equal(planned.sequence, state.sequence + 1);
    assert.equal(planned.stateHead, STATE_HEAD);
    assert.equal(planned.updatedAt, NOW);
    assert.equal(
      canonicalStringify(planned.releases),
      canonicalStringify(state.releases),
    );
    assert.equal(
      canonicalStringify(planned.hostedReleases),
      canonicalStringify(state.hostedReleases),
    );
    assert.equal(
      canonicalStringify(planned.githubCooldowns),
      canonicalStringify(state.githubCooldowns),
    );
    assert.equal(nextRuntime.id, priorRuntime.id);
    assert.equal(nextRuntime.activeRevision, CHILD_DEADLINE_REVISION);
    assert.equal(
      nextRuntime.generation,
      RUNTIME52_GENERATION + 1,
    );
    assert.equal(
      canonicalStringify(nextRuntime.lastHealthyProof),
      canonicalStringify(priorRuntime.lastHealthyProof),
    );
    assert.equal(
      canonicalStringify(nextRuntime.lastExecutionProof),
      canonicalStringify(priorRuntime.lastExecutionProof),
    );
    assert.equal(canonicalStringify(state), before);

    // A missing predecessor proof, a proof of the failed pointer itself and a
    // wrong-generation predecessor proof never authorize the rollback.
    const refusals = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RUNTIME52_REVISION,
          generation: RUNTIME52_GENERATION,
          executionProof: failedProof(
            RUNTIME52_REVISION,
            RUNTIME52_GENERATION,
            513,
          ),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RUNTIME52_REVISION,
          generation: RUNTIME52_GENERATION,
          healthyProof: healthyProof(
            RUNTIME52_REVISION,
            RUNTIME52_GENERATION,
            514,
          ),
          executionProof: failedProof(
            RUNTIME52_REVISION,
            RUNTIME52_GENERATION,
            515,
          ),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RUNTIME52_REVISION,
          generation: RUNTIME52_GENERATION,
          healthyProof: healthyProof(
            CHILD_DEADLINE_REVISION,
            RUNTIME52_GENERATION,
            516,
          ),
          executionProof: failedProof(
            RUNTIME52_REVISION,
            RUNTIME52_GENERATION,
            517,
          ),
        }),
      }),
    ];
    for (const refusal of refusals) {
      assert.equal(
        planOwnerDevelopmentInstall(refusal, NOW).status,
        "waiting",
      );
    }
  },
);

Deno.test(
  "owner install owner-repair53: an idle unproven generation 52 installs the pinned 573d repair at generation 53",
  () => {
    const retained51 = healthyProof(
      CHILD_DEADLINE_REVISION,
      CHILD_DEADLINE_GENERATION,
      601,
    );
    // The pointer is exactly the idle unproven generation 52 revision: no
    // settlement and no healthy proof of its own, only the genuine retained
    // generation 51 proof.
    const state = releaseSnapshot({
      runtime: runtimeRecord({
        revision: RUNTIME52_REVISION,
        generation: RUNTIME52_GENERATION,
        healthyProof: retained51,
      }),
    });
    const before = canonicalStringify(state);
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.equal(plan.status, "install");
    if (plan.status !== "install") throw new Error("expected install");
    assert.equal(plan.move.action, "install");
    assert.equal(plan.move.priorRevision, RUNTIME52_REVISION);
    assert.equal(plan.move.priorGeneration, RUNTIME52_GENERATION);
    assert.equal(plan.move.nextRevision, OWNER_REPAIR53_REVISION);
    assert.equal(plan.move.nextGeneration, OWNER_REPAIR53_GENERATION);
    assert.equal(plan.move.nextGeneration, plan.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(plan.move.priorHealthyProof),
      canonicalStringify(retained51),
    );
    // The repair install applies to the intended snapshot and preserves the
    // retained prior proof and every unrelated release/history record.
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );
    const priorRuntime = state.hostedRuntimes[0];
    const nextRuntime = planned.hostedRuntimes[0];
    assert.equal(planned.sequence, state.sequence + 1);
    assert.equal(planned.stateHead, STATE_HEAD);
    assert.equal(planned.updatedAt, NOW);
    assert.equal(
      canonicalStringify(planned.releases),
      canonicalStringify(state.releases),
    );
    assert.equal(
      canonicalStringify(planned.hostedReleases),
      canonicalStringify(state.hostedReleases),
    );
    assert.equal(
      canonicalStringify(planned.githubCooldowns),
      canonicalStringify(state.githubCooldowns),
    );
    assert.equal(nextRuntime.id, priorRuntime.id);
    assert.equal(nextRuntime.activeRevision, OWNER_REPAIR53_REVISION);
    assert.equal(nextRuntime.generation, OWNER_REPAIR53_GENERATION);
    assert.equal(nextRuntime.createdAt, priorRuntime.createdAt);
    assert.equal(
      canonicalStringify(nextRuntime.lastHealthyProof),
      canonicalStringify(retained51),
    );
    assert.equal(
      canonicalStringify(nextRuntime.lastExecutionProof),
      canonicalStringify(priorRuntime.lastExecutionProof),
    );
    assert.equal(canonicalStringify(state), before);

    // A missing or mismatched retained proof never authorizes the repair
    // install.
    const refusals = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RUNTIME52_REVISION,
          generation: RUNTIME52_GENERATION,
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RUNTIME52_REVISION,
          generation: RUNTIME52_GENERATION,
          healthyProof: healthyProof(
            UNRELATED,
            CHILD_DEADLINE_GENERATION,
            602,
          ),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RUNTIME52_REVISION,
          generation: RUNTIME52_GENERATION,
          healthyProof: healthyProof(
            CHILD_DEADLINE_REVISION,
            RUNTIME52_GENERATION,
            603,
          ),
        }),
      }),
    ];
    for (const refusal of refusals) {
      assert.equal(
        planOwnerDevelopmentInstall(refusal, NOW).status,
        "waiting",
      );
    }

    // A retained earlier settlement remains history, while any inconsistent
    // own-generation settlement cannot be ignored to take the repair path.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: RUNTIME52_REVISION,
            generation: RUNTIME52_GENERATION,
            healthyProof: retained51,
            executionProof: retained51,
          }),
        }),
        NOW,
      ).status,
      "install",
    );
    for (
      const settlement of [
        healthyProof(RUNTIME52_REVISION, RUNTIME52_GENERATION, 605),
        notStartedProof(RUNTIME52_REVISION, RUNTIME52_GENERATION),
        failedProof(UNRELATED, RUNTIME52_GENERATION, 606),
        failedProof(RUNTIME52_REVISION, CHILD_DEADLINE_GENERATION, 607),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: RUNTIME52_REVISION,
              generation: RUNTIME52_GENERATION,
              healthyProof: retained51,
              executionProof: settlement,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }
    for (
      const proof of [
        { ...retained51, repository: "ubiquity/ai.ubq.fi" },
        { ...retained51, ref: "refs/heads/development" },
      ]
    ) {
      const tampered = structuredClone(state);
      tampered.hostedRuntimes[0].lastHealthyProof = proof;
      assert.equal(
        planOwnerDevelopmentInstall(tampered, NOW).status,
        "waiting",
      );
    }

    // The proven generation 52 keeps its existing terminal outcome instead of
    // taking the unproven repair path.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: RUNTIME52_REVISION,
            generation: RUNTIME52_GENERATION,
            healthyProof: healthyProof(
              RUNTIME52_REVISION,
              RUNTIME52_GENERATION,
              604,
            ),
            executionProof: healthyProof(
              RUNTIME52_REVISION,
              RUNTIME52_GENERATION,
              604,
            ),
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );

    // A running execution, a requested release, a live pointer intent and an
    // active cooldown each keep the repair install a zero-write wait.
    const intentRelease = parseHostedReleaseRecordV1({
      ...acceptedRelease(),
      phase: "promoting",
      pointerIntent: {
        action: "promote",
        expectedRevision: ORIGINAL,
        nextRevision: AGGREGATE,
        expectedGeneration: OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
        createdAt: T0,
      },
    });
    const gated = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RUNTIME52_REVISION,
          generation: RUNTIME52_GENERATION,
          healthyProof: retained51,
          execution: executionIntent(RUNTIME52_REVISION, RUNTIME52_GENERATION),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RUNTIME52_REVISION,
          generation: RUNTIME52_GENERATION,
          healthyProof: retained51,
        }),
        hostedReleases: [requestedRelease()],
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RUNTIME52_REVISION,
          generation: RUNTIME52_GENERATION,
          healthyProof: retained51,
        }),
        hostedReleases: [intentRelease],
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RUNTIME52_REVISION,
          generation: RUNTIME52_GENERATION,
          healthyProof: retained51,
        }),
        cooldowns: [cooldown(NOW + 1)],
      }),
    ];
    for (const gatedState of gated) {
      assert.equal(
        planOwnerDevelopmentInstall(gatedState, NOW).status,
        "waiting",
      );
    }
  },
);

Deno.test(
  "owner install owner-repair53: a failed corrected generation 53 rolls back to the recorded 1f90 generation 51 predecessor at generation 54",
  () => {
    const retained51 = healthyProof(
      CHILD_DEADLINE_REVISION,
      CHILD_DEADLINE_GENERATION,
      611,
    );
    const state = releaseSnapshot({
      runtime: runtimeRecord({
        revision: OWNER_REPAIR53_REVISION,
        generation: OWNER_REPAIR53_GENERATION,
        healthyProof: retained51,
        executionProof: failedProof(
          OWNER_REPAIR53_REVISION,
          OWNER_REPAIR53_GENERATION,
          612,
        ),
      }),
    });
    const before = canonicalStringify(state);
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.equal(plan.status, "rollback");
    if (plan.status !== "rollback") throw new Error("expected rollback");
    assert.equal(plan.move.action, "rollback");
    assert.equal(plan.move.priorRevision, OWNER_REPAIR53_REVISION);
    assert.equal(plan.move.priorGeneration, OWNER_REPAIR53_GENERATION);
    assert.equal(plan.move.nextRevision, CHILD_DEADLINE_REVISION);
    assert.equal(plan.move.nextGeneration, OWNER_REPAIR53_GENERATION + 1);
    assert.equal(plan.move.nextGeneration, plan.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(plan.move.priorHealthyProof),
      canonicalStringify(retained51),
    );
    // The single rollback applies to the intended snapshot and preserves the
    // recorded prior proof and every unrelated release/history record.
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );
    const priorRuntime = state.hostedRuntimes[0];
    const nextRuntime = planned.hostedRuntimes[0];
    assert.equal(planned.sequence, state.sequence + 1);
    assert.equal(planned.stateHead, STATE_HEAD);
    assert.equal(planned.updatedAt, NOW);
    assert.equal(
      canonicalStringify(planned.releases),
      canonicalStringify(state.releases),
    );
    assert.equal(
      canonicalStringify(planned.hostedReleases),
      canonicalStringify(state.hostedReleases),
    );
    assert.equal(
      canonicalStringify(planned.githubCooldowns),
      canonicalStringify(state.githubCooldowns),
    );
    assert.equal(nextRuntime.id, priorRuntime.id);
    assert.equal(nextRuntime.activeRevision, CHILD_DEADLINE_REVISION);
    assert.equal(nextRuntime.generation, OWNER_REPAIR53_GENERATION + 1);
    assert.equal(nextRuntime.createdAt, priorRuntime.createdAt);
    assert.equal(
      canonicalStringify(nextRuntime.lastHealthyProof),
      canonicalStringify(retained51),
    );
    assert.equal(
      canonicalStringify(nextRuntime.lastExecutionProof),
      canonicalStringify(priorRuntime.lastExecutionProof),
    );
    assert.equal(canonicalStringify(state), before);

    // Installing the corrected pointer retains the earlier proof; it must wait
    // for its own genuine generation 53 healthy settlement before completion.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: OWNER_REPAIR53_REVISION,
            generation: OWNER_REPAIR53_GENERATION,
            healthyProof: retained51,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );

    // A missing, own-generation or wrong-generation predecessor proof never
    // authorizes the rollback.
    const refusals = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: OWNER_REPAIR53_REVISION,
          generation: OWNER_REPAIR53_GENERATION,
          executionProof: failedProof(
            OWNER_REPAIR53_REVISION,
            OWNER_REPAIR53_GENERATION,
            613,
          ),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: OWNER_REPAIR53_REVISION,
          generation: OWNER_REPAIR53_GENERATION,
          healthyProof: healthyProof(
            OWNER_REPAIR53_REVISION,
            OWNER_REPAIR53_GENERATION,
            614,
          ),
          executionProof: failedProof(
            OWNER_REPAIR53_REVISION,
            OWNER_REPAIR53_GENERATION,
            615,
          ),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: OWNER_REPAIR53_REVISION,
          generation: OWNER_REPAIR53_GENERATION,
          healthyProof: healthyProof(
            CHILD_DEADLINE_REVISION,
            OWNER_REPAIR53_GENERATION,
            616,
          ),
          executionProof: failedProof(
            OWNER_REPAIR53_REVISION,
            OWNER_REPAIR53_GENERATION,
            617,
          ),
        }),
      }),
    ];
    for (const refusal of refusals) {
      assert.equal(
        planOwnerDevelopmentInstall(refusal, NOW).status,
        "waiting",
      );
    }

    // Both rollback targets (1f90 generation 53 and 1f90 generation 54)
    // stay terminal with no automatic retry.
    for (
      const terminalState of [
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: CHILD_DEADLINE_REVISION,
            generation: OWNER_REPAIR53_GENERATION,
            healthyProof: retained51,
          }),
        }),
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: CHILD_DEADLINE_REVISION,
            generation: OWNER_REPAIR53_GENERATION + 1,
            healthyProof: retained51,
          }),
        }),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(terminalState, NOW).status,
        "no_change",
      );
    }
  },
);

/** Keep explicit policy/refusal inputs; only historical omissions use fixture policy. */
function planOwnerDevelopmentInstall(
  ...args: Parameters<typeof productionPlanOwnerDevelopmentInstall>
): ReturnType<typeof productionPlanOwnerDevelopmentInstall> {
  return productionPlanOwnerDevelopmentInstall(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.queue : args[4],
    args[5] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.custody : args[5],
    args[6] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.rollout : args[6],
    args[7],
    args[8],
  );
}

/** Snapshot validation uses the same historical policy as its real planner. */
function buildOwnerDevelopmentInstallSnapshot(
  ...args: Parameters<typeof productionBuildOwnerDevelopmentInstallSnapshot>
): ReturnType<typeof productionBuildOwnerDevelopmentInstallSnapshot> {
  return productionBuildOwnerDevelopmentInstallSnapshot(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[6] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.queue : args[6],
    args[7] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.custody : args[7],
    args[8],
    args[9] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.rollout : args[9],
    args[10],
  );
}
