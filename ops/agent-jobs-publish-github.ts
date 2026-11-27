import {
  deploymentWorksAgentJobTargetV1,
  HOSTED_CONTROLLER_PROFILE,
  type HostedControllerProfileV1,
} from "../src/contracts/hosted-controller-deployment.ts";
import type { RemoteUrl } from "./agent-jobs-git.ts";
import type {
  AgentJobCommitReviewInput,
  AgentJobDraftInput,
  AgentJobsPublishPorts,
} from "./agent-jobs-publish.ts";

export const AGENT_JOB_REVIEW_COMMENT = "sentinel-agent-job-review";
const MAX_COMMENT_PAGES = 5;
const PUBLISHER = "ubiquity-sentinel[bot]";

export class AgentJobPublicationRefusal extends Error {}

function sameRepository(value: unknown, repository: string): boolean {
  return typeof value === "string" &&
    value.toLowerCase() === repository.toLowerCase();
}

interface CommitComment {
  id?: number;
  commit_id?: string;
  body?: string;
  user?: { login?: string; type?: string };
}

function reviewMarker(input: AgentJobCommitReviewInput): string {
  return `<!-- ${AGENT_JOB_REVIEW_COMMENT} job=${input.id} run=${input.runTag} head=${input.headSha} task=${input.taskDigest} -->`;
}

function reviewBody(
  input: AgentJobCommitReviewInput,
  controller: string,
): string {
  const [run, attempt] = input.runTag.split("-");
  return `${
    reviewMarker(input)
  }\nNative review verdict: **accepted** for Sentinel on-demand job \`${input.id}\`.\n\nReviewed commit: \`${input.headSha}\`.\n\n[Actions review run](https://github.com/${controller}/actions/runs/${run}/attempts/${attempt})`;
}

function exactComment(
  input: AgentJobCommitReviewInput,
  row: CommitComment | null,
  body: string,
): string {
  if (
    !row || typeof row.id !== "number" || !Number.isSafeInteger(row.id) ||
    row.id < 1 || row.commit_id !== input.headSha ||
    row.user?.login !== PUBLISHER || row.user.type !== "Bot" ||
    row.body !== body
  ) {
    throw new AgentJobPublicationRefusal(
      "commit comment does not match the reviewed candidate and App author",
    );
  }
  return `https://github.com/${input.repository}/commit/${input.headSha}#commitcomment-${row.id}`;
}

/** Authenticated, nonredirecting access shared by trusted publication and cleanup. */
export function githubAgentJobsMutationApi(
  token: string,
  fetchResponse: typeof fetch = fetch,
  profile: HostedControllerProfileV1 = HOSTED_CONTROLLER_PROFILE,
) {
  const request = (path: string, method = "GET", body?: unknown) =>
    fetchResponse(`https://api.github.com/repos/${path}`, {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function assertTarget(repository: string): Promise<void> {
    const response = await request(repository).catch(() => null);
    if (!response?.ok) {
      await response?.body?.cancel();
    }
    const body = response?.ok ? await response.json().catch(() => null) : null;
    if (!deploymentWorksAgentJobTargetV1(profile, repository, body)) {
      throw new AgentJobPublicationRefusal(
        `target visibility does not match the ${profile.targetVisibility} deployment or is unavailable`,
      );
    }
  }
  return { request, assertTarget };
}

export function githubAgentJobsPublishPorts(
  token: string,
  remoteUrl: RemoteUrl,
  fetchResponse: typeof fetch = fetch,
  profile: HostedControllerProfileV1 = HOSTED_CONTROLLER_PROFILE,
): AgentJobsPublishPorts {
  const { request, assertTarget } = githubAgentJobsMutationApi(
    token,
    fetchResponse,
    profile,
  );
  const commentPath = (input: AgentJobCommitReviewInput) =>
    `${input.repository}/commits/${input.headSha}/comments`;
  const readComment = async (
    input: AgentJobCommitReviewInput,
    body: string,
  ): Promise<string | null> => {
    const marker = reviewMarker(input);
    for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
      const response = await request(
        `${commentPath(input)}?per_page=100&page=${page}`,
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new AgentJobPublicationRefusal(
          `review commit comment lookup refused (HTTP ${response.status})`,
        );
      }
      const rows: (CommitComment | null)[] = await response.json();
      if (!Array.isArray(rows)) {
        throw new AgentJobPublicationRefusal(
          "review commit comment list is malformed",
        );
      }
      const matches = rows.filter((row) =>
        row?.user?.login === PUBLISHER &&
        typeof row.body === "string" && row.body.startsWith(`${marker}\n`)
      );
      if (matches.length > 1) {
        throw new AgentJobPublicationRefusal(
          "multiple App comments claim the same review verdict",
        );
      }
      if (matches.length === 1) return exactComment(input, matches[0], body);
      if (!response.headers.get("link")?.includes('rel="next"')) return null;
    }
    throw new AgentJobPublicationRefusal(
      "review commit comment lookup exceeded its page bound",
    );
  };
  const exactDraft = (input: AgentJobDraftInput, draft: unknown): string => {
    const row = draft as {
      number?: number;
      state?: string;
      draft?: boolean;
      title?: string;
      body?: string;
      user?: { login?: string; type?: string };
      head?: { sha?: string; ref?: string; repo?: { full_name?: string } };
      base?: { sha?: string; ref?: string; repo?: { full_name?: string } };
    } | null;
    if (
      !row || typeof row.number !== "number" ||
      !Number.isSafeInteger(row.number) || row.number < 1 ||
      row.state !== "open" || row.draft !== true || row.title !== input.title ||
      row.body !== input.body ||
      row.user?.type !== "Bot" || row.user.login !== PUBLISHER ||
      row.head?.sha !== input.headSha || row.head.ref !== input.head ||
      !sameRepository(row.head.repo?.full_name, input.repository) ||
      row.base?.sha !== input.baseSha || row.base.ref !== input.base ||
      !sameRepository(row.base.repo?.full_name, input.repository)
    ) {
      throw new AgentJobPublicationRefusal(
        "a pull request already uses this branch with different custody or content",
      );
    }
    return `https://github.com/${input.repository}/pull/${row.number}`;
  };
  const readDraft = async (
    input: AgentJobDraftInput,
  ): Promise<string | null> => {
    const [owner] = input.repository.split("/");
    const head = encodeURIComponent(`${owner}:${input.head}`);
    const response = await request(
      `${input.repository}/pulls?state=all&per_page=100&head=${head}`,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new AgentJobPublicationRefusal(
        `draft pull request lookup refused (HTTP ${response.status})`,
      );
    }
    const rows = await response.json();
    if (
      !Array.isArray(rows) || rows.length > 1 ||
      response.headers.get("link")?.includes('rel="next"')
    ) {
      throw new AgentJobPublicationRefusal(
        "draft pull request identity is ambiguous",
      );
    }
    return rows.length === 0 ? null : exactDraft(input, rows[0]);
  };
  return {
    remoteUrl,
    assertTarget,
    ensureReviewComment: async (input) => {
      const body = reviewBody(input, profile.repository);
      const existing = await readComment(input, body);
      await assertTarget(input.repository);
      if (existing !== null) return existing;
      const created = await request(commentPath(input), "POST", {
        body,
      }).catch(() => null);
      if (created?.ok) {
        const row = await created.json().catch(() => null);
        if (row !== null) return exactComment(input, row, body);
      } else if (created && created.status < 500) {
        await created.body?.cancel();
        throw new AgentJobPublicationRefusal(
          `review commit comment refused (HTTP ${created.status})`,
        );
      } else {
        await created?.body?.cancel();
      }
      // A lost response can still leave an App comment on the exact commit.
      await assertTarget(input.repository);
      const reconciled = await readComment(input, body);
      if (reconciled !== null) return reconciled;
      const failure = created ? ` (HTTP ${created.status})` : "";
      throw new AgentJobPublicationRefusal(
        `review commit comment was not confirmed${failure}`,
      );
    },
    ensureDraftPullRequest: async (input) => {
      const existing = await readDraft(input);
      await assertTarget(input.repository);
      if (existing !== null) return existing;
      const created = await request(`${input.repository}/pulls`, "POST", {
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        draft: true,
      }).catch(() => null);
      if (created?.ok) return exactDraft(input, await created.json());
      await created?.body?.cancel();
      await assertTarget(input.repository);
      const reconciled = await readDraft(input);
      if (reconciled !== null) return reconciled;
      const failure = created ? ` (HTTP ${created.status})` : "";
      throw new AgentJobPublicationRefusal(
        `draft pull request was not confirmed${failure}`,
      );
    },
    log: (line) => console.log(line),
  };
}
