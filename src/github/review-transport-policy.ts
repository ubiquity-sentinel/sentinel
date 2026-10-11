// review transport policy.

import {
  MAX_REVIEW_TOTAL_MS,
  type PreparedStructuredReviewV1,
  type StructuredReviewCloseV1,
} from "./codex-reviewer.ts";
import type { GitHubReviewWireV1 } from "./wire.ts";
import type { ReviewJournalV1 } from "./review-journal.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { ReviewTaskStatementV1 } from "../contracts/review-receipt.ts";

/** The single finite review bound used for a submission that must fit. */
export const REVIEW_TRANSPORT_TOTAL_MS = MAX_REVIEW_TOTAL_MS;

/** Static sanitized details; never an echoed value or raw error. */
export const DETAIL_INPUT =
  "review transport: invalid submission identity or deadline";

export const DETAIL_PUBLISHER =
  "review transport: submission publisher is not the trusted publisher";

export const DETAIL_DRAIN = "review transport: review submissions are closed";

export const DETAIL_OVERLAP =
  "review transport: an owned review operation is already active";

export const DETAIL_CAPACITY =
  "review transport: active review capacity is exhausted";

export const DETAIL_SNAPSHOT =
  "review transport: the immutable review snapshot is unavailable";

export const DETAIL_RECONCILE =
  "review transport: remote review reconciliation is unavailable or conflicting";

export const DETAIL_CREATE =
  "review transport: pending review creation was not reconciled";

export const DETAIL_READBACK =
  "review transport: exact review readback did not match the durable journal";

export const DETAIL_PREPARE =
  "review transport: structured review preparation failed";

export const DETAIL_RUNNING =
  "review transport: the running journal could not be durably persisted";

export const DETAIL_START =
  "review transport: the single review start was rejected";

export const DETAIL_PUBLISH =
  "review transport: the ready journal could not be published";

export const DETAIL_FAILURE =
  "review transport: review operation state is unavailable";

export const DETAIL_READ = "review transport: review read failed";

export const DETAIL_TASK =
  "review transport: the task statement is malformed or its digest does not bind its text";

/** Static sanitized summary of a standing unavailable disposition. */
export const UNAVAILABLE_SUMMARY =
  "structured review unavailable: the review did not produce a validated result";

/** Static reason persisted when a validated result cannot fit the journal. */
export const DETAIL_RESULT_BOUND =
  "structured review unavailable: the validated result exceeded the durable journal bound";

/**
 * Hard bound of one persisted no-verdict reason. Every accepted reason is a
 * short single-line printable-ASCII static review detail; anything else (raw
 * error text, provider output, a stack, a multi-line message) is refused and
 * replaced by the generic sentence, so the durable journal can never carry
 * unfiltered content.
 */
export const MAX_UNAVAILABLE_REASON_CHARS = 256;

/** Persisted summary of one no-verdict disposition; never raw content. */
export function staticUnavailableSummary(reason: unknown): string {
  if (typeof reason !== "string") return UNAVAILABLE_SUMMARY;
  if (reason.length === 0 || reason.length > MAX_UNAVAILABLE_REASON_CHARS) {
    return UNAVAILABLE_SUMMARY;
  }
  if (!/^[\x20-\x7e]+$/.test(reason)) return UNAVAILABLE_SUMMARY;
  return reason;
}

/** Exactly-one binding of one publisher record during reconciliation. */
export type BoundRecordV1 =
  | { kind: "one"; review: GitHubReviewWireV1; journal: ReviewJournalV1 }
  | { kind: "none" }
  | { kind: "conflict" };

export type OperationPhaseV1 =
  | "intent"
  | "running"
  | "ready"
  | "published"
  | "failed";

export interface OwnedReviewV1 {
  operationKey: string;
  requestId: string;
  prNumber: number;
  expectedHead: GitSha;
  expectedBase: GitSha;
  requestedAt: number;
  latestStartAt: number;
  settleBy: number;
  /**
   * Exact task statement this submission was validated with, or null. It is
   * passed to the producer and never persisted in the journal; the producer's
   * result must be bound to it.
   */
  task: ReviewTaskStatementV1 | null;
  phase: OperationPhaseV1;
  reviewId: number | null;
  /** True once any journal body was durably created on the remote. */
  remoteJournal: boolean;
  prepared: PreparedStructuredReviewV1 | null;
  /** The single owned close attempt; reused so close is never duplicated. */
  closePromise: Promise<StructuredReviewCloseV1> | null;
  /** In-flight submission/publication work; retained for drain, never lost. */
  submission: Promise<void> | null;
  /** False until the retained submission promise itself has settled. */
  submissionSettled: boolean;
  running: Promise<void> | null;
  /** False until the retained owned-completion promise itself has settled. */
  runningSettled: boolean;
  done: boolean;
  processSettled: boolean;
  /** A durable ready journal (published or awaiting publication). */
  readyDurable: boolean;
  fault: string | null;
}

/**
 * An owned operation is active while its admission/journal work is pending OR
 * while a retained prepared handle has not been proved settled. `done` alone is
 * not settlement: a run that ended with an UNPROVED close still owns the
 * producer process, so it must block same-key replacement and still count
 * against active capacity until the close proves settlement.
 */
export function isActiveReview(op: OwnedReviewV1): boolean {
  if (!op.done) return true;
  return op.prepared !== null && !op.processSettled;
}

/** Bounded race of an owned promise against an absolute instant. */
export async function waitUntil(
  promise: Promise<void>,
  deadline: number,
  now: () => number,
): Promise<"settled" | "timeout"> {
  const remaining = deadline - now();
  if (remaining <= 0) {
    // An already-expired deadline still observes already-settled owned work
    // (the settled handler is enqueued before the timeout fallback).
    return await Promise.race([
      promise.then(() => "settled" as const, () => "settled" as const),
      Promise.resolve("timeout" as const),
    ]);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => "settled" as const, () => "settled" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), remaining);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
