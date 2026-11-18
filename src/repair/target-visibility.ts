/**
 * Which target repositories Sentinel may work (owner decision 2026-11-18:
 * "So moving forward let's simplify the logic: no private repos."; "2 ok").
 *
 * Sentinel runs in a public repository: its plans, cell bundles, logs and
 * state are readable by anyone signed in, so work on a private repository
 * would publish that repository's content. Sentinel therefore works a target
 * only when GitHub's own answer on a repository read says it is public. A
 * private or internal repository, and any answer that does not say (an
 * unreadable read, a missing or malformed `private`/`visibility` field), is
 * not worked: the target is skipped for the whole cycle, never treated as
 * public.
 *
 * `sentinelWorksRepositoryV1` is the ONE predicate every consumer applies
 * (the runtime's target load and the launcher's maintenance passes). A
 * future deployment that may work private repositories replaces it here,
 * in this owner-merged authority file, and nowhere else.
 */

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

/**
 * The one predicate: Sentinel works a repository only when GitHub said it
 * is public. Private and unknown are both skipped (fail closed).
 */
export function sentinelWorksRepositoryV1(
  visibility: TargetVisibilityV1,
): boolean {
  return visibility === "public";
}
