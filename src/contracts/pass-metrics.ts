/**
 * Advisory per-pass report input, not state/admission/merge authority.
 * Counters and cellMinutes are deltas, never cumulative totals. A pass id is
 * globally unique (including controller run attempt); repeated exports are OK.
 * Repository queue/blocked/live fields are complete end-of-pass snapshots.
 */
export interface PassMetricsV1 {
  version: 1;
  kind: "pass_metrics";
  id: string;
  startedAt: string;
  finishedAt: string;
  /** Sum across cells, including concurrent work; may exceed pass duration. */
  cellMinutes: number;
  repositories: RepositoryPassMetricsV1[];
}

export interface RepositoryPassMetricsV1 {
  repository: string;
  merges: { number: number; mergedAt: string }[];
  refreshCommits: number;
  targetCiRuns: number;
  deliveryQueueDepth: number;
  blockedCauses: Record<string, number>;
  plannerRefusals: Record<string, number>;
  liveRecords: {
    id: string;
    waitingSince: string;
    nextStep: "work" | "review" | "delivery" | "blocked";
    cause: string | null;
  }[];
}

/** Date-only arguments mean midnight UTC; reject rollover and local-time dates. */
export function metricsTime(value: string): number {
  if (
    !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)
  ) throw new Error(`Invalid UTC date: ${value}`);
  const n = Date.parse(value);
  if (
    !Number.isFinite(n) ||
    new Date(n).toISOString().slice(0, value.length === 10 ? 10 : 19) !==
      value.slice(0, value.length === 10 ? 10 : 19)
  ) throw new Error(`Invalid UTC date: ${value}`);
  return n;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected metrics object");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (
    typeof value !== "string" || !value.trim() ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  ) {
    throw new Error(
      "Expected nonempty metrics text without control characters",
    );
  }
  return value;
}
function timestamp(value: unknown): string {
  const s = text(value);
  if (!s.includes("T")) throw new Error("Expected UTC metrics timestamp");
  metricsTime(s);
  return s;
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("Expected nonnegative integer metrics count");
  }
  return Number(value);
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected metrics array");
  return value;
}
function histogram(value: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(object(value)).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, n]) => [text(key), count(n)],
    ),
  );
}
function unique(values: (string | number)[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error("Duplicate entry in pass metrics");
  }
}

export function parsePassMetrics(value: unknown): PassMetricsV1 {
  const row = object(value);
  if (row.version !== 1 || row.kind !== "pass_metrics") {
    throw new Error("Unsupported pass metrics version/kind");
  }
  const startedAt = timestamp(row.startedAt);
  const finishedAt = timestamp(row.finishedAt);
  const start = metricsTime(startedAt), end = metricsTime(finishedAt);
  if (end < start) throw new Error("Pass finishes before it starts");
  if (
    typeof row.cellMinutes !== "number" || !Number.isFinite(row.cellMinutes) ||
    row.cellMinutes < 0
  ) throw new Error("Expected nonnegative finite cellMinutes");
  const repositories = array(row.repositories).map((value) => {
    const repo = object(value);
    const repository = text(repo.repository);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
      throw new Error("Expected owner/repository in pass metrics");
    }
    const merges = array(repo.merges).map((value) => {
      const merge = object(value);
      const number = count(merge.number);
      const mergedAt = timestamp(merge.mergedAt);
      if (
        number === 0 || metricsTime(mergedAt) < start ||
        metricsTime(mergedAt) > end
      ) {
        throw new Error("Invalid merge number or merge outside its pass");
      }
      return { number, mergedAt };
    }).sort((a, b) => a.number - b.number);
    unique(merges.map((m) => m.number));
    const liveRecords = array(repo.liveRecords).map((value) => {
      const live = object(value);
      const waitingSince = timestamp(live.waitingSince);
      const nextStep = text(live.nextStep);
      if (
        metricsTime(waitingSince) > end ||
        !["work", "review", "delivery", "blocked"].includes(nextStep)
      ) throw new Error("Invalid live-record wait or next step");
      return {
        id: text(live.id),
        waitingSince,
        nextStep: nextStep as RepositoryPassMetricsV1["liveRecords"][number][
          "nextStep"
        ],
        cause: live.cause === null ? null : text(live.cause),
      };
    }).sort((a, b) => a.id.localeCompare(b.id));
    unique(liveRecords.map((r) => r.id));
    return {
      repository,
      merges,
      refreshCommits: count(repo.refreshCommits),
      targetCiRuns: count(repo.targetCiRuns),
      deliveryQueueDepth: count(repo.deliveryQueueDepth),
      blockedCauses: histogram(repo.blockedCauses),
      plannerRefusals: histogram(repo.plannerRefusals),
      liveRecords,
    };
  }).sort((a, b) => a.repository.localeCompare(b.repository));
  unique(repositories.map((r) => r.repository));
  return {
    version: 1,
    kind: "pass_metrics",
    id: text(row.id),
    startedAt,
    finishedAt,
    cellMinutes: row.cellMinutes,
    repositories,
  };
}
