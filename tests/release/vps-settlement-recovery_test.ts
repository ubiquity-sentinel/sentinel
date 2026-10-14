import assert from "node:assert/strict";
import { asGitSha } from "../../src/contracts/brands.ts";
import { portOk, type StateReadView } from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { parseVpsReleaseRecordV1 } from "../../src/contracts/vps-release.ts";
import {
  parseVpsReceipt,
  vpsDigest,
  type VpsSettlement,
} from "../../src/contracts/vps-release-wire.ts";
import { verifyCommittedSettlement } from "../../src/host/vps-release.ts";
import {
  vpsMutation,
  VpsReleaseController,
} from "../../src/release/vps-controller.ts";
import { composeVpsReleasePort } from "../../src/release/vps-port.ts";
import { makeGitCtx, storeAt } from "./helpers.ts";

const fixture = parseVpsReleaseRecordV1(JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/vps/release-requested-v1.json", import.meta.url),
  ),
));

async function failedState() {
  const context = await makeGitCtx("vps-settlement-recovery");
  const state = storeAt(context, "vps-settlement-recovery", "release");
  const now = fixture.createdAt + 1000;
  const initial = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: fixture.createdAt,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
    vpsReleases: [fixture],
  });
  const first = await state.writeRelease(initial, null);
  assert.ok(first.ok && first.value.status === "applied");
  const record = parseVpsReleaseRecordV1({
    ...fixture,
    phase: "failed",
    intent: { action: "fail", persistedAt: now },
    error: "acceptance_insufficient",
    updatedAt: now,
  });
  const snapshot = parseReleaseStateSnapshotV1({
    ...initial,
    stateHead: first.value.head,
    sequence: 2,
    updatedAt: now,
    vpsReleases: [record],
  });
  const committed = await state.writeRelease(snapshot, first.value.head);
  assert.ok(committed.ok && committed.value.status === "applied");
  const input: VpsSettlement = {
    ...await vpsMutation(record.driver),
    stateRevision: committed.value.head,
    disposition: "failed",
    digest: await vpsDigest(record),
  };
  const terminal = parseVpsReceipt({
    ...record.driver,
    phase: "failed",
    sequence: 2,
    updatedAt: now,
    settlement: {
      stateRevision: input.stateRevision,
      disposition: input.disposition,
      digest: input.digest,
    },
    error: "acceptance_insufficient",
  });
  return { context, state, snapshot, record, input, terminal, now };
}

Deno.test("VPS settlement: exact prepared failure and original ancestor commit authorize unchanged terminal cleanup", async () => {
  const rig = await failedState();
  try {
    assert.equal(
      await verifyCommittedSettlement(
        rig.state,
        rig.record.driver,
        rig.input,
        rig.now,
      ),
      true,
    );
    const retry = { ...rig.input, ...await vpsMutation(rig.terminal) };
    assert.equal(
      await verifyCommittedSettlement(rig.state, rig.terminal, retry, rig.now),
      true,
    );
    const moved = await rig.state.writeRelease({
      ...rig.snapshot,
      stateHead: asGitSha(rig.input.stateRevision),
      sequence: 3,
      updatedAt: rig.now + 1000,
    }, asGitSha(rig.input.stateRevision));
    assert.ok(moved.ok && moved.value.status === "applied");
    assert.notEqual(moved.value.head, retry.stateRevision);
    assert.equal(
      await verifyCommittedSettlement(
        rig.state,
        rig.terminal,
        retry,
        rig.now + 1000,
      ),
      true,
    );
    assert.equal(retry.stateRevision, rig.input.stateRevision);
    assert.equal(retry.digest, rig.input.digest);
    assert.equal(
      await verifyCommittedSettlement(
        rig.state,
        rig.record.driver,
        rig.input,
        rig.now + 1000,
      ),
      false,
      "initial settlement cannot use historical state",
    );
    for (
      const patch of [{ sequence: 3 }, { settlement: null }, {
        error: "different_failure",
      }, { phase: "rollback_pending" }]
    ) {
      assert.throws(
        () => parseVpsReceipt({ ...rig.terminal, ...patch }),
        /contract is invalid/,
      );
    }
  } finally {
    await rig.context.cleanup();
  }
});

Deno.test("VPS settlement: changed tuple, native identity, missing history and moving fixed head retain cleanup refusal", async () => {
  const rig = await failedState();
  try {
    const moved = await rig.state.writeRelease({
      ...rig.snapshot,
      stateHead: asGitSha(rig.input.stateRevision),
      sequence: 3,
      updatedAt: rig.now + 1000,
    }, asGitSha(rig.input.stateRevision));
    assert.ok(moved.ok && moved.value.status === "applied");
    const retry = { ...rig.input, ...await vpsMutation(rig.terminal) };
    assert.equal(
      await verifyCommittedSettlement(rig.state, rig.terminal, {
        ...retry,
        stateRevision: moved.value.head,
      }, rig.now + 1000),
      false,
    );
    assert.equal(
      await verifyCommittedSettlement(rig.state, rig.terminal, {
        ...retry,
        digest: "f".repeat(64),
      }, rig.now + 1000),
      false,
    );
    assert.equal(
      await verifyCommittedSettlement(
        rig.state,
        {
          ...rig.terminal,
          candidate: {
            ...rig.terminal.candidate,
            immutableTreeSha256: "f".repeat(64),
          },
        },
        retry,
        rig.now + 1000,
      ),
      false,
    );
    assert.equal(
      await verifyCommittedSettlement(
        rig.state,
        { ...rig.terminal, updatedAt: rig.now + 1001 },
        retry,
        rig.now + 1000,
      ),
      false,
    );
    const withoutHistory: StateReadView = {
      readRepair: () => rig.state.readRepair(),
      readRelease: () => rig.state.readRelease(),
    };
    assert.equal(
      await verifyCommittedSettlement(
        withoutHistory,
        rig.terminal,
        retry,
        rig.now + 1000,
      ),
      false,
    );
    let reads = 0;
    const movedDuringRead: StateReadView = {
      ...withoutHistory,
      readReleaseAt: (input) => rig.state.readReleaseAt(input),
      readRelease: async () => {
        const read = await rig.state.readRelease();
        if (++reads === 2 && read.ok && read.value.status === "found") {
          return portOk({ ...read.value, head: asGitSha("f".repeat(40)) });
        }
        return read;
      },
    };
    assert.equal(
      await verifyCommittedSettlement(
        movedDuringRead,
        rig.terminal,
        retry,
        rig.now + 1000,
      ),
      false,
    );
  } finally {
    await rig.context.cleanup();
  }
});

Deno.test("VPS controller: already persisted terminal retries original settlement and proceeds after cleanup", async () => {
  const rig = await failedState();
  try {
    const moved = await rig.state.writeRelease({
      ...rig.snapshot,
      stateHead: asGitSha(rig.input.stateRevision),
      sequence: 3,
      updatedAt: rig.now + 1000,
    }, asGitSha(rig.input.stateRevision));
    assert.ok(moved.ok && moved.value.status === "applied");
    let cleanupAllowed = false;
    const inputs: VpsSettlement[] = [];
    const port = composeVpsReleasePort({
      driver: {
        inspectPrior: () => Promise.resolve(rig.terminal.prior),
        prepare: () => Promise.reject(new Error("no new request")),
        activate: () => Promise.reject(new Error("no activation")),
        restore: () => Promise.reject(new Error("no restoration")),
        sampleHealth: () => Promise.reject(new Error("no health effect")),
        observe: () => Promise.resolve(rig.terminal),
        settle: async (input) => {
          inputs.push(input);
          assert.equal(
            await verifyCommittedSettlement(
              rig.state,
              rig.terminal,
              input,
              rig.now + 1000,
            ),
            true,
          );
          if (!cleanupAllowed) throw new Error("pin cleanup unavailable");
          return rig.terminal;
        },
      },
      metrics: { sample: () => Promise.reject(new Error("no metrics effect")) },
      readInferenceProof: () =>
        Promise.reject(new Error("no inference effect")),
    });
    const controller = new VpsReleaseController({
      stateRead: rig.state,
      stateWrite: rig.state,
      repository: fixture.request.target.repository,
      environment: fixture.request.target.environment,
      controllerSha: asGitSha(fixture.driver.controllerSha),
      driverSha256: fixture.driver.driverSha256,
      policy: fixture.policy,
      logsLagMs: 0,
      port,
      clock: { now: () => rig.now + 1000 },
    });
    const unavailable = await controller.run();
    assert.ok(unavailable.ok && unavailable.value.status === "waiting");
    cleanupAllowed = true;
    const resumed = await controller.run();
    assert.ok(resumed.ok && resumed.value.status === "idle");
    assert.equal(inputs.length, 2);
    for (const input of inputs) {
      assert.equal(input.stateRevision, rig.input.stateRevision);
      assert.equal(input.digest, rig.input.digest);
      assert.equal(input.expectedDigest, await vpsDigest(rig.terminal));
      assert.equal(input.expectedSequence, rig.terminal.sequence);
    }
    const current = await rig.state.readRelease();
    assert.ok(current.ok && current.value.status === "found");
    assert.equal(
      current.value.head,
      moved.value.head,
      "cleanup never rewrites terminal state",
    );
  } finally {
    await rig.context.cleanup();
  }
});
