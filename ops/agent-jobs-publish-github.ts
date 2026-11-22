import { repositoryVisibilityV1 } from "../src/repair/target-visibility.ts";
import type { RemoteUrl } from "./agent-jobs-git.ts";
import type {
  AgentJobCommitStatusInput,
  AgentJobDraftInput,
  AgentJobsPublishPorts,
} from "./agent-jobs-publish.ts";

export const AGENT_JOB_REVIEW_STATUS = "sentinel/agent-job-review";
const DESCRIPTION = "Native review accepted the exact on-demand candidate";
const PUBLISHER = "ubiquity-sentinel[bot]";

export class AgentJobPublicationRefusal extends Error {}

function sameRepository(value: unknown, repository: string): boolean {
  return typeof value === "string" &&
    value.toLowerCase() === repository.toLowerCase();
}

function statusFor(input: AgentJobCommitStatusInput) {
  const [run, attempt] = input.runTag.split("-");
  return {
    state: "success",
    context: AGENT_JOB_REVIEW_STATUS,
    description: DESCRIPTION,
    target_url:
      `https://github.com/ubiquity-sentinel/sentinel/actions/runs/${run}/attempts/${attempt}`,
  };
}

export function githubAgentJobsPublishPorts(
  token: string,
  remoteUrl: RemoteUrl,
  fetchResponse: typeof fetch = fetch,
): AgentJobsPublishPorts {
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
  const readStatus = async (
    input: AgentJobCommitStatusInput,
  ): Promise<boolean> => {
    const response = await request(
      `${input.repository}/commits/${input.headSha}/status`,
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new AgentJobPublicationRefusal(
        `commit status lookup refused (HTTP ${response.status})`,
      );
    }
    const body: {
      sha?: string;
      statuses?: {
        context?: string;
        state?: string;
        description?: string;
        target_url?: string;
      }[];
    } | null = await response.json();
    if (body?.sha !== input.headSha || !Array.isArray(body.statuses)) {
      throw new AgentJobPublicationRefusal(
        "commit status did not identify the reviewed commit",
      );
    }
    const actual = body.statuses.find((status) =>
      status?.context === AGENT_JOB_REVIEW_STATUS
    );
    const expected = statusFor(input);
    return actual?.state === expected.state &&
      actual.description === expected.description &&
      actual.target_url === expected.target_url;
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
    repositoryVisibility: async (repository) => {
      const response = await request(repository);
      if (!response.ok) {
        await response.body?.cancel();
        return "unknown";
      }
      const body = await response.json();
      return sameRepository(body?.full_name, repository)
        ? repositoryVisibilityV1(body)
        : "unknown";
    },
    setCommitStatus: async (input) => {
      if (await readStatus(input)) return;
      const written = await request(
        `${input.repository}/statuses/${input.headSha}`,
        "POST",
        statusFor(input),
      ).catch(() => null);
      await written?.body?.cancel();
      // A lost response can still leave the status on the exact commit.
      if (await readStatus(input)) return;
      const failure = written ? ` (HTTP ${written.status})` : "";
      throw new AgentJobPublicationRefusal(
        `review commit status was not confirmed${failure}`,
      );
    },
    ensureDraftPullRequest: async (input) => {
      const existing = await readDraft(input);
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
