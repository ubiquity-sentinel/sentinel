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
import type {
  VpsBoundedJournalCommand,
  VpsJoinCipher,
  VpsJoinStorage,
  VpsJournalRequest,
  VpsMetricsOptions,
  VpsMetricsScope,
  VpsMetricsWork,
  VpsQueryLimits,
} from "../release/vps-metrics.ts";
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
  composeVpsReleasePort,
  loadPinnedVpsDriver,
  type NativeVpsDriverV1,
} from "../release/vps-port.ts";
import type { VpsReleaseEntrypointDepsV1 } from "../release-main.ts";

type VpsCommand = (
  program: string,
  args: string[],
  cwd: string,
) => Promise<string>;
type VpsCoverage = {
  complete: true;
  unit: "ai-ubq-fi.service";
  windowStart: number;
  windowEnd: number;
  bootId: string;
  firstCursor: string;
  lastCursor: string;
  digest: string;
};
type JournalReader = {
  read(start: number, end: number, limits: VpsQueryLimits): Promise<string>;
  coverage(
    start: number,
    end: number,
    limits: VpsQueryLimits,
  ): Promise<VpsCoverage | null>;
};
interface MetricsModule {
  createVpsJournalReader(
    run: VpsBoundedJournalCommand,
    root: string,
    coverage: JournalReader["coverage"],
  ): JournalReader;
  VpsJournalMetrics: new (
    reader: JournalReader,
    now: () => number,
    lagMs: number,
    timeoutKinds: readonly string[],
    upstreamWideKinds: readonly string[],
    options: VpsMetricsOptions,
  ) => VpsMetricsWork & {
    sample(
      input: { identity: VpsIdentity; windowStart: number; windowEnd: number },
    ): Promise<VpsMetricsSample>;
  };
}

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
  retention: RetentionPolicyV1;
  joinStorage: VpsJoinStorage;
  cipher: VpsJoinCipher;
  journalCommand: VpsBoundedJournalCommand;
  logsLagMs: number;
  timeoutKinds: readonly string[];
  upstreamWideKinds: readonly string[];
  /** Authenticated current source/review/task/CI/merge observer supplied by the owner. */
  verifySource(binding: VpsBinding): Promise<boolean>;
  /** Independent completeness readback; journal text alone cannot prove coverage. */
  journalCoverage: JournalReader["coverage"];
  /** Existing authenticated direct Mac-to-VPS proof, privately read by the release owner. */
  readInferenceProof(identity: VpsIdentity): Promise<VpsInferenceProof | null>;
  /** Only external system/network boundaries are replaceable in local tests. */
  platform?: { run: VpsCommand; fetch: typeof fetch };
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

/** Bind joins to the unique exact committed release operation, never caller supplied timestamps. */
export async function readVpsMetricsScope(
  state: StateReadView,
  input: VpsJournalRequest,
  installationId: number,
  environment: "production" | "isolated",
  controllerSha: string,
  driverSha256: string,
  saved?: { stateHead: string; stateSequence: number },
): Promise<VpsMetricsScope> {
  const current = await state.readRelease();
  if (!current.ok || current.value.status !== "found") {
    throw new Error("VPS metrics context unavailable");
  }
  let read = current;
  if (saved && current.value.head !== saved.stateHead) {
    if (!state.readReleaseAt) {
      throw new Error("VPS metrics history unavailable");
    }
    const historic = await state.readReleaseAt({
      commit: asGitSha(saved.stateHead),
      expectedHead: current.value.head,
    });
    if (
      !historic.ok || historic.value.status !== "found" ||
      historic.value.head !== saved.stateHead
    ) throw new Error("VPS metrics history unavailable");
    read = historic;
  }
  if (!read.ok || read.value.status !== "found") {
    throw new Error("VPS metrics context unavailable");
  }
  const snapshot = parseReleaseStateSnapshotV1(read.value.snapshot);
  if (saved && snapshot.sequence !== saved.stateSequence) {
    throw new Error("VPS metrics history sequence mismatch");
  }
  const records = (snapshot.vpsReleases ?? []).map(parseVpsReleaseRecordV1)
    .filter((record) =>
      record.request.target.repository.owner === "ubiquity" &&
      record.request.target.repository.name === "ai.ubq.fi" &&
      record.request.target.repository.installationId === installationId &&
      record.request.target.environment === environment &&
      record.driver.controllerSha === controllerSha &&
      record.driver.driverSha256 === driverSha256 &&
      record.phase === "monitoring" &&
      (sameVps(input.identity, record.driver.candidate) ||
        sameVps(input.identity, record.driver.prior.identity))
    );
  if (records.length !== 1 || records[0].monitoring.startedAt === null) {
    throw new Error("VPS metrics context ambiguous");
  }
  const record = records[0],
    baselineEnd = Math.floor(record.driver.createdAt / 30_000) * 30_000;
  return {
    operationId: record.driver.operationId,
    requestDigest: record.requestDigest,
    controllerSha,
    driverSha256,
    candidate: record.driver.candidate,
    prior: record.driver.prior.identity,
    monitoringStartedAt: record.monitoring.startedAt!,
    baselineStart: baselineEnd - record.policy.baselineWindowMs,
    baselineEnd,
    stateHead: read.value.head,
    stateSequence: snapshot.sequence,
  };
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
    const retention = parseRetentionPolicy(options.retention, "$.retention");
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
      typeof options.joinStorage?.load !== "function" ||
      typeof options.joinStorage?.save !== "function" ||
      typeof options.cipher?.seal !== "function" ||
      typeof options.cipher?.open !== "function" ||
      typeof options.journalCommand !== "function" ||
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
    const metricsModule = await import(
      new URL(
        `file://${options.pinnedDriver.releaseRoot}/ops/vps-release-metrics.ts`,
      ).href
    ) as MetricsModule;
    if (
      typeof metricsModule.createVpsJournalReader !== "function" ||
      typeof metricsModule.VpsJournalMetrics !== "function"
    ) {
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
    const reader = metricsModule.createVpsJournalReader(
      options.journalCommand,
      options.targetRoot,
      options.journalCoverage,
    );
    const metrics = new metricsModule.VpsJournalMetrics(
      reader,
      () => options.clock.now(),
      options.logsLagMs,
      options.timeoutKinds,
      options.upstreamWideKinds,
      {
        retention,
        storage: options.joinStorage,
        cipher: options.cipher,
        deadline: options.deadline,
        context: (input, saved) =>
          readVpsMetricsScope(
            stateRead,
            input,
            repository.installationId,
            options.environment,
            options.controllerSha,
            driverSha256,
            saved,
          ),
      },
    );
    return portOk({
      stateRead,
      stateWrite,
      repository,
      environment: options.environment,
      controllerSha: options.controllerSha,
      driverSha256,
      policy: options.policy,
      logsLagMs: options.logsLagMs,
      metricsWork: metrics,
      clock: options.clock,
      port: composeVpsReleasePort({
        driver,
        metrics,
        readInferenceProof: options.readInferenceProof,
      }),
      wait: options.wait,
      deadline: options.deadline,
    });
  } catch {
    return portError(
      "unavailable",
      "trusted VPS release capabilities are unavailable",
    );
  }
}
