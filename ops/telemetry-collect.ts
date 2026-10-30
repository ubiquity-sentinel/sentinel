import { type Archive, safeError } from "./telemetry-store.ts";
import { allowedEndpoint } from "./telemetry-import.ts";
import { inventory, json } from "./telemetry-proof.ts";
import {
  type Api,
  CONTROLLER,
  type Coverage,
  decoder,
  digest,
  encoder,
  type Evidence,
  iso,
  list,
  object,
  POINTER_PATH,
  positive,
  sha,
  type SyncOptions,
  TARGETS,
  time,
} from "./telemetry-types.ts";

/** Existing gh authentication stays inside gh; never inspect its token or configuration. */
export const ghApi: Api = async (endpoint, timeoutMs) => {
  if (!allowedEndpoint(endpoint)) {
    throw new Error("Refused non-telemetry endpoint");
  }
  const child = new Deno.Command("gh", {
    args: ["api", "--method", "GET", endpoint],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timeout = false;
  let kill: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timeout = true;
    try {
      child.kill("SIGTERM");
    } catch { /* already settled */ }
    kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* settled */ }
    }, 1000);
  }, timeoutMs);
  try {
    const result = await child.output();
    const error = decoder.decode(result.stderr);
    const status = timeout
      ? 0
      : result.success
      ? 200
      : Number(error.match(/HTTP\s+(\d{3})/)?.[1] ?? 0);
    return {
      status,
      body: result.success && !timeout ? result.stdout : new Uint8Array(),
      error: status === 200 ? undefined : safeError(status, error),
    };
  } finally {
    clearTimeout(timer);
    if (kill !== undefined) clearTimeout(kill);
  }
};

export function apiPath(
  path: string,
  params: Record<string, string | number> = {},
): string {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  query.sort();
  return `${path}${query.size ? `?${query}` : ""}`;
}
function decoded(row: Evidence | null): Record<string, unknown> {
  const value = row && object(json(row));
  try {
    return value && typeof value.content === "string"
      ? object(JSON.parse(atob(value.content.replace(/\s/g, ""))))
      : {};
  } catch {
    return {};
  }
}

export async function syncArchive(
  archive: Archive,
  options: SyncOptions,
  api: Api = ghApi,
): Promise<Coverage> {
  const started = performance.now();
  const coverage: Coverage = {
    schema: 1,
    observedAt: new Date().toISOString(),
    since: iso(options.since),
    cutoff: iso(options.cutoff),
    reads: 0,
    maxReads: options.maxReads,
    stopped: "complete",
    runsComplete: false,
    mergesComplete: {},
    notes: [],
  };
  const rows = await archive.evidence();
  const requested = new Map<string, Evidence | null>();
  const base = `repos/${CONTROLLER}`;
  async function get(
    path: string,
    immutable: boolean | ((row: Evidence) => boolean) = false,
  ): Promise<Evidence | null> {
    if (!allowedEndpoint(path)) {
      throw new Error("Refused non-telemetry endpoint");
    }
    if (requested.has(path)) return requested.get(path)!;
    const cached = rows.filter((r) =>
      r.observation.endpoint === path && r.observation.status === 200
    ).at(-1);
    if (
      cached &&
      (immutable === true ||
        typeof immutable === "function" && immutable(cached))
    ) {
      requested.set(path, cached);
      return cached;
    }
    const remaining = options.deadlineMs - (performance.now() - started);
    if (coverage.reads >= options.maxReads || remaining < 100) {
      coverage.stopped = remaining < 100 ? "deadline" : "read_budget";
      return null;
    }
    coverage.reads++;
    const observedAt = new Date().toISOString();
    let status = 0;
    let body: Uint8Array | null = null;
    let error: string | null = null;
    try {
      const result = await api(path, Math.min(30_000, remaining));
      status = result.status;
      body = status === 200 ? result.body : null;
      error = status === 200 ? null : safeError(status, result.error);
    } catch {
      error = "request failed or timed out";
    }
    const row = await archive.record({
      endpoint: path,
      observedAt,
      status,
      error,
      transport: "gh",
    }, body);
    rows.push(row);
    requested.set(path, row);
    return row;
  }
  try {
    // Current immutable snapshot, then only the journal chain needed to bound this window.
    const ref = await get(`${base}/git/ref/heads/sentinel-state/release`);
    const release = object(object(ref && json(ref)).object).sha;
    if (sha(release)) {
      const treeRow = await get(
        apiPath(`${base}/git/trees/${release}`, { recursive: 1 }),
        true,
      );
      const tree = object(treeRow && json(treeRow));
      const entries = list(tree.tree);
      if (tree.truncated) {
        coverage.notes.push(
          "release tree truncated; missing state remains unknown",
        );
      }
      const pointerEntry = entries.find((e) => e.path === POINTER_PATH);
      if (sha(pointerEntry?.sha)) {
        const pointer = decoded(
          await get(`${base}/git/blobs/${pointerEntry.sha}`, true),
        );
        let revision = pointer.activeRevision;
        let journalReads = 0;
        const visited = new Set<string>();
        while (sha(revision) && !visited.has(revision) && visited.size < 128) {
          visited.add(revision);
          const path = `hostedInstallations/${await digest(
            encoder.encode(`installation:${revision}`),
          )}.json`;
          const entry = entries.find((e) => e.path === path);
          if (!sha(entry?.sha)) {
            coverage.notes.push(`journal unavailable for ${revision}`);
            break;
          }
          const uri = `${base}/git/blobs/${entry.sha}`;
          const saved = rows.some((r) =>
            r.observation.endpoint === uri && r.observation.status === 200
          );
          if (!saved && journalReads >= 8) {
            coverage.notes.push(
              "journal pass bounded at eight missing blobs; next sync resumes using cached chain",
            );
            break;
          }
          if (!saved) journalReads++;
          const journal = decoded(await get(uri, true));
          if (!Object.keys(journal).length) break;
          const began = time(
            object(object(journal.bootstrapProof).execution).createdAt,
          );
          if (began !== null && began < options.since) break;
          revision = journal.previousRevision;
        }
      }
    }

    const seenRuns = new Set<number>();
    for (let page = 1; page <= 10; page++) {
      const row = await get(
        apiPath(`${base}/actions/workflows/supervisor.yml/runs`, {
          per_page: 100,
          page,
          created: `${iso(options.since)}..${iso(options.cutoff)}`,
        }),
      );
      const value = object(row && json(row));
      if (!Array.isArray(value.workflow_runs)) {
        coverage.notes.push("run metadata page unavailable");
        break;
      }
      const runs = list(value.workflow_runs);
      for (const run of runs) if (positive(run.id)) seenRuns.add(run.id);
      if (runs.length < 100 || seenRuns.size >= Number(value.total_count)) {
        coverage.runsComplete = true;
        break;
      }
      if (page === 10) {
        coverage.notes.push(
          "Actions query truncated at 1000 runs; narrow --days",
        );
      }
    }
    // Merge lists are independently paginated; no App-actor inference is made.
    for (const repository of TARGETS) {
      coverage.mergesComplete[repository] = false;
      for (let page = 1; page <= 10; page++) {
        const row = await get(
          apiPath(`repos/${repository}/pulls`, {
            state: "closed",
            sort: "updated",
            direction: "desc",
            per_page: 100,
            page,
          }),
        );
        const value = row && json(row);
        if (!Array.isArray(value)) break;
        const pulls = list(value);
        for (const pull of pulls) {
          const merged = time(pull.merged_at);
          if (
            positive(pull.number) && merged !== null &&
            merged >= options.since && merged < options.cutoff
          ) {
            await get(
              `repos/${repository}/pulls/${pull.number}`,
              (r) => time(object(json(r)).merged_at) !== null,
            );
          }
        }
        if (
          pulls.length < 100 ||
          pulls.some((p) => Number(time(p.updated_at)) < options.since)
        ) {
          coverage.mergesComplete[repository] = true;
          break;
        }
        if (page === 10) {
          coverage.notes.push(
            `${repository}: merge history truncated at ten pages`,
          );
        }
      }
    }
    const runs = inventory(rows, options.since, options.cutoff);
    // Enumerate every prior attempt, preserving failures before a successful rerun.
    for (
      const attempt of [...runs.values()].sort((a, b) =>
        b.runId - a.runId || a.attempt - b.attempt
      )
    ) {
      if (attempt.status === "unknown") {
        await get(
          `${base}/actions/runs/${attempt.runId}/attempts/${attempt.attempt}`,
          (r) => object(json(r)).status === "completed",
        );
      }
    }
    for (
      const attempt of [...runs.values()].sort((a, b) =>
        b.runId - a.runId || a.attempt - b.attempt
      )
    ) {
      const allJobs: Record<string, unknown>[] = [];
      for (let page = 1; page <= 10; page++) {
        const row = await get(
          apiPath(
            `${base}/actions/runs/${attempt.runId}/attempts/${attempt.attempt}/jobs`,
            { per_page: 100, ...(page > 1 ? { page } : {}) },
          ),
          (r) => {
            const value = object(json(r));
            return Array.isArray(value.jobs) &&
              list(value.jobs).every((j) => j.status === "completed");
          },
        );
        const value = object(row && json(row));
        if (!Array.isArray(value.jobs)) break;
        const jobs = list(value.jobs);
        allJobs.push(...jobs);
        if (jobs.length < 100 || allJobs.length >= Number(value.total_count)) {
          break;
        }
        if (page === 10) {
          coverage.notes.push(
            `${attempt.runId}/${attempt.attempt}: jobs truncated`,
          );
        }
      }
      for (
        const job of allJobs.filter((j) =>
          j.name === "repair" && j.run_id === attempt.runId &&
          j.run_attempt === attempt.attempt && j.status === "completed" &&
          time(j.started_at) !== null
        )
      ) {
        if (positive(job.id)) {
          await get(`${base}/actions/jobs/${job.id}/logs`, true);
        }
      }
    }
    return coverage;
  } finally {
    coverage.observedAt = new Date().toISOString();
    await archive.saveSession(coverage);
  }
}
