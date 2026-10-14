import type { Clock, GitHubCooldownGateV1 } from "../contracts/ports.ts";
import { headerMap, type HttpTransportV1 } from "../github/http.ts";
import { classifyGitHubRateLimit } from "../github/rate-limit.ts";
import {
  API_USER_URL,
  LOCAL_REPOSITORY,
  REMOTE_URL,
  STATIC_GITHUB_LOGIN,
} from "./local-policy.ts";

/** Scoped Basic auth for trusted git only; never in a URL or config file. */
export function githubGitAuthEnv(
  token: string,
  remoteUrl: string = REMOTE_URL,
): Record<string, string> {
  const basic = btoa(`x-access-token:${token}`);
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${remoteUrl}.extraheader`,
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** Authenticate the current owner login; strict nonempty bounded login. */
export async function readAuthenticatedLogin(
  token: string,
  http: HttpTransportV1,
  gate: GitHubCooldownGateV1,
  clock: Clock,
  installationId: number = LOCAL_REPOSITORY.installationId,
): Promise<string> {
  const admission = await gate.beforeRequest(installationId);
  if (!admission.ok) throw new Error(STATIC_GITHUB_LOGIN);
  const response = await http({
    method: "GET",
    url: API_USER_URL,
    headers: headerMap({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "sentinel-local-owner",
      "x-github-api-version": "2022-11-28",
    }),
    body: null,
  });
  if (response.status !== 200) {
    // Classify through the shared rate-limit classifier only: a generic 403
    // (or any non-200 without a confirmed limit) yields null and never
    // invents a throttle. A confirmed 403/429 observation is persisted to the
    // same durable gate BEFORE the static startup failure is thrown; failed or
    // throwing persistence is itself a static failure with no follow-on
    // request.
    const observation = await classifyGitHubRateLimit(response, clock.now());
    if (observation !== null) {
      const persisted = await gate.recordRateLimit(
        installationId,
        observation,
      );
      if (!persisted.ok) throw new Error(STATIC_GITHUB_LOGIN);
    }
    throw new Error(STATIC_GITHUB_LOGIN);
  }
  let login: unknown = null;
  try {
    login = (JSON.parse(response.bodyText) as { login?: unknown } | null)
      ?.login;
  } catch {
    throw new Error(STATIC_GITHUB_LOGIN);
  }
  if (
    typeof login !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/.test(login)
  ) {
    throw new Error(STATIC_GITHUB_LOGIN);
  }
  return login;
}
