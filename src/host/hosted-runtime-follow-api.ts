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

/** Uses the existing bounded HTTP helpers, with one deadline for the whole scan. */
export class HostedRuntimeFollowApi {
  private readonly deadline: DeadlineV1;
  constructor(
    private readonly http: HttpTransportV1,
    private readonly token: string,
    deadlineMs = 100_000,
    private readonly maxPages = 10,
  ) {
    this.deadline = createDeadline(deadlineMs);
  }

  dispose(): void {
    this.deadline.dispose();
  }

  async request(
    path: string,
    query: Record<string, string> = {},
    body?: Record<string, unknown>,
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
      throw new FollowError(
        this.deadline.fired() ? "follow_deadline" : "transport_unavailable",
      );
    }
    if (response.status !== 200) {
      throw new FollowError(
        [409, 412, 422].includes(response.status)
          ? "ref_conflict"
          : "github_read_unavailable",
      );
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

  /** Total, uniqueness and terminal-link checks prevent partial-list success. */
  async list(
    path: string,
    key: "workflow_runs" | "jobs",
    query: Record<string, string> = {},
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
