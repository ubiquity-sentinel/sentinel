/**
 * The repeat-failure bound (JAM B10, non-progress cycle): an implementation
 * retry that keeps failing the SAME way is parked for the owner instead of
 * being re-granted on every base move.
 *
 * Durable attempt memory is keyed by (task, base, runtime), so it never
 * refuses a task whose target base keeps moving: ai.ubq.fi 300 recorded 53
 * identical "model run failed (unavailable)" outcomes over 23 bases, each
 * after a fresh charged reservation, and the per-task 200-reservation cap was
 * the only remaining bound. This module reads the same attempt memory
 * base-independently.
 *
 * - Signature: the blocker class plus the first 16 hex digits of the SHA-256
 *   of the normalized blocker message (case, whitespace, hex identities and
 *   numbers folded), so neither the base, the runtime revision nor an
 *   embedded SHA makes two equal failures look different.
 * - Streak: the task's implementation outcomes newest first, across every
 *   base and runtime; it stops at the newest outcome with a different
 *   normalized detail and at the newest recorded success. An entry that
 *   straddles that boundary counts once (only its last occurrence is proven
 *   later), so the count never overstates.
 * - Park: `REPEAT_FAILURE_PARK_THRESHOLD` (3) identical outcomes park the
 *   record — for a transient-classified outcome only once they also span the
 *   attempt policy's own six-hour transient decay window, so a provider
 *   outage shorter than that window never parks the fleet. Three is the
 *   owner's review-round cap and the attempt policy's no-progress tolerance
 *   plus one; with an independent transient fault, three identical failures
 *   six hours apart are already improbable, and every further grant is a
 *   charged model start.
 * - The park is ONE write: the record stays `blocked`, its retained intent,
 *   counters, charges and attempt memory untouched, and only its blocker
 *   becomes the explicit owner-gated message below, which no retry rule of
 *   this or any earlier launcher matches. Every later pass names it
 *   (`repeat_failure_parked`) without writing.
 * - Re-arm: an edited source issue (its canonical task digest differs from
 *   the one the park recorded) or a changed model route (the launcher's
 *   route selector identity differs) returns the record to `work` once,
 *   through the ordinary gates; a different failure signature resets the
 *   streak by construction. An identical failure after a re-arm re-parks at
 *   once: the change did not alter the outcome. Age, generation or a base
 *   move alone never re-arm.
 *
 * Charged reservations stay charged: nothing here settles, refunds or
 * deletes a charge, and parking only withholds a new one.
 */
import { createHash } from "node:crypto";
import type { AttemptFailureClassV1 } from "../src/contracts/attempt-memory.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { MaxText } from "../src/contracts/validation.ts";
import { ATTEMPT_TRANSIENT_DECAY_MS } from "../src/repair/attempt-policy.ts";
import { sameRepository } from "./hosted-autonomy-policy.ts";
import {
  isPassportWorkTrial,
  passportTrialCanReconsider,
} from "../src/repair/passport-work-trial.ts";

/** Identical consecutive outcomes that park a record (see module doc). */
export const REPEAT_FAILURE_PARK_THRESHOLD = 3;

/** A transient-class streak must span the attempt policy's decay window. */
export const REPEAT_FAILURE_TRANSIENT_SPAN_MS = ATTEMPT_TRANSIENT_DECAY_MS;

/** The owner-gated blocker prefix; no retry rule of any launcher matches it. */
export const REPEAT_FAILURE_PARK_PREFIX =
  "repeated identical failure; owner action required (close or edit the issue, or change the model route): ";

/** The work record contract's blocker message bound. */
const MAX_BLOCKER_MESSAGE = MaxText.message;

const PARK_PATTERN = new RegExp(
  `^${
    REPEAT_FAILURE_PARK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }(\\d{1,9})x ([a-z_]{1,32}\\|[0-9a-f]{16}) issue=([0-9a-f]{12}|none) route=([0-9a-f]{12}): `,
);

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Case, whitespace, hex identities and numbers folded. */
export function normalizeFailureMessage(message: string): string {
  return message.normalize("NFC").toLowerCase()
    .replace(/\b[0-9a-f]{7,64}\b/g, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/** `<blocker kind>|<16 hex of the normalized message digest>`. */
export function failureSignature(kind: string, message: string): string {
  return `${kind}|${sha256Hex(normalizeFailureMessage(message)).slice(0, 16)}`;
}

/**
 * The launcher's model-route identity: 12 hex digits over the non-secret
 * route selector the supervisor workflow hands every job (`SENTINEL_MODEL_*`
 * repository variables). Unset and empty are the same selector.
 */
export function repeatFailureRouteIdentity(selector: {
  baseUrl: string | null;
  model: string | null;
  fallback: string | null;
}): string {
  const value = (raw: string | null) => (raw ?? "").trim();
  return sha256Hex(canonicalStringify({
    domain: "sentinel.repeat-failure.route.v1",
    baseUrl: value(selector.baseUrl),
    model: value(selector.model),
    fallback: value(selector.fallback),
  })).slice(0, 12);
}

/** The identity of an entirely unset selector (tests, absent environment). */
export const REPEAT_FAILURE_DEFAULT_ROUTE: string = repeatFailureRouteIdentity(
  { baseUrl: null, model: null, fallback: null },
);

export interface RepeatFailureStreakV1 {
  signature: string;
  /** Proven consecutive identical outcomes (never overstated). */
  count: number;
  firstAtMs: number;
  lastAtMs: number;
  /** The newest outcome's recorded class. */
  failureClass: AttemptFailureClassV1;
}

/**
 * The record's current identical-failure streak, or null when its blocker is
 * not the newest recorded implementation outcome of its task.
 */
export function repeatFailureStreak(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): RepeatFailureStreakV1 | null {
  const blocker = record.blocker;
  if (record.nextStep !== "blocked" || blocker === null) return null;
  const target = normalizeFailureMessage(blocker.message);
  let success = Number.NEGATIVE_INFINITY;
  const entries: {
    normalized: string;
    count: number;
    firstAtMs: number;
    lastAtMs: number;
    failureClass: AttemptFailureClassV1;
  }[] = [];
  for (const memory of snapshot.attemptMemory) {
    if (
      memory.taskId !== record.id || memory.purpose !== "implementation" ||
      !sameRepository(memory.repository, record.repository)
    ) continue;
    if (typeof memory.lastSuccessAtMs === "number") {
      success = Math.max(success, memory.lastSuccessAtMs);
    }
    for (const entry of memory.entries) {
      entries.push({
        normalized: normalizeFailureMessage(entry.detail),
        count: entry.count,
        firstAtMs: entry.firstAtMs,
        lastAtMs: entry.lastAtMs,
        failureClass: entry.failureClass,
      });
    }
  }
  entries.sort((left, right) => right.lastAtMs - left.lastAtMs);
  const newest = entries[0];
  if (
    newest === undefined || newest.normalized !== target ||
    newest.lastAtMs <= success
  ) return null;
  const different = entries.find((entry) => entry.normalized !== target);
  const boundary = Math.max(success, different?.lastAtMs ?? success);
  let count = 0;
  let firstAtMs = newest.lastAtMs;
  for (const entry of entries) {
    if (entry.normalized !== target || entry.lastAtMs <= boundary) continue;
    // Wholly after the boundary: every occurrence counts. Straddling it:
    // only the last occurrence is proven later.
    const whole = entry.firstAtMs > boundary;
    count += whole ? entry.count : 1;
    firstAtMs = Math.min(firstAtMs, whole ? entry.firstAtMs : entry.lastAtMs);
  }
  return {
    signature: failureSignature(blocker.kind, blocker.message),
    count,
    firstAtMs,
    lastAtMs: newest.lastAtMs,
    failureClass: newest.failureClass,
  };
}

/** True once a streak has reached the bound (see module doc). */
export function repeatFailureDue(streak: RepeatFailureStreakV1): boolean {
  if (streak.count < REPEAT_FAILURE_PARK_THRESHOLD) return false;
  return streak.failureClass !== "transient_infrastructure" ||
    streak.lastAtMs - streak.firstAtMs >= REPEAT_FAILURE_TRANSIENT_SPAN_MS;
}

export interface RepeatFailureParkV1 {
  count: number;
  signature: string;
  /** 12 hex of the canonical source task digest at park time, or `none`. */
  issue: string;
  /** The launcher route identity at park time. */
  route: string;
}

/** The explicit owner-gated blocker message; it keeps the original detail. */
export function repeatFailureParkMessage(
  park: RepeatFailureParkV1,
  original: string,
): string {
  return `${REPEAT_FAILURE_PARK_PREFIX}${park.count}x ${park.signature} issue=${park.issue} route=${park.route}: ${original}`
    .slice(0, MAX_BLOCKER_MESSAGE);
}

/** The park a blocker records, or null for every other blocker. */
export function parseRepeatFailurePark(
  blocker: WorkRecordV1["blocker"],
): RepeatFailureParkV1 | null {
  if (blocker === null || blocker.kind !== "other") return null;
  const match = PARK_PATTERN.exec(blocker.message);
  if (match === null) return null;
  return {
    count: Number(match[1]),
    signature: match[2],
    issue: match[3],
    route: match[4],
  };
}

/** Launcher facts the bound reads; absent means nothing can be verified. */
export interface RepeatFailureContextV1 {
  /** `repeatFailureRouteIdentity` of this launcher's route selector. */
  route: string;
  /**
   * The live canonical task digest (`ReviewTaskStatementV1.digest`) of each
   * issue-backed record's source issue this pass, by record id; null when it
   * could not be read.
   */
  issueDigests: ReadonlyMap<string, string | null>;
}

export type RepeatFailureVerdictV1 =
  | { kind: "none" }
  /** Withhold the grant and write `message` as the record's blocker. */
  | { kind: "park"; park: RepeatFailureParkV1; message: string }
  /** Due, but the source digest is unreadable: withhold, write nothing. */
  | { kind: "unverified"; streak: RepeatFailureStreakV1 }
  | { kind: "parked"; park: RepeatFailureParkV1 }
  | {
    kind: "rearm";
    park: RepeatFailureParkV1;
    trigger: "issue_edited" | "route_changed" | "passport_trial";
  };

function issueBaseline(
  record: WorkRecordV1,
  context: RepeatFailureContextV1 | undefined,
): string | null {
  if (record.related.issueNumber === null) return "none";
  const digest = context?.issueDigests.get(record.id) ?? null;
  return digest !== null && /^[0-9a-f]{64}$/.test(digest)
    ? digest.slice(0, 12)
    : null;
}

/**
 * The bound's verdict on one blocked record. Pure; the caller applies a
 * `park` in its own CAS write and reports every non-`none` verdict.
 */
export function repeatFailureVerdict(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  context?: RepeatFailureContextV1,
): RepeatFailureVerdictV1 {
  const parked = parseRepeatFailurePark(record.blocker);
  if (isPassportWorkTrial(record.repository)) {
    return parked !== null &&
        passportTrialCanReconsider(record, snapshot.reservations)
      ? { kind: "rearm", park: parked, trigger: "passport_trial" }
      : parked === null
      ? { kind: "none" }
      : { kind: "parked", park: parked };
  }
  const route = context?.route ?? REPEAT_FAILURE_DEFAULT_ROUTE;
  if (parked !== null) {
    if (context !== undefined && parked.route !== route) {
      return { kind: "rearm", park: parked, trigger: "route_changed" };
    }
    const issue = issueBaseline(record, context);
    if (
      issue !== null && issue !== "none" && parked.issue !== "none" &&
      issue !== parked.issue
    ) return { kind: "rearm", park: parked, trigger: "issue_edited" };
    return { kind: "parked", park: parked };
  }
  const streak = repeatFailureStreak(snapshot, record);
  if (streak === null || !repeatFailureDue(streak)) return { kind: "none" };
  const issue = issueBaseline(record, context);
  if (issue === null) return { kind: "unverified", streak };
  const park = {
    count: streak.count,
    signature: streak.signature,
    issue,
    route,
  };
  return {
    kind: "park",
    park,
    message: repeatFailureParkMessage(park, record.blocker!.message),
  };
}

/** True when the bound needs this record's live source digest this pass. */
export function repeatFailureNeedsIssue(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): boolean {
  if (isPassportWorkTrial(record.repository)) return false;
  if (record.nextStep !== "blocked" || record.related.issueNumber === null) {
    return false;
  }
  if (parseRepeatFailurePark(record.blocker) !== null) return true;
  const streak = repeatFailureStreak(snapshot, record);
  return streak !== null && repeatFailureDue(streak);
}

/** One park the retry pass writes. */
export interface RepeatFailureParkPlanV1 {
  id: string;
  repository: WorkRecordV1["repository"];
  message: string;
  park: RepeatFailureParkV1;
}

/**
 * Apply parks to one snapshot (pure): only the blocker of each named,
 * still-blocked record changes. Intent, counters, charges, reviews and
 * attempt memory are untouched.
 */
export function applyRepeatFailureParks(
  snapshot: RepairStateSnapshotV1,
  parks: readonly RepeatFailureParkPlanV1[],
  now: number,
): RepairStateSnapshotV1 {
  if (parks.length === 0) return snapshot;
  return parseRepairStateSnapshotV1({
    ...snapshot,
    work: snapshot.work.map((record) => {
      const park = parks.find((item) =>
        item.id === record.id &&
        sameRepository(item.repository, record.repository)
      );
      if (park === undefined || record.nextStep !== "blocked") return record;
      return {
        ...record,
        blocker: { kind: "other", message: park.message, since: now },
        updatedAt: now,
      };
    }),
  });
}

/**
 * The bound's gate inside `planHostedRetries`: true when the record is
 * withheld, reported through `onDenied` (and a due park through `onPark`).
 * A parked record is withheld everywhere; a due or unverified one only where
 * a work grant would be planned (`atWorkGrant`).
 */
export function repeatFailureWithheld(
  verdict: RepeatFailureVerdictV1,
  record: WorkRecordV1,
  atWorkGrant: boolean,
  onDenied?: (
    denial: {
      id: string;
      repository: WorkRecordV1["repository"];
      reason: string;
    },
  ) => void,
  onPark?: (park: RepeatFailureParkPlanV1) => void,
): boolean {
  const deny = (reason: string) =>
    onDenied?.({ id: record.id, repository: record.repository, reason });
  if (verdict.kind === "parked") {
    deny(`repeat_failure_parked:${repeatFailureLabel(verdict.park)}`);
    return true;
  }
  if (!atWorkGrant) return false;
  if (verdict.kind === "park") {
    onPark?.({
      id: record.id,
      repository: record.repository,
      message: verdict.message,
      park: verdict.park,
    });
    deny(`repeat_failure_parked:${repeatFailureLabel(verdict.park)}`);
    return true;
  }
  if (verdict.kind === "unverified") {
    deny("repeat_failure_unverified_issue");
    return true;
  }
  return false;
}

/** The bounded action naming one park or parked record in the run summary. */
export function repeatFailureLabel(park: RepeatFailureParkV1): string {
  return `${park.signature}:x${park.count}`;
}
