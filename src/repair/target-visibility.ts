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
 * (the runtime's target load and the launcher's maintenance passes).
 *
 * Deployment rule (owner, 2026-11-18, on a second, private deployment of the
 * same code: "can you please just handle all that"): what a run may expose
 * is decided by the repository the run itself executes in (the host,
 * `GITHUB_REPOSITORY`), never by a setting. Only a host GitHub answers is
 * private, and that does not list its own repository among its committed
 * targets, works private (or internal) targets, and then ONLY those: the
 * public deployment keeps every public target, Sentinel's own repository
 * included, so no target is worked by two deployments. Every other host
 * (public, unreadable, unstated, or one that works itself) is exactly the
 * public-only rule above. There is no variable or file that changes this.
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

/** The closed reason a host proven private skips a public target. */
export const PUBLIC_TARGET_REASON = "public_repository";

/** Why a repository GitHub did answer about is not worked on this host. */
export type TargetExclusionReasonV1 =
  | typeof PRIVATE_TARGET_REASON
  | typeof PUBLIC_TARGET_REASON;

/** The repository a run executes in (`GITHUB_REPOSITORY`), as decided. */
export interface SentinelHostV1 {
  /** GitHub's answer about the host; `unknown` when it was never read. */
  readonly visibility: TargetVisibilityV1;
  /** The host's own repository is one of its committed targets. */
  readonly worksItself: boolean;
}

/**
 * True only for a host GitHub answered is private that does not work its
 * own repository (a deployment that works Sentinel itself is the public
 * one). Absent, unknown, public or self-listed is never private.
 */
export function sentinelHostIsPrivateV1(
  host: SentinelHostV1 | undefined,
): boolean {
  return host !== undefined && !host.worksItself &&
    host.visibility === "private";
}

/**
 * The one predicate. On a host that is not proven private (or with no host
 * at all), Sentinel works a repository only when GitHub said it is public.
 * On a host proven private, it works a repository only when GitHub said it
 * is private (or internal): public ones belong to the public deployment.
 * Unknown is skipped on every host (fail closed).
 */
export function sentinelWorksRepositoryV1(
  visibility: TargetVisibilityV1,
  host?: SentinelHostV1,
): boolean {
  return sentinelHostIsPrivateV1(host)
    ? visibility === "private"
    : visibility === "public";
}

/** The closed reason a known answer is not worked on this host. */
export function targetExclusionReasonV1(
  host?: SentinelHostV1,
): TargetExclusionReasonV1 {
  return sentinelHostIsPrivateV1(host)
    ? PUBLIC_TARGET_REASON
    : PRIVATE_TARGET_REASON;
}

const HOST_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Decide the host once per run. `repository` is the run's native
 * `GITHUB_REPOSITORY` (already bound to the committed controller by the
 * caller's identity check); `listed` is the committed target setting. A host
 * that lists its own repository works itself, is never read here and is
 * never private, so the public deployment makes no extra read. Otherwise
 * `readVisibility` reads the host's own repository once; a throw, a missing
 * or malformed repository, or an answer that does not say is unknown.
 */
export async function resolveSentinelHostV1(input: {
  readonly repository: string | null | undefined;
  readonly listed: readonly string[];
  readonly readVisibility: () => Promise<TargetVisibilityV1>;
}): Promise<SentinelHostV1> {
  const repository = input.repository;
  if (typeof repository !== "string" || !HOST_SLUG.test(repository)) {
    return { visibility: "unknown", worksItself: false };
  }
  const key = repository.toLowerCase();
  if (input.listed.some((slug) => slug.toLowerCase() === key)) {
    return { visibility: "unknown", worksItself: true };
  }
  let visibility: TargetVisibilityV1 = "unknown";
  try {
    visibility = await input.readVisibility();
  } catch {
    visibility = "unknown";
  }
  return {
    visibility: visibility === "public" || visibility === "private"
      ? visibility
      : "unknown",
    worksItself: false,
  };
}
