/**
 * Owner-landing publication: a candidate that changes a protected path of its
 * target is published, tested and reviewed like any candidate, but Sentinel
 * never merges it. The repository owner merges it, and that human merge
 * completes the record through the ordinary human-merge path.
 *
 * Only a change that could run in CI with elevated rights or rewrite the
 * policy itself stays unpublishable and keeps the pre-publication park:
 * anything under `.github/` (workflows, composite actions, repository
 * automation), `.git/`, env files, the act configuration files the backup CI
 * must never read from the target tree, `.npmrc` and the generic target's own
 * `sentinel.protected` list. A candidate touching any of those is never
 * pushed.
 */
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1, WorkWaitV1 } from "../contracts/work-record.ts";
import type { WorkWaitCauseV1 } from "../contracts/work-wait-cause.ts";
import { targetTouchesProtectedV1 } from "../host/target-policy-generic.ts";
import { normalizePathPrefix, touchesProtected } from "./loop-records.ts";

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

const CI_CONFIG_FILES: readonly string[] = Object.freeze([
  ".actrc",
  ".secrets",
  ".vars",
  ".input",
  ".npmrc",
  "sentinel.protected",
]);

/**
 * A path whose change could execute in CI with elevated rights or change
 * what CI or the protected policy reads: never published.
 */
export function ciExecutablePath(path: string): boolean {
  const normalized = normalizePathPrefix(path);
  const segments = normalized.split("/");
  if (segments[0] === ".github" || segments.includes(".git")) return true;
  const base = segments[segments.length - 1] ?? "";
  return base.startsWith(".env") || CI_CONFIG_FILES.includes(base);
}

/** How one candidate's change set meets its target's protected paths. */
export type OwnerLandingTouchV1 =
  | { kind: "none" }
  | { kind: "unpublishable" }
  | { kind: "owner"; paths: string[] };

/**
 * `owner` names the configured protected prefixes the change touches
 * (sorted, unique). A protected path no configured literal prefix covers (a
 * generic target's nested env family) or any CI-executable path is
 * `unpublishable`.
 */
export function ownerLandingTouch(
  config: Pick<RepositoryConfigV1, "commands" | "protectedPaths">,
  changedPaths: readonly string[],
): OwnerLandingTouchV1 {
  const hits = changedPaths.filter((path) =>
    targetTouchesProtectedV1(config, path)
  );
  if (hits.length === 0) return { kind: "none" };
  const prefixes = new Set<string>();
  for (const path of hits) {
    if (ciExecutablePath(path)) return { kind: "unpublishable" };
    const covering = config.protectedPaths.filter((prefix) =>
      touchesProtected([prefix], path)
    );
    if (
      covering.length === 0 ||
      covering.some((prefix) => ciExecutablePath(prefix))
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

/** The record without the owner-landing flag (an unpublished park). */
export function withoutOwnerLanding(record: WorkRecordV1): WorkRecordV1 {
  if (record.ownerLanding === undefined) return record;
  const { ownerLanding: _dropped, ...rest } = record;
  return rest;
}

/**
 * The protected paths a publication of this record is validated against:
 * the configured list minus the prefixes its owner-landing flag names. A
 * CI-executable prefix is never removed.
 */
export function publicationProtectedPaths(
  protectedPaths: readonly string[],
  record: Pick<WorkRecordV1, "ownerLanding"> | null,
): string[] {
  const named = record?.ownerLanding?.paths ?? [];
  return protectedPaths.filter((prefix) =>
    ciExecutablePath(prefix) || !named.includes(prefix)
  );
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
 * CI-executable path, or a protected prefix its owner-landing flag does not
 * already name (a conflict-resolution merge never widens the flag).
 */
export function protectedBeyondOwnerLanding(
  config: Pick<RepositoryConfigV1, "commands" | "protectedPaths">,
  record: Pick<WorkRecordV1, "ownerLanding">,
  changedPaths: readonly string[],
): boolean {
  const touch = ownerLandingTouch(config, changedPaths);
  if (touch.kind !== "owner") return touch.kind === "unpublishable";
  const named = record.ownerLanding?.paths ?? [];
  return touch.paths.some((path) => !named.includes(path));
}
