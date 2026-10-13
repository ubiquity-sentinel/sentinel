import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseVpsReleaseRecordV1,
  type VpsReleaseRecordV1,
} from "../../src/contracts/vps-release.ts";
import {
  isHealthyVps,
  parseVpsReceipt,
  vpsDigest,
  type VpsHealthProof,
  type VpsIdentity,
  type VpsMutation,
  type VpsOperation,
  type VpsPrepare,
  type VpsSettlement,
} from "../../src/contracts/vps-release-wire.ts";
import { VpsReleaseController } from "../../src/release/vps-controller.ts";
import {
  composeVpsReleasePort,
  type NativeVpsDriverV1,
} from "../../src/release/vps-port.ts";
import { makeGitCtx, publishRepairRequest, storeAt } from "./helpers.ts";

const fixture = parseVpsReleaseRecordV1(
  JSON.parse(
    await Deno.readTextFile(
      new URL("../fixtures/vps/release-requested-v1.json", import.meta.url),
    ),
  ),
);
class FakeNativeVpsDriver implements NativeVpsDriverV1 {
  receipt = structuredClone(fixture.driver);
  activations = 0;
  restorations = 0;
  constructor(private readonly now: () => number) {}
  inspectPrior() {
    return Promise.resolve(this.receipt.prior);
  }
  prepare(input: VpsPrepare) {
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      binding: input.binding,
      controllerSha: input.controllerSha,
    });
    return Promise.resolve(this.receipt);
  }
  sampleHealth(
    identity: VpsIdentity,
    surface: "loopback" | "public",
  ): Promise<VpsHealthProof> {
    return Promise.resolve({
      identity,
      surface,
      observedAt: this.now(),
      httpStatus: 200,
      bodyMatches: true,
      headersMatch: true,
      originMatches: true,
    });
  }
  observe(input: VpsOperation) {
    assert.equal(input.requestDigest, this.receipt.binding.requestDigest);
    return Promise.resolve(this.receipt);
  }
  async activate(input: VpsMutation) {
    assert.equal(input.expectedSequence, this.receipt.sequence);
    assert.equal(input.expectedDigest, await vpsDigest(this.receipt));
    this.activations++;
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      phase: "ingress_applied",
      sequence: this.receipt.sequence + 1,
      updatedAt: this.now(),
      intent: { action: "promote", persistedAt: this.now() },
      loopback: await this.sampleHealth(this.receipt.candidate, "loopback"),
      public: await this.sampleHealth(this.receipt.candidate, "public"),
    });
    return this.receipt;
  }
  async restore(input: VpsMutation) {
    assert.equal(input.expectedDigest, await vpsDigest(this.receipt));
    this.restorations++;
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      phase: "rolled_back",
      sequence: this.receipt.sequence + 1,
      updatedAt: this.now(),
      intent: { action: "rollback", persistedAt: this.now() },
      restoration: {
        loopback: await this.sampleHealth(
          this.receipt.prior.identity,
          "loopback",
        ),
        public: await this.sampleHealth(this.receipt.prior.identity, "public"),
      },
    });
    return this.receipt;
  }
  settle(input: VpsSettlement) {
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      phase: input.disposition,
      sequence: this.receipt.sequence + 1,
      updatedAt: this.now(),
      settlement: {
        stateRevision: input.stateRevision,
        disposition: input.disposition,
        digest: input.digest,
      },
      error: input.disposition === "failed" ? "acceptance_insufficient" : null,
    });
    return Promise.resolve(this.receipt);
  }
}

async function scenario(failures = 0) {
  const context = await makeGitCtx("vps-controller");
  const state = storeAt(context, "vps-controller", "release");
  await publishRepairRequest(context, fixture.request);
  let now = fixture.createdAt;
  const driver = new FakeNativeVpsDriver(() => now);
  const port = composeVpsReleasePort({
    driver,
    metrics: {
      sample: (input) =>
        Promise.resolve({
          ...input,
          sampledAt: now,
          requestCount: 100,
          fiveXxCount: input.identity.gitSha === fixture.request.revision
            ? failures
            : 0,
          timeoutCount: 0,
          streamFailureCount: 0,
          upstreamWideFault: false,
          coverage: "complete",
          coverageDigest: "e".repeat(64),
        }),
    },
    readInferenceProof: (identity) =>
      Promise.resolve({
        revision: identity.gitSha,
        observedAt: now,
        origin: "mac-direct-vps",
        authenticated: true,
        succeeded: true,
        proofDigest: "f".repeat(64),
      }),
  });
  const options = {
    stateRead: state,
    stateWrite: state,
    repository: fixture.request.target.repository,
    environment: fixture.request.target.environment,
    controllerSha: fixture.driver.controllerSha as GitSha,
    driverSha256: fixture.driver.driverSha256,
    policy: fixture.policy,
    logsLagMs: 0,
    port,
    clock: { now: () => now },
  };
  const controller = new VpsReleaseController(options);
  const record = async (): Promise<VpsReleaseRecordV1> => {
    const read = await state.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    const value = read.value.snapshot.vpsReleases?.[0];
    assert.ok(value);
    return value;
  };
  return {
    context,
    state,
    driver,
    options,
    controller,
    record,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
Deno.test("VPS controller: real Git intent, continuous telemetry, authenticated proof and exact accepted readback", async () => {
  const rig = await scenario();
  try {
    assert.equal((await rig.controller.run()).ok, true);
    assert.equal((await rig.record()).phase, "requested");
    await rig.controller.run();
    assert.equal((await rig.record()).phase, "promoting");
    assert.equal(rig.driver.activations, 0);
    await rig.controller.run();
    assert.equal((await rig.record()).phase, "monitoring");
    for (let slot = 0; slot < 64; slot++) {
      rig.advance(30_000);
      await rig.controller.run();
      if ((await rig.record()).phase === "accepted") break;
    }
    const accepted = await rig.record();
    assert.equal(accepted.phase, "accepted");
    assert.equal(accepted.monitoring.samples.length, 60);
    assert.equal(accepted.monitoring.continuous, true);
    assert.equal(accepted.inference?.origin, "mac-direct-vps");
    assert.equal(rig.driver.activations, 1);
    assert.ok(isHealthyVps(accepted.driver.public!));
    const read = await rig.state.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(
      read.value.snapshot.releases.length,
      0,
      "VPS never manufactures a Deno record",
    );
  } finally {
    await rig.context.cleanup();
  }
});
Deno.test("VPS controller: objective failure persists rollback intent and restores only recorded prior", async () => {
  const rig = await scenario(10);
  try {
    await rig.controller.run();
    await rig.controller.run();
    await rig.controller.run();
    for (let slot = 0; slot < 64; slot++) {
      rig.advance(30_000);
      await rig.controller.run();
      if ((await rig.record()).phase === "rolled_back") break;
    }
    const restored = await rig.record();
    assert.equal(restored.phase, "rolled_back");
    assert.equal(restored.acceptance?.objectiveFailure, true);
    assert.equal(
      restored.driver.restoration?.public.identity.gitSha,
      fixture.driver.prior.identity.gitSha,
    );
    assert.equal(rig.driver.restorations, 1);
  } finally {
    await rig.context.cleanup();
  }
});
Deno.test("VPS controller: unobserved gap resets coverage and CAS refusal prevents activation", async () => {
  const rig = await scenario();
  try {
    await rig.controller.run();
    await rig.controller.run();
    await rig.controller.run();
    rig.advance(90_000);
    await rig.controller.run();
    const restarted = await rig.record();
    assert.equal(restarted.monitoring.samples.length, 0);
    assert.equal(restarted.monitoring.continuous, false);
  } finally {
    await rig.context.cleanup();
  }
  const refused = await scenario();
  try {
    const controller = new VpsReleaseController({
      ...refused.options,
      stateWrite: {
        writeRelease: () =>
          Promise.resolve({
            ok: true as const,
            value: { status: "conflict" as const, currentHead: null },
          }),
      },
    });
    const result = await controller.run();
    assert.ok(result.ok && result.value.status === "conflict");
    assert.equal(refused.driver.activations, 0);
  } finally {
    await refused.context.cleanup();
  }
});
