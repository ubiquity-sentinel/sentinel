/** Standalone release-role composition over an owner-pinned actual VPS driver. */
import type { GitSha } from "../contracts/brands.ts";
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
import type { StabilityPolicyV1 } from "../contracts/repository-policy.ts";
import { validateStabilityPolicy } from "../release/config.ts";
import {
  parseVpsIdentity,
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
  read(start: number, end: number): Promise<string>;
  coverage(start: number, end: number): Promise<VpsCoverage | null>;
};
interface MetricsModule {
  createVpsJournalReader(
    run: VpsCommand,
    root: string,
    coverage: JournalReader["coverage"],
  ): JournalReader;
  VpsJournalMetrics: new (
    reader: JournalReader,
    now: () => number,
    lagMs: number,
    timeoutKinds: readonly string[],
    upstreamWideKinds: readonly string[],
  ) => {
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
async function verifyCommittedSettlement(
  state: StateReadView,
  receipt: VpsReceipt,
  settlement: VpsSettlement,
): Promise<boolean> {
  const read = await state.readRelease();
  if (
    !read.ok || read.value.status !== "found" ||
    read.value.head !== settlement.stateRevision
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
    await vpsDigest(record) !== settlement.digest ||
    await vpsDigest(record.driver) !== await vpsDigest(receipt)
  ) return false;
  return settlement.disposition === "accepted"
    ? record.intent?.action === "accept" &&
      record.acceptance?.passed === true && record.inference !== null
    : record.phase === settlement.disposition;
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
        verifyCommittedSettlement(stateRead, receipt, settlement),
    });
    const reader = metricsModule.createVpsJournalReader(
      run,
      options.targetRoot,
      options.journalCoverage,
    );
    const metrics = new metricsModule.VpsJournalMetrics(
      reader,
      () => options.clock.now(),
      options.logsLagMs,
      options.timeoutKinds,
      options.upstreamWideKinds,
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
