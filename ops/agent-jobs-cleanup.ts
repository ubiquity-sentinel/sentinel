/**
 * EXPERIMENTAL manual agent-job lane: the `cleanup` step.
 *
 * Deletes result branches the lane pushed earlier. An operator commits a
 * request file under `jobs/cleanup/`; this step refuses every branch name that
 * is not an `agent-jobs/<job>-<run>-<attempt>` branch, so it can only remove
 * what the publish step created. A branch with an open pull request is kept
 * unless the request says to close it; the pull request is then closed
 * explicitly, because GitHub does not reliably close it with the branch. No model runs here and no Sentinel
 * state is read or written.
 */

const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
/** The only branch shape `ops/agent-jobs-publish.ts` pushes. */
export const AGENT_JOB_RESULT_BRANCH =
  /^agent-jobs\/[a-z0-9][a-z0-9-]{0,39}-\d+-\d+$/;

export interface AgentJobsCleanupEntryV1 {
  repository: string;
  branch: string;
  /** Delete even when an open pull request uses the branch (closing it). */
  closePullRequest: boolean;
}

export type AgentJobsCleanupStatus =
  | "deleted"
  | "missing"
  | "kept_open_pr"
  | "failed";

export interface AgentJobsCleanupResultV1 {
  repository: string;
  branch: string;
  status: AgentJobsCleanupStatus;
  detail: string;
}

export interface AgentJobsCleanupPorts {
  /** Numbers of the open pull requests whose head is the branch. */
  openPullRequests: (repository: string, branch: string) => Promise<number[]>;
  closePullRequest: (repository: string, number: number) => Promise<void>;
  /** Delete the branch; `missing` when it does not exist. */
  deleteBranch: (
    repository: string,
    branch: string,
  ) => Promise<"deleted" | "missing">;
  log: (line: string) => void;
}

function fail(message: string): never {
  throw new Error(`agent jobs cleanup refused: ${message}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate request documents and merge them, dropping repeats. Pure. */
export function parseAgentJobsCleanup(
  documents: unknown[],
): AgentJobsCleanupEntryV1[] {
  const entries = new Map<string, AgentJobsCleanupEntryV1>();
  for (const document of documents) {
    if (!record(document) || !Array.isArray(document.branches)) {
      fail('expected {"branches":[...]}');
    }
    for (const value of document.branches) {
      if (!record(value)) fail("every branch entry must be an object");
      for (const key of Object.keys(value)) {
        if (!["repository", "branch", "closePullRequest"].includes(key)) {
          fail(`unknown field ${key}`);
        }
      }
      const { repository, branch, closePullRequest } = value;
      if (
        typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)
      ) fail("repository must be owner/name");
      if (typeof branch !== "string" || !AGENT_JOB_RESULT_BRANCH.test(branch)) {
        fail(
          `${repository}: only agent-jobs/<job>-<run>-<attempt> branches can be deleted`,
        );
      }
      if (
        closePullRequest !== undefined && typeof closePullRequest !== "boolean"
      ) fail(`${repository} ${branch}: closePullRequest must be a boolean`);
      entries.set(`${repository}\n${branch}`, {
        repository,
        branch,
        closePullRequest: closePullRequest ?? false,
      });
    }
  }
  if (entries.size === 0) fail("no branch was named");
  return [...entries.values()];
}

/** One matrix row per repository owner: one App token is minted per owner. */
export function agentJobsCleanupMatrix(
  entries: AgentJobsCleanupEntryV1[],
): { include: { owner: string; repositories: string }[] } {
  const byOwner = new Map<string, Set<string>>();
  for (const entry of entries) {
    const [owner, name] = entry.repository.split("/");
    byOwner.set(owner, (byOwner.get(owner) ?? new Set()).add(name));
  }
  return {
    include: [...byOwner].map(([owner, names]) => ({
      owner,
      repositories: [...names].join(","),
    })),
  };
}

/** Delete each branch; one failure does not stop the others. */
export async function cleanupAgentJobBranches(
  entries: AgentJobsCleanupEntryV1[],
  ports: AgentJobsCleanupPorts,
): Promise<AgentJobsCleanupResultV1[]> {
  const results: AgentJobsCleanupResultV1[] = [];
  for (const entry of entries) {
    const result: AgentJobsCleanupResultV1 = {
      repository: entry.repository,
      branch: entry.branch,
      status: "failed",
      detail: "",
    };
    try {
      const open = await ports.openPullRequests(
        entry.repository,
        entry.branch,
      );
      if (open.length > 0 && !entry.closePullRequest) {
        result.status = "kept_open_pr";
        result.detail = "an open pull request uses this branch";
      } else {
        for (const number of open) {
          await ports.closePullRequest(entry.repository, number);
          result.detail = `${result.detail} closed pull request ${number}`
            .trim();
        }
        result.status = await ports.deleteBranch(
          entry.repository,
          entry.branch,
        );
      }
    } catch (error) {
      result.detail = `${result.detail} ${
        error instanceof Error ? error.message : String(error)
      }`.trim();
    }
    results.push(result);
    ports.log(
      `${result.repository} ${result.branch}: ${result.status} ${result.detail}`
        .trim(),
    );
  }
  return results;
}

/** GitHub REST ports for one installation token. */
export function githubCleanupPorts(token: string): AgentJobsCleanupPorts {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };
  return {
    openPullRequests: async (repository, branch) => {
      const owner = repository.split("/")[0];
      const response = await fetch(
        `https://api.github.com/repos/${repository}/pulls?state=open&per_page=100&head=${
          encodeURIComponent(`${owner}:${branch}`)
        }`,
        { headers },
      );
      if (!response.ok) {
        throw new Error(`pull request lookup: HTTP ${response.status}`);
      }
      return (await response.json() as { number: number }[]).map((pull) =>
        pull.number
      );
    },
    closePullRequest: async (repository, number) => {
      const response = await fetch(
        `https://api.github.com/repos/${repository}/pulls/${number}`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ state: "closed" }),
        },
      );
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error(`pull request close: HTTP ${response.status}`);
      }
    },
    deleteBranch: async (repository, branch) => {
      const response = await fetch(
        `https://api.github.com/repos/${repository}/git/refs/heads/${branch}`,
        { method: "DELETE", headers },
      );
      await response.body?.cancel();
      if (response.status === 204) return "deleted";
      // GitHub answers 422 "Reference does not exist" for a missing branch.
      if (response.status === 404 || response.status === 422) return "missing";
      throw new Error(`branch delete: HTTP ${response.status}`);
    },
    log: (line) => console.log(line),
  };
}

/**
 * CLI for `.github/workflows/agent-jobs-cleanup.yml`:
 * `plan <files>` writes the owner matrix; `delete <files>` deletes the
 * branches of `AGENT_JOBS_CLEANUP_OWNER` with `AGENT_JOBS_WRITE_TOKEN`.
 */
if (import.meta.main) {
  const env = (name: string) => Deno.env.get(name) ?? "";
  const [mode, ...paths] = Deno.args;
  const entries = parseAgentJobsCleanup(
    await Promise.all(
      paths.map(async (path) => JSON.parse(await Deno.readTextFile(path))),
    ),
  );
  if (mode === "plan") {
    const matrix = agentJobsCleanupMatrix(entries);
    const output = env("GITHUB_OUTPUT");
    if (output) {
      await Deno.writeTextFile(output, `matrix=${JSON.stringify(matrix)}\n`, {
        append: true,
      });
    }
    console.log(
      `planned ${entries.length} branches for ${matrix.include.length} owners`,
    );
  } else if (mode === "delete") {
    const token = env("AGENT_JOBS_WRITE_TOKEN");
    if (token.length === 0) {
      throw new Error("AGENT_JOBS_WRITE_TOKEN is not set");
    }
    const owner = env("AGENT_JOBS_CLEANUP_OWNER");
    const results = await cleanupAgentJobBranches(
      entries.filter((entry) => entry.repository.split("/")[0] === owner),
      githubCleanupPorts(token),
    );
    const summary = env("GITHUB_STEP_SUMMARY");
    if (summary) {
      const rows = results.map((row) =>
        `| ${row.repository} | ${row.branch} | ${row.status} | ${row.detail} |`
      );
      await Deno.writeTextFile(
        summary,
        `| repository | branch | status | detail |\n|---|---|---|---|\n${
          rows.join("\n")
        }\n`,
        { append: true },
      );
    }
    if (results.some((row) => row.status === "failed")) Deno.exit(1);
  } else {
    fail("mode must be plan or delete");
  }
}
