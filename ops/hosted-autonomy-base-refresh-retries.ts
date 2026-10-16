/**
 * Launcher re-admission rule for one base-refresh TERMINAL block class: a
 * per-job credential expiry.
 *
 * Generation <= 76 counted `auth_failed` as a failed refresh execution, so
 * three consecutive expiries of the repair job's short-lived installation
 * token ended in
 * "base refresh failed 3 consecutive times: auth_failed <closed detail>"
 * and cleared target.pr. That is not evidence about the pull request: the
 * record is re-admitted to `work` only while its PR is still OPEN, owned by a
 * trusted publisher, on the exact deterministic branch and at the exact
 * published head, and target.pr is restored from that verified PR alone.
 * Nothing is charged; the runtime's own freshness gate then re-plans the
 * refresh before any review spend. The rule is not part of the prefix table
 * of `HOSTED_AUTONOMY_RETRYABLE` because it needs remote verification and a
 * target-specific transition; it shares that table's retry budget and
 * closed-issue gates.
 *
 * A deterministic merge conflict ("base refresh has conflicts[ at <base>]")
 * is deliberately not re-admitted: the conflicting candidate cannot be
 * published over the current base, so it stays a visible terminal block.
 *
 * The transition writes generation-76 shapes only (no new key, field or enum
 * value), so a rollback still parses every record. It relies on the
 * generation-77 credential deferral, so this launcher logic ships with or
 * after generation 77 and re-admits nothing while a runtime without that
 * deferral is active (see `BASE_REFRESH_LEGACY_RUNTIMES`).
 */
import { type GitSha, isGitSha } from "../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../src/contracts/work-record.ts";
import { candidateBranch } from "../src/repair/keys.ts";
import {
  BASE_REFRESH_BASE_READ_DETAIL,
  BASE_REFRESH_CAPABILITY_DETAIL,
  BASE_REFRESH_FOREIGN_HEAD_DETAIL,
  BASE_REFRESH_PR_OBSERVATION_DETAIL,
  BASE_REFRESH_PRESERVE_DETAIL,
  BASE_REFRESH_PUSH_DETAIL,
  BASE_REFRESH_REF_READ_DETAIL,
  BASE_REFRESH_UNPREPARED_DETAIL,
  MAX_BASE_REFRESH_FAILURES,
} from "../src/repair/loop-base-refresh-failure.ts";
import {
  HOSTED_AUTONOMY_MAX_RETRIES,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  hostedIssueKey,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import { taskReservationCount } from "./hosted-autonomy-retries.ts";
import type { HostedAutonomyScopeV1 } from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyHeadPullV1 } from "./hosted-autonomy-types.ts";

/**
 * The exact terminal messages a credential expiry produced under generation
 * <= 76: the bounded failure count at its limit, the `auth_failed` kind and
 * one of the closed failure details. Any other text (another kind, count or
 * detail) is not this class. Generation 77 never writes these for a genuine
 * credential failure (it defers without counting), and a counted
 * `auth_failed` (a 403 permission refusal) carries the closed
 * `BASE_REFRESH_PERMISSION_SUFFIX`, so it is never re-admitted here: a
 * lasting refusal cannot loop through uncharged re-admissions.
 */
export const BASE_REFRESH_AUTH_BLOCKERS: ReadonlySet<string> = new Set(
  [
    BASE_REFRESH_PR_OBSERVATION_DETAIL,
    BASE_REFRESH_CAPABILITY_DETAIL,
    BASE_REFRESH_UNPREPARED_DETAIL,
    BASE_REFRESH_BASE_READ_DETAIL,
    BASE_REFRESH_PRESERVE_DETAIL,
    BASE_REFRESH_REF_READ_DETAIL,
    BASE_REFRESH_PUSH_DETAIL,
    BASE_REFRESH_FOREIGN_HEAD_DETAIL,
  ].map((detail) =>
    `base refresh failed ${MAX_BASE_REFRESH_FAILURES} consecutive times: auth_failed ${detail}`
  ),
);

/**
 * Active hosted runtime revisions WITHOUT the generation-77 credential
 * deferral: generation 76, the one-time rollback target of a failed
 * generation 77. Under it every credential expiry counts again, so a
 * re-admission could cycle block -> re-admit without any charge. While one of
 * these is active nothing is re-admitted.
 */
const BASE_REFRESH_LEGACY_RUNTIMES: ReadonlySet<string> = new Set([
  "41bb853a1bedfc0422bf903dfabbe23bf714b44f",
]);

/** Action detail of every verified credential-expiry re-admission. */
const READMISSION_DETAIL = "base_refresh_auth_expired";

/** A blocked record that passed every local gate; remote facts pending. */
export interface BaseRefreshCandidateV1 {
  id: string;
  repository: RepositoryIdentityV1;
  branch: string;
  /** The exact published head the branch and its open PR must carry. */
  head: GitSha;
}

/** A verified re-admission, applied by `applyBaseRefreshReadmissions`. */
export interface BaseRefreshReadmissionV1 {
  id: string;
  repository: RepositoryIdentityV1;
  /** The verified open PR restored as target.pr. */
  pullRequest: number;
  detail: string;
}

/**
 * Pure local gating. Returns the candidates whose remote facts must still be
 * verified; refusals the operator should see are reported through `onDenied`.
 */
export function planBaseRefreshReadmissions(
  snapshot: RepairStateSnapshotV1,
  runtimeSha: GitSha,
  closedIssues: ReadonlySet<string>,
  onDenied?: (denial: { id: string; reason: string }) => void,
): BaseRefreshCandidateV1[] {
  if (!isGitSha(runtimeSha)) return [];
  const legacyRuntime = BASE_REFRESH_LEGACY_RUNTIMES.has(runtimeSha);
  const candidates: BaseRefreshCandidateV1[] = [];
  for (const record of snapshot.work) {
    const blocker = record.blocker;
    if (
      record.nextStep !== "blocked" || blocker === null ||
      blocker.kind !== "other" ||
      !BASE_REFRESH_AUTH_BLOCKERS.has(blocker.message)
    ) continue;
    if (legacyRuntime) {
      onDenied?.({
        id: record.id,
        reason: "runtime_lacks_credential_deferral",
      });
      continue;
    }
    // Exactly the terminal shape the runtime wrote: no pending operation, no
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
    if (
      taskReservationCount(snapshot, record.id) >= HOSTED_AUTONOMY_MAX_RETRIES
    ) continue;
    const head = record.target.head;
    const candidateState = record.target.candidateState;
    const branch = candidateBranch(record.id);
    if (
      head === null || record.target.branch !== branch ||
      candidateState === undefined || candidateState.preserved === null ||
      candidateState.publishedHead !== head ||
      record.target.selfMerge !== undefined
    ) {
      onDenied?.({ id: record.id, reason: "unpublished_candidate" });
      continue;
    }
    candidates.push({
      id: record.id,
      repository: record.repository,
      branch,
      head,
    });
  }
  return candidates;
}

/**
 * Pure remote verification of one candidate against the exact-branch pull
 * listing, the branch tip and the repository's base branch.
 */
export function decideBaseRefreshReadmission(
  candidate: BaseRefreshCandidateV1,
  pulls: readonly HostedAutonomyHeadPullV1[] | null,
  branchTip: string | null,
  baseBranch: string | null,
): { kind: "readmit"; readmission: BaseRefreshReadmissionV1 } | {
  kind: "refused";
  reason: string;
} {
  if (pulls === null) return { kind: "refused", reason: "pr_read_failed" };
  if (baseBranch === null) {
    return { kind: "refused", reason: "base_branch_unknown" };
  }
  if (pulls.some((pull) => pull.headRef !== candidate.branch)) {
    return { kind: "refused", reason: "pr_listing_mismatch" };
  }
  // A merged publication is delivered (or a human merge): never re-admitted.
  if (pulls.some((pull) => pull.merged)) {
    return { kind: "refused", reason: "pr_merged" };
  }
  // The branch must still carry the exact published head the restored PR
  // identity is bound to.
  if (branchTip !== candidate.head) {
    return { kind: "refused", reason: "branch_moved" };
  }
  const open = pulls.filter((pull) => pull.state === "open");
  if (open.length === 0) return { kind: "refused", reason: "pr_not_open" };
  if (open.length > 1) return { kind: "refused", reason: "pr_ambiguous" };
  const pull = open[0];
  if (
    pull.author === null ||
    !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author) ||
    pull.headSha !== candidate.head || pull.baseRef !== baseBranch
  ) {
    return { kind: "refused", reason: "pr_foreign" };
  }
  return {
    kind: "readmit",
    readmission: {
      id: candidate.id,
      repository: candidate.repository,
      pullRequest: pull.number,
      detail: READMISSION_DETAIL,
    },
  };
}

/**
 * Read the remote facts for every candidate through its OWN repository scope
 * and keep only the verified re-admissions. Every refusal is reported as an
 * action; a throwing or missing reader is a refusal, never a guess.
 *
 * The branch tip is read first: a branch that provably no longer carries the
 * published head is a lasting refusal (`branch_moved`) decided without
 * reading the pull listing. Remembering a refusal across passes would need
 * new durable state, so each pass re-reads that one tip; `pr_foreign` needs
 * both reads every pass for the same reason.
 */
export async function verifyBaseRefreshReadmissions(
  candidates: readonly BaseRefreshCandidateV1[],
  scopeFor: (
    repository: RepositoryIdentityV1,
  ) => Promise<HostedAutonomyScopeV1>,
  actions: string[],
): Promise<BaseRefreshReadmissionV1[]> {
  const verified: BaseRefreshReadmissionV1[] = [];
  for (const candidate of candidates) {
    const scope = await scopeFor(candidate.repository);
    const surface = scope.surface;
    if (surface === null || surface.listPullsByHeadRef === undefined) {
      actions.push(`retry:${candidate.id}:skipped:pr_lookup_unavailable`);
      continue;
    }
    let branchTip: string | null;
    try {
      branchTip = await surface.readBaseTip(candidate.branch);
    } catch {
      branchTip = null;
    }
    if (branchTip !== null && branchTip !== candidate.head) {
      actions.push(`retry:${candidate.id}:skipped:branch_moved`);
      continue;
    }
    let pulls: readonly HostedAutonomyHeadPullV1[] | null;
    try {
      pulls = await surface.listPullsByHeadRef(candidate.branch);
    } catch {
      pulls = null;
    }
    const decision = decideBaseRefreshReadmission(
      candidate,
      pulls,
      branchTip,
      scope.baseBranch,
    );
    if (decision.kind === "refused") {
      actions.push(`retry:${candidate.id}:skipped:${decision.reason}`);
      continue;
    }
    verified.push(decision.readmission);
  }
  return verified;
}

/**
 * Apply verified re-admissions to a snapshot whose sequence/head the caller
 * already advanced (pure; strict-parsed). Only target.pr, the step and the
 * cleared blocker change; counters and every other field are kept, and
 * records without a re-admission are returned byte-identical.
 */
export function applyBaseRefreshReadmissions(
  snapshot: RepairStateSnapshotV1,
  readmissions: readonly BaseRefreshReadmissionV1[],
  now: number,
): RepairStateSnapshotV1 {
  if (readmissions.length === 0) return snapshot;
  return parseRepairStateSnapshotV1({
    ...snapshot,
    work: snapshot.work.map((record) => {
      const readmission = readmissions.find((entry) =>
        entry.id === record.id &&
        sameRepository(entry.repository, record.repository)
      );
      if (readmission === undefined) return record;
      return parseWorkRecordV1({
        ...record,
        target: { ...record.target, pr: readmission.pullRequest },
        nextStep: "work",
        wait: null,
        blocker: null,
        intent: null,
        updatedAt: now,
      });
    }),
  });
}
