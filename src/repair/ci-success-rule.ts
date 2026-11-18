/**
 * The CI integrity rule for a head that changes a CI-executable path (owner
 * directive 2026-11-17, "give sentinel full access"; redesigned 2026-11-18).
 * Such a pull request's own CI runs its own modified workflow, so a workflow
 * whose jobs are all skipped or neutral would otherwise read as green
 * (2026-10-24: skipped and neutral are not red), and an edit could drop or
 * skip the real tests and pass on a trivial new job.
 *
 * The expected jobs compare like with like: the job names GitHub Actions ran
 * to `success` on the head of the most recently merged pull request into the
 * same base branch (the same pull-request context: a base commit's runs come
 * from `push`, where a deploy or other push-only job runs that a pull request
 * head never runs). Every such name must also conclude `success` (its latest
 * run) on the candidate head; no name is exempt, skipped or absent, renamed
 * or not. When that merged pull request has no successful Actions job, up to
 * `CI_REFERENCE_PULLS_MAX` merged pull requests are walked back, newest merge
 * first. Only after that bound (or every merged pull request there is, when
 * the listing is provably complete) is there "no prior CI": then the base's
 * own Actions successes are expected (the strongest reference left), and
 * only when the base has none either is it a first CI workflow, which needs
 * at least one Actions job to succeed on the head. Anything unreadable, or a
 * listing that cannot prove the walk, is `unknown`: never satisfied (wait).
 *
 * Only GitHub Actions check runs count (`isTargetCiSuccessCheck`): never a
 * commit status, another app's check, a skipped or neutral job, or a backup-CI
 * stand-in (it runs the same modified workflow from the merge tree). The
 * runtime gates, the runtime merge executor and the launcher all read the
 * expectation through `readCiExpectation` and judge it with
 * `ciExpectationSatisfied`, so they cannot disagree.
 *
 * Whether a head changes such a path (`headCiChange`) is read through the
 * port's `readChangedPaths`, which diffs the local mirror first (no API read
 * when the mirror holds both commits) and falls back to one exact comparison.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { GitHubCheckV1, PortResultV1 } from "../contracts/ports.ts";
import type { MergedPullHeadsV1 } from "../contracts/ports-github-requests.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { latestChecks } from "./ci-rejection.ts";
import {
  isTargetCiSuccessCheck,
  selectMergeGateChecksV1,
} from "./merge-gate-checks.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";
import { ciExecutablePath } from "./workflow-trust.ts";

/** The pre-review park of such a head once its bounded wait ends. */
export const WORKFLOW_CI_SUCCESS_DETAIL =
  "CI-first: the head changes a CI-executable path and its own CI did not " +
  "run to success every job the last merged pull request passed; owner " +
  "action required";

/** Merged pull requests walked back for a reference at most. */
export const CI_REFERENCE_PULLS_MAX = 5;

/** The job names GitHub Actions ran to success on one commit (latest each). */
export function actionsSuccessNames(
  checks: readonly GitHubCheckV1[],
): string[] {
  return [
    ...new Set(
      latestChecks([...checks]).filter(isTargetCiSuccessCheck).map((check) =>
        check.name
      ),
    ),
  ].sort();
}

/** What a CI-changing head must pass, by the reference it was read from. */
export type CiExpectationV1 =
  | {
    readonly kind: "reference";
    /** The merged pull request head the names were read from. */
    readonly head: string;
    readonly names: readonly string[];
  }
  | { readonly kind: "base"; readonly names: readonly string[] }
  | { readonly kind: "first_ci" }
  | { readonly kind: "unknown" };

/** The two reads the expectation needs; null (or a throw) is unreadable. */
export interface CiReferenceReadsV1 {
  mergedPullHeads(): Promise<
    { readonly heads: readonly string[]; readonly complete: boolean } | null
  >;
  successNames(sha: string): Promise<readonly string[] | null>;
}

const UNKNOWN: CiExpectationV1 = { kind: "unknown" };

/**
 * The expectation for a CI-changing pull request into the branch whose
 * merged pull requests `reads` lists, with `base` its exact base commit.
 */
export async function readCiExpectation(
  reads: CiReferenceReadsV1,
  base: string,
): Promise<CiExpectationV1> {
  try {
    const listing = await reads.mergedPullHeads();
    if (listing === null) return UNKNOWN;
    const walked = listing.heads.slice(0, CI_REFERENCE_PULLS_MAX);
    for (const head of walked) {
      const names = await reads.successNames(head);
      if (names === null) return UNKNOWN;
      if (names.length > 0) return { kind: "reference", head, names };
    }
    // "No prior CI" needs the whole bound walked, or every merged pull
    // request there is; a full page with fewer merged ones proves nothing.
    if (walked.length < CI_REFERENCE_PULLS_MAX && !listing.complete) {
      return UNKNOWN;
    }
    const names = await reads.successNames(base);
    if (names === null) return UNKNOWN;
    return names.length > 0 ? { kind: "base", names } : { kind: "first_ci" };
  } catch {
    return UNKNOWN;
  }
}

/** Whether `head` (its Actions success names) meets `expectation`. */
export function ciExpectationSatisfied(
  expectation: CiExpectationV1,
  head: readonly string[],
): boolean {
  switch (expectation.kind) {
    case "unknown":
      return false;
    case "first_ci":
      return head.length > 0;
    default:
      return expectation.names.every((name) => head.includes(name));
  }
}

/** The runtime port reads the expectation consumes. */
export interface RuntimeCiReferencePortV1 {
  readChecks(head: GitSha): Promise<PortResultV1<{ checks: GitHubCheckV1[] }>>;
  readMergedPullHeads?(
    baseRef: string,
  ): Promise<PortResultV1<MergedPullHeadsV1>>;
}

/**
 * The runtime's reads over its GitHub port (or client): the merged listing
 * of `baseRef`, and each commit's gating checks reduced to Actions success
 * names (Passport's deploy observations are never expected). A port without
 * the listing is unreadable.
 */
export function runtimeCiReferenceReads(
  github: RuntimeCiReferencePortV1,
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
  baseRef: string | undefined,
): CiReferenceReadsV1 {
  return {
    async mergedPullHeads() {
      if (baseRef === undefined || github.readMergedPullHeads === undefined) {
        return null;
      }
      const read = await github.readMergedPullHeads(baseRef);
      return read.ok ? read.value : null;
    },
    async successNames(sha: string) {
      const read = await github.readChecks(sha as GitSha);
      if (!read.ok) return null;
      return actionsSuccessNames(
        selectMergeGateChecksV1(repository, read.value.checks).checks,
      );
    },
  };
}

/** The base branch configured for `record`'s repository, if any. */
export function recordBaseRef(
  deps: Partial<Pick<RepairCycleDepsV1, "configs">>,
  record: Pick<WorkRecordV1, "repository">,
): string | undefined {
  return deps.configs?.find((config) =>
    config.repository.owner === record.repository.owner &&
    config.repository.name === record.repository.name &&
    config.repository.installationId === record.repository.installationId
  )?.baseBranch;
}

/** What one change-set read says about a head's CI-executable change. */
export type HeadCiChangeV1 = "ci" | "none" | "unknown";

/**
 * `ci` when the record's exact `base...head` change set changes a
 * CI-executable path, `none` when it is read whole and does not, `unknown`
 * when it cannot be read whole (no read, a failed read, a list GitHub may
 * have truncated, or no head).
 */
export async function headCiChange(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: Pick<WorkRecordV1, "target">,
): Promise<HeadCiChangeV1> {
  const { base, head } = record.target;
  const read = deps.github.readChangedPaths;
  if (head === null || base === null || read === undefined) return "unknown";
  try {
    const paths = await read.call(deps.github, base, head);
    if (!paths.ok || paths.value === null) return "unknown";
    return paths.value.some(ciExecutablePath) ? "ci" : "none";
  } catch {
    return "unknown";
  }
}
