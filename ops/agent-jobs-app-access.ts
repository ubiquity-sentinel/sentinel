import {
  createWebCryptoJwtSigner,
  type JwtSignerV1,
} from "../src/github/auth.ts";
import { SENTINEL_APP_ID } from "../src/host/hosted-app-grant.ts";
import {
  agentJobRepositoryParts,
  agentJobRepositoryUrl,
  type AgentJobsGitHubRead,
  type AuthorizePrivateAgentJobRepository,
  readAgentJobsGitHubObject,
} from "./agent-jobs-admission.ts";

export async function privateAgentJobAppAuthorizer(
  privateKey: string,
): Promise<AuthorizePrivateAgentJobRepository> {
  const signer = await createWebCryptoJwtSigner(privateKey);
  if (!signer.ok) throw new Error("deployment App authentication unavailable");
  const now = Math.floor(Date.now() / 1000);
  return await createAgentJobAppAuthorizer(signer.value, now);
}

/** Read the exact App installation's full grant, then mint a single-repo read token. */
export async function createAgentJobAppAuthorizer(
  signer: JwtSignerV1,
  nowSeconds: number,
  read: AgentJobsGitHubRead = fetch,
): Promise<AuthorizePrivateAgentJobRepository> {
  const jwt = await signer.signJwt({
    iat: nowSeconds - 60,
    exp: nowSeconds + 8 * 60,
    iss: String(SENTINEL_APP_ID),
  });
  if (!jwt.ok) throw new Error("deployment App authentication unavailable");
  return async (repository, requirePullRequests) => {
    const [owner, name] = agentJobRepositoryParts(repository);
    const installation = await readAgentJobsGitHubObject(
      agentJobRepositoryUrl(repository) + "/installation",
      read,
      jwt.value,
    );
    const { id, app_id, account, permissions, suspended_at } = installation ??
      {};
    const login = (account as { login?: unknown } | undefined)?.login;
    const grant = permissions as Record<string, unknown> | undefined;
    if (
      typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0 ||
      app_id !== SENTINEL_APP_ID || suspended_at !== null ||
      typeof login !== "string" ||
      login.toLowerCase() !== owner.toLowerCase() ||
      grant?.contents !== "write" ||
      (requirePullRequests && grant.pull_requests !== "write")
    ) throw new Error("agent job target is not writable by the deployment App");

    const result = await readAgentJobsGitHubObject(
      `https://api.github.com/app/installations/${id}/access_tokens`,
      read,
      jwt.value,
      { repositories: [name], permissions: { contents: "read" } },
    );
    const token = result?.token;
    const scope = result?.permissions as Record<string, unknown> | undefined;
    const repositories = result?.repositories;
    const exactlyScoped = repositories === undefined ||
      (Array.isArray(repositories) && repositories.length === 1 &&
        typeof repositories[0]?.full_name === "string" &&
        repositories[0].full_name.toLowerCase() === repository.toLowerCase());
    if (
      typeof token !== "string" || !/^[!-~]+$/.test(token) ||
      scope?.contents !== "read" ||
      Object.entries(scope).some(([key, value]) =>
        key !== "contents" && (key !== "metadata" || value !== "read")
      ) ||
      !exactlyScoped ||
      typeof result?.expires_at !== "string" ||
      !(Date.parse(result.expires_at) > nowSeconds * 1000)
    ) {
      throw new Error(
        "deployment App could not grant exact target read access",
      );
    }
    return token;
  };
}
