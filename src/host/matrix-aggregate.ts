/** Bounded progressive authenticated matrix recovery and serial delivery. */
import { matrixDigestV1 } from "../contracts/matrix.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { OPERATION_MARGIN_MS, REVIEW_BOUND_MS } from "../repair/loop-bounds.ts";
import {
  type ActionsTargetCyclesInputV1,
  type ActionsTargetCyclesResultV1,
  runActionsTargetCycles,
} from "./actions.ts";
import { ingestMatrixResults } from "./matrix.ts";
import { createGitBundleImporter } from "./matrix-git.ts";
import {
  MATRIX_ARTIFACT_RECOVERY_MAX_MS,
  type MatrixArtifactRequestV1,
  type MatrixArtifactTransportV1,
  MatrixArtifactUnavailableError,
} from "./matrix-artifact-port.ts";
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
 * even while its own charged producers are still live: their artifacts stay
 * charged and unresolved for a later recovery instead of being terminalized
 * here.
 */
const MATRIX_CONSUMER_MAX_WAIT_MS = 20 * 60_000;
/** Time reserved after progressive consumption for the ordinary lifecycle. */
const MATRIX_CONSUMER_MARGIN_MS = 5 * 60_000;
/**
 * Lead one target's serial cycle needs, after the consumer yields, before it
 * can request a review: intake, base reads and publication. Targets run one
 * after another, so every later target also waits for the earlier cycles.
 */
export const MATRIX_TARGET_REVIEW_LEAD_MS = 5 * 60_000;
/**
 * An earlier target's own review, which its serial cycle drains before the
 * next target's cycle starts. Live (31 sentinel review receipts): submission
 * to completion took 6.6 minutes at the median, about 10 at p75 and 18.4 at
 * most. Reserved for every target except the last, whose own review start is
 * the bound itself; a longer review leaves a later target's review to the
 * next run instead of keeping live cells waiting.
 */
export const MATRIX_TARGET_REVIEW_DRAIN_MS = 10 * 60_000;

/** The progressive consumer's two bounds, fixed once when it starts. */
export interface MatrixConsumerWindowV1 {
  /** Its own wait, never past the margin the ordinary lifecycle keeps. */
  readonly window: number;
  /** When it stops waiting for live producers: never after `window`. */
  readonly until: number;
}

/**
 * The progressive consumer's bounds. When the ordinary lifecycle that follows
 * may start reviews, the consumer also stops waiting early enough that every
 * serial target cycle still reaches its latest review start: the cycle loop
 * runs to `deadline - OPERATION_MARGIN_MS` and a review must fit its full
 * bound before one more margin, so the last review start of any cycle is
 * `deadline - 2 * OPERATION_MARGIN_MS - REVIEW_BOUND_MS`. Before the last
 * target reaches it, every target needs its review lead and every earlier
 * target also drains its own review. A long run never reaches this bound; a
 * short one (an App-token window) waits less for live cells, which stay
 * charged for a later recovery, instead of leaving later targets no review.
 */
export function matrixConsumerWindowV1(input: {
  now: number;
  deadline: number;
  maxWaitMs: number;
  targets: number;
  reviewsMayStart: boolean;
}): MatrixConsumerWindowV1 {
  const window = Math.min(
    input.deadline - MATRIX_CONSUMER_MARGIN_MS,
    input.now + input.maxWaitMs,
  );
  if (!input.reviewsMayStart) return { window, until: window };
  return {
    window,
    until: Math.min(
      window,
      input.deadline - 2 * OPERATION_MARGIN_MS - REVIEW_BOUND_MS -
        input.targets * MATRIX_TARGET_REVIEW_LEAD_MS -
        Math.max(0, input.targets - 1) * MATRIX_TARGET_REVIEW_DRAIN_MS,
    ),
  };
}

/** Deterministic seams for the progressive authenticated matrix consumer. */
export interface MatrixAggregateOptionsV1 {
  /** Wall-clock wait between empty scans; tests inject a clock advance. */
  pollWait?: (ms: number) => Promise<void>;
  /** Consumer window; 0 keeps exactly the original single-scan behavior. */
  maxWaitMs?: number;
}

/**
 * The recovery bound of one scan. Later scans stop at the consumer's `until`.
 * The mandatory initial scan never does: a review cutoff only seconds away
 * would time it out and refuse the whole run before any target cycle, so it
 * keeps the consumer's own window, else the run deadline; the transport's own
 * scan budget (`MATRIX_ARTIFACT_RECOVERY_MAX_MS`) bounds any overrun.
 */
function scanRecoveryBound(
  initialScan: boolean,
  consumer: MatrixConsumerWindowV1,
  deadline: number,
  clock: { now(): number },
): number {
  if (!initialScan) return consumer.until;
  return consumer.window > clock.now() ? consumer.window : deadline;
}

/** The charged matrix producers of one authoritative snapshot. */
export interface MatrixConsumerProducersV1 {
  /** Every producer still holding a matrix intent, from any wave. */
  readonly charged: readonly MatrixArtifactRequestV1[];
  /** The charged producers whose reservation is still unconsumed. */
  readonly live: readonly MatrixArtifactRequestV1[];
  /** The live producers this execution's own planner admitted. */
  readonly own: readonly MatrixArtifactRequestV1[];
}

/** Runner clock-skew allowance when classing a reservation as this run's own. */
export const MATRIX_CONSUMER_OWN_SKEW_MS = 60_000;

/**
 * The producers the progressive consumer recovers. The mandatory initial scan
 * recovers every `charged` producer, whatever wave planned it, so a lost
 * candidate object is rehydrated exactly as before. Only an `own` producer can
 * still deliver during this run: its reservation was made at or after
 * `plannedSince`, the creation of this execution, which every admission of its
 * own planner follows. An earlier wave's producer whose reservation is still
 * "reserved" belongs to a run that has ended, so it never holds the consumer's
 * polling or a later scan; it stays charged and unresolved for the next run's
 * initial scan and the launcher maintenance that owns its recovery.
 */
export function matrixConsumerProducersV1(
  snapshot: RepairStateSnapshotV1,
  plannedSince: number,
): MatrixConsumerProducersV1 {
  const handled = closedCWaveHandledReservations(snapshot);
  const charged = snapshot.work.flatMap((record) => {
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
  const reservedAt = new Map(
    snapshot.reservations
      .filter((row) => row.outcome === "reserved")
      .map((row) => [row.id, row.createdAt]),
  );
  const live = charged.filter((request) =>
    reservedAt.has(request.reservationId)
  );
  // A small allowance for clock skew between the runner that created the
  // execution and the planner's runner: an earlier wave's reservations are
  // many minutes older (its cells, aggregate, finalize and this run's
  // maintenance and prepare all came between), so they stay excluded.
  const since = plannedSince - MATRIX_CONSUMER_OWN_SKEW_MS;
  const own = live.filter((request) => {
    const at = reservedAt.get(request.reservationId);
    return at !== undefined && at >= since;
  });
  return { charged, live, own };
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
  // #183: progress comments compare against the state before this job's
  // ingestion, so a park or publication made while consuming cells reports.
  const progressBaseline = read.value.snapshot.work;
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
  // The ordinary lifecycle below may start models (and so reviews) only for
  // the native consumer of this run's own plan.
  const lifecycleModelStarts = carrier === undefined
    ? false
    : input.modelStartsEnabled;
  const consumer = matrixConsumerWindowV1({
    now: input.clock.now(),
    deadline: input.deadline,
    maxWaitMs: options.maxWaitMs ?? MATRIX_CONSUMER_MAX_WAIT_MS,
    targets: input.configs.length,
    reviewsMayStart: lifecycleModelStarts,
  });
  const consumerUntil = consumer.until;
  const prepared = new Set<string>();
  let firstScan = true;
  // Progressive authenticated consumption: every scan re-reads authoritative
  // state, recovers ONLY completed artifacts for the still-charged producers
  // and ingests each exactly once. The first scan also recovers already-settled
  // charges and every earlier wave's producers so a lost candidate object is
  // rehydrated exactly as before; later scans wait only for producers this
  // execution planned whose reservation is still unconsumed, so no
  // already-ingested artifact is repeatedly downloaded and no ended run's
  // producer holds the target cycles back. An empty scan is never completion:
  // while an own producer may still deliver, the consumer keeps polling inside
  // the run's own budget. Late or missing artifacts stay charged and
  // unresolved instead of being terminalized as a failure or health verdict,
  // and repeated scans of an already-consumed cell are the existing duplicate
  // no-op.
  for (;;) {
    const scan = await input.state.readRepair();
    if (!scan.ok || scan.value.status !== "found") {
      throw new Error("matrix aggregate cannot read authoritative state");
    }
    const { charged, own } = matrixConsumerProducersV1(
      scan.value.snapshot,
      host.execution.createdAt,
    );
    const initialScan = firstScan;
    const requests = initialScan ? charged : own;
    firstScan = false;
    if (requests.length === 0) break;
    const unresolved = new Set(
      requests.map((request) => request.reservationId),
    );
    let waves: Awaited<ReturnType<typeof recoverWithHistoricalIsolation>>;
    try {
      waves = await recoverWithHistoricalIsolation(input, transport, {
        requests,
        runtimeSha: input.controllerSha,
        launcherSha: host.run.launcherSha,
        consumerRun: host.run,
        // The initial scan still runs when there is no polling window left:
        // bounded by the consumer's own window even when the review cutoff is
        // near or spent, else by the actual run deadline, and one shared
        // transport budget. Subsequent scans and retries never renew that
        // polling window.
        deadline: Math.min(
          input.deadline,
          scanRecoveryBound(initialScan, consumer, input.deadline, input.clock),
        ),
        ...(carrier === undefined ? {} : { currentRun: host.run }),
      });
    } catch (error) {
      // GitHub kept answering a server error: nothing was authenticated or
      // ingested, so every charge stays unresolved exactly as for late
      // artifacts, and the ordinary lifecycle below still runs.
      if (!(error instanceof MatrixArtifactUnavailableError)) throw error;
      console.log(JSON.stringify({
        kind: "sentinel_matrix_artifacts_unavailable",
        scan: initialScan ? "initial" : "own",
        requests: requests.length,
      }));
      break;
    }
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
    // A later scan is bounded by `consumerUntil`, and one that reaches it
    // mid-download refuses the whole run, so it starts only with its whole
    // transport budget still before it: `maxWaitMs: 0`, or any window shorter
    // than that budget, is exactly one authenticated recovery even when that
    // scan consumed a cell.
    if (input.clock.now() + MATRIX_ARTIFACT_RECOVERY_MAX_MS > consumerUntil) {
      break;
    }
    if (progressed) continue;
    // Nothing is left to wait for once every producer this execution planned
    // has been consumed; a settled charge, or an earlier wave's producer still
    // reserved after its run ended, is rehydrated by the ordinary lifecycle
    // and by the next run's first scan, never by spinning here.
    if (own.length === 0) break;
    if (
      input.clock.now() + MATRIX_CONSUMER_POLL_MS +
          MATRIX_ARTIFACT_RECOVERY_MAX_MS > consumerUntil
    ) break;
    await pollWait(MATRIX_CONSUMER_POLL_MS);
  }
  // Missing/unavailable cell artifacts stay charged and unresolved. Reviews and
  // delivery retain the real ordinary lifecycle; implementation never falls back.
  return await runActionsTargetCycles({
    ...input,
    modelStartsEnabled: lifecycleModelStarts,
    externalImplementations: true,
    progressBaseline: input.progressBaseline ?? progressBaseline,
  });
}
