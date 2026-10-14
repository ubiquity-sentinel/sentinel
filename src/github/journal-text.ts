// journal text.

import { expectString, fail, MaxText } from "../contracts/validation.ts";
import { MAX_FINDING_PATH } from "./review-result-contracts.ts";

// ---------------------------------------------------------------------------
// Shared text primitives
// ---------------------------------------------------------------------------

export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Human text (summary/body): control chars rejected except tab/newline. */
export function expectHumanText(
  value: unknown,
  path: string,
  max: number,
): string {
  return expectMultilineText(value, path, max);
}

export function expectMultilineText(
  value: unknown,
  path: string,
  max: number,
): string {
  const text = expectString(value, path, max);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7F) {
      if (code !== 0x09 && code !== 0x0A) {
        fail(path, "invalid_pattern", "control character in text");
      }
    }
  }
  return text;
}

/** Single-line text (title, ids): no control characters at all. */
export function expectSingleLineText(
  value: unknown,
  path: string,
  max: number,
): string {
  const text = expectString(value, path, max);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7F) {
      fail(path, "invalid_pattern", "control character in text");
    }
  }
  return text;
}

export function expectBoundedId(
  value: unknown,
  path: string,
  max: number,
): string {
  const text = expectSingleLineText(value, path, max);
  if (text.length === 0) {
    fail(path, "invalid_pattern", "expected non-empty string");
  }
  return text;
}

/**
 * Bounded model-id text: nonempty, no control characters, within the shared
 * token bound and with no leading/trailing whitespace. The trusted configured
 * identity is preserved verbatim; whitespace is never silently trimmed.
 */
export function expectModelId(value: unknown, path: string): string {
  const text = expectBoundedId(value, path, MaxText.token);
  if (text.trim() !== text) {
    fail(path, "invalid_pattern", "expected a trimmed model id");
  }
  return text;
}

export function parseReviewPath(value: unknown, path: string): string {
  const text = expectSingleLineText(value, path, MAX_FINDING_PATH);
  if (text.length === 0) {
    fail(path, "invalid_pattern", "expected a non-empty relative path");
  }
  if (text.startsWith("/")) {
    fail(path, "invalid_pattern", "expected a relative path");
  }
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    fail(path, "invalid_pattern", "expected a relative path");
  }
  if (text.includes("\\")) {
    fail(path, "invalid_pattern", "expected a relative path");
  }
  for (const segment of text.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      fail(
        path,
        "invalid_pattern",
        "expected a path without traversal segments",
      );
    }
  }
  return text;
}
