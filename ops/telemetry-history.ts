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
  function restores(value: Record<string, unknown>) {
    const e = object(object(value.rollbackProof).execution);
    return value.phase === "rolled_back" &&
      value.previousRevision === pointer.activeRevision &&
      e.revision === pointer.activeRevision &&
      e.generation === pointer.generation;
  }
  let journal = await read(pointer.activeRevision);
  if (
    journal &&
    object(object(journal.bootstrapProof).execution).generation !==
      pointer.generation
  ) {
    let restored = [...cached.values()].find(restores);
    for (
      const slot of ["execution", "lastExecutionProof", "lastHealthyProof"]
    ) {
      const value = object(pointer[slot]);
      const e = slot === "execution" ? value : object(value.execution);
      if (!restored && sha(e.launcherSha)) {
        const candidate = await read(e.launcherSha);
        if (candidate && restores(candidate)) restored = candidate;
      }
    }
    // A plain pointer has no inverse journal index. Bound this exceptional snapshot search,
    // retain fetched blobs, and resume missing entries on a later explicit invocation.
    for (const entry of entries) {
      if (restored || missing >= 8) break;
      if (
        typeof entry.path !== "string" ||
        !entry.path.startsWith("hostedInstallations/") || !sha(entry.sha)
      ) continue;
      const uri = `${base}/git/blobs/${entry.sha}`;
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
      if (restores(candidate)) restored = candidate;
    }
    if (restored) journal = restored;
    else {notes.push(
        "current generation has no discovered rollback journal; interval remains unknown",
      );}
  }
  const seen = new Set<string>();
  while (
    journal && sha(journal.candidateRevision) &&
    !seen.has(journal.candidateRevision) && seen.size < 128
  ) {
    seen.add(journal.candidateRevision);
    const first = object(
      object(journal.retriedBootstrapProof ?? journal.bootstrapProof).execution,
    );
    const began = time(first.createdAt);
    if (began !== null && began < options.since) break;
    journal = await read(journal.previousRevision);
  }
}
