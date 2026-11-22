/**
 * Committed targets the run's minted target token does not cover.
 *
 * A tolerant App-token mint (`.github/actions/sentinel-app-token`, input
 * `tolerate-inaccessible-repositories`) may drop a listed repository from the
 * token. A PUBLIC repository stays readable without the installation, so a
 * read alone would still configure, plan and charge it until the native App
 * principal refused at publication. These helpers exclude it explicitly for
 * the run, before any read, under the closed reason `token_scope`: never
 * planned, worked or charged, its records untouched. Sentinel's own
 * repositories are never excluded (they are not on the target token).
 *
 * Absent or unusable evidence (an older workflow, a grant without repository
 * names, an unset variable) excludes nothing: exactly today's behaviour.
 */
import { isHostedControllerDeploymentSlugV1 } from "../contracts/hosted-controller-deployment.ts";
import { parseHostedAppMintGrant } from "./hosted-app-grant.ts";

export const TARGET_TOKEN_SCOPE_REASON = "token_scope";
/** Maintenance input: the same job's mint output `unavailable-repositories`. */
export const UNAVAILABLE_TARGETS_ENV = "SENTINEL_UNAVAILABLE_TARGETS";
const MAX_REPORTED_BYTES = 16_384;

const lower = (value: string) => value.toLowerCase();
const foreign = (slug: string) => !isHostedControllerDeploymentSlugV1(slug);

/**
 * Runtime jobs: a predicate for "this listed slug is outside the same-mint
 * grant's repository names", or null when the grant names none.
 */
export function grantTokenScopeV1(
  grant: string | null | undefined,
  now: number,
  installationId: number,
): ((slug: string) => boolean) | null {
  const parsed = parseHostedAppMintGrant(
    grant ?? undefined,
    now,
    installationId,
  );
  if (parsed === null || parsed.repositoryNames === undefined) return null;
  const covered = new Set(parsed.repositoryNames.map(lower));
  return (slug) => {
    const name = slug.split("/")[1];
    return foreign(slug) && name !== undefined && !covered.has(lower(name));
  };
}

/**
 * Maintenance: the listed foreign slugs the mint reported dropped. A name
 * outside the committed list is ignored, so the report can only remove.
 */
export function reportedTokenScopeV1(
  listed: readonly string[],
  reported: string | null | undefined,
): string[] {
  if (
    typeof reported !== "string" || reported === "" ||
    reported.length > MAX_REPORTED_BYTES
  ) return [];
  const names = new Set(
    reported.split(/[\n,]+/).map((part) => lower(part.trim())),
  );
  return listed.filter((slug) => foreign(slug) && names.has(lower(slug)));
}

/** One text-free line: the closed reason, the count and the listed slugs. */
export function tokenScopeLineV1(
  excluded: readonly string[],
): Record<string, unknown> | null {
  return excluded.length === 0 ? null : {
    kind: "sentinel_target_token_scope",
    reason: TARGET_TOKEN_SCOPE_REASON,
    count: excluded.length,
    targets: [...excluded],
  };
}

/**
 * The launcher gate's visibility read, except that an excluded repository is
 * `unknown` without any read: the gate then hides it for the run (no surface,
 * its rows restored byte-identical on every write).
 */
export function scopedVisibilityReaderV1<
  T extends { owner: string; name: string },
  V,
>(
  read: (repository: T) => Promise<V>,
  excluded: readonly string[],
): (repository: T) => Promise<V | "unknown"> {
  const hidden = new Set(excluded.map(lower));
  if (hidden.size === 0) return read;
  return (repository) =>
    hidden.has(lower(`${repository.owner}/${repository.name}`))
      ? Promise.resolve("unknown")
      : read(repository);
}

/**
 * The same resolver, except that a target outside the token is skipped
 * without any read and recorded in `excluded`.
 */
export function scopedTargetResolverV1<T extends { slug: string }, R>(
  resolve: (target: T) => Promise<R | null>,
  outside: ((slug: string) => boolean) | null,
  excluded: string[],
): (target: T) => Promise<R | null> {
  if (outside === null) return resolve;
  return (target) => {
    if (!outside(target.slug)) return resolve(target);
    excluded.push(target.slug);
    return Promise.resolve(null);
  };
}
