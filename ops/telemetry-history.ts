import { json } from "./telemetry-proof.ts";
import {
  CONTROLLER,
  digest,
  encoder,
  type Evidence,
  object,
  sha,
  type SyncOptions,
  time,
} from "./telemetry-types.ts";

export function decodeState(row: Evidence | null): Record<string, unknown> {
  const value = row && object(json(row));
  try {
    return value && typeof value.content === "string"
      ? object(JSON.parse(atob(value.content.replace(/\s/g, ""))))
      : {};
  } catch {
    return {};
  }
}

/** Normal SHA chain; generation-gap recovery reads at most eight missing snapshot journals. */
export async function collectJournals(
  pointer: Record<string, unknown>,
  entries: Record<string, unknown>[],
  rows: Evidence[],
  get: (path: string, immutable?: boolean) => Promise<Evidence | null>,
  options: SyncOptions,
  notes: string[],
) {
  const base = `repos/${CONTROLLER}`;
  let missing = 0;
  const cached = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (/\/git\/blobs\//.test(row.observation.endpoint)) {
      const value = decodeState(row);
      if (
        value.kind === "hosted_installation" && sha(value.candidateRevision)
      ) cached.set(value.candidateRevision, value);
    }
  }
  async function read(revision: unknown) {
    if (!sha(revision)) return null;
    const path = `hostedInstallations/${await digest(
      encoder.encode(`installation:${revision}`),
    )}.json`;
    const entry = entries.find((e) => e.path === path);
    if (!sha(entry?.sha)) return null;
    const uri = `${base}/git/blobs/${entry.sha}`;
    if (
      !rows.some((r) =>
        r.observation.endpoint === uri && r.observation.status === 200
      )
    ) {
      if (missing >= 8) {
        notes.push("journal pass reached eight missing snapshot blobs");
        return null;
      }
      missing++;
    }
    const value = decodeState(await get(uri, true));
    if (value.kind !== "hosted_installation") return null;
    cached.set(revision, value);
    return value;
  }
  function restores(
    value: Record<string, unknown>,
    revision: unknown,
    generation: unknown,
  ) {
    const e = object(object(value.rollbackProof).execution);
    return value.phase === "rolled_back" &&
      value.previousRevision === revision &&
      e.revision === revision && e.generation === generation;
  }
  async function resolve(
    revision: unknown,
    generation: unknown,
    hints: Record<string, unknown>[],
  ) {
    const journal = await read(revision);
    const bootstrap = object(object(journal?.bootstrapProof).execution);
    if (
      journal && bootstrap.revision === revision &&
      bootstrap.generation === generation
    ) return journal;
    let restored = [...cached.values()].find((v) =>
      restores(v, revision, generation)
    );
    for (const hint of hints) {
      if (!restored && sha(hint.launcherSha)) {
        const candidate = await read(hint.launcherSha);
        if (candidate && restores(candidate, revision, generation)) {
          restored = candidate;
        }
      }
    }
    // Resolve the exact generation at every edge, under one shared missing-blob budget.
    for (const entry of entries) {
      if (restored || missing >= 8) break;
      if (
        typeof entry.path !== "string" ||
        !entry.path.startsWith("hostedInstallations/") || !sha(entry.sha)
      ) continue;
      const uri = base + "/git/blobs/" + entry.sha;
      if (
        rows.some((r) =>
          r.observation.endpoint === uri && r.observation.status === 200
        )
      ) continue;
      missing++;
      const candidate = decodeState(await get(uri, true));
      if (
        candidate.kind === "hosted_installation" &&
        sha(candidate.candidateRevision)
      ) cached.set(candidate.candidateRevision, candidate);
      if (restores(candidate, revision, generation)) restored = candidate;
    }
    if (!restored) {
      notes.push(
        "no journal proves " + revision + "/g" + generation +
          "; predecessor interval remains unknown",
      );
    }
    return restored ?? null;
  }
  let revision = pointer.activeRevision, generation = pointer.generation;
  let hints = ["execution", "lastExecutionProof", "lastHealthyProof"].map(
    (slot) =>
      slot === "execution"
        ? object(pointer[slot])
        : object(object(pointer[slot]).execution),
  );
  const seen = new Set<string>();
  while (
    sha(revision) && Number.isSafeInteger(generation) &&
    Number(generation) > 0 && seen.size < 128
  ) {
    const key = revision + "/" + generation;
    if (seen.has(key)) break;
    seen.add(key);
    const journal = await resolve(revision, generation, hints);
    if (!journal) break;
    const rollback = object(object(journal.rollbackProof).execution);
    const first =
      rollback.revision === revision && rollback.generation === generation
        ? rollback
        : object(
          object(journal.retriedBootstrapProof ?? journal.bootstrapProof)
            .execution,
        );
    const began = time(first.createdAt);
    if (began !== null && began < options.since) break;
    revision = journal.previousRevision;
    generation = journal.previousGeneration;
    hints = [object(object(journal.previousHealthyProof).execution)];
  }
}
