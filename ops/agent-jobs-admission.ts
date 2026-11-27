import {
  agentJobRepositoryVisibilityV1,
  agentJobsUseStagedBaseV1,
  deploymentWorksAgentJobTargetV1,
  deploymentWorksTargetV1,
  type HostedControllerProfileV1,
  isHostedControllerDeploymentSlugV1,
  PUBLIC_CONTROLLER_PROFILE,
} from "../src/contracts/hosted-controller-deployment.ts";
import type { AgentJobsPlanV1, AgentJobV1 } from "./agent-jobs-plan.ts";

export const AGENT_JOB_SHA = /^[0-9a-f]{40}$/;
export const AGENT_JOB_BASE_REF = "refs/heads/sentinel-base";

export type AgentJobsGitHubRead = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

export function agentJobRepositoryParts(repository: string): [string, string] {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/.exec(
    repository,
  );
  if (!match || match[2] === "." || match[2] === "..") {
    throw new Error("agent job target is unavailable");
  }
  return [match[1], match[2]];
}

export function agentJobRepositoryUrl(repository: string): string {
  const [owner, name] = agentJobRepositoryParts(repository);
  return `https://api.github.com/repos/${owner}/${name}`;
}

export function agentJobBaseBundlePath(
  repository: string,
  baseSha: string,
): string {
  const [owner, name] = agentJobRepositoryParts(repository);
  if (!AGENT_JOB_SHA.test(baseSha)) {
    throw new Error("agent job base is unavailable");
  }
  return `bases/${owner}/${name}/${baseSha}.bundle`;
}

export async function readAgentJobsGitHubObject(
  url: string,
  read: AgentJobsGitHubRead,
  token?: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await read(url, {
      redirect: "error",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "sentinel-agent-jobs",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
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
  read: AgentJobsGitHubRead = fetch,
): Promise<{ defaultBranch: string }> {
  const data = await readAgentJobsGitHubObject(
    agentJobRepositoryUrl(repository),
    read,
  );
  if (
    !data ||
    !deploymentWorksAgentJobTargetV1(
      PUBLIC_CONTROLLER_PROFILE,
      repository,
      data,
    ) ||
    typeof data.default_branch !== "string" || !data.default_branch
  ) throw new Error("agent job target is unavailable or not public");
  return { defaultBranch: data.default_branch };
}

export type AuthorizePrivateAgentJobRepository = (
  repository: string,
  requirePullRequests: boolean,
) => Promise<string>;

export interface PrivateAgentJobBase {
  repository: string;
  sha: string;
  readToken: string;
}

export async function requirePrivateAgentJobHost(
  profile: HostedControllerProfileV1,
  nativeToken: string,
  read: AgentJobsGitHubRead = fetch,
): Promise<void> {
  const data = nativeToken
    ? await readAgentJobsGitHubObject(
      agentJobRepositoryUrl(profile.repository),
      read,
      nativeToken,
    )
    : null;
  if (
    !agentJobsUseStagedBaseV1(profile) ||
    data?.full_name !== profile.repository ||
    !deploymentWorksTargetV1(profile, agentJobRepositoryVisibilityV1(data))
  ) {
    throw new Error(
      "agent jobs deployment repository is unavailable or not private",
    );
  }
}

function refusePublicAgentJobTarget(repository: string, data: unknown): void {
  if (
    deploymentWorksAgentJobTargetV1(PUBLIC_CONTROLLER_PROFILE, repository, data)
  ) {
    throw new Error(
      "agent job target is public; the private deployment requires a private target",
    );
  }
}

export async function readPrivateAgentJobRepository(
  profile: HostedControllerProfileV1,
  repository: string,
  requirePullRequests: boolean,
  authorize: AuthorizePrivateAgentJobRepository,
  read: AgentJobsGitHubRead = fetch,
): Promise<{ defaultBranch: string; readToken: string }> {
  if (!agentJobsUseStagedBaseV1(profile)) {
    throw new Error(
      "private agent job repository access requires the private deployment",
    );
  }
  if (isHostedControllerDeploymentSlugV1(repository)) {
    throw new Error(
      "controller repositories are unavailable to private agent jobs",
    );
  }
  const url = agentJobRepositoryUrl(repository);
  let readToken: string;
  try {
    readToken = await authorize(repository, requirePullRequests);
  } catch (error) {
    // Distinguish a public target even if the private App cannot reach it.
    const data = await readAgentJobsGitHubObject(url, read);
    refusePublicAgentJobTarget(repository, data);
    throw error;
  }
  if (!readToken) {
    throw new Error("agent job target is not writable by the deployment App");
  }
  const data = await readAgentJobsGitHubObject(url, read, readToken);
  refusePublicAgentJobTarget(repository, data);
  if (
    !data || !deploymentWorksAgentJobTargetV1(profile, repository, data) ||
    typeof data.default_branch !== "string" || !data.default_branch
  ) throw new Error("agent job target is unavailable or not private");
  if (data.archived === true || data.disabled === true) {
    throw new Error("agent job target is not writable by the deployment App");
  }
  return { defaultBranch: data.default_branch, readToken };
}

interface AgentJobsPinOptions {
  profile?: HostedControllerProfileV1;
  read?: AgentJobsGitHubRead;
  authorizePrivateRepository?: AuthorizePrivateAgentJobRepository;
  checkPrivateMinutes?: () => Promise<void>;
  stagePrivateBase?: (base: PrivateAgentJobBase) => Promise<void>;
}

/** Validate every target and base before exposing any staged private Git objects. */
export async function pinAgentJobsPlan(
  plan: AgentJobsPlanV1,
  createdAtMs: number,
  {
    profile = PUBLIC_CONTROLLER_PROFILE,
    read = fetch,
    authorizePrivateRepository,
    checkPrivateMinutes,
    stagePrivateBase,
  }: AgentJobsPinOptions = {},
): Promise<AgentJobsPlanV1> {
  const stagedBase = agentJobsUseStagedBaseV1(profile);
  if (
    stagedBase &&
    (!authorizePrivateRepository || !checkPrivateMinutes || !stagePrivateBase)
  ) {
    throw new Error(
      "private agent job planning requires trusted Git access and a minutes check",
    );
  }
  const repositories = new Map<
    string,
    Promise<{ defaultBranch: string; readToken?: string }>
  >();
  const bases = new Map<string, Promise<string>>();
  const pullRequests = new Set(
    plan.cells.flatMap(({ jobs }) =>
      jobs.filter(({ pr }) => pr).map(({ repository }) =>
        repository.toLowerCase()
      )
    ),
  );
  async function pin(job: AgentJobV1): Promise<AgentJobV1> {
    const repositoryKey = job.repository.toLowerCase();
    let metadata = repositories.get(repositoryKey);
    if (!metadata) {
      metadata = stagedBase && authorizePrivateRepository
        ? readPrivateAgentJobRepository(
          profile,
          job.repository,
          pullRequests.has(repositoryKey),
          authorizePrivateRepository,
          read,
        )
        : readPublicAgentJobRepository(job.repository, read);
      repositories.set(repositoryKey, metadata);
    }
    const { defaultBranch, readToken } = await metadata;
    const base = job.base ?? defaultBranch;
    const baseKey = repositoryKey + "\n" + base;
    let pin = bases.get(baseKey);
    if (!pin) {
      pin = (async () => {
        const body = await readAgentJobsGitHubObject(
          agentJobRepositoryUrl(job.repository) + "/branches/" +
            encodeURIComponent(base),
          read,
          readToken,
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
  const cells = await Promise.all(plan.cells.map(async (cell) => ({
    ...cell,
    jobs: await Promise.all(cell.jobs.map(pin)),
  })));
  if (stagedBase && checkPrivateMinutes && stagePrivateBase) {
    await checkPrivateMinutes();
    const paths = new Set<string>();
    for (const { repository, baseSha } of cells.flatMap(({ jobs }) => jobs)) {
      const { readToken } =
        (await repositories.get(repository.toLowerCase())) ?? {};
      if (!readToken || !baseSha) {
        throw new Error("private agent job base is unavailable");
      }
      const path = agentJobBaseBundlePath(repository, baseSha);
      if (paths.has(path)) continue;
      await stagePrivateBase({ repository, sha: baseSha, readToken });
      paths.add(path);
    }
  }
  return { ...plan, createdAtMs, cells };
}
