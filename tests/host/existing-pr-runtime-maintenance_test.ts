import { DORMANT_HOSTED_SUPERVISOR_POLICY as dormant } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { readHostedMaintenanceCompatibility } from "../../ops/hosted-autonomy-runtime-compatibility.ts";
import { EXISTING_PR_TAKEOVER_ACTIVATED } from "../../src/github/existing-pr-takeover-policy.ts";
import { NOW } from "./owner-install-fixture-constants.ts";
import {
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import {
  nativeWriterFixture,
  retainedRepairHistory,
} from "./existing-pr-runtime-fixtures.ts";
const PRIOR = "549c7a69186b3d2070aa4e69c92ee846d183ce8f" as GitSha;
const NEXT = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
const HEAD = "a".repeat(40) as GitSha;
const OLD = "b".repeat(40) as GitSha;
const custody = {
  custodyActivated: true,
  revisions: [NEXT],
  ownerInstallMigrations: [{
    fromRevision: PRIOR,
    fromGeneration: 79,
    toRevision: NEXT,
    toGeneration: 80,
  }],
};
function fixture(compatible = false) {
  const native = nativeWriterFixture({
    runId: 700,
    runAttempt: 1,
    launcherSha: HEAD,
  }, "maintenance");
  const release = releaseSnapshot({
    runtime: runtimeRecord({
      revision: compatible ? NEXT : PRIOR,
      generation: compatible ? 80 : 79,
      healthyProof: healthyProof(PRIOR, 79, 501),
      executionProof: healthyProof(PRIOR, 79, 501),
    }),
  });
  const repair = retainedRepairHistory().original;
  const order: string[] = [];
  let head = HEAD;
  const state = {
    readRelease: () => {
      order.push("release");
      return Promise.resolve(
        portOk({
          status: "found" as const,
          ref: null,
          head,
          snapshot: structuredClone(release),
        }),
      );
    },
    readRepair: () => {
      order.push("repair");
      return Promise.resolve(
        portOk({
          status: "found" as const,
          ref: null,
          head: HEAD,
          snapshot: structuredClone(repair),
        }),
      );
    },
  };
  const input = {
    rollout: dormant.rollout,
    state,
    clock: { now: () => NOW },
    native: {
      token: "offline",
      run: native.run,
      deadline: NOW + 120_000,
      read: native.read,
    },
    readQueueReady: () => {
      order.push("queue");
      return Promise.resolve(true);
    },
  };
  return {
    native,
    release,
    repair,
    order,
    input,
    setHead: (value: GitSha) => {
      head = value;
    },
  };
}

Deno.test("existing PR maintenance: migration-only retains queue-first read ordering and cannot become ordinary readiness", async () => {
  const f = fixture();
  const before = structuredClone({ release: f.release, repair: f.repair });
  f.native.peers.push({ ...f.native.nativeRun, id: 701, status: "queued" });
  const result = await readHostedMaintenanceCompatibility(
    f.input,
    dormant.queue,
    custody,
  );
  assert.equal(result.status, "migration_only");
  assert.equal(f.order[0], "queue");
  assert.deepEqual({ release: f.release, repair: f.repair }, before);
  assert.ok(result.status === "migration_only");
  assert.ok(result.move !== null);
  assert.equal(result.move.priorRevision, PRIOR);
  assert.equal(result.move.nextRevision, NEXT);
  assert.equal(result.releaseHead, HEAD);
  assert.equal(
    EXISTING_PR_TAKEOVER_ACTIVATED,
    false,
    "admission does not control the independent custody floor",
  );
});

Deno.test("existing PR maintenance: incompatible execution, old queued source and state drift hold all ordinary work", async (t) => {
  for (
    const fault of [
      "execution",
      "old_queue",
      "state",
      "queue_unavailable",
      "no_migration",
    ]
  ) {
    await t.step(fault, async () => {
      const f = fixture();
      if (fault === "execution") {
        f.release.hostedRuntimes[0].execution =
          healthyProof(PRIOR, 79, 501).execution;
      }
      if (fault === "old_queue") {
        f.native.peers.push({
          ...f.native.nativeRun,
          id: 701,
          status: "queued",
          head_sha: OLD,
        });
      }
      if (fault === "state") {
        const read = f.input.native.read;
        f.input.native.read = async (path) => {
          const value = await read(path);
          f.setHead(OLD);
          return value;
        };
      }
      if (fault === "queue_unavailable") {
        f.input.readQueueReady = () => Promise.resolve(false);
      }
      const result = await readHostedMaintenanceCompatibility(
        f.input,
        dormant.queue,
        fault === "no_migration"
          ? { ...custody, ownerInstallMigrations: [] }
          : custody,
      );
      assert.equal(result.status, "hold");
    });
  }
});

Deno.test("existing PR maintenance: accepted installed runtime still intersects queue capability", async () => {
  const f = fixture(true);
  assert.equal(
    (await readHostedMaintenanceCompatibility(f.input, dormant.queue, custody))
      .status,
    "ordinary",
  );
  assert.equal(
    (await readHostedMaintenanceCompatibility(f.input, {
      proofActivated: true,
      revisions: [],
    }, custody)).status,
    "hold",
  );
});

Deno.test("existing PR maintenance: queue proof activation requires custody floor before any ordinary writer", async () => {
  const f = fixture(true);
  const result = await readHostedMaintenanceCompatibility(f.input, {
    proofActivated: true,
    revisions: [NEXT],
  }, { custodyActivated: false, revisions: [] });
  assert.equal(result.status, "hold");
  assert.deepEqual(f.order, []);
});
