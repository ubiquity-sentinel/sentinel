/** Strict issue comment wire boundary; comment bodies contain one existing native payload. */
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  expectNonEmptyString,
  expectPositiveInt,
  expectRecord,
  fail,
  MaxText,
} from "../contracts/validation.ts";

export interface BaseReviewCommentV1 {
  id: number;
  body: string;
  author: string;
}

export function parseBaseReviewComment(
  input: unknown,
  issueUrl: string,
): BaseReviewCommentV1 {
  const row = expectRecord(input, "$");
  const user = expectRecord(row.user, "$.user");
  if (row.issue_url !== issueUrl) {
    fail("$.issue_url", "invalid_value", "base review comment issue mismatch");
  }
  return {
    id: expectPositiveInt(row.id, "$.id"),
    body: expectNonEmptyString(row.body, "$.body", 60_000),
    author: expectNonEmptyString(user.login, "$.user.login", MaxText.login),
  };
}

/** Canonical JSON is one physical line, so model strings cannot escape the fence. */
export function baseReviewCommentBody(payload: unknown): string {
  const body = `~~~json\n${canonicalStringify(payload)}\n~~~`;
  // The owner forbids posting the hosted GitHub app trigger, even in evidence.
  if (/@codex\s+review/i.test(body)) {
    throw new Error("base review evidence contains a forbidden app trigger");
  }
  if (new TextEncoder().encode(body).length > 60_000) {
    throw new Error("base review payload exceeds bound");
  }
  return body;
}

export function baseReviewCommentPayload(body: string): unknown {
  if (!body.startsWith("~~~json\n") || !body.endsWith("\n~~~")) {
    throw new Error("base review payload unavailable");
  }
  const value: unknown = JSON.parse(body.slice(8, -4));
  if (baseReviewCommentBody(value) !== body) {
    throw new Error("base review payload changed");
  }
  return value;
}
