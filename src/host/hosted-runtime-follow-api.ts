import { isGitSha } from "../contracts/brands.ts";
import {
  HOSTED_CONTROLLER_DEPLOYMENT,
  HOSTED_CONTROLLER_REPOSITORY,
  HOSTED_CONTROLLER_SOURCE_REF,
  HOSTED_CONTROLLER_SUPERVISOR_REF,
} from "../contracts/hosted-controller-deployment.ts";
import {
  createDeadline,
  type DeadlineV1,
  headerMap,
  type HttpTransportV1,
} from "../github/http.ts";
import { nextLinkUrl } from "../github/client-response.ts";

export const FOLLOW_REPOSITORY = HOSTED_CONTROLLER_REPOSITORY;
export const FOLLOW_REPO_PATH = `/repos/${FOLLOW_REPOSITORY}`;
export const FOLLOW_LAUNCHER_REF = HOSTED_CONTROLLER_SUPERVISOR_REF;
export const FOLLOW_DEVELOPMENT_REF = HOSTED_CONTROLLER_SOURCE_REF;
export const FOLLOW_STATE_REF = "refs/heads/sentinel-state/release";
export const FOLLOW_SUPERVISOR = "supervisor.yml";
export const FOLLOW_ACTIVE_STATUSES = [
  "queued",
  "in_progress",
  "requested",
  "waiting",
  "pending",
] as const;

/** Static reason codes only: never expose a response, token or thrown message. */
export class FollowError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** A read GitHub may answer on retry; its reason is the one finally thrown. */
class TransientFollowRead extends FollowError {
  constructor(reason: string, readonly retryAfterMs = 0) {
    super(reason);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FollowError("malformed_response");
  }
  return value as Record<string, unknown>;
}

export function sha(value: unknown): string {
  if (!isGitSha(value)) throw new FollowError("malformed_sha");
  return value;
}

export function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new FollowError("malformed_identity");
  }
  return value as number;
}

/** Complete listings attempted, including the first, before incompleteness fails. */
export const FOLLOW_LIST_ATTEMPTS = 3;
/** Production pause between complete re-listings; tests inject their own. */
export const FOLLOW_LIST_RETRY_PAUSE_MS = 1_000;

export function defaultListPause(): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(resolve, FOLLOW_LIST_RETRY_PAUSE_MS)
  );
}

function defaultPause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded retry of transient reads and inconsistent listings for one pass. */
export interface FollowRetryPolicy {
  /** Attempts per GET, including the first, for a 5xx, 429 or lost read. */
  readonly readAttempts: number;
  /** Complete listings attempted, including the first. */
  readonly listAttempts: number;
  /** Pause before retry `n` (1-based) of one read or listing. */
  backoffMs(retry: number): number;
  /** Longest honoured Retry-After; a longer or malformed one is not retried. */
  readonly retryAfterCapMs: number;
  /** Total pause one API instance may spend on all of its retries. */
  readonly budgetMs: number;
}

/** The dispatch guard's unchanged policy: one read, fixed listing pauses. */
const FOLLOW_GUARD_RETRY: FollowRetryPolicy = {
  readAttempts: 1,
  listAttempts: FOLLOW_LIST_ATTEMPTS,
  backoffMs: () => FOLLOW_LIST_RETRY_PAUSE_MS,
  retryAfterCapMs: 0,
  budgetMs: Number.POSITIVE_INFINITY,
};

/**
 * The follow scan's policy. A deferred scan leaves the supervisor on the old
 * runtime for a whole ~30 minute cycle (2026-11-13: run 43504030921 deferred on
 * one non-200 read, run 43520076144 on a listing still inconsistent after three
 * reads 1 s apart), while those follow steps took 49 s and 33 s against the
 * 100 s scan deadline. At most 30 s of pauses is added per pass: up to four
 * reads (1, 2, 4 s), five listings (1, 2, 4, 8 s) and a 429 Retry-After of at
 * most 10 s. The unchanged deadline, not the budget, still bounds the step.
 */
export const FOLLOW_SCAN_RETRY: FollowRetryPolicy = {
  readAttempts: 4,
  listAttempts: 5,
  backoffMs: (retry) => 1_000 * 2 ** (retry - 1),
  retryAfterCapMs: 10_000,
  budgetMs: 30_000,
};

/** Uses the existing bounded HTTP helpers, with one deadline for the whole scan. */
export class HostedRuntimeFollowApi {
  private readonly deadline: DeadlineV1;
  private paused = 0;
  constructor(
    private readonly http: HttpTransportV1,
    private readonly token: string,
    deadlineMs = 100_000,
    private readonly maxPages = 10,
    private readonly pause: (ms: number) => Promise<void> = defaultPause,
    private readonly retry: FollowRetryPolicy = FOLLOW_GUARD_RETRY,
  ) {
    this.deadline = createDeadline(deadlineMs);
  }

  dispose(): void {
    this.deadline.dispose();
  }

  /**
   * Only an idempotent read is retried, never the single ref mutation. 401,
   * 403, 404, a conflict, a malformed body and every verdict computed from a
   * successful read keep their first answer.
   */
  async request(
    path: string,
    query: Record<string, string> = {},
    body?: Record<string, unknown>,
  ): Promise<{ value: unknown; headers: Headers }> {
    for (let attempt = 1;; attempt++) {
      try {
        return await this.requestOnce(path, query, body);
      } catch (error) {
        if (
          body !== undefined || !(error instanceof TransientFollowRead) ||
          attempt >= this.retry.readAttempts
        ) throw error;
        await this.pauseBeforeRetry(
          error,
          Math.max(this.retry.backoffMs(attempt), error.retryAfterMs),
        );
      }
    }
  }

  /** One pause inside both the scan deadline and the pass's retry budget. */
  private async pauseBeforeRetry(
    error: FollowError,
    ms: number,
  ): Promise<void> {
    if (this.deadline.fired() || this.paused + ms > this.retry.budgetMs) {
      throw error;
    }
    this.paused += ms;
    try {
      await this.deadline.race(this.pause(ms));
    } catch {
      throw this.deadline.fired() ? new FollowError("follow_deadline") : error;
    }
  }

  private async requestOnce(
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown> | undefined,
  ): Promise<{ value: unknown; headers: Headers }> {
    if (this.deadline.fired()) throw new FollowError("follow_deadline");
    const url = new URL(path, "https://api.github.com");
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    let response;
    try {
      response = await this.deadline.race(this.http({
        method: body === undefined ? "GET" : "POST",
        url: url.toString(),
        headers: headerMap({
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        }),
        body: body === undefined ? null : JSON.stringify(body),
        redirect: "error",
      }));
    } catch {
      if (this.deadline.fired()) throw new FollowError("follow_deadline");
      throw new TransientFollowRead("transport_unavailable");
    }
    if (response.status !== 200) {
      if ([409, 412, 422].includes(response.status)) {
        throw new FollowError("ref_conflict");
      }
      const wait = this.retryAfterMs(response.headers);
      throw (response.status === 429 || response.status >= 500) &&
          wait !== null
        ? new TransientFollowRead("github_read_unavailable", wait)
        : new FollowError("github_read_unavailable");
    }
    try {
      return {
        value: JSON.parse(response.bodyText) as unknown,
        headers: response.headers,
      };
    } catch {
      throw new FollowError("malformed_json");
    }
  }

  /** 0 without Retry-After; null for a malformed one or one beyond the cap. */
  private retryAfterMs(headers: Headers): number | null {
    const raw = headers.get("retry-after")?.trim();
    if (raw === undefined) return 0;
    if (!/^\d{1,6}$/.test(raw)) return null;
    const ms = Number(raw) * 1_000;
    return ms <= this.retry.retryAfterCapMs ? ms : null;
  }

  async get(
    path: string,
    query: Record<string, string> = {},
  ): Promise<unknown> {
    return (await this.request(`${FOLLOW_REPO_PATH}${path}`, query)).value;
  }

  async ref(name: string): Promise<string> {
    const value = record(await this.get(`/git/ref/${name.slice(5)}`));
    const object = record(value.object);
    if (value.ref !== name || object.type !== "commit") {
      throw new FollowError("ref_identity_mismatch");
    }
    return sha(object.sha);
  }

  /**
   * GitHub's filtered listings are eventually consistent, so an incomplete or
   * inconsistent listing is re-read from page 1 a bounded number of times,
   * pausing inside the same overall deadline. Only a listing that completes
   * within one pass is returned; one that stays inconsistent still fails.
   */
  async list(
    path: string,
    key: "workflow_runs" | "jobs",
    query: Record<string, string> = {},
  ): Promise<Record<string, unknown>[]> {
    for (let attempt = 1;; attempt++) {
      try {
        return await this.listOnce(path, key, query);
      } catch (error) {
        if (
          !(error instanceof FollowError) ||
          error.reason !== "incomplete_pagination" ||
          attempt >= this.retry.listAttempts
        ) throw error;
        await this.pauseBeforeRetry(error, this.retry.backoffMs(attempt));
      }
    }
  }

  /** Total, uniqueness and terminal-link checks prevent partial-list success. */
  private async listOnce(
    path: string,
    key: "workflow_runs" | "jobs",
    query: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const ids = new Set<number>();
    let total: number | undefined;
    for (let page = 1; page <= this.maxPages; page++) {
      const response = await this.request(`${FOLLOW_REPO_PATH}${path}`, {
        ...query,
        per_page: "100",
        page: String(page),
      });
      const value = record(response.value);
      const count = value.total_count;
      if (
        !Number.isSafeInteger(count) || (count as number) < 0 ||
        (total !== undefined && total !== count) || !Array.isArray(value[key])
      ) throw new FollowError("incomplete_pagination");
      total = count as number;
      const batch = value[key] as unknown[];
      if (batch.length > 100) throw new FollowError("incomplete_pagination");
      for (const raw of batch) {
        const row = record(raw);
        const id = positive(row.id);
        if (ids.has(id)) throw new FollowError("incomplete_pagination");
        ids.add(id);
        rows.push(row);
      }
      const next = nextLinkUrl(response.headers);
      if (rows.length === total && next === null) return rows;
      if (rows.length >= total || batch.length !== 100) {
        throw new FollowError("incomplete_pagination");
      }
      // Never follow an API-supplied URL with credentials. The exact query
      // and numeric page are reconstructed above; the link must agree.
      if (next !== null) {
        const expected = new URL(
          `${FOLLOW_REPO_PATH}${path}`,
          "https://api.github.com",
        );
        for (const [name, item] of Object.entries(query)) {
          expected.searchParams.set(name, item);
        }
        expected.searchParams.set("per_page", "100");
        expected.searchParams.set("page", String(page + 1));
        const linked = new URL(next);
        if (
          linked.origin !== expected.origin ||
          linked.pathname !== expected.pathname ||
          linked.searchParams.size !== expected.searchParams.size ||
          [...expected.searchParams].some(([name, item]) =>
            linked.searchParams.get(name) !== item
          )
        ) {
          throw new FollowError("incomplete_pagination");
        }
      }
    }
    throw new FollowError("pagination_limit");
  }

  /**
   * The `.github/workflows` tree id of an exact commit, or null when the
   * commit has none. The native dispatcher token cannot move a ref onto a
   * commit whose workflow files differ, so the follow compares these ids
   * instead of attempting a write GitHub will refuse.
   */
  async workflowsTree(commit: string): Promise<string | null> {
    const value = record(await this.get(`/git/commits/${commit}`));
    if (value.sha !== commit) throw new FollowError("commit_identity_mismatch");
    let tree = sha(record(value.tree).sha);
    for (const name of [".github", "workflows"]) {
      const listing = record(await this.get(`/git/trees/${tree}`));
      if (
        listing.sha !== tree || listing.truncated === true ||
        !Array.isArray(listing.tree)
      ) throw new FollowError("malformed_tree");
      const entry = listing.tree.map(record).find((item) =>
        item.path === name && item.type === "tree"
      );
      if (entry === undefined) return null;
      tree = sha(entry.sha);
    }
    return tree;
  }

  async ancestor(base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    const value = record(
      await this.get(`/compare/${base}...${head}`, { per_page: "1" }),
    );
    const ahead = value.ahead_by;
    const behind = value.behind_by;
    const total = value.total_commits;
    if (
      ![ahead, behind, total].every((item) =>
        Number.isSafeInteger(item) && (item as number) >= 0
      )
    ) {
      throw new FollowError("malformed_ancestry");
    }
    return record(value.base_commit).sha === base &&
      record(value.merge_base_commit).sha === base && behind === 0 &&
      ((value.status === "ahead" && (ahead as number) > 0 && total === ahead) ||
        (value.status === "identical" && ahead === 0 && total === 0));
  }

  /** REST PATCH refs has no expected-old SHA; updateRefs supplies real CAS. */
  async advance(
    repositoryId: string,
    before: string,
    after: string,
  ): Promise<void> {
    const value = record(
      (await this.request("/graphql", {}, {
        query:
          "mutation Follow($input:UpdateRefsInput!){updateRefs(input:$input){clientMutationId}}",
        variables: {
          input: {
            repositoryId,
            clientMutationId: `sentinel-follow:${before}:${after}`,
            refUpdates: [{
              name: FOLLOW_LAUNCHER_REF,
              beforeOid: before,
              afterOid: after,
              force: false,
            }],
          },
        },
      })).value,
    );
    if (value.errors !== undefined) {
      const conflicts = ["UNPROCESSABLE", "UNPROCESSABLE_ENTITY", "CONFLICT"];
      const conflict = Array.isArray(value.errors) && value.errors.length > 0 &&
        value.errors.every((error) =>
          conflicts.includes(String(record(error).type))
        );
      throw new FollowError(conflict ? "ref_conflict" : "ref_update_rejected");
    }
    const updated = record(record(value.data).updateRefs);
    if (updated.clientMutationId !== `sentinel-follow:${before}:${after}`) {
      throw new FollowError("ref_update_unconfirmed");
    }
  }
}

export async function activeSupervisorRuns(
  api: HostedRuntimeFollowApi,
): Promise<Record<string, unknown>[]> {
  const runs: Record<string, unknown>[] = [];
  for (const status of FOLLOW_ACTIVE_STATUSES) {
    const listed = await api.list(
      `/actions/workflows/${FOLLOW_SUPERVISOR}/runs`,
      "workflow_runs",
      {
        branch: HOSTED_CONTROLLER_DEPLOYMENT.supervisorBranch,
        event: "workflow_dispatch",
        status,
      },
    );
    for (const run of listed) {
      if (
        run.head_branch !== HOSTED_CONTROLLER_DEPLOYMENT.supervisorBranch ||
        run.event !== "workflow_dispatch" ||
        run.path !== HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowPath ||
        !FOLLOW_ACTIVE_STATUSES.includes(run.status as typeof status)
      ) {
        throw new FollowError("supervisor_identity_mismatch");
      }
    }
    runs.push(...listed);
  }
  return runs;
}
