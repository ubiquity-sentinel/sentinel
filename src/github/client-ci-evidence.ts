/**
 * Trusted, read-only collector of CI failure evidence for one candidate head
 * of the client's own target repository (generation 81).
 *
 * Every API path is `/repos/{target}/...` through `sendCore`, so the durable
 * cooldown gate, the authorization header and the per-request deadline apply
 * exactly as for every other read, and a matrix cell's gate records nothing.
 * Per failing check: identity (name, conclusion, app), and for an Actions job
 * the workflow (name and file path), the job and its failing steps, the
 * check-run annotations and a bounded excerpt of the job log, read through the
 * signed-log redirect with the fixed trusted host check and no credential.
 * Another app's check run contributes its output and annotations; a commit
 * status its description. Requests, bytes and time are bounded, the method
 * never throws, and any failure degrades to a reason code with whatever was
 * already collected.
 */
import { isGitSha } from "../contracts/brands.ts";
import type { HttpResponseV1 } from "./http.ts";
import { createDeadline, type DeadlineV1 } from "./http.ts";
import { GitHubClientNativeCi } from "./client-native-ci.ts";
import { repoPath } from "./client-response.ts";
import { trustedActionsLogUrl } from "./client-hosted-log-wire.ts";
import {
  type CheckRunWireV1,
  type JobWireV1,
  parseAnnotationsWire,
  parseCheckRunsPageWire,
  parseJobWire,
  parseRunWire,
  parseStatusesWire,
  type RunWireV1,
} from "./client-ci-evidence-wire.ts";
import {
  baseCheck,
  evidenceText,
  failuresFirst,
  output,
  statusReason,
} from "./client-ci-evidence-shape.ts";
import {
  readSignedCiLog,
  type SignedLogReadV1,
} from "./client-ci-evidence-log.ts";
import { excerptFromLog } from "../repair/ci-evidence-excerpt.ts";
import { applyBackupCiEvidence } from "./client-ci-evidence-backup.ts";
import { classifyCheck, extractHints } from "../repair/ci-evidence-classify.ts";
import { ciExcerptShare } from "../repair/ci-evidence-render.ts";
import {
  type CiAnnotationV1,
  type CiCheckEvidenceV1,
  type CiEvidenceReaderV1,
  type CiEvidenceReadInputV1,
  type CiEvidenceReasonV1,
  type CiEvidenceV1,
  type CiFailingStepV1,
  emptyCiEvidence,
  MAX_CI_EVIDENCE_CHECKS,
  MAX_CI_EVIDENCE_COLLECTION_MS,
  MAX_CI_EVIDENCE_REQUESTS,
  MAX_CI_FAILING_STEPS,
  MAX_CI_LOG_CHECKS,
} from "../repair/ci-evidence-types.ts";

const CHECK_PAGES = 3;
const PAGE_SIZE = 100;
const ANNOTATION_PAGE = 50;
const ACTIONS_APP = "github-actions";
/** Failing check-run conclusions, most relevant first. */
const FAILING = [
  "failure",
  "timed_out",
  "startup_failure",
  "cancelled",
  "action_required",
  "stale",
];
const FAILING_STEP = ["failure", "timed_out", "cancelled", "startup_failure"];

type Got =
  | { ok: true; response: HttpResponseV1 }
  | { ok: false; reason: CiEvidenceReasonV1 };

interface CollectionV1 {
  head: string;
  deadline: DeadlineV1;
  requests: number;
  runs: Map<number, RunWireV1 | null>;
  /** A rate limit stops every later API read of this collection. */
  stopped: CiEvidenceReasonV1 | null;
}

export abstract class GitHubClientCiEvidence extends GitHubClientNativeCi
  implements CiEvidenceReaderV1 {
  async readCiFailureEvidence(
    input: CiEvidenceReadInputV1,
  ): Promise<CiEvidenceV1> {
    if (!isGitSha(input.head) || !isGitSha(input.base)) {
      return emptyCiEvidence(input.head, input.base, "malformed");
    }
    const bound = Number.isFinite(input.deadlineMs)
      ? Math.max(1, Math.min(input.deadlineMs, MAX_CI_EVIDENCE_COLLECTION_MS))
      : 1;
    const collection: CollectionV1 = {
      head: input.head,
      deadline: createDeadline(bound),
      requests: 0,
      runs: new Map(),
      stopped: null,
    };
    const evidence = emptyCiEvidence(input.head, input.base, null);
    try {
      await this.collectCiEvidence(input, collection, evidence);
    } catch {
      evidence.unavailable = collection.deadline.fired()
        ? "timeout"
        : "unavailable";
    } finally {
      collection.deadline.dispose();
    }
    return evidence;
  }

  private async collectCiEvidence(
    input: CiEvidenceReadInputV1,
    collection: CollectionV1,
    evidence: CiEvidenceV1,
  ): Promise<void> {
    const runs: CheckRunWireV1[] = [];
    for (let page = 1; page <= CHECK_PAGES; page++) {
      const got = await this.ciGet(
        collection,
        `/commits/${input.head}/check-runs`,
        { per_page: String(PAGE_SIZE), page: String(page), filter: "latest" },
      );
      const body = this.ciBody(got, false);
      if (!body.ok) {
        evidence.unavailable = body.reason;
        return;
      }
      const parsed = parseCheckRunsPageWire(body.value);
      runs.push(...parsed.runs.filter((run) => run.headSha === input.head));
      if (parsed.runs.length < PAGE_SIZE || runs.length >= parsed.total) break;
    }
    const latest = new Map<string, CheckRunWireV1>();
    for (const run of runs) {
      const previous = latest.get(run.name);
      if (
        previous === undefined ||
        (run.startedAt ?? -1) > (previous.startedAt ?? -1)
      ) latest.set(run.name, run);
    }
    const prefer = input.prefer ?? (() => false);
    const rank = (run: CheckRunWireV1) =>
      (prefer(run.name) ? 0 : 100) + FAILING.indexOf(run.conclusion ?? "");
    const failing = [...latest.values()]
      .filter((run) =>
        run.status === "completed" && FAILING.includes(run.conclusion ?? "")
      )
      .sort((a, b) => rank(a) - rank(b));
    const statuses = await this.ciFailingStatuses(collection, input.head);
    const total = failing.length + statuses.length;
    const selected = failing.slice(0, MAX_CI_EVIDENCE_CHECKS);
    const statusRoom = MAX_CI_EVIDENCE_CHECKS - selected.length;
    const shownStatuses = statuses.slice(0, Math.max(0, statusRoom));
    evidence.omittedChecks = total - selected.length - shownStatuses.length;
    const count = selected.length + shownStatuses.length;
    if (count === 0) {
      evidence.unavailable = "no_failing_checks";
      return;
    }
    let logs = 0;
    for (const run of selected) {
      if (collection.deadline.fired() || collection.stopped !== null) {
        // Out of time or rate limited: count the unreached checks, invent none.
        evidence.unavailable = collection.stopped ?? "timeout";
        evidence.omittedChecks += count - evidence.checks.length;
        return;
      }
      const actions = run.app === ACTIONS_APP;
      const withLog = actions && logs < MAX_CI_LOG_CHECKS;
      if (withLog) logs++;
      evidence.checks.push(
        actions
          ? await this.ciActionsCheck(collection, run, count, withLog)
          : await this.ciExternalCheck(collection, run),
      );
    }
    for (const status of shownStatuses) {
      const check = baseCheck(status.context, status.state, null);
      check.output = output("", status.description, "");
      const label = classifyCheck({
        conclusion: status.state,
        external: true,
        failingSteps: null,
        log: null,
      });
      check.classification = label.classification;
      check.classificationReason = label.reason;
      evidence.checks.push(check);
    }
    // A red backup stand-in's receipt evidence (docs/backup-ci-spec.md §11.7).
    await applyBackupCiEvidence(
      this.backupCiReads(),
      input.head,
      selected,
      evidence,
      collection.deadline,
    );
    if (collection.stopped !== null) evidence.unavailable = collection.stopped;
  }

  private async ciFailingStatuses(
    collection: CollectionV1,
    head: string,
  ) {
    // Best effort: a credential without commit-status read just has none.
    const got = await this.ciGet(collection, `/commits/${head}/statuses`, {
      per_page: String(PAGE_SIZE),
    });
    const body = this.ciBody(got, false);
    if (!body.ok) return [];
    try {
      const seen = new Set<string>();
      return parseStatusesWire(body.value).filter((status) => {
        // Newest first: only each context's latest state counts.
        if (seen.has(status.context)) return false;
        seen.add(status.context);
        return status.state === "failure" || status.state === "error";
      });
    } catch {
      return [];
    }
  }

  private async ciActionsCheck(
    collection: CollectionV1,
    run: CheckRunWireV1,
    count: number,
    withLog: boolean,
  ): Promise<CiCheckEvidenceV1> {
    const check = baseCheck(run.name, run.conclusion ?? "", run.app);
    let job: JobWireV1 | null = null;
    let failingSteps: CiFailingStepV1[] | null = null;
    const jobBody = this.ciBody(
      await this.ciGet(collection, `/actions/jobs/${run.id}`),
      true,
    );
    if (!jobBody.ok) {
      check.unavailable = jobBody.reason;
    } else {
      const parsed = this.ciParse(() => parseJobWire(jobBody.value));
      if (parsed === null) check.unavailable = "malformed";
      else if (parsed.id !== run.id || parsed.headSha !== collection.head) {
        check.unavailable = "head_mismatch";
      } else {
        job = parsed;
        check.job = { id: parsed.id, name: evidenceText(parsed.name) };
        failingSteps = parsed.steps
          .filter((step) => FAILING_STEP.includes(step.conclusion ?? ""))
          .slice(0, MAX_CI_FAILING_STEPS)
          .map((step) => ({
            number: step.number,
            name: evidenceText(step.name),
            conclusion: evidenceText(step.conclusion ?? ""),
          }));
        check.failingSteps = failingSteps;
        const workflow = withLog
          ? await this.ciRun(collection, parsed.runId)
          : null;
        const workflowName = workflow?.name ?? parsed.workflowName;
        if (workflowName !== null) {
          check.workflow = {
            name: evidenceText(workflowName),
            path: workflow?.path === null || workflow?.path === undefined
              ? null
              : evidenceText(workflow.path),
          };
        }
      }
    }
    check.annotations = await this.ciAnnotations(collection, run.id);
    let log = null;
    if (withLog && job !== null) {
      const read = await this.ciJobLog(collection, job);
      log = read.log;
      check.truncatedScan = read.truncated;
      if (read.reason !== null) check.unavailable = read.reason;
      if (read.reason === "rate_limited") collection.stopped = read.reason;
      if (log !== null) {
        check.hints = extractHints(log.steps);
        const excerpt = excerptFromLog(log, ciExcerptShare(check, count));
        if (excerpt !== null) {
          check.excerpt = excerpt.text;
          check.excerptLines = { kept: excerpt.kept, total: excerpt.total };
        }
      }
    }
    const label = classifyCheck({
      conclusion: run.conclusion ?? "",
      external: false,
      failingSteps,
      log,
    });
    check.classification = label.classification;
    check.classificationReason = label.reason;
    return check;
  }

  private async ciExternalCheck(
    collection: CollectionV1,
    run: CheckRunWireV1,
  ): Promise<CiCheckEvidenceV1> {
    const check = baseCheck(run.name, run.conclusion ?? "", run.app);
    check.output = output(
      run.output.title,
      run.output.summary,
      run.output.text,
    );
    check.annotations = await this.ciAnnotations(collection, run.id);
    const label = classifyCheck({
      conclusion: run.conclusion ?? "",
      external: true,
      failingSteps: null,
      log: null,
    });
    check.classification = label.classification;
    check.classificationReason = label.reason;
    return check;
  }

  private async ciRun(
    collection: CollectionV1,
    runId: number,
  ): Promise<RunWireV1 | null> {
    if (collection.runs.has(runId)) return collection.runs.get(runId) ?? null;
    const body = this.ciBody(
      await this.ciGet(collection, `/actions/runs/${runId}`),
      true,
    );
    const run = body.ok ? this.ciParse(() => parseRunWire(body.value)) : null;
    const trusted = run !== null && run.id === runId &&
        run.headSha === collection.head
      ? run
      : null;
    collection.runs.set(runId, trusted);
    return trusted;
  }

  private async ciAnnotations(
    collection: CollectionV1,
    checkRunId: number,
  ): Promise<CiAnnotationV1[]> {
    const body = this.ciBody(
      await this.ciGet(collection, `/check-runs/${checkRunId}/annotations`, {
        per_page: String(ANNOTATION_PAGE),
      }),
      false,
    );
    if (!body.ok) return [];
    return failuresFirst(
      this.ciParse(() => parseAnnotationsWire(body.value)) ?? [],
    );
  }

  private async ciJobLog(
    collection: CollectionV1,
    job: JobWireV1,
  ): Promise<SignedLogReadV1> {
    const got = await this.ciGet(
      collection,
      `/actions/jobs/${job.id}/logs`,
      {},
      "manual",
    );
    if (!got.ok) {
      return {
        log: null,
        truncated: false,
        reason: got.reason === "forbidden"
          ? "forbidden_actions_read"
          : got.reason,
      };
    }
    const status = got.response.status;
    if (status !== 302) {
      return {
        log: null,
        truncated: false,
        reason: status >= 300 && status < 400
          ? "untrusted_redirect"
          : status === 200
          ? "malformed"
          : statusReason(status, true),
      };
    }
    const location = got.response.headers.get("location");
    const signed = location === null ? null : trustedActionsLogUrl(location);
    if (signed === null) {
      return {
        log: null,
        truncated: false,
        reason: "untrusted_redirect",
      };
    }
    return await readSignedCiLog({
      http: this.options.http,
      url: signed,
      deadline: collection.deadline,
      failedSteps: job.steps.flatMap((step) =>
        FAILING_STEP.includes(step.conclusion ?? "") &&
          step.startedAt !== null && step.completedAt !== null &&
          step.completedAt >= step.startedAt
          ? [{
            name: step.name,
            startedAt: step.startedAt,
            completedAt: step.completedAt,
          }]
          : []
      ).slice(0, MAX_CI_FAILING_STEPS),
      takeRequest: () => {
        if (collection.requests >= MAX_CI_EVIDENCE_REQUESTS) return false;
        collection.requests++;
        return true;
      },
    });
  }

  private ciParse<T>(parse: () => T): T | null {
    try {
      return parse();
    } catch {
      return null;
    }
  }

  /** One JSON 200 body, or the reason it is not available. */
  private ciBody(
    got: Got,
    actions: boolean,
  ): { ok: true; value: unknown } | { ok: false; reason: CiEvidenceReasonV1 } {
    if (!got.ok) {
      return {
        ok: false,
        reason: actions && got.reason === "forbidden"
          ? "forbidden_actions_read"
          : got.reason,
      };
    }
    if (got.response.status !== 200) {
      return { ok: false, reason: statusReason(got.response.status, actions) };
    }
    try {
      return { ok: true, value: JSON.parse(got.response.bodyText) };
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }

  /** One repository-scoped, gated, credentialed GET within the bounds. */
  private async ciGet(
    collection: CollectionV1,
    path: string,
    query: Record<string, string> = {},
    redirect?: "manual",
  ): Promise<Got> {
    if (collection.deadline.fired()) return { ok: false, reason: "timeout" };
    if (collection.stopped !== null) {
      return { ok: false, reason: collection.stopped };
    }
    if (collection.requests >= MAX_CI_EVIDENCE_REQUESTS) {
      return { ok: false, reason: "request_bound" };
    }
    collection.requests++;
    const queryText = new URLSearchParams(query).toString();
    const raw = await this.sendCore(
      "GET",
      `${this.apiBaseUrl}/repos/${repoPath(this.repository)}${path}${
        queryText.length === 0 ? "" : `?${queryText}`
      }`,
      null,
      redirect,
      collection.deadline,
    );
    if (raw.status === "response") {
      // An unclassified 429 is still a rate limit: nothing more is asked.
      if (raw.response.status === 429) collection.stopped = "rate_limited";
      return { ok: true, response: raw.response };
    }
    if (collection.deadline.fired() || raw.status === "lost") {
      return {
        ok: false,
        reason: collection.deadline.fired() ? "timeout" : "unavailable",
      };
    }
    const kind = raw.error.kind;
    if (kind === "rate_limited") collection.stopped = "rate_limited";
    return {
      ok: false,
      reason: kind === "rate_limited"
        ? "rate_limited"
        : kind === "auth_failed"
        ? "forbidden"
        : kind === "not_found"
        ? "not_found"
        : "unavailable",
    };
  }
}
