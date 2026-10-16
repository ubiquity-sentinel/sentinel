/** Bounded progressive authenticated matrix recovery and serial delivery. */
import { matrixDigestV1 } from "../contracts/matrix.ts";
import {
  type ActionsTargetCyclesInputV1,
  type ActionsTargetCyclesResultV1,
  runActionsTargetCycles,
} from "./actions.ts";
import { ingestMatrixResults } from "./matrix.ts";
import { createGitBundleImporter } from "./matrix-git.ts";
import type { MatrixArtifactTransportV1 } from "./matrix-artifact-port.ts";
import {
  closedCWaveHandledReservations,
  closedCWaveNeedsRecovery,
  ingestClosedCWave,
} from "./modern-matrix-recovery.ts";
import { recoverWithHistoricalIsolation } from "./matrix-historical-isolation.ts";
import {
  hostOf,
  type MatrixNativeCarrierV1,
  targetDeps,
} from "./matrix-actions-shared.ts";

async function transportFor(
  input: ActionsTargetCyclesInputV1,
  injected?: MatrixArtifactTransportV1,
): Promise<MatrixArtifactTransportV1> {
  if (injected !== undefined) return injected;
  return await hostOf(input).createArtifactTransport();
}
/** One bounded interval between authenticated completed-artifact scans. */
const MATRIX_CONSUMER_POLL_MS = 60_000;
/**
 * The progressive consumer yields to the ordinary lifecycle after this window
 * even while charged producers are still live: their artifacts stay charged
 * and unresolved for a later recovery instead of being terminalized here.
 */
const MATRIX_CONSUMER_MAX_WAIT_MS = 20 * 60_000;
/** Time reserved after progressive consumption for the ordinary lifecycle. */
const MATRIX_CONSUMER_MARGIN_MS = 5 * 60_000;

/** Deterministic seams for the progressive authenticated matrix consumer. */
export interface MatrixAggregateOptionsV1 {
  /** Wall-clock wait between empty scans; tests inject a clock advance. */
  pollWait?: (ms: number) => Promise<void>;
  /** Consumer window; 0 keeps exactly the original single-scan behavior. */
  maxWaitMs?: number;
}

/** Authenticating/importing receipts precedes ordinary publication/review/delivery. */
export async function runActionsMatrixAggregateCycles(
  input: ActionsTargetCyclesInputV1,
  injectedTransport?: MatrixArtifactTransportV1,
  carrier?: MatrixNativeCarrierV1,
  options: MatrixAggregateOptionsV1 = {},
): Promise<ActionsTargetCyclesResultV1> {
  const host = hostOf(input);
  let read = await input.state.readRepair();
  if (!read.ok || read.value.status !== "found") {
    throw new Error("matrix aggregate cannot read authoritative state");
  }
  if (closedCWaveNeedsRecovery(read.value.snapshot)) {
    if (!host.readExecution) {
      throw new Error("C recovery native proof reader unavailable");
    }
    const recovered = await ingestClosedCWave({
      state: input.state,
      clock: input.clock,
      configs: input.configs,
      cycleFor: (config) => targetDeps(input, config),
      prepareTarget: async (config) => {
        await input.prepareTarget?.(config);
      },
      importerFor: (config, bundlesDir) =>
        createGitBundleImporter({
          repositoryDir: host.sourcePathFor(config),
          bundlesDir,
        }),
      transportFor: (state) => host.createArtifactTransport(state),
      readExecution: host.readExecution,
      failoverModel: host.failoverModel,
    }, false);
    console.log(
      JSON.stringify({ kind: "sentinel_closed_c_recovery", ...recovered }),
    );
    read = await input.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("C recovery readback unavailable");
    }
  }
  const transport = await transportFor(input, injectedTransport);
  const pollWait = options.pollWait ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const consumerUntil = Math.min(
    input.deadline - MATRIX_CONSUMER_MARGIN_MS,
    input.clock.now() + (options.maxWaitMs ?? MATRIX_CONSUMER_MAX_WAIT_MS),
  );
  const prepared = new Set<string>();
  let firstScan = true;
  // Progressive authenticated consumption: every scan re-reads authoritative
  // state, recovers ONLY completed artifacts for the still-charged producers
  // and ingests each exactly once. The first scan also recovers already-settled
  // charges so a lost candidate object is rehydrated exactly as before; later
  // scans wait only for producers whose reservation is still unconsumed, so no
  // already-ingested artifact is repeatedly downloaded. An empty scan is never
  // completion: while a charged producer may still deliver, the consumer keeps
  // polling inside the run's own budget. Late or missing artifacts stay charged
  // and unresolved instead of being terminalized as a failure or health
  // verdict, and repeated scans of an already-consumed cell are the existing
  // duplicate no-op.
  for (;;) {
    const scan = await input.state.readRepair();
    if (!scan.ok || scan.value.status !== "found") {
      throw new Error("matrix aggregate cannot read authoritative state");
    }
    const handled = closedCWaveHandledReservations(scan.value.snapshot);
    const charged = scan.value.snapshot.work.flatMap((record) => {
      const intent = record.intent;
      if (
        record.nextStep !== "work" ||
        (intent?.kind !== "implementation" &&
          intent?.kind !== "candidate_preservation") ||
        intent.requestId === null || handled.has(intent.requestId)
      ) {
        return [];
      }
      return [{
        taskId: record.id,
        repository: record.repository,
        reservationId: intent.requestId,
        intentKey: intent.key,
        expectedBase: record.target.base,
        attempt: record.counters.attempts,
      }];
    });
    const reservedNow = new Set(
      scan.value.snapshot.reservations
        .filter((row) => row.outcome === "reserved")
        .map((row) => row.id),
    );
    const live = charged.filter((request) =>
      reservedNow.has(request.reservationId)
    );
    const initialScan = firstScan;
    const requests = initialScan ? charged : live;
    firstScan = false;
    if (requests.length === 0) break;
    const unresolved = new Set(
      requests.map((request) => request.reservationId),
    );
    const waves = await recoverWithHistoricalIsolation(input, transport, {
      requests,
      runtimeSha: input.controllerSha,
      launcherSha: host.run.launcherSha,
      consumerRun: host.run,
      // The initial scan still runs when there is no polling window left,
      // bounded by the actual run deadline and one shared transport budget.
      // Subsequent scans and retries never renew that polling window.
      deadline: Math.min(
        input.deadline,
        initialScan && consumerUntil <= input.clock.now()
          ? input.deadline
          : consumerUntil,
      ),
      ...(carrier === undefined ? {} : { currentRun: host.run }),
    });
    let progressed = false;
    for (const wave of waves) {
      if (
        await matrixDigestV1(wave.plan) !== wave.planDigest ||
        wave.plan.run.runId !== wave.provenance.run.runId ||
        wave.plan.run.runAttempt !== wave.provenance.run.runAttempt ||
        wave.plan.run.launcherSha !== wave.provenance.run.launcherSha ||
        !Number.isSafeInteger(wave.provenance.plannerJobId) ||
        wave.provenance.plannerJobId <= 0
      ) {
        throw new Error("matrix artifact provenance is inconsistent");
      }
      if (
        carrier !== undefined && wave.plan.run.runId === host.run.runId &&
        wave.plan.run.runAttempt === host.run.runAttempt &&
        wave.planDigest !== carrier.planDigest
      ) {
        throw new Error(
          "matrix aggregate plan differs from native planner output",
        );
      }
      for (const config of input.configs) {
        const configKey = config.repository.owner + "/" +
          config.repository.name;
        const cells = wave.plan.cells.filter((cell) =>
          cell.repository.owner === config.repository.owner &&
          cell.repository.name === config.repository.name &&
          cell.repository.installationId ===
            config.repository.installationId &&
          unresolved.has(cell.reservationId)
        );
        if (cells.length === 0) continue;
        if (!prepared.has(configKey)) {
          await input.prepareTarget?.(config);
          prepared.add(configKey);
        }
        const report = await ingestMatrixResults(
          targetDeps(input, config),
          { ...wave.plan, cells },
          wave.results.filter((entry) =>
            cells.some((cell) => cell.cellId === entry.cellId)
          ),
          {
            deadline: input.deadline,
            expectedProvider: host.expectedProvider,
            failoverModel: host.failoverModel,
            bundleImporter: createGitBundleImporter({
              repositoryDir: host.sourcePathFor(config),
              bundlesDir: wave.bundlesDir,
            }),
          },
        );
        console.log(
          JSON.stringify({ kind: "sentinel_matrix_ingest", ...report }),
        );
        if (report.ingested > 0) progressed = true;
      }
    }
    // The bounded consumer window closes before any further scan, so
    // `maxWaitMs: 0` is exactly one authenticated recovery even when that scan
    // consumed a cell.
    if (input.clock.now() >= consumerUntil) break;
    if (progressed) continue;
    // Nothing is left to wait for once every charged producer has been
    // consumed; a settled charge is rehydrated by the ordinary lifecycle and
    // by the next run's first scan, never by spinning here.
    if (live.length === 0) break;
    if (input.clock.now() + MATRIX_CONSUMER_POLL_MS >= consumerUntil) break;
    await pollWait(MATRIX_CONSUMER_POLL_MS);
  }
  // Missing/unavailable cell artifacts stay charged and unresolved. Reviews and
  // delivery retain the real ordinary lifecycle; implementation never falls back.
  return await runActionsTargetCycles({
    ...input,
    modelStartsEnabled: carrier === undefined
      ? false
      : input.modelStartsEnabled,
    externalImplementations: true,
  });
}
