// Exact deployment identity and trusted managed-host derivation.
import type { DeploymentIdentityV1 } from "../contracts/shared.ts";
import { DENO_MANAGED_HOST_RE } from "./config.ts";

export const GIT_SHA_RE = /^[0-9a-f]{40}$/;
/**
 * Validated exact Deno revision id charset for the immutable hostname form:
 * the id is used as a single hostname label, so dots (subdomain boundaries)
 * are never accepted. Bounded by the local implementation constant.
 */
export const DENO_REVISION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function headerEquals(
  headers: Headers,
  name: string,
  value: string,
): boolean {
  return (headers.get(name) ?? null) === value;
}

/**
 * The target's identified Cloudflare warning exception: an HTTP 403 that is
 * demonstrably a Cloudflare Bot Fight Mode challenge (the gateway runner was
 * challenged, not the application). Identification requires the Cloudflare
 * `server` and `cf-mitigated: challenge` headers plus a non-empty `cf-ray`;
 * a 403 without all three is an application/origin 403 and is never
 * claimed to be a Cloudflare challenge.
 */
export function isVerifiedCloudflareChallenge(headers: Headers): boolean {
  const server = headers.get("server")?.trim().toLowerCase() ?? "";
  const mitigation = headers.get("cf-mitigated")?.trim().toLowerCase() ?? "";
  const ray = headers.get("cf-ray")?.trim() ?? "";
  return server === "cloudflare" && mitigation === "challenge" &&
    ray.length > 0;
}

export function sameIdentity(
  a: DeploymentIdentityV1,
  b: DeploymentIdentityV1,
): boolean {
  return a.gitSha === b.gitSha && a.revisionId === b.revisionId;
}

/**
 * Derives the immutable health base URL for one exact revision from the
 * trusted configured managed base URL. Only the config-validated root HTTPS
 * shape is accepted (https, no credentials, default port, no path/query/
 * fragment, hostname ending in `.deno.net` — the actual two-label target is
 * `<project>.<organization>.deno.net`), and the FIRST hostname label is
 * replaced with `label-<revisionId>` while every other label stays (Deno's
 * immutable hostname form). The first label need not equal the configured
 * project id; no platform-supplied URL is ever consumed.
 */
export function immutableManagedBaseUrl(
  managedBaseUrl: string,
  revisionId: string,
): string | null {
  if (!DENO_REVISION_ID_RE.test(revisionId)) return null;
  let url: URL;
  try {
    url = new URL(managedBaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  if (url.search !== "" || url.hash !== "") return null;
  const hostname = url.hostname;
  if (!DENO_MANAGED_HOST_RE.test(hostname)) return null;
  const dotIndex = hostname.indexOf(".");
  if (dotIndex <= 0) return null;
  const firstLabel = hostname.slice(0, dotIndex);
  const immutableHost = `${firstLabel}-${revisionId}${
    hostname.slice(firstLabel.length)
  }`;
  return `${url.protocol}//${immutableHost}`;
}
