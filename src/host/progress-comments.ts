/**
 * Plain-language progress comments on the issues Sentinel works on (#183).
 *
 * After each target cycle the trusted repair host compares that target's
 * work records before and after the cycle and posts one comment on the
 * source issue for every stage change, in plain words. It never runs in a
 * `matrix_cell` job, never writes state and never changes a record or the
 * cycle outcome: a failed read or post is logged and the pass moves on.
 *
 * Each comment carries a hidden marker
 * (`<!-- sentinel:progress <record id>:<stage key> -->`); a stage whose
 * marker the issue's latest Sentinel progress comment for that record already
 * carries is skipped, so retries and re-runs never duplicate.
 */
import type { Clock, GitHubCooldownGateV1 } from "../contracts/ports.ts";
import type { HttpResponseV1, HttpTransportV1 } from "../github/http.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { classifyGitHubRateLimit } from "../github/rate-limit.ts";

/** One stage of a record in plain words, with its stable change key. */
export interface ProgressStageV1 {
  readonly key: string;
  readonly words: string;
}

/** One stage change to report on a source issue. */
export interface ProgressChangeV1 {
  readonly recordId: string;
  readonly issueNumber: number;
  readonly stage: ProgressStageV1;
}

/** No more comments than this are posted for one target in one cycle. */
export const PROGRESS_COMMENTS_PER_CYCLE = 20;

/** No comment read or post starts this close to the run deadline. */
const PROGRESS_MARGIN_MS = 60_000;

/** Issue comment pages read to find the latest progress marker. */
const PROGRESS_COMMENT_PAGES = 5;

const MARKER_PREFIX = "<!-- sentinel:progress ";

/** The retirement blocker of a record whose source issue closed. */
const SOURCE_CLOSED_PREFIX = "source issue is closed";

export function progressMarker(recordId: string, key: string): string {
  return `${MARKER_PREFIX}${recordId}:${key} -->`;
}

/** No SHA longer than 10 characters and no raw field dumps in the words. */
function plain(text: string): string {
  const short = text.replace(/\b[0-9a-f]{11,64}\b/g, (sha) => sha.slice(0, 10))
    .replace(/\s+/g, " ").trim();
  return short.length > 200 ? `${short.slice(0, 197)}...` : short;
}

/** A short stable key for a blocker message (FNV-1a, 32 bits). */
function hashKey(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const WAIT_WORDS: Record<string, string> = {
  ci_pending: "waiting for CI on it",
  review_pending: "waiting for its review",
  review_quota: "waiting for a review slot",
  backoff: "waiting before it retries",
  unavailable: "waiting for GitHub to respond",
  cooldown: "waiting for a GitHub rate limit to reset",
};

/**
 * The one stage-to-words table. Null for a record with nothing to report
 * yet (an issue queued but not started) or a non-issue record.
 */
export function progressStage(record: WorkRecordV1): ProgressStageV1 | null {
  if (record.source.kind !== "issue") return null;
  const pr = record.target.pr;
  const rounds = record.counters.reviewRounds;
  if (record.nextStep === "done") {
    return pr === null
      ? { key: "done", words: "Sentinel finished its work on this issue." }
      : {
        key: `done:${pr}`,
        words: `Merged in #${pr}; this repair is done.`,
      };
  }
  if (record.nextStep === "blocked") {
    const message = record.blocker?.message ?? "no reason recorded";
    // A record retired because its issue closed says nothing on that issue.
    if (message.startsWith(SOURCE_CLOSED_PREFIX)) return null;
    const person = message.startsWith("candidate touches a protected path")
      ? " A person needs to fix this one."
      : "";
    return {
      key: `blocked:${hashKey(message)}`,
      words: `Parked: ${plain(message)}.${person}`,
    };
  }
  if (record.nextStep === "delivery") {
    return pr === null ? null : {
      key: `delivery:${pr}`,
      words: `The review passed; Sentinel is merging pull request #${pr}.`,
    };
  }
  if (record.nextStep === "review") {
    return pr === null ? null : {
      key: `review:${pr}:${rounds + 1}`,
      words: `CI is green; Sentinel requested review round ${
        rounds + 1
      } on pull request #${pr}.`,
    };
  }
  // nextStep === "work"
  if (pr === null) {
    if (record.intent?.kind !== "implementation") return null;
    return {
      key: `started:${record.counters.attempts}`,
      words: `Sentinel started working on this issue (attempt ${
        Math.max(1, record.counters.attempts)
      }).`,
    };
  }
  if (rounds > 0) {
    return {
      key: `revising:${pr}:${rounds}`,
      words:
        `Sentinel is revising pull request #${pr} after review round ${rounds}.`,
    };
  }
  const waiting = record.wait === null ? null : WAIT_WORDS[record.wait.reason];
  return {
    key: `opened:${pr}:${record.wait?.reason ?? "active"}`,
    words: `Sentinel opened pull request #${pr}${
      waiting === undefined || waiting === null ? "" : ` and is ${waiting}`
    }.`,
  };
}

/**
 * The stage changes of one repository's issue records across one cycle. A
 * record new in `after` reports its first stage; a record whose stage key
 * is unchanged reports nothing. Ordered by issue number, then record id.
 */
export function progressChanges(
  before: readonly WorkRecordV1[],
  after: readonly WorkRecordV1[],
  repository: RepositoryConfigV1["repository"],
): ProgressChangeV1[] {
  const previous = new Map(before.map((record) => [record.id, record]));
  const changes: ProgressChangeV1[] = [];
  for (const record of after) {
    if (
      record.repository.owner !== repository.owner ||
      record.repository.name !== repository.name
    ) continue;
    const issueNumber = record.related.issueNumber;
    if (issueNumber === null) continue;
    const stage = progressStage(record);
    if (stage === null) continue;
    const prior = previous.get(record.id);
    const priorStage = prior === undefined ? null : progressStage(prior);
    if (priorStage?.key === stage.key) continue;
    changes.push({ recordId: record.id, issueNumber, stage });
  }
  return changes.sort((a, b) =>
    a.issueNumber - b.issueNumber ||
    (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0)
  );
}

export interface ProgressCommentsDepsV1 {
  http: HttpTransportV1;
  clock: Clock;
  gate: GitHubCooldownGateV1;
  /** The target-scoped token the comment is posted with. */
  token: string;
  /** Absolute run deadline; no request starts inside its final margin. */
  deadline: number;
  apiBaseUrl?: string;
  log?: (line: Record<string, unknown>) => void;
}

export interface ProgressCommentsReportV1 {
  repository: string;
  posted: number;
  skipped: number;
  failed: number;
  dropped: number;
  stopped: "deadline" | "cooldown" | "rate_limited" | null;
}

/**
 * Post one comment per stage change. Never throws for a GitHub failure and
 * never touches repair state.
 */
export async function postProgressComments(
  deps: ProgressCommentsDepsV1,
  config: RepositoryConfigV1,
  changes: readonly ProgressChangeV1[],
): Promise<ProgressCommentsReportV1> {
  const repository = `${config.repository.owner}/${config.repository.name}`;
  const report: ProgressCommentsReportV1 = {
    repository,
    posted: 0,
    skipped: 0,
    failed: 0,
    dropped: Math.max(0, changes.length - PROGRESS_COMMENTS_PER_CYCLE),
    stopped: null,
  };
  const base = deps.apiBaseUrl ?? "https://api.github.com";
  type Stop = "deadline" | "cooldown" | "rate_limited";
  const api = async (
    method: "GET" | "POST",
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<HttpResponseV1 | Stop | null> => {
    if (deps.clock.now() + PROGRESS_MARGIN_MS >= deps.deadline) {
      return "deadline";
    }
    const admitted = await deps.gate.beforeRequest(
      config.repository.installationId,
    );
    if (!admitted.ok) return "cooldown";
    let response: HttpResponseV1;
    try {
      response = await deps.http({
        method,
        url: `${base}/repos/${repository}${path}`,
        headers: new Map([
          ["authorization", `Bearer ${deps.token}`],
          ["accept", "application/vnd.github+json"],
          ["x-github-api-version", "2022-11-28"],
          ...(body === null
            ? []
            : [["content-type", "application/json"] as [string, string]]),
        ]),
        body: body === null ? null : JSON.stringify(body),
      });
    } catch {
      return null;
    }
    const limit = await classifyGitHubRateLimit(response, deps.clock.now());
    if (limit !== null) {
      await deps.gate.recordRateLimit(config.repository.installationId, limit);
      return "rate_limited";
    }
    return response;
  };
  const isStop = (value: unknown): value is Stop =>
    value === "deadline" || value === "cooldown" || value === "rate_limited";
  /** The key of the latest progress marker for `recordId`, or null. */
  const latestKey = async (
    issue: number,
    recordId: string,
  ): Promise<string | null | Stop | "unreadable"> => {
    const prefix = `${MARKER_PREFIX}${recordId}:`;
    let latest: string | null = null;
    for (let page = 1; page <= PROGRESS_COMMENT_PAGES; page++) {
      const response = await api(
        "GET",
        `/issues/${issue}/comments?per_page=100&page=${page}`,
        null,
      );
      if (isStop(response)) return response;
      if (response === null || response.status !== 200) return "unreadable";
      let rows: unknown;
      try {
        rows = JSON.parse(response.bodyText);
      } catch {
        return "unreadable";
      }
      if (!Array.isArray(rows)) return "unreadable";
      for (const row of rows) {
        const body = typeof row === "object" && row !== null
          ? (row as Record<string, unknown>).body
          : undefined;
        if (typeof body !== "string") continue;
        const at = body.lastIndexOf(prefix);
        if (at < 0) continue;
        const end = body.indexOf(" -->", at);
        if (end > at) latest = body.slice(at + prefix.length, end);
      }
      if (rows.length < 100) return latest;
    }
    return "unreadable";
  };
  for (const change of changes.slice(0, PROGRESS_COMMENTS_PER_CYCLE)) {
    const latest = await latestKey(change.issueNumber, change.recordId);
    if (isStop(latest)) {
      report.stopped = latest;
      break;
    }
    if (latest === "unreadable") {
      report.failed++;
      continue;
    }
    if (latest === change.stage.key) {
      report.skipped++;
      continue;
    }
    const posted = await api("POST", `/issues/${change.issueNumber}/comments`, {
      body: `${change.stage.words}\n\n${
        progressMarker(change.recordId, change.stage.key)
      }`,
    });
    if (isStop(posted)) {
      report.stopped = posted;
      break;
    }
    if (posted === null || posted.status !== 201) {
      report.failed++;
      continue;
    }
    report.posted++;
  }
  (deps.log ?? ((line) => console.log(JSON.stringify(line))))({
    kind: "sentinel_progress_comments",
    ...report,
  });
  return report;
}
