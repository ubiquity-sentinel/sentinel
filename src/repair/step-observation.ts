/**
 * Observation-only wait re-arms (#328 widening, owner decision 2026-11-05).
 *
 * A step that read its live inputs and only re-armed a bounded wait of an
 * intent-free record (a CI result still pending, a review result not yet
 * posted, a post-merge delivery check still running, a read that failed into
 * `backoff`/`unavailable`) moved nothing but the wait. The serial input gate
 * settles such a step like a deferral: it stamps the record (#326), which is
 * what makes the record delegable to a repository cell on the next plan.
 *
 * The stamp deadline is the re-armed wait's own `until` (`stepDeadline`), so
 * the serial pass never skips such a record longer than the ranking already
 * does. A delegated record whose next step needs an effect (a GitHub write, a
 * reservation, a model start or a review receipt) is still handed back by
 * its cell, which drops the stamp, so the next plan keeps it trusted.
 */
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  WorkRecordV1,
  WorkWaitReasonV1,
} from "../contracts/work-record.ts";

/** Wait reasons a pure read re-arms (never quota, budget, ledger, manual). */
export const OBSERVATION_WAIT_REASONS: ReadonlySet<WorkWaitReasonV1> = new Set<
  WorkWaitReasonV1
>([
  "backoff",
  "unavailable",
  "deployment",
  "ci_pending",
  "review_pending",
]);

/** The record without its wait, stamp, update time and no-progress count. */
function observationShape(record: WorkRecordV1): string {
  const {
    wait: _wait,
    stepInputs: _stamp,
    updatedAt: _updated,
    counters,
    ...rest
  } = record;
  const { stalled: _stalled, ...charged } = counters;
  return canonicalStringify({ ...rest, counters: charged });
}

/**
 * True when `after` differs from `before` (the record as its step selected
 * it) only by a running observation wait: no intent before or after, no
 * blocker, the same lifecycle step, target, evidence and charges.
 */
export function rearmedObservation(
  before: WorkRecordV1,
  after: WorkRecordV1,
  now: number,
): boolean {
  const wait = after.wait;
  return before.id === after.id && before.intent === null &&
    after.intent === null && after.blocker === null && wait !== null &&
    OBSERVATION_WAIT_REASONS.has(wait.reason) && wait.until !== null &&
    wait.until > now && observationShape(before) === observationShape(after);
}
