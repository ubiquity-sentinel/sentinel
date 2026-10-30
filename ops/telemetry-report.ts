import type { Archive } from "./telemetry-store.ts";
import {
  bindHealth,
  endpoint,
  inventory,
  json,
  states,
  transitions,
} from "./telemetry-proof.ts";
import {
  type Evidence,
  type Interval,
  iso,
  list,
  object,
  positive,
  sha,
  TARGETS,
  time,
} from "./telemetry-types.ts";

type Merge = {
  repository: string;
  pullRequest: number;
  mergeSha: string;
  mergedAt: number;
  origin: "owner_manual" | "unknown";
  evidence: string[];
};
function merges(rows: Evidence[], since: number, cutoff: number) {
  const found = new Map<string, Merge>();
  const detail = new Map<
    string,
    { value: Record<string, unknown>; id: string }
  >();
  for (const row of rows) {
    const match = endpoint(row).match(/^repos\/(.+\/[^/]+)\/pulls\/(\d+)$/);
    if (match && json(row)) {
      detail.set(`${match[1]}/${match[2]}`, {
        value: object(json(row)),
        id: row.id,
      });
    }
  }
  const coverage: Record<
    string,
    { complete: boolean; through: string | null; evidence: string[] }
  > = {};
  for (const repository of TARGETS) {
    const pages = new Map<number, Evidence>();
    for (const row of rows) {
      if (
        endpoint(row) !== `repos/${repository}/pulls` ||
        !Array.isArray(json(row))
      ) continue;
      const query = new URLSearchParams(row.observation.endpoint.split("?")[1]);
      if (
        query.get("state") !== "closed" || query.get("sort") !== "updated" ||
        query.get("direction") !== "desc" || query.get("per_page") !== "100"
      ) continue;
      const page = Number(query.get("page") ?? 1);
      if (positive(page)) pages.set(page, row);
    }
    const sources: string[] = [];
    let complete = false;
    let throughTime = Infinity;
    for (let page = 1; pages.has(page); page++) {
      const row = pages.get(page)!;
      const pulls = list(json(row));
      sources.push(row.id);
      const observed = row.observation.observedAt;
      throughTime = Math.min(throughTime, Number(time(observed)));
      for (const p of pulls) {
        const mergedAt = time(p.merged_at);
        if (
          !positive(p.number) || !sha(p.merge_commit_sha) ||
          mergedAt === null || mergedAt < since || mergedAt >= cutoff
        ) continue;
        const key = `${repository}/${p.number}/${p.merge_commit_sha}`;
        const more = detail.get(`${repository}/${p.number}`);
        // A bot/App actor alone proves no autonomous origin. A human merger is a manual observation.
        const actor = object((more?.value ?? p).merged_by);
        const manual = actor.type === "User";
        found.set(key, {
          repository,
          pullRequest: p.number,
          mergeSha: p.merge_commit_sha,
          mergedAt,
          origin: manual ? "owner_manual" : "unknown",
          evidence: [row.id, ...(more ? [more.id] : [])],
        });
      }
      const oldest = Math.min(
        ...pulls.map((p) => time(p.updated_at) ?? Infinity),
      );
      if (pulls.length < 100 || oldest < since) {
        complete = throughTime >= cutoff;
        break;
      }
    }
    coverage[repository] = {
      complete,
      through: Number.isFinite(throughTime) ? iso(throughTime) : null,
      evidence: sources,
    };
  }
  return { values: [...found.values()], coverage };
}

export async function makeReport(
  archive: Archive,
  since: number,
  cutoff: number,
) {
  const evidence = await archive.evidence();
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
  const merge = merges(evidence, since, cutoff);
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
  const sessions = await archive.sessions();
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
    "Runtime SHA | generation | production h | bound runs | good ordinary SAMPLE | native logs | merges/manual/unclassified | autonomous/h | interval UTC",
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
    "Percentages cover bound ordinary samples only. Bootstrap/rollback/verification, idle counts and source/clock provenance remain separate in JSON.",
  );
  return lines.join("\n");
}
