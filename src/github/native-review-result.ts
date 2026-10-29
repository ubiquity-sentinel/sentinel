/** Strict Sentinel payload carried by the actual native review exit item. */
import type { ReviewTaskStatementV1 } from "../contracts/review-receipt.ts";
import {
  expectRecord,
  expectSha256Hex,
  fail,
  RecordParseError,
} from "../contracts/validation.ts";
import {
  expectEnvelopeJson,
  refuseAsJsonSyntax,
} from "./native-review-envelope-repair.ts";
import {
  expectJournalExactKeys,
  parseReviewResultV1,
} from "./review-result-parser.ts";
import {
  MAX_JOURNAL_BYTES,
  reviewResultOutputSchema,
  type ReviewResultV1,
} from "./review-result-contracts.ts";
import type { ReviewSnapshotV1 } from "./review-snapshot.ts";

export const NATIVE_REVIEW_OPEN = "<SENTINEL_NATIVE_REVIEW_V1>";
export const NATIVE_REVIEW_CLOSE = "</SENTINEL_NATIVE_REVIEW_V1>";

export function nativeReviewBinding(
  snapshot: ReviewSnapshotV1,
  task: ReviewTaskStatementV1 | null,
): unknown {
  return {
    head: snapshot.head,
    base: snapshot.base,
    snapshotDigest: snapshot.digest,
    taskDigest: task?.digest ?? null,
  };
}

/** A request within review/start, never a normal-turn rubric or schema override. */
export function nativeReviewInstructions(
  snapshot: ReviewSnapshotV1,
  task: ReviewTaskStatementV1 | null,
  cwd: string,
): string {
  return [
    "Use native Codex review mode and its native review output format.",
    "For Sentinel's exact task acceptance, set native overall_explanation to exactly one envelope:",
    `${NATIVE_REVIEW_OPEN}{\"binding\":${
      JSON.stringify(nativeReviewBinding(snapshot, task))
    },\"result\":<RESULT>}${NATIVE_REVIEW_CLOSE}`,
    "RESULT must satisfy the following descriptive contract; it is not a protocol-enforced output schema:",
    JSON.stringify(reviewResultOutputSchema(task)),
    "Set findings to an empty array for a clean or unavailable verdict, and include at least one finding for a findings verdict.",
    "Every finding must satisfy lineStart <= lineEnd.",
    "Keep every RESULT string, and each native finding's title and body, free of double quote characters; quote code with backticks.",
    "Never repeat a finding: every finding must be distinct from every other finding.",
    "Assess taskAcceptance explicitly from the exact supplied task and committed evidence. Never infer fulfilled from a clean code review. Preserve the exact issueNumber and taskDigest; insufficient evidence is uncertain or unavailable.",
    "Mirror every result.findings entry in native findings with identical title/body, code_location.absolute_file_path under the exact checkout, and matching line_range.start/end. Native findings must be empty exactly when result.findings is empty. Do not add prose outside the envelope in overall_explanation.",
    `Exact checkout: ${JSON.stringify(cwd)}.`,
  ].join("\n");
}

/** Matches the installed native renderer, so no native finding is discarded. */
export function nativeFindingSuffix(
  result: ReviewResultV1,
  cwd: string,
): string {
  if (result.findings.length === 0) return "";
  const lines = [
    result.findings.length > 1 ? "Full review comments:" : "Review comment:",
  ];
  for (const item of result.findings) {
    lines.push(
      "",
      `- ${item.title} — ${cwd}/${item.path}:${item.lineStart}-${item.lineEnd}`,
    );
    const body = item.body.replace(/\r\n/g, "\n").split("\n");
    if (body.at(-1) === "") body.pop();
    for (const line of body) lines.push(`  ${line}`);
  }
  return "\n\n" + lines.join("\n").trim();
}

export function renderNativeReviewResult(
  result: ReviewResultV1,
  snapshot: ReviewSnapshotV1,
  task: ReviewTaskStatementV1 | null,
  cwd: string,
): string {
  return NATIVE_REVIEW_OPEN +
    JSON.stringify({ binding: nativeReviewBinding(snapshot, task), result }) +
    NATIVE_REVIEW_CLOSE + nativeFindingSuffix(result, cwd);
}

export function parseNativeReviewResult(
  text: string,
  snapshot: ReviewSnapshotV1,
  task: ReviewTaskStatementV1 | null,
  cwd: string,
): ReviewResultV1 {
  if (new TextEncoder().encode(text).length > MAX_JOURNAL_BYTES) {
    fail("$", "bound_exceeded", "native result exceeds bound");
  }
  const end = text.indexOf(NATIVE_REVIEW_CLOSE);
  if (
    !text.startsWith(NATIVE_REVIEW_OPEN) || end < 0 ||
    text.indexOf(NATIVE_REVIEW_OPEN, NATIVE_REVIEW_OPEN.length) >= 0 ||
    text.indexOf(NATIVE_REVIEW_CLOSE, end + NATIVE_REVIEW_CLOSE.length) >= 0
  ) fail("$", "invalid_value", "native result envelope unavailable");
  const parsed = expectEnvelopeJson(
    text.slice(NATIVE_REVIEW_OPEN.length, end),
    "$",
  );
  try {
    return checkNativeEnvelope(parsed.value, text, end, snapshot, task, cwd);
  } catch (error) {
    if (
      parsed.recovered && error instanceof RecordParseError &&
      error.issues[0]?.code !== "bound_exceeded"
    ) refuseAsJsonSyntax("$");
    throw error;
  }
}

function checkNativeEnvelope(
  value: unknown,
  text: string,
  end: number,
  snapshot: ReviewSnapshotV1,
  task: ReviewTaskStatementV1 | null,
  cwd: string,
): ReviewResultV1 {
  const envelope = expectRecord(value, "$");
  expectJournalExactKeys(envelope, ["binding", "result"], "$");
  const binding = expectRecord(envelope.binding, "$.binding");
  expectJournalExactKeys(binding, [
    "head",
    "base",
    "snapshotDigest",
    "taskDigest",
  ], "$.binding");
  expectSha256Hex(binding.snapshotDigest, "$.binding.snapshotDigest");
  if (
    binding.head !== snapshot.head || binding.base !== snapshot.base ||
    binding.snapshotDigest !== snapshot.digest ||
    binding.taskDigest !== (task?.digest ?? null)
  ) fail("$.binding", "invalid_value", "native result binding mismatch");
  const result = parseReviewResultV1(envelope.result);
  if (
    text.slice(end + NATIVE_REVIEW_CLOSE.length) !==
      nativeFindingSuffix(result, cwd)
  ) {
    fail(
      "$",
      "invalid_value",
      "native findings contradict the structured result",
    );
  }
  return result;
}
