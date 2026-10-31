/**
 * The dead worker-local candidate release (owner throughput, 2026-10-31).
 *
 * A preserved-null issue record with no pull request and no recorded published
 * head (`unpublishedLocalCandidateShape` in `loop-eligibility.ts`) owns no
 * publishable artifact, so the ordinary lane starts a fresh implementation from
 * the base instead of parking it forever on its placeholder descriptor.
 *
 * That release is only safe when the deterministic candidate branch is also
 * absent: a worker that pushed a candidate but died before the state write left
 * a live branch under `candidateBranch(record.id)` with `publishedHead === null`.
 * A fresh start would produce a different head over the base, and publication
 * refuses an unrecorded branch head (`candidate branch ref identity mismatch`),
 * so the live candidate would be orphaned and the record terminally blocked
 * after a charged run. The cheap live ref read here refuses the start uncharged
 * instead, leaving such a row for the existing parked recovery.
 */
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { candidateBranch } from "./keys.ts";
import { unpublishedLocalCandidateShape } from "./loop-eligibility.ts";
import type { RepairCycleDepsV1, StepResultV1 } from "./loop-types.ts";

/** Refusal detail of a released candidate whose deterministic branch exists. */
export const LOCAL_CANDIDATE_BRANCH_EXISTS_DETAIL =
  "worker-local candidate branch already exists";

/** Refusal detail of an unreadable worker-local candidate branch. */
export const LOCAL_CANDIDATE_BRANCH_UNREADABLE_DETAIL =
  "worker-local candidate branch read unavailable";

/**
 * Re-prove that a released dead worker-local candidate has no live branch.
 * Null means the deterministic branch is absent and the fresh base start may
 * proceed; otherwise the returned step refuses it uncharged (no write, no
 * reservation, no model run).
 */
export async function verifyNoLiveLocalCandidateBranch(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  // Every record outside the released shape keeps its own admission rules.
  if (!unpublishedLocalCandidateShape(record)) return null;
  // The fresh start publishes `candidateBranch(record.id)` (publication uses it
  // whenever there is no takeover custody), so that is the ref to prove absent.
  const ref = `refs/heads/${candidateBranch(record.id)}`;
  let live: Awaited<ReturnType<RepairCycleDepsV1["github"]["readRef"]>>;
  try {
    live = await deps.github.readRef(ref);
  } catch {
    return {
      kind: "deferred",
      detail: LOCAL_CANDIDATE_BRANCH_UNREADABLE_DETAIL,
    };
  }
  if (!live.ok) {
    return {
      kind: "deferred",
      detail: LOCAL_CANDIDATE_BRANCH_UNREADABLE_DETAIL,
    };
  }
  if (live.value !== null) {
    return { kind: "deferred", detail: LOCAL_CANDIDATE_BRANCH_EXISTS_DETAIL };
  }
  return null;
}
