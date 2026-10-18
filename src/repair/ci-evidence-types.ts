/**
 * CI failure evidence for a CI correction cell (generation 81).
 *
 * The trusted host collects this evidence for the failing checks of a red
 * candidate head when it prepares the correction's model cell, with a
 * read-only credential the model worker never sees. It is never persisted:
 * it is not part of the plan, the request, its digest, a receipt or state.
 * The authoritative state keeps only the short CI correction finding.
 *
 * Everything below that came from CI (names, step titles, annotations, log
 * text) is UNTRUSTED output produced by running the candidate's code; the
 * renderer fences it and the model may use it only as a description of the
 * failure. Only the reason codes and the classification labels are trusted,
 * fixed vocabulary computed by the host.
 */
import type { GitSha } from "../contracts/brands.ts";

/** Closed reason codes for evidence the host could not collect. */
export const CI_EVIDENCE_REASONS = [
  "forbidden_actions_read",
  "forbidden",
  "expired",
  "not_found",
  "rate_limited",
  "timeout",
  "oversize",
  "untrusted_redirect",
  "no_time",
  "malformed",
  "head_mismatch",
  "request_bound",
  "no_failing_checks",
  "unavailable",
] as const;
export type CiEvidenceReasonV1 = typeof CI_EVIDENCE_REASONS[number];

/** Fixed explanation per reason, in trusted vocabulary only. */
export const CI_EVIDENCE_REASON_TEXT: Readonly<
  Record<CiEvidenceReasonV1, string>
> = {
  forbidden_actions_read:
    "the host credential cannot read this repository's Actions jobs and logs",
  forbidden: "the host credential cannot read this check",
  expired: "the job log is no longer retained",
  not_found: "the check, job or log was not found",
  rate_limited: "GitHub rate limited the evidence read",
  timeout: "the evidence read ran out of its bounded time",
  oversize: "the job log exceeds the bounded read",
  untrusted_redirect: "the job log redirect was not a trusted log host",
  no_time: "the cell had no spare time before its model start",
  malformed: "GitHub returned an unexpected response shape",
  head_mismatch: "the job does not belong to the candidate head",
  request_bound: "the evidence read reached its request bound",
  no_failing_checks: "no failing check is currently reported for the head",
  unavailable: "the evidence read failed",
};

/** Trusted advisory label; it never changes correction or round policy. */
export type CiCheckClassificationV1 = "candidate" | "likely_infrastructure";

export interface CiFailingStepV1 {
  number: number;
  name: string;
  conclusion: string;
}

export interface CiAnnotationV1 {
  path: string;
  startLine: number | null;
  endLine: number | null;
  level: string;
  title: string;
  message: string;
}

export interface CiCheckEvidenceV1 {
  /** Check name as GitHub reports it (untrusted, sanitized). */
  name: string;
  conclusion: string;
  /** Producing app slug (`github-actions`), or null for a commit status. */
  app: string | null;
  workflow: { name: string; path: string | null } | null;
  job: { id: number; name: string } | null;
  failingSteps: CiFailingStepV1[];
  classification: CiCheckClassificationV1;
  /** Fixed trusted vocabulary (`classify` in ci-evidence-classify.ts). */
  classificationReason: string;
  annotations: CiAnnotationV1[];
  /** Sanitized bounded log excerpt of the failing step(s), if any. */
  excerpt: string | null;
  excerptLines: { kept: number; total: number } | null;
  /** Optional structured summaries derived from the excerpt (untrusted). */
  hints: string[];
  /** Non-Actions check output (title, summary, text), sanitized and bounded. */
  output: { title: string; summary: string; text: string } | null;
  /** Why part of this check's evidence (usually its log) is missing. */
  unavailable: CiEvidenceReasonV1 | null;
  /** The log was larger than the scan bound; only its head and tail were read. */
  truncatedScan: boolean;
}

export interface CiEvidenceV1 {
  head: GitSha;
  base: GitSha;
  checks: CiCheckEvidenceV1[];
  /** Failing checks beyond `MAX_CI_EVIDENCE_CHECKS`. */
  omittedChecks: number;
  /** Why the collection as a whole stopped or found nothing, if it did. */
  unavailable: CiEvidenceReasonV1 | null;
}

export interface CiEvidenceReadInputV1 {
  head: GitSha;
  base: GitSha;
  /** Whole-collection bound; every request and log read shares it. */
  deadlineMs: number;
  /** Checks the trusted finding names first (by trusted check name). */
  prefer?: (name: string) => boolean;
}

/** Read-only, never-throwing collector of one head's failure evidence. */
export interface CiEvidenceReaderV1 {
  readCiFailureEvidence(input: CiEvidenceReadInputV1): Promise<CiEvidenceV1>;
}

export function emptyCiEvidence(
  head: GitSha,
  base: GitSha,
  unavailable: CiEvidenceReasonV1 | null,
): CiEvidenceV1 {
  return { head, base, checks: [], omittedChecks: 0, unavailable };
}

// ---------------------------------------------------------------------------
// Budgets. The model prompt is capped at 32,000 characters without evidence
// (`MAX_PROMPT_CHARS`); the evidence section adds at most
// `MAX_CI_EVIDENCE_PROMPT_CHARS` (model-port-policy.ts), about 8-10K tokens.
// Measured on the 39 live red ai.ubq.fi heads of 2026-10-17 23:00Z: a 16,
// 8 or 4 KiB share per check keeps every true error line (2 KiB loses 2 of
// 139). A failing step that fits its share is kept whole (the small ones,
// 430-550 characters); a larger one fills it with the context nearest its
// markers, then its start and end (the 1.9 MB logs: about 15,000-15,500
// characters of a 16 KiB share). The longest real error line is 228
// characters.
// ---------------------------------------------------------------------------

/** Total fenced evidence characters per correction (two full-share checks). */
export const MAX_CI_EVIDENCE_CHARS = 32 * 1024;
/** Per-check share bounds: `MAX_CI_EVIDENCE_CHARS / checks`, clamped. */
export const MIN_CI_CHECK_SHARE_CHARS = 4 * 1024;
export const MAX_CI_CHECK_SHARE_CHARS = 16 * 1024;
/** Per-line cap after sanitizing (real error lines reach 228 characters). */
export const MAX_CI_EVIDENCE_LINE_CHARS = 400;
/** Raw line pre-cap applied before any pattern runs. */
export const MAX_CI_RAW_LINE_CHARS = 8 * 1024;
/** Failing checks named per correction (same as the finding's bound). */
export const MAX_CI_EVIDENCE_CHECKS = 8;
/** Failing Actions checks whose logs are read. */
export const MAX_CI_LOG_CHECKS = 4;
/** Annotations kept per check (failures first). */
export const MAX_CI_ANNOTATIONS = 10;
/** Non-Actions check output characters (title, summary and text). */
export const MAX_CI_OUTPUT_CHARS = 8 * 1024;
/** Structured hints per check and characters per hint. */
export const MAX_CI_HINTS = 12;
export const MAX_CI_HINT_CHARS = 200;
/** Failing steps named per check. */
export const MAX_CI_FAILING_STEPS = 3;
/** Ranged log read chunk (below the 8 MiB transport body bound). */
export const CI_LOG_CHUNK_BYTES = 4 * 1024 * 1024;
/** Log bytes scanned from the start before jumping to the tail. */
export const MAX_CI_LOG_SCAN_BYTES = 32 * 1024 * 1024;
/** Tail read of a log larger than the scan bound. */
export const CI_LOG_TAIL_BYTES = 256 * 1024;
/** Longest collection, and the start margin it always leaves unused. */
export const MAX_CI_EVIDENCE_COLLECTION_MS = 60_000;
export const CI_EVIDENCE_START_GUARD_MS = 60_000;
/** Shortest window worth starting a collection in. */
export const MIN_CI_EVIDENCE_COLLECTION_MS = 5_000;
/** GitHub API and signed-log requests per correction. */
export const MAX_CI_EVIDENCE_REQUESTS = 64;

/** Characters one check's block may use when `checks` checks are rendered. */
export function ciCheckShareChars(checks: number): number {
  const count = Math.max(1, Math.floor(checks));
  return Math.min(
    MAX_CI_CHECK_SHARE_CHARS,
    Math.max(
      MIN_CI_CHECK_SHARE_CHARS,
      Math.floor(MAX_CI_EVIDENCE_CHARS / count),
    ),
  );
}
