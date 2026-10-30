import { mergeObservations } from "./telemetry-merges.ts";
import type { Archive } from "./telemetry-store.ts";
import {
  bindHealth,
  inventory,
  states,
  transitions,
} from "./telemetry-proof.ts";
import { type Interval, iso, object, TARGETS } from "./telemetry-types.ts";

export async function makeReport(
  archive: Archive,
  since: number,
  cutoff: number,
) {
  const evidence = await archive.evidence();
  const sessions = await archive.sessions();
  const state = await states(evidence);
  const attempts = inventory(evidence, since, cutoff);
  const refusals = await bindHealth(evidence, state, attempts, since, cutoff);
  const movements = transitions(state).filter((t) => t.start < cutoff);
  const pointers = state.filter((s) =>
    s.value.kind === "hosted_runtime" && Number(s.value.updatedAt) <= cutoff
  )
    .sort((a, b) => Number(a.value.updatedAt) - Number(b.value.updatedAt));
  const pointer = pointers.at(-1);
  const intervals: Interval[] = movements.map((t, i) => {
    const next = movements[i + 1];
    const bound = next && next.priorRevision === t.revision &&
      next.priorGeneration === t.generation;
    const open = !next && pointer?.value.activeRevision === t.revision &&
      pointer.value.generation === t.generation;
    const end = bound ? next.start : null;
    const clippedStart = Math.max(t.start, since);
    const clippedEnd = end === null
      ? open ? cutoff : null
      : Math.min(end, cutoff);
    return {
      ...t,
      end,
      clippedStart,
      clippedEnd,
      hours: clippedEnd === null
        ? null
        : Math.max(0, clippedEnd - clippedStart) / 3_600_000,
      open,
      endEvidence: bound ? next.evidence : open ? pointer!.evidence : null,
    };
  }).filter((i) => i.clippedEnd === null || i.clippedEnd > since);
  const merge = mergeObservations(evidence, sessions, since, cutoff);
  const allMergesComplete = TARGETS.every((t) => merge.coverage[t].complete);
  const allAttempts = [...attempts.values()];
  const installations = state.filter((s) =>
    s.value.kind === "hosted_installation"
  ).map((s) => ({
    candidateRevision: s.value.candidateRevision,
    phase: s.value.phase,
    previousRevision: s.value.previousRevision,
    previousGeneration: s.value.previousGeneration,
    createdAt: s.value.createdAt,
    updatedAt: s.value.updatedAt,
    bootstrapProof: s.value.bootstrapProof ?? null,
    rollbackProof: s.value.rollbackProof ?? null,
    evidence: s.evidence,
  }));
  const revisions = new Set([
    ...intervals.map((i) => i.revision),
    ...installations.map((i) => String(i.candidateRevision)),
    ...allAttempts.flatMap((a) => a.execution ? [a.execution.revision] : []),
  ]);
  const versions = [...revisions].map((revision) => {
    const own = allAttempts.filter((a) => a.execution?.revision === revision);
    const ordinary = own.filter((a) => a.execution?.purpose === "ordinary");
    const completed = ordinary.filter((a) =>
      a.health === "healthy" || a.health === "failed"
    );
    const healthy = completed.filter((a) => a.health === "healthy").length;
    const production = intervals.filter((i) => i.revision === revision);
    const hours = production.length && production.every((i) => i.hours !== null)
      ? production.reduce((n, i) => n + i.hours!, 0)
      : null;
    const observedMerges = merge.values.filter((m) =>
      production.some((i) =>
        i.clippedEnd !== null && m.mergedAt >= i.clippedStart &&
        m.mergedAt < i.clippedEnd
      )
    );
    const manual = observedMerges.filter((m) =>
      m.origin === "owner_manual"
    ).length;
    const unknown = observedMerges.length - manual;
    const autonomous = allMergesComplete && unknown === 0 && hours !== null
      ? 0
      : null;
    return {
      runtimeSha: revision,
      productionHours: hours,
      intervals: production.map((i) => ({
        ...i,
        start: iso(i.start),
        end: i.end === null ? null : iso(i.end),
        clippedStart: iso(i.clippedStart),
        clippedEnd: i.clippedEnd === null ? null : iso(i.clippedEnd),
        boundaryQuality:
          "journal application transition clock; not measured remote CAS completion",
      })),
      runCount: own.length,
      ordinary: {
        healthy,
        completed: completed.length,
        goodPercent: completed.length ? 100 * healthy / completed.length : null,
        nativeLogCovered: completed.filter((a) => a.native).length,
        nativeCoveragePercent: completed.length
          ? 100 * completed.filter((a) => a.native).length / completed.length
          : null,
        failed: completed.length - healthy,
        canceled: ordinary.filter((a) => a.health === "canceled").length,
        unstarted: ordinary.filter((a) => a.health === "unstarted").length,
        pendingOrUnknown: ordinary.filter((a) => a.health === "unknown").length,
        idle: ordinary.filter((a) => a.productivity === "idle").length,
      },
      otherPurposes: Object.fromEntries([
        ...new Set(
          own.map((a) => a.execution!.purpose).filter((p) => p !== "ordinary"),
        ),
      ].map((purpose) => [
        purpose,
        own.filter((a) => a.execution?.purpose === purpose).length,
      ])),
      velocity: {
        observedMerges: observedMerges.length,
        observedMergesPerHour: hours ? observedMerges.length / hours : null,
        observedVelocityCoverage: allMergesComplete
          ? "complete observed merge lists"
          : "partial observed merge lists; rate is a lower bound",
        ownerManualMerges: manual,
        unclassifiedMerges: unknown,
        newAcceptedAutonomousMerges: autonomous,
        autonomousMergesPerHour: autonomous === null || !hours
          ? null
          : autonomous / hours,
        acceptedDeliveryCount: null,
        provenance:
          "Zero requires complete merge lists and no unclassified merges; actor identity never proves autonomy. Existing receipts/progress do not prove a fresh accepted effect.",
        merges: observedMerges,
      },
      attempts: own,
    };
  }).sort((a, b) =>
    (b.intervals.at(-1)?.generation ?? 0) -
    (a.intervals.at(-1)?.generation ?? 0)
  );
  const currentJournal = state.filter((s) =>
    s.value.kind === "hosted_installation" &&
    s.value.candidateRevision === pointer?.value.activeRevision &&
    object(s.value.bootstrapProof).execution &&
    object(object(s.value.bootstrapProof).execution).generation ===
      pointer?.value.generation
  ).at(-1);
  const unassigned = allAttempts.filter((a) => !a.execution);
  const completedActions = allAttempts.filter((a) => a.status === "completed");
  const report = {
    schema: "sentinel_local_telemetry_v1",
    generatedAt: new Date().toISOString(),
    observedThrough: iso(cutoff),
    since: iso(since),
    archive: archive.root,
    current: pointer
      ? {
        runtimeSha: pointer.value.activeRevision,
        generation: pointer.value.generation,
        evidence: pointer.evidence,
        pointerObservedAt: pointer.value.updatedAt,
        rollbackPrior: currentJournal
          ? {
            revision: currentJournal.value.previousRevision,
            generation: currentJournal.value.previousGeneration,
            evidence: currentJournal.evidence,
          }
          : null,
      }
      : null,
    versions,
    installations,
    workflowOutcomes: {
      attempts: allAttempts.length,
      completed: completedActions.length,
      successes:
        completedActions.filter((a) => a.conclusion === "success").length,
      failures:
        completedActions.filter((a) => a.conclusion === "failure").length,
      canceled:
        completedActions.filter((a) => a.conclusion === "cancelled").length,
      pendingOrUnknown: allAttempts.length - completedActions.length,
    },
    coverage: {
      observations: evidence.length,
      unassignedAttempts: unassigned.length,
      unassignedCompletedAttempts:
        unassigned.filter((a) => a.status === "completed").length,
      nativeRefusals: refusals,
      mergeLists: merge.coverage,
      sessions,
      errors: evidence.filter((e) => e.observation.status !== 200).map((e) => ({
        evidence: e.id,
        endpoint: e.observation.endpoint,
        observedAt: e.observation.observedAt,
        status: e.observation.status,
        error: e.observation.error,
      })),
    },
    unassignedAttempts: unassigned,
    limits: [
      "Health is among bound ordinary completions; unassigned attempts are not assigned by workflow head or time.",
      "No new runtime merge producer was added; positive fresh autonomous acceptance is unknown without source-bound provenance.",
      "Production exposure requires journal boundaries and an observed current pointer; missing history remains unknown.",
      "No automatic ranking, deletion or rollback. Healthy idle executions do not establish productive delivery.",
    ],
  };
  const path = await archive.saveReport(report, evidence);
  return { report, path };
}

export function renderReport(
  result: Awaited<ReturnType<typeof makeReport>>,
): string {
  const { report: r, path } = result;
  const lines = [
    `Sentinel telemetry ${r.since} → ${r.observedThrough}`,
    `Saved report: ${path}`,
    `Current runtime: ${r.current?.runtimeSha ?? "unknown"} / generation ${
      r.current?.generation ?? "unknown"
    }`,
    "",
    "Runtime SHA | generation | production h | bound runs | good ordinary SAMPLE | native logs | merges/manual/unclassified | observed/h | autonomous/h | interval UTC",
  ];
  const shown = r.versions.filter((v) => v.intervals.length > 0);
  for (const v of shown) {
    const intervals = v.intervals.map((i) =>
      `g${i.generation} ${i.clippedStart}→${i.clippedEnd ?? "unknown"}${
        i.open ? " (open)" : ""
      }`
    ).join("; ");
    lines.push(
      `${v.runtimeSha} | ${v.intervals.map((i) => i.generation).join(",")} | ${
        v.productionHours?.toFixed(3) ?? "unknown"
      } | ${v.runCount} | ${v.ordinary.healthy}/${v.ordinary.completed} (${
        v.ordinary.goodPercent?.toFixed(1) ?? "unknown"
      }%) | ${v.ordinary.nativeLogCovered}/${v.ordinary.completed} | ${v.velocity.observedMerges}/${v.velocity.ownerManualMerges}/${v.velocity.unclassifiedMerges} | ${
        v.velocity.observedMergesPerHour?.toFixed(3) ?? "unknown"
      } | ${
        v.velocity.autonomousMergesPerHour?.toFixed(3) ?? "unknown"
      } | ${intervals}`,
    );
  }
  lines.push(
    `${
      r.versions.length - shown.length
    } additional versions have journal/proof evidence without a bound production interval; complete details remain in JSON.`,
  );
  lines.push(
    "",
    `Actions outcomes (separate): ${r.workflowOutcomes.successes}/${r.workflowOutcomes.completed} success; ${r.workflowOutcomes.failures} failed; ${r.workflowOutcomes.canceled} canceled; ${r.workflowOutcomes.pendingOrUnknown} pending/unknown.`,
  );
  lines.push(
    `Unassigned: ${r.coverage.unassignedAttempts} attempts (${r.coverage.unassignedCompletedAttempts} completed); native refusals ${r.coverage.nativeRefusals.length}; archived API errors ${r.coverage.errors.length}.`,
  );
  if (r.current?.rollbackPrior) {
    lines.push(
      `Recorded prior: ${r.current.rollbackPrior.revision} / g${r.current.rollbackPrior.generation}; no rollback selected.`,
    );
  }
  lines.push(
    "Percentages cover bound ordinary samples only. Observed/h is a lower bound when merge coverage is incomplete; it is separate from accepted autonomous velocity. Other purposes and source/clock provenance remain in JSON.",
  );
  return lines.join("\n");
}
