/**
 * Launcher re-admission of the retired human-merge parks.
 *
 * The installed runtime completed a human merge only at the exact reviewed
 * head and parked every merged pull request whose head had moved on, as
 * "observed merged head identity mismatch" with `target.pr` cleared. It also
 * parked a human merge whose base branch had moved on after the review, as
 * "the merge landed off its reviewed base: ...", keeping `target.pr`. Owner
 * rule 2026-10-30: a human merge is a completed delivery, so the runtime now
 * books that merge on the record's own base branch. This maintenance path
 * returns the records already parked by both rules to `review`, where the
 * runtime re-reads the pull request and completes the delivery (or refuses a
 * merge that landed on another branch) through its ordinary path. A park the
 * runtime's own trusted merge wrote with the same off-base message is not a
 * human merge and stays refused: its merged pull must not name the Sentinel
 * application as the merger.
 *
 * The first re-admission write exposed a third shape: the completion step's
 * queue-custody guard wrote a permanent `backoff` wait (`until: null`) on a
 * record already at `review`, so selection treated the merged pull as waiting
 * forever. That guard no longer runs for a human merge, but the records
 * already carrying the shape are corrected here: a `review` record with a
 * permanent backoff, a retained pull and no intent is re-admitted only when
 * that exact pull is merged into the base branch by a readable non-Sentinel
 * actor, so a genuine queue-custody hold is never released.
 *
 * Nothing is charged and no counter, reservation or evidence moves here: the
 * record keeps its reviewed head, base and counters, only the verified pull
 * identity on its own branch is restored (and the stuck wait cleared), and the
 * runtime then settles the exact outstanding review admission itself. The rule
 * is not part of the prefix table of `HOSTED_AUTONOMY_RETRYABLE` because the
 * parked record no longer names its pull request and a merged pull can never
 * pass that table's open-pull verification.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../src/contracts/work-record.ts";
import { HUMAN_MERGE_HEAD_MISMATCH_BLOCKER } from "../src/repair/human-merge.ts";
import { MERGED_OFF_TIP_PREFIX } from "../src/repair/merge-off-tip.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyScopeV1 } from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyHeadPullV1 } from "./hosted-autonomy-types.ts";

/** The parks this rule re-admits, by the exact shape they wrote. */
export type HumanMergeParkV1 =
  | "head_mismatch"
  | "merge_off_base"
  | "review_backoff";

/** Action detail of every verified human-merge head re-admission. */
const READMISSION_DETAIL = "human_merge_head_moved";
/** Action detail of a re-admission from the moved-base park. */
const MERGED_OFF_TIP_READMISSION_DETAIL = "human_merge_merged_off_base";
/** Action detail of a re-admission from the stuck review backoff. */
const REVIEW_BACKOFF_READMISSION_DETAIL = "human_merge_review_backoff";

/** A record that passed every local gate; remote facts pending. */
export interface HumanMergeCandidateV1 {
  id: string;
  repository: RepositoryIdentityV1;
  /** The record's own pull branch; the PR is restored from its listing. */
  branch: string;
  /** The exact reviewed head the record keeps unchanged. */
  head: GitSha;
  /** The retained pull identity; null for the head-mismatch park. */
  pullRequest: number | null;
  /** Which shape wrote the record; the merge-actor gate depends on it. */
  parkedBy: HumanMergeParkV1;
}

/** A verified re-admission, applied by `applyHumanMergeReadmissions`. */
export interface HumanMergeReadmissionV1 {
  id: string;
  repository: RepositoryIdentityV1;
  /** The verified merged PR restored as target.pr. */
  pullRequest: number;
  detail: string;
}

/** The park a blocked record names, or null for any other blocker. */
function parkOf(message: string): HumanMergeParkV1 | null {
  if (message === HUMAN_MERGE_HEAD_MISMATCH_BLOCKER) return "head_mismatch";
  if (message.startsWith(MERGED_OFF_TIP_PREFIX)) return "merge_off_base";
  return null;
}

/**
 * Pure local gating: the exact shapes the runtime wrote — a blocked record
 * with no intent or wait and one exact message, or the stuck `review` record
 * whose completion was held by a permanent backoff — each with a saved branch
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
      record.intent !== null || record.target.head === null ||
      record.target.branch === null
    ) continue;
    let parkedBy: HumanMergeParkV1 | null = null;
    if (record.nextStep === "blocked" && record.wait === null) {
      if (record.blocker !== null && record.blocker.kind === "other") {
        parkedBy = parkOf(record.blocker.message);
      }
    } else if (
      // The first re-admission left the completion step's permanent custody
      // hold on a record that is already at `review` with its merged pull.
      record.nextStep === "review" && record.blocker === null &&
      record.target.pr !== null && record.wait?.reason === "backoff" &&
      record.wait.until === null
    ) parkedBy = "review_backoff";
    if (parkedBy === null) continue;
    candidates.push({
      id: record.id,
      repository: record.repository,
      branch: record.target.branch,
      head: record.target.head,
      pullRequest: record.target.pr,
      parkedBy,
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
 * on another base all refuse without a write. A record parked by the off-base
 * message is only re-admitted when the same pull read names its merger and
 * that merger is not the Sentinel application: a park the runtime's own
 * trusted merge wrote keeps its exact-tip refusal. The stuck review backoff
 * uses the same merger gate, so a real queue-custody hold is never released.
 */
export function decideHumanMergeHeadReadmission(
  candidate: HumanMergeCandidateV1,
  pulls: readonly HostedAutonomyHeadPullV1[] | null,
  baseBranch: string | null,
  /** The pull's observed merger; undefined when no detail read was made. */
  mergedBy?: string | null,
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
  if (candidate.pullRequest !== null && pull.number !== candidate.pullRequest) {
    return { kind: "refused", reason: "pr_identity_mismatch" };
  }
  if (
    pull.author === null ||
    !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)
  ) return { kind: "refused", reason: "pr_foreign" };
  if (candidate.parkedBy !== "head_mismatch") {
    if (mergedBy === null || mergedBy === undefined || mergedBy.length === 0) {
      return { kind: "refused", reason: "merge_actor_unreadable" };
    }
    if (mergedBy === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR) {
      return { kind: "refused", reason: "merge_by_sentinel" };
    }
  }
  return {
    kind: "readmit",
    readmission: {
      id: candidate.id,
      repository: candidate.repository,
      pullRequest: pull.number,
      detail: candidate.parkedBy === "merge_off_base"
        ? MERGED_OFF_TIP_READMISSION_DETAIL
        : candidate.parkedBy === "review_backoff"
        ? REVIEW_BACKOFF_READMISSION_DETAIL
        : READMISSION_DETAIL,
    },
  };
}

/**
 * The only remote fact that separates a human merge from the runtime's own
 * trusted merge on the same branch: the pull detail's merger. Any failed,
 * foreign or unreadable detail read is null, and a null merger refuses.
 */
async function readMergedBy(
  surface: NonNullable<HostedAutonomyScopeV1["surface"]>,
  number: number,
  baseBranch: string | null,
): Promise<string | null> {
  try {
    const pull = await surface.readPull(number, baseBranch);
    if (pull === null || pull.number !== number || pull.merged !== true) {
      return null;
    }
    return typeof pull.mergedBy === "string" && pull.mergedBy.length > 0
      ? pull.mergedBy
      : null;
  } catch {
    return null;
  }
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
    const mergedBy = candidate.parkedBy !== "head_mismatch" &&
        pulls !== null && pulls.length === 1
      ? await readMergedBy(surface, pulls[0].number, scope.baseBranch)
      : undefined;
    const decision = decideHumanMergeHeadReadmission(
      candidate,
      pulls,
      scope.baseBranch,
      mergedBy,
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
