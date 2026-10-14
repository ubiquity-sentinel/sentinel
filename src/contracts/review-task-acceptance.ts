import { canonicalStringifySha256 } from "./canonical.ts";
import {
  expectArray,
  expectEnum,
  expectExactKeys,
  expectNonEmptyString,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  fail,
  MaxText,
} from "./validation.ts";

/**
 * Bounded exact task statement an independent review is judged against: the
 * live source issue the candidate must fulfill. The digest is a canonical
 * SHA-256 over `{issueNumber, title, body}` and binds the review acceptance to
 * this exact text; it never carries credentials or host paths.
 */
export interface ReviewTaskStatementV1 {
  issueNumber: number;
  title: string;
  body: string;
  /** Canonical SHA-256 over `{issueNumber, title, body}`. */
  digest: string;
}

/** Canonical digest binding one exact task statement. */
export function reviewTaskStatementDigest(
  task: { issueNumber: number; title: string; body: string },
): Promise<string> {
  return canonicalStringifySha256({
    issueNumber: task.issueNumber,
    title: task.title,
    body: task.body,
  });
}

/** One source-issue task title bound (chars). */
export const MAX_REVIEW_TASK_TITLE = MaxText.message;
/** One source-issue task body bound (chars). */
export const MAX_REVIEW_TASK_BODY = MaxText.body;
/** Static sanitized refusal of a malformed/over-bound task statement. */
export const REVIEW_TASK_SHAPE_DETAIL =
  "review task statement is malformed or over bound";
/** Static sanitized refusal of a task statement whose digest does not bind it. */
export const REVIEW_TASK_DIGEST_DETAIL =
  "review task statement digest does not bind its text";

export type ReviewTaskStatementCheckV1 =
  | { ok: true; statement: ReviewTaskStatementV1 }
  | { ok: false; detail: string };

/** True only for text without NUL/other C0 controls (tab and LF allowed). */
export function isBoundedTaskText(
  value: unknown,
  maxLength: number,
): value is string {
  if (typeof value !== "string" || value.length > maxLength) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a) continue;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/**
 * Strict bounded check of one submitted task statement, including the digest
 * binding: the caller-supplied digest must equal the canonical digest of the
 * exact text, so a receipt can never be bound to a digest that does not
 * describe the task the reviewer was shown.
 */
export async function checkReviewTaskStatement(
  input: unknown,
): Promise<ReviewTaskStatementCheckV1> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, detail: REVIEW_TASK_SHAPE_DETAIL };
  }
  const record = input as Record<string, unknown>;
  const issueNumber = record.issueNumber;
  if (
    typeof issueNumber !== "number" || !Number.isSafeInteger(issueNumber) ||
    issueNumber < 1
  ) {
    return { ok: false, detail: REVIEW_TASK_SHAPE_DETAIL };
  }
  const title = record.title;
  if (
    !isBoundedTaskText(title, MAX_REVIEW_TASK_TITLE) || title.length === 0
  ) {
    return { ok: false, detail: REVIEW_TASK_SHAPE_DETAIL };
  }
  const body = record.body;
  if (!isBoundedTaskText(body, MAX_REVIEW_TASK_BODY)) {
    return { ok: false, detail: REVIEW_TASK_SHAPE_DETAIL };
  }
  const digest = record.digest;
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
    return { ok: false, detail: REVIEW_TASK_SHAPE_DETAIL };
  }
  const expected = await reviewTaskStatementDigest({
    issueNumber,
    title,
    body,
  });
  if (expected !== digest) {
    return { ok: false, detail: REVIEW_TASK_DIGEST_DETAIL };
  }
  return { ok: true, statement: { issueNumber, title, body, digest } };
}

/**
 * Static, sanitized semantic-refusal details shared by every authorization
 * surface (repair merge gate, GitHub adapter, hosted copies). Each one is a
 * terminal no-delivery disposition: the candidate is never merged, released or
 * closed as a new repair, and no task or model text is ever echoed.
 */
export const TASK_ACCEPTANCE_MISSING_DETAIL =
  "task acceptance missing: a change-only review cannot authorize delivery";
export const TASK_ACCEPTANCE_MISMATCH_DETAIL =
  "task acceptance is bound to a different source issue";
export const TASK_ACCEPTANCE_DIGEST_DETAIL =
  "task acceptance is not bound to the current source-issue text";
export const TASK_ACCEPTANCE_CONTEXT_DETAIL =
  "source issue task context is unavailable";
export const TASK_ACCEPTANCE_UNBOUND_DETAIL =
  "task acceptance present for work without a source issue";
export const TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL =
  "task already satisfied at base: no new repair is delivered";
export const TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL =
  "task acceptance not fulfilled: the candidate does not satisfy the source issue";
export const TASK_ACCEPTANCE_UNCERTAIN_DETAIL =
  "task acceptance uncertain: insufficient evidence for the source issue";

/**
 * The one semantic acceptance predicate shared by every authorization surface.
 *
 * `task` is the TRUSTED statement independently read from the live source
 * issue at authorization time (never the model's echoed digest and never
 * equality between two copied receipts), or the literal `"unavailable"` when
 * that context could not be read or bounded. Returns null only for a positive,
 * exactly bound `fulfilled` acceptance of the record's own issue; every other
 * combination is a static refusal. Work without a source issue accepts only a
 * matching absence (no invented acceptance), so incident work keeps its
 * existing change-only contract. An absent field and an explicit null are the
 * same "no acceptance": absence is the legacy on-disk shape and is never a
 * defaulted passing acceptance.
 */
export function reviewTaskAcceptanceRefusal(input: {
  /** The record's own source issue number, or null for incident work. */
  issueNumber: number | null;
  /** Trusted live task statement, or "unavailable" when it cannot be read. */
  task: ReviewTaskStatementV1 | null | "unavailable";
  /**
   * The acceptance carried by the durable review receipt: an acceptance, an
   * explicit null, or undefined when the legacy record omitted the field.
   */
  acceptance: ReviewTaskAcceptanceV1 | null | undefined;
}): string | null {
  const { issueNumber, task, acceptance } = input;
  if (issueNumber === null) {
    const absent = acceptance === null || acceptance === undefined;
    return task === null && absent ? null : TASK_ACCEPTANCE_UNBOUND_DETAIL;
  }
  if (task === "unavailable" || task === null) {
    return TASK_ACCEPTANCE_CONTEXT_DETAIL;
  }
  if (task.issueNumber !== issueNumber) {
    return TASK_ACCEPTANCE_CONTEXT_DETAIL;
  }
  if (acceptance === null || acceptance === undefined) {
    return TASK_ACCEPTANCE_MISSING_DETAIL;
  }
  if (acceptance.issueNumber !== issueNumber) {
    return TASK_ACCEPTANCE_MISMATCH_DETAIL;
  }
  // The acceptance must bind the EXACT live source-issue text, not merely a
  // digest the reviewer copied: a same-issue/same-head receipt judged against
  // changed issue text is a different task and never authorizes this delivery.
  if (acceptance.taskDigest !== task.digest) {
    return TASK_ACCEPTANCE_DIGEST_DETAIL;
  }
  switch (acceptance.verdict) {
    case "fulfilled":
      return null;
    case "already_satisfied_at_base":
      return TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL;
    case "not_fulfilled":
      return TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL;
    case "uncertain":
      return TASK_ACCEPTANCE_UNCERTAIN_DETAIL;
  }
}

/**
 * The reviewer's positive verdict on the ORIGINAL issue acceptance. A
 * code-quality-only pass is not a task verdict: a change-only review carries
 * no acceptance at all and can never authorize delivery.
 */
export type TaskAcceptanceVerdictV1 =
  | "fulfilled"
  | "not_fulfilled"
  | "already_satisfied_at_base"
  | "uncertain";

/** One finite evidence item bound (chars). */
export const MAX_TASK_ACCEPTANCE_EVIDENCE_CHARS = 1024;
/** Finite acceptance evidence count. */
export const MAX_TASK_ACCEPTANCE_EVIDENCE = 4;

/**
 * Reviewer-generated task acceptance bound to the exact reviewed task. The
 * verdict is the reviewer's own semantic judgment; the identity fields bind it
 * to the one task statement that was submitted with this exact review.
 */
export interface ReviewTaskAcceptanceV1 {
  /** Source issue number the judgment is about. */
  issueNumber: number;
  /** Digest of the exact task statement the reviewer judged. */
  taskDigest: string;
  verdict: TaskAcceptanceVerdictV1;
  /** Concrete acceptance evidence; empty only for `uncertain`. */
  evidence: string[];
}

/** Strict bounded parse of one task acceptance carried by a review. */
export function parseReviewTaskAcceptance(
  input: unknown,
  path: string,
): ReviewTaskAcceptanceV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(
    obj,
    ["issueNumber", "taskDigest", "verdict", "evidence"],
    path,
  );
  const issueNumber = expectPositiveInt(obj.issueNumber, `${path}.issueNumber`);
  const taskDigest = expectSha256Hex(obj.taskDigest, `${path}.taskDigest`);
  const verdict = expectEnum(
    obj.verdict,
    ["fulfilled", "not_fulfilled", "already_satisfied_at_base", "uncertain"],
    `${path}.verdict`,
  );
  const evidence = expectArray(
    obj.evidence,
    `${path}.evidence`,
    MAX_TASK_ACCEPTANCE_EVIDENCE,
    (item, itemPath) =>
      expectNonEmptyString(
        item,
        itemPath,
        MAX_TASK_ACCEPTANCE_EVIDENCE_CHARS,
      ),
  );
  // A non-uncertain verdict claims a concrete judgment; an empty evidence list
  // would make that claim unverifiable, so it is refused.
  if (verdict !== "uncertain" && evidence.length === 0) {
    fail(
      `${path}.evidence`,
      "invalid_lifecycle",
      "a definitive task acceptance requires at least one evidence item",
    );
  }
  return { issueNumber, taskDigest, verdict, evidence };
}
