// Deterministic release monitoring stage; state stays with the controller context.
import type { PortResultV1 } from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import {
  type AcceptanceResultV1,
  parseReleaseRecordV1,
  type ReleaseRecordV1,
} from "../contracts/release.ts";
import type { MetricsSampleV1 } from "../contracts/shared.ts";
import {
  RELEASE_EXPECTED_SAMPLES,
  RELEASE_MAX_SLOTS_PER_RUN,
  RELEASE_SAMPLE_INTERVAL_MS,
} from "./config.ts";
import {
  evaluateAcceptance,
  nextAlignedWindowStart,
  slotMissed,
} from "./acceptance.ts";
import {
  buildDiagnosticAcceptance,
  completeSample,
  type LoadedContextV1,
  makeError,
  type ReleaseCycleResultV1,
  sameIdentity,
} from "./controller-common.ts";
import type { ReleaseControllerState } from "./controller-state.ts";
import {
  finalizeRolledBack,
  persistRollbackIntent,
  rollbackRecord,
} from "./controller-rollback.ts";

export async function monitorRecord(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  if (record.intent !== null && record.intent.action === "rollback") {
    return rollbackRecord(state, record, context);
  }
  if (record.monitoring.startedAt === null) {
    return state.blocked(record.id, "monitoring window has no start");
  }

  // Managed identity observation every tick. A healthy managed sample is
  // body marker + managed headers + exact identity (port-level `healthy`);
  // any missing piece is an interrupted monitor (reset, never fabricate) —
  // an observable mismatch is handled below; degraded/unhealthy evidence
  // never advances the window.
  const observation = await state.observeManaged();
  if (
    observation.status === "error" ||
    observation.sample.identity === null ||
    observation.sample.status !== "healthy"
  ) {
    return restartMonitor(state, record, context);
  }
  const identity = observation.sample.identity;
  if (!sameIdentity(identity, record.candidate.identity)) {
    if (sameIdentity(identity, record.prior.identity)) {
      // The candidate was never/again not current: already restored.
      return finalizeRolledBack(state, record, context, {
        action: "rollback",
        ok: true,
        statusCode: null,
        observedIdentity: record.prior.identity,
        observedDomain: state.target.acceptance.domain,
        at: state.clock.now(),
        detail: "deployment already served the prior identity",
      });
    }
    return state.blocked(
      record.id,
      "candidate ownership conflicts with an unrelated deployment",
    );
  }

  // Custom-domain probe after the managed identity passed. 200 with exact
  // identity passes; 200 mismatch is a hard identity failure; a VERIFIED
  // Cloudflare 403 challenge warns only; every other outcome (unverified
  // 403, other non-200, unobservable gateway) blocks acceptance — custom
  // delivery can never be accepted while the gateway cannot be verified.
  const warnings: string[] = [];
  const custom = await state.probeCustom(record.candidate.identity);
  if (custom?.status === "hard-fail") {
    return persistRollbackIntent(state, record, context, warnings);
  }
  if (custom?.status === "warned") warnings.push(...custom.warnings);
  if (custom?.status === "blocked") {
    return state.blocked(record.id, custom.detail);
  }

  // Candidate window slots, strictly from persisted state. A slot is due
  // only after its own window, the following adjacent window, and the
  // source lag have elapsed, so a boundary-spanning request can be joined
  // before the slot is persisted. Every slot keeps its exact persisted
  // window. When the observation is late by more than one interval beyond
  // that safe point (an unobserved monitoring gap), continuity restarts:
  // historical slots are never accepted as if sampled while the monitor was
  // absent. A slot whose telemetry is incomplete/unreadable is likewise an
  // interrupted monitor and is never reconstructed.
  const startedAt = record.monitoring.startedAt;
  const now = state.clock.now();
  const collected = record.monitoring.samples;
  const safeObservedAt = now - RELEASE_SAMPLE_INTERVAL_MS;
  const dueSlots = Math.floor(
    (safeObservedAt - state.target.logsLagMs - startedAt) /
      RELEASE_SAMPLE_INTERVAL_MS,
  ) - collected;
  if (dueSlots <= 0) {
    return portOk({
      status: "waiting",
      detail: "next sample slot is not due",
      warnings,
    });
  }
  if (
    slotMissed(
      startedAt,
      RELEASE_SAMPLE_INTERVAL_MS,
      collected,
      safeObservedAt,
      state.target.logsLagMs,
    )
  ) {
    return restartMonitor(state, record, context);
  }

  const baselineStart = record.prior.verifiedHealthyAt -
    state.policy.baselineWindowMs;
  const baseline = [...(record.acceptance?.baseline ?? [])];
  const samples: MetricsSampleV1[] = [...(record.acceptance?.samples ?? [])];
  // The baseline cap applies to this invocation, not to the accumulated
  // persisted baseline. A run with several overdue candidate slots must not
  // bypass the per-run sampling bound through the outer loop.
  let baselineCollectedThisRun = 0;
  for (let i = 0; i < dueSlots; i++) {
    const slotIndex = collected + i;
    const windowStart = startedAt + slotIndex * RELEASE_SAMPLE_INTERVAL_MS;
    const windowEnd = windowStart + RELEASE_SAMPLE_INTERVAL_MS;
    const sample = await state.deno.sampleMetrics({
      baseUrl: state.target.managedBaseUrl,
      metricsPath: state.target.acceptance.metricsPath,
      identity: record.candidate.identity,
      windowStart,
      windowEnd,
      domain: state.target.acceptance.domain,
    });
    if (!sample.ok || !completeSample(sample.value)) {
      // Unreadable/missing telemetry in a window slot is an interrupted
      // monitor: restart, never reconstruct.
      return restartMonitor(state, record, context);
    }
    samples.push(sample.value);
    // Historical baseline slots for the recorded prior (bounded per run);
    // an unreadable baseline slot is re-queried on a later run, never
    // reconstructed.
    while (
      baseline.length < state.policy.baselineWindowMs /
          RELEASE_SAMPLE_INTERVAL_MS &&
      baselineCollectedThisRun < RELEASE_MAX_SLOTS_PER_RUN
    ) {
      const slotIndexB = baseline.length;
      const windowStartB = baselineStart +
        slotIndexB * RELEASE_SAMPLE_INTERVAL_MS;
      const windowEndB = windowStartB + RELEASE_SAMPLE_INTERVAL_MS;
      if (windowEndB + state.target.logsLagMs > now) break;
      const baselineSample = await state.deno.sampleMetrics({
        baseUrl: state.target.managedBaseUrl,
        metricsPath: state.target.acceptance.metricsPath,
        identity: record.prior.identity,
        windowStart: windowStartB,
        windowEnd: windowEndB,
        domain: state.target.acceptance.domain,
      });
      if (!baselineSample.ok || !completeSample(baselineSample.value)) break;
      baseline.push(baselineSample.value);
      baselineCollectedThisRun++;
    }
  }
  if (baseline.length === 0 && samples.length >= 1) {
    // Candidate telemetry was observed but no baseline evidence for the
    // recorded prior exists: an acceptance document cannot be constructed
    // (the frozen parser requires baseline evidence), so the missing
    // baseline is a persisted explicit insufficient-evidence failure —
    // never a thrown exception, never a fabricated baseline.
    return failBaselineInsufficient(state, record, context, warnings);
  }
  // One durable write per run: the run's slots (and the completed baseline
  // evidence) are persisted together; a crashed run simply restarts its
  // window from persisted state instead of reconstructing anything.
  const latest = parseReleaseRecordV1({
    ...record,
    monitoring: {
      startedAt,
      samples: collected + dueSlots,
      continuous: true,
      lastSampleAt: now,
    },
    acceptance: buildDiagnosticAcceptance(
      record.candidate.identity,
      state.policy,
      baseline,
      samples,
    ),
    updatedAt: now,
  });
  const write = await state.writeSnapshot(context, latest);
  if (!write) {
    return portOk({ status: "conflict", recordId: record.id, warnings: [] });
  }

  if (latest.monitoring.samples >= RELEASE_EXPECTED_SAMPLES) {
    return evaluateWindow(state, latest, context, warnings);
  }
  return portOk({
    status: "persisted",
    recordId: record.id,
    phase: "monitoring",
    warnings,
  });
}

export function restartMonitor(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const startedAt = nextAlignedWindowStart(
    RELEASE_SAMPLE_INTERVAL_MS,
    state.clock.now(),
  );
  const updated = parseReleaseRecordV1({
    ...record,
    monitoring: {
      startedAt,
      samples: 0,
      continuous: true,
      lastSampleAt: null,
    },
    acceptance: null,
    updatedAt: state.clock.now(),
  });
  return state.persistAndReport(updated, context, "monitoring");
}

export async function evaluateWindow(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
  warnings: string[],
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const acceptance = record.acceptance;
  if (acceptance === null || acceptance.samples.length < 1) {
    return restartMonitor(state, record, context);
  }
  const evaluation = evaluateAcceptance(
    state.policy,
    acceptance.baseline,
    acceptance.samples,
  );
  if (evaluation.passed) {
    const finalAcceptance: AcceptanceResultV1 = {
      ...acceptance,
      continuous: true,
      thresholdResults: evaluation.thresholds,
      passed: true,
    };
    const accepted = parseReleaseRecordV1({
      ...record,
      phase: "accepted",
      observed: {
        identity: record.candidate.identity,
        domain: state.target.acceptance.domain,
        verified: true,
        at: state.clock.now(),
      },
      monitoring: { ...record.monitoring, continuous: true },
      acceptance: finalAcceptance,
      updatedAt: state.clock.now(),
    });
    const write = await state.writeSnapshot(context, accepted);
    if (!write) {
      return portOk({
        status: "conflict",
        recordId: record.id,
        warnings: [],
      });
    }
    return portOk({
      status: "advanced",
      recordId: record.id,
      phase: "accepted",
      warnings: [],
    });
  }
  if (evaluation.objectiveFailure) {
    return persistRollbackIntent(state, record, context, warnings);
  }
  return failInsufficient(state, record, context, evaluation, warnings);
}

export async function failInsufficient(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
  evaluation: ReturnType<typeof evaluateAcceptance>,
  warnings: string[],
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const acceptance = record.acceptance;
  const finalAcceptance: AcceptanceResultV1 | null = acceptance === null
    ? null
    : {
      ...acceptance,
      continuous: true,
      thresholdResults: evaluation.thresholds,
      passed: false,
    };
  const failed = parseReleaseRecordV1({
    ...record,
    phase: "failed",
    acceptance: finalAcceptance,
    receipts: {
      ...record.receipts,
      error: makeError(state.clock.now(), "acceptance_insufficient"),
    },
    updatedAt: state.clock.now(),
  });
  const write = await state.writeSnapshot(context, failed);
  if (!write) {
    return portOk({ status: "conflict", recordId: record.id, warnings: [] });
  }
  return portOk({
    status: "advanced",
    recordId: record.id,
    phase: "failed",
    warnings,
  });
}

export async function failBaselineInsufficient(
  state: ReleaseControllerState,
  record: ReleaseRecordV1,
  context: LoadedContextV1,
  warnings: string[],
): Promise<PortResultV1<ReleaseCycleResultV1>> {
  const failed = parseReleaseRecordV1({
    ...record,
    phase: "failed",
    acceptance: null,
    receipts: {
      ...record.receipts,
      error: makeError(state.clock.now(), "acceptance_insufficient"),
    },
    updatedAt: state.clock.now(),
  });
  const write = await state.writeSnapshot(context, failed);
  if (!write) {
    return portOk({ status: "conflict", recordId: record.id, warnings: [] });
  }
  return portOk({
    status: "advanced",
    recordId: record.id,
    phase: "failed",
    warnings,
  });
}
