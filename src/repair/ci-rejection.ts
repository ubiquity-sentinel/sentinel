/**
 * Repair loop internals: pure CI attribution for a reviewed candidate head.
 *
 * A failed check on the candidate is attributed by the SAME-named check on the
 * base the head was reviewed against. Only a real failure on the head (failure
 * or timed_out) can be the candidate's: passed on the base means the candidate
 * broke it (a correction can fix it); failure, timed_out or action_required on
 * the base means the base itself is red (no correction can fix it, so no round
 * is spent); still running on the base means the attribution must wait; and a
 * base that never ran the check, or ended it skipped/neutral/cancelled/stale,
 * proves nothing. Skipped/cancelled/neutral head conclusions are secondary:
 * they never open a charged round and never block a deferral on their own.
 *
 * Nothing here is persisted. The generation-76 rollback contract forbids any
 * new state shape, so every consumer re-derives the attribution from live
 * check runs and carries it only in memory (and in the trusted planner's own
 * digest-bound correction request).
 */
import type { GitSha } from "../contracts/brands.ts";
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

/**
 * Review rounds after which a candidate CI failure keeps its terminal block.
 * Mirrors the hosted review-round ceiling: once every round is spent a
 * correction can never become a reviewed verdict. The launcher's CI
 * re-admission reads this same value (through `ciCorrectable`), and a test
 * pins it equal to `HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS`.
 */
export const CI_CORRECTION_REVIEW_ROUNDS = 3;

/**
 * Whether a HOSTED run may open a CI correction. A hosted correction runs as a
 * matrix cell, and a cell planned in one run may be consumed only by a later
 * run, which after a failed generation's rollback runs the rollback target's
 * code. Generation 76 (41bb853a1) refused a CI correction of a head reviewed
 * clean as a generic provenance refusal that failed every later repair run,
 * so generation 77 kept this route closed. Generation 77 (R77 ab3613e02), the
 * rollback target of generation 78, carries this tree's consumer
 * (`matrix-artifact-wave.ts`): it accepts the planned cell (a head reviewed
 * clean against the record's exact base, the planner's CI finding first) and
 * isolates it as an authenticated runtime mismatch, which blocks the record
 * with its charge retained and never refunded
 * (tests/host/matrix-ci-correction-gen77_test.ts). Every other state the open
 * route writes is inert under R77 except a reviewed head returned to `work`
 * to await its correction: R77's closed route re-publishes that same head and
 * requests one more review, a bounded charged cost of one review round per
 * such record, never a model start, a refund or a merge without review
 * (tests/repair/ci-correction-rollback-gen77_test.ts). In-process runs never
 * plan a cell.
 */
export const HOSTED_CI_CORRECTIONS = true;

/**
 * The CI correction route is open for this run: always in process, and in a
 * hosted (matrix) run only once `HOSTED_CI_CORRECTIONS` is set.
 */
export function ciCorrectionRouteOpen(
  deps: { externalImplementations?: boolean },
): boolean {
  return deps.externalImplementations !== true || HOSTED_CI_CORRECTIONS;
}

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

/** Exact opening of the trusted CI correction finding (planner-produced). */
export const CI_CORRECTION_FINDING_PREFIX =
  "Required CI checks failed on this candidate while the same checks passed on its base ";

/** Head conclusions that can be the candidate's own failure. */
const CANDIDATE_CONCLUSIONS: readonly string[] = ["failure", "timed_out"];
/** Base conclusions that make the reviewed base itself red. */
const RED_BASE_CONCLUSIONS: readonly string[] = [
  "failure",
  "timed_out",
  "action_required",
];

/** The carried identity of one observed check name. */
export function trustedCheckName(name: string): string {
  return CI_CHECK_NAME_PATTERN.test(name) ? name : UNTRUSTED_CHECK_NAME;
}

/**
 * Latest observation per check name. GitHub returns historical observations;
 * recency is by start time, so a newer in-progress rerun overrides an older
 * completed run (exactly the merge gate's dedupe).
 */
export function latestChecks(
  checks: readonly GitHubCheckV1[],
): GitHubCheckV1[] {
  const latest = new Map<string, GitHubCheckV1>();
  const time = (check: GitHubCheckV1) =>
    check.startedAt ?? check.completedAt ?? -1;
  for (const check of checks) {
    const prev = latest.get(check.name);
    if (prev === undefined || time(check) > time(prev)) {
      latest.set(check.name, check);
    }
  }
  return [...latest.values()];
}

/** Deduped checks that completed with anything but `success`. */
export function failedChecks(
  checks: readonly GitHubCheckV1[],
): GitHubCheckV1[] {
  return latestChecks(checks).filter((check) =>
    check.status === "completed" && check.conclusion !== "success"
  );
}

/** Failed head checks partitioned by the base observation of the same name. */
export interface CiAttributionV1 {
  /** Head failure/timed_out, passed on the base: broken by the candidate. */
  candidate: GitHubCheckV1[];
  /** Head failure/timed_out, failure/timed_out/action_required on the base. */
  baseRed: GitHubCheckV1[];
  /** Head failure/timed_out, still running on the base. */
  basePending: GitHubCheckV1[];
  /** Head failure/timed_out with no usable base evidence. */
  unattributed: GitHubCheckV1[];
  /** Head skipped/cancelled/neutral/action_required: never attributed. */
  secondary: GitHubCheckV1[];
}

export function attributeFailedChecks(
  failed: readonly GitHubCheckV1[],
  baseChecks: readonly GitHubCheckV1[],
): CiAttributionV1 {
  const base = new Map(
    latestChecks(baseChecks).map((check) => [check.name, check]),
  );
  const attribution: CiAttributionV1 = {
    candidate: [],
    baseRed: [],
    basePending: [],
    unattributed: [],
    secondary: [],
  };
  for (const check of failed) {
    if (!CANDIDATE_CONCLUSIONS.includes(check.conclusion ?? "")) {
      attribution.secondary.push(check);
      continue;
    }
    const observed = base.get(check.name);
    if (observed === undefined) attribution.unattributed.push(check);
    else if (observed.status !== "completed") {
      attribution.basePending.push(check);
    } else if (observed.conclusion === "success") {
      attribution.candidate.push(check);
    } else if (RED_BASE_CONCLUSIONS.includes(observed.conclusion ?? "")) {
      attribution.baseRed.push(check);
    } else attribution.unattributed.push(check);
  }
  return attribution;
}

/** What the failed head checks prove, in precedence order. */
export type CiDispositionV1 =
  | { kind: "candidate"; checks: GitHubCheckV1[] }
  | { kind: "base_pending" }
  | { kind: "base_red" }
  | { kind: "unattributed"; checks: GitHubCheckV1[] };

/**
 * A candidate-caused failure decides first (the correction re-runs every
 * check); a running base check is awaited; a red base defers only when every
 * real head failure is red there too; anything else proves nothing. Secondary
 * conclusions alone are unattributed.
 */
export function decideCiDisposition(
  attribution: CiAttributionV1,
): CiDispositionV1 {
  if (attribution.candidate.length > 0) {
    return { kind: "candidate", checks: attribution.candidate };
  }
  if (attribution.basePending.length > 0) return { kind: "base_pending" };
  if (attribution.baseRed.length > 0 && attribution.unattributed.length === 0) {
    return { kind: "base_red" };
  }
  return {
    kind: "unattributed",
    checks: attribution.unattributed.length > 0
      ? attribution.unattributed
      : attribution.secondary,
  };
}

/** Deduped, bounded `name(conclusion)` labels over trusted names only. */
function labels(
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

/** Terminal blocker detail of a failure no base observation attributes. */
export function unattributedDetail(checks: readonly GitHubCheckV1[]): string {
  return `${CI_UNATTRIBUTED_DETAIL}: ${
    labels(checks, (name, conclusion) => `${name}(${conclusion})`)
  }`;
}

/**
 * The unresolved P1-equivalent finding a correction must resolve. It names
 * only trusted failing check names and the green base; no CI log text exists.
 */
export function ciCorrectionFinding(
  base: GitSha,
  checks: readonly GitHubCheckV1[],
): { severity: string; path: string | null; message: string } {
  return {
    severity: "P1",
    path: null,
    message:
      `${CI_CORRECTION_FINDING_PREFIX}${base.slice(0, 12)}: ${
        labels(checks, (name, conclusion) => `${name} (${conclusion})`)
      }. Reproduce them with the repository's own test and check commands and ` +
      `fix the candidate so they pass; no CI log text is available.`,
  };
}

/** True for the trusted planner's CI correction finding. */
export function isCiCorrectionFinding(
  finding: { severity: string; path: string | null; message: string },
): boolean {
  return finding.severity === "P1" && finding.path === null &&
    finding.message.startsWith(CI_CORRECTION_FINDING_PREFIX);
}

/**
 * The record shape a candidate-caused CI failure may correct: an issue task
 * holding its exact publication with a review round left, on a durably
 * described candidate (a candidate state without its preserved descriptor can
 * never resume a correction, exactly as the launcher excludes it).
 */
export function ciCorrectionShape(record: WorkRecordV1): boolean {
  const candidateState = record.target.candidateState;
  return record.source.kind === "issue" &&
    record.target.head !== null && record.target.pr !== null &&
    record.target.branch !== null &&
    record.target.head !== record.target.base &&
    (candidateState === undefined || candidateState.preserved !== null) &&
    record.counters.reviewRounds < CI_CORRECTION_REVIEW_ROUNDS;
}

/** The delivery gate may open a correction: the shape and no live operation. */
export function ciCorrectable(record: WorkRecordV1): boolean {
  return record.intent === null && ciCorrectionShape(record);
}
