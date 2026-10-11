import { parseBudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type {
  BudgetReservationV1,
  ReservationOutcomeV1,
  ReservationPurposeV1,
} from "../contracts/budget-reservation.ts";
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { LiveStartLimitsV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";

/** One rolling hour in milliseconds. */
export const HOUR_WINDOW_MS = 3_600_000;
/** One rolling week in milliseconds. */
export const SEVEN_DAY_WINDOW_MS = 7 * 24 * 3_600_000;

export const PURPOSES: readonly ReservationPurposeV1[] = [
  "implementation",
  "continuation",
  "retry",
  "review_request",
];
export const SETTLEMENT_OUTCOMES: readonly ReservationOutcomeV1[] = [
  "submitted",
  "ambiguous",
  "confirmed_not_submitted",
];
/** Reservations that still charge the caps; refunded proof is the only uncharged terminal. */
export function isCharged(
  reservation: BudgetReservationV1,
): boolean {
  return reservation.outcome !== "confirmed_not_submitted";
}

/**
 * Earliest retry time under the rolling caps at `now` for the given
 * reservations. Windows are (x - windowMs, x]; refunded
 * confirmed_not_submitted reservations never charge. Entries are sorted by
 * their charge timestamp (createdAt) and the earliest x >= now that admits
 * one more start is the max of every enforced per-window result. A cap that is
 * explicitly null is not enforced at all: the explicit uncapped policy
 * records every start durably but never defers one.
 *
 * Exported for deterministic use and boundary tests. Invalid input (a
 * malformed reservation, a non-safe `now`, a non-positive numeric cap, or a
 * numeric hour cap that exceeds a numeric weekly cap) and arithmetic overflow
 * throw one fixed sanitized RangeError that never echoes input values; callers
 * catch it at their boundary and fail closed.
 */
export function earliestRetryAt(
  reservations: readonly BudgetReservationV1[],
  now: number,
  limits: LiveStartLimitsV1,
): number {
  if (!isSafeTimestamp(now)) {
    throw new RangeError("earliestRetryAt: invalid now");
  }
  if (
    (limits.perHour !== null && !isPositiveSafeInt(limits.perHour)) ||
    (limits.perSevenDays !== null &&
      !isPositiveSafeInt(limits.perSevenDays)) ||
    (limits.perHour !== null && limits.perSevenDays !== null &&
      limits.perHour > limits.perSevenDays)
  ) {
    throw new RangeError("earliestRetryAt: invalid limits");
  }
  if (!Array.isArray(reservations)) {
    throw new RangeError("earliestRetryAt: invalid reservations");
  }
  // The frozen reservation parser is the input gate: reserved/settled
  // lifecycle, safe timestamps and valid refs are all already enforced.
  for (const reservation of reservations) {
    try {
      parseBudgetReservationV1(reservation);
    } catch {
      throw new RangeError("earliestRetryAt: invalid reservation");
    }
  }
  const descending = reservations
    .filter(isCharged)
    .map((r) => r.createdAt)
    .sort((a, b) => b - a);
  let retryAt = now;
  // Each numeric cap still defers; explicit null has no admission cap for
  // that window, so only the enforced windows bound admission.
  if (limits.perHour !== null) {
    retryAt = Math.max(
      retryAt,
      perWindowRetryAt(descending, limits.perHour, HOUR_WINDOW_MS, now),
    );
  }
  if (limits.perSevenDays !== null) {
    retryAt = Math.max(
      retryAt,
      perWindowRetryAt(
        descending,
        limits.perSevenDays,
        SEVEN_DAY_WINDOW_MS,
        now,
      ),
    );
  }
  return retryAt;
}

export function perWindowRetryAt(
  descending: readonly number[],
  limit: number,
  windowMs: number,
  now: number,
): number {
  if (descending.length < limit) return now;
  // The limit-th most recent charge must fall out of the window before one
  // more start fits; sorting handles several excess entries, not one.
  const threshold = descending[limit - 1];
  const retryAt = threshold + windowMs;
  if (!Number.isSafeInteger(retryAt)) {
    throw new RangeError("earliestRetryAt: retry timestamp overflow");
  }
  return Math.max(now, retryAt);
}

export function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The next snapshot sequence: sequence 1 on branch creation, otherwise
 * exactly one more than the prior sequence. Returns null when the increment
 * would leave the safe-integer range (exhausted state: no write may proceed).
 */
export function nextSequence(
  prior: RepairStateSnapshotV1 | null,
): number | null {
  const value = prior === null ? 1 : prior.sequence + 1;
  return Number.isSafeInteger(value) ? value : null;
}

/** SHA-256 of the canonical JSON identity — the trusted reservation id. */
export async function deriveReservationId(
  identity: {
    repository: RepositoryIdentityV1;
    taskId: WorkItemId;
    head: GitSha;
    attempt: number;
    purpose: ReservationPurposeV1;
  },
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalStringify({
      repository: identity.repository,
      taskId: identity.taskId,
      head: identity.head,
      attempt: identity.attempt,
      purpose: identity.purpose,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function sameLogicalIdentity(
  reservation: BudgetReservationV1,
  repository: RepositoryIdentityV1,
  taskId: WorkItemId,
  head: GitSha,
  attempt: number,
  purpose: ReservationPurposeV1,
): boolean {
  return sameRepository(reservation.repository, repository) &&
    reservation.taskId === taskId &&
    reservation.head === head &&
    reservation.attempt === attempt &&
    reservation.purpose === purpose;
}

export function sameRepository(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

export function unavailable<T extends string>(
  detail: T,
): { status: "unavailable"; detail: T } {
  return { status: "unavailable", detail };
}

export function invalid<T extends string>(
  detail: T,
): { status: "invalid"; detail: T } {
  return { status: "invalid", detail };
}

export function disabledPolicy(
  detail: string,
): { status: "disabled"; detail: string } {
  return { status: "disabled", detail };
}
