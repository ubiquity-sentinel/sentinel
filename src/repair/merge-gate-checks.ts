/**
 * Merge-gate check selection (owner directive 2026-10-30).
 *
 * For `ubiquity/passport.ubq.fi`, the checks its dispatch-only deployment
 * workflows report (`deploy-production` from `deno-deploy.yml`,
 * `deploy-standby` from `workers-deploy.yml`, and Cloudflare Pages/Workers
 * deployment statuses) are deployment signals, not correctness checks. They
 * are still read and carried as evidence here; only the target's own CI jobs
 * and their verified backup-CI stand-ins may decide the gate. Every other
 * target keeps judging every observed check exactly as before.
 *
 * Pure and shared by the runtime's `decideCiGate` and its CI-first/delivery
 * consumers. Nothing here is persisted or weakens a check that ran and failed:
 * a CI job's failure stays red.
 */
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";

/** Closed Passport identity; kept here so no ordinary file can change the gate. */
function isPassportDeployTarget(
  repository: Pick<RepositoryIdentityV1, "owner" | "name"> | undefined,
): boolean {
  return repository?.owner.toLowerCase() === "ubiquity" &&
    repository.name.toLowerCase() === "passport.ubq.fi";
}

/**
 * The deployment checks those dispatch-only workflows and Cloudflare report.
 * This is closed trusted policy keyed by external producer name; a repository
 * slug or candidate cannot add to it.
 */
const PASSPORT_DEPLOY_CHECK_NAMES: ReadonlySet<string> = new Set([
  "deploy",
  "deployment",
  "deploy-production",
  "deploy-standby",
  "deno deploy",
  "deno-deploy",
  "workers-deploy",
  "workers standby deploy",
  "workers builds",
  "cloudflare pages",
  "cloudflare workers",
  "pages",
  "pages build and deployment",
  "pages-build-deployment",
]);

const PASSPORT_DEPLOY_CHECK_PREFIXES = [
  "cloudflare pages",
  "cloudflare workers",
  "workers builds",
] as const;

/** Whether `name` is one of Passport's deployment signals, not CI. */
export function isPassportDeployCheck(
  repository: Pick<RepositoryIdentityV1, "owner" | "name"> | undefined,
  name: string,
): boolean {
  if (!isPassportDeployTarget(repository)) return false;
  const normalized = name.trim().toLowerCase();
  return PASSPORT_DEPLOY_CHECK_NAMES.has(normalized) ||
    PASSPORT_DEPLOY_CHECK_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix)
    );
}

/** One observation split into the gate set and retained evidence. */
export interface MergeGateCheckSelectionV1 {
  /** Checks that decide the gate (the target's own CI observations). */
  readonly checks: GitHubCheckV1[];
  /** Deployment observations retained as evidence, never a gate. */
  readonly deployChecks: GitHubCheckV1[];
}

/**
 * Split one complete check observation for the merge gate. On every target but
 * Passport (and for every non-deploy name) all checks stay in the gate set.
 */
export function selectMergeGateChecksV1(
  repository: Pick<RepositoryIdentityV1, "owner" | "name"> | undefined,
  checks: readonly GitHubCheckV1[],
): MergeGateCheckSelectionV1 {
  const ciChecks: GitHubCheckV1[] = [];
  const deployChecks: GitHubCheckV1[] = [];
  for (const check of checks) {
    if (isPassportDeployCheck(repository, check.name)) deployChecks.push(check);
    else ciChecks.push(check);
  }
  return { checks: ciChecks, deployChecks };
}
