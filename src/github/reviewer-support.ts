// reviewer support.

import type { CodexSessionV1 } from "../repair/codex-transport.ts";
import type { ReviewResultV1 } from "./review-journal.ts";
import type { ReviewSnapshotV1 } from "./review-snapshot.ts";
import { portError, type PortResultV1 } from "../contracts/ports.ts";
import {
  CLOSE_BOUND_MS,
  CLOSE_FAILED_MARKER,
  CLOSE_INVALIDATED_DETAIL,
  FINDING_PATH_DETAIL,
  FINDING_RANGE_DETAIL,
  MAX_ID_CHARS,
  MAX_PROVIDER_CHARS,
} from "./reviewer-policy.ts";
import type {
  StructuredReviewCloseV1,
  StructuredReviewOutcomeV1,
} from "./codex-reviewer.ts";

export function isBoundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= MAX_ID_CHARS;
}

export function isValidProvider(value: string): boolean {
  if (value.length === 0 || value.length > MAX_PROVIDER_CHARS) return false;
  if (value.trim() !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * Bounded configured review model id: the same trusted shape contract as the
 * provider name (nonempty, no leading/trailing whitespace, no control
 * characters, finite length). The configured value is never silently trimmed
 * or replaced by a built-in default.
 */
export function isValidReviewModel(value: unknown): value is string {
  return typeof value === "string" && isValidProvider(value);
}

/**
 * Trusted named permission profile: a host-defined name only. Built-in
 * full-access mode identifiers are never accepted as a named profile binding.
 */
export const PERMISSION_PROFILE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const BUILTIN_FULL_ACCESS_PERMISSION_PROFILE_IDS = new Set([
  "full-access",
  "danger-full-access",
]);

export function isValidPermissionProfile(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (!PERMISSION_PROFILE_PATTERN.test(value)) return false;
  return !BUILTIN_FULL_ACCESS_PERMISSION_PROFILE_IDS.has(value.toLowerCase());
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isAbsoluteMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0;
}

/** Bounded race of one promise against an absolute deadline. */
export async function racePromise<T>(
  promise: Promise<T>,
  deadline: number,
  now: () => number,
): Promise<
  { ok: true; value: T } | { ok: false; reason: "deadline" | "failure" }
> {
  const remaining = deadline - now();
  if (remaining <= 0) {
    promise.catch(() => {});
    return { ok: false, reason: "deadline" };
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const, reason: "failure" as const }),
      ),
      new Promise<{ ok: false; reason: "deadline" }>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, reason: "deadline" }),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Bounded close of one owned session; never hangs and never throws. */
export async function boundedClose(
  session: CodexSessionV1,
  now: () => number,
  settleBy: number,
): Promise<StructuredReviewCloseV1> {
  const remaining = settleBy - now();
  const bound = remaining > 0 ? Math.min(CLOSE_BOUND_MS, remaining) : 0;
  const closed = await racePromise(
    Promise.resolve().then(() => session.close()),
    now() + bound,
    now,
  );
  let settled = closed.ok;
  let failure: string | null = null;
  let timedOut = false;
  if (!closed.ok) {
    if (closed.reason === "deadline") timedOut = true;
    else failure = CLOSE_FAILED_MARKER;
  }
  // Settlement/failure probes are optional test-double capabilities: a
  // throwing probe is reported as unsettled with the static sanitized marker,
  // never as an escaping raw error, and a reported fatal failure is only ever
  // surfaced as that same marker.
  try {
    if (session.isSettled !== undefined && !session.isSettled()) {
      settled = false;
    }
  } catch {
    settled = false;
    failure = CLOSE_FAILED_MARKER;
  }
  try {
    if (session.getFailure !== undefined && session.getFailure() !== null) {
      settled = false;
      failure = CLOSE_FAILED_MARKER;
    }
  } catch {
    settled = false;
    failure = CLOSE_FAILED_MARKER;
  }
  return { settled, failure, timedOut };
}

/** Every finding location must exist inside the exact candidate manifest. */
export function validateFindingLocations(
  result: ReviewResultV1,
  snapshot: ReviewSnapshotV1,
): string | null {
  const lines = new Map<string, number>();
  for (const file of snapshot.files) {
    if (file.kind === "deleted") continue;
    lines.set(file.path, file.candidateLines ?? 0);
  }
  for (const finding of result.findings) {
    const lineCount = lines.get(finding.path);
    if (lineCount === undefined) return FINDING_PATH_DETAIL;
    if (finding.lineEnd > lineCount) return FINDING_RANGE_DETAIL;
  }
  return null;
}

/**
 * Fold the awaited close outcome into a review outcome. A clean/findings
 * disposition is only valid after a settled, uncorrupted close; an unavailable
 * disposition is preserved as correlated failed evidence.
 */
export function finalizeReviewCompletion(
  outcome: PortResultV1<StructuredReviewOutcomeV1>,
  close: StructuredReviewCloseV1,
): PortResultV1<StructuredReviewOutcomeV1> {
  if (!outcome.ok) return outcome;
  const status = outcome.value.status;
  if (status !== "clean" && status !== "findings") return outcome;
  if (close.settled && close.failure === null && !close.timedOut) {
    return outcome;
  }
  return portError("unavailable", CLOSE_INVALIDATED_DETAIL);
}
