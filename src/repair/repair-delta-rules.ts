/**
 * The one transition rule a fan-out repair delta must satisfy (issue #328),
 * shared by the repository pass that builds a delta and the trusted writer
 * that applies it.
 *
 * A transition replaces ONE existing work record of the delta's repository.
 * It may move the record's lifecycle (next step, wait, blocker, target,
 * evidence, non-model intents and the #326 step stamp) and its no-progress
 * counter. It may never change the record's identity or source, never charge
 * (attempts, retries, review rounds, timeouts), and never create, settle or rewrite a model implementation or replay intent:
 * those stay with the existing planner, cell and trusted serial paths, which
 * own reservations and accounting.
 */
import { canonicalStringify } from "../contracts/canonical.ts";
import { sameRepositoryV1 } from "../contracts/repair-delta.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

export type RepairTransitionRefusalV1 =
  | "foreign_record"
  | "identity_changed"
  | "charge_changed"
  | "model_intent";

/** Fields fixed for the life of a record. */
const IMMUTABLE = [
  "version",
  "kind",
  "repository",
  "id",
  "source",
  "related",
  "fingerprint",
  "failingRevision",
  "sourceSnapshotDigest",
  "classification",
  "urgency",
  "dependencies",
  "controller",
  "firstSeenAt",
  "createdAt",
] as const;

/** Intent kinds whose lifecycle is bound to a reservation or replay. */
const MODEL_INTENTS = new Set(["implementation", "replay"]);

function same(left: unknown, right: unknown): boolean {
  return canonicalStringify(left ?? null) === canonicalStringify(right ?? null);
}

/** Null when `after` may replace `before` in a delta for `repository`. */
export function repairTransitionRefusalV1(
  before: WorkRecordV1,
  after: WorkRecordV1,
  repository: RepositoryIdentityV1,
): RepairTransitionRefusalV1 | null {
  if (
    !sameRepositoryV1(before.repository, repository) ||
    !sameRepositoryV1(after.repository, repository)
  ) return "foreign_record";
  for (const key of IMMUTABLE) {
    if (!same(before[key], after[key])) return "identity_changed";
  }
  if (
    before.counters.attempts !== after.counters.attempts ||
    before.counters.retries !== after.counters.retries ||
    before.counters.reviewRounds !== after.counters.reviewRounds ||
    (before.counters.timeouts ?? 0) !== (after.counters.timeouts ?? 0)
  ) return "charge_changed";
  if (
    !same(before.intent, after.intent) &&
    (MODEL_INTENTS.has(before.intent?.kind ?? "") ||
      MODEL_INTENTS.has(after.intent?.kind ?? ""))
  ) return "model_intent";
  return null;
}
