import assert from "node:assert/strict";
import { HOSTED_RUNTIME_ROLLOUT } from "../../src/host/hosted-runtime-rollout.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION,
} from "../../src/host/owner-install-runtime-pins.ts";

import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  EXISTING_PR_RUNTIME_CAPABILITY_REFUSED,
  type ExistingPrRuntimeCapability,
} from "../../src/host/existing-pr-runtime-capability.ts";
import {
  commitHosted,
  planPointerRecovery,
} from "../../src/host/actions-supervisor-state.ts";
import { reservation } from "../state/helpers.ts";
import {
  CANDIDATE,
  DORMANT_HOSTED_POLICIES,
  LAUNCHER,
  makeRig,
  releaseRequest,
  requireRun,
  reviewReceipt,
  type RigV1,
  run,
  runProof,
} from "./actions-supervisor-fixture.ts";
import {
  advanceToCandidate,
  bootstrapHealthy,
  persistPromotingIntent,
} from "./actions-supervisor-lifecycle-fixture.ts";

import { allowsHostedRuntime } from "../../src/host/hosted-runtime-compatibility.ts";
const allowsQueueRuntime = (
  revision: GitSha,
  policy?: ExistingPrRuntimeCapability,
) =>
  allowsHostedRuntime(
    revision,
    DORMANT_HOSTED_POLICIES.queueRuntimeCapability,
    policy,
  );

// Trusted in-process configuration: no environment, state field or workflow input.
const activated = (revisions: readonly GitSha[] = [CANDIDATE]) => ({
  custodyActivated: true,
  revisions,
});

function input(rig: RigV1, id: number, policy = activated()) {
  return {
    ...DORMANT_HOSTED_POLICIES,
    clock: rig.clock,
    state: rig.release,
    run: run(id),
    evidence: rig.evidence,
    existingPrRuntimeCapability: policy,
  };
}

async function requestedPrior(rig: RigV1) {
  await bootstrapHealthy(rig);
  const request = releaseRequest();
  await rig.seedRepair([request], [reviewReceipt(request)]);
  rig.evidence.requests.add(request.id);
  return requireRun(await rig.prepare(run(2)));
}

Deno.test("existing PR runtime fence: committed LF accepts only its exact forward runtime", () => {
  const intents = HOSTED_RUNTIME_ROLLOUT.ownerSupersessions;
  assert.ok(
    intents.length > 0,
    "committed LF carries explicit owner authority",
  );
  assert.equal(EXISTING_PR_RUNTIME_CAPABILITY.custodyActivated, true);
  assert.deepEqual(
    EXISTING_PR_RUNTIME_CAPABILITY.revisions,
    [...new Set(intents.map((intent) => intent.toRevision))],
  );
  assert.deepEqual(
    EXISTING_PR_RUNTIME_CAPABILITY.ownerInstallMigrations,
    intents.map((
      { fromRevision, fromGeneration, toRevision, toGeneration },
    ) => ({
      fromRevision,
      fromGeneration,
      toRevision,
      toGeneration,
    })),
  );
  for (const intent of intents) {
    assert.equal(allowsQueueRuntime(intent.toRevision), true);
    assert.equal(allowsQueueRuntime(intent.fromRevision), false);
    assert.ok(intent.toGeneration > intent.fromGeneration);
  }
  assert.equal(
    allowsQueueRuntime(OWNER_DEVELOPMENT_INSTALL_GEN80_REVISION),
    false,
  );
  assert.equal(
    allowsQueueRuntime(OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION),
    false,
  );
});

Deno.test("existing PR runtime fence: explicit dormant fixture and accepted pins are exact", () => {
  const dormant = DORMANT_HOSTED_POLICIES.existingPrRuntimeCapability;
  assert.equal(dormant.custodyActivated, false);
  assert.deepEqual(dormant.revisions, []);
  assert.deepEqual(dormant.ownerInstallMigrations, []);
  assert.equal(allowsQueueRuntime(LAUNCHER, dormant), true);
  assert.equal(allowsQueueRuntime(CANDIDATE, activated()), true);
  for (
    const revision of [LAUNCHER, CANDIDATE.slice(0, 10), `${CANDIDATE}0`, "*"]
  ) {
    assert.equal(allowsQueueRuntime(revision as GitSha, activated()), false);
  }
  assert.equal(allowsQueueRuntime(LAUNCHER, activated([])), false);
  for (
    const bad of [
      null,
      {},
      { custodyActivated: "false", revisions: [LAUNCHER] },
      { custodyActivated: true, revisions: [LAUNCHER, "*"] },
    ]
  ) {
    assert.equal(
      allowsQueueRuntime(
        LAUNCHER,
        bad as unknown as ExistingPrRuntimeCapability,
      ),
      false,
    );
  }
});

Deno.test("existing PR runtime fence: first bootstrap refuses before any pointer write", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    const before = await rig.release.readRelease();
    assert.deepEqual(await runHostedSupervisorPrepare(input(rig, 1)), {
      status: "pending",
      detail: EXISTING_PR_RUNTIME_CAPABILITY_REFUSED,
    });
    assert.deepEqual(await rig.release.readRelease(), before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime fence: every saved execution purpose is rechecked on same-run replay", async (t) => {
  for (
    const purpose of [
      "bootstrap",
      "ordinary",
      "prior",
      "candidate",
      "rollback",
    ] as const
  ) {
    await t.step(purpose, async () => {
      const rig = await makeRig();
      try {
        let saved: HostedExecutionIntentV1;
        if (purpose === "bootstrap") {
          rig.evidence.revisions.add(LAUNCHER);
          saved = requireRun(await rig.prepare(run(1)));
        } else if (purpose === "ordinary") {
          await bootstrapHealthy(rig);
          saved = requireRun(await rig.prepare(run(2)));
        } else if (purpose === "prior") saved = await requestedPrior(rig);
        else {
          const { candidate } = await advanceToCandidate(rig);
          if (purpose === "candidate") saved = candidate;
          else {
            rig.evidence.settlements.set(
              candidate.id,
              runProof(candidate, "failed"),
            );
            saved = requireRun(await rig.prepare(run(4)));
          }
        }
        assert.equal(saved.purpose, purpose);
        const before = await rig.snapshot();
        const policy = activated(
          saved.revision === LAUNCHER ? [CANDIDATE] : [LAUNCHER],
        );
        assert.deepEqual(
          await runHostedSupervisorPrepare(input(rig, saved.runId, policy)),
          { status: "pending", detail: EXISTING_PR_RUNTIME_CAPABILITY_REFUSED },
        );
        assert.deepEqual(await rig.snapshot(), before);
        if (saved.releaseId !== null) {
          assert.equal(
            (await runHostedSupervisorPrepare(
              input(rig, saved.runId, activated([saved.revision])),
            )).status,
            "pending",
            "candidate and retained prior must both be accepted",
          );
          assert.deepEqual(await rig.snapshot(), before);
        }
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("existing PR runtime fence: unsafe candidate or retained prior cannot open a generic release", async (t) => {
  for (const pins of [[LAUNCHER], [CANDIDATE]]) {
    await t.step(pins[0], async () => {
      const rig = await makeRig();
      try {
        await bootstrapHealthy(rig);
        const request = releaseRequest();
        await rig.seedRepair([request], [reviewReceipt(request)]);
        rig.evidence.requests.add(request.id);
        const before = await rig.snapshot();
        assert.deepEqual(
          await runHostedSupervisorPrepare(input(rig, 2, activated(pins))),
          { status: "pending", detail: EXISTING_PR_RUNTIME_CAPABILITY_REFUSED },
        );
        assert.deepEqual(await rig.snapshot(), before);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("existing PR runtime fence: persisted promotion and rollback keep their old intent and pointer", async (t) => {
  for (const action of ["promote", "rollback"] as const) {
    await t.step(action, async () => {
      const rig = await makeRig();
      try {
        if (action === "promote") {
          const prior = await requestedPrior(rig);
          rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
          await persistPromotingIntent(rig, run(3));
        } else {
          const { candidate } = await advanceToCandidate(rig);
          rig.evidence.settlements.set(
            candidate.id,
            runProof(candidate, "failed"),
          );
          await rig.finalize(run(3));
          let writes = 0;
          await runHostedSupervisorPrepare({
            ...input(rig, 4, { custodyActivated: false, revisions: [] }),
            state: {
              readRelease: rig.release.readRelease.bind(rig.release),
              readRepair: rig.release.readRepair.bind(rig.release),
              writeRelease: (next, head) =>
                ++writes === 2
                  ? Promise.resolve(
                    portOk({ status: "conflict" as const, currentHead: null }),
                  )
                  : rig.release.writeRelease(next, head),
            },
          });
        }
        const before = await rig.snapshot();
        assert.equal(before.hostedReleases[0].pointerIntent?.action, action);
        const pins = {
          ...activated([CANDIDATE]),
          ownerInstallMigrations: [{
            fromRevision: LAUNCHER,
            fromGeneration: 1,
            toRevision: CANDIDATE,
            toGeneration: 2,
          }],
        };
        assert.equal(
          planPointerRecovery(
            before.hostedRuntimes[0],
            before.hostedReleases,
            rig.clock.now(),
            DORMANT_HOSTED_POLICIES.queueRuntimeCapability,
            pins,
          ),
          null,
        );
        assert.deepEqual(
          await runHostedSupervisorPrepare(input(rig, 5, pins)),
          { status: "pending", detail: EXISTING_PR_RUNTIME_CAPABILITY_REFUSED },
        );
        assert.deepEqual(await rig.snapshot(), before);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("existing PR runtime fence: old prior settles without promotion or any repair accounting change", async () => {
  const rig = await makeRig();
  try {
    const prior = await requestedPrior(rig);
    const repair = await rig.repair.readRepair();
    assert.ok(repair.ok && repair.value.status === "found");
    const charged = await rig.repair.writeRepair({
      ...repair.value.snapshot,
      stateHead: repair.value.head,
      sequence: repair.value.snapshot.sequence + 1,
      reservations: [reservation("queue-existing-charge")],
    }, repair.value.head);
    assert.ok(charged.ok && charged.value.status === "applied");
    const repairBefore = await rig.repair.readRepair();
    const proof = runProof(prior, "healthy");
    rig.evidence.settlements.set(prior.id, proof);
    assert.equal(
      (await runHostedSupervisorFinalize(input(rig, 2))).status,
      "idle",
    );
    const settled = await rig.snapshot();
    assert.equal(settled.hostedRuntimes[0].execution, null);
    assert.deepEqual(settled.hostedRuntimes[0].lastExecutionProof, proof);
    assert.equal(settled.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(settled.hostedReleases[0].phase, "requested");
    assert.equal(settled.hostedReleases[0].pointerIntent, null);
    assert.equal(
      (await runHostedSupervisorPrepare(input(rig, 3))).status,
      "pending",
    );
    assert.deepEqual(await rig.snapshot(), settled);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime fence: accepted exact lifecycle keeps promotion and retained rollback", async () => {
  const rig = await makeRig();
  const policy = activated([LAUNCHER, CANDIDATE]);
  try {
    rig.evidence.revisions.add(LAUNCHER);
    const boot = requireRun(
      await runHostedSupervisorPrepare(input(rig, 1, policy)),
    );
    assert.equal(boot.purpose, "bootstrap");
    rig.evidence.settlements.set(boot.id, runProof(boot, "healthy"));
    await runHostedSupervisorFinalize(input(rig, 1, policy));
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    const prior = requireRun(
      await runHostedSupervisorPrepare(input(rig, 2, policy)),
    );
    assert.equal(prior.purpose, "prior");
    rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
    const candidate = requireRun(
      await runHostedSupervisorPrepare(input(rig, 3, policy)),
    );
    assert.equal(candidate.purpose, "candidate");
    rig.evidence.settlements.set(candidate.id, runProof(candidate, "failed"));
    const rollback = requireRun(
      await runHostedSupervisorPrepare(input(rig, 4, policy)),
    );
    assert.equal(rollback.purpose, "rollback");
    assert.equal(rollback.revision, LAUNCHER);
    assert.equal(rollback.generation, 3);
    rig.evidence.settlements.set(rollback.id, runProof(rollback, "healthy"));
    await runHostedSupervisorFinalize(input(rig, 4, policy));
    const ordinary = requireRun(
      await runHostedSupervisorPrepare(input(rig, 5, policy)),
    );
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, LAUNCHER);
    assert.equal((await rig.snapshot()).hostedReleases[0].phase, "rolled_back");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime fence: final CAS rejects an unsafe synthesized pointer movement", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const read = await rig.release.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    const before = read.value.snapshot;
    const cursor = { snapshot: before, head: read.value.head };
    const result = await commitHosted(
      input(rig, 2, activated([LAUNCHER])),
      cursor,
      { ...before.hostedRuntimes[0], activeRevision: CANDIDATE, generation: 2 },
      before.hostedReleases,
    );
    assert.equal(result, "pending");
    assert.deepEqual(await rig.snapshot(), before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime fence: old healthy ordinary runtime is refused even with an empty queue", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const before = await rig.snapshot();
    const input = {
      ...DORMANT_HOSTED_POLICIES,
      clock: rig.clock,
      state: rig.release,
      run: run(2),
      evidence: rig.evidence,
      existingPrRuntimeCapability: activated(),
    };
    const decision = await runHostedSupervisorPrepare(input);
    assert.equal(decision.status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime fence: queue-off cannot resume an incompatible saved ordinary execution", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const execution = requireRun(await rig.prepare(run(2)));
    const before = await rig.snapshot();
    const input = {
      ...DORMANT_HOSTED_POLICIES,
      clock: rig.clock,
      state: rig.release,
      run: run(execution.runId),
      evidence: rig.evidence,
      existingPrRuntimeCapability: {
        custodyActivated: true,
        revisions: [CANDIDATE],
      },
    };
    assert.equal((await runHostedSupervisorPrepare(input)).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("existing PR runtime fence: queue remains an independent veto when takeover accepts", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const before = await rig.snapshot();
    const outcome = await runHostedSupervisorPrepare({
      ...input(rig, 2, activated([LAUNCHER])),
      queueRuntimeCapability: { proofActivated: true, revisions: [CANDIDATE] },
    });
    assert.equal(outcome.status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
  } finally {
    await rig.cleanup();
  }
});
