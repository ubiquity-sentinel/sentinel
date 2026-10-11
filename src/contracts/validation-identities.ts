import { isGitSha } from "./brands.ts";
import type { CommandId, GitSha, Version1 } from "./brands.ts";
import {
  describeValue,
  expectPattern,
  expectString,
  fail,
  MaxText,
} from "./validation.ts";

export function expectVersion(value: unknown, path: string): Version1 {
  if (value !== "v1") {
    fail(
      path,
      "invalid_version",
      `expected version "v1", got ${describe(value)}`,
    );
  }
  return "v1";
}

export function describe(value: unknown): string {
  return describeValue(value);
}

export function expectGitSha(value: unknown, path: string): GitSha {
  if (!isGitSha(value)) {
    fail(
      path,
      "invalid_sha",
      `expected full 40-hex commit SHA, got ${describe(value)}`,
    );
  }
  return value;
}

/** 64 lowercase hex chars; the caller applies the exact digest brand. */
export function expectSha256Hex(value: unknown, path: string): string {
  const text = expectString(value, path, 64);
  if (!/^[0-9a-f]{64}$/.test(text)) {
    fail(
      path,
      "invalid_digest",
      `expected full 64-hex SHA-256 digest, got ${describe(text)}`,
    );
  }
  return text;
}

export function expectCommandId(value: unknown, path: string): CommandId {
  const text = expectPattern(
    value,
    path,
    /^[a-z][a-z0-9_]{0,63}$/,
    "invalid_pattern",
    "expected command id matching ^[a-z][a-z0-9_]{0,63}$",
    MaxText.token,
  );
  return text as CommandId;
}

/** Canonical base64: 4-char groups, standard alphabet, correct padding. */
export function expectCanonicalBase64(
  value: unknown,
  path: string,
  maxChars: number,
): string {
  const text = expectString(value, path, maxChars);
  const canonical =
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      text,
    );
  if (!canonical || text.length % 4 !== 0) {
    fail(
      path,
      "invalid_base64",
      "expected canonical base64 with standard alphabet and padding",
    );
  }
  return text;
}
