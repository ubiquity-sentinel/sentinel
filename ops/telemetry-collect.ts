import { collectJournals, decodeState } from "./telemetry-history.ts";
import { type Archive, safeError } from "./telemetry-store.ts";
import { allowedEndpoint } from "./telemetry-import.ts";
import { inventory, json } from "./telemetry-proof.ts";
import {
  type Api,
  CONTROLLER,
  type Coverage,
  decoder,
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
export async function syncArchive(
  archive: Archive,
  options: SyncOptions,
  api: Api = ghApi,
): Promise<Coverage> {
  const started = performance.now();
  const coverage: Coverage = {
    schema: 1,
    collection: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    since: iso(options.since),
    cutoff: iso(options.cutoff),
    reads: 0,
    maxReads: options.maxReads,
    stopped: "complete",
    runsComplete: false,
    mergesComplete: {},
    attemptLogArchives: { captured: 0, reused: 0, missing: 0, deferred: 0 },
    notes: [],
  };
  const rows = await archive.evidence();
  const requested = new Map<string, Evidence | null>();
  const archivedAttempts = new Set<string>();
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
      collection: coverage.collection,
      observedAt,
      status,
      error,
      transport: "gh",
    }, body);
    rows.push(row);
    requested.set(path, row);
    return row;
  }
  async function jobsFor(attempts: ReturnType<typeof inventory>) {
    const completed = new Map<string, number>();
    for (const row of rows) {
      const value = object(json(row));
      const candidates = Array.isArray(value.workflow_runs)
        ? list(value.workflow_runs)
        : /\/actions\/runs\/\d+\/attempts\/\d+$/.test(row.observation.endpoint)
        ? [value]
        : [];
      for (const run of candidates) {
        if (run.status === "completed") {
          const key = run.id + "/" + run.run_attempt;
          completed.set(
            key,
            Math.min(
              completed.get(key) ?? Infinity,
              Number(time(row.observation.observedAt)),
            ),
          );
        }
      }
    }
    for (
      const attempt of [...attempts.values()].sort((a, b) =>
        b.runId - a.runId || a.attempt - b.attempt
      )
    ) {
      if (attempt.status === "unknown") {
        await get(
          base + "/actions/runs/" + attempt.runId + "/attempts/" +
            attempt.attempt,
          (r) => object(json(r)).status === "completed",
        );
      }
      const allJobs: Record<string, unknown>[] = [];
      for (let page = 1; page <= 10; page++) {
        const row = await get(
          apiPath(
            base + "/actions/runs/" + attempt.runId + "/attempts/" +
              attempt.attempt + "/jobs",
            { per_page: 100, ...(page > 1 ? { page } : {}) },
          ),
          (r) => {
            const v = object(json(r));
            const jobs = list(v.jobs);
            return completed.has(attempt.runId + "/" + attempt.attempt) &&
              completed.get(attempt.runId + "/" + attempt.attempt)! <=
                Number(time(r.observation.observedAt)) &&
              Array.isArray(v.jobs) && Number.isSafeInteger(v.total_count) &&
              v.total_count === jobs.length &&
              jobs.every((j) => j.status === "completed");
          },
        );
        const value = object(row && json(row));
        if (!Array.isArray(value.jobs)) break;
        const jobs = list(value.jobs);
        allJobs.push(...jobs);
        if (allJobs.length >= Number(value.total_count)) break;
        if (jobs.length < 100) {
          coverage.notes.push(
            attempt.runId + "/" + attempt.attempt + ": incomplete jobs listing",
          );
          break;
        }
        if (page === 10) {
          coverage.notes.push(
            attempt.runId + "/" + attempt.attempt + ": jobs truncated",
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
          await get(base + "/actions/jobs/" + job.id + "/logs", true);
        }
      }
      const key = attempt.runId + "/" + attempt.attempt;
      if (completed.has(key) && !archivedAttempts.has(key)) {
        archivedAttempts.add(key);
        const path = base + "/actions/runs/" + attempt.runId + "/attempts/" +
          attempt.attempt + "/logs";
        const reused = rows.some((r) =>
          r.observation.endpoint === path && r.observation.status === 200 &&
          r.observation.blob !== null
        );
        const archiveLog = await get(path, true);
        const counts = coverage.attemptLogArchives!;
        if (!archiveLog) counts.deferred++;
        else if (
          archiveLog.observation.status !== 200 || !archiveLog.observation.blob
        ) counts.missing++;
        else if (reused) counts.reused++;
        else counts.captured++;
      }
    }
  }
  try {
    const ref = await get(base + "/git/ref/heads/sentinel-state/release");
    const release = object(object(ref && json(ref)).object).sha;
    let entries: Record<string, unknown>[] = [];
    let pointer: Record<string, unknown> = {};
    if (sha(release)) {
      const treeRow = await get(
        apiPath(base + "/git/trees/" + release, { recursive: 1 }),
        true,
      );
      const tree = object(treeRow && json(treeRow));
      entries = list(tree.tree);
      if (tree.truncated) {
        coverage.notes.push(
          "release tree truncated; missing state remains unknown",
        );
      }
      const entry = entries.find((e) => e.path === POINTER_PATH);
      if (sha(entry?.sha)) {
        pointer = decodeState(
          await get(base + "/git/blobs/" + entry.sha, true),
        );
      }
    }
    const seenRuns = new Set<number>();
    for (let page = 1; page <= 10; page++) {
      const row = await get(
        apiPath(base + "/actions/workflows/supervisor.yml/runs", {
          per_page: 100,
          page,
          created: iso(options.since) + ".." + iso(options.cutoff),
        }),
      );
      const value = object(row && json(row));
      if (!Array.isArray(value.workflow_runs)) {
        coverage.notes.push("run metadata page unavailable");
        break;
      }
      const runs = list(value.workflow_runs);
      for (const run of runs) if (positive(run.id)) seenRuns.add(run.id);
      if (page === 1) {
        const current = inventory(rows, options.since, options.cutoff);
        const selected = new Map(
          [...current].filter(([, a]) =>
            seenRuns.has(a.runId) &&
            (a.workflowHeadSha === pointer.activeRevision ||
              a.runId === object(pointer.execution).runId)
          ),
        );
        // These are read priorities only; native evidence still owns attribution.
        await jobsFor(
          selected.size
            ? selected
            : new Map([...current].filter(([, a]) => seenRuns.has(a.runId))),
        );
      }
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
    await collectJournals(pointer, entries, rows, get, options, coverage.notes);
    const enrichment: { repository: string; number: number }[] = [];
    for (const repository of TARGETS) {
      coverage.mergesComplete[repository] = false;
      for (let page = 1; page <= 10; page++) {
        const row = await get(
          apiPath("repos/" + repository + "/pulls", {
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
          ) enrichment.push({ repository, number: pull.number });
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
            repository + ": merge history truncated at ten pages",
          );
        }
      }
    }
    await jobsFor(inventory(rows, options.since, options.cutoff));
    // Detail enrichment is last: old merged PR actor reads cannot starve current native proof.
    for (const pull of enrichment) {
      await get(
        "repos/" + pull.repository + "/pulls/" + pull.number,
        (r) => time(object(json(r)).merged_at) !== null,
      );
    }
    return coverage;
  } finally {
    coverage.observedAt = new Date().toISOString();
    await archive.saveSession(coverage);
  }
}
