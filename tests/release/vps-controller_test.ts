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
  type VpsMetricsSample,
  type VpsMutation,
  type VpsOperation,
  type VpsPrepare,
  type VpsReceipt,
  type VpsSettlement,
} from "../../src/contracts/vps-release-wire.ts";
import { VpsReleaseController } from "../../src/release/vps-controller.ts";
import type {
  VpsMetricsProgress,
  VpsMetricsWork,
} from "../../src/release/vps-metrics.ts";
import {
  composeTrustedVpsReleaseHost,
  verifyCommittedSettlement,
} from "../../src/host/vps-release.ts";
import {
  composeVpsReleasePort,
  type NativeVpsDriverV1,
} from "../../src/release/vps-port.ts";
import { makeGitCtx, publishRepairRequest, storeAt } from "./helpers.ts";
import {
  installVpsDriverHook,
  JOINED_DRIVER_SHA,
  joinedDriverFiles,
  journalCoverage,
  journalRange,
  journalRows,
  testCipher,
  writeVpsDriverTree,
} from "./vps-driver-fixture.ts";

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
  settlements = 0;
  interruptAfterSettlement = 0;
  cleanupFailures = 0;
  verifySettlement:
    | ((receipt: VpsReceipt, input: VpsSettlement) => Promise<boolean>)
    | null = null;
  constructor(private readonly now: () => number) {}
  inspectPrior() {
    return Promise.resolve(this.receipt.prior);
  }
  prepare(input: VpsPrepare) {
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      binding: input.binding,
      controllerSha: input.controllerSha,
      driverSha256: input.expectedDriverSha256,
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
  async settle(input: VpsSettlement) {
    assert.equal(input.expectedSequence, this.receipt.sequence);
    assert.equal(input.expectedDigest, await vpsDigest(this.receipt));
    if (this.verifySettlement) {
      assert.equal(await this.verifySettlement(this.receipt, input), true);
    }
    this.settlements++;
    if (this.receipt.settlement !== null) {
      assert.deepEqual(this.receipt.settlement, {
        stateRevision: input.stateRevision,
        disposition: input.disposition,
        digest: input.digest,
      });
      if (this.cleanupFailures > 0) {
        this.cleanupFailures--;
        throw new Error("pin cleanup unavailable");
      }
      return this.receipt;
    }
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
    if (this.interruptAfterSettlement > 0) {
      this.interruptAfterSettlement--;
      throw new Error("interrupted after terminal persistence");
    }
    return this.receipt;
  }
}

async function scenario(
  failures = 0,
  joined: {
    metricsWork: VpsMetricsWork;
    sample?: (
      input: { identity: VpsIdentity; windowStart: number; windowEnd: number },
      now: number,
    ) => Promise<VpsMetricsSample>;
  } | null = null,
) {
  const context = await makeGitCtx("vps-controller");
  const state = storeAt(context, "vps-controller", "release");
  await publishRepairRequest(context, fixture.request);
  let now = fixture.createdAt;
  const driver = new FakeNativeVpsDriver(() => now);
  const port = composeVpsReleasePort({
    driver,
    metrics: {
      sample: (input) =>
        joined?.sample?.(input, now) ?? Promise.resolve({
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
    ...(joined ? { metricsWork: joined.metricsWork } : {}),
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
Deno.test("VPS controller: interrupted acceptance retries pin cleanup before final state and after head advancement", async () => {
  const rig = await scenario();
  try {
    rig.driver.verifySettlement = (receipt, input) =>
      verifyCommittedSettlement(
        rig.state,
        receipt,
        input,
        rig.options.clock.now(),
      );
    rig.driver.interruptAfterSettlement = 1;
    await rig.controller.run();
    await rig.controller.run();
    await rig.controller.run();
    for (let slot = 0; slot < 64; slot++) {
      rig.advance(30_000);
      await rig.controller.run();
      if (rig.driver.receipt.phase === "accepted") break;
    }
    assert.equal(rig.driver.receipt.phase, "accepted");
    assert.equal((await rig.record()).phase, "monitoring");
    const terminal = structuredClone(rig.driver.receipt);
    rig.driver.cleanupFailures = 1;
    const blocked = await rig.controller.run();
    assert.ok(blocked.ok && blocked.value.status === "waiting");
    assert.equal((await rig.record()).phase, "monitoring");
    await rig.controller.run();
    assert.equal((await rig.record()).phase, "accepted");
    const resumed = await rig.controller.run();
    assert.ok(resumed.ok && resumed.value.status === "idle");
    assert.deepEqual(rig.driver.receipt, terminal);
    assert.equal(rig.driver.settlements, 4);
    assert.equal(rig.driver.activations, 1);
    assert.equal(rig.driver.restorations, 0);
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

Deno.test("VPS controller: joined metrics begin each tick before sampling and hold a collecting window without restarting", async () => {
  const events: string[] = [];
  let startedAt = 0;
  const collecting = (input: { windowStart: number }, now: number) =>
    startedAt > 0 && input.windowStart === startedAt + 60_000 &&
    now < startedAt + 180_000;
  const rig = await scenario(0, {
    metricsWork: {
      beginTick: (at) => events.push(`tick:${at}`),
      progress: (input): Promise<VpsMetricsProgress> =>
        Promise.resolve(
          events.at(-1) === `collecting:${input.windowStart}`
            ? { state: "collecting", reason: "terminal_or_slice_pending" }
            : { state: "complete", reason: null },
        ),
    },
    sample: (input, now) => {
      const pending = collecting(input, now);
      events.push(`${pending ? "collecting" : "sample"}:${input.windowStart}`);
      return Promise.resolve({
        ...input,
        sampledAt: now,
        requestCount: pending ? null : 100,
        fiveXxCount: pending ? null : 0,
        timeoutCount: pending ? null : 0,
        streamFailureCount: pending ? null : 0,
        upstreamWideFault: pending ? null : false,
        coverage: pending ? "incomplete" : "complete",
        coverageDigest: pending ? null : "e".repeat(64),
      });
    },
  });
  try {
    await rig.controller.run();
    await rig.controller.run();
    await rig.controller.run();
    const monitoring = await rig.record();
    assert.equal(monitoring.phase, "monitoring");
    startedAt = monitoring.monitoring.startedAt!;
    const held: number[] = [];
    for (let slot = 0; slot < 80; slot++) {
      rig.advance(30_000);
      events.push(`run:${rig.options.clock.now()}`);
      await rig.controller.run();
      const record = await rig.record();
      if (record.phase === "accepted") break;
      assert.equal(record.monitoring.startedAt, startedAt, "never restarted");
      assert.equal(record.monitoring.continuous, true);
      held.push(record.monitoring.samples.length);
    }
    const accepted = await rig.record();
    assert.equal(accepted.phase, "accepted");
    assert.equal(accepted.monitoring.startedAt, startedAt);
    assert.equal(accepted.monitoring.samples.length, 60);
    assert.deepEqual(held.slice(0, 7), [0, 1, 2, 2, 2, 5, 6]);
    const runs = events.flatMap((event, index) =>
      event.startsWith("run:") ? [index] : []
    );
    assert.ok(runs.length >= 60);
    for (const [position, index] of runs.entries()) {
      const tick = events.slice(index + 1, runs[position + 1]);
      if (tick.length === 0) continue;
      assert.equal(
        tick[0],
        `tick:${events[index].slice(4)}`,
        "each monitoring run begins its tick at its observation time before sampling",
      );
      assert.equal(tick.filter((event) => event.startsWith("tick:")).length, 1);
    }
  } finally {
    await rig.context.cleanup();
  }
});

Deno.test("VPS controller: the real #1027 VpsJournalMetrics drive acceptance through the composed bridge host", async () => {
  const policy = {
    ...fixture.policy,
    minRequests: 2,
    baselineWindowMs: 300_000,
    baselineMinSamples: 10,
  };
  const rig = await scenario();
  const tree = await writeVpsDriverTree(
    JOINED_DRIVER_SHA,
    await joinedDriverFiles(),
  );
  const hook = installVpsDriverHook({ create: () => rig.driver });
  try {
    const candidate = fixture.driver.candidate;
    const prior = fixture.driver.prior.identity;
    // Monitoring starts at the fixture's creation time (the clock holds for
    // the first three runs); the request accepted in candidate window 2 only
    // terminates in window 5, as buffered inference may.
    const startedAt = fixture.createdAt;
    const journal: [number, number, number][] = [];
    const composed = await composeTrustedVpsReleaseHost({
      clock: rig.options.clock,
      stateRead: rig.state,
      stateWrite: rig.state,
      repository: fixture.request.target.repository,
      environment: "production",
      controllerSha: fixture.driver.controllerSha as GitSha,
      targetRoot: "/home/codex/repos/ubiquity/ai.ubq.fi",
      pinnedDriver: {
        releaseRoot: tree.releaseRoot,
        identity: tree.identity,
        moduleSha256: tree.moduleSha256,
      },
      policy,
      logsLagMs: 0,
      timeoutKinds: [],
      upstreamWideKinds: [],
      verifySource: () => Promise.resolve(true),
      journalCoverage: (start, end) =>
        Promise.resolve(journalCoverage(start, end)),
      readInferenceProof: (identity) =>
        Promise.resolve({
          revision: identity.gitSha,
          observedAt: rig.options.clock.now(),
          origin: "mac-direct-vps",
          authenticated: true,
          succeeded: true,
          proofDigest: "f".repeat(64),
        }),
      wait: () => Promise.resolve(),
      deadline: fixture.createdAt + 86_400_000,
      telemetry: {
        retention: {
          evidenceMaxAgeMs: 172_800_000,
          evidenceMaxBytes: 16_777_216,
        },
        cipher: await testCipher(),
      },
      platform: {
        fetch,
        run: () => Promise.reject(new Error("no generic command expected")),
        journal: (args, limits) => {
          const [start, end] = journalRange(args);
          journal.push([start, limits.deadline, rig.options.clock.now()]);
          const requests = [{
            id: "buffered-inference",
            identity: candidate,
            acceptedAt: startedAt + 65_000,
            terminalAt: startedAt + 151_000,
          }];
          for (
            let at = Math.floor(start / 10_000) * 10_000 - 10_000;
            at < end;
            at += 10_000
          ) {
            for (const identity of [candidate, prior]) {
              requests.push({
                id: `${identity.gitSha.slice(0, 7)}-${at}`,
                identity,
                acceptedAt: at + 1_000,
                terminalAt: at + 2_000,
              });
            }
          }
          return Promise.resolve(journalRows(requests, start, end));
        },
      },
    });
    assert.ok(composed.ok, "the joined driver composes");
    assert.ok(composed.value.metricsWork);
    const controller = new VpsReleaseController(composed.value);
    await controller.run();
    await controller.run();
    await controller.run();
    assert.equal((await rig.record()).monitoring.startedAt, startedAt);
    const held: number[] = [];
    for (let slot = 0; slot < 80; slot++) {
      rig.advance(30_000);
      await controller.run();
      const record = await rig.record();
      if (record.phase === "accepted") break;
      assert.equal(record.monitoring.startedAt, startedAt, "never restarted");
      held.push(record.monitoring.samples.length);
    }
    const accepted = await rig.record();
    assert.equal(accepted.phase, "accepted");
    assert.equal(accepted.monitoring.samples.length, 60);
    assert.equal(accepted.monitoring.baseline.length, 10);
    assert.equal(accepted.acceptance?.passed, true);
    assert.equal(accepted.monitoring.samples[2].requestCount, 4);
    assert.deepEqual(held.slice(0, 6), [0, 1, 2, 2, 2, 5]);
    assert.ok(journal.length > 0);
    for (const [, deadline, now] of journal) {
      assert.equal(deadline, now + 20_000, "each tick begins at its own time");
    }
    assert.equal(
      hook.sealed.get(fixture.driver.operationId)?.sequence !== undefined,
      true,
    );
  } finally {
    await tree.cleanup();
    await rig.context.cleanup();
  }
});
