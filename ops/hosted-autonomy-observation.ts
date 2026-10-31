import {
  extractSelfFailureSignature,
  planSelfObservations,
  SELF_DEFECT_MAX_ISSUES_PER_PASS,
  SELF_DEFECT_MAX_LOG_BYTES,
  SELF_DEFECT_MAX_RUNS_PER_PASS,
  SELF_DEFECT_WINDOW_MS,
  SELF_DEFECT_WORKFLOWS,
  type SelfFailureV1,
} from "./self-defects.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedSelfObservationV1,
} from "./hosted-autonomy-types.ts";

/**
 * Bounded self-observation: read this deployment's own recent failed or
 * cancelled runs, extract ONE allowlisted signature per failed job from a
 * bounded log read, and file at most `SELF_DEFECT_MAX_ISSUES_PER_PASS`
 * deduplicated reports into the repository's own tracker. The normal repair
 * loop then works those issues like any other. Every read and write here is
 * optional: a surface without the capability is skipped with an explicit
 * action, and no failure of this pass changes any state or blocks another
 * pass.
 */
export async function runSelfObservationPass(input: {
  github: HostedAutonomyGitHubV1 | null;
  now: number;
}): Promise<string[]> {
  const actions: string[] = [];
  const surface = input.github;
  const observation = surface?.selfObservation;
  if (surface === null || observation === undefined) {
    return ["self-observation:skipped:capability_absent"];
  }
  let runs: Awaited<ReturnType<HostedSelfObservationV1["listRuns"]>> = null;
  try {
    runs = await observation.listRuns({
      sinceIso: new Date(input.now - SELF_DEFECT_WINDOW_MS).toISOString(),
      limit: 30,
    });
  } catch {
    runs = null;
  }
  if (runs === null) return ["self-observation:skipped:runs_unavailable"];
  const failed = runs
    .filter((run) =>
      SELF_DEFECT_WORKFLOWS.includes(run.name) &&
      run.conclusion !== null && run.conclusion !== "success" &&
      run.conclusion !== "skipped"
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, SELF_DEFECT_MAX_RUNS_PER_PASS);
  if (failed.length === 0) return ["self-observation:skipped:no_failed_runs"];
  const failures: (SelfFailureV1 & {
    signature: ReturnType<typeof extractSelfFailureSignature>;
  })[] = [];
  for (const run of failed) {
    let jobs: Awaited<ReturnType<HostedSelfObservationV1["listJobs"]>> = null;
    try {
      jobs = await observation.listJobs(run.id);
    } catch {
      jobs = null;
    }
    if (jobs === null) {
      actions.push(`self-observation:skipped:run=${run.id}:jobs_unavailable`);
      continue;
    }
    // Cancellation can be intentional (paused admission or a superseded run)
    // or a fail-fast side effect. Prefer the actual failure and never treat
    // cancellation alone as a repairable defect.
    const job = jobs.find((entry) =>
      entry.conclusion === "failure" || entry.conclusion === "timed_out" ||
      entry.conclusion === "startup_failure"
    ) ?? jobs.find((entry) =>
      entry.conclusion !== null && entry.conclusion !== "success" &&
      entry.conclusion !== "skipped" && entry.conclusion !== "cancelled"
    );
    if (job === undefined) {
      continue;
    }
    let log: string | null = null;
    try {
      log = await observation.readJobLog({
        jobId: job.id,
        maxBytes: SELF_DEFECT_MAX_LOG_BYTES,
      });
    } catch {
      log = null;
    }
    if (log === null) {
      actions.push(
        `self-observation:skipped:run=${run.id}:log_unavailable`,
      );
      continue;
    }
    const context: SelfFailureV1 = {
      runId: run.id,
      workflow: run.name,
      job: job.name,
      conclusion: job.conclusion ?? run.conclusion ?? "unknown",
      createdAt: run.createdAt,
    };
    failures.push({
      ...context,
      signature: extractSelfFailureSignature(log, context),
    });
  }
  if (failures.length === 0) {
    return actions.length > 0
      ? actions
      : ["self-observation:skipped:no_readable_failure"];
  }
  let existing: string[] | null = null;
  try {
    existing = await observation.listOpenIssueBodies();
  } catch {
    existing = null;
  }
  if (existing === null) {
    return [...actions, "self-observation:skipped:markers_unavailable"];
  }
  const existingMarkers = existing
    .flatMap((body) => {
      const found = body.match(/<!-- sentinel:self-observation:[^>]*-->/g);
      return found ?? [];
    });
  const planned = planSelfObservations({
    failures,
    existingMarkers,
    maxIssues: SELF_DEFECT_MAX_ISSUES_PER_PASS,
  });
  for (const issue of planned) {
    let number: number | null = null;
    try {
      number = await observation.fileIssue({
        title: issue.title,
        body: issue.body,
      });
    } catch {
      number = null;
    }
    actions.push(
      number === null
        ? `self-observation:refused:${issue.key}`
        : `self-observation:filed:${number}:${issue.occurrences}x`,
    );
  }
  if (actions.length === 0) actions.push("self-observation:no_change");
  return actions;
}
