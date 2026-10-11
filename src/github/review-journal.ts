/**
 * Strict structured review-result and review-journal codec.
 *
 * The review journal is the durable operation record kept in the body of an
 * authenticated pending GitHub review: a deterministic human-readable
 * rendering plus hidden canonical metadata. One renderer/parser pair owns the
 * format; consumers never fall back to prose-as-clean and never truncate.
 *
 * Fail-closed rules shared by every parser here:
 *
 * - The strict result is exactly `{verdict, summary, findings}` with the exact
 *   keys (unknown fields are rejected), finite bounded text, bounded finding
 *   count, exact priority range and valid line ranges. `clean` requires an
 *   empty finding list, `findings` requires a non-empty one and `unavailable`
 *   also requires an empty one — a result can never smuggle partially
 *   accepted findings.
 * - Every text field has a hard bound (summary 4096 chars, finding combined
 *   title+body+location message 8192 chars, path 512 chars); a contract-bound
 *   overflow is an `unavailable` disposition (issue code `bound_exceeded`),
 *   never a truncation and never a partial clean.
 * - Paths are relative: no absolute paths, no drive letters, no backslashes,
 *   no `.`/`..` segments and no control characters.
 * - The journal metadata is canonical JSON (via `canonicalStringify`) encoded
 *   in standard base64 and hidden in a fixed HTML comment. Because base64
 *   contains no `<`, `>` or `-` and the human rendering HTML-escapes `&`,
 *   `<` and `>` of the untrusted text, human body text can never terminate or
 *   forge the metadata region. The JSON text parser rejects duplicate object
 *   keys (never silently keeping a last value) while accepting any key order
 *   and whitespace.
 * - `parseReviewJournalBody` consumes the full expected body: byte-bound,
 *   strict metadata, result-digest verification over the canonical structured
 *   result and exact byte equality with re-rendering. Any added, ignored,
 *   altered or reordered text fails.
 * - All errors are static sanitized messages; no unknown body text, URL,
 *   header or token value is ever echoed.
 *
 * Phase shapes (common identity fields at the top level):
 * - intent: identity only (no review id, no execution).
 * - running: identity + positive reviewId + execution
 *   (ownerRunId/invocationId/threadId/submittedProvider/model/reasoning/
 *   startMayOccur=true; no turn id yet — a turn is never invented).
 * - ready: identity + positive reviewId + completedAt + result + resultDigest
 *   + execution, where execution is either null (only for verdict
 *   `unavailable`, so no runtime completion is ever fabricated) or the
 *   running fields plus turnId/resultId/actual request-runtime receipt.
 *   `clean`/`findings` require a non-null execution with runtime terminal
 *   origin, completed observed terminal status and matching IDs.
 */

import {
  expectCanonicalBase64,
  fail,
  RecordParseError,
} from "../contracts/validation.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import {
  METADATA_MARKER,
  METADATA_TERMINATOR,
  parseReviewJournalMetadata,
  type ReviewJournalV1,
} from "./journal-metadata.ts";
import { utf8Length } from "./journal-text.ts";
import { MAX_JOURNAL_BYTES } from "./review-result-contracts.ts";
import { findingLocation } from "./review-result-parser.ts";

/**
 * Deterministic render of the full journal body: hidden canonical metadata
 * (base64-encoded canonical JSON in a fixed HTML comment, immune to `--` and
 * `-->` in any text) followed by the escaped human-readable section. Throws
 * `RecordParseError` with `bound_exceeded` when the rendered body exceeds
 * `MAX_JOURNAL_BYTES` — the producer maps that to `unavailable`, never a
 * partial body.
 */
export function renderReviewJournalBody(journal: ReviewJournalV1): string {
  const metadata = encodeJournalMetadata(journal);
  const human = renderHumanSection(journal);
  const body =
    `${METADATA_MARKER}\n${metadata}\n${METADATA_TERMINATOR}\n\n${human}`;
  if (utf8Length(body) > MAX_JOURNAL_BYTES) {
    fail(
      "$",
      "bound_exceeded",
      `rendered journal exceeds ${MAX_JOURNAL_BYTES} bytes`,
    );
  }
  return body;
}

/**
 * Parse the full journal body. Verifies the byte bound, the strict complete
 * metadata (duplicate-key-rejecting canonical JSON), the result digest and
 * exact byte equality with re-rendering. Throws `RecordParseError`;
 * `bound_exceeded` is the unavailable disposition, every other issue is
 * invalid evidence.
 */
export async function parseReviewJournalBody(
  body: string,
): Promise<ReviewJournalV1> {
  if (utf8Length(body) > MAX_JOURNAL_BYTES) {
    fail(
      "$",
      "bound_exceeded",
      `journal body exceeds ${MAX_JOURNAL_BYTES} bytes`,
    );
  }
  const metadata = extractMetadata(body);
  const journal = parseReviewJournalMetadata(metadata);
  if (journal.phase === "ready") {
    const digest = await canonicalStringifySha256(journal.result);
    if (digest !== journal.resultDigest) {
      fail("$.resultDigest", "invalid_digest", "result digest mismatch");
    }
  }
  if (renderReviewJournalBody(journal) !== body) {
    fail("$", "invalid_value", "journal body does not match its metadata");
  }
  return journal;
}

/** True when a codec failure is a contract-bound overflow (unavailable). */
export function isJournalBoundExceeded(error: unknown): boolean {
  return error instanceof RecordParseError &&
    error.issues.some((issue) => issue.code === "bound_exceeded");
}

function extractMetadata(body: string): string {
  const marker = `${METADATA_MARKER}\n`;
  if (!body.startsWith(marker)) {
    fail("$", "invalid_value", "expected journal metadata marker");
  }
  const afterMarker = body.slice(marker.length);
  const end = afterMarker.indexOf(`\n${METADATA_TERMINATOR}`);
  if (end === -1) {
    fail("$", "invalid_value", "expected journal metadata terminator");
  }
  const encoded = afterMarker.slice(0, end);
  if (encoded === "" || encoded.includes("\n")) {
    fail("$", "invalid_value", "journal metadata is malformed");
  }
  try {
    // Standard base64: only [A-Za-z0-9+/=], so the metadata region can never
    // contain an HTML comment terminator no matter what the record says.
    const canonical = expectCanonicalBase64(
      encoded,
      "$",
      4 * MAX_JOURNAL_BYTES,
    );
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(atob(canonical), (char) => char.charCodeAt(0)),
    );
    return decoded;
  } catch (error) {
    if (error instanceof RecordParseError) throw error;
    fail("$", "invalid_value", "journal metadata is malformed");
  }
}

function encodeJournalMetadata(journal: ReviewJournalV1): string {
  const json = canonicalStringify(journal);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function renderHumanSection(journal: ReviewJournalV1): string {
  if (journal.phase === "intent") {
    return [
      "# Model review intent",
      "",
      `A code review is requested for pull request ${journal.prNumber} by ${
        escapeHuman(journal.publisher)
      }.`,
      "",
    ].join("\n");
  }
  if (journal.phase === "running") {
    return [
      "# Model review in progress",
      "",
      `Review ${journal.reviewId} is running for pull request ${journal.prNumber} by ${
        escapeHuman(journal.publisher)
      }.`,
      "",
    ].join("\n");
  }
  const lines: string[] = [
    `# Model review: ${journal.result.verdict}`,
    "",
    "Summary:",
    escapeHuman(journal.result.summary),
    "",
  ];
  const acceptance = journal.result.taskAcceptance ?? null;
  if (acceptance !== null) {
    lines.push(
      `Task acceptance (issue #${acceptance.issueNumber}): ${acceptance.verdict}`,
      `Task digest: ${acceptance.taskDigest}`,
      ...acceptance.evidence.map((item) => `- ${escapeHuman(item)}`),
      "",
    );
  }
  if (journal.result.verdict === "findings") {
    lines.push(`Findings (${journal.result.findings.length}):`, "");
    for (const finding of journal.result.findings) {
      lines.push(`- [P${finding.priority}] ${escapeHuman(finding.title)}`);
      for (const line of finding.body.split("\n")) {
        lines.push(`  ${escapeHuman(line)}`);
      }
      lines.push(
        `  ${escapeHuman(findingLocation(finding))}`,
        "",
      );
    }
  }
  return lines.join("\n");
}

/**
 * Deterministic escaping of untrusted text for the human section. `&` is
 * escaped first; the result can never form `<`, `-->` or any raw comment
 * delimiter, and the same function is applied on every render, so the parser
 * round-trip is exact.
 */
function escapeHuman(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
    ">",
    "&gt;",
  );
}
export { MAX_RESULT_SUMMARY } from "./review-result-contracts.ts";
export { MAX_FINDING_TITLE } from "./review-result-contracts.ts";
export { MAX_FINDING_BODY } from "./review-result-contracts.ts";
export { MAX_FINDING_PATH } from "./review-result-contracts.ts";
export { MAX_FINDING_MESSAGE } from "./review-result-contracts.ts";
export { MAX_FINDINGS } from "./review-result-contracts.ts";
export { MAX_JOURNAL_BYTES } from "./review-result-contracts.ts";
export { REVIEW_MODEL } from "./review-result-contracts.ts";
export { REVIEW_REASONING } from "./review-result-contracts.ts";
export type { ReviewVerdictV1 } from "./review-result-contracts.ts";
export type { FindingPriorityV1 } from "./review-result-contracts.ts";
export type { ReviewFindingV1 } from "./review-result-contracts.ts";
export type { ReviewResultV1 } from "./review-result-contracts.ts";
export { REVIEW_RESULT_OUTPUT_SCHEMA } from "./review-result-contracts.ts";
export { findingLocation } from "./review-result-parser.ts";
export { findingMessage } from "./review-result-parser.ts";
export { parseReviewResultV1 } from "./review-result-parser.ts";
export { parseReviewResultJson } from "./review-result-parser.ts";
export { reviewResultDigest } from "./review-result-parser.ts";
export type { ReviewResultRejectionCategoryV1 } from "./review-result-parser.ts";
export { classifyReviewResultRejection } from "./review-result-parser.ts";
export type { ReviewJournalPhaseV1 } from "./journal-metadata.ts";
export type { ReviewJournalRepositoryV1 } from "./journal-metadata.ts";
export type { ReviewJournalExecutionV1 } from "./journal-metadata.ts";
export type { ReviewJournalRuntimeActualV1 } from "./journal-metadata.ts";
export type { ReviewJournalReadyExecutionV1 } from "./journal-metadata.ts";
export type { ReviewJournalIntentV1 } from "./journal-metadata.ts";
export type { ReviewJournalRunningV1 } from "./journal-metadata.ts";
export type { ReviewJournalReadyV1 } from "./journal-metadata.ts";
export type { ReviewJournalV1 } from "./journal-metadata.ts";
export { parseReviewJournalMetadata } from "./journal-metadata.ts";
