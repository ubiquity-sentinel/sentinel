import {
  checkReviewTaskStatement,
  reviewTaskStatementDigest,
} from "../src/contracts/review-receipt.ts";
import { isGreenConclusion } from "../src/repair/ci-rejection.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  type CoverageCheckV1,
  missingExpectedChecks,
} from "../src/repair/ci-coverage.ts";
import { isGatewayVpsRepository } from "../src/repair/vps-delivery.ts";
import { HOSTED_AUTONOMY_REQUIRED_CHECK } from "./hosted-autonomy-policy.ts";
import { createHostedMismatchDispositionObservations } from "./hosted-autonomy-mismatch-github.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyHeadRunV1,
  HostedAutonomyPullV1,
  HostedSelfJobV1,
  HostedSelfRunV1,
} from "./hosted-autonomy-types.ts";
import {
  API_BASE,
  createHostedAutonomyEffect,
  createHostedAutonomyRawRead,
  createHostedAutonomyRequest,
  LISTING_PAGE_SIZE,
  MAX_COMPARE_RESPONSE_BYTES,
  readHostedCompleteListing,
  REQUEST_TIMEOUT_MS,
  RUN_LISTING_PAGE_SIZE,
} from "./hosted-autonomy-github-listing.ts";
import { createHostedFollowUpIssues } from "./hosted-autonomy-github-issues.ts";
import { createHostedRetryLabel } from "./hosted-autonomy-retry-label.ts";
import {
  classifyTipChecks,
  createHostedOutageTracker,
} from "./hosted-autonomy-outage-observation.ts";
import { completedJobNeverStarted } from "../src/github/never-started-job.ts";
import { createHostedActionsJobReads } from "./hosted-autonomy-github-jobs.ts";
import { createMergeBaseTreeChanges } from "./hosted-autonomy-github-trees.ts";
import {
  parseHostedAutonomyHeadPulls,
  parseHostedAutonomyPull,
  revisionIntegratedIntoBase,
} from "./hosted-autonomy-github-pull.ts";

/** An exact full commit id (a carried proof names nothing else). */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** GitHub's `created_at` wire format: UTC, whole or fractional seconds. */
const RUN_CREATED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * A run's `created_at` in epoch milliseconds, or null for an unknown age. Only
 * a strict UTC timestamp counts: a lenient parse (`"1"` reads as 2001) could
 * make a fresh run look old enough to settle its head.
 */
function runCreatedAt(value: unknown): number | null {
  if (typeof value !== "string" || !RUN_CREATED_AT.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * The base runs of a complete check-run listing with their check suites, for
 * the coverage rule (`missingExpectedChecks`): a run without a suite expects
 * nothing; a suite that is present but not a positive safe integer id makes
 * the listing malformed (null).
 */
function suitedChecks(
  runs: readonly Record<string, unknown>[],
): CoverageCheckV1[] | null {
  const checks: CoverageCheckV1[] = [];
  for (const run of runs) {
    const name = String(run["name"]);
    const suite = run["check_suite"];
    if (suite === undefined || suite === null) {
      checks.push({ name });
      continue;
    }
    const id = typeof suite === "object"
      ? (suite as Record<string, unknown>)["id"]
      : undefined;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
      return null;
    }
    checks.push({ name, suite: id });
  }
  return checks;
}

/**
 * Live GitHub surface this helper needs, over one repository token. The
 * factory takes the target repository identity and builds EVERY REST path for
 * THAT repository: the sentinel self repository's paths are never reused as a
 * fallback for a foreign target, and no other repository name is hard-coded.
 */
/** GitHub lists at most 3000 files of a pull request (30 pages of 100). */
const PULL_FILE_PAGES = 30;

export function createHostedAutonomyGitHub(
  token: string,
  repository: RepositoryIdentityV1,
): HostedAutonomyGitHubV1 {
  const scope = `${repository.owner}/${repository.name}`;

  const request = createHostedAutonomyRequest(token);
  const jobReads = createHostedActionsJobReads(request, scope);
  const effect = createHostedAutonomyEffect(token);
  const rawRead = createHostedAutonomyRawRead(token);
  async function readPull(
    number: number,
    baseBranch: string | null,
  ): Promise<HostedAutonomyPullV1 | null> {
    const pull = await request("GET", `/repos/${scope}/pulls/${number}`);
    const parsed = parseHostedAutonomyPull(pull);
    if (parsed === null || parsed.merged !== true) return parsed;
    const mergeCommitSha = parsed.mergeCommitSha;
    if (mergeCommitSha === null) return null;
    // A merged pull whose integration point is unknown cannot be verified: it
    // reads as null rather than as an unproven merge.
    if (baseBranch === null) return null;
    let parents: string[] = [];
    let revisionOnBaseBranch = false;
    const commit = await request(
      "GET",
      `/repos/${scope}/commits/${mergeCommitSha}`,
    );
    const parentList = commit !== null && typeof commit === "object"
      ? (commit as Record<string, unknown>)["parents"]
      : null;
    if (!Array.isArray(parentList)) return null;
    parents = parentList.map((parent) =>
      typeof parent === "object" && parent !== null
        ? String((parent as Record<string, unknown>)["sha"] ?? "")
        : ""
    );
    const compare = await request(
      "GET",
      `/repos/${scope}/compare/${mergeCommitSha}...${baseBranch}`,
      undefined,
      MAX_COMPARE_RESPONSE_BYTES,
    );
    revisionOnBaseBranch = revisionIntegratedIntoBase(
      compare,
      mergeCommitSha,
    );
    // The reviewed base may have advanced before the merge landed (the owner
    // merged PRs 890/892/894/895 as a stack on 2026-10-05), so the merge's
    // first parent is not always the pull's own base commit. Prove the base
    // ancestry instead of guessing it: the same compare shape with the pull's
    // base commit as the left side.
    let baseAncestorOfRevision = false;
    if (parsed.baseSha !== null) {
      const baseCompare = await request(
        "GET",
        `/repos/${scope}/compare/${parsed.baseSha}...${mergeCommitSha}`,
        undefined,
        MAX_COMPARE_RESPONSE_BYTES,
      );
      baseAncestorOfRevision = revisionIntegratedIntoBase(
        baseCompare,
        parsed.baseSha,
      );
    }
    return {
      ...parsed,
      parents,
      revisionOnBaseBranch,
      baseAncestorOfRevision,
    };
  }

  const readCompleteListing = (
    pagePath: (page: number) => string,
    key: string,
    pageSize: number,
  ) => readHostedCompleteListing(request, pagePath, key, pageSize);
  /**
   * Complete check-run listing for exactly one commit. Every reported run must
   * be bound to the requested head: a run recorded for another commit is not
   * evidence for this head, and a page that could not be read completely makes
   * the whole listing unusable.
   */
  async function readCompleteCheckRuns(
    head: string,
  ): Promise<Record<string, unknown>[] | null> {
    const runs = await readCompleteListing(
      (page) =>
        `/repos/${scope}/commits/${head}/check-runs?per_page=${LISTING_PAGE_SIZE}&page=${page}`,
      "check_runs",
      LISTING_PAGE_SIZE,
    );
    if (runs === null) return null;
    for (const run of runs) {
      if (run["head_sha"] !== head) return null;
      if (typeof run["name"] !== "string" || run["name"].length === 0) {
        return null;
      }
      if (typeof run["status"] !== "string" || run["status"].length === 0) {
        return null;
      }
      const conclusion = run["conclusion"];
      if (conclusion !== null && typeof conclusion !== "string") return null;
    }
    return runs;
  }

  /** Complete workflow-run listing for exactly one commit. */
  const readHeadRuns = (head: string) =>
    readCompleteListing(
      (page) =>
        `/repos/${scope}/actions/runs?head_sha=${head}&per_page=${RUN_LISTING_PAGE_SIZE}&page=${page}`,
      "workflow_runs",
      RUN_LISTING_PAGE_SIZE,
    );

  return {
    mismatchDisposition: createHostedMismatchDispositionObservations(
      token,
      repository,
    ),
    async readDefaultBranch() {
      const repo = await request("GET", `/repos/${scope}`);
      if (repo === null || typeof repo !== "object") return null;
      const branch = (repo as Record<string, unknown>)["default_branch"];
      return typeof branch === "string" && branch.length > 0 ? branch : null;
    },
    async readBaseTip(branch: string) {
      const ref = await request(
        "GET",
        `/repos/${scope}/git/ref/heads/${branch}`,
      );
      if (ref === null || typeof ref !== "object") return null;
      // The response must name exactly the requested branch: a ref for another
      // branch (or one without a ref identity) is never this branch's tip.
      if ((ref as Record<string, unknown>)["ref"] !== `refs/heads/${branch}`) {
        return null;
      }
      const object = (ref as Record<string, unknown>)["object"];
      if (object === null || typeof object !== "object") return null;
      const sha = (object as Record<string, unknown>)["sha"];
      return typeof sha === "string" ? sha : null;
    },
    async hasSuccessfulCheck(head: string) {
      const runs = await readCompleteCheckRuns(head);
      // An unreadable, incomplete, drifted or malformed listing is never
      // green; the exact named check must be found on its bound head.
      if (runs === null) return false;
      return runs.some((run) =>
        run["name"] === HOSTED_AUTONOMY_REQUIRED_CHECK &&
        run["head_sha"] === head &&
        run["status"] === "completed" &&
        run["conclusion"] === "success"
      );
    },
    async hasAllChecksGreen(head: string, base?: string) {
      const runs = await readCompleteCheckRuns(head);
      // An unreadable, incomplete, drifted or malformed listing is no
      // evidence either way: unreadable (null), never green and never red.
      if (runs === null) return null;
      // Only the runs reported on the exact head count, and the listing was
      // already proven complete and bound to this head. Zero runs is not
      // green: a foreign repository's own completed CI is the only
      // deterministic signal it can supply, so a head with no CI at all is
      // never delivered, and it is not red either (no CI ran).
      if (runs.length === 0) return null;
      // Every run on that head must be completed and green (success, or a
      // job the workflow itself skipped or marked neutral), which excludes
      // anything pending, queued or failed — including a failure that only
      // the last page carries (owner directive 2026-10-24).
      const green = runs.every((run) =>
        run["head_sha"] === head &&
        run["status"] === "completed" &&
        typeof run["conclusion"] === "string" &&
        isGreenConclusion(run["conclusion"])
      );
      if (!green || base === undefined) return green;
      // The runs that exist are green; a job GitHub creates late (`needs:`)
      // must exist too, by the base's own check suites (issue #154).
      const baseRuns = await readCompleteCheckRuns(base);
      if (baseRuns === null) return null;
      const expected = suitedChecks(baseRuns);
      if (expected === null) return null;
      const reported = runs.map((run) => ({ name: String(run["name"]) }));
      return missingExpectedChecks(reported, expected).length === 0;
    },
    async failedChecks(head: string) {
      const runs = await readCompleteCheckRuns(head);
      if (runs === null) return null;
      // A job that never started (a billing stop) is no failing check.
      return await jobReads.failedCheckNames(head, runs);
    },
    runNeverStarted: (id: number, head: string) =>
      jobReads.runNeverStarted(id, head),
    readPull,
    async listPullsByHeadRef(branch: string) {
      // One bounded page filtered by GitHub to this repository's exact head
      // ref; the parser refuses a full page (unprovable completeness), a fork
      // and any item whose head ref is not exactly this branch.
      const head = encodeURIComponent(`${repository.owner}:${branch}`);
      const listing = await request(
        "GET",
        `/repos/${scope}/pulls?state=all&head=${head}&per_page=${LISTING_PAGE_SIZE}`,
      );
      return parseHostedAutonomyHeadPulls(
        listing,
        scope,
        branch,
        LISTING_PAGE_SIZE,
      );
    },
    async listPullFiles(number: number) {
      if (!Number.isSafeInteger(number) || number <= 0) return null;
      const paths: string[] = [];
      for (let page = 1; page <= PULL_FILE_PAGES; page++) {
        const body = await request(
          "GET",
          `/repos/${scope}/pulls/${number}/files?per_page=${LISTING_PAGE_SIZE}&page=${page}`,
        );
        if (!Array.isArray(body)) return null;
        for (const entry of body) {
          if (entry === null || typeof entry !== "object") return null;
          const row = entry as Record<string, unknown>;
          const filename = row["filename"];
          if (typeof filename !== "string" || filename.length === 0) {
            return null;
          }
          paths.push(filename);
          const previous = row["previous_filename"];
          if (previous !== undefined) {
            if (typeof previous !== "string" || previous.length === 0) {
              return null;
            }
            paths.push(previous);
          }
        }
        if (body.length < LISTING_PAGE_SIZE) return paths;
      }
      // GitHub's 3000-file cap: a full last page cannot prove completeness.
      return null;
    },
    async listParkedRuns(head: string) {
      // The approval listing gates the same delivery as the checks themselves,
      // so it is read completely too: a parked run on a later page must still
      // be found, and an unproven listing approves nothing.
      const runs = await readHeadRuns(head);
      if (runs === null) return [];
      return runs
        .filter((run) =>
          run["head_sha"] === head &&
          run["conclusion"] === "action_required"
        )
        .map((run) => Number(run["id"]))
        .filter((id) => Number.isSafeInteger(id) && id > 0);
    },
    async approveRun(id: number) {
      const approved = await request(
        "POST",
        `/repos/${scope}/actions/runs/${id}/approve`,
      );
      return approved !== null;
    },
    async listHeadRuns(head: string) {
      // The once-per-head re-run decision reads GitHub's own run_attempt, so
      // the listing must be complete and every run bound to this exact head
      // and well formed; anything else is unprovable and re-runs nothing. A
      // missing or malformed `created_at` is only an unknown age, which never
      // settles a head, so it does not void the listing.
      const runs = await readHeadRuns(head);
      if (runs === null) return null;
      const parsed: HostedAutonomyHeadRunV1[] = [];
      for (const run of runs) {
        const attempt = run["run_attempt"];
        const status = run["status"];
        const conclusion = run["conclusion"];
        if (
          run["head_sha"] !== head ||
          typeof attempt !== "number" || !Number.isSafeInteger(attempt) ||
          attempt < 1 || typeof status !== "string" ||
          (conclusion !== null && typeof conclusion !== "string")
        ) return null;
        // Only the CI resume pass reads these; each is present only when
        // GitHub reported it strictly (absent is unknown).
        const updatedAt = runCreatedAt(run["updated_at"]);
        const attemptStartedAt = runCreatedAt(run["run_started_at"]);
        const workflow = run["workflow_id"];
        parsed.push({
          id: run["id"] as number,
          headSha: head,
          status,
          conclusion,
          runAttempt: attempt,
          createdAt: runCreatedAt(run["created_at"]),
          ...(updatedAt === null ? {} : { updatedAt }),
          ...(attemptStartedAt === null ? {} : { attemptStartedAt }),
          ...(typeof workflow === "number" && Number.isSafeInteger(workflow) &&
              workflow > 0
            ? { workflowId: workflow }
            : {}),
        });
      }
      return parsed;
    },
    rerunFailedJobs(id: number) {
      return effect(
        "POST",
        `/repos/${scope}/actions/runs/${id}/rerun-failed-jobs`,
      );
    },
    async readIssueOpen(number: number) {
      const issue = await request("GET", `/repos/${scope}/issues/${number}`);
      if (issue === null || typeof issue !== "object") return null;
      if (
        isGatewayVpsRepository(repository) &&
        (issue as Record<string, unknown>)["number"] !== number
      ) return null;
      const state = (issue as Record<string, unknown>)["state"];
      if (state === "open") return true;
      if (state === "closed") return false;
      return null;
    },
    async readIssueTask(number: number) {
      // Trusted independent read over THIS repository's authenticated surface,
      // through the same client and auth as every other read here. Only the
      // bounded exact statement is returned: a malformed, over-bound or
      // unreadable issue is null and never authorizes anything.
      const issue = await request("GET", `/repos/${scope}/issues/${number}`);
      if (issue === null || typeof issue !== "object") return null;
      const obj = issue as Record<string, unknown>;
      const title = obj["title"];
      const rawBody = obj["body"];
      const body = typeof rawBody === "string"
        ? rawBody
        : rawBody === null
        ? ""
        : null;
      if (typeof title !== "string" || body === null) return null;
      const checked = await checkReviewTaskStatement({
        issueNumber: Number(obj["number"]),
        title,
        body,
        digest: await reviewTaskStatementDigest({
          issueNumber: Number(obj["number"]),
          title,
          body,
        }),
      });
      return checked.ok ? checked.statement : null;
    },
    async readIssueOptedOut(number: number) {
      const issue = await request("GET", `/repos/${scope}/issues/${number}`);
      if (issue === null || typeof issue !== "object" || Array.isArray(issue)) {
        return null;
      }
      const object = issue as Record<string, unknown>;
      if (
        object["number"] !== number ||
        !["open", "closed"].includes(String(object["state"])) ||
        object["pull_request"] !== undefined || !Array.isArray(object["labels"])
      ) return null;
      const body = object["body"] === null ? "" : object["body"];
      if (typeof body !== "string") return null;
      const labels: string[] = [];
      for (const label of object["labels"]) {
        if (
          label === null || typeof label !== "object" || Array.isArray(label) ||
          typeof (label as Record<string, unknown>)["name"] !== "string"
        ) return null;
        labels.push((label as Record<string, unknown>)["name"] as string);
      }
      return body.split(/\r?\n/, 1)[0].trim() === "<!-- sentinel:skip -->" ||
        labels.some((label) => label.toLowerCase() === "sentinel:skip");
    },
    async closeIssue(number: number) {
      const closed = await request(
        "PATCH",
        `/repos/${scope}/issues/${number}`,
        { state: "closed" },
      );
      if (closed === null || typeof closed !== "object") return false;
      if (
        isGatewayVpsRepository(repository) &&
        (closed as Record<string, unknown>)["number"] !== number
      ) return false;
      return (closed as Record<string, unknown>)["state"] === "closed";
    },
    selfObservation: {
      async listRuns(input: { sinceIso: string; limit: number }) {
        const runs = await request(
          "GET",
          `/repos/${scope}/actions/runs?created=${
            encodeURIComponent(
              `>=${input.sinceIso}`,
            )
          }&per_page=${Math.min(Math.max(input.limit, 1), 50)}`,
        );
        const list = runs !== null && typeof runs === "object"
          ? (runs as Record<string, unknown>)["workflow_runs"]
          : null;
        if (!Array.isArray(list)) return null;
        const parsed: HostedSelfRunV1[] = [];
        for (const item of list) {
          if (typeof item !== "object" || item === null) continue;
          const obj = item as Record<string, unknown>;
          const id = Number(obj["id"]);
          const name = obj["name"];
          const conclusion = obj["conclusion"];
          const createdAt = obj["created_at"];
          if (!Number.isSafeInteger(id) || id <= 0) continue;
          if (typeof name !== "string" || typeof createdAt !== "string") {
            continue;
          }
          parsed.push({
            id,
            name,
            conclusion: typeof conclusion === "string" ? conclusion : null,
            createdAt,
          });
        }
        return parsed;
      },
      async listJobs(runId: number) {
        const jobs = await request(
          "GET",
          `/repos/${scope}/actions/runs/${runId}/jobs?per_page=50`,
        );
        const list = jobs !== null && typeof jobs === "object"
          ? (jobs as Record<string, unknown>)["jobs"]
          : null;
        if (!Array.isArray(list)) return null;
        const parsed: HostedSelfJobV1[] = [];
        for (const item of list) {
          if (typeof item !== "object" || item === null) continue;
          const obj = item as Record<string, unknown>;
          const id = Number(obj["id"]);
          const name = obj["name"];
          const conclusion = obj["conclusion"];
          if (!Number.isSafeInteger(id) || id <= 0) continue;
          if (typeof name !== "string") continue;
          parsed.push({
            id,
            name,
            conclusion: typeof conclusion === "string" ? conclusion : null,
          });
        }
        return parsed;
      },
      async readJobLog(input: { jobId: number; maxBytes: number }) {
        // The log endpoint answers with a redirect to a pre-signed URL that
        // must NEVER receive the installation token, so the redirect is taken
        // manually and the signed URL is fetched unauthenticated.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
          const head = await fetch(
            `${API_BASE}/repos/${scope}/actions/jobs/${input.jobId}/logs`,
            {
              method: "GET",
              redirect: "manual",
              headers: {
                authorization: `Bearer ${token}`,
                accept: "application/vnd.github+json",
                "user-agent": "sentinel-hosted-autonomy",
              },
              signal: controller.signal,
            },
          );
          const location = head.headers.get("location");
          const isRedirect = head.status >= 300 && head.status < 400;
          if (isRedirect && location === null) return null;
          const target = isRedirect ? location! : null;
          if (target !== null && !target.startsWith("https://")) return null;
          const response = target === null ? head : await fetch(target, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
          });
          if (response.status < 200 || response.status >= 300) return null;
          const body = response.body;
          if (body === null) return null;
          const reader = body.getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (total < input.maxBytes) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const value = chunk.value;
            if (value === undefined) break;
            const remaining = input.maxBytes - total;
            const slice = value.byteLength > remaining
              ? value.slice(0, remaining)
              : value;
            chunks.push(slice);
            total += slice.byteLength;
            if (value.byteLength > remaining) break;
          }
          try {
            await reader.cancel();
          } catch {
            // A body that refuses cancellation is still bounded by total.
          }
          const merged = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return new TextDecoder().decode(merged);
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      },
      async listOpenIssueBodies() {
        const issues = await request(
          "GET",
          `/repos/${scope}/issues?state=open&per_page=100`,
        );
        if (!Array.isArray(issues)) return null;
        const bodies: string[] = [];
        for (const item of issues) {
          if (typeof item !== "object" || item === null) continue;
          const body = (item as Record<string, unknown>)["body"];
          if (typeof body === "string") bodies.push(body);
        }
        return bodies;
      },
      async fileIssue(
        input: { title: string; body: string; labels?: string[] },
      ) {
        const created = await request("POST", `/repos/${scope}/issues`, {
          title: input.title,
          body: input.body,
          ...(input.labels === undefined ? {} : { labels: input.labels }),
        });
        if (created === null || typeof created !== "object") return null;
        const number = Number((created as Record<string, unknown>)["number"]);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
      },
    },
    async baseAdvanced(base: string, tip: string) {
      // The reviewed base is a strict ancestor of the tip: the exact compare
      // shape of `revisionIntegratedIntoBase`, with the tip strictly ahead.
      if (base === tip) return false;
      const compare = await request(
        "GET",
        `/repos/${scope}/compare/${base}...${tip}`,
        undefined,
        MAX_COMPARE_RESPONSE_BYTES,
      );
      return compare !== null && typeof compare === "object" &&
        (compare as Record<string, unknown>)["status"] === "ahead" &&
        revisionIntegratedIntoBase(compare, base);
    },
    mergeBaseTreeChanges: createMergeBaseTreeChanges(request, scope),
    async comparePatchDigest(base: string, head: string) {
      // The merge-base diff GitHub renders for `base...head`, hashed as raw
      // bytes: the carried merge's evidence line only. Its abbreviated blob
      // ids, rename detection and "Binary files ... differ" rendering prove
      // no exact patch; `mergeBaseTreeChanges` is the proof.
      if (!COMMIT_SHA.test(base) || !COMMIT_SHA.test(head)) return null;
      const bytes = await rawRead(
        `/repos/${scope}/compare/${base}...${head}`,
        "application/vnd.github.diff",
        MAX_COMPARE_RESPONSE_BYTES,
      );
      if (bytes === null) return null;
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer,
        ),
      );
      return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
    followUpIssues: createHostedFollowUpIssues(request, repository),
    retryLabel: createHostedRetryLabel(request, repository),
    ciOutageTracker: createHostedOutageTracker(request, repository),
    async classifyTipStart(tip: string) {
      const runs = await readCompleteCheckRuns(tip);
      if (runs === null) return null;
      return classifyTipChecks(
        runs.map((run) => ({
          id: Number(run["id"]),
          name: String(run["name"]),
          status: String(run["status"]),
          conclusion: typeof run["conclusion"] === "string"
            ? run["conclusion"]
            : null,
        })),
        async (run) => {
          if (!Number.isSafeInteger(run.id) || run.id <= 0) return "unknown";
          const job = await request(
            "GET",
            `/repos/${scope}/actions/jobs/${run.id}`,
          );
          const verdict = job === null
            ? null
            : completedJobNeverStarted(job, run.id, tip);
          return verdict === true
            ? "not_started"
            : verdict === false
            ? "started"
            : "unknown";
        },
      );
    },
    async merge(number: number, head: string, message?: string) {
      const response = await request(
        "PUT",
        `/repos/${scope}/pulls/${number}/merge`,
        message === undefined
          ? { sha: head, merge_method: "merge" }
          : { sha: head, merge_method: "merge", commit_message: message },
      );
      if (response === null || typeof response !== "object") return null;
      const obj = response as Record<string, unknown>;
      const sha = obj["sha"];
      return {
        merged: obj["merged"] === true,
        sha: typeof sha === "string" ? sha : null,
      };
    },
  };
}
