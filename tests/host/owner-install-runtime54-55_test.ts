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
  CHILD_DEADLINE_REVISION,
  NOW,
  ORIGINAL,
  OWNER_REPAIR53_GENERATION,
  OWNER_REPAIR53_REVISION,
  RUNTIME54_GENERATION,
  RUNTIME54_REVISION,
  RUNTIME55_GENERATION,
  RUNTIME55_REVISION,
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
  "owner install runtime54: the public planner installs exact a6c4 generation 54 only from proven idle 573d generation 53",
  () => {
    const proven53 = healthyProof(OWNER_REPAIR53_REVISION, 53, 701);
    const runtime = runtimeRecord({
      revision: OWNER_REPAIR53_REVISION,
      generation: OWNER_REPAIR53_GENERATION,
      healthyProof: proven53,
      executionProof: proven53,
    });
    const state = releaseSnapshot({
      runtime,
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const before = canonicalStringify(state);
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.equal(plan.status, "install");
    if (plan.status !== "install") throw new Error("expected install");
    assert.deepEqual(plan.move, {
      action: "install",
      priorRevision: OWNER_REPAIR53_REVISION,
      priorGeneration: OWNER_REPAIR53_GENERATION,
      nextRevision: RUNTIME54_REVISION,
      nextGeneration: RUNTIME54_GENERATION,
      priorHealthyProof: proven53,
    });
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );
    assert.deepEqual(planned, {
      ...state,
      stateHead: STATE_HEAD,
      sequence: state.sequence + 1,
      updatedAt: NOW,
      hostedRuntimes: [{
        ...runtime,
        activeRevision: RUNTIME54_REVISION,
        generation: RUNTIME54_GENERATION,
        updatedAt: NOW,
        nextOrdinaryAt: NOW,
      }],
    });
    assert.equal(canonicalStringify(state), before);

    for (
      const proof of [
        null,
        healthyProof(OWNER_REPAIR53_REVISION, 52, 702),
        healthyProof(UNRELATED, 53, 703),
        healthyProof(CHILD_DEADLINE_REVISION, 51, 704),
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
        { ...proven53, repository: "ubiquity/ai.ubq.fi" },
        { ...proven53, ref: "refs/heads/development" },
      ]
    ) {
      const tampered = structuredClone(state);
      tampered.hostedRuntimes[0].lastHealthyProof = proof;
      assert.equal(
        planOwnerDevelopmentInstall(tampered, NOW).status,
        "waiting",
      );
    }

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
    for (
      const gated of [
        releaseSnapshot({
          runtime: {
            ...runtime,
            execution: executionIntent(OWNER_REPAIR53_REVISION, 53),
          },
        }),
        releaseSnapshot({ runtime, hostedReleases: [requestedRelease()] }),
        releaseSnapshot({ runtime, hostedReleases: [intentRelease] }),
        releaseSnapshot({ runtime, cooldowns: [cooldown(NOW + 1)] }),
        releaseSnapshot({ runtime, cooldowns: [cooldown(null)] }),
      ]
    ) {
      const unchanged = canonicalStringify(gated);
      assert.equal(planOwnerDevelopmentInstall(gated, NOW).status, "waiting");
      assert.equal(canonicalStringify(gated), unchanged);
    }
    // A movement computed from another pointer or proof cannot be applied.
    for (
      const stale of [
        { ...plan.move, priorRevision: UNRELATED },
        { ...plan.move, priorGeneration: 52 },
        {
          ...plan.move,
          priorHealthyProof: healthyProof(OWNER_REPAIR53_REVISION, 53, 705),
        },
      ]
    ) {
      assert.throws(() =>
        buildOwnerDevelopmentInstallSnapshot(state, STATE_HEAD, stale, NOW)
      );
    }
  },
);

Deno.test(
  "owner install runtime54: an exact failed a6c4 generation 54 applies one rollback to proven 573d generation 55 and never retries",
  () => {
    const proven53 = healthyProof(OWNER_REPAIR53_REVISION, 53, 711);
    const failed54 = failedProof(RUNTIME54_REVISION, RUNTIME54_GENERATION, 712);
    const runtime = runtimeRecord({
      revision: RUNTIME54_REVISION,
      generation: RUNTIME54_GENERATION,
      healthyProof: proven53,
      executionProof: failed54,
    });
    const state = releaseSnapshot({
      runtime,
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const before = canonicalStringify(state);
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.equal(plan.status, "rollback");
    if (plan.status !== "rollback") throw new Error("expected rollback");
    assert.deepEqual(plan.move, {
      action: "rollback",
      priorRevision: RUNTIME54_REVISION,
      priorGeneration: RUNTIME54_GENERATION,
      nextRevision: OWNER_REPAIR53_REVISION,
      nextGeneration: 55,
      priorHealthyProof: proven53,
    });
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );
    assert.deepEqual(planned, {
      ...state,
      stateHead: STATE_HEAD,
      sequence: state.sequence + 1,
      updatedAt: NOW,
      hostedRuntimes: [{
        ...runtime,
        activeRevision: OWNER_REPAIR53_REVISION,
        generation: 55,
        updatedAt: NOW,
        nextOrdinaryAt: NOW,
      }],
    });
    assert.equal(canonicalStringify(state), before);
    assert.equal(planOwnerDevelopmentInstall(planned, NOW).status, "no_change");
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: OWNER_REPAIR53_REVISION,
            generation: 55,
            healthyProof: healthyProof(OWNER_REPAIR53_REVISION, 55, 713),
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
    assert.throws(() =>
      buildOwnerDevelopmentInstallSnapshot(planned, STATE_HEAD, plan.move, NOW)
    );

    for (
      const proof of [
        null,
        healthyProof(UNRELATED, 53, 714),
        healthyProof(OWNER_REPAIR53_REVISION, 52, 715),
        healthyProof(RUNTIME54_REVISION, RUNTIME54_GENERATION, 716),
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
      const settlement of [
        null,
        notStartedProof(RUNTIME54_REVISION, RUNTIME54_GENERATION),
        failedProof(UNRELATED, RUNTIME54_GENERATION, 717),
        failedProof(RUNTIME54_REVISION, 53, 718),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: { ...runtime, lastExecutionProof: settlement },
          }),
          NOW,
        ).status,
        "waiting",
      );
    }
    const healthy54 = healthyProof(
      RUNTIME54_REVISION,
      RUNTIME54_GENERATION,
      719,
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: {
            ...runtime,
            lastHealthyProof: healthy54,
            lastExecutionProof: healthy54,
          },
        }),
        NOW,
      ).status,
      "install",
    );
  },
);

Deno.test(
  "owner install runtime55: proven idle a6c4 generation 54 installs exact 275f generation 55 while failed a6c4 retains its distinct rollback",
  () => {
    const proven54 = healthyProof(
      RUNTIME54_REVISION,
      RUNTIME54_GENERATION,
      801,
    );
    const runtime = runtimeRecord({
      revision: RUNTIME54_REVISION,
      generation: RUNTIME54_GENERATION,
      healthyProof: proven54,
      executionProof: proven54,
    });
    const state = releaseSnapshot({
      runtime,
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const before = canonicalStringify(state);
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.equal(plan.status, "install");
    if (plan.status !== "install") throw new Error("expected install");
    assert.deepEqual(plan.move, {
      action: "install",
      priorRevision: RUNTIME54_REVISION,
      priorGeneration: RUNTIME54_GENERATION,
      nextRevision: RUNTIME55_REVISION,
      nextGeneration: RUNTIME55_GENERATION,
      priorHealthyProof: proven54,
    });
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );
    assert.deepEqual(planned, {
      ...state,
      stateHead: STATE_HEAD,
      sequence: state.sequence + 1,
      updatedAt: NOW,
      hostedRuntimes: [{
        ...runtime,
        activeRevision: RUNTIME55_REVISION,
        generation: RUNTIME55_GENERATION,
        updatedAt: NOW,
        nextOrdinaryAt: NOW,
      }],
    });
    assert.equal(canonicalStringify(state), before);
    assert.throws(() =>
      buildOwnerDevelopmentInstallSnapshot(planned, STATE_HEAD, plan.move, NOW)
    );
    for (
      const proof of [
        null,
        healthyProof(RUNTIME54_REVISION, 53, 802),
        healthyProof(UNRELATED, 54, 803),
        healthyProof(OWNER_REPAIR53_REVISION, 53, 804),
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
    for (
      const gated of [
        releaseSnapshot({
          runtime: {
            ...runtime,
            execution: executionIntent(RUNTIME54_REVISION, 54),
          },
        }),
        releaseSnapshot({ runtime, hostedReleases: [requestedRelease()] }),
        releaseSnapshot({ runtime, hostedReleases: [intentRelease] }),
        releaseSnapshot({ runtime, cooldowns: [cooldown(NOW + 1)] }),
        releaseSnapshot({ runtime, cooldowns: [cooldown(null)] }),
      ]
    ) {
      assert.equal(planOwnerDevelopmentInstall(gated, NOW).status, "waiting");
    }
    const failed54 = failedProof(RUNTIME54_REVISION, 54, 805);
    // Latest exact failure has precedence over the pointer's earlier health.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: { ...runtime, lastExecutionProof: failed54 },
        }),
        NOW,
      ).status,
      "waiting",
    );
    const proven53 = healthyProof(OWNER_REPAIR53_REVISION, 53, 806);
    const failedState = releaseSnapshot({
      runtime: {
        ...runtime,
        lastHealthyProof: proven53,
        lastExecutionProof: failed54,
      },
    });
    const rollback = planOwnerDevelopmentInstall(failedState, NOW);
    assert.equal(rollback.status, "rollback");
    if (rollback.status !== "rollback") throw new Error("expected rollback");
    assert.equal(rollback.move.nextRevision, OWNER_REPAIR53_REVISION);
    assert.equal(rollback.move.nextGeneration, 55);
    const restored = buildOwnerDevelopmentInstallSnapshot(
      failedState,
      STATE_HEAD,
      rollback.move,
      NOW,
    );
    assert.equal(
      planOwnerDevelopmentInstall(restored, NOW).status,
      "no_change",
    );
  },
);

Deno.test(
  "owner install runtime55: exact failed 275f generation 55 restores proven a6c4 once at terminal generation 56",
  () => {
    const proven54 = healthyProof(
      RUNTIME54_REVISION,
      RUNTIME54_GENERATION,
      811,
    );
    const failed55 = failedProof(RUNTIME55_REVISION, RUNTIME55_GENERATION, 812);
    const runtime = runtimeRecord({
      revision: RUNTIME55_REVISION,
      generation: RUNTIME55_GENERATION,
      healthyProof: proven54,
      executionProof: failed55,
    });
    const state = releaseSnapshot({
      runtime,
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const before = canonicalStringify(state);
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.equal(plan.status, "rollback");
    if (plan.status !== "rollback") throw new Error("expected rollback");
    assert.deepEqual(plan.move, {
      action: "rollback",
      priorRevision: RUNTIME55_REVISION,
      priorGeneration: RUNTIME55_GENERATION,
      nextRevision: RUNTIME54_REVISION,
      nextGeneration: 56,
      priorHealthyProof: proven54,
    });
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );
    assert.deepEqual(planned, {
      ...state,
      stateHead: STATE_HEAD,
      sequence: state.sequence + 1,
      updatedAt: NOW,
      hostedRuntimes: [{
        ...runtime,
        activeRevision: RUNTIME54_REVISION,
        generation: 56,
        updatedAt: NOW,
        nextOrdinaryAt: NOW,
      }],
    });
    assert.equal(canonicalStringify(state), before);
    assert.equal(planOwnerDevelopmentInstall(planned, NOW).status, "no_change");
    assert.throws(() =>
      buildOwnerDevelopmentInstallSnapshot(planned, STATE_HEAD, plan.move, NOW)
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: RUNTIME54_REVISION,
            generation: 56,
            healthyProof: healthyProof(RUNTIME54_REVISION, 56, 813),
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
    for (
      const proof of [
        null,
        healthyProof(UNRELATED, 54, 814),
        healthyProof(RUNTIME54_REVISION, 53, 815),
        healthyProof(RUNTIME55_REVISION, 55, 816),
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
      const settlement of [
        null,
        notStartedProof(RUNTIME55_REVISION, 55),
        failedProof(UNRELATED, 55, 817),
        failedProof(RUNTIME55_REVISION, 54, 818),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: { ...runtime, lastExecutionProof: settlement },
          }),
          NOW,
        ).status,
        "waiting",
      );
    }
    const proven55 = healthyProof(RUNTIME55_REVISION, 55, 819);
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: {
            ...runtime,
            lastHealthyProof: proven55,
            lastExecutionProof: proven55,
          },
        }),
        NOW,
      ).status,
      "no_change",
    );
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
