/**
 * Owner-landing publication and the protected-path classification (owner
 * directive 2026-11-17, "give sentinel full access"): a protected change a
 * target's configuration names is published as an ordinary pull request and
 * merged by Sentinel through the unchanged gates (current-head CI not red,
 * completed native review with no unresolved P0, task acceptance, custody
 * and accounting), with two exceptions:
 *
 * - A credential or history path (`credentialPath`: `.git/`, `.env*`, the
 *   act/npm credential files the backup CI must never read and a target's
 *   own `sentinel.protected` list) is never published on any target and
 *   keeps the pre-publication park.
 * - On Sentinel's own repository every configured protected prefix (its
 *   authority files, `SENTINEL_AUTHORITY_PATHS`: credential minting and
 *   selection, write-token dispatch, the merge gate, promotion and this
 *   policy itself) is published, tested and reviewed, but Sentinel never
 *   merges it: its owner does, and that human merge completes the record
 *   through the ordinary human-merge path. Any `.github/` path there stays
 *   unpublishable, as before the directive: a pushed workflow would run with
 *   Sentinel's own secrets and a writable token before the owner saw it.
 * - A changed path no predicate can classify (`unsafeChangedPath`: quoted,
 *   escaped, absolute or not normalised) is unpublishable everywhere.
 */
import { isPublicControllerNameV1 } from "../contracts/hosted-controller-deployment.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1, WorkWaitV1 } from "../contracts/work-record.ts";
import type { WorkWaitCauseV1 } from "../contracts/work-wait-cause.ts";
import { SENTINEL_AUTHORITY_PATHS } from "../host/hosted-authority-protected-paths.ts";
import { targetTouchesProtectedV1 } from "../host/target-policy-generic.ts";
import { normalizePathPrefix, touchesProtected } from "./loop-records.ts";
import { ciExecutablePath, unsafeChangedPath } from "./workflow-trust.ts";

/** The delivery refusal (launcher actions) of an owner-landing record. */
export const OWNER_MERGE_REQUIRED = "owner_merge_required";

/** The wait cause code an owner-landing record parks with (#335). */
export const OWNER_MERGE_WAIT_CAUSE: WorkWaitCauseV1 = {
  port: "github",
  status: "none",
  code: "owner_merge",
};

/** How often a record waiting for its owner's merge re-reads its PR. */
export const OWNER_LANDING_POLL_MS = 15 * 60_000;

const CREDENTIAL_FILES: readonly string[] = Object.freeze([
  ".actrc",
  ".secrets",
  ".vars",
  ".input",
  ".npmrc",
  "sentinel.protected",
]);

/**
 * A credential or history path: `.git/` anywhere, any `.env*` file, the
 * act/npm credential configuration the backup CI must never read from a
 * target tree, a target's own `sentinel.protected` list, and any path no
 * predicate can classify (`unsafeChangedPath`). A workflow or other
 * `.github/` path is not one (2026-11-17). It refuses a change only where a
 * configured protected prefix covers it (`ownerLandingTouch`); a key file
 * relies on the secret-shaped-text detector.
 */
export function credentialPath(path: string): boolean {
  if (unsafeChangedPath(path)) return true;
  const normalized = normalizePathPrefix(path);
  const segments = normalized.split("/");
  if (segments.includes(".git")) return true;
  const base = segments[segments.length - 1] ?? "";
  return base.startsWith(".env") || CREDENTIAL_FILES.includes(base);
}

/**
 * A Sentinel authority path (or prefix inside one): on Sentinel's own
 * repository a configured protected change to it lands for the owner.
 */
export function authorityPath(path: string): boolean {
  return touchesProtected(SENTINEL_AUTHORITY_PATHS, normalizePathPrefix(path));
}

/**
 * A protected path or prefix that is never published on any target. The
 * implementer prompt names the configured prefixes this refuses
 * (`model-port-prompt.ts`), so the prompt and this gate share one predicate.
 */
export function unpublishablePath(path: string): boolean {
  return credentialPath(path);
}

/** Sentinel's own repository: only its owner merges its protected changes. */
export function ownerMergesProtectedChanges(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
): boolean {
  return isPublicControllerNameV1(
    repository.owner.toLowerCase(),
    repository.name.toLowerCase(),
  );
}

/** How one candidate's change set meets its target's protected paths. */
export type OwnerLandingTouchV1 =
  | { kind: "none" }
  | { kind: "unpublishable" }
  | { kind: "owner"; paths: string[] };

/**
 * `owner` names the configured protected prefixes the change touches
 * (sorted, unique); only Sentinel's own repository has them. A credential
 * path, or (on Sentinel itself) a protected path no configured literal
 * prefix covers, is `unpublishable`. Any other protected change is `none`:
 * an ordinary pull request that Sentinel merges through the normal gates.
 */
export function ownerLandingTouch(
  config: Pick<RepositoryConfigV1, "commands" | "protectedPaths">,
  changedPaths: readonly string[],
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
): OwnerLandingTouchV1 {
  // Fail closed on a path no predicate can classify, and keep Sentinel's own
  // `.github/` unpublishable whatever its configuration lists.
  if (changedPaths.some(unsafeChangedPath)) return { kind: "unpublishable" };
  if (
    ownerMergesProtectedChanges(repository) &&
    changedPaths.some(ciExecutablePath)
  ) return { kind: "unpublishable" };
  const hits = changedPaths.filter((path) =>
    targetTouchesProtectedV1(config, path)
  );
  if (hits.some(unpublishablePath)) return { kind: "unpublishable" };
  if (hits.length === 0 || !ownerMergesProtectedChanges(repository)) {
    return { kind: "none" };
  }
  const prefixes = new Set<string>();
  for (const path of hits) {
    const covering = config.protectedPaths.filter((prefix) =>
      touchesProtected([prefix], path)
    );
    if (
      covering.length === 0 ||
      covering.some((prefix) => unpublishablePath(prefix))
    ) return { kind: "unpublishable" };
    for (const prefix of covering) prefixes.add(prefix);
  }
  return { kind: "owner", paths: [...prefixes].sort() };
}

/** The record with its owner-landing paths widened by `paths`. */
export function withOwnerLanding(
  record: WorkRecordV1,
  paths: readonly string[],
  now: number,
): WorkRecordV1 {
  const merged = [
    ...new Set([...(record.ownerLanding?.paths ?? []), ...paths]),
  ].sort();
  return {
    ...record,
    ownerLanding: { paths: merged, since: record.ownerLanding?.since ?? now },
  };
}

/**
 * The record with its owner-landing flag REPLACED from one implementation
 * candidate's full base..head change set: the protected prefixes it touches
 * now, or no flag when it touches none (ordinary delivery applies again). A
 * conflict-resolution merge never replaces; it only widens (above).
 */
export function replaceOwnerLanding(
  record: WorkRecordV1,
  paths: readonly string[],
  now: number,
): WorkRecordV1 {
  if (paths.length === 0) return withoutOwnerLanding(record);
  return {
    ...record,
    ownerLanding: {
      paths: [...new Set(paths)].sort(),
      since: record.ownerLanding?.since ?? now,
    },
  };
}

/** The record without the owner-landing flag (an unpublished park). */
export function withoutOwnerLanding(record: WorkRecordV1): WorkRecordV1 {
  if (record.ownerLanding === undefined) return record;
  const { ownerLanding: _dropped, ...rest } = record;
  return rest;
}

/**
 * The protected paths a publication of this record is validated against:
 * every credential prefix, and on Sentinel's own repository the configured
 * prefixes its owner-landing flag does not name. On any other target the
 * remaining configured prefixes publish as ordinary changes.
 */
export function publicationProtectedPaths(
  protectedPaths: readonly string[],
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
  record: Pick<WorkRecordV1, "ownerLanding"> | null,
): string[] {
  const named = record?.ownerLanding?.paths ?? [];
  const owner = ownerMergesProtectedChanges(repository);
  const refused = protectedPaths.filter((prefix) =>
    unpublishablePath(prefix) ||
    (owner && (ciExecutablePath(prefix) || !named.includes(prefix)))
  );
  // Sentinel's own `.github/` is refused whole, configured or not.
  return owner && !refused.includes(".github/")
    ? [...refused, ".github/"]
    : refused;
}

/**
 * A change set Sentinel never merges on its own (the launcher's merge-time
 * gate): a credential path anywhere, or a protected path of Sentinel's own
 * repository, which only its owner merges.
 */
export function sentinelNeverMerges(
  config: Pick<RepositoryConfigV1, "commands" | "protectedPaths">,
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
  changedPaths: readonly string[],
): boolean {
  return ownerLandingTouch(config, changedPaths, repository).kind !== "none";
}

/** The bounded wait of a reviewed, CI-green owner-landing record. */
export function ownerMergeWait(record: WorkRecordV1, now: number): WorkWaitV1 {
  const since = ownerMergeReady(record) ? record.wait!.since : now;
  return { reason: "manual", since, until: now + OWNER_LANDING_POLL_MS };
}

/** The record waits for its owner's merge (reviewed, CI green). */
export function ownerMergeReady(record: WorkRecordV1): boolean {
  return record.ownerLanding !== undefined &&
    record.nextStep === "delivery" && record.wait?.reason === "manual";
}

/** At most this many paths are named in the owner comment. */
const OWNER_WORDS_PATHS = 10;

/** The one owner comment of a ready owner-landing pull request. */
export function ownerLandingWords(paths: readonly string[]): string {
  const named = paths.slice(0, OWNER_WORDS_PATHS).map((path) => `\`${path}\``)
    .join(", ");
  const more = paths.length > OWNER_WORDS_PATHS
    ? ` and ${paths.length - OWNER_WORDS_PATHS} more`
    : "";
  return `Ready for the repository owner to merge: this change touches ` +
    `protected path(s) ${named}${more}; Sentinel never merges protected paths.`;
}

/**
 * A change set touches a protected path this record may not publish: any
 * credential path, or on Sentinel itself a protected prefix its owner-landing
 * flag does not already name (a conflict-resolution merge never widens it).
 */
export function protectedBeyondOwnerLanding(
  config: Pick<RepositoryConfigV1, "commands" | "protectedPaths">,
  record: Pick<WorkRecordV1, "ownerLanding" | "repository">,
  changedPaths: readonly string[],
): boolean {
  const touch = ownerLandingTouch(config, changedPaths, record.repository);
  if (touch.kind !== "owner") return touch.kind === "unpublishable";
  const named = record.ownerLanding?.paths ?? [];
  return touch.paths.some((path) => !named.includes(path));
}
