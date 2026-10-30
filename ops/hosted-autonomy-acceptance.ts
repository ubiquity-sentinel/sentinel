/**
 * Launcher half of JAM B6, "task acceptance not fulfilled: the candidate does
 * not satisfy the source issue" (the runtime half is
 * `src/repair/acceptance-correction.ts`). Every rule is a pure predicate over
 * the authenticated state; nothing here charges, refunds, merges or reads a
 * review.
 *
 * - B6a re-admission (retry pass): a record the rollback-target runtime R80
 *   blocked with EXACTLY that refusal while an ordinary review round is left
 *   (`!ordinaryReviewRoundsSpent`) returns to `review` with only its blocker
 *   cleared (counters, charges, intent, PR, head and candidate unchanged), on
 *   its still-open issue and still-open pull request, and only under a proven
 *   acceptance-correction runtime (`acceptanceCorrectionRuntimeProven`). The
 *   runtime then re-observes the standing completed review of that exact head
 *   (no new review, nothing charged) and turns the verdict into the correction
 *   a P0/P1 gets. Under any other runtime the record is named in a
 *   `retry:<id>:denied:acceptance_correction_requires_runtime` line instead:
 *   R80 would re-observe the same verdict and block it again on every pass.
 * - B6b owner gate (delivery pass): the runtime's owner-gated park
 *   (`TASK_ACCEPTANCE_OWNER_GATE_DETAIL`) and the R80-written refusal once its
 *   ordinary rounds are spent, on a source issue not read closed, can neither
 *   merge nor correct. The delivery pass skips them without a read (replacing
 *   the per-pass `delivery:<id>:spent_not_admissible` line) and the run
 *   summary names them once per pass:
 *   `owner_gate:task_acceptance_not_fulfilled:n=<count>:<ids>`. No retry rule
 *   matches either shape.
 *
 * The two sets are disjoint by the ordinary round count, and the runtime's
 * review step never writes the refusal it re-admits again (it corrects, or
 * parks on the owner-gated message), so a record can never cycle between
 * them.
 */
import type { HostedRuntimeRecordV1 } from "../src/contracts/hosted-supervisor.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { HOSTED_RUNTIME_ROLLOUT } from "../src/host/hosted-runtime-rollout.ts";
import { TASK_ACCEPTANCE_OWNER_GATE_DETAIL } from "../src/repair/acceptance-correction.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";
import {
  TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
  TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
} from "../src/repair/review-gate.ts";
import {
  isPassportWorkTrial,
  passportTrialCanReconsider,
} from "../src/repair/passport-work-trial.ts";
import { ordinaryReviewRoundsSpent } from "../src/repair/review-round-cap.ts";
import { ciCorrectionRuntimeProven } from "./hosted-autonomy-ci-retries.ts";
import { hostedIssueKey } from "./hosted-autonomy-policy.ts";
import type { RetryDenialV1, RetryPlanV1 } from "./hosted-autonomy-retries.ts";

type WorkRow = RepairStateSnapshotV1["work"][number];

/** First runtime generation that corrects a not-fulfilled acceptance. */
export const HOSTED_AUTONOMY_ACCEPTANCE_CORRECTION_MIN_GENERATION = 81;

/**
 * Exact reviewed runtime revisions that correct a not-fulfilled acceptance
 * (`src/repair/acceptance-correction.ts` in that revision's tree), each named
 * by the launcher commit that pins its install. R81 is the first supported
 * runtime: under R80 the re-admission would only be blocked again.
 */
export const HOSTED_AUTONOMY_ACCEPTANCE_CORRECTION_RUNTIMES: ReadonlySet<
  string
> = new Set<string>([
  ...HOSTED_RUNTIME_ROLLOUT.acceptanceCorrection,
  "da98f5f49c45b57cfa97a45fe647c36b1021f302",
]);

/** Denial of the B6a re-admission under a runtime that cannot correct it. */
export const ACCEPTANCE_CORRECTION_REQUIRES_RUNTIME =
  "acceptance_correction_requires_runtime";

/** Detail of an applied B6a re-admission (`retry:<id>:grant=0:<detail>`). */
export const ACCEPTANCE_READMISSION_DETAIL =
  "other:task acceptance not fulfilled:review";

/** Owner-gated records named per summary line (the rest are counted). */
export const ACCEPTANCE_OWNER_GATE_REPORTS_PER_PASS = 12;

/**
 * True only for an allowlisted acceptance-correction runtime at generation
 * 81+ whose own settled healthy proof binds this exact revision and
 * generation (the CI-correction proof rule over this allowlist).
 */
export function acceptanceCorrectionRuntimeProven(
  runtime: HostedRuntimeRecordV1 | null | undefined,
  allowlist: ReadonlySet<string> =
    HOSTED_AUTONOMY_ACCEPTANCE_CORRECTION_RUNTIMES,
): boolean {
  return runtime !== null && runtime !== undefined &&
    Number.isSafeInteger(runtime.generation) &&
    runtime.generation >=
      HOSTED_AUTONOMY_ACCEPTANCE_CORRECTION_MIN_GENERATION &&
    ciCorrectionRuntimeProven(runtime, allowlist);
}

/** The executing clean source proves modern correction only for its own install. */
export function acceptanceCorrectionSelfInstalledRuntimeProven(
  runtime: HostedRuntimeRecordV1 | null | undefined,
  sourceRevision: GitSha | undefined,
): boolean {
  return sourceRevision !== undefined && runtime !== null &&
    runtime !== undefined && runtime.activeRevision === sourceRevision &&
    Number.isSafeInteger(runtime.generation) && runtime.generation >= 82 &&
    acceptanceCorrectionRuntimeProven(runtime, new Set([sourceRevision])) &&
    runtime.lastHealthyProof?.execution.launcherSha === sourceRevision;
}

/** An issue task blocked with no operation in flight on `message`, exactly. */
function blockedOn(record: WorkRow, message: string): boolean {
  const issue = record.related.issueNumber;
  return record.nextStep === "blocked" && record.intent === null &&
    record.blocker !== null && record.blocker.kind === "other" &&
    record.blocker.message === message && record.source.kind === "issue" &&
    issue !== null && record.source.id === String(issue);
}

/**
 * B6b: a not-fulfilled acceptance no correction can follow, on a source issue
 * not known closed. The runtime's owner-gated park, or the R80-written
 * refusal once its ordinary review rounds are spent. A record whose issue the
 * owner already closed (live 112 and 596: their pull requests merged by hand)
 * awaits no decision and keeps its existing handling.
 */
export function acceptanceOwnerGated(
  record: WorkRow,
  snapshot: Pick<RepairStateSnapshotV1, "reservations">,
  /** `hostedIssueKey` values of the source issues this pass read closed. */
  closedIssues: ReadonlySet<string> = new Set(),
): boolean {
  return (blockedOn(record, TASK_ACCEPTANCE_OWNER_GATE_DETAIL) ||
    (blockedOn(record, TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL) &&
      ordinaryReviewRoundsSpent(snapshot, record))) &&
    !closedIssues.has(
      hostedIssueKey(record.repository, record.related.issueNumber!),
    );
}

/** The record's exact published, described and unreleased head. */
function exactPublication(
  snapshot: Pick<RepairStateSnapshotV1, "releaseRequests">,
  record: WorkRow,
): boolean {
  const { head, pr, branch, base, candidateState } = record.target;
  return head !== null && pr !== null && branch !== null && head !== base &&
    (candidateState === undefined ||
      (candidateState.preserved !== null &&
        candidateState.preserved.head === head &&
        candidateState.publishedHead === head)) &&
    !snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, record)
    );
}

/**
 * B6a: the closed re-admission plans (`nextStep: "review"`, counters kept)
 * for the R80-written refusal with an ordinary review round left. Applied by
 * `applyHostedRetries` after the retry pass verified each pull request open.
 */
export function planAcceptanceReadmissions(
  snapshot: RepairStateSnapshotV1,
  closedIssues: ReadonlySet<string>,
  /** `acceptanceCorrectionRuntimeProven` of the installed runtime. */
  runtimeProven: boolean,
  onDenied?: (denial: RetryDenialV1) => void,
  /** Same-source self-install proof, required for every Passport trial class. */
  modernRuntimeProven = false,
): RetryPlanV1[] {
  const plans: RetryPlanV1[] = [];
  for (const record of snapshot.work) {
    const trial = isPassportWorkTrial(record.repository);
    if (
      !(blockedOn(record, TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL) ||
        (trial &&
          [TASK_ACCEPTANCE_OWNER_GATE_DETAIL, TASK_ACCEPTANCE_UNCERTAIN_DETAIL]
            .some((message) => blockedOn(record, message)))) ||
      (trial && !passportTrialCanReconsider(record, snapshot.reservations)) ||
      record.counters.reviewRounds < 1 ||
      closedIssues.has(
        hostedIssueKey(record.repository, record.related.issueNumber!),
      ) ||
      ordinaryReviewRoundsSpent(snapshot, record) ||
      !exactPublication(snapshot, record)
    ) continue;
    if (!(modernRuntimeProven || (!trial && runtimeProven))) {
      onDenied?.({
        id: record.id,
        repository: record.repository,
        reason: ACCEPTANCE_CORRECTION_REQUIRES_RUNTIME,
      });
      continue;
    }
    plans.push({
      id: record.id,
      repository: record.repository,
      grant: 0,
      nextStep: "review",
      reviewRounds: null,
      advanceBase: false,
      observedBase: null,
      detail: ACCEPTANCE_READMISSION_DETAIL,
    });
  }
  return plans;
}

/**
 * The run summary's one owner-gate line for this snapshot (none when no
 * record is owner-gated): the count, then at most
 * `ACCEPTANCE_OWNER_GATE_REPORTS_PER_PASS` record ids in id order and the
 * number not named.
 */
export function acceptanceOwnerGateActions(
  snapshot: RepairStateSnapshotV1,
  closedIssues: ReadonlySet<string> = new Set(),
): string[] {
  const ids = snapshot.work.filter((record) =>
    acceptanceOwnerGated(record, snapshot, closedIssues)
  ).map((record) => record.id).sort();
  if (ids.length === 0) return [];
  const named = ids.slice(0, ACCEPTANCE_OWNER_GATE_REPORTS_PER_PASS);
  const more = ids.length - named.length;
  return [
    `owner_gate:task_acceptance_not_fulfilled:n=${ids.length}:${
      named.join(",")
    }${more > 0 ? `,+${more}` : ""}`,
  ];
}
