import assert from "node:assert/strict";
import {
  type OwnerFutureRecoveryAuthority,
  readOwnerFutureRecoveryAuthority,
  readOwnerLegacyFirstRecoveryTarget,
} from "../../src/host/owner-install-future-recovery.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-install-plan.ts";
import { buildOwnerDevelopmentInstallSnapshot } from "../../src/host/owner-install-snapshot.ts";
import { runOwnerDevelopmentInstallMain } from "../../src/host/owner-install-run.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION as R80,
  OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION as R81,
} from "../../src/host/owner-install-runtime-pins.ts";
import { requestedRelease } from "./owner-install-fixture-proofs.ts";
import { nativeWriterFixture } from "./existing-pr-runtime-fixtures.ts";
import { readHostedMaintenanceCompatibility } from "../../ops/hosted-autonomy-runtime-compatibility.ts";
import { runHostedAutonomyMain } from "../../ops/hosted-autonomy-main.ts";
import { snapshotWire } from "../github/merge-queue-fixtures.ts";
import {
  FUTURE,
  futureRecoveryFixture,
  RECOVERY_NOW,
} from "./owner-install-future-recovery-fixtures.ts";

type Rig = Awaited<ReturnType<typeof futureRecoveryFixture>>;
type Input = Awaited<ReturnType<Rig["readerInput"]>>;

function planned(input: Input, authority: OwnerFutureRecoveryAuthority) {
  return planOwnerDevelopmentInstall(
    input.current.snapshot,
    RECOVERY_NOW,
    undefined,
    undefined,
    input.queue,
    input.custody,
    input.rollout,
    authority,
  );
}

function built(
  input: Input,
  authority: OwnerFutureRecoveryAuthority,
  move: Extract<ReturnType<typeof planned>, { status: "install" }>["move"],
) {
  return buildOwnerDevelopmentInstallSnapshot(
    input.current.snapshot,
    input.current.head,
    move,
    RECOVERY_NOW,
    undefined,
    undefined,
    input.queue,
    input.custody,
    authority,
    input.rollout,
  );
}

async function target(rig: Rig, input: Input) {
  const repair = await rig.repair.readRepair();
  assert.ok(repair.ok && repair.value.status === "found");
  return readOwnerLegacyFirstRecoveryTarget({
    snapshot: input.current.snapshot,
    repair: repair.value.snapshot,
    launcherSha: rig.run.launcherSha,
    now: RECOVERY_NOW,
    queue: input.queue,
    custody: input.custody,
    rollout: input.rollout,
  });
}

Deno.test("legacy first recovery actual maintenance: retained R81 health permits ordinary maintenance without owner migration", async () => {
  const rig = await futureRecoveryFixture({ legacyFirst: true });
  try {
    const before = await rig.current();
    const repairBefore = await rig.repair.readRepair();
    const runtime = before.snapshot.hostedRuntimes[0];
    assert.equal(runtime.activeRevision, R81);
    assert.equal(runtime.lastExecutionProof?.outcome, "failed");
    assert.equal(runtime.lastHealthyProof?.execution.revision, R81);
    assert.equal(
      runtime.lastHealthyProof?.execution.generation,
      runtime.generation,
    );
    assert.equal(rig.queue.revisions.includes(R81), false);
    assert.equal(rig.custody.revisions.includes(R81), false);
    const output = `${rig.source.root}/ordinary-maintenance-output`;
    const readiness: boolean[] = [];
    let writes = 0;
    const forbiddenWrite = () => {
      writes++;
      throw new Error("empty maintenance must preserve durable state");
    };
    const native = nativeWriterFixture(rig.run, "maintenance");
    // Readiness notifications are observations, not model/state/install effects.
    // The retired migration-only helper deliberately throws on all four alike.
    const code = await runHostedAutonomyMain({
      env: {
        GITHUB_REPOSITORY: "ubiquity-sentinel/sentinel",
        GITHUB_REF: "refs/heads/sentinel-supervisor",
        GITHUB_JOB: "maintenance",
        GITHUB_RUN_ID: String(rig.run.runId),
        GITHUB_RUN_ATTEMPT: String(rig.run.runAttempt),
        GITHUB_WORKFLOW_REF:
          "ubiquity-sentinel/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
        GITHUB_SHA: rig.run.launcherSha,
        GITHUB_WORKFLOW_SHA: rig.run.launcherSha,
        GITHUB_TOKEN: "offline-native-token",
        GITHUB_OUTPUT: output,
      },
      deps: {
        state: {
          readRepair: () => rig.repair.readRepair(),
          readRelease: () => rig.state.readRelease(),
          writeRepair: forbiddenWrite,
        },
        clock: { now: () => RECOVERY_NOW },
        githubFor: () => null,
        onQueueCustodyReady: (ready) => {
          readiness.push(ready);
        },
      },
      compatibility: {
        queue: rig.queue,
        custody: rig.custody,
        rollout: rig.rollout,
        nativeRead: native.read,
        http: (request) => {
          const path = new URL(request.url).pathname;
          assert.ok(path.includes("/rules/branches/") || path === "/graphql");
          if (path === "/graphql") {
            assert.ok(
              JSON.parse(request.body!).query.trimStart().startsWith("query"),
            );
          } else assert.equal(request.method, "GET");
          return Promise.resolve({
            status: 200,
            headers: new Headers(),
            bodyText: JSON.stringify(
              path === "/graphql" ? snapshotWire(null) : [],
            ),
          });
        },
      },
    });
    const outputs = Object.fromEntries(
      (await Deno.readTextFile(output)).trimEnd().split("\n").map((line) =>
        line.split("=", 2)
      ),
    );
    assert.equal(code, 0);
    assert.deepEqual(readiness, [false, true]);
    assert.equal(writes, 0);
    assert.deepEqual(outputs, {
      queueCustodyReady: "true",
      runtimeMigrationOnly: "false",
      runtimeMigrationRevision: "",
      runtimeMigrationGeneration: "",
    });
    assert.deepEqual(await rig.current(), before);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
    assert.equal(rig.patches(), 0);
  } finally {
    await rig.close();
  }
});

Deno.test("legacy first recovery actual owner: exact R81 failure reaches one App CAS", async () => {
  const rig = await futureRecoveryFixture({ legacyFirst: true });
  try {
    const input = await rig.readerInput();
    const authority = await readOwnerFutureRecoveryAuthority(input);
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
    const code = await runOwnerDevelopmentInstallMain({
      queueRuntimeCapability: rig.queue,
      existingPrRuntimeCapability: rig.custody,
      rollout: rig.rollout,
    });
    assert.deepEqual({
      authority: authority !== undefined,
      plan: plan.status,
      code,
      writer: rig.reports.at(-1)?.status,
      patches: rig.patches(),
    }, {
      authority: true,
      plan: "install",
      code: 0,
      writer: "installed",
      patches: 1,
    });
    const after = await rig.current();
    assert.equal(
      after.snapshot.hostedRuntimes[0].activeRevision,
      rig.successor,
    );
    assert.equal(after.snapshot.hostedRuntimes[0].generation, 82);
    assert.equal(after.snapshot.sequence, input.current.snapshot.sequence + 1);
    assert.deepEqual(
      after.snapshot.hostedRuntimes[0].lastHealthyProof,
      rig.healthy,
    );
    assert.deepEqual(
      after.snapshot.hostedRuntimes[0].lastExecutionProof,
      rig.failed,
    );
    assert.deepEqual(
      after.snapshot.hostedReleases,
      input.current.snapshot.hostedReleases,
    );
    assert.equal(
      after.snapshot.hostedRuntimes[0].execution?.id,
      `${rig.run.runId}:1:repair`,
    );
    assert.equal(
      after.snapshot.hostedRuntimes[0].execution?.purpose,
      "bootstrap",
    );
    assert.equal(after.snapshot.hostedRuntimes[0].execution?.releaseId, null);
    assert.equal(
      after.snapshot.hostedRuntimes[0].lastHealthyProof?.execution.generation,
      81,
    );
  } finally {
    await rig.close();
  }
});

Deno.test("legacy first recovery authority: both floors exact nonrollback rung and legacy exclusion are rechecked at every boundary", async (t) => {
  const rig = await futureRecoveryFixture({ legacyFirst: true });
  try {
    const input = await rig.readerInput();
    const authority = await readOwnerFutureRecoveryAuthority(input);
    assert.ok(authority);
    const plan = planned(input, authority);
    assert.ok(plan.status === "install");
    assert.equal(
      built(input, authority, plan.move).hostedRuntimes[0].generation,
      82,
    );
    assert.deepEqual(await target(rig, input), {
      revision: rig.successor,
      generation: 82,
    });
    const cases: [string, Input][] = [];
    for (const floor of ["queue", "custody"] as const) {
      cases.push(
        [`${floor} inactive`, {
          ...input,
          [floor]: {
            ...input[floor],
            ...(floor === "queue"
              ? { proofActivated: false }
              : { custodyActivated: false }),
          },
        }],
        [`${floor} missing grant`, {
          ...input,
          [floor]: { ...input[floor], ownerInstallMigrations: [] },
        }],
        [`${floor} mismatched grant`, {
          ...input,
          [floor]: {
            ...input[floor],
            ownerInstallMigrations: [{ ...rig.row, toRevision: FUTURE }],
          },
        }],
        [`${floor} removed destination`, {
          ...input,
          [floor]: { ...input[floor], revisions: [] },
        }],
      );
      for (const old of [R80, R81]) {
        cases.push([`${floor} admits ${old === R80 ? "R80" : "R81"}`, {
          ...input,
          [floor]: {
            ...input[floor],
            revisions: [...input[floor].revisions, old],
          },
        }]);
      }
    }
    for (const old of [R80, R81]) {
      cases.push([`both floors admit ${old === R80 ? "R80" : "R81"}`, {
        ...input,
        queue: { ...input.queue, revisions: [...input.queue.revisions, old] },
        custody: {
          ...input.custody,
          revisions: [...input.custody.revisions, old],
        },
      }]);
    }
    for (
      const installs of [
        [],
        input.rollout.installs.map((pin) => ({
          ...pin,
          rollbackToPrior: true,
        })),
      ]
    ) {
      cases.push([installs.length ? "rollback rung" : "missing rung", {
        ...input,
        rollout: { ...input.rollout, installs },
      }]);
    }
    cases.push(
      ["missing recovery row", {
        ...input,
        rollout: { ...input.rollout, recoveries: [] },
      }],
      ["changed row digest", {
        ...input,
        rollout: {
          ...input.rollout,
          recoveries: [{ ...rig.row, failedProofSha256: "0".repeat(64) }],
        },
      }],
      ["source policy mismatch", {
        ...input,
        queue: {
          ...input.queue,
          revisions: [...input.queue.revisions, FUTURE],
        },
      }],
    );
    for (
      const [name, runtime] of [
        ["active execution", {
          ...input.current.snapshot.hostedRuntimes[0],
          execution: rig.failed.execution,
        }],
        ["missing own health", {
          ...input.current.snapshot.hostedRuntimes[0],
          lastHealthyProof: null,
        }],
        ["latest proof healthy", {
          ...input.current.snapshot.hostedRuntimes[0],
          lastExecutionProof: rig.healthy,
        }],
      ] as const
    ) {
      cases.push([name, {
        ...input,
        current: {
          ...input.current,
          snapshot: { ...input.current.snapshot, hostedRuntimes: [runtime] },
        },
      }]);
    }
    cases.push(["nonterminal release", {
      ...input,
      current: {
        ...input.current,
        snapshot: {
          ...input.current.snapshot,
          hostedReleases: [requestedRelease()],
        },
      },
    }]);
    cases.push(["active cooldown", {
      ...input,
      current: {
        ...input.current,
        snapshot: {
          ...input.current.snapshot,
          githubCooldowns: [{
            installationId: 0,
            retryNotBefore: null,
            observedAt: RECOVERY_NOW,
            observationId: "a".repeat(64),
            secondaryBackoff: 0,
          }],
        },
      },
    }]);
    for (const [name, changed] of cases) {
      await t.step(name, async () => {
        assert.equal(
          await readOwnerFutureRecoveryAuthority(changed),
          undefined,
          "issuer",
        );
        assert.equal(planned(changed, authority).status, "waiting", "planner");
        assert.throws(() => built(changed, authority, plan.move), "snapshot");
        assert.equal(
          await target(rig, changed),
          undefined,
          "inert routing target",
        );
      });
    }
    for (const forged of [{}, { ...authority }]) {
      assert.equal(
        planned(input, forged as OwnerFutureRecoveryAuthority).status,
        "waiting",
      );
      assert.throws(() =>
        built(input, forged as OwnerFutureRecoveryAuthority, plan.move)
      );
    }
    assert.throws(() =>
      built(input, authority, { ...plan.move, nextGeneration: 83 })
    );
    assert.equal(rig.patches(), 0);
  } finally {
    await rig.close();
  }
});

Deno.test("legacy first recovery actual maintenance: native writer drain and changed state heads retain the hold", async (t) => {
  const rig = await futureRecoveryFixture({ legacyFirst: true });
  try {
    const before = await rig.current();
    for (
      const fault of ["native_writer", "release_head", "repair_head"] as const
    ) {
      await t.step(fault, async () => {
        const native = nativeWriterFixture(rig.run, "maintenance");
        if (fault === "native_writer") {
          native.peers.push({
            ...native.nativeRun,
            id: 9001,
            status: "queued",
            head_sha: FUTURE,
          });
        }
        let drained = false;
        const decision = await readHostedMaintenanceCompatibility(
          {
            state: {
              readRelease: async () => {
                const read = await rig.state.readRelease();
                return fault === "release_head" && drained && read.ok &&
                    read.value.status === "found"
                  ? { ...read, value: { ...read.value, head: FUTURE } }
                  : read;
              },
              readRepair: async () => {
                const read = await rig.state.readRepair();
                return fault === "repair_head" && drained && read.ok &&
                    read.value.status === "found"
                  ? { ...read, value: { ...read.value, head: FUTURE } }
                  : read;
              },
            },
            clock: { now: () => RECOVERY_NOW },
            rollout: rig.rollout,
            readQueueReady: () => Promise.resolve(true),
            native: {
              token: "offline-native-token-value",
              run: rig.run,
              deadline: RECOVERY_NOW + 120_000,
              read: (path) => {
                drained = true;
                return native.read(path);
              },
            },
          },
          rig.queue,
          rig.custody,
        );
        assert.equal(decision.status, "hold");
        assert.equal(rig.patches(), 0);
        assert.deepEqual(await rig.current(), before);
      });
    }
  } finally {
    await rig.close();
  }
});

Deno.test("legacy first recovery authority: R80 and wrong-generation R81 never enter strict future recovery", async (t) => {
  const rig = await futureRecoveryFixture({ legacyFirst: true });
  try {
    const input = await rig.readerInput();
    const authority = await readOwnerFutureRecoveryAuthority(input);
    assert.ok(authority);
    const plan = planned(input, authority);
    assert.ok(plan.status === "install");
    for (const [revision, generation] of [[R80, 81], [R81, 82]] as const) {
      await t.step(`${revision}/${generation}`, async () => {
        const migration = {
          fromRevision: revision,
          fromGeneration: generation,
          toRevision: rig.successor,
          toGeneration: generation + 1,
        };
        const row = { ...rig.row, ...migration };
        const changed: Input = {
          ...input,
          current: {
            ...input.current,
            snapshot: {
              ...input.current.snapshot,
              hostedRuntimes: [{
                ...input.current.snapshot.hostedRuntimes[0],
                activeRevision: revision,
                generation,
              }],
            },
          },
          queue: {
            ...input.queue,
            revisions: [R80, R81, rig.successor],
            ownerInstallMigrations: [migration],
          },
          custody: {
            ...input.custody,
            revisions: [R80, R81, rig.successor],
            ownerInstallMigrations: [migration],
          },
          rollout: {
            ...input.rollout,
            recoveries: [row],
            installs: [{ ...migration, rollbackToPrior: false }],
          },
        };
        const reads = rig.calls.length;
        assert.equal(
          await readOwnerFutureRecoveryAuthority(changed),
          undefined,
        );
        assert.equal(
          rig.calls.length,
          reads,
          "reserved legacy identities refuse before native/source CI reads",
        );
        assert.equal(planned(changed, authority).status, "waiting");
        assert.throws(() => built(changed, authority, plan.move));
        assert.equal(await target(rig, changed), undefined);
      });
    }
  } finally {
    await rig.close();
  }
});

Deno.test("legacy first recovery authority: invalid genuine proof chronology and purpose preserve the failed pointer", async (t) => {
  for (const fault of ["chronology", "purpose", "observation"] as const) {
    await t.step(fault, async () => {
      const rig = await futureRecoveryFixture({ legacyFirst: true, fault });
      try {
        const before = await rig.current();
        assert.equal(
          await readOwnerFutureRecoveryAuthority(await rig.readerInput()),
          undefined,
        );
        const routed = await rig.maintenance();
        assert.equal(routed.outputs.runtimeMigrationOnly, "false");
        await runOwnerDevelopmentInstallMain({
          queueRuntimeCapability: rig.queue,
          existingPrRuntimeCapability: rig.custody,
          rollout: rig.rollout,
        });
        assert.equal(rig.patches(), 0);
        assert.deepEqual(await rig.current(), before);
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("legacy first recovery actual CAS: changed committed capability input grants and nonrollback rung refuse publication", async (t) => {
  for (
    const fault of [
      "capability",
      "queue_grant",
      "custody_grant",
      "rung",
    ] as const
  ) {
    await t.step(fault, async () => {
      const rig = await futureRecoveryFixture({ legacyFirst: true });
      const fetch = globalThis.fetch;
      let changed = false;
      try {
        const before = await rig.current();
        globalThis.fetch = async (request, init) => {
          if (
            !changed && init?.method === "POST" &&
            new URL(String(request)).pathname.endsWith("/git/commits")
          ) {
            changed = true;
            if (fault === "queue_grant") rig.queue.ownerInstallMigrations = [];
            else if (fault === "custody_grant") {
              rig.custody.ownerInstallMigrations = [];
            } else if (fault === "rung") {
              await rig.source.write(
                rig.source.launcher,
                "src/host/hosted-runtime-rollout.json",
                JSON.stringify({ ...rig.rollout, installs: [] }),
              );
            } else {
              const path = "src/host/hosted-custody-capability.json";
              const text = await Deno.readTextFile(
                `${rig.source.launcher}/${path}`,
              );
              await rig.source.write(rig.source.launcher, path, text + "\n");
            }
          }
          return fetch(request, init);
        };
        await runOwnerDevelopmentInstallMain({
          queueRuntimeCapability: rig.queue,
          existingPrRuntimeCapability: rig.custody,
          rollout: rig.rollout,
        });
        assert.equal(changed, true);
        assert.equal(rig.patches(), 0);
        assert.deepEqual(await rig.current(), before);
      } finally {
        await rig.close();
      }
    });
  }
});
