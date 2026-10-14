// client hosted execution.

import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
  HostedNotStartedProofV1,
} from "../contracts/hosted-supervisor.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { tryParse } from "../contracts/validation.ts";
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS,
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  parseHostedExecutionIntentV1,
  parseHostedNotStartedProofV1,
  parseHostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import { createDeadline, type DeadlineV1 } from "./http.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { HttpResponseV1 } from "./http.ts";
import { GitHubClientHostedRevisions } from "./client-hosted-revisions.ts";
import {
  ACTIONS_RELEASE_LOG_MAX_BYTES,
  HOSTED_EXECUTION_JOBS_PAGE_SIZE,
  HOSTED_EXECUTION_MAX_JOBS,
  HOSTED_EXECUTION_METADATA,
  HOSTED_EXECUTION_READ_DEADLINE_MS,
  HOSTED_EXECUTION_REDIRECT,
  HOSTED_EXECUTION_SCOPE,
  HOSTED_EXECUTION_UNAVAILABLE,
} from "./client-hosted-policy.ts";
import {
  nextLinkUrl,
  parseWire,
  parseWith,
  repoPath,
} from "./client-response.ts";
import {
  parseHostedAttempt,
  parseHostedJobs,
  parseHostedJobsPage,
  validHostedJobsNext,
} from "./client-hosted-job-wire.ts";
import { type HostedJobsV1, sha256Hex } from "./client-hosted-revision-wire.ts";
import {
  HOSTED_EXECUTION_TERMINAL,
  HOSTED_EXECUTION_TERMINAL_LOOKING,
  parseHostedRuntimeTerminalLog,
  trustedActionsLogUrl,
} from "./client-hosted-log-wire.ts";

export abstract class GitHubClientHostedExecution
  extends GitHubClientHostedRevisions {
  /**
   * Exact authenticated settlement of one saved hosted execution intent:
   * attempt + complete paginated jobs listing + (for a completed runtime step)
   * the trusted signed job log carrying exactly one runtime terminal. A missing
   * or not-yet-complete repair job is `null` (pending); an exact completed
   * skip/cancellation/timeout/absence is an explicit not_started settlement.
   * Nothing is inferred from a green workflow alone, and a job that published
   * no terminal is never health and never a failure.
   */
  async readHostedExecution(
    intent: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>> {
    if (!this.isHostedSelfScope()) {
      return portError("invalid", HOSTED_EXECUTION_SCOPE);
    }
    const parsedIntent = tryParse(parseHostedExecutionIntentV1, intent);
    if (!parsedIntent.ok) return portError("invalid", HOSTED_EXECUTION_SCOPE);
    const saved = parsedIntent.value;
    const deadline = createDeadline(HOSTED_EXECUTION_READ_DEADLINE_MS);
    try {
      const repo = repoPath(this.repository);
      const attemptRaw = await this.actionsReleaseGet(
        `/repos/${repo}/actions/runs/${saved.runId}/attempts/${saved.runAttempt}`,
        {},
        deadline,
      );
      if (!attemptRaw.ok) return attemptRaw;
      const observedAt = this.options.clock.now();
      const attempt = parseWith(
        attemptRaw.value,
        (value) => parseHostedAttempt(value, saved, observedAt),
      );
      if (!attempt.ok) return attempt;
      const jobs = await this.readHostedAttemptJobs(saved, deadline);
      if (!jobs.ok) return jobs;
      const evidenceDigest = await sha256Hex(
        canonicalStringify({
          attempt: attemptRaw.value,
          jobs: jobs.value.raw,
        }),
      );
      const repair = jobs.value.repair;
      if (repair === null) {
        if (
          attempt.value.status !== "completed" ||
          attempt.value.completedAt === null
        ) {
          return portOk(null);
        }
        return this.hostedNotStarted(
          saved,
          null,
          attempt.value.completedAt,
          evidenceDigest,
        );
      }
      if (repair.status !== "completed" || repair.completedAt === null) {
        return portOk(null);
      }
      // A completed repair job whose conclusion is `skipped`, `cancelled` or
      // `timed_out` published no runtime terminal: the step never produced one
      // or was killed before it could. The only honest settlement is an
      // explicit no-execution proof. Claiming health would be a fabrication and
      // claiming failure would trigger a rollback for work that never ran;
      // returning `unavailable` instead would strand the pointer's saved
      // execution forever, because no later observation of that exact job can
      // ever produce a terminal.
      if (
        repair.conclusion === "skipped" ||
        repair.conclusion === "cancelled" ||
        repair.conclusion === "timed_out"
      ) {
        return this.hostedNotStarted(
          saved,
          repair.id,
          repair.completedAt,
          evidenceDigest,
        );
      }
      const step = repair.runtimeStep;
      if (step === null) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      if (step.status === "completed" && step.conclusion === "skipped") {
        return this.hostedNotStarted(
          saved,
          repair.id,
          repair.completedAt,
          evidenceDigest,
        );
      }
      if (repair.conclusion !== "success" && repair.conclusion !== "failure") {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      const interrupted = repair.conclusion === "failure" &&
        step.conclusion === "cancelled";
      if (
        interrupted &&
        (attempt.value.status !== "completed" || !jobs.value.allCompleted)
      ) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      if (
        step.status !== "completed" ||
        (!interrupted && step.conclusion !== "success" &&
          step.conclusion !== "failure") ||
        repair.startedAt === null || step.startedAt === null ||
        step.completedAt === null
      ) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      // Actual (non-skipped) metadata must be coherent and not future.
      const tolerance = HOSTED_ACTIONS_CLOCK_TOLERANCE_MS;
      if (
        step.startedAt + tolerance < repair.startedAt ||
        step.completedAt > repair.completedAt + tolerance ||
        repair.completedAt > observedAt + tolerance ||
        step.completedAt > observedAt + tolerance
      ) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      const log = await this.readHostedRuntimeLog(repair.id, deadline);
      if (!log.ok) return log;
      const parsedTerminal = parseHostedRuntimeTerminalLog(
        log.value,
        saved,
        repair,
        step,
        observedAt,
      );
      // A runtime step that STARTED and then failed or was interrupted without
      // publishing any terminal is an explicit, observable failure of that
      // exact execution: the child ran and died before it could emit one.
      // Returning unavailable here would strand the pointer's saved execution
      // forever, because no later observation of that completed job can ever
      // produce a terminal. Only the no-terminal case is rewritten, and only
      // when failure/interruption has coherent timestamps; every
      // other metadata fault stays unavailable.
      if (
        !parsedTerminal.ok &&
        parsedTerminal.error.detail === HOSTED_EXECUTION_TERMINAL &&
        (step.conclusion === "failure" || interrupted) &&
        !HOSTED_EXECUTION_TERMINAL_LOOKING.test(log.value) &&
        repair.startedAt !== null && step.startedAt !== null &&
        step.completedAt !== null && repair.completedAt !== null &&
        step.startedAt + tolerance >= repair.startedAt &&
        step.completedAt <= repair.completedAt + tolerance &&
        repair.completedAt <= observedAt + tolerance &&
        step.completedAt <= observedAt + tolerance
      ) {
        return parseWith({
          execution: saved,
          workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
          workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
          repository: HOSTED_SUPERVISOR_REPOSITORY,
          ref: HOSTED_SUPERVISOR_REF,
          jobId: repair.id,
          startedAt: repair.startedAt,
          finishedAt: repair.completedAt,
          observedAt,
          outcome: "failed",
          startupReady: false,
          settled: true,
          baseSha: null,
          terminalAt: step.completedAt,
          logDigest: await sha256Hex(log.value),
        }, parseHostedRunProofV1);
      }
      // Cancelled-step evidence is admitted only by the no-terminal failure
      // path above. Any terminal-looking record contradicts that interruption.
      if (interrupted) {
        return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
      }
      if (!parsedTerminal.ok) return parsedTerminal;
      const terminal = parsedTerminal.value.terminal;
      // A healthy terminal with a failed job or runtime step is contradictory:
      // it is never rewritten into a failed proof.
      if (
        terminal.outcome === "healthy" &&
        (repair.conclusion !== "success" || step.conclusion !== "success")
      ) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      return parseWith({
        execution: saved,
        workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
        workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
        repository: HOSTED_SUPERVISOR_REPOSITORY,
        ref: HOSTED_SUPERVISOR_REF,
        jobId: repair.id,
        startedAt: repair.startedAt,
        finishedAt: repair.completedAt,
        observedAt,
        outcome: terminal.outcome === "healthy" ? "healthy" : "failed",
        startupReady: terminal.startupReady,
        settled: true,
        baseSha: terminal.baseSha,
        terminalAt: parsedTerminal.value.terminalAt,
        logDigest: await sha256Hex(log.value),
      }, parseHostedRunProofV1);
    } catch {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    } finally {
      deadline.dispose();
    }
  }

  protected hostedNotStarted(
    intent: HostedExecutionIntentV1,
    jobId: number | null,
    finishedAt: number,
    evidenceDigest: string,
  ): PortResultV1<HostedNotStartedProofV1> {
    return parseWith({
      execution: intent,
      workflowId: HOSTED_SUPERVISOR_WORKFLOW_ID,
      workflowPath: HOSTED_SUPERVISOR_WORKFLOW_PATH,
      repository: HOSTED_SUPERVISOR_REPOSITORY,
      ref: HOSTED_SUPERVISOR_REF,
      jobId,
      finishedAt,
      observedAt: this.options.clock.now(),
      outcome: "not_started",
      evidenceDigest,
    }, parseHostedNotStartedProofV1);
  }

  /** Complete native attempt listing; every page shares the same deadline. */
  protected async readHostedAttemptJobs(
    intent: HostedExecutionIntentV1,
    deadline: DeadlineV1,
  ): Promise<
    PortResultV1<{ raw: unknown } & HostedJobsV1>
  > {
    const path = `/repos/${
      repoPath(this.repository)
    }/actions/runs/${intent.runId}/attempts/${intent.runAttempt}/jobs`;
    const pages: unknown[] = [];
    const jobs: unknown[] = [];
    let total: number | null = null;
    const maxPages = Math.ceil(
      HOSTED_EXECUTION_MAX_JOBS / HOSTED_EXECUTION_JOBS_PAGE_SIZE,
    );
    for (let page = 1; page <= maxPages; page++) {
      if (deadline.fired()) return this.hostedExecutionTimeout();
      const response = await this.request(
        "GET",
        path,
        {
          per_page: String(HOSTED_EXECUTION_JOBS_PAGE_SIZE),
          page: String(page),
        },
        deadline,
      );
      if (!response.ok) return response;
      if (response.value.status !== 200) {
        return portError(...this.mapError(response.value));
      }
      const parsed = parseWire(response.value, parseHostedJobsPage);
      if (!parsed.ok) return parsed;
      if (total === null) total = parsed.value.total;
      if (
        total !== parsed.value.total ||
        parsed.value.jobs.length !== Math.min(
            HOSTED_EXECUTION_JOBS_PAGE_SIZE,
            total - jobs.length,
          )
      ) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      pages.push(JSON.parse(response.value.bodyText));
      jobs.push(...parsed.value.jobs);
      const link = response.value.headers.get("link") ?? "";
      if ([...link.matchAll(/;\s*rel="next"/g)].length > 1) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
      const next = nextLinkUrl(response.value.headers);
      if (jobs.length === total) {
        if (next !== null) {
          return portError("unavailable", HOSTED_EXECUTION_METADATA);
        }
        const complete = parseWith(
          { total_count: total, jobs },
          (value) => parseHostedJobs(value, intent),
        );
        if (!complete.ok) return complete;
        return portOk({
          raw: pages.length === 1 ? pages[0] : pages,
          ...complete.value,
        });
      }
      if (
        next === null ||
        !validHostedJobsNext(this.apiBaseUrl, path, next, page + 1)
      ) {
        return portError("unavailable", HOSTED_EXECUTION_METADATA);
      }
    }
    return portError("unavailable", HOSTED_EXECUTION_METADATA);
  }

  /** Trusted signed job log, bounded and read without any credential. */
  protected async readHostedRuntimeLog(
    jobId: number,
    deadline: DeadlineV1,
  ): Promise<PortResultV1<string>> {
    if (deadline.fired()) return this.hostedExecutionTimeout();
    const raw = await this.sendCore(
      "GET",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/actions/jobs/${jobId}/logs`,
      null,
      "manual",
      deadline,
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    }
    if (raw.response.status !== 302) {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    }
    const location = raw.response.headers.get("location");
    if (location === null) {
      return portError("unavailable", HOSTED_EXECUTION_REDIRECT);
    }
    const signedUrl = trustedActionsLogUrl(location);
    if (signedUrl === null) {
      return portError("unavailable", HOSTED_EXECUTION_REDIRECT);
    }
    if (deadline.fired()) return this.hostedExecutionTimeout();
    let logResponse: HttpResponseV1;
    try {
      const signedCall = Promise.resolve().then(() =>
        this.options.http({
          method: "GET",
          url: signedUrl,
          headers: new Map<string, string>(),
          body: null,
          redirect: "error",
        })
      );
      signedCall.catch(() => {});
      logResponse = await deadline.race(signedCall);
    } catch {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    }
    if (logResponse.status !== 200) {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    }
    if (
      new TextEncoder().encode(logResponse.bodyText).length >
        ACTIONS_RELEASE_LOG_MAX_BYTES
    ) {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    }
    return portOk(logResponse.bodyText);
  }
}
