/**
 * Launcher re-admission of a candidate parked on a base-refresh merge conflict
 * ("base refresh has conflicts[ at <base>]") before the installed runtime
 * could resolve one.
 *
 * Up to generation 77 a conflicting refresh was a terminal block that also
 * detached target.pr, although the candidate, its preserved descriptor, its
 * managed branch and its open pull request all still name the exact head H.
 * A runtime with an open conflict-resolution route schedules ONE charged
 * resolution per (task, base tip) instead (`src/repair/conflict-resolution.ts`).
 * This rule only restores such a record to `work` with the verified open pull
 * request as target.pr; it writes no marker, charges nothing and decides
 * nothing about the conflict. The installed runtime's own refresh then
 * re-observes the base, conflicts (or now merges cleanly), and its own shape
 * check, round ceiling and admission decide whether the resolution is charged.
 *
 * The rule is inert unless the AUTHENTICATED installed runtime is an exact
 * allowlisted conflict-resolution revision at generation 79 or later that
 * holds its own healthy proof for that exact pointer, and only a block
 * written BEFORE that runtime's pinned activation is re-admitted: a block the
 * resolving runtime wrote itself (a spent round allowance, a lost shape, a
 * closed route) is final, so no record cycles block -> re-admit. Generation 78
 * keeps the hosted route closed; generation 79 opens it
 * (`HOSTED_CONFLICT_RESOLUTIONS`). The allowlist is named by the commit that
 * pins the opening runtime, with its activation bound after its own healthy
 * proof; it never names R77 or R78, so either one restored at any later
 * generation is excluded by revision. Under any other runtime a re-admitted
 * head would only conflict and block again.
 *
 * A failed or unresolvable resolution keeps the conflict marker on its
 * retained intent. The ordinary retry table (`planHostedRetries`) refuses it
 * while its settled charge names the still-current base tip, and otherwise
 * returns it to a plain refresh at the moved tip only when its blocker class
 * is one the table retries (a protected-path resolution stays owner-terminal),
 * so no launcher path spends a second charge on the same base tip.
 *
 * All eligible re-admissions and moved-tip re-pends may proceed in one pass;
 * per-task review, same-base charge and execution deadline guards remain.
 */
import { isGitSha } from "../src/contracts/brands.ts";
import { HOSTED_RUNTIME_ROLLOUT } from "../src/host/hosted-runtime-rollout.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../src/contracts/hosted-supervisor.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { conflictResolutionShape } from "../src/repair/conflict-resolution.ts";
import { candidateBranch } from "../src/repair/keys.ts";
import {
  type BaseRefreshCandidateV1,
  type BaseRefreshReadmissionV1,
  verifyBaseRefreshReadmissions,
} from "./hosted-autonomy-base-refresh-retries.ts";
import { hostedIssueKey, sameRepository } from "./hosted-autonomy-policy.ts";
import { refreshFixActivation } from "./hosted-autonomy-refresh-rearm.ts";
import {
  ciFirstRuntimeProven,
  ciFirstSelfInstalledRuntimeProven,
  LEGACY_ROUND_REQUIRES_CI_FIRST,
  legacyFinalRoundAdmissible,
} from "./hosted-autonomy-ci-first.ts";
import type { HostedAutonomyScopeV1 } from "./hosted-autonomy-scopes.ts";
import type { HostedRefreshRearmRuntimeV1 } from "./hosted-autonomy-types.ts";

/**
 * First runtime generation whose HOSTED resolution route is open. Generation
 * 78 carries the route but keeps it closed in hosted runs (its rollback target
 * 77 refused the cell); generation 79 opens it.
 */
export const HOSTED_AUTONOMY_CONFLICT_RESOLUTION_MIN_GENERATION = 79;

/**
 * Exact runtime revisions whose HOSTED conflict-resolution route is open
 * (`HOSTED_CONFLICT_RESOLUTIONS` true in that revision's own tree, which a test
 * proves for every listed revision present locally), each with an instant no
 * later than its first activation (see `HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES`).
 * The commit that pins the generation-79 runtime adds it; R77 and R78 keep the
 * hosted route closed and are never listed. A generation number never
 * qualifies.
 */
export const HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES:
  readonly HostedRefreshRearmRuntimeV1[] = [
    ...HOSTED_RUNTIME_ROLLOUT.conflictResolution,
    // Generation 79 (R79, which opens the hosted route), pinned by its
    // launcher commit at 1792185359753.
    {
      revision: "549c7a69186b3d2070aa4e69c92ee846d183ce8f",
      activatedNotBefore: 1792185359753,
    },
    // Generation 80 (R80, which keeps the hosted route open), pinned by its
    // launcher commit at 1792256700000.
    {
      revision: "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481",
      activatedNotBefore: 1792256700000,
    },
    // Generation 81 (R81), bound before publication and first activation.
    {
      revision: "da98f5f49c45b57cfa97a45fe647c36b1021f302",
      activatedNotBefore: 1792299493000,
    },
  ];

/**
 * Retired four-record throttle. Keep the exported numeric policy compatible
 * while admitting every remotely verified candidate. Review rounds, unique
 * charged reservations per base and execution deadlines remain authoritative.
 */
export const HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS =
  Number.MAX_SAFE_INTEGER;

/** The exact terminal conflict blocker a refresh writes (legacy bare form too). */
export const BASE_REFRESH_CONFLICT_BLOCKER =
  /^base refresh has conflicts( at [0-9a-f]{40})?$/;

/** Action detail of every verified conflict re-admission. */
export const CONFLICT_READMISSION_DETAIL = "base_refresh_conflict";

/**
 * True only for an allowlisted conflict-resolution runtime at generation 79+
 * whose own settled healthy proof binds this exact revision and generation.
 */
export function conflictResolutionRuntimeProven(
  runtime: HostedRuntimeRecordV1 | null | undefined,
  pinned: readonly HostedRefreshRearmRuntimeV1[] =
    HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES,
): boolean {
  if (runtime === null || runtime === undefined) return false;
  const proof = runtime.lastHealthyProof;
  return pinned.some((row) => row.revision === runtime.activeRevision) &&
    Number.isSafeInteger(runtime.generation) &&
    runtime.generation >= HOSTED_AUTONOMY_CONFLICT_RESOLUTION_MIN_GENERATION &&
    proof !== null && proof.outcome === "healthy" && proof.settled === true &&
    proof.startupReady === true &&
    proof.execution.revision === runtime.activeRevision &&
    proof.execution.generation === runtime.generation;
}

/** The record with its restored PR identity, as the runtime will see it. */
function withPullRequest(
  record: RepairStateSnapshotV1["work"][number],
  pullRequest: number,
): RepairStateSnapshotV1["work"][number] {
  return { ...record, target: { ...record.target, pr: pullRequest } };
}

/**
 * Pure local gating. Inert (nothing planned, nothing reported) unless the
 * installed runtime is a proven conflict-resolution runtime; afterwards each
 * conflict block is either planned for remote verification or reported.
 */
export function planConflictReadmissions(
  snapshot: RepairStateSnapshotV1,
  release: ReleaseStateSnapshotV1 | null,
  closedIssues: ReadonlySet<string>,
  onDenied?: (denial: { id: string; reason: string }) => void,
  pinned: readonly HostedRefreshRearmRuntimeV1[] =
    HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES,
  /** The launcher's legacy review cutoff (`launcherLegacyCutoff`). */
  cutoff: number | null = null,
): BaseRefreshCandidateV1[] {
  if (release === null) return [];
  const installed = release.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  if (!conflictResolutionRuntimeProven(installed, pinned)) return [];
  const activation = refreshFixActivation(release, pinned);
  const candidates: BaseRefreshCandidateV1[] = [];
  for (const record of snapshot.work) {
    const blocker = record.blocker;
    if (
      record.nextStep !== "blocked" || blocker === null ||
      blocker.kind !== "other" ||
      !BASE_REFRESH_CONFLICT_BLOCKER.test(blocker.message)
    ) continue;
    // A block at or after the resolving runtime's activation may be its own.
    if (activation === null || blocker.since >= activation) {
      onDenied?.({ id: record.id, reason: "conflict_block_after_activation" });
      continue;
    }
    // Exactly the terminal shape the refresh wrote: no pending operation, no
    // wait and the dead PR identity cleared.
    if (
      record.intent !== null || record.wait !== null ||
      record.target.pr !== null || record.source.kind !== "issue" ||
      record.related.issueNumber === null
    ) continue;
    if (
      closedIssues.has(
        hostedIssueKey(record.repository, record.related.issueNumber),
      )
    ) continue;
    const head = record.target.head;
    // The runtime's OWN shape (a stand-in PR number until the open pull
    // request is verified; the exact one is re-checked after verification).
    if (
      head === null || !isGitSha(head) ||
      !conflictResolutionShape(withPullRequest(record, 1), snapshot, cutoff)
    ) {
      onDenied?.({ id: record.id, reason: "conflict_unresolvable_shape" });
      continue;
    }
    // A legacy record's one final round (the resolved merge's review)
    // is spent only on a green head, under a proven CI-first runtime.
    if (
      !legacyFinalRoundAdmissible(
        snapshot,
        record,
        ciFirstRuntimeProven(installed) ||
          ciFirstSelfInstalledRuntimeProven(installed),
      )
    ) {
      onDenied?.({ id: record.id, reason: LEGACY_ROUND_REQUIRES_CI_FIRST });
      continue;
    }
    candidates.push({
      id: record.id,
      repository: record.repository,
      branch: candidateBranch(record.id),
      head,
      detail: CONFLICT_READMISSION_DETAIL,
    });
  }
  return candidates;
}

/**
 * Remote verification through each record's OWN repository surface (the
 * owned open PR on the exact branch at the published head, exactly as the
 * credential-expiry rule verifies it), then the runtime's shape again with
 * the verified pull request, so a head a review of that PR rejected is never
 * re-admitted. At most `limit` re-admissions are returned: only candidates
 * that verified count, so a dropped one never holds a slot, and every
 * candidate past the cap is reported (`conflict_resolution_cap`) without any
 * remote read and waits for a later pass.
 */
export async function verifyConflictReadmissions(
  snapshot: RepairStateSnapshotV1,
  candidates: readonly BaseRefreshCandidateV1[],
  scopeFor: (
    repository: RepositoryIdentityV1,
  ) => Promise<HostedAutonomyScopeV1>,
  actions: string[],
  limit: number = HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS,
  /** The launcher's legacy review cutoff (`launcherLegacyCutoff`). */
  cutoff: number | null = null,
): Promise<BaseRefreshReadmissionV1[]> {
  const admitted: BaseRefreshReadmissionV1[] = [];
  for (const candidate of candidates) {
    if (admitted.length >= limit) {
      actions.push(`retry:${candidate.id}:skipped:conflict_resolution_cap`);
      continue;
    }
    const [readmission] = await verifyBaseRefreshReadmissions(
      [candidate],
      scopeFor,
      actions,
    );
    if (readmission === undefined) continue;
    const record = snapshot.work.find((row) =>
      row.id === readmission.id &&
      sameRepository(row.repository, readmission.repository)
    );
    const eligible = record !== undefined &&
      conflictResolutionShape(
        withPullRequest(record, readmission.pullRequest),
        snapshot,
        cutoff,
      );
    if (!eligible) {
      actions.push(
        `retry:${readmission.id}:skipped:conflict_unresolvable_shape`,
      );
      continue;
    }
    admitted.push(readmission);
  }
  return admitted;
}
