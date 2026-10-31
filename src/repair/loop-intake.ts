import { reconcileExistingPrs } from "./loop-existing-pr.ts";
/** Repair loop internals: intake. */
import type { GitSha } from "../contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type {
  IssueSourceErrorContextV1,
  SkippedIssueV1,
} from "../contracts/ports.ts";
import {
  issueSourceFailureDetail,
  sanitizeIssueSourceContext,
  sanitizeSkippedIssue,
} from "../github/client-response.ts";
import { candidateBranch } from "./keys.ts";
import { isCiOutageNotice } from "./ci-outage-notice.ts";
import {
  checkGithubCooldown,
  createRunBounds,
  INCIDENT_PAGE_LIMIT,
  MAX_INCIDENT_SCAN_PAGES,
} from "./loop-bounds.ts";
import { sameRepositoryIdentity, summaryChanged } from "./loop-records.ts";
import {
  loadSnapshot,
  persistTransition,
  synchronizeSnapshot,
} from "./loop-state.ts";
import { readBase } from "./loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  RepairCycleOptionsV1,
  RepairCycleOutcomeV1,
  StepResultV1,
} from "./loop-types.ts";
import { rankEligibleWork } from "./selection.ts";
import {
  applyIncidentSummary,
  assignTarget,
  createIncidentWork,
  createIssueWork,
} from "./transitions.ts";

/** True when every configured target reads its work from GitHub issues alone. */
export function isIssueOnlyIntake(
  configs: RepairCycleDepsV1["configs"],
): boolean {
  return configs.length > 0 &&
    configs.every((config) => config.adapter.kind === "github");
}

/** Matrix intake only: discover sources and assign fresh branches without dispatching lifecycle work. */
export async function prepareMatrixIntakeV1(
  deps: RepairCycleDepsV1,
  options: RepairCycleOptionsV1,
): Promise<RepairCycleOutcomeV1> {
  const bounds = createRunBounds(deps, options);
  if (deps.clock.now() >= bounds.runDeadline) {
    return { status: "margin", detail: "matrix intake deadline reached" };
  }
  const context = await loadSnapshot(deps, bounds);
  if (context === null) {
    return { status: "state_error", detail: "repair state unavailable" };
  }
  if (deps.clock.now() >= bounds.runDeadline) {
    return {
      status: "margin",
      detail: "matrix intake deadline reached during state read",
    };
  }
  const intake = await pollIntake(deps, context);
  if (intake.result.kind === "state_error") {
    return { status: "state_error", detail: intake.result.detail };
  }
  const synchronized = await synchronizeSnapshot(deps, context);
  if (synchronized.status !== "ok") {
    return {
      status: "state_error",
      detail: "matrix intake state moved or is unavailable",
    };
  }
  if (deps.clock.now() >= bounds.runDeadline) {
    return {
      status: "margin",
      detail: "matrix intake deadline reached after source reads",
    };
  }
  const takeoverAttempted = new Set<string>();
  const takeoverRefused = new Set<string>();
  for (;;) {
    const takeover = await reconcileExistingPrs(
      deps,
      context,
      takeoverAttempted,
      takeoverRefused,
    );
    if (takeover === null) break;
    if (takeover.kind === "state_error") {
      return { status: "state_error", detail: takeover.detail };
    }
    if (deps.clock.now() >= bounds.runDeadline) {
      return {
        status: "margin",
        detail: "existing PR intake deadline reached",
      };
    }
  }
  const ranked = rankEligibleWork(
    context.snapshot,
    deps.configs,
    deps.clock.now(),
  );
  const freshIds = new Set(ranked.ordered.filter((id) => {
    if (takeoverRefused.has(id)) return false;
    const record = context.snapshot.work.find((row) => row.id === id);
    return record !== undefined && record.source.kind === "issue" &&
      record.nextStep === "work" && record.intent === null &&
      record.target.branch === null && record.target.head === null &&
      (record.target.candidateState === undefined ||
        record.target.candidateState.preserved !== null);
  }));
  if (freshIds.size > 0) {
    const assigned = await persistTransition(deps, context, (draft) => {
      draft.work = draft.work.map((record) =>
        freshIds.has(record.id)
          ? assignTarget(record, {
            base: record.target.base,
            branch: candidateBranch(record.id),
          }, deps.clock.now())
          : record
      );
    });
    if (assigned.kind !== "progress") {
      return {
        status: "state_error",
        detail: assigned.kind === "state_error"
          ? assigned.detail
          : "matrix branch assignment did not persist",
      };
    }
  }
  return intake.error === null
    ? { status: "idle", detail: "matrix intake prepared" }
    : { status: "source_error", detail: intake.error };
}

// ---------------------------------------------------------------------------
// Intake: deterministic incident and issue polling; a failed read is never empty.
// ---------------------------------------------------------------------------

export interface IntakeResultV1 {
  result: StepResultV1;
  changed: boolean;
  error: string | null;
  issueSource?: IssueSourceErrorContextV1;
}

/** A cooldown gate fault during intake is a state trust failure: run-terminal. */
export function intakeFault(detail: string): IntakeResultV1 {
  return {
    result: { kind: "state_error", detail },
    changed: false,
    error: detail,
  };
}

export async function pollIntake(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
): Promise<IntakeResultV1> {
  const now = deps.clock.now();
  let cursor: string | null = null;
  let error: string | null = null;
  let changed = false;
  let issueSource: IssueSourceErrorContextV1 | undefined;
  let issueListing: {
    repository: string;
    openIssues: number | null;
    skippedIssues: SkippedIssueV1[] | null;
  } | undefined;
  const reportIssues = () => {
    if (issueListing === undefined) return;
    console.log(JSON.stringify({
      kind: "sentinel_issue_intake",
      ...issueListing,
      ...(issueSource === undefined ? {} : { error: issueSource }),
    }));
  };

  const updatedWork = new Map<string, WorkRecordV1>();
  const newWork: WorkRecordV1[] = [];
  const newSummaries = new Map<
    string,
    RepairStateSnapshotV1["incidents"][number]
  >();

  // Scanner guards for this consumer: repeated cursors and an unbounded page
  // run are never normal exhaustion — they are source faults and trip the
  // existing source-error path. The run deadline alone cannot bound the scan
  // when the injected clock does not advance (frozen clock), and an empty page
  // is a real page that may legitimately continue (the producer's filtered
  // scan can return an empty slice with a continuation cursor), so it is
  // followed only under these finite guards — never converted into success.
  const seenCursors = new Set<string>();
  let pages = 0;

  // Issue-only intake: when every configured target is a GitHub issue source,
  // no incident scan is needed. Any gateway adapter keeps the existing incident
  // scan and its fail-closed source-error behavior.
  const issueOnlyIntake = isIssueOnlyIntake(deps.configs);

  for (;;) {
    // A GitHub issue-only host never scans incidents; the issue listing below
    // is its only intake source.
    if (issueOnlyIntake) break;
    // No new intake read may start at/after the total run deadline: every
    // page read is awaited wall-clock time, so the bounds are rechecked
    // between pages. A stop preserves whatever was already collected; the
    // next run resumes the same scan.
    if (deps.clock.now() >= context.bounds.runDeadline) {
      break;
    }
    if (cursor !== null) {
      if (seenCursors.has(cursor)) {
        error = "incident source cursor repeated without progress";
        break;
      }
      seenCursors.add(cursor);
    }
    pages += 1;
    if (pages > MAX_INCIDENT_SCAN_PAGES) {
      error = "incident source pagination exceeded the page bound";
      break;
    }
    const page = await deps.incidents.listUnresolvedIncidents(
      cursor,
      INCIDENT_PAGE_LIMIT,
    );
    if (!page.ok) {
      error = `incident source unavailable: ${page.error.kind}`;
      break;
    }
    for (const summary of page.value.items) {
      const existing = context.snapshot.incidents.find(
        (incident) =>
          incident.id === summary.id &&
          incident.fingerprint === summary.fingerprint &&
          sameRepositoryIdentity(incident.repository, summary.repository),
      );
      const work = context.snapshot.work.find(
        (record) =>
          record.source.kind === "incident" &&
          record.related.incidentId === summary.id &&
          record.fingerprint === summary.fingerprint &&
          sameRepositoryIdentity(record.repository, summary.repository),
      ) ?? null;
      if (existing !== null && existing !== undefined) {
        // Nondecreasing refresh of the stored summary.
        if (
          summary.lastSeenAt < existing.lastSeenAt ||
          summary.count < existing.count
        ) {
          error = "incident summary counter regression";
          continue;
        }
        if (summaryChanged(existing, summary)) {
          newSummaries.set(existing.id, summary);
          if (work !== null) {
            try {
              updatedWork.set(
                work.id,
                applyIncidentSummary(work, existing, summary, now),
              );
            } catch {
              error = "incident summary identity mismatch";
            }
          }
        }
        continue;
      }
      // New incident: a trusted base must be observed before a record is owned.
      // The page read is awaited wall-clock time: no new source read (base
      // ref) may start after the total deadline. The shared cooldown gate is
      // checked before every base read: an ordinary rate_limited denial is a
      // normal deferral (this summary is not admitted until its base is
      // observed, and no source error is fabricated); a gate fault is a state
      // trust failure which stops intake.
      if (deps.clock.now() >= context.bounds.runDeadline) {
        break;
      }
      const cooled = await checkGithubCooldown(
        deps,
        summary.repository,
        context.bounds,
      );
      if (cooled.kind === "state_error") {
        return intakeFault(cooled.detail);
      }
      if (cooled.kind === "deferred") {
        continue;
      }
      const base = await readBase(deps, summary.repository);
      if (base === null) {
        error = `base unavailable for ${summary.repository.name}`;
        continue;
      }
      newSummaries.set(summary.id, summary);
      newWork.push(createIncidentWork(summary, {
        controllerSha: deps.controllerSha,
        repository: summary.repository,
        observedBase: base,
        now,
      }));
      changed = true;
    }
    if (page.value.coverage.status === "incomplete") {
      error = "incident discovery coverage incomplete";
      break;
    }
    if (page.value.nextCursor === null) break;
    cursor = page.value.nextCursor;
  }

  // The injected GitHub port targets one configured repository. The frozen
  // GitHubIssueV1 carries no repository field, so associate its rows with the
  // sole configuration for this cycle. A multi-repository host must inject a
  // separately targeted cycle rather than guessing an issue's repository.
  const issueRepository = deps.configs.length === 1
    ? deps.configs[0].repository
    : null;
  if (
    issueRepository !== null &&
    deps.clock.now() < context.bounds.runDeadline
  ) {
    // No new issue intake read starts at/after the total deadline (the
    // incident reads above are awaited wall-clock time). The shared cooldown
    // gate is checked before issue intake: a cooling installation never calls
    // the GitHub port (not even a fake one); an ordinary rate_limited denial
    // is a normal deferral that leaves the source state untouched, and a gate
    // fault is a state trust failure that stops the run.
    const issueCooled = await checkGithubCooldown(
      deps,
      issueRepository,
      context.bounds,
    );
    if (issueCooled.kind === "state_error") {
      return intakeFault(issueCooled.detail);
    }
    if (issueCooled.kind === "ok") {
      const issues = await deps.github.listOpenIssues();
      const repository = `${issueRepository.owner}/${issueRepository.name}`;
      const skippedRows = "skippedIssues" in issues ? issues.skippedIssues : [];
      const skipped = issues.ok && Array.isArray(skippedRows)
        ? skippedRows.map((row: unknown) =>
          sanitizeSkippedIssue(row, repository)
        )
        : null;
      issueListing = {
        repository,
        openIssues: issues.ok && skipped !== null
          ? issues.value.filter((issue) => issue.state === "open").length +
            skipped.length
          : null,
        skippedIssues: skipped !== null && skipped.every((row) => row !== null)
          ? skipped as SkippedIssueV1[]
          : null,
      };
      if (!issues.ok) {
        issueSource = sanitizeIssueSourceContext(issues.error.issueSource);
        if (issueSource?.target !== repository) issueSource = undefined;
        error = issueSourceFailureDetail({ ...issues.error, issueSource });
        reportIssues();
      } else {
        reportIssues();
        const seenIssues = new Set<string>();
        const baseByRepository = new Map<string, GitSha | null>();
        for (const issue of issues.value) {
          if (issue.state !== "open") continue;
          // An App-filed CI outage notice asks the owner for billing; no
          // code change fixes it, so it is never admitted as a task.
          if (isCiOutageNotice(issue)) continue;
          const issueKey =
            `${issueRepository.owner}/${issueRepository.name}#${issue.number}`;
          if (seenIssues.has(issueKey)) continue;
          seenIssues.add(issueKey);
          const existing = context.snapshot.work.find(
            (record) =>
              record.source.kind === "issue" &&
              record.repository.owner === issueRepository.owner &&
              record.repository.name === issueRepository.name &&
              record.source.id === String(issue.number),
          );
          if (existing !== undefined) continue;

          // Issue-only (github adapter) intake checks NATIVE dependency
          // relations when available. An issue that is itself a parent (has
          // sub-issues) or has open native blockers is skipped without an
          // error; it is re-listed on the next poll once those dependencies
          // close. If relations are unavailable (GraphQL failure), the issue
          // is admitted anyway — the matrix cell's pre-start verification
          // re-reads the issue and refuses if blockers are present. This
          // prevents a GraphQL outage from starving the entire intake.
          if (issueOnlyIntake) {
            const relations = issue.relations;
            if (
              relations !== undefined &&
              (relations.subIssueCount > 0 || relations.openBlockers.length > 0)
            ) {
              continue;
            }
          }

          const repositoryKey =
            `${issueRepository.owner}/${issueRepository.name}`;
          let base = baseByRepository.get(repositoryKey);
          if (base === undefined) {
            // The issue read above is awaited wall-clock time: stop before a
            // new base-ref read after the total deadline. The gate is checked
            // before every base read; a deferral admits nothing and caches
            // nothing (the next run re-lists and re-reads).
            if (deps.clock.now() >= context.bounds.runDeadline) break;
            const baseCooled = await checkGithubCooldown(
              deps,
              issueRepository,
              context.bounds,
            );
            if (baseCooled.kind === "state_error") {
              return intakeFault(baseCooled.detail);
            }
            if (baseCooled.kind === "deferred") {
              continue;
            }
            base = await readBase(deps, issueRepository);
            baseByRepository.set(repositoryKey, base);
          }
          if (base === null) {
            error = `base unavailable for ${issueRepository.name}`;
            continue;
          }
          newWork.push(createIssueWork({
            number: issue.number,
            title: issue.title,
            labels: issue.labels,
            createdAt: issue.createdAt,
          }, {
            controllerSha: deps.controllerSha,
            repository: issueRepository,
            observedBase: base,
            now,
          }));
          changed = true;
        }
      }
    }
  }

  if (!changed && updatedWork.size === 0 && newSummaries.size === 0) {
    return {
      result: { kind: "progress" },
      changed: false,
      error,
      ...(issueSource === undefined ? {} : { issueSource }),
    };
  }

  const persisted = await persistTransition(
    deps,
    context,
    (draft) => {
      for (const summary of newSummaries.values()) {
        const index = draft.incidents.findIndex(
          (incident) => incident.id === summary.id,
        );
        if (index === -1) draft.incidents.push(summary);
        else draft.incidents[index] = summary;
      }
      for (const work of newWork) {
        if (!draft.work.some((record) => record.id === work.id)) {
          draft.work.push(work);
        }
      }
      for (const [id, work] of updatedWork) {
        const index = draft.work.findIndex((record) => record.id === id);
        if (index !== -1) draft.work[index] = work;
      }
    },
  );
  return {
    result: persisted,
    changed: changed || updatedWork.size > 0,
    error,
    ...(issueSource === undefined ? {} : { issueSource }),
  };
}
