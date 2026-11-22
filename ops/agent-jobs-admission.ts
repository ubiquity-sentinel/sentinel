import { repositoryVisibilityV1 } from "../src/repair/target-visibility.ts";
import type { AgentJobsPlanV1, AgentJobV1 } from "./agent-jobs-plan.ts";

export const AGENT_JOB_SHA = /^[0-9a-f]{40}$/;

type ReadResponse = (url: string, init: RequestInit) => Promise<Response>;

function repositoryUrl(repository: string): string {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(
    repository,
  );
  if (!match || match[2] === "." || match[2] === "..") {
    throw new Error("agent job target is unavailable");
  }
  return "https://api.github.com/repos/" + match[1] + "/" + match[2];
}

async function githubObject(
  url: string,
  read: ReadResponse,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await read(url, {
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "sentinel-agent-jobs",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || response.redirected) {
      await response.body?.cancel();
      return null;
    }
    const data: unknown = await response.json();
    return typeof data === "object" && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Require anonymous GitHub evidence on the exact requested repository. */
export async function readPublicAgentJobRepository(
  repository: string,
  read: ReadResponse = fetch,
): Promise<{ defaultBranch: string }> {
  const data = await githubObject(repositoryUrl(repository), read);
  if (
    !data || repositoryVisibilityV1(data) !== "public" ||
    typeof data.full_name !== "string" ||
    data.full_name.toLowerCase() !== repository.toLowerCase() ||
    typeof data.default_branch !== "string" || !data.default_branch
  ) throw new Error("agent job target is unavailable or not public");
  return { defaultBranch: data.default_branch };
}

/** Pin each hosted job to an independently verified public base before upload. */
export async function pinAgentJobsPlan(
  plan: AgentJobsPlanV1,
  createdAtMs: number,
  read: ReadResponse = fetch,
): Promise<AgentJobsPlanV1> {
  const repositories = new Map<string, Promise<{ defaultBranch: string }>>();
  const bases = new Map<string, Promise<string>>();
  async function pin(job: AgentJobV1): Promise<AgentJobV1> {
    const repositoryKey = job.repository.toLowerCase();
    const metadata = repositories.get(repositoryKey) ??
      readPublicAgentJobRepository(job.repository, read);
    repositories.set(repositoryKey, metadata);
    const { defaultBranch } = await metadata;
    const base = job.base ?? defaultBranch;
    const baseKey = repositoryKey + "\n" + base;
    let pin = bases.get(baseKey);
    if (!pin) {
      pin = (async () => {
        const body = await githubObject(
          repositoryUrl(job.repository) + "/branches/" +
            encodeURIComponent(base),
          read,
        );
        const commit = body?.commit as { sha?: unknown } | undefined;
        if (
          body?.name !== base || typeof commit?.sha !== "string" ||
          !AGENT_JOB_SHA.test(commit.sha)
        ) throw new Error("agent job base is unavailable");
        return commit.sha;
      })();
      bases.set(baseKey, pin);
    }
    return { ...job, base, baseSha: await pin };
  }
  return {
    ...plan,
    createdAtMs,
    cells: await Promise.all(plan.cells.map(async (cell) => ({
      ...cell,
      jobs: await Promise.all(cell.jobs.map(pin)),
    }))),
  };
}
