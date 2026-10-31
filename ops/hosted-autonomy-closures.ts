import { MATRIX_PRESERVATION_UNCERTAINTY_DETAIL } from "../src/host/matrix-uncertainty-maintenance.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { ReleaseRequestV1 } from "../src/contracts/release.ts";
import type { ReviewTaskStatementV1 } from "../src/contracts/review-receipt.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { hostedDeliveryProofMatches } from "./hosted-autonomy-delivery-proof.ts";
import {
  type HostedQueueCustodyContext,
  queueRecordProtected,
} from "./hosted-autonomy-queue-context.ts";
import { authorizingReceipt } from "./hosted-autonomy-delivery.ts";
import { intentClosable } from "./hosted-autonomy-retries.ts";
import {
  HOSTED_AUTONOMY_RETIRED,
  hostedDeliveryKey,
  hostedIssueKey,
  isHostedSelf,
} from "./hosted-autonomy-policy.ts";

/**
 * Hosted releases that are accepted, keyed by the exact repository, pull
 * request, head and base they delivered. The repository scope is part of the
 * key, so an accepted release for one repository can never retire another
 * repository's record.
 */
export function acceptedReleases(
  releases: readonly {
    readonly phase: string;
    readonly request: ReleaseRequestV1;
    readonly candidateProof: unknown;
  }[],
): Map<string, unknown> {
  const accepted = new Map<string, unknown>();
  for (const release of releases) {
    if (release.phase !== "accepted") continue;
    if (release.candidateProof === null) continue;
    accepted.set(
      hostedDeliveryKey(
        release.request.target.repository,
        release.request.source.pullRequest,
        release.request.source.head,
        release.request.source.base,
      ),
      release,
    );
  }
  return accepted;
}

/** One closure candidate: the record and its exact repository-scoped issue. */
export interface HostedClosurePlanV1 {
  id: string;
  issueNumber: number;
  repository: RepositoryIdentityV1;
}

/**
 * Records whose exact pull request and reviewed head are delivered, whose issue
 * is still open and whose implementation intent (when present) is provably
 * settled. These are the tasks the runtime's own closure step would finish;
 * marking them done here is the same conclusion from the same evidence, never
 * an earlier one.
 *
 * The two delivery authorities are deliberately separate and repository-bound.
 * A SELF record is closed only by an ACCEPTED hosted release: the trusted
 * release path is bound to the self scope by design, and no other evidence may
 * stand in for it. A FOREIGN record is closed only by `foreignMerged`, the
 * verified merge evidence its own repository surface produced, because the
 * sentinel release authority can never authorize a foreign repository.
 */
export function planHostedClosures(
  snapshot: RepairStateSnapshotV1,
  released: ReadonlyMap<string, unknown>,
  foreignMerged: ReadonlyMap<string, unknown> = new Map(),
  tasks: ReadonlyMap<
    string,
    ReviewTaskStatementV1 | null | "unavailable"
  > = new Map(),
): HostedClosurePlanV1[] {
  const plans: HostedClosurePlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    if (issueNumber === null) continue;
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    if (pullRequest === null || head === null || base === null) continue;
    const key = hostedDeliveryKey(
      record.repository,
      pullRequest,
      head,
      base,
    );
    const delivered = isHostedSelf(record.repository)
      ? released.has(key)
      : hostedDeliveryProofMatches(
        foreignMerged.get(key),
        snapshot,
        record,
        tasks.get(record.id) ?? "unavailable",
      );
    if (!delivered) continue;
    // Delivered evidence alone never closes a task: the SAME shared semantic
    // predicate that authorized the delivery must still authorize the closure
    // against the trusted live issue statement read immediately before it.
    // A legacy quality-only receipt, a drifted digest or an unreadable task
    // context leaves the issue open.
    if (
      authorizingReceipt(
        snapshot,
        record,
        tasks.get(record.id) ?? "unavailable",
      ) ===
        null
    ) continue;
    if (!intentClosable(record, snapshot.reservations)) continue;
    plans.push({ id: record.id, issueNumber, repository: record.repository });
  }
  return plans;
}

/**
 * True for the retirement park itself (`applyHostedRetirements`): blocked on
 * `HOSTED_AUTONOMY_RETIRED` with no operation in flight, the exact shape
 * `planHostedRetirements` never plans again (its inline check is the pinned
 * 01f482529 fix block, `tests/model/positives.ts`). Terminal: no retry,
 * re-admission or delivery rule takes it.
 */
export function isHostedRetired(
  record: Pick<
    RepairStateSnapshotV1["work"][number],
    "nextStep" | "intent" | "blocker"
  >,
): boolean {
  return record.nextStep === "blocked" && record.intent === null &&
    record.blocker?.kind === "other" &&
    record.blocker.message === HOSTED_AUTONOMY_RETIRED;
}

/**
 * Records whose source issue is closed or gone and which can no longer produce
 * anything: the work no longer exists, so the record is parked as blocked with
 * a static reason that the retry pass refuses to clear. A record that produced
 * nothing (no pull request) is parked from a live step only, exactly as before:
 * an already blocked record keeps its own blocker. A record with a pull request
 * still has a delivery path unless that pull request is definitively closed
 * without a merge, and that verdict is evidence from any step — an already
 * blocked record whose pull can never merge is parked with the same static
 * reason. `closedUnmerged` carries the ids whose pull request is closed without
 * a merge; an open, merged or unreadable pull is not evidence. A record with a
 * pull request and an UNSETTLED implementation intent is never retired: the
 * runtime's own uncertainty handler owns that intent, and only a settled
 * implementation intent may be cleared here. Non-implementation intents (the
 * runtime clears an unprepared `base_refresh` itself) and null intents stay
 * retirable.
 */
export function planHostedRetirements(
  snapshot: RepairStateSnapshotV1,
  closedIssues: ReadonlySet<string>,
  closedUnmerged: ReadonlySet<string> = new Set(),
  custody?: HostedQueueCustodyContext,
): HostedClosurePlanV1[] {
  const plans: HostedClosurePlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep === "done" || queueRecordProtected(record, custody)) {
      continue;
    }
    if (
      record.nextStep === "blocked" &&
      record.intent?.kind === "candidate_preservation" &&
      record.blocker?.kind === "other" &&
      record.blocker.message === MATRIX_PRESERVATION_UNCERTAINTY_DETAIL
    ) continue;
    const issueNumber = record.related.issueNumber;
    if (
      issueNumber === null ||
      !closedIssues.has(hostedIssueKey(record.repository, issueNumber))
    ) {
      continue;
    }
    if (record.target.pr === null) {
      // Existing behavior: only a non-blocked record that produced nothing is
      // parked; an already blocked record keeps its own blocker.
      if (record.nextStep === "blocked") continue;
      plans.push({ id: record.id, issueNumber, repository: record.repository });
      continue;
    }
    // Only a definitively closed-unmerged pull proves the task can never
    // deliver; anything else leaves the record alone.
    if (!closedUnmerged.has(record.id)) continue;
    // Already retired (this exact parking): planning it again would rewrite
    // the same row every pass and take a retirement slot from a record that
    // still needs one.
    if (
      record.nextStep === "blocked" && record.intent === null &&
      record.blocker?.kind === "other" &&
      record.blocker.message === HOSTED_AUTONOMY_RETIRED
    ) continue;
    // A self-merge proof (in flight, or kept by `parkSelfMergeRefusal` after
    // the remote writes began) is the only durable binding of a
    // `development` write to its task and review (#197): retirement would
    // clear it, so the record is left for reconciliation.
    if (record.intent?.selfMerge !== undefined) continue;
    // Retirement clears the intent, so it must never take an unsettled
    // implementation intent away from the runtime's own uncertainty handler.
    // `intentClosable` is that same settled-intent rule; it is consulted only
    // for implementation intents, so non-implementation and null intents stay
    // retirable exactly as before.
    if (
      record.intent !== null && record.intent.kind === "implementation" &&
      !intentClosable(record, snapshot.reservations)
    ) continue;
    plans.push({ id: record.id, issueNumber, repository: record.repository });
  }
  return plans;
}

/** Park the given records with the immutable retirement reason (pure). */
export function applyHostedRetirements(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  plans: readonly { id: string; issueNumber: number }[],
  now: number,
): RepairStateSnapshotV1 {
  const ids = new Set(plans.map((plan) => plan.id));
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) =>
      ids.has(record.id)
        ? {
          ...record,
          nextStep: "blocked",
          wait: null,
          blocker: {
            kind: "other",
            message: HOSTED_AUTONOMY_RETIRED,
            since: now,
          },
          intent: null,
          updatedAt: now,
        }
        : record
    ),
  });
}

/** Mark the given records done (pure). */
export function applyHostedClosures(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  plans: readonly { id: string; issueNumber: number }[],
  now: number,
): RepairStateSnapshotV1 {
  const ids = new Set(plans.map((plan) => plan.id));
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) =>
      ids.has(record.id)
        ? {
          ...record,
          nextStep: "done",
          wait: null,
          blocker: null,
          intent: null,
          updatedAt: now,
        }
        : record
    ),
  });
}
