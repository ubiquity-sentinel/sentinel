import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import {
  buildOwnerDevelopmentInstallSnapshot
    as productionBuildOwnerDevelopmentInstallSnapshot,
  ownerDevelopmentInstallCommitMessage,
  ownerDevelopmentInstallFiles,
  planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall,
} from "../../src/host/owner-development-install.ts";
import {
  AGGREGATE,
  APP_IDENTITY,
  CANDIDATE_AUTH,
  DELIVERED_ROUND2,
  FOREIGN_AUTH,
  MODEL_ROUTE,
  MULTI_TARGET,
  NOW,
  ORIGINAL,
  PRESERVE_SCOPE,
  READER,
  REASON_CODE,
  RELEASED,
  RESERVE_MODEL,
  SCOPE_GATE,
  SETTLEMENT,
  STATE_HEAD,
  TRIGGER,
} from "./owner-install-fixture-constants.ts";
import {
  acceptedRelease,
  cooldown,
  failedProof,
  healthyProof,
  rawSha256,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";

Deno.test(
  "owner development install snapshot: only the planned runtime fields change and historical proof is preserved",
  () => {
    const readerHealthy = healthyProof(READER, 6, 81);
    const originalHealthy = healthyProof(ORIGINAL, 5, 82);

    const installState = releaseSnapshot({
      runtime: runtimeRecord({
        revision: READER,
        generation: 6,
        healthyProof: readerHealthy,
        executionProof: readerHealthy,
      }),
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const rollbackState = releaseSnapshot({
      runtime: runtimeRecord({
        revision: READER,
        generation: 6,
        healthyProof: originalHealthy,
        executionProof: failedProof(READER, 6, 83),
      }),
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });

    for (const state of [installState, rollbackState]) {
      const before = canonicalStringify(state);
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.ok(plan.status === "install" || plan.status === "rollback");
      if (plan.status !== "install" && plan.status !== "rollback") {
        throw new Error("expected a move");
      }
      const planned = buildOwnerDevelopmentInstallSnapshot(
        state,
        STATE_HEAD,
        plan.move,
        NOW,
      );
      const priorRuntime = state.hostedRuntimes[0];
      const nextRuntime = planned.hostedRuntimes[0];

      assert.equal(planned.version, "v1");
      assert.equal(planned.kind, "release_state_snapshot");
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
      assert.equal(planned.hostedRuntimes.length, 1);
      assert.equal(nextRuntime.id, priorRuntime.id);
      assert.equal(nextRuntime.activeRevision, plan.move.nextRevision);
      assert.equal(nextRuntime.generation, plan.move.nextGeneration);
      assert.equal(nextRuntime.nextOrdinaryAt, NOW);
      assert.equal(nextRuntime.updatedAt, NOW);
      assert.equal(nextRuntime.createdAt, priorRuntime.createdAt);
      assert.equal(nextRuntime.execution, null);
      assert.equal(
        canonicalStringify(nextRuntime.lastHealthyProof),
        canonicalStringify(priorRuntime.lastHealthyProof),
      );
      assert.equal(
        canonicalStringify(nextRuntime.lastExecutionProof),
        canonicalStringify(priorRuntime.lastExecutionProof),
      );
      // The planning boundary never mutates its input snapshot.
      assert.equal(canonicalStringify(state), before);
    }

    // A move that does not bind the exact read pointer is refused outright.
    const plan = planOwnerDevelopmentInstall(installState, NOW);
    if (plan.status !== "install") throw new Error("expected install");
    assert.throws(() =>
      buildOwnerDevelopmentInstallSnapshot(
        installState,
        STATE_HEAD,
        { ...plan.move, priorGeneration: 2 },
        NOW,
      )
    );
  },
);

Deno.test(
  "owner development install files: canonical manifest, digest record path and bounded commit record",
  async () => {
    const proof = healthyProof(READER, 6, 91);
    const state = releaseSnapshot({
      runtime: runtimeRecord({
        revision: READER,
        generation: 6,
        healthyProof: proof,
        executionProof: proof,
      }),
      hostedReleases: [acceptedRelease()],
    });
    const plan = planOwnerDevelopmentInstall(state, NOW);
    if (plan.status !== "install") throw new Error("expected install");
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );

    const files = await ownerDevelopmentInstallFiles(planned, STATE_HEAD);
    assert.equal(files.manifest.path, "manifest.json");
    const manifest = JSON.parse(files.manifest.text);
    assert.equal(manifest.version, "v1");
    assert.equal(manifest.kind, "release_state_manifest");
    assert.equal(manifest.sequence, state.sequence + 1);
    assert.equal(manifest.updatedAt, NOW);
    assert.equal(manifest.stateHead, STATE_HEAD);
    assert.equal(
      files.manifest.text,
      `${canonicalStringify(manifest)}\n`,
    );

    const runtime = planned.hostedRuntimes[0];
    const digest = await rawSha256(HOSTED_RUNTIME_ID);
    assert.equal(
      files.record.path,
      `hostedRuntimes/${digest}.json`,
    );
    assert.match(files.record.path, /^hostedRuntimes\/[0-9a-f]{64}\.json$/);
    assert.equal(
      files.record.text,
      `${canonicalStringify(runtime)}\n`,
    );
    const reread = JSON.parse(files.record.text);
    assert.equal(reread.id, HOSTED_RUNTIME_ID);
    assert.equal(reread.activeRevision, plan.move.nextRevision);
    assert.equal(reread.generation, plan.move.nextGeneration);
    assert.equal(reread.nextOrdinaryAt, NOW);

    const record = {
      version: "v1" as const,
      kind: "owner_development_install" as const,
      authority: "owner" as const,
      action: plan.move.action,
      authorizedAt: NOW,
      priorRevision: plan.move.priorRevision,
      priorGeneration: plan.move.priorGeneration,
      nextRevision: plan.move.nextRevision,
      nextGeneration: plan.move.nextGeneration,
      stateHead: STATE_HEAD,
      priorHealthyProof: plan.move.priorHealthyProof,
      nonce: "a".repeat(64),
    };
    const message = ownerDevelopmentInstallCommitMessage(record);
    assert.ok(message.startsWith("owner-development-install\n\n"));
    assert.ok(message.length < 8_192);
    const lines = message.trim().split("\n");
    const parsed = JSON.parse(lines[lines.length - 1]);
    assert.equal(parsed.kind, "owner_development_install");
    assert.equal(parsed.authority, "owner");
    assert.equal(parsed.action, "install");
    assert.equal(parsed.authorizedAt, NOW);
    assert.equal(parsed.priorRevision, plan.move.priorRevision);
    assert.equal(parsed.priorGeneration, plan.move.priorGeneration);
    assert.equal(parsed.nextRevision, AGGREGATE);
    assert.equal(parsed.nextGeneration, 7);
    assert.equal(parsed.stateHead, STATE_HEAD);
    assert.equal(parsed.nonce, "a".repeat(64));
    assert.equal(
      canonicalStringify(parsed.priorHealthyProof),
      canonicalStringify(proof),
    );

    // A malformed record is refused instead of serialized.
    assert.throws(() =>
      ownerDevelopmentInstallCommitMessage({ ...record, nonce: "not-a-nonce" })
    );
  },
);

Deno.test(
  "owner install issue79: a healthy generation 17 waits for the separately promoted generation 18",
  () => {
    const settlementHealthy = healthyProof(SETTLEMENT, 17, 301);
    const plan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT,
          generation: 17,
          healthyProof: settlementHealthy,
          executionProof: settlementHealthy,
        }),
      }),
      NOW,
    );
    // The 17 -> 18 movement belongs to the separate hosted promotion that
    // accepted the released revision. Planning the trigger revision from the
    // settlement pointer would be the two-generation jump the intended
    // snapshot builder always rejects, so the planner waits instead.
    assert.equal(plan.status, "waiting");
  },
);

Deno.test(
  "owner install issue79: a failed released generation 18 waits instead of installing the trigger",
  () => {
    const releasedHealthy = healthyProof(RELEASED, 18, 302);
    const failedReleased = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RELEASED,
          generation: 18,
          healthyProof: releasedHealthy,
          executionProof: failedProof(RELEASED, 18, 303),
        }),
      }),
      NOW,
    );
    // The retained generation 18 healthy proof cannot authorize forward
    // installation while the latest settlement of this exact pointer failed;
    // with no recorded prior authority the failure waits instead of inventing
    // a rollback target.
    assert.equal(failedReleased.status, "waiting");

    // A settled healthy generation 18 execution still authorizes exactly the
    // one-generation install of the trigger revision.
    const settledReleased = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RELEASED,
          generation: 18,
          healthyProof: releasedHealthy,
          executionProof: releasedHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(settledReleased.status, "install");
    if (settledReleased.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(settledReleased.move.nextRevision, TRIGGER);
    assert.equal(settledReleased.move.nextGeneration, 19);
    assert.equal(
      settledReleased.move.nextGeneration,
      settledReleased.move.priorGeneration + 1,
    );
    assert.equal(
      canonicalStringify(settledReleased.move.priorHealthyProof),
      canonicalStringify(releasedHealthy),
    );
  },
);

Deno.test(
  "owner install issue79: failed generations 25-33 roll back to their recorded healthy predecessor",
  () => {
    const rows = [
      {
        revision: APP_IDENTITY,
        generation: 25,
        priorRevision: DELIVERED_ROUND2,
        priorGeneration: 24,
      },
      {
        revision: MODEL_ROUTE,
        generation: 26,
        priorRevision: APP_IDENTITY,
        priorGeneration: 25,
      },
      {
        revision: RESERVE_MODEL,
        generation: 27,
        priorRevision: MODEL_ROUTE,
        priorGeneration: 26,
      },
      {
        revision: MULTI_TARGET,
        generation: 28,
        priorRevision: RESERVE_MODEL,
        priorGeneration: 27,
      },
      {
        revision: SCOPE_GATE,
        generation: 29,
        priorRevision: MULTI_TARGET,
        priorGeneration: 28,
      },
      {
        revision: CANDIDATE_AUTH,
        generation: 30,
        priorRevision: SCOPE_GATE,
        priorGeneration: 29,
      },
      {
        revision: PRESERVE_SCOPE,
        generation: 31,
        priorRevision: CANDIDATE_AUTH,
        priorGeneration: 30,
      },
      {
        revision: FOREIGN_AUTH,
        generation: 32,
        priorRevision: PRESERVE_SCOPE,
        priorGeneration: 31,
      },
      {
        revision: REASON_CODE,
        generation: 33,
        priorRevision: FOREIGN_AUTH,
        priorGeneration: 32,
      },
    ];
    for (const [index, row] of rows.entries()) {
      const runId = 300 + index * 5;
      const priorHealthy = healthyProof(
        row.priorRevision,
        row.priorGeneration,
        runId,
      );
      const state = releaseSnapshot({
        runtime: runtimeRecord({
          revision: row.revision,
          generation: row.generation,
          healthyProof: priorHealthy,
          executionProof: failedProof(
            row.revision,
            row.generation,
            runId + 1,
          ),
        }),
      });
      const before = canonicalStringify(state);
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.equal(
        plan.status,
        "rollback",
        `generation ${row.generation} must roll back`,
      );
      if (plan.status !== "rollback") throw new Error("expected rollback");
      assert.equal(plan.move.action, "rollback");
      assert.equal(plan.move.priorRevision, row.revision);
      assert.equal(plan.move.priorGeneration, row.generation);
      assert.equal(plan.move.nextRevision, row.priorRevision);
      assert.equal(plan.move.nextGeneration, row.generation + 1);
      assert.equal(plan.move.nextGeneration, plan.move.priorGeneration + 1);
      assert.equal(
        canonicalStringify(plan.move.priorHealthyProof),
        canonicalStringify(priorHealthy),
      );

      // The planned movement applies to an intended snapshot that changes
      // exactly the pointer, generation and timestamps.
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
      assert.equal(planned.hostedRuntimes.length, 1);
      assert.equal(nextRuntime.id, priorRuntime.id);
      assert.equal(nextRuntime.activeRevision, row.priorRevision);
      assert.equal(nextRuntime.generation, row.generation + 1);
      assert.equal(nextRuntime.createdAt, priorRuntime.createdAt);
      assert.equal(nextRuntime.nextOrdinaryAt, NOW);
      assert.equal(nextRuntime.updatedAt, NOW);
      assert.equal(
        canonicalStringify(nextRuntime.lastHealthyProof),
        canonicalStringify(priorRuntime.lastHealthyProof),
      );
      assert.equal(
        canonicalStringify(nextRuntime.lastExecutionProof),
        canonicalStringify(priorRuntime.lastExecutionProof),
      );
      // Neither boundary mutates its input snapshot.
      assert.equal(canonicalStringify(state), before);

      // A missing prior proof, or one bound to the wrong generation, never
      // authorizes the rollback.
      const missing = releaseSnapshot({
        runtime: runtimeRecord({
          revision: row.revision,
          generation: row.generation,
          executionProof: failedProof(
            row.revision,
            row.generation,
            runId + 2,
          ),
        }),
      });
      assert.equal(
        planOwnerDevelopmentInstall(missing, NOW).status,
        "waiting",
        `generation ${row.generation} missing prior proof`,
      );
      const wrong = releaseSnapshot({
        runtime: runtimeRecord({
          revision: row.revision,
          generation: row.generation,
          healthyProof: healthyProof(
            row.priorRevision,
            row.generation,
            runId + 3,
          ),
          executionProof: failedProof(
            row.revision,
            row.generation,
            runId + 4,
          ),
        }),
      });
      assert.equal(
        planOwnerDevelopmentInstall(wrong, NOW).status,
        "waiting",
        `generation ${row.generation} wrong prior proof`,
      );
    }
  },
);

Deno.test(
  "owner install issue79: the trusted consumer pipeline applies the failed generation 25 rollback to its recorded prior",
  async () => {
    const priorHealthy = healthyProof(DELIVERED_ROUND2, 24, 401);
    const state = releaseSnapshot({
      runtime: runtimeRecord({
        revision: APP_IDENTITY,
        generation: 25,
        healthyProof: priorHealthy,
        executionProof: failedProof(APP_IDENTITY, 25, 402),
      }),
      hostedReleases: [acceptedRelease()],
      cooldowns: [cooldown(NOW - 1)],
    });
    const before = canonicalStringify(state);
    // The trusted one-shot consumer runs exactly this public sequence before
    // it writes: plan, build the intended snapshot, serialize the two changed
    // blobs and compose the bounded commit record. No port is faked and no
    // live call is made.
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.equal(plan.status, "rollback");
    if (plan.status !== "rollback") throw new Error("expected rollback");
    assert.equal(plan.move.priorRevision, APP_IDENTITY);
    assert.equal(plan.move.priorGeneration, 25);
    assert.equal(plan.move.nextRevision, DELIVERED_ROUND2);
    assert.equal(plan.move.nextGeneration, 26);
    const planned = buildOwnerDevelopmentInstallSnapshot(
      state,
      STATE_HEAD,
      plan.move,
      NOW,
    );
    const files = await ownerDevelopmentInstallFiles(planned, STATE_HEAD);
    const message = ownerDevelopmentInstallCommitMessage({
      version: "v1",
      kind: "owner_development_install",
      authority: "owner",
      action: plan.move.action,
      authorizedAt: NOW,
      priorRevision: plan.move.priorRevision,
      priorGeneration: plan.move.priorGeneration,
      nextRevision: plan.move.nextRevision,
      nextGeneration: plan.move.nextGeneration,
      stateHead: STATE_HEAD,
      priorHealthyProof: plan.move.priorHealthyProof,
      nonce: "b".repeat(64),
    });

    // The applied snapshot moves only the pointer, generation and timestamps
    // and preserves every unrelated release and history record.
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
    const priorRuntime = state.hostedRuntimes[0];
    const nextRuntime = planned.hostedRuntimes[0];
    assert.equal(nextRuntime.activeRevision, DELIVERED_ROUND2);
    assert.equal(nextRuntime.generation, 26);
    assert.equal(
      canonicalStringify(nextRuntime.lastHealthyProof),
      canonicalStringify(priorHealthy),
    );
    assert.equal(
      canonicalStringify(nextRuntime.lastExecutionProof),
      canonicalStringify(priorRuntime.lastExecutionProof),
    );
    assert.equal(canonicalStringify(state), before);

    // The serialized blobs and the commit record carry that exact rollback.
    const manifest = JSON.parse(files.manifest.text);
    assert.equal(manifest.sequence, state.sequence + 1);
    assert.equal(manifest.stateHead, STATE_HEAD);
    const record = JSON.parse(files.record.text);
    assert.equal(record.activeRevision, DELIVERED_ROUND2);
    assert.equal(record.generation, 26);
    const lines = message.trim().split("\n");
    const committed = JSON.parse(lines[lines.length - 1]);
    assert.equal(committed.action, "rollback");
    assert.equal(committed.priorRevision, APP_IDENTITY);
    assert.equal(committed.priorGeneration, 25);
    assert.equal(committed.nextRevision, DELIVERED_ROUND2);
    assert.equal(committed.nextGeneration, 26);
    assert.equal(
      canonicalStringify(committed.priorHealthyProof),
      canonicalStringify(priorHealthy),
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
