import assert from "node:assert/strict";
import { runOwnerDevelopmentInstallMain } from "../../src/host/owner-install-run.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-install-plan.ts";
import { buildOwnerDevelopmentInstallSnapshot } from "../../src/host/owner-install-snapshot.ts";
import {
  type OwnerFutureRecoveryAuthority,
  readOwnerFutureRecoveryAuthority,
} from "../../src/host/owner-install-future-recovery.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { FakeEvidence } from "./actions-supervisor-fixture.ts";
import { runHostedSupervisorWithPolicy } from "./hosted-supervisor-policy-fixture.ts";
import {
  FUTURE,
  futureNativeSettlement,
  futureRecoveryFixture,
  RECOVERY_NOW,
} from "./owner-install-future-recovery-fixtures.ts";

Deno.test("future recovery actual owner: failed-first pointer atomically starts its exact successor bootstrap", async () => {
  const rig = await futureRecoveryFixture();
  try {
    const before = await rig.current();
    assert.equal(
      before.snapshot.hostedRuntimes[0].lastHealthyProof?.execution.revision ===
        FUTURE,
      false,
    );
    assert.equal(
      await runOwnerDevelopmentInstallMain({
        queueRuntimeCapability: rig.queue,
        existingPrRuntimeCapability: rig.custody,
        rollout: rig.rollout,
      }),
      0,
    );
    assert.equal(
      rig.reports.at(-1)?.status,
      "installed",
      JSON.stringify(rig.reports),
    );
    assert.equal(rig.patches(), 1);
    const after = await rig.current();
    const runtime = after.snapshot.hostedRuntimes[0];
    assert.equal(runtime.activeRevision, rig.successor);
    assert.equal(runtime.generation, 83);
    assert.deepEqual(
      runtime.lastHealthyProof,
      before.snapshot.hostedRuntimes[0].lastHealthyProof,
    );
    assert.equal(runtime.execution?.purpose, "bootstrap");
    assert.equal(runtime.execution?.releaseId, null);
    assert.equal(runtime.execution?.runId, rig.run.runId);
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
    assert.equal(prepared.status, "run");
    assert.ok(prepared.status === "run");
    assert.deepEqual(prepared.execution, runtime.execution);
    assert.equal(evidence.matrixCalls.length, 0);
    const outputs = new Map<string, string>();
    await runHostedSupervisorWithPolicy({
      queue: rig.queue,
      custody: rig.custody,
      rollout: rig.rollout,
    }, {
      sourceDir: rig.source.launcher,
      clock: core.clock,
      state: rig.state,
      process: new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin"),
      http: () => {
        throw new Error(
          "saved own-run bootstrap must require no new source request",
        );
      },
      env: {
        GITHUB_REPOSITORY: "ubiquity/sentinel",
        GITHUB_REF: "refs/heads/sentinel-supervisor",
        GITHUB_JOB: "prepare",
        GITHUB_RUN_ID: String(rig.run.runId),
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: rig.run.launcherSha,
        GITHUB_WORKFLOW_SHA: rig.run.launcherSha,
        GITHUB_WORKFLOW_REF:
          "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
        GITHUB_TOKEN: "offline-native-token-value",
      },
      writeOutput: (key, value) => {
        outputs.set(key, value);
        return Promise.resolve();
      },
    });
    assert.equal(outputs.get("modelStartsEnabled"), "false");
    assert.equal(outputs.get("executionPurpose"), "bootstrap");
    assert.equal(outputs.get("revision"), rig.successor);
    evidence.settlements.set(
      prepared.execution.id,
      await futureNativeSettlement(prepared.execution, "healthy"),
    );
    await runHostedSupervisorFinalize({
      ...core,
      clock: { now: () => RECOVERY_NOW + 10_000 },
    });
    const healthy = (await rig.current()).snapshot.hostedRuntimes[0];
    assert.equal(healthy.execution, null);
    assert.equal(healthy.lastHealthyProof?.execution.revision, rig.successor);
    assert.equal(healthy.lastHealthyProof?.execution.generation, 83);
    rig.setNow(RECOVERY_NOW + 10_000);
    assert.equal(
      await runOwnerDevelopmentInstallMain({
        queueRuntimeCapability: rig.queue,
        existingPrRuntimeCapability: rig.custody,
        rollout: rig.rollout,
      }),
      0,
    );
    assert.equal(rig.patches(), 1, "a consumed row never repeats its write");
  } finally {
    await rig.close();
  }
});

Deno.test("future recovery authority: issued identity is immutable and rejects plain objects or copies", async () => {
  const rig = await futureRecoveryFixture();
  try {
    const input = await rig.readerInput();
    const authority = await readOwnerFutureRecoveryAuthority(input);
    assert.ok(authority, "full current native/source authority must issue");
    assert.equal(Object.isFrozen(authority), true);
    const plan = planOwnerDevelopmentInstall(
      input.current.snapshot,
      RECOVERY_NOW,
      undefined,
      undefined,
      rig.queue,
      rig.custody,
      rig.rollout,
      authority,
    );
    assert.equal(plan.status, "install");
    assert.ok(plan.status === "install");
    assert.equal(Object.isFrozen(plan.move.priorHealthyProof), true);
    assert.equal(Object.isFrozen(plan.move.priorHealthyProof.execution), true);
    for (const disabled of ["queue", "custody"]) {
      const guarded = planOwnerDevelopmentInstall(
        input.current.snapshot,
        RECOVERY_NOW,
        undefined,
        undefined,
        disabled === "queue"
          ? { ...rig.queue, proofActivated: false }
          : rig.queue,
        disabled === "custody"
          ? { ...rig.custody, custodyActivated: false }
          : rig.custody,
        rig.rollout,
        authority,
      );
      assert.equal(guarded.status, "waiting");
    }
    for (const forged of [{}, { ...authority }]) {
      assert.equal(
        planOwnerDevelopmentInstall(
          input.current.snapshot,
          RECOVERY_NOW,
          undefined,
          undefined,
          rig.queue,
          rig.custody,
          rig.rollout,
          forged as OwnerFutureRecoveryAuthority,
        ).status,
        "waiting",
      );
    }
    assert.throws(() =>
      buildOwnerDevelopmentInstallSnapshot(
        input.current.snapshot,
        "a".repeat(40) as typeof input.current.head,
        plan.move,
        RECOVERY_NOW,
        undefined,
        undefined,
        rig.queue,
        rig.custody,
        authority,
        rig.rollout,
      )
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        input.current.snapshot,
        RECOVERY_NOW,
        undefined,
        undefined,
        rig.queue,
        rig.custody,
        rig.rollout,
      ).status,
      "waiting",
    );
    assert.equal(rig.patches(), 0);
  } finally {
    await rig.close();
  }
});

Deno.test("future recovery actual owner: retained own health and failed restored generation require the explicit row", async (t) => {
  for (const options of [{ ownHealth: true }, { restored: true }]) {
    await t.step(JSON.stringify(options), async () => {
      const rig = await futureRecoveryFixture(options);
      try {
        const before = await rig.current();
        const ordinary = planOwnerDevelopmentInstall(
          before.snapshot,
          RECOVERY_NOW,
          undefined,
          undefined,
          rig.queue,
          rig.custody,
          rig.rollout,
        );
        assert.notEqual(
          ordinary.status,
          "install",
          "preplanned outgoing A is never failure recovery",
        );
        await runOwnerDevelopmentInstallMain({
          queueRuntimeCapability: rig.queue,
          existingPrRuntimeCapability: rig.custody,
          rollout: rig.rollout,
        });
        assert.equal(
          rig.reports.at(-1)?.status,
          "installed",
          JSON.stringify(rig.reports),
        );
        const after = (await rig.current()).snapshot.hostedRuntimes[0];
        assert.equal(after.activeRevision, rig.successor);
        assert.equal(
          after.generation,
          before.snapshot.hostedRuntimes[0].generation + 1,
        );
        assert.equal(after.execution?.purpose, "bootstrap");
        assert.deepEqual(
          after.lastHealthyProof,
          before.snapshot.hostedRuntimes[0].lastHealthyProof,
        );
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("future recovery actual owner: native source CI ancestry witness writer and rate-limit faults write nothing", async (t) => {
  for (
    const fault of [
      "source_ci",
      "target_ci",
      "ancestry",
      "profile",
      "witness",
      "proof",
      "log",
      "actor_source",
      "active_writer",
      "rate_limit",
      "cooldown",
      "chronology",
      "purpose",
      "observation",
    ] as const
  ) {
    await t.step(fault, async () => {
      const rig = await futureRecoveryFixture({ fault });
      try {
        const before = await rig.current();
        await runOwnerDevelopmentInstallMain({
          queueRuntimeCapability: rig.queue,
          existingPrRuntimeCapability: rig.custody,
          rollout: rig.rollout,
        });
        assert.notEqual(rig.reports.at(-1)?.status, "installed");
        assert.equal(rig.patches(), 0);
        assert.deepEqual(await rig.current(), before);
        if (fault === "rate_limit") {
          assert.equal(
            rig.calls.filter((path) => path.includes("/actions/runs/501/"))
              .length,
            0,
          );
        }
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("future recovery authority: both active floors exact tuples and proof digests are mandatory", async () => {
  const rig = await futureRecoveryFixture();
  try {
    const input = await rig.readerInput();
    for (
      const changed of [
        { ...input, queue: { ...rig.queue, proofActivated: false } },
        { ...input, custody: { ...rig.custody, custodyActivated: false } },
        { ...input, queue: { ...rig.queue, revisions: [rig.successor] } },
        { ...input, custody: { ...rig.custody, revisions: [FUTURE] } },
        {
          ...input,
          rollout: {
            ...rig.rollout,
            recoveries: [{ ...rig.row, failedProofSha256: "0".repeat(64) }],
          },
        },
        {
          ...input,
          rollout: {
            ...rig.rollout,
            recoveries: [{
              ...rig.row,
              retainedHealthyProofSha256: "0".repeat(64),
            }],
          },
        },
        {
          ...input,
          current: {
            ...input.current,
            snapshot: {
              ...input.current.snapshot,
              hostedRuntimes: [{
                ...input.current.snapshot.hostedRuntimes[0],
                lastHealthyProof: null,
              }],
            },
          },
        },
        {
          ...input,
          current: {
            ...input.current,
            snapshot: {
              ...input.current.snapshot,
              hostedRuntimes: [{
                ...input.current.snapshot.hostedRuntimes[0],
                generation: 83,
              }],
            },
          },
        },
      ]
    ) assert.equal(await readOwnerFutureRecoveryAuthority(changed), undefined);
    assert.equal(rig.patches(), 0);
  } finally {
    await rig.close();
  }
});

Deno.test("future recovery actual CAS: row or repair custody changes before publication retain the failed pointer", async (t) => {
  for (const fault of ["row", "repair", "writer"] as const) {
    await t.step(fault, async () => {
      const rig = await futureRecoveryFixture();
      const previous = globalThis.fetch;
      let changed = false;
      try {
        const before = await rig.current();
        globalThis.fetch = async (request, init) => {
          const url = new URL(String(request));
          if (
            !changed && init?.method === "POST" &&
            url.pathname.endsWith("/git/commits")
          ) {
            changed = true;
            if (fault === "row") {
              await rig.source.write(
                rig.source.launcher,
                "src/host/hosted-runtime-rollout.json",
                JSON.stringify({ ...rig.rollout, recoveries: [] }),
              );
            } else if (fault === "repair") {
              const read = await rig.repair.readRepair();
              assert.ok(read.ok && read.value.status === "found");
              const write = await rig.repair.writeRepair({
                ...read.value.snapshot,
                stateHead: read.value.head,
                sequence: read.value.snapshot.sequence + 1,
                updatedAt: RECOVERY_NOW,
              }, read.value.head);
              assert.ok(write.ok && write.value.status === "applied");
            }
          }
          if (
            changed && fault === "writer" &&
            url.pathname.includes("/actions/runs/9000/") &&
            url.pathname.endsWith("/jobs")
          ) {
            const reply = await previous(request, init);
            const body = await reply.json();
            body.jobs.push({ ...body.jobs[0], id: 90002, name: "repair" });
            body.total_count = body.jobs.length;
            return new Response(JSON.stringify(body));
          }
          return previous(request, init);
        };
        await runOwnerDevelopmentInstallMain({
          queueRuntimeCapability: rig.queue,
          existingPrRuntimeCapability: rig.custody,
          rollout: rig.rollout,
        });
        assert.equal(changed, true);
        assert.equal(rig.patches(), 0);
        assert.deepEqual(await rig.current(), before);
        assert.notEqual(rig.reports.at(-1)?.status, "installed");
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("future recovery actual CAS: moved release head cannot be overwritten", async () => {
  const rig = await futureRecoveryFixture({ releaseCas: true });
  try {
    await runOwnerDevelopmentInstallMain({
      queueRuntimeCapability: rig.queue,
      existingPrRuntimeCapability: rig.custody,
      rollout: rig.rollout,
    });
    assert.notEqual(rig.reports.at(-1)?.status, "installed");
    assert.equal(rig.patches(), 0);
  } finally {
    await rig.close();
  }
});

Deno.test("future recovery authority: active migration exceptions cannot replace exact runtime membership", async (t) => {
  const rig = await futureRecoveryFixture();
  try {
    const input = await rig.readerInput();
    const authority = await readOwnerFutureRecoveryAuthority(input);
    assert.ok(authority);
    const plan = planOwnerDevelopmentInstall(
      input.current.snapshot,
      RECOVERY_NOW,
      undefined,
      undefined,
      rig.queue,
      rig.custody,
      rig.rollout,
      authority,
    );
    assert.ok(plan.status === "install");
    const migration = {
      fromRevision: FUTURE,
      fromGeneration: 82,
      toRevision: rig.successor,
      toGeneration: 83,
    };
    const accepted = buildOwnerDevelopmentInstallSnapshot(
      input.current.snapshot,
      input.current.head,
      plan.move,
      RECOVERY_NOW,
      undefined,
      undefined,
      rig.queue,
      rig.custody,
      authority,
      rig.rollout,
    );
    assert.equal(accepted.hostedRuntimes[0].execution?.purpose, "bootstrap");
    for (const floor of ["queue", "custody"]) {
      const queue = floor === "queue"
        ? {
          ...rig.queue,
          revisions: [rig.successor],
          ownerInstallMigrations: [migration],
        }
        : rig.queue;
      const custody = floor === "custody"
        ? {
          ...rig.custody,
          revisions: [rig.successor],
          ownerInstallMigrations: [migration],
        }
        : rig.custody;
      await t.step(`${floor} planner`, () => {
        assert.equal(
          planOwnerDevelopmentInstall(
            input.current.snapshot,
            RECOVERY_NOW,
            undefined,
            undefined,
            queue,
            custody,
            rig.rollout,
            authority,
          ).status,
          "waiting",
        );
      });
      await t.step(`${floor} snapshot`, () => {
        assert.throws(() =>
          buildOwnerDevelopmentInstallSnapshot(
            input.current.snapshot,
            input.current.head,
            plan.move,
            RECOVERY_NOW,
            undefined,
            undefined,
            queue,
            custody,
            authority,
            rig.rollout,
          )
        );
      });
    }
    assert.equal(rig.patches(), 0);
  } finally {
    await rig.close();
  }
});

Deno.test("future recovery authority: source CI429 stops candidate and native proof reads", async () => {
  const rig = await futureRecoveryFixture({ fault: "source_ci_rate_limit" });
  try {
    const before = await rig.current();
    assert.equal(
      await readOwnerFutureRecoveryAuthority(await rig.readerInput()),
      undefined,
    );
    assert.equal(
      rig.calls.filter((path) => path.includes("/compare/")).length,
      0,
    );
    assert.equal(
      rig.calls.filter((path) =>
        path.includes(`/commits/${rig.successor}/check-runs`)
      ).length,
      0,
    );
    assert.equal(
      rig.calls.filter((path) => path.includes("/actions/runs/")).length,
      0,
    );
    assert.equal(rig.patches(), 0);
    assert.deepEqual(await rig.current(), before);
  } finally {
    await rig.close();
  }
});
