/**
 * Launcher re-admission of the retired human-merge head park.
 *
 * The installed runtime completed a human merge only at the exact reviewed
 * head and parked every merged pull request whose head had moved on, as
 * "observed merged head identity mismatch" with `target.pr` cleared. Owner
 * rule 2026-10-30: a human merge is a completed delivery, so the runtime now
 * books that merge on the record's own base. This maintenance path returns
 * the records already parked by the old rule to `review`, where the runtime
 * re-reads the pull request and completes the delivery (or refuses a merge
 * that landed on another base) through its ordinary path.
 *
 * Nothing is charged and no counter, reservation or evidence moves here: the
 * record keeps its reviewed head, base and counters, only the verified open
 * pull identity on its own branch is restored, and the runtime then settles
 * the exact outstanding review admission itself. The rule is not part of the
 * prefix table of `HOSTED_AUTONOMY_RETRYABLE` because the parked record no
 * longer names its pull request and a merged pull can never pass that table's
 * open-pull verification.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../src/contracts/work-record.ts";
import { HUMAN_MERGE_HEAD_MISMATCH_BLOCKER } from "../src/repair/human-merge.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyScopeV1 } from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyHeadPullV1 } from "./hosted-autonomy-types.ts";

/** Action detail of every verified human-merge head re-admission. */
const READMISSION_DETAIL = "human_merge_head_moved";

/** A blocked record that passed every local gate; remote facts pending. */
export interface HumanMergeCandidateV1 {
  id: string;
  repository: RepositoryIdentityV1;
  /** The record's own pull branch; the PR is restored from its listing. */
  branch: string;
  /** The exact reviewed head the record keeps unchanged. */
  head: GitSha;
}

/** A verified re-admission, applied by `applyHumanMergeReadmissions`. */
export interface HumanMergeReadmissionV1 {
  id: string;
  repository: RepositoryIdentityV1;
  /** The verified merged PR restored as target.pr. */
  pullRequest: number;
  detail: string;
}

/**
 * Pure local gating: exactly the terminal shape the old runtime wrote (a
 * blocked record, no intent or wait, the exact message) with a saved branch
 * and reviewed head. Closed-issue and review-round gates deliberately do not
 * apply: the delivery already happened, so the record only needs its
 * bookkeeping completed.
 */
export function planHumanMergeHeadReadmissions(
  snapshot: RepairStateSnapshotV1,
): HumanMergeCandidateV1[] {
  const candidates: HumanMergeCandidateV1[] = [];
  for (const record of snapshot.work) {
    if (
      record.nextStep !== "blocked" || record.blocker === null ||
      record.blocker.kind !== "other" ||
      record.blocker.message !== HUMAN_MERGE_HEAD_MISMATCH_BLOCKER ||
      record.intent !== null || record.wait !== null ||
      record.target.head === null || record.target.branch === null
    ) continue;
    candidates.push({
      id: record.id,
      repository: record.repository,
      branch: record.target.branch,
      head: record.target.head,
    });
  }
  return candidates;
}

/**
 * Pure remote verification of one candidate against the exact-branch pull
 * listing. The pull must be the one merged publication of the record's own
 * branch: a readable listing whose every entry is on that branch, exactly one
 * pull, merged, by a trusted author and based on the scope's base branch. An
 * unreadable listing, an open pull (the standing review owns it) and a pull
 * on another base all refuse without a write.
 */
export function decideHumanMergeHeadReadmission(
  candidate: HumanMergeCandidateV1,
  pulls: readonly HostedAutonomyHeadPullV1[] | null,
  baseBranch: string | null,
): { kind: "readmit"; readmission: HumanMergeReadmissionV1 } | {
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
  if (pulls.length !== 1) {
    return {
      kind: "refused",
      reason: pulls.length === 0 ? "pr_not_found" : "pr_ambiguous",
    };
  }
  const pull = pulls[0];
  if (pull.merged !== true || pull.state !== "closed") {
    return { kind: "refused", reason: "pr_not_merged" };
  }
  if (pull.baseRef !== baseBranch) {
    return { kind: "refused", reason: "pr_base_mismatch" };
  }
  if (
    pull.author === null ||
    !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)
  ) return { kind: "refused", reason: "pr_foreign" };
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
 * Read the pull listing for every candidate through its OWN repository scope
 * and keep only the verified re-admissions. A throwing or missing reader is a
 * refusal, never a guess; every refusal is reported as an action.
 */
export async function verifyHumanMergeHeadReadmissions(
  candidates: readonly HumanMergeCandidateV1[],
  scopeFor: (
    repository: RepositoryIdentityV1,
  ) => Promise<HostedAutonomyScopeV1>,
  actions: string[],
): Promise<HumanMergeReadmissionV1[]> {
  const verified: HumanMergeReadmissionV1[] = [];
  for (const candidate of candidates) {
    const scope = await scopeFor(candidate.repository);
    const surface = scope.surface;
    if (surface === null || surface.listPullsByHeadRef === undefined) {
      actions.push(`retry:${candidate.id}:skipped:pr_lookup_unavailable`);
      continue;
    }
    let pulls: readonly HostedAutonomyHeadPullV1[] | null;
    try {
      pulls = await surface.listPullsByHeadRef(candidate.branch);
    } catch {
      pulls = null;
    }
    const decision = decideHumanMergeHeadReadmission(
      candidate,
      pulls,
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
 * Apply verified re-admissions (pure; strict-parsed). Only the restored pull,
 * the step and the cleared blocker change; the reviewed head, base, counters,
 * reservations and evidence are kept, and records without a re-admission are
 * returned byte-identical.
 */
export function applyHumanMergeReadmissions(
  snapshot: RepairStateSnapshotV1,
  readmissions: readonly HumanMergeReadmissionV1[],
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
        nextStep: "review",
        wait: null,
        blocker: null,
        updatedAt: now,
      });
    }),
  });
}
