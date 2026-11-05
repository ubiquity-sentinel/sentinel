import {
  metricsTime,
  parsePassMetrics,
  type PassMetricsV1,
  type RepositoryPassMetricsV1,
} from "../src/contracts/pass-metrics.ts";

/** Parse an exported JSON array or append-only JSONL; never skip bad records. */
export function readPassMetrics(text: string): PassMetricsV1[] {
  const raw: unknown = text.trimStart().startsWith("[")
    ? JSON.parse(text)
    : text.split(/\r?\n/).filter((line) => line.trim()).map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Invalid pass metrics JSON at nonempty line ${i + 1}`);
      }
    });
  if (!Array.isArray(raw)) throw new Error("Expected pass metrics records");
  const records = new Map<string, PassMetricsV1>();
  for (const value of raw) {
    const row = parsePassMetrics(value);
    const prior = records.get(row.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
      throw new Error(`Conflicting pass metrics for ${row.id}`);
    }
    records.set(row.id, row);
  }
  return [...records.values()];
}

type Total = {
  merges: Map<number, string>;
  refresh: number;
  ci: number;
  refusals: Map<string, number>;
  latest: RepositoryPassMetricsV1;
  sampledAt: number;
};
const DAY = 86_400_000;
const iso = (n: number) => new Date(n).toISOString();
const ratio = (n: number, d: number) => d ? (n / d).toFixed(2) : "n/a";
function table(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) =>
    "| " + cells.map((s) => String(s).replaceAll("|", "\\|")).join(" | ") +
    " |";
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)]
    .join("\n");
}

/** Pure report over completed passes. No GitHub, state writes or model calls. */
export function renderReport(
  records: PassMetricsV1[],
  since: number,
  until: number,
): string {
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) {
    throw new Error(
      "Report --since must be earlier than --until (default: now)",
    );
  }
  const passes = records.filter((r) => {
    const end = metricsTime(r.finishedAt);
    return end >= since && end < until;
  }).sort((a, b) => metricsTime(a.finishedAt) - metricsTime(b.finishedAt));
  if (!passes.length) {
    throw new Error(
      "No completed pass metrics in window; throughput is unknown",
    );
  }
  const totals = new Map<string, Total>();
  let cells = 0, controller = 0;
  for (const pass of passes) {
    const sampledAt = metricsTime(pass.finishedAt);
    cells += pass.cellMinutes;
    controller += (sampledAt - metricsTime(pass.startedAt)) / 60_000;
    for (const repo of pass.repositories) {
      let total = totals.get(repo.repository);
      if (!total) {
        total = {
          merges: new Map(),
          refresh: 0,
          ci: 0,
          refusals: new Map(),
          latest: repo,
          sampledAt,
        };
        totals.set(repo.repository, total);
      } else if (
        sampledAt === total.sampledAt &&
        JSON.stringify([
            repo.deliveryQueueDepth,
            repo.blockedCauses,
            repo.liveRecords,
          ]) !==
          JSON.stringify([
            total.latest.deliveryQueueDepth,
            total.latest.blockedCauses,
            total.latest.liveRecords,
          ])
      ) {
        throw new Error(`Ambiguous latest snapshot for ${repo.repository}`);
      }
      total.refresh += repo.refreshCommits;
      total.ci += repo.targetCiRuns;
      total.latest = repo;
      total.sampledAt = sampledAt;
      for (const merge of repo.merges) {
        const at = metricsTime(merge.mergedAt);
        if (at < since || at >= until) continue;
        const prior = total.merges.get(merge.number);
        if (prior && metricsTime(prior) !== at) {
          throw new Error(
            `Conflicting merge time for ${repo.repository}#${merge.number}`,
          );
        }
        total.merges.set(merge.number, merge.mergedAt);
      }
      for (const [cause, n] of Object.entries(repo.plannerRefusals)) {
        total.refusals.set(cause, (total.refusals.get(cause) ?? 0) + n);
      }
    }
  }
  const repositories = [...totals.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const days: (string | number)[][] = [];
  for (let day = Math.floor(since / DAY) * DAY; day < until; day += DAY) {
    const date = iso(day).slice(0, 10);
    for (const [repo, total] of repositories) {
      days.push([
        date,
        repo,
        [...total.merges.values()].filter((at) => at.slice(0, 10) === date)
          .length,
      ]);
    }
  }
  const blocked: (string | number)[][] = [],
    refusals: (string | number)[][] = [];
  const live: {
    repository: string;
    record: RepositoryPassMetricsV1["liveRecords"][number];
  }[] = [];
  for (const [repository, total] of repositories) {
    for (
      const [cause, n] of Object.entries(total.latest.blockedCauses).sort()
    ) {
      if (n) blocked.push([repository, cause, n]);
    }
    for (const [cause, n] of [...total.refusals.entries()].sort()) {
      if (n) refusals.push([repository, cause, n]);
    }
    live.push(
      ...total.latest.liveRecords.map((record) => ({ repository, record })),
    );
  }
  live.sort((a, b) =>
    metricsTime(a.record.waitingSince) - metricsTime(b.record.waitingSince) ||
    a.repository.localeCompare(b.repository) ||
    a.record.id.localeCompare(b.record.id)
  );
  return [
    "Throughput report (UTC)",
    `Window: ${iso(since)} <= time < ${iso(until)}`,
    `Completed passes: ${passes.length}; latest: ${passes.at(-1)!.finishedAt}`,
    `Model duty cycle: ${cells.toFixed(2)} cell minutes / ${
      controller.toFixed(2)
    } controller minutes = ${
      controller ? (100 * cells / controller).toFixed(2) + "%" : "n/a"
    }`,
    "Pass deltas are selected by finish time; parallel cells can exceed 100% duty.",
    "Queue, blocked causes and live records use each repository's latest snapshot, not sums.",
    "",
    "Merges per day by repository",
    table(["Day (UTC)", "Repository", "Merges"], days),
    "",
    "Repository totals",
    table(
      [
        "Repository",
        "Merges",
        "Merges/day",
        "Refresh commits",
        "Refresh/merge",
        "Target CI runs",
        "CI/merge",
        "Delivery queue",
        "Snapshot (UTC)",
      ],
      repositories.map(([repo, t]) => [
        repo,
        t.merges.size,
        ratio(t.merges.size, (until - since) / DAY),
        t.refresh,
        ratio(t.refresh, t.merges.size),
        t.ci,
        ratio(t.ci, t.merges.size),
        t.latest.deliveryQueueDepth,
        iso(t.sampledAt),
      ]),
    ),
    "",
    "Blocked-cause histogram (latest snapshots)",
    blocked.length
      ? table(["Repository", "Cause", "Count"], blocked)
      : "(none)",
    "",
    "Planner refusal histogram (pass deltas)",
    refusals.length
      ? table(["Repository", "Refusal", "Count"], refusals)
      : "(none)",
    "",
    "Longest-waiting live records (latest snapshots; top 10; age at window end)",
    live.length
      ? table(
        [
          "Repository",
          "Record",
          "Next step",
          "Cause",
          "Waiting since (UTC)",
          "Waiting hours",
        ],
        live.slice(0, 10).map(({ repository, record: r }) => [
          repository,
          r.id,
          r.nextStep,
          r.cause ?? "-",
          r.waitingSince,
          ((until - metricsTime(r.waitingSince)) / 3_600_000).toFixed(2),
        ]),
      )
      : "(none)",
  ].join("\n");
}

export async function reportFromFile(
  opts: Record<string, string>,
  now = Date.now(),
): Promise<string> {
  if (
    Object.keys(opts).some((key) =>
      !["since", "until", "metrics"].includes(key)
    )
  ) {
    throw new Error(
      "usage: sentinel report --since <UTC date> [--until <UTC date>] [--metrics <file>]",
    );
  }
  if (!opts.since) {
    throw new Error("sentinel report requires --since <UTC date>");
  }
  const since = metricsTime(opts.since);
  const until = opts.until ? metricsTime(opts.until) : now;
  if (since >= until) {
    throw new Error(
      "Report --since must be earlier than --until (default: now)",
    );
  }
  const path = opts.metrics ?? ".sentinel/pass-metrics.jsonl";
  if (path === "true" || !path) {
    throw new Error("--metrics requires a file path");
  }
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    throw new Error(`Pass metrics unavailable at ${path}; no report produced`, {
      cause: error,
    });
  }
  return renderReport(readPassMetrics(text), since, until);
}
