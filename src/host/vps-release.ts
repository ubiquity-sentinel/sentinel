/** Standalone release-role composition over an owner-pinned actual VPS driver. */
import { asGitSha, type GitSha } from "../contracts/brands.ts";
import type {
  Clock,
  PortResultV1,
  ReleaseStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  parseRepositoryIdentity,
  type RepositoryIdentityV1,
} from "../contracts/shared.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { parseVpsReleaseRecordV1 } from "../contracts/vps-release.ts";
import {
  parseRetentionPolicy,
  type RetentionPolicyV1,
  type StabilityPolicyV1,
} from "../contracts/repository-policy.ts";
import { validateStabilityPolicy } from "../release/config.ts";
import {
  canonicalVps,
  isHealthyVps,
  parseVpsIdentity,
  parseVpsReceipt,
  sameVps,
  sha256,
  type VpsBinding,
  vpsDigest,
  type VpsIdentity,
  type VpsInferenceProof,
  type VpsMetricsSample,
  type VpsReceipt,
  type VpsSettlement,
} from "../contracts/vps-release-wire.ts";
import {
  assertDenoLoadableVpsGraph,
  composeVpsReleasePort,
  loadPinnedVpsDriver,
  type NativeVpsDriverV1,
  VpsBunOnlyGraphError,
} from "../release/vps-port.ts";
import {
  type VpsBoundedJournalCommand,
  type VpsCommand,
  type VpsJoinCipher,
  type VpsJoinedMetricsModule,
  vpsJoinStorageModule,
  type VpsJournalCoverageReader,
  type VpsJournalRequest,
  vpsMetricsInterface,
  type VpsMetricsScope,
  type VpsMetricsWork,
} from "../release/vps-metrics.ts";
import type { VpsReleaseEntrypointDepsV1 } from "../release-main.ts";

type VpsSampler = {
  sample(input: VpsJournalRequest): Promise<VpsMetricsSample>;
};
/** The pinned driver's `VpsPayloadPreparation(root, sha, archive)`. */
export type VpsPayloadPreparation = (
  root: string,
  sha: string,
  archive: string,
) => Promise<unknown>;

/** These capabilities belong to the release launcher, never repair/model workers. */
export interface TrustedVpsReleaseHostOptionsV1 {
  clock: Clock;
  stateRead: StateReadView;
  stateWrite: ReleaseStateWriter;
  repository: RepositoryIdentityV1;
  environment: "production" | "isolated";
  controllerSha: GitSha;
  targetRoot: string;
  pinnedDriver: {
    releaseRoot: string;
    identity: VpsIdentity;
    moduleSha256: string;
  };
  policy: StabilityPolicyV1;
  logsLagMs: number;
  timeoutKinds: readonly string[];
  upstreamWideKinds: readonly string[];
  /** Authenticated current source/review/task/CI/merge observer supplied by the owner. */
  verifySource(binding: VpsBinding): Promise<boolean>;
  /** Independent completeness readback; journal text alone cannot prove coverage. */
  journalCoverage: VpsJournalCoverageReader;
  /**
   * Owner-approved evidence retention and sealing key for a driver with the
   * joined VpsJournalMetrics interface (ubiquity/ai.ubq.fi#1027). The pinned
   * driver tree supplies the join storage; absent custody leaves such a driver
   * unavailable. A driver with the window interface never reads it.
   */
  telemetry?: { retention: RetentionPolicyV1; cipher: VpsJoinCipher };
  /** Existing authenticated direct Mac-to-VPS proof, privately read by the release owner. */
  readInferenceProof(identity: VpsIdentity): Promise<VpsInferenceProof | null>;
  /**
   * Owner-supplied release payload preparation, passed to the pinned driver
   * unchanged (sentinel#162). Without one the driver uses its own, which is
   * Bun-only through ai.ubq.fi 6c3afe42, so a Deno bridge can then drive only
   * candidates already prepared under `<root>/.data/releases/<sha>` until
   * ubiquity/ai.ubq.fi#1178 item 1 ships a Deno-safe preparation.
   */
  preparePayload?: VpsPayloadPreparation;
  /**
   * Only external system/network boundaries are replaceable in local tests;
   * the release bridge refuses an owner capabilities host that carries one.
   */
  platform?: {
    run: VpsCommand;
    fetch: typeof fetch;
    journal?: VpsBoundedJournalCommand;
  };
  wait(ms: number): Promise<void>;
  deadline: number;
}

/** Real release-state readback supplies target settlement; no caller boolean substitutes. */
export async function verifyCommittedSettlement(
  state: StateReadView,
  receipt: VpsReceipt,
  settlement: VpsSettlement,
  now: number,
): Promise<boolean> {
  const current = await state.readRelease();
  if (
    !current.ok || current.value.status !== "found" || receipt.updatedAt > now
  ) return false;
  let read: Awaited<ReturnType<StateReadView["readRelease"]>> = current;
  if (current.value.head !== settlement.stateRevision) {
    if (receipt.settlement === null || !state.readReleaseAt) return false;
    read = await state.readReleaseAt({
      commit: asGitSha(settlement.stateRevision),
      expectedHead: current.value.head,
    });
  }
  if (
    !read.ok || read.value.status !== "found" ||
    read.value.head !== settlement.stateRevision ||
    read.value.ref !== current.value.ref
  ) return false;
  const snapshot = parseReleaseStateSnapshotV1(read.value.snapshot);
  const records = (snapshot.vpsReleases ?? []).filter((entry) =>
    entry.driver.operationId === receipt.operationId
  );
  if (records.length !== 1) return false;
  const record = parseVpsReleaseRecordV1(records[0]);
  if (
    record.requestDigest !== receipt.binding.requestDigest ||
    record.driver.driverSha256 !== receipt.driverSha256 ||
    record.driver.controllerSha !== receipt.controllerSha ||
    await vpsDigest(record) !== settlement.digest
  ) return false;
  const committed = settlement.disposition === "accepted"
    ? record.intent?.action === "accept" &&
      record.acceptance?.passed === true && record.inference !== null
    : record.phase === settlement.disposition;
  if (!committed) return false;
  if (
    settlement.disposition === "accepted" &&
    (record.driver.phase !== "ingress_applied" || !record.driver.loopback ||
      !record.driver.public || !isHealthyVps(record.driver.loopback) ||
      !isHealthyVps(record.driver.public))
  ) return false;
  if (
    settlement.disposition === "rolled_back" &&
    record.driver.phase !== "rolled_back"
  ) return false;
  if (
    settlement.disposition === "failed" && record.driver.intent === null &&
    record.intent?.action !== "fail"
  ) return false;
  const predecessorDigest = await vpsDigest(record.driver);
  if (receipt.settlement === null) {
    return predecessorDigest === await vpsDigest(receipt);
  }
  if (
    receipt.phase !== settlement.disposition ||
    canonicalVps(receipt.settlement) !== canonicalVps({
        stateRevision: settlement.stateRevision,
        disposition: settlement.disposition,
        digest: settlement.digest,
      }) ||
    record.driver.settlement !== null ||
    receipt.updatedAt < record.driver.updatedAt
  ) return false;
  const derived = parseVpsReceipt({
    ...record.driver,
    phase: settlement.disposition,
    sequence: record.driver.sequence + 1,
    updatedAt: receipt.updatedAt,
    settlement: receipt.settlement,
    error: settlement.disposition === "failed"
      ? "acceptance_insufficient"
      : record.driver.error,
  });
  const terminalDigest = await vpsDigest(receipt);
  if (await vpsDigest(derived) !== terminalDigest) return false;
  const live = parseReleaseStateSnapshotV1(current.value.snapshot)
    .vpsReleases?.filter((entry) =>
      entry.driver.operationId === receipt.operationId
    ) ?? [];
  if (live.length !== 1) return false;
  for (
    const key of [
      "request",
      "requestDigest",
      "policy",
      "intent",
      "acceptance",
      "inference",
      "createdAt",
    ] as const
  ) {
    if (canonicalVps(live[0][key]) !== canonicalVps(record[key])) return false;
  }
  const liveDriverDigest = await vpsDigest(live[0].driver);
  if (
    (liveDriverDigest !== predecessorDigest &&
      liveDriverDigest !== terminalDigest) ||
    (live[0].phase !== record.phase && live[0].phase !== settlement.disposition)
  ) return false;
  const fresh = await state.readRelease();
  return fresh.ok && fresh.value.status === "found" &&
    fresh.value.head === current.value.head &&
    fresh.value.ref === current.value.ref;
}

type VpsScopeBinding = {
  installationId: number;
  environment: "production" | "isolated";
  controllerSha: string;
  driverSha256: string;
};
/**
 * The unique committed monitoring operation of this host's pinned driver that
 * owns the sampled identity; joins bind to it, never to caller-supplied time.
 * A saved checkpoint is re-read at its own committed release-state revision.
 */
async function readVpsMetricsScope(
  state: StateReadView,
  input: VpsJournalRequest,
  bound: VpsScopeBinding,
  saved?: { stateHead: string; stateSequence: number },
): Promise<VpsMetricsScope> {
  const current = await state.readRelease();
  if (!current.ok || current.value.status !== "found") {
    throw new Error("VPS metrics scope is unavailable");
  }
  let read = current.value;
  if (saved !== undefined && saved.stateHead !== read.head) {
    const historic = await state.readReleaseAt?.({
      commit: asGitSha(saved.stateHead),
      expectedHead: read.head,
    });
    if (
      !historic?.ok || historic.value.status !== "found" ||
      historic.value.head !== saved.stateHead
    ) throw new Error("VPS metrics scope history is unavailable");
    read = historic.value;
  }
  const snapshot = parseReleaseStateSnapshotV1(read.snapshot);
  if (saved !== undefined && snapshot.sequence !== saved.stateSequence) {
    throw new Error("VPS metrics scope history is unavailable");
  }
  const records = (snapshot.vpsReleases ?? []).filter((record) =>
    record.phase === "monitoring" &&
    record.request.target.repository.owner === "ubiquity" &&
    record.request.target.repository.name === "ai.ubq.fi" &&
    record.request.target.repository.installationId === bound.installationId &&
    record.request.target.environment === bound.environment &&
    record.driver.controllerSha === bound.controllerSha &&
    record.driver.driverSha256 === bound.driverSha256 &&
    (sameVps(input.identity, record.driver.candidate) ||
      sameVps(input.identity, record.driver.prior.identity))
  );
  const startedAt = records.length === 1
    ? records[0].monitoring.startedAt
    : null;
  if (startedAt === null) throw new Error("VPS metrics scope is ambiguous");
  const [record] = records;
  // The controller's own baseline slots: the policy window before creation.
  const baselineEnd = Math.floor(record.driver.createdAt / 30_000) * 30_000;
  return {
    operationId: record.driver.operationId,
    requestDigest: record.requestDigest,
    controllerSha: bound.controllerSha,
    driverSha256: bound.driverSha256,
    candidate: record.driver.candidate,
    prior: record.driver.prior.identity,
    monitoringStartedAt: startedAt,
    baselineStart: baselineEnd - record.policy.baselineWindowMs,
    baselineEnd,
    stateHead: read.head,
    stateSequence: snapshot.sequence,
  };
}

/**
 * ubiquity/ai.ubq.fi#1027 composition: the five metrics options, the bounded
 * journal runner and the pinned tree's join storage, imported only once its
 * graph is proven Deno-loadable. The controller drives `beginTick`.
 */
async function composeJoinedVpsMetrics(
  options: TrustedVpsReleaseHostOptionsV1,
  module: VpsJoinedMetricsModule,
  stateRead: StateReadView,
  bound: VpsScopeBinding,
): Promise<
  PortResultV1<{ metrics: VpsSampler; metricsWork: VpsMetricsWork }>
> {
  const cipher = options.telemetry?.cipher;
  let retention: RetentionPolicyV1 | null = null;
  try {
    retention = parseRetentionPolicy(
      options.telemetry?.retention,
      "$.telemetry.retention",
    );
  } catch {
    // Unapproved or absent retention keeps the joined driver unavailable.
  }
  if (
    retention === null || typeof cipher?.seal !== "function" ||
    typeof cipher.open !== "function"
  ) {
    return portError(
      "unavailable",
      "trusted VPS telemetry capabilities are unavailable",
    );
  }
  // The #1027 join storage shares the driver's deploy lock (bun:ffi there).
  await assertDenoLoadableVpsGraph(options.pinnedDriver.releaseRoot, [
    "ops/vps-metrics-storage.ts",
  ]);
  const storageModule = vpsJoinStorageModule(
    await import(
      new URL(
        `file://${options.pinnedDriver.releaseRoot}/ops/vps-metrics-storage.ts`,
      ).href
    ),
  );
  if (storageModule === null) {
    return portError(
      "unavailable",
      "trusted VPS metrics capability is unavailable",
    );
  }
  const now = () => options.clock.now();
  const context = (
    input: VpsJournalRequest,
    saved?: { stateHead: string; stateSequence: number },
  ) => readVpsMetricsScope(stateRead, input, bound, saved);
  // Five arguments: the bridge accepts the upstream 10 s bound on the release
  // state read made under the deploy lock (`stateReadMs`, ai.ubq.fi#1155).
  // Each save prunes `.data/sentinel-vps-metrics` by this one owner retention,
  // the same policy the metrics receive, so every bridge sharing the target
  // root must install the identical `telemetry.retention` (sentinel#161).
  const storage = storageModule.createVpsJoinFileStorage(
    options.targetRoot,
    retention,
    cipher,
    (scope) =>
      context({
        identity: scope.candidate,
        windowStart: scope.monitoringStartedAt,
        windowEnd: scope.monitoringStartedAt + 30_000,
      }),
    now,
  );
  // The pinned tree's own runner checks exactly the argv its own reader builds
  // (six arguments with `--all` since ai.ubq.fi#1155). Sentinel never checks or
  // rebuilds that argv, and the release bridge refuses a `platform` substitute.
  const reader = module.createVpsJournalReader(
    options.platform?.journal ?? module.runVpsJournalCommand,
    options.targetRoot,
    options.journalCoverage,
  );
  const metrics = new module.VpsJournalMetrics(
    reader,
    now,
    options.logsLagMs,
    options.timeoutKinds,
    options.upstreamWideKinds,
    { retention, context, storage, cipher, deadline: options.deadline },
  );
  return portOk({
    metrics,
    metricsWork: {
      beginTick: (observedAt) => metrics.beginTick(observedAt),
      progress: (input) => metrics.progress(input),
    },
  });
}

/** Missing launcher/writer/policy inputs remain unavailable; no transport is invented. */
export async function composeTrustedVpsReleaseHost(
  options: TrustedVpsReleaseHostOptionsV1,
): Promise<PortResultV1<VpsReleaseEntrypointDepsV1>> {
  try {
    const repository = parseRepositoryIdentity(
      options.repository,
      "$.repository",
    );
    const identity = parseVpsIdentity(options.pinnedDriver.identity);
    const driverSha256 = sha256(options.pinnedDriver.moduleSha256);
    if (
      repository.owner !== "ubiquity" || repository.name !== "ai.ubq.fi" ||
      repository.installationId < 1 ||
      !["production", "isolated"].includes(options.environment) ||
      !validateStabilityPolicy(options.policy).ok ||
      !options.targetRoot.startsWith("/") ||
      (options.environment === "production" &&
        options.targetRoot !== "/home/codex/repos/ubiquity/ai.ubq.fi") ||
      typeof options.stateRead?.readRepair !== "function" ||
      typeof options.stateRead?.readRelease !== "function" ||
      typeof options.stateWrite?.writeRelease !== "function" ||
      typeof options.verifySource !== "function" ||
      typeof options.journalCoverage !== "function" ||
      typeof options.readInferenceProof !== "function" ||
      (options.preparePayload !== undefined &&
        typeof options.preparePayload !== "function") ||
      typeof options.wait !== "function" ||
      !Number.isSafeInteger(options.deadline) ||
      options.deadline <= options.clock.now()
    ) {
      return portError(
        "unavailable",
        "trusted VPS release capabilities are unavailable",
      );
    }
    const module = await loadPinnedVpsDriver({
      releaseRoot: options.pinnedDriver.releaseRoot,
      identity,
      moduleSha256: driverSha256,
    }) as {
      createVpsDeploymentDriver(deps: unknown): NativeVpsDriverV1;
      runVpsCommand: VpsCommand;
    };
    if (typeof module.runVpsCommand !== "function") {
      return portError(
        "unavailable",
        "trusted VPS driver command capability is unavailable",
      );
    }
    // The full immutable tree was verified by the loader before either module is evaluated.
    const metricsInterface = vpsMetricsInterface(
      await import(
        new URL(
          `file://${options.pinnedDriver.releaseRoot}/ops/vps-release-metrics.ts`,
        ).href
      ),
    );
    if (metricsInterface === null) {
      return portError(
        "unavailable",
        "trusted VPS metrics capability is unavailable",
      );
    }
    const stateRead: StateReadView = {
      readRepair: () => options.stateRead.readRepair(),
      readRelease: () => options.stateRead.readRelease(),
      readReleaseAt: options.stateRead.readReleaseAt?.bind(options.stateRead),
    };
    const stateWrite: ReleaseStateWriter = {
      writeRelease: (snapshot, expectedHead) =>
        options.stateWrite.writeRelease(snapshot, expectedHead),
    };
    const run = options.platform?.run ?? module.runVpsCommand;
    const driver = module.createVpsDeploymentDriver({
      root: options.targetRoot,
      installationId: repository.installationId,
      environment: options.environment,
      driverSha256,
      run,
      ...(options.preparePayload === undefined
        ? {}
        : { preparePayload: options.preparePayload }),
      fetch: options.platform?.fetch ?? fetch,
      now: () => options.clock.now(),
      verifySource: options.verifySource,
      verifySettlement: (receipt: VpsReceipt, settlement: VpsSettlement) =>
        verifyCommittedSettlement(
          stateRead,
          receipt,
          settlement,
          options.clock.now(),
        ),
    });
    let metrics: VpsSampler, metricsWork: VpsMetricsWork | undefined;
    if (metricsInterface.kind === "window") {
      // The driver pinned today (ai.ubq.fi 21e4a2a9): composed exactly as before.
      const reader = metricsInterface.module.createVpsJournalReader(
        run,
        options.targetRoot,
        options.journalCoverage,
      );
      metrics = new metricsInterface.module.VpsJournalMetrics(
        reader,
        () => options.clock.now(),
        options.logsLagMs,
        options.timeoutKinds,
        options.upstreamWideKinds,
      );
    } else {
      const joined = await composeJoinedVpsMetrics(
        options,
        metricsInterface.module,
        stateRead,
        {
          installationId: repository.installationId,
          environment: options.environment,
          controllerSha: options.controllerSha,
          driverSha256,
        },
      );
      if (!joined.ok) return joined;
      ({ metrics, metricsWork } = joined.value);
    }
    return portOk({
      stateRead,
      stateWrite,
      repository,
      environment: options.environment,
      controllerSha: options.controllerSha,
      driverSha256,
      policy: options.policy,
      logsLagMs: options.logsLagMs,
      clock: options.clock,
      port: composeVpsReleasePort({
        driver,
        metrics,
        readInferenceProof: options.readInferenceProof,
      }),
      wait: options.wait,
      deadline: options.deadline,
      ...(metricsWork === undefined ? {} : { metricsWork }),
    });
  } catch (error) {
    return portError(
      "unavailable",
      error instanceof VpsBunOnlyGraphError
        ? "trusted VPS driver needs a host that can load Bun-only modules"
        : "trusted VPS release capabilities are unavailable",
    );
  }
}
