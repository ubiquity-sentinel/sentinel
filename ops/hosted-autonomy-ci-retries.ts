/**
 * Re-admission of a reviewed head that a pre-correction runtime parked on its
 * merge-gate CI failure ("CI checks failed: ..."). The grant only returns the
 * record to `delivery` with its blocker cleared; it writes no CI evidence and
 * decides nothing about the failure. The installed runtime's own CI gate then
 * re-observes the exact head and its reviewed base: a candidate-caused failure
 * opens a correction round while rounds remain, a red base defers without
 * spending one, and a broken head on a moved base is corrected before any
 * refresh. Charges, counters and the publication identity are untouched.
 *
 * The correction rule is inert unless the AUTHENTICATED installed runtime is
 * an exact allowlisted CI-correction revision at generation 78 or later that
 * holds its own healthy proof for that exact pointer. Under any other runtime
 * (including R77 restored after a failed generation 78) a re-admitted head
 * would only be re-gated and blocked again. The flake comes first: the
 * caller re-admits a head for correction only once its once-per-head re-run
 * (ops/hosted-autonomy-ci-rerun.ts) can no longer act, and only once its
 * pull request reads open (`HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS` is a
 * retired throttle).
 *
 * The green-head rule (`ciGreenRedeliveryEligible`) needs no such runtime: a
 * head whose CI is green NOW on its unchanged reviewed base passes any
 * runtime's merge gate, so it never reaches a correction route, open or
 * closed. It is how a flaked run that the launcher re-ran returns to
 * delivery, review rounds spent or not, from the legacy CI block and from the
 * runtime's own unattributed block alike.
 */
import { hasBlockingSeverity } from "../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { HOSTED_RUNTIME_ROLLOUT } from "../src/host/hosted-runtime-rollout.ts";
import type { HostedRuntimeRecordV1 } from "../src/contracts/hosted-supervisor.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { ciCorrectable } from "../src/repair/ci-rejection.ts";
import {
  HOSTED_AUTONOMY_CI_FAILED_PREFIX,
  HOSTED_AUTONOMY_CI_UNATTRIBUTED_PREFIX,
  hostedRepositoryKey,
  sameRepository,
} from "./hosted-autonomy-policy.ts";

/**
 * First runtime generation whose HOSTED runs open the CI correction route.
 * Generation 77 carries the route but keeps it closed in hosted runs (its
 * rollback target 76 refused the correction cell); generation 78 opens it.
 */
export const HOSTED_AUTONOMY_CI_CORRECTION_MIN_GENERATION = 78;

/**
 * Exact reviewed runtime revisions whose hosted runs open the CI correction
 * route (`HOSTED_CI_CORRECTIONS` true in that revision's own tree, which a
 * test proves for every listed revision present locally). It never names a
 * runtime at or before generation 77: R77 keeps the hosted route closed, so a
 * head re-admitted under it would only be blocked again, and a failed
 * generation 78 restores R77 at generation 79, which this set excludes by
 * revision.
 */
export const HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES: ReadonlySet<string> =
  new Set<string>([
    ...HOSTED_RUNTIME_ROLLOUT.ciCorrection,
    // Generation 78 (R78), pinned by its launcher commit.
    "474f87eb639f97cd72b9bc4b9e56101488f841aa",
    // Generation 79 (R79), pinned by its launcher commit.
    "549c7a69186b3d2070aa4e69c92ee846d183ce8f",
    // Generation 80 (R80), pinned by its launcher commit.
    "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481",
    // Generation 81 (R81), pinned by its launcher commit.
    "da98f5f49c45b57cfa97a45fe647c36b1021f302",
  ]);

/**
 * Retired per-pass throttle on CI correction re-admissions (4, then 12 from
 * 2026-10-17). The owner directive lifting artificial caps retires it the way
 * the conflict-resolution throttle was retired: the exported numeric policy
 * stays for importers while every remotely verified candidate is admitted.
 * The retry pass still re-admits a head only after its pull request reads
 * open, and the correction itself stays a charged, round-counted runtime
 * step: review rounds, durable reservations, current-head CI and the
 * proven-runtime rule (`ciCorrectionRuntimeProven`) remain the bounds.
 */
export const HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS = Number.MAX_SAFE_INTEGER;

/**
 * True only for an allowlisted CI-correction runtime at generation 78+ whose
 * own settled healthy proof binds this exact revision and generation. A
 * missing, failed or foreign proof never activates the rule.
 */
export function ciCorrectionRuntimeProven(
  runtime: HostedRuntimeRecordV1 | null | undefined,
  allowlist: ReadonlySet<string> = HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES,
): boolean {
  if (runtime === null || runtime === undefined) return false;
  const proof = runtime.lastHealthyProof;
  return allowlist.has(runtime.activeRevision) &&
    Number.isSafeInteger(runtime.generation) &&
    runtime.generation >= HOSTED_AUTONOMY_CI_CORRECTION_MIN_GENERATION &&
    proof !== null && proof.outcome === "healthy" && proof.settled === true &&
    proof.startupReady === true &&
    proof.execution.revision === runtime.activeRevision &&
    proof.execution.generation === runtime.generation;
}

type WorkRow = RepairStateSnapshotV1["work"][number];

/**
 * True only for the exact legacy shape the runtime's merge gate leaves: an
 * issue task blocked on its own reviewed, still-published head with no
 * operation in flight, a review round left and no release request. The caller
 * checks the installed runtime first (`ciCorrectionRuntimeProven`).
 *
 * The record shape is the runtime's own `ciCorrectable` predicate over the
 * same durable ledger (issue task, exact publication, a durably described
 * candidate, no operation in flight, a CI fix left and a review round left by
 * the hard ceiling's own count, `reviewRoundsLeft`: fewer than
 * `CI_CORRECTION_REVIEW_ROUNDS`, or a legacy record whose one final round is
 * still open), never a copy: a head the runtime cannot correct is blocked again by
 * its merge gate at once, so re-admitting it would only churn on every pass.
 */
export function ciRedeliveryEligible(
  snapshot: RepairStateSnapshotV1,
  record: WorkRow,
  /** The launcher's legacy review cutoff (`launcherLegacyCutoff`). */
  cutoff?: number | null,
): boolean {
  return ciCorrectable(record, snapshot, cutoff) &&
    ciGateParked(snapshot, record, CORRECTION_PREFIXES);
}

/**
 * `ciRedeliveryEligible` without the review-round and CI fix ceilings, for a
 * head whose CI is green again (the caller proves that and the unchanged
 * base). The shape is still the runtime's own predicate, evaluated as if no
 * round or fix were spent: the ceilings only bound corrections, and a green
 * head needs none.
 * Besides the legacy block it accepts the runtime's own unattributed block
 * ("CI checks failed without base evidence: ..."), so that block keeps the
 * free flake re-run and green re-admission; the correction rule never takes
 * it, because the runtime would block the same unattributed head again.
 */
export function ciGreenRedeliveryEligible(
  snapshot: RepairStateSnapshotV1,
  record: WorkRow,
): boolean {
  // Neither the review-round nor the CI fix ceiling applies: a green head
  // needs no correction and no fix, so its rounds are counted over no ledger.
  return ciCorrectable({
    ...record,
    counters: { ...record.counters, reviewRounds: 0, retries: 0 },
  }, NO_LEDGER) && ciGateParked(snapshot, record, GREEN_PREFIXES);
}

/** No charge at all: the green rule counts neither rounds nor fixes. */
const NO_LEDGER = { reservations: [] } as const;

/** The merge-gate blocks a correction re-admission may clear. */
const CORRECTION_PREFIXES: readonly string[] = [
  HOSTED_AUTONOMY_CI_FAILED_PREFIX,
];
/** The CI blocks a green head (or its single flake re-run) may clear. */
const GREEN_PREFIXES: readonly string[] = [
  HOSTED_AUTONOMY_CI_FAILED_PREFIX,
  HOSTED_AUTONOMY_CI_UNATTRIBUTED_PREFIX,
];

/** One exact head of one repository, as the green-head set carries it. */
export function ciGreenHeadKey(
  repository: RepositoryIdentityV1,
  head: string,
): string {
  return `${hostedRepositoryKey(repository)}@${head}`;
}

/** Parked on its own merge-gate CI failure after a clean review, unreleased. */
function ciGateParked(
  snapshot: RepairStateSnapshotV1,
  record: WorkRow,
  prefixes: readonly string[],
): boolean {
  const blocker = record.blocker;
  if (
    blocker === null || blocker.kind !== "other" ||
    !prefixes.some((prefix) => blocker.message.startsWith(prefix))
  ) return false;
  if (record.related.issueNumber === null) return false;
  const { head, pr, base } = record.target;
  // The gate that failed ran after review authorization: the exact head must
  // hold its completed, non-rejecting review against this base.
  const reviewed = snapshot.reviews.some((review) =>
    sameRepository(review.repository, record.repository) &&
    review.pullRequest.number === pr && review.pullRequest.head === head &&
    review.pullRequest.base === base && review.outcome === "completed" &&
    !hasBlockingSeverity(review.unresolvedSeverities)
  );
  if (!reviewed) return false;
  // A release-phase CI block belongs to an already merged delivery.
  return !snapshot.releaseRequests.some((request) =>
    sameRepository(request.target.repository, record.repository) &&
    request.source.pullRequest === pr && request.source.head === head
  );
}
