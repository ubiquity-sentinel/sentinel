import { parseHostedNotStartedProofV1 } from "../src/contracts/hosted-supervisor-execution.ts";
import {
  type Attempt,
  CONTROLLER,
  decoder,
  digest,
  encoder,
  type Evidence,
  type Execution,
  execution,
  list,
  object,
  POINTER_PATH,
  positive,
  sha,
  time,
  type Transition,
} from "./telemetry-types.ts";

export function json(row: Evidence): unknown {
  if (row.observation.status !== 200 || !row.body) return null;
  try {
    return JSON.parse(decoder.decode(row.body));
  } catch {
    return null;
  }
}
export function endpoint(row: Evidence): string {
  return row.observation.endpoint.split("?")[0].toLowerCase();
}
export function attemptKey(run: unknown, attempt: unknown): string {
  return `${run}/${attempt}`;
}
export type StateEvidence = {
  value: Record<string, unknown>;
  evidence: string;
  path: string;
};

/** Decode only Git blobs bound by a fetched immutable tree and a fetched release ref. */
export async function states(rows: Evidence[]): Promise<StateEvidence[]> {
  const heads = new Set(
    rows.filter((r) =>
      endpoint(r) === `repos/${CONTROLLER}/git/ref/heads/sentinel-state/release`
    )
      .map((r) => object(object(json(r)).object).sha).filter(sha),
  );
  const bindings = new Map<string, { path: string; evidence: string }>();
  for (const row of rows) {
    const match = endpoint(row).match(/\/git\/trees\/([a-f0-9]{40})$/);
    if (!match || !heads.has(match[1])) continue;
    for (const entry of list(object(json(row)).tree)) {
      if (
        entry.type === "blob" && sha(entry.sha) &&
        typeof entry.path === "string" &&
        (entry.path === POINTER_PATH ||
          /^hostedInstallations\/[a-f0-9]{64}\.json$/.test(entry.path))
      ) {
        bindings.set(entry.sha, { path: entry.path, evidence: row.id });
      }
    }
  }
  const values: StateEvidence[] = [];
  for (const row of rows) {
    const match = endpoint(row).match(/\/git\/blobs\/([a-f0-9]{40})$/);
    const binding = match && bindings.get(match[1]);
    const wrapper = object(json(row));
    if (
      !match || !binding || wrapper.encoding !== "base64" ||
      typeof wrapper.content !== "string" || wrapper.sha !== match[1]
    ) continue;
    try {
      const bytes = Uint8Array.from(
        atob(wrapper.content.replace(/\s/g, "")),
        (c) => c.charCodeAt(0),
      );
      const header = encoder.encode(`blob ${bytes.length}\0`);
      const full = new Uint8Array(header.length + bytes.length);
      full.set(header);
      full.set(bytes, header.length);
      if (await digest(full, "SHA-1") !== match[1]) continue;
      const value = object(JSON.parse(decoder.decode(bytes)));
      if (value.kind === "hosted_installation") {
        if (
          !sha(value.candidateRevision) ||
          value.id !== `installation:${value.candidateRevision}` ||
          binding.path !==
            `hostedInstallations/${await digest(
              encoder.encode(String(value.id)),
            )}.json`
        ) continue;
      } else if (
        value.kind !== "hosted_runtime" || binding.path !== POINTER_PATH ||
        value.id !== `${CONTROLLER}:0:production`
      ) continue;
      values.push({ value, evidence: row.id, path: binding.path });
    } catch {
      /* Malformed/mismatched immutable source remains archived, never promoted to proof. */
    }
  }
  return values;
}

export function inventory(
  rows: Evidence[],
  since: number,
  cutoff: number,
): Map<string, Attempt> {
  const attempts = new Map<string, Attempt>();
  function add(run: Record<string, unknown>, evidence: string) {
    const id = run.id;
    const n = run.run_attempt;
    const created = time(run.created_at);
    if (
      !positive(id) || !positive(n) || !created || created < since ||
      created >= cutoff
    ) return;
    // Missing earlier rerun metadata is explicit, rather than silently losing those attempts.
    for (let a = 1; a <= Math.min(n, 100); a++) {
      const key = attemptKey(id, a);
      if (!attempts.has(key)) {
        attempts.set(key, {
          runId: id,
          attempt: a,
          status: "unknown",
          conclusion: null,
          createdAt: created,
          workflowHeadSha: null,
          execution: null,
          health: "unknown",
          native: false,
          evidence: [],
          productivity: "unknown",
        });
      }
    }
    const key = attemptKey(id, n);
    const old = attempts.get(key)!;
    const concludedAfterCutoff = run.status === "completed" &&
      Number(time(run.updated_at)) > cutoff;
    attempts.set(key, {
      ...old,
      status: concludedAfterCutoff ? "unknown_at_cutoff" : String(run.status),
      conclusion: concludedAfterCutoff
        ? null
        : typeof run.conclusion === "string"
        ? run.conclusion
        : null,
      workflowHeadSha: sha(run.head_sha) ? run.head_sha : null,
      evidence: [...new Set([...old.evidence, evidence])],
    });
  }
  for (const row of rows) {
    const path = endpoint(row);
    if (!path.startsWith(`repos/${CONTROLLER}/actions/`)) continue;
    const value = object(json(row));
    if (path.endsWith("/actions/workflows/supervisor.yml/runs")) {
      for (const run of list(value.workflow_runs)) add(run, row.id);
    } else if (/\/actions\/runs\/\d+\/attempts\/\d+$/.test(path)) {
      add(value, row.id);
    }
  }
  return attempts;
}

function validProof(
  value: unknown,
): { e: Execution; proof: Record<string, unknown> } | null {
  const p = object(value);
  const e = execution(p.execution);
  if (p.outcome === "not_started") {
    try {
      const accepted = parseHostedNotStartedProofV1(value);
      return e ? { e, proof: object(accepted) } : null;
    } catch {
      return null;
    }
  }
  return e && p.repository === CONTROLLER &&
      p.workflowPath === ".github/workflows/supervisor.yml" &&
      p.ref === "refs/heads/sentinel-supervisor" && p.settled === true &&
      positive(p.jobId) &&
      typeof p.logDigest === "string" && /^[a-f0-9]{64}$/.test(p.logDigest) &&
      ["healthy", "failed", "cancelled"].includes(
        String(p.outcome),
      ) && time(p.finishedAt)
    ? { e, proof: p }
    : null;
}

export function transitions(values: StateEvidence[]): Transition[] {
  const found = new Map<string, Transition>();
  for (const { value: v, evidence } of values) {
    if (
      v.kind !== "hosted_installation" || !sha(v.previousRevision) ||
      !positive(v.previousGeneration)
    ) continue;
    const bootstrap = validProof(v.bootstrapProof);
    const retried = validProof(v.retriedBootstrapProof);
    if (
      bootstrap && bootstrap.e.revision === v.candidateRevision &&
      bootstrap.e.generation === v.previousGeneration + 1 &&
      bootstrap.e.id === v.bootstrapExecutionId &&
      ["accepted", "rolled_back"].includes(String(v.phase))
    ) {
      const t: Transition = {
        revision: bootstrap.e.revision,
        generation: bootstrap.e.generation,
        start: retried && retried.e.revision === bootstrap.e.revision &&
            retried.e.generation === bootstrap.e.generation &&
            retried.e.purpose === "bootstrap" &&
            retried.proof.outcome !== "healthy" &&
            retried.e.createdAt < bootstrap.e.createdAt
          ? retried.e.createdAt
          : bootstrap.e.createdAt,
        priorRevision: v.previousRevision,
        priorGeneration: v.previousGeneration,
        kind: "installation",
        evidence,
      };
      found.set(`${t.revision}/${t.generation}/${t.start}`, t);
    }
    const rollback = validProof(v.rollbackProof);
    if (
      rollback && rollback.e.revision === v.previousRevision &&
      rollback.e.generation === v.previousGeneration + 2 &&
      rollback.e.id === v.rollbackExecutionId && v.phase === "rolled_back"
    ) {
      const t: Transition = {
        revision: rollback.e.revision,
        generation: rollback.e.generation,
        start: rollback.e.createdAt,
        priorRevision: String(v.candidateRevision),
        priorGeneration: v.previousGeneration + 1,
        kind: "rollback",
        evidence,
      };
      found.set(`${t.revision}/${t.generation}/${t.start}`, t);
    }
  }
  return [...found.values()].sort((a, b) => a.start - b.start);
}

export async function bindHealth(
  rows: Evidence[],
  state: StateEvidence[],
  attempts: Map<string, Attempt>,
  since: number,
  cutoff: number,
): Promise<string[]> {
  const refusals: string[] = [];
  const conflicts = new Set<string>();
  function bind(
    e: Execution,
    health: Attempt["health"],
    native: boolean,
    source: string[],
    productivity: Attempt["productivity"] = "unknown",
  ) {
    if (e.createdAt < since || e.createdAt >= cutoff) return;
    const key = attemptKey(e.runId, e.runAttempt);
    const old = attempts.get(key) ?? {
      runId: e.runId,
      attempt: e.runAttempt,
      status: "unknown",
      conclusion: null,
      createdAt: e.createdAt,
      workflowHeadSha: null,
      execution: null,
      health: "unknown",
      native: false,
      evidence: [],
      productivity: "unknown",
    };
    if (conflicts.has(key)) return;
    if (
      old.execution &&
      (JSON.stringify(old.execution) !== JSON.stringify(e) ||
        old.health !== "unknown" && old.health !== health)
    ) {
      conflicts.add(key);
      refusals.push(`conflicting native identity/outcome ${key}`);
      attempts.set(key, {
        ...old,
        execution: null,
        health: "unknown",
        native: false,
      });
      return;
    }
    attempts.set(key, {
      ...old,
      execution: e,
      health,
      native: old.native || native,
      evidence: [...new Set([...old.evidence, ...source])],
      productivity: productivity === "unknown"
        ? old.productivity
        : productivity,
    });
  }
  const durable = new Map<
    number,
    { p: Record<string, unknown>; source: string }[]
  >();
  for (const s of state) {
    for (
      const slot of [
        "lastHealthyProof",
        "lastExecutionProof",
        "bootstrapProof",
        "retriedBootstrapProof",
        "previousHealthyProof",
        "rollbackProof",
      ]
    ) {
      const result = validProof(s.value[slot]);
      if (!result || Number(result.proof.finishedAt) > cutoff) continue;
      const { e, proof: p } = result;
      if (positive(p.jobId) && typeof p.logDigest === "string") {
        const proofs = durable.get(p.jobId) ?? [];
        proofs.push({ p, source: s.evidence });
        durable.set(p.jobId, proofs);
      }
      bind(
        e,
        p.outcome === "healthy" && p.startupReady === true
          ? "healthy"
          : p.outcome === "not_started"
          ? "unstarted"
          : p.outcome === "cancelled"
          ? "canceled"
          : "failed",
        false,
        [s.evidence],
      );
    }
  }
  const jobs = new Map<
    number,
    { job: Record<string, unknown>; source: string }
  >();
  for (const row of rows) {
    const path = endpoint(row);
    const match = path.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/);
    const single = path.match(/\/actions\/jobs\/(\d+)$/);
    if (!path.startsWith(`repos/${CONTROLLER}/`)) continue;
    for (
      const job of match
        ? list(object(json(row)).jobs)
        : single
        ? [object(json(row))]
        : []
    ) {
      if (
        positive(job.id) && job.name === "repair" &&
        (!match ||
          job.run_id === Number(match[1]) &&
            job.run_attempt === Number(match[2]))
      ) {
        jobs.set(job.id, { job, source: row.id });
      }
    }
  }
  for (const row of rows) {
    const match = endpoint(row).match(
      /^repos\/ubiquity-sentinel\/sentinel\/actions\/jobs\/(\d+)\/logs$/,
    );
    const bound = match && jobs.get(Number(match[1]));
    if (!bound || !row.body || row.observation.status !== 200) continue;
    const text = decoder.decode(row.body);
    const events: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      if (!line.includes('"kind":"hosted_runtime_')) continue;
      try {
        events.push(object(JSON.parse(line.slice(line.indexOf("{")))));
      } catch { /* retain raw */ }
    }
    const terminal = events.filter((v) => v.kind === "hosted_runtime_terminal");
    const summaries = events.filter((v) => v.kind === "hosted_runtime_summary");
    const t = terminal[0] ?? {};
    const s = summaries[0] ?? {};
    const e = execution(t.execution);
    const j = bound.job;
    const matching = terminal.length === 1 && summaries.length === 1 && e &&
      e.runId === j.run_id &&
      e.runAttempt === j.run_attempt && e.launcherSha === j.head_sha &&
      t.controllerSha === e.revision &&
      s.runtimeSha === e.revision && s.launcherSha === e.launcherSha &&
      s.generation === e.generation &&
      s.purpose === e.purpose && s.runId === e.runId &&
      s.attempt === e.runAttempt && s.outcome === t.outcome &&
      t.settled === true && j.status === "completed" && time(t.finishedAt) &&
      Number(t.finishedAt) <= cutoff;
    if (!matching || !e) {
      refusals.push(`unbound native log ${row.id}`);
      continue;
    }
    const decodedDigest = await digest(encoder.encode(text));
    const proofs = durable.get(Number(j.id)) ?? [];
    if (
      proofs.some(({ p }) =>
        p.logDigest !== decodedDigest ||
        JSON.stringify(execution(p.execution)) !== JSON.stringify(e)
      )
    ) {
      refusals.push(`durable/log mismatch ${row.id}`);
      const key = attemptKey(e.runId, e.runAttempt);
      conflicts.add(key);
      const old = attempts.get(key);
      if (old) {
        attempts.set(key, {
          ...old,
          execution: null,
          health: "unknown",
          native: false,
        });
      }
      continue;
    }
    const health = t.outcome === "healthy" && t.startupReady === true &&
        j.conclusion === "success"
      ? "healthy"
      : t.outcome === "failed"
      ? "failed"
      : t.outcome === "not_started"
      ? "unstarted"
      : t.outcome === "cancelled"
      ? "canceled"
      : "unknown";
    // No touched PR or admitted work proves an idle summary; it does not prove a merge count.
    const productivity =
      s.admittedWorkCount === 0 && Array.isArray(s.prsTouched) &&
        s.prsTouched.length === 0
        ? "idle"
        : positive(s.admittedWorkCount)
        ? "active"
        : "unknown";
    bind(e, health, true, [
      bound.source,
      row.id,
      ...proofs.map((p) => p.source),
    ], productivity);
  }
  return refusals;
}
