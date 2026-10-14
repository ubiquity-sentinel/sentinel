// Release lifecycle setup over fake APIs and disposable Git; registers no tests.
import assert from "node:assert/strict";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import type { ReleaseRecordV1 } from "../../src/contracts/release.ts";
import { parseReleaseRecordV1 } from "../../src/contracts/release.ts";
import type {
  DeploymentIdentityV1,
  MetricsSampleV1,
} from "../../src/contracts/shared.ts";
import type { StabilityPolicyV1 } from "../../src/contracts/repository-config.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  ReleaseController,
  type ReleaseControllerOptions,
  type ReleaseCycleResultV1,
} from "../../src/release/controller.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { DenoReleaseRESTClient } from "../../src/release/port.ts";
import {
  buildAcceptanceResult,
  evaluateAcceptance,
} from "../../src/release/acceptance.ts";
import { RELEASE_SAMPLE_INTERVAL_MS } from "../../src/release/config.ts";
import {
  asTransport,
  DEP_0,
  DEP_1,
  type GitCtxV1,
  installREST,
  logRoute,
  makeGitCtx,
  MANAGED_URL,
  promoteRoute,
  publishRepairRequest,
  requestFor,
  ScriptedResolver,
  ScriptedTransport,
  stabilityPolicy,
  storeAt,
  T0,
  targetConfig,
  TestClock,
} from "./helpers.ts";

export interface ScenarioV1 {
  ctx: GitCtxV1;
  transport: ScriptedTransport;
  clock: TestClock;
  controller: ReleaseController;
  resolver: ScriptedResolver;
  policy: StabilityPolicyV1;
  records(): Promise<ReleaseRecordV1[]>;
  cleanup(): Promise<void>;
}

export async function makeScenario(
  overrides: {
    logs?: Parameters<typeof logRoute>[1];
    policy?: StabilityPolicyV1;
    deployments?: DeploymentIdentityV1[];
    promote?:
      | { target: DeploymentIdentityV1; lost?: boolean; reject?: boolean }
      | null;
    request?: ReturnType<typeof requestFor>;
    resolver?: ScriptedResolver;
  } = {},
): Promise<ScenarioV1> {
  const ctx = await makeGitCtx("acceptance");
  const env = ctx.env;
  void env;
  const config = targetConfig();
  const transport = new ScriptedTransport(config);
  const deployments = overrides.deployments ?? [DEP_0, DEP_1];
  installREST(transport, deployments);
  transport.health();
  if (overrides.logs) {
    logRoute(transport, overrides.logs);
  }
  const promote = overrides.promote === undefined
    ? { target: DEP_1 }
    : overrides.promote;
  if (promote !== null) {
    promoteRoute(transport, promote.target, promote);
  }
  const clock = new TestClock(T0);
  const resolver = overrides.resolver ?? new ScriptedResolver();
  const policy = overrides.policy ?? stabilityPolicy();
  const state = storeAt(ctx, "controller", "release");
  const request = overrides.request ?? requestFor();
  const published = await publishRepairRequest(ctx, request);
  assert.ok(published.length === 40, "repair request must be published");
  const options: ReleaseControllerOptions = {
    repository: request.target.repository,
    environment: request.target.environment,
    target: config,
    policy,
    stateRead: state,
    stateWrite: state,
    deno: portClient(transport, config, clock),
    resolver,
    clock,
  };
  const controller = new ReleaseController(options);
  return {
    ctx,
    transport,
    clock,
    controller,
    resolver,
    policy,
    records: async () => {
      const store = storeAt(ctx, "read", "release");
      const read = await store.readRelease();
      if (!read.ok || read.value.status !== "found") return [];
      return read.value.snapshot.releases;
    },
    cleanup: () => ctx.cleanup(),
  };
}

export function portClient(
  transport: ScriptedTransport,
  config: ReturnType<typeof targetConfig>,
  clock: TestClock,
): DenoReleaseRESTClient {
  return new DenoReleaseRESTClient({
    transport: asTransport(transport),
    auth: { bearerToken: () => Promise.resolve(portOk("deno-token")) },
    config,
    clock,
  });
}

export function assertCycle(
  result: PortResultV1<ReleaseCycleResultV1>,
  status: ReleaseCycleResultV1["status"],
): void {
  assert.ok(result.ok, "expected a cycle result");
  if (!result.ok) return;
  assert.equal(result.value.status, status);
}

export async function promoteToMonitoring(
  scene: ScenarioV1,
): Promise<ReleaseRecordV1> {
  assertCycle(await scene.controller.run(), "advanced"); // record created
  scene.clock.advance(1);
  assertCycle(await scene.controller.run(), "advanced"); // promoting → monitoring
  const records = await scene.records();
  if (records.length !== 1) throw new Error("expected one record");
  assert.equal(records[0].phase, "monitoring");
  return records[0];
}

/**
 * Steps the monitoring window one slot per run: each run waits for the next
 * adjacent slot as well as the source lag, so every persisted sample has a
 * complete boundary join. Returns the number of slots actually persisted.
 */
export async function stepSlots(
  scene: ScenarioV1,
  count: number,
): Promise<number> {
  const records = await scene.records();
  const record = records[0];
  if (record.monitoring.startedAt === null) {
    throw new Error("missing window start");
  }
  const startedAt = record.monitoring.startedAt;
  for (let k = 0; k < count; k++) {
    // Slot k is sampled after its following slot ends and the trusted log lag
    // has elapsed. Exactly one slot is due per run.
    scene.clock.at(
      startedAt + (k + 2) * RELEASE_SAMPLE_INTERVAL_MS + 5_000 + 1,
    );
    const result = await scene.controller.run();
    assert.ok(result.ok, "expected a cycle result");
    if (result.ok) assert.equal(result.value.status, "persisted");
  }
  const after = await scene.records();
  return after[0].monitoring.samples;
}

/**
 * Persists `slotCount` candidate slots plus the complete baseline through the
 * REAL metrics port (exact windows, exact identities, real cohort counts) in
 * one deterministic record, exactly as the controller's per-slot runs would
 * have persisted them, then lets one controller run collect the final slot
 * and evaluate the window. This keeps the full-window tests bounded while
 * every sample remains real port evidence validated by the contract parser.
 */
export async function seedMonitorWindow(
  scene: ScenarioV1,
  slotCount: number,
): Promise<void> {
  const records = await scene.records();
  const record = records[0];
  if (record.monitoring.startedAt === null) {
    throw new Error("missing window start");
  }
  const startedAt = record.monitoring.startedAt;
  const client = portClient(scene.transport, targetConfig(), scene.clock);
  const policy = scene.policy;
  const interval = RELEASE_SAMPLE_INTERVAL_MS;
  const lag = targetConfig().logsLagMs;
  const now = startedAt + (slotCount + 1) * interval + lag + 1;
  scene.clock.at(now);

  const baseline: MetricsSampleV1[] = [];
  const baselineStart = record.prior.verifiedHealthyAt -
    policy.baselineWindowMs;
  const expectedBaseline = policy.baselineWindowMs / interval;
  for (let k = 0; k < expectedBaseline; k++) {
    const sample = await client.sampleMetrics({
      baseUrl: MANAGED_URL,
      metricsPath: "/health",
      identity: record.prior.identity,
      windowStart: baselineStart + k * interval,
      windowEnd: baselineStart + (k + 1) * interval,
      domain: "ai.ubq.fi",
    });
    assert.ok(sample.ok, "baseline slot must sample through the port");
    if (!sample.ok) throw new Error("baseline slot unavailable");
    baseline.push(sample.value);
  }
  const samples: MetricsSampleV1[] = [];
  for (let k = 0; k < slotCount; k++) {
    const sample = await client.sampleMetrics({
      baseUrl: MANAGED_URL,
      metricsPath: "/health",
      identity: record.candidate.identity,
      windowStart: startedAt + k * interval,
      windowEnd: startedAt + (k + 1) * interval,
      domain: "ai.ubq.fi",
    });
    assert.ok(sample.ok, "candidate slot must sample through the port");
    if (!sample.ok) throw new Error("candidate slot unavailable");
    samples.push(sample.value);
  }

  const evaluation = evaluateAcceptance(policy, baseline, samples);
  const acceptance = buildAcceptanceResult(
    record.candidate.identity,
    baseline,
    samples,
    evaluation,
  );
  const seeded = parseReleaseRecordV1({
    ...record,
    monitoring: {
      startedAt,
      samples: slotCount,
      continuous: true,
      lastSampleAt: now,
    },
    acceptance,
    updatedAt: now,
  });
  const store = storeAt(scene.ctx, "seed", "release");
  const read = await store.readRelease();
  assert.ok(read.ok, "release state must be readable");
  if (!read.ok) throw new Error("release state unavailable");
  if (read.value.status !== "found") throw new Error("missing release state");
  const priorSnapshot = read.value.snapshot;
  const next: ReleaseStateSnapshotV1 = {
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: read.value.head,
    sequence: priorSnapshot.sequence + 1,
    updatedAt: now,
    releases: priorSnapshot.releases.map((entry) =>
      entry.id === seeded.id ? seeded : entry
    ),
    hostedRuntimes: priorSnapshot.hostedRuntimes,
    hostedReleases: priorSnapshot.hostedReleases,
    githubCooldowns: priorSnapshot.githubCooldowns,
  };
  const written = await store.writeRelease(next, read.value.head);
  assert.ok(written.ok, "seeded window must be applied");
  if (written.ok) assert.equal(written.value.status, "applied");
}

/**
 * Completes the acceptance window: seeds `slotCount - 1` persisted slots
 * (continuous, real port evidence), then one controller run collects the
 * final due slot and evaluates the window.
 */
export async function completeWindow(
  scene: ScenarioV1,
  slotCount = 60,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  await seedMonitorWindow(scene, slotCount - 1);
  const records = await scene.records();
  const startedAt = records[0].monitoring.startedAt;
  if (startedAt === null) throw new Error("missing window start");
  scene.clock.at(
    startedAt + (slotCount + 1) * RELEASE_SAMPLE_INTERVAL_MS +
      targetConfig().logsLagMs + 1,
  );
  return scene.controller.run();
}

export function makeRestartController(scene: ScenarioV1): ReleaseController {
  const config = targetConfig();
  const state = storeAt(scene.ctx, "restart", "release");
  return new ReleaseController({
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
    environment: "production",
    target: config,
    policy: stabilityPolicy(),
    stateRead: state,
    stateWrite: state,
    deno: portClient(scene.transport, config, scene.clock),
    resolver: scene.resolver,
    clock: scene.clock,
  });
}
