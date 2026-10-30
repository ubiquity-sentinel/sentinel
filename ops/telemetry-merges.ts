import { endpoint, json } from "./telemetry-proof.ts";
import {
  type Evidence,
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

/** Union immutable positive observations; pagination freshness never removes a known merge. */
export function mergeObservations(
  rows: Evidence[],
  sessions: unknown[],
  since: number,
  cutoff: number,
) {
  const found = new Map<string, Merge>();
  const changed = new Set<string>();
  const details = rows.filter((r) =>
    /\/pulls\/\d+$/.test(endpoint(r)) && json(r)
  );
  const history = sessions.map(object).filter((s) =>
    time(s.observedAt) !== null && typeof s.since === "string"
  ).sort((a, b) => Number(time(a.observedAt)) - Number(time(b.observedAt)));
  const imported = new Map<string, Evidence[]>();
  const cohorts = new Map<string, string>();
  for (const row of rows) {
    const source = row.observation.source;
    const receipt = source?.receipt.match(/^([a-f0-9]{64}):(\d+)$/);
    if (!source || !receipt || !/\/pulls$/.test(endpoint(row))) continue;
    const key = source.manifest + ":" + receipt[1] + ":" + endpoint(row);
    const group = imported.get(key) ?? [];
    group.push(row);
    imported.set(key, group);
  }
  for (const [key, group] of imported) {
    group.sort((a, b) =>
      Number(a.observation.source!.receipt.split(":")[1]) -
      Number(b.observation.source!.receipt.split(":")[1])
    );
    let pass: string | null = null;
    for (const row of group) {
      const page = Number(
        new URLSearchParams(row.observation.endpoint.split("?")[1]).get(
          "page",
        ) ?? 1,
      );
      // A ledger proves request provenance, not one pass: every page-one request restarts it.
      if (page === 1) pass = key + ":" + row.observation.source!.receipt;
      if (pass) cohorts.set(row.id, pass);
    }
  }
  function collection(row: Evidence): string {
    if (row.observation.collection) return row.observation.collection;
    const source = row.observation.source;
    if (source) return cohorts.get(row.id) ?? `unbound:${row.id}`;
    // Old archives have session end clocks, allowing conservative reconstruction of their passes.
    const session = history.find((s) =>
      Number(time(s.observedAt)) >= Number(time(row.observation.observedAt))
    );
    return session ? `legacy:${session.observedAt}` : `unbound:${row.id}`;
  }
  const pagesByRepo = new Map<string, Evidence[]>();
  for (const repository of TARGETS) {
    const pages = rows.filter((row) => {
      if (endpoint(row) !== `repos/${repository}/pulls`) return false;
      const q = new URLSearchParams(row.observation.endpoint.split("?")[1]);
      return q.get("state") === "closed" && q.get("sort") === "updated" &&
        q.get("direction") === "desc" && q.get("per_page") === "100";
    });
    pagesByRepo.set(repository, pages);
    for (const row of pages) {
      for (const p of list(json(row))) {
        const mergedAt = time(p.merged_at);
        if (
          !positive(p.number) || !sha(p.merge_commit_sha) ||
          mergedAt === null || mergedAt < since || mergedAt >= cutoff
        ) continue;
        const key = `${repository}/${p.number}/${p.merge_commit_sha}`;
        const more = details.filter((d) =>
          endpoint(d) === `repos/${repository}/pulls/${p.number}`
        ).findLast((d) => {
          const value = object(json(d));
          return value.merge_commit_sha === p.merge_commit_sha &&
            time(value.merged_at) === mergedAt;
        });
        const actor = object((more ? object(json(more)) : p).merged_by);
        const old = found.get(key);
        if (old && old.mergedAt !== mergedAt) changed.add(repository);
        if (
          [...found.values()].some((v) =>
            v.repository === repository && v.pullRequest === p.number &&
            v.mergeSha !== p.merge_commit_sha
          )
        ) changed.add(repository);
        found.set(key, {
          repository,
          pullRequest: p.number,
          mergeSha: p.merge_commit_sha,
          mergedAt: old?.mergedAt ?? mergedAt,
          origin: old?.origin === "owner_manual" || actor.type === "User"
            ? "owner_manual"
            : "unknown",
          evidence: [
            ...new Set([
              ...(old?.evidence ?? []),
              row.id,
              ...(more ? [more.id] : []),
            ]),
          ],
        });
      }
    }
  }
  const coverage: Record<
    string,
    {
      complete: boolean;
      through: string | null;
      evidence: string[];
      uncertainty: string[];
    }
  > = {};
  for (const repository of TARGETS) {
    const all = pagesByRepo.get(repository)!;
    const first = all.findLast((r) =>
      Number(
        new URLSearchParams(r.observation.endpoint.split("?")[1]).get("page") ??
          1,
      ) === 1
    );
    const pass = first && collection(first);
    const pages = new Map<number, Evidence>();
    for (const row of all) {
      if (pass && collection(row) === pass) {
        pages.set(
          Number(
            new URLSearchParams(row.observation.endpoint.split("?")[1]).get(
              "page",
            ) ?? 1,
          ),
          row,
        );
      }
    }
    const sources: string[] = [];
    const present = new Set<string>();
    let complete = false;
    let through = Infinity;
    for (let page = 1; pages.has(page); page++) {
      const row = pages.get(page)!;
      if (!Array.isArray(json(row))) break;
      const pulls = list(json(row));
      sources.push(row.id);
      through = Math.min(through, Number(time(row.observation.observedAt)));
      for (const p of pulls) {
        if (sha(p.merge_commit_sha)) {
          present.add(`${repository}/${p.number}/${p.merge_commit_sha}`);
        }
      }
      if (
        pulls.length < 100 ||
        pulls.some((p) => Number(time(p.updated_at)) < since)
      ) {
        complete = through >= cutoff;
        break;
      }
    }
    const uncertainty: string[] = [];
    if (!complete) {
      uncertainty.push(
        "latest collection has incomplete or unbound pagination",
      );
    }
    if (changed.has(repository)) {
      uncertainty.push("archived merge identity or clock changed");
    }
    if (
      complete &&
      [...found.entries()].some(([key, value]) =>
        value.repository === repository && !present.has(key)
      )
    ) {
      uncertainty.push(
        "known merged observation absent from latest complete collection",
      );
    }
    coverage[repository] = {
      complete: complete && uncertainty.length === 0,
      through: Number.isFinite(through) ? iso(through) : null,
      evidence: sources,
      uncertainty,
    };
  }
  return { values: [...found.values()], coverage };
}
