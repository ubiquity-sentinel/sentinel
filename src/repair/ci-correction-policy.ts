/**
 * Repair loop internals: trusted CI labels, correction findings and the
 * publication shapes a CI fix may correct.
 *
 * This is the presentation/policy half split from `ci-rejection.ts` (the
 * attribution half) to keep both source files under the repository's target
 * size. Nothing here is persisted and no function charges anything.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { LegacyCutoff } from "./review-round-cap.ts";
import {
  CI_FIX_EXHAUSTED_PREFIX,
  CI_PRE_REVIEW_PENDING_PREFIX,
  CI_PRE_REVIEW_RED_PREFIX,
  ciFixesLeft,
  reviewRoundAvailable,
} from "./ci-first-policy.ts";

/** Bound on the failing checks one correction finding names. */
export const MAX_CI_CORRECTION_CHECKS = 8;

/**
 * Trusted check-name shape: a short job/status identifier. Anything outside
 * this closed set (control characters, prose, markup) is never carried.
 */
export const CI_CHECK_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 ._:/()[\],+#@-]{0,63}$/;

/** Fixed stand-in for a failing check whose name is not a trusted identifier. */
export const UNTRUSTED_CHECK_NAME = "check with an unsupported name";

/** Static terminal prefix when no base observation attributes a failure. */
export const CI_UNATTRIBUTED_DETAIL = "CI checks failed without base evidence";

/**
 * Static terminal prefix of a legacy final-round head on a moved base that is
 * red only because its reviewed base is red too (issue #155). Base evidence
 * exists, so it is not the unattributed block, and it matches no launcher
 * correction, re-run or green rule.
 */
export const CI_BASE_RED_DETAIL = "CI checks failed on the red reviewed base";

/** Exact opening of the trusted CI correction finding (planner-produced). */
export const CI_CORRECTION_FINDING_PREFIX =
  "Required CI checks failed on this candidate while the same checks passed on its base ";

/**
 * Exact opening of the trusted CI fix finding of a base-repair task
 * (`src/repair/base-repair.ts`): its head fails checks that are red on its
 * base too, the red it was filed to fix, so the finding never claims they
 * passed there. `isCiCorrectionFinding` recognises both openings; a hosted
 * run uses it only once `HOSTED_BASE_REPAIR_FINDING` is set.
 */
export const CI_BASE_REPAIR_FINDING_PREFIX =
  "Required CI checks failed on this candidate and on its red base ";

/** The carried identity of one observed check name. */
export function trustedCheckName(name: string): string {
  return CI_CHECK_NAME_PATTERN.test(name) ? name : UNTRUSTED_CHECK_NAME;
}

/** Deduped, bounded `name(conclusion)` labels over trusted names only. */
export function ciLabels(
  checks: readonly GitHubCheckV1[],
  format: (name: string, conclusion: string) => string,
): string {
  const seen = new Set<string>();
  for (const check of checks) {
    seen.add(
      format(trustedCheckName(check.name), check.conclusion ?? "unknown"),
    );
    if (seen.size >= MAX_CI_CORRECTION_CHECKS) break;
  }
  return [...seen].join(", ");
}

/**
 * Bounded `name(conclusion)` labels of completed checks, `name(status)`
 * labels of running ones and `name(not_started)` labels of runs whose job
 * never started, over trusted names only; a head with no check runs at all
 * reads `no checks reported`.
 */
export function ciCheckLabels(checks: readonly GitHubCheckV1[]): string {
  if (checks.length === 0) return "no checks reported";
  const seen = new Set<string>();
  for (const check of checks) {
    const state = check.neverStarted === true
      ? "not_started"
      : check.status === "completed"
      ? check.conclusion ?? "unknown"
      : check.status;
    seen.add(`${trustedCheckName(check.name)}(${state})`);
    if (seen.size >= MAX_CI_CORRECTION_CHECKS) break;
  }
  return [...seen].join(", ");
}

/** Label of a base whose check runs could not be read for coverage. */
export const BASE_CHECKS_UNREADABLE = "base checks unreadable";

/**
 * Bounded `name(absent)` labels of expected checks the head does not report
 * yet (`missingExpectedChecks`), over trusted names only; null (the base's
 * runs could not be read) is `BASE_CHECKS_UNREADABLE`.
 */
export function absentCheckLabels(names: readonly string[] | null): string {
  if (names === null) return BASE_CHECKS_UNREADABLE;
  if (names.length === 0) return "no checks reported";
  const seen = new Set<string>();
  for (const name of names) {
    seen.add(`${trustedCheckName(name)}(absent)`);
    if (seen.size >= MAX_CI_CORRECTION_CHECKS) break;
  }
  return [...seen].join(", ");
}

/** Terminal blocker detail of a failure its red reviewed base shares. */
export function baseRedDetail(checks: readonly GitHubCheckV1[]): string {
  return `${CI_BASE_RED_DETAIL}: ${
    ciLabels(checks, (name, conclusion) => `${name}(${conclusion})`)
  }`;
}

/**
 * The unresolved P1-equivalent finding a correction must resolve. It names
 * only trusted failing check names and the base: green, or red under a
 * base-repair task's own opening (`redBase`).
 */
export function ciCorrectionFinding(
  base: GitSha,
  checks: readonly GitHubCheckV1[],
  /** A base-repair task's own red base (`CI_BASE_REPAIR_FINDING_PREFIX`). */
  redBase = false,
): { severity: string; path: string | null; message: string } {
  const prefix = redBase
    ? CI_BASE_REPAIR_FINDING_PREFIX
    : CI_CORRECTION_FINDING_PREFIX;
  return {
    severity: "P1",
    path: null,
    message:
      `${prefix}${base.slice(0, 12)}: ${
        ciLabels(checks, (name, conclusion) => `${name} (${conclusion})`)
      }. Reproduce them with the repository's own test and check commands and ` +
      `fix the candidate so they pass.`,
  };
}

/** True for the trusted planner's CI correction finding (either opening). */
export function isCiCorrectionFinding(
  finding: { severity: string; path: string | null; message: string },
): boolean {
  return finding.severity === "P1" && finding.path === null &&
    (finding.message.startsWith(CI_CORRECTION_FINDING_PREFIX) ||
      finding.message.startsWith(CI_BASE_REPAIR_FINDING_PREFIX));
}

/**
 * The record shape a candidate-caused CI failure may correct: an issue task
 * holding its exact publication, on a durably described candidate, with a CI
 * fix and a review round left.
 */
export function ciCorrectionShape(
  record: WorkRecordV1,
  ledger: { readonly reservations: readonly BudgetReservationV1[] },
  /** The legacy cutoff this run evaluates under (`review-round-cap.ts`). */
  cutoff?: LegacyCutoff,
): boolean {
  return ciPublicationShape(record) && ciFixesLeft(record) &&
    reviewRoundAvailable(ledger, record, cutoff);
}

/**
 * The publication half of `ciCorrectionShape`: an issue task holding its
 * exact publication on a durably described candidate, whatever its CI fix
 * and review-round counters say.
 */
export function ciPublicationShape(record: WorkRecordV1): boolean {
  const candidateState = record.target.candidateState;
  return record.source.kind === "issue" &&
    record.target.head !== null && record.target.pr !== null &&
    record.target.branch !== null &&
    record.target.head !== record.target.base &&
    (candidateState === undefined || candidateState.preserved !== null);
}

/** Terminal detail of a red head whose three CI fixes are spent. */
export function ciFixExhaustedDetail(
  checks: readonly GitHubCheckV1[],
): string {
  return `${CI_FIX_EXHAUSTED_PREFIX}${ciCheckLabels(checks)}`;
}

/** Park detail of a red, never-reviewed head no fix may start for yet. */
export function preReviewRedDetail(checks: readonly GitHubCheckV1[]): string {
  return `${CI_PRE_REVIEW_RED_PREFIX}${ciCheckLabels(checks)}`;
}

/** Park detail of a head whose CI did not finish within the bound. */
export function preReviewPendingDetail(
  checks: readonly GitHubCheckV1[],
): string {
  return `${CI_PRE_REVIEW_PENDING_PREFIX}${ciCheckLabels(checks)}`;
}

/**
 * Park detail of a head that still lacks an expected check after the bound:
 * the same pending park (same prefix, same launcher re-admission), naming
 * the checks GitHub has not created on the head, or a base whose runs could
 * not be read.
 */
export function preReviewAbsentDetail(
  names: readonly string[] | null,
): string {
  return `${CI_PRE_REVIEW_PENDING_PREFIX}${absentCheckLabels(names)}`;
}

/** The delivery gate may open a correction: the shape and no live operation. */
export function ciCorrectable(
  record: WorkRecordV1,
  ledger: { readonly reservations: readonly BudgetReservationV1[] },
  cutoff?: LegacyCutoff,
): boolean {
  return record.intent === null && ciCorrectionShape(record, ledger, cutoff);
}
