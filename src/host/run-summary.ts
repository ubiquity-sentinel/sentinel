/**
 * One run-level summary in the finalize job (#178).
 *
 * Every runtime child prints one advisory `hosted_runtime_summary` line, so a
 * supervisor run with matrix cells leaves one per cell plus one per other
 * runtime job, and an operator had to open several job logs to learn what the
 * run did. The finalize job reads the run attempt's completed job logs, keeps
 * the last summary line of each, and prints exactly one
 * `hosted_runtime_run_summary` line plus a GitHub step summary.
 *
 * Advisory only: it grants no health, accounting or admission authority, an
 * unknown count stays null, and a failed read never changes the finalize
 * outcome.
 */
import type { PortResultV1 } from "../contracts/ports.ts";

/** The fields of one child's `hosted_runtime_summary` this summary reads. */
export interface ChildRuntimeSummaryV1 {
  launcherSha: string | null;
  runtimeSha: string | null;
  generation: number | null;
  purpose: string | null;
  targets: {
    repository: string;
    openIssues: number | null;
    admitted: number | null;
    skipped: number | null;
  }[];
  admittedWorkCount: number | null;
  modelStarts: number | null;
  prsTouched: { repository: string; number: number; action: string }[];
  outcome: string;
  reasonCode: string;
}

/** One completed job of the run attempt and its last runtime summary. */
export interface RunJobSummaryV1 {
  name: string;
  conclusion: string | null;
  summary: ChildRuntimeSummaryV1 | null;
}

export interface HostedRuntimeRunSummaryV1 {
  version: "v1";
  kind: "hosted_runtime_run_summary";
  runId: number;
  attempt: number;
  launcherSha: string | null;
  runtimeSha: string | null;
  generation: number | null;
  purpose: string | null;
  jobs: {
    name: string;
    conclusion: string | null;
    outcome: string | null;
    reasonCode: string | null;
  }[];
  targets: {
    repository: string;
    openIssues: number | null;
    admitted: number | null;
    skipped: number | null;
  }[];
  admittedWorkCount: number | null;
  modelStarts: number | null;
  prsTouched: { repository: string; number: number; action: string }[];
  outcome: "healthy" | "failed" | "unavailable";
  explanation: string;
  nextAction: string;
}

const SUMMARY_KIND = '"kind":"hosted_runtime_summary"';
const MAX_JOBS = 300;
const MAX_TARGETS = 50;
const MAX_PRS = 200;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | null =>
  Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : null;
const text = (value: unknown, max = 200): string | null =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;

/** The child summary fields, or null for a line that is not one. */
export function parseChildRuntimeSummary(
  value: unknown,
): ChildRuntimeSummaryV1 | null {
  if (!record(value) || value.kind !== "hosted_runtime_summary") return null;
  const targets = Array.isArray(value.targets) ? value.targets : [];
  const prs = Array.isArray(value.prsTouched) ? value.prsTouched : [];
  return {
    launcherSha: text(value.launcherSha, 40),
    runtimeSha: text(value.runtimeSha, 40),
    generation: count(value.generation),
    purpose: text(value.purpose, 40),
    targets: targets.slice(0, MAX_TARGETS).flatMap((row) => {
      if (!record(row)) return [];
      const repository = text(row.repository);
      if (repository === null) return [];
      return [{
        repository,
        openIssues: count(row.openIssues),
        admitted: count(row.admitted),
        skipped: Array.isArray(row.skippedIssues)
          ? row.skippedIssues.length
          : null,
      }];
    }),
    admittedWorkCount: count(value.admittedWorkCount),
    modelStarts: count(value.modelStarts),
    prsTouched: prs.slice(0, MAX_PRS).flatMap((row) => {
      if (!record(row)) return [];
      const repository = text(row.repository);
      const number = count(row.number);
      const action = text(row.action, 20);
      return repository === null || number === null || action === null
        ? []
        : [{ repository, number, action }];
    }),
    outcome: text(value.outcome, 20) ?? "unavailable",
    reasonCode: text(value.reasonCode, 80) ?? "unknown",
  };
}

/**
 * The last `hosted_runtime_summary` line of one job log (Actions prefixes
 * each line with a timestamp), or null when the job printed none.
 */
export function lastRuntimeSummary(log: string): ChildRuntimeSummaryV1 | null {
  const lines = log.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line.includes(SUMMARY_KIND)) continue;
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      const parsed = parseChildRuntimeSummary(JSON.parse(line.slice(start)));
      if (parsed !== null) return parsed;
    } catch {
      // A truncated or foreign line is not a summary; keep looking.
    }
  }
  return null;
}

/** The one value every known summary agrees on, else null. */
function agreed<T>(values: readonly (T | null)[]): T | null {
  const known = [...new Set(values.filter((value) => value !== null))];
  return known.length === 1 ? known[0] as T : null;
}

/** The sum of the known counts, or null when none is known. */
function total(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function aggregateRunSummary(
  run: { runId: number; runAttempt: number },
  jobs: readonly RunJobSummaryV1[],
): HostedRuntimeRunSummaryV1 {
  const listed = jobs.slice(0, MAX_JOBS);
  const summaries = listed.flatMap((job) =>
    job.summary === null ? [] : [job.summary]
  );
  const byRepository = new Map<string, ChildRuntimeSummaryV1["targets"]>();
  for (const summary of summaries) {
    for (const target of summary.targets) {
      byRepository.set(target.repository, [
        ...(byRepository.get(target.repository) ?? []),
        target,
      ]);
    }
  }
  const targets = [...byRepository.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([repository, rows]) => {
      const open = rows.flatMap((row) =>
        row.openIssues === null ? [] : [row.openIssues]
      );
      return {
        repository,
        openIssues: open.length === 0 ? null : Math.max(...open),
        admitted: total(rows.map((row) => row.admitted)),
        skipped: total(rows.map((row) => row.skipped)),
      };
    });
  const seen = new Set<string>();
  const prsTouched = summaries.flatMap((summary) => summary.prsTouched)
    .filter((pr) => {
      const key = `${pr.repository}#${pr.number}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const failed = listed.find((job) =>
    job.conclusion === "failure" || job.summary?.outcome === "failed"
  );
  const unreadable = listed.filter((job) => job.summary === null);
  const outcome: HostedRuntimeRunSummaryV1["outcome"] = failed !== undefined
    ? "failed"
    : summaries.length === 0 ||
        summaries.some((summary) => summary.outcome !== "healthy")
    ? "unavailable"
    : "healthy";
  const generation = agreed(summaries.map((summary) => summary.generation));
  const purpose = agreed(summaries.map((summary) => summary.purpose));
  const admittedWorkCount = total(
    summaries.map((summary) => summary.admittedWorkCount),
  );
  const modelStarts = total(summaries.map((summary) => summary.modelStarts));
  const explanation = `Run ${run.runId} attempt ${run.runAttempt}: ${
    summaries.length === 1
      ? "1 runtime summary"
      : `${summaries.length} runtime summaries`
  } read${generation === null ? "" : ` on generation ${generation}`}${
    purpose === null ? "" : ` (${purpose})`
  }; ${admittedWorkCount === null ? "unknown" : admittedWorkCount} admitted, ${
    modelStarts === null ? "unknown" : modelStarts
  } model starts, ${
    plural(prsTouched.length, "pull request")
  } touched; ${outcome}.`;
  const nextAction = failed !== undefined
    ? `Open the ${failed.name} job log (${
      failed.summary?.reasonCode ?? failed.conclusion ?? "failed"
    }).`
    : outcome === "unavailable"
    ? `Open the job logs of ${
      unreadable.length === 0
        ? "the run"
        : unreadable.map((job) => job.name).slice(0, 5).join(", ")
    }; their runtime summary was missing or not healthy.`
    : "None; the next scheduled run continues.";
  return {
    version: "v1",
    kind: "hosted_runtime_run_summary",
    runId: run.runId,
    attempt: run.runAttempt,
    launcherSha: agreed(summaries.map((summary) => summary.launcherSha)),
    runtimeSha: agreed(summaries.map((summary) => summary.runtimeSha)),
    generation,
    purpose,
    jobs: listed.map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      outcome: job.summary?.outcome ?? null,
      reasonCode: job.summary?.reasonCode ?? null,
    })),
    targets,
    admittedWorkCount,
    modelStarts,
    prsTouched,
    outcome,
    explanation,
    nextAction,
  };
}

const cell = (value: number | string | null) =>
  value === null ? "unknown" : String(value).replace(/\|/g, "/");

/** The GitHub step summary for one run summary, in plain Markdown. */
export function runSummaryMarkdown(summary: HostedRuntimeRunSummaryV1): string {
  const lines = [
    "### Sentinel run summary",
    "",
    summary.explanation,
    "",
    `Next action: ${summary.nextAction}`,
    "",
  ];
  if (summary.targets.length > 0) {
    lines.push(
      "| Target | Open issues | Admitted | Skipped |",
      "| --- | --- | --- | --- |",
      ...summary.targets.map((target) =>
        `| ${cell(target.repository)} | ${cell(target.openIssues)} | ${
          cell(target.admitted)
        } | ${cell(target.skipped)} |`
      ),
      "",
    );
  }
  if (summary.prsTouched.length > 0) {
    lines.push(
      "Pull requests touched:",
      ...summary.prsTouched.map((pr) =>
        `- ${cell(pr.repository)}#${pr.number}: ${cell(pr.action)}`
      ),
      "",
    );
  }
  return lines.join("\n");
}

export interface RunSummaryDepsV1 {
  /** The run attempt's completed jobs with each job's selected summary. */
  readJobs(
    runId: number,
    runAttempt: number,
    select: (log: string) => ChildRuntimeSummaryV1 | null,
  ): Promise<PortResultV1<RunJobSummaryV1[]>>;
  log?: (line: string) => void;
  /** `GITHUB_STEP_SUMMARY`, appended to when present. */
  stepSummaryPath?: string;
  appendFile?: (path: string, text: string) => Promise<void>;
}

/** Read, aggregate and print once. Never throws. */
export async function emitRunSummary(
  deps: RunSummaryDepsV1,
  run: { runId: number; runAttempt: number },
): Promise<HostedRuntimeRunSummaryV1 | null> {
  const log = deps.log ?? ((line: string) => console.log(line));
  try {
    const jobs = await deps.readJobs(
      run.runId,
      run.runAttempt,
      lastRuntimeSummary,
    );
    const summary = aggregateRunSummary(run, jobs.ok ? jobs.value : []);
    if (!jobs.ok) {
      summary.nextAction =
        "The run's job list was unreadable; open the run's job logs.";
    }
    log(JSON.stringify(summary));
    if (deps.stepSummaryPath !== undefined && deps.stepSummaryPath !== "") {
      const append = deps.appendFile ??
        ((path: string, body: string) =>
          Deno.writeTextFile(path, body, { append: true }));
      try {
        await append(deps.stepSummaryPath, runSummaryMarkdown(summary));
      } catch {
        // The step summary is a convenience; the JSON line already printed.
      }
    }
    return summary;
  } catch {
    return null;
  }
}
