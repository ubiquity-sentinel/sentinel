/** Decode GitHub repository visibility. Deployment policy lives in hosted-controller-deployment.ts. */
/** GitHub's answer about one repository, as Sentinel reads it. */
export type TargetVisibilityV1 = "public" | "private" | "unknown";

/** The one closed reason a target is skipped for its visibility. */
export const PRIVATE_TARGET_REASON = "private_repository";

/**
 * The visibility in one `GET /repos/{owner}/{name}` answer body. Public only
 * when `private` is exactly `false` and `visibility`, when GitHub sends it,
 * is exactly `"public"`; private when `private` is `true` or `visibility` is
 * `"private"` or `"internal"`; anything else is unknown.
 */
export function repositoryVisibilityV1(body: unknown): TargetVisibilityV1 {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "unknown";
  }
  const record = body as Record<string, unknown>;
  const flag = record["private"];
  const visibility = record["visibility"];
  if (
    flag === true || visibility === "private" || visibility === "internal"
  ) return "private";
  if (
    flag === false &&
    (visibility === undefined || visibility === "public")
  ) return "public";
  return "unknown";
}

/** The closed reason a host proven private skips a public target. */
export const PUBLIC_TARGET_REASON = "public_repository";

/** Why a repository GitHub did answer about is not worked on this host. */
export type TargetExclusionReasonV1 =
  | typeof PRIVATE_TARGET_REASON
  | typeof PUBLIC_TARGET_REASON;
