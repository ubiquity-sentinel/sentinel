/**
 * Step input fingerprints (issue #326).
 *
 * A record's fingerprint is the SHA-256 of everything its next serial step
 * reads that this pass can observe cheaply: the record's own content (without
 * its stamp and `updatedAt`), its live GitHub inputs, its own snapshot rows
 * (review receipts, reservations, release requests, dependency states), the
 * lifecycle shape of every other record of its repository (the delivery line
 * and the base-refresh ordering read those), its repository configuration and
 * the run's trusted gates. A record whose last settled step stamped the same
 * fingerprint, and whose stamp deadline has not elapsed, would only repeat that
 * step's deterministic deferral, so the pass skips it with no write and no
 * charge. Every fingerprint input that moved makes the digests differ, and the
 * stamp deadline bounds every input the fingerprint cannot see (review service
 * journals, budget windows, idle timers): the record is stepped again no later
 * than `STEP_INPUTS_MAX_SKIP_MS` after it settled.
 *
 * A stamp is folded into a state write the trusted repair writer already
 * performs (or the pass's one closing write) only while the record still has
 * exactly the content it settled with; it never moves `updatedAt`.
 */
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type {
  StepInputsStampV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import type { RecordLiveInputsV1 } from "./loop-live-inputs.ts";
import {
  configFor,
  releaseRequestMatchesDelivery,
  sameRepositoryIdentity,
} from "./loop-records.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";

/** Longest time a settled record is skipped on unchanged inputs. */
export const STEP_INPUTS_MAX_SKIP_MS = 30 * 60_000;

/** Bumped whenever the fingerprint inputs change shape. */
export const STEP_INPUTS_VERSION = 1;

/** A settled stamp waiting for the next trusted write of this pass. */
export interface PendingStepInputsV1 {
  /** The record content the stamp was computed for (`stepContent`). */
  content: string;
  stamp: StepInputsStampV1;
}

/** Run-level gates every step decision depends on. */
export interface StepInputGatesV1 {
  modelStartsEnabled: boolean | null;
}

/** The record's content without its stamp and update time. */
export function stepContent(record: WorkRecordV1): string {
  const { stepInputs: _stamp, updatedAt: _updated, ...content } = record;
  return canonicalStringify(content);
}

function siblingShape(record: WorkRecordV1): unknown[] {
  return [
    record.id,
    record.nextStep,
    record.wait?.reason ?? null,
    record.intent?.key ?? null,
    record.intent?.resultId ?? null,
    record.target.head,
    record.target.pr,
    record.blocker?.message ?? null,
    record.counters.reviewRounds,
  ];
}

/** The fingerprint of `record` with `inputs` in `snapshot`. */
export function stepFingerprint(
  deps: RepairCycleDepsV1,
  gates: StepInputGatesV1,
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  inputs: RecordLiveInputsV1,
): Promise<string> {
  const pr = record.target.pr ?? record.intent?.pr ?? null;
  const github = deps.github;
  return canonicalStringifySha256({
    version: STEP_INPUTS_VERSION,
    record: stepContent(record),
    inputs,
    reviews: pr === null
      ? []
      : snapshot.reviews.filter((review) =>
        review.pullRequest.number === pr &&
        sameRepositoryIdentity(review.repository, record.repository)
      ),
    reservations: snapshot.reservations.filter((row) =>
      row.taskId === record.id
    ),
    releaseRequests: snapshot.releaseRequests.filter((request) =>
      releaseRequestMatchesDelivery(request, record)
    ),
    dependencies: record.dependencies.map((id) => [
      id,
      snapshot.work.find((row) => row.id === id)?.nextStep ?? null,
    ]),
    siblings: snapshot.work.filter((row) =>
      row.id !== record.id &&
      sameRepositoryIdentity(row.repository, record.repository)
    ).map(siblingShape),
    config: configFor(deps, record.repository),
    gates: {
      controller: deps.controllerSha,
      externalImplementations: deps.externalImplementations === true,
      legacyReviewCutoff: deps.legacyReviewCutoff ?? null,
      modelStartsEnabled: gates.modelStartsEnabled,
      capabilities: [
        github.prepareBaseRefresh !== undefined,
        github.proveCarriedPatch !== undefined,
        github.closeAlreadySatisfiedTask !== undefined,
        github.readCommitParents !== undefined,
        github.existingPrTakeover !== undefined,
        github.nativeQueue !== undefined,
      ],
    },
  });
}

/** The next instant a settled record must be stepped again. */
export function stepDeadline(record: WorkRecordV1, now: number): number {
  const ceiling = now + STEP_INPUTS_MAX_SKIP_MS;
  const until = record.wait?.until ?? null;
  return until !== null && until > now ? Math.min(until, ceiling) : ceiling;
}

/**
 * Fold the pending stamps into `draft` for every record the current mutation
 * left untouched (the same object as in `base`) whose content still equals the
 * content it settled with. A stamp whose record changed is dropped: its
 * settled inputs no longer describe the record. Returns the folded ids.
 */
export function foldStepInputs(
  base: RepairStateSnapshotV1,
  draft: RepairStateSnapshotV1,
  pending: Map<string, PendingStepInputsV1> | undefined,
): string[] {
  const folded: string[] = [];
  if (pending === undefined || pending.size === 0) return folded;
  const original = new Map(base.work.map((record) => [record.id, record]));
  draft.work = draft.work.map((record) => {
    const settled = pending.get(record.id);
    if (settled === undefined) return record;
    if (
      original.get(record.id) !== record ||
      stepContent(record) !== settled.content
    ) {
      pending.delete(record.id);
      return record;
    }
    if (
      record.stepInputs?.digest === settled.stamp.digest &&
      record.stepInputs.deadline === settled.stamp.deadline
    ) {
      pending.delete(record.id);
      return record;
    }
    folded.push(record.id);
    return { ...record, stepInputs: settled.stamp };
  });
  return folded;
}
