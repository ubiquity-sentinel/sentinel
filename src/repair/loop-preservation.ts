/** Repair loop internals: preservation. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type {
  CandidatePreservationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import { candidateBranch, implementationIntentKey } from "./keys.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  clearIntent,
  markBlocked,
  setCandidateState,
  setWait,
} from "./transitions.ts";

/**
 * One publication observation for the exact previously published candidate
 * head: verified (the head, or null when nothing was published at the prior
 * head) or unavailable (a cooldown or a failed ref read proved nothing).
 */
export type PublishedHeadObservationV1 =
  | { kind: "verified"; head: GitSha | null }
  | { kind: "unavailable" };

/**
 * The exact previously published candidate head for one record.
 *
 * Existing V1 candidate state carries the verified value. A legacy record has
 * no such value: the exact prior target head counts as published ONLY after
 * the actual owned-branch ref was observed at that exact SHA. An unavailable
 * read never becomes publication proof, and never becomes proof of absence
 * either: it stays unavailable so the caller does not persist it as a
 * verified null that a recovered read of the legitimate predecessor head
 * would contradict.
 */
export async function verifiedPublishedHead(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<PublishedHeadObservationV1> {
  const existing = record.target.candidateState;
  if (existing !== undefined) {
    return { kind: "verified", head: existing.publishedHead };
  }
  const priorHead = record.target.head;
  if (priorHead === null) return { kind: "verified", head: null };
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind !== "ok") return { kind: "unavailable" };
  const read = await deps.github.readRef(
    `refs/heads/${candidateBranch(record.id)}`,
  );
  if (!read.ok) return { kind: "unavailable" };
  if (read.value === null || read.value.sha !== priorHead) {
    return { kind: "verified", head: null };
  }
  return { kind: "verified", head: priorHead };
}

/**
 * Reconcile ONE pending candidate-preservation intent through the real
 * trusted capability on this port. Success attaches the exact descriptor and
 * clears the intent in one state write; any error or lost acknowledgement
 * retains the same intent, head and accounting with a bounded wait. This path
 * never starts a model or a review to repair preservation.
 */
export async function executeCandidatePreservation(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const intent = record.intent;
  const candidateState = record.target.candidateState;
  const head = record.target.head;
  if (
    intent === null || intent.kind !== "candidate_preservation" ||
    candidateState === undefined || candidateState.preserved !== null ||
    head === null || intent.requestId === null ||
    intent.branch === null || !isGitSha(head) ||
    intent.expectedHead !== head ||
    intent.observedBase !== record.target.base ||
    intent.key !== implementationIntentKey(intent.requestId) ||
    intent.pr !== null || intent.resultId !== null
  ) {
    return {
      kind: "state_error",
      detail: "candidate preservation intent identity mismatch",
    };
  }
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  const operationKey: string = intent.key;
  const preservationRef: string = intent.branch;
  const candidate: CandidatePreservationV1 = {
    operationKey,
    base: record.target.base,
    head,
    ref: preservationRef,
  };
  const publishedHead: GitSha | null = candidateState.publishedHead;
  const preserved = await deps.github.preserveCandidate({
    taskId: record.id,
    candidate,
    publishedHead,
  });
  const at = deps.clock.now();
  if (!preserved.ok) {
    // A trusted content refusal is deterministic for this exact immutable
    // candidate. Keep its publication identity and submitted charge, but close
    // the preservation operation instead of retrying it or regenerating work.
    if (preserved.error.kind === "invalid") {
      return persistWork(
        deps,
        context,
        markBlocked(
          clearIntent(record, at),
          "other",
          "candidate preservation validation refused",
          at,
        ),
      );
    }
    // A positively proven absent candidate can never be reconciled: the
    // producing checkout lived only inside that run's private scratch, no
    // trusted store or remote ref holds the object, and every retry repeats
    // the same refusal forever while the record keeps a shared publication
    // slot. The attempt stays charged (its reservation is already settled) and
    // the record returns to the legacy work shape whose retained identity is
    // the published branch head, so the next cycle buys a fresh implementation
    // attempt under the existing attempt ceiling instead of retrying a
    // candidate that can never appear.
    if (preserved.error.kind === "not_found") {
      // There is no durable serial/matrix producer discriminator in this shape.
      // Local/remote Git absence does not prove archived artifact loss. Preserve
      // ambiguous modern serial rows too; the separately proven legacy bridge
      // remains the authority for its own historical loss cases.
      if (deps.externalImplementations === true) {
        return persistWork(
          deps,
          context,
          setWait(record, {
            reason: "unavailable",
            since: at,
            until: at + CHECK_POLL_MS,
          }, at),
        );
      }
      const recovered: WorkRecordV1 = {
        ...record,
        intent: null,
        target: {
          base: record.target.base,
          branch: record.target.branch,
          checkpoint: null,
          head: candidateState.publishedHead,
          pr: record.target.pr,
        },
        wait: null,
        updatedAt: at,
      };
      return persistWork(deps, context, recovered);
    }
    // A generic transport/CAS/permission failure is not permanent loss: keep
    // the same intent/head/accounting and reconcile the same operation later.
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
        at,
      ),
    );
  }
  return persistWork(
    deps,
    context,
    setCandidateState(
      clearIntent(record, at),
      {
        preserved: candidate,
        publishedHead,
      },
      at,
    ),
  );
}
