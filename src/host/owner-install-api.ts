import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_TEST_LOCAL_CHECK,
} from "./owner-install-pins.ts";
import type {
  OwnerDevelopmentInstallApiResponseV1,
} from "./owner-install-types.ts";

export const API_BASE = "https://api.github.com";
export const REQUEST_TIMEOUT_MS = 30_000;
export const RESPONSE_LIMIT_BYTES = 1_048_576;
export const MAX_COMMIT_MESSAGE_CHARS = 8_192;
export const NONCE_BYTES = 32;

export const STATIC_PLAN = "owner development install plan is invalid";
export const STATIC_API = "owner development install GitHub request failed";
export const STATIC_WRITE = "owner development install write was not confirmed";

export async function ownerMatrixMetadataList(
  token: string,
  path: string,
  key: "jobs" | "artifacts" | "workflow_runs",
): Promise<Record<string, unknown>[] | null> {
  const rows: Record<string, unknown>[] = [];
  let total: number | null = null;
  for (let page = 1; page <= 20; page++) {
    const response = await ownerDevelopmentInstallApi(
      token,
      "GET",
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    if (
      !response.ok || response.value.status !== 200 ||
      !isRecord(response.value.value)
    ) return null;
    const value = response.value.value;
    if (
      !Number.isSafeInteger(value.total_count) ||
      (value.total_count as number) < 0 || !Array.isArray(value[key]) ||
      (total !== null && total !== value.total_count)
    ) return null;
    total = value.total_count as number;
    const batch = value[key] as unknown[];
    if (
      batch.length > 100 ||
      batch.some((row) =>
        !isRecord(row) || !Number.isSafeInteger(row.id) ||
        (row.id as number) <= 0
      )
    ) return null;
    rows.push(...batch as Record<string, unknown>[]);
    if (
      new Set(rows.map((row) => row.id)).size !== rows.length ||
      rows.length > total
    ) return null;
    if (rows.length === total) return rows;
    if (batch.length !== 100) return null;
  }
  return null;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One bounded authenticated GitHub request. The fixed deadline stays armed
 * through the complete body read, the body is limited by BYTE count, and only
 * a fully read in-budget JSON body is parsed. No response text, status detail
 * or exception message ever leaves this function.
 */
export async function ownerDevelopmentInstallApi(
  token: string,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<PortResultV1<OwnerDevelopmentInstallApiResponseV1>> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "sentinel-owner-development-install",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? null : JSON.stringify(body),
    });
  } catch {
    return portError("unavailable", STATIC_API);
  }
  const text = await readBoundedResponse(response);
  if (!text.ok) return text;
  let value: unknown = null;
  if (text.value.length > 0) {
    try {
      value = JSON.parse(text.value);
    } catch {
      return portError("invalid", STATIC_API);
    }
  }
  return portOk({ status: response.status, value });
}

export async function readBoundedResponse(
  response: Response,
): Promise<PortResultV1<string>> {
  if (response.body === null) return portOk("");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let readBytes = 0;
  let overflowed = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      readBytes += chunk.value.byteLength;
      if (readBytes > RESPONSE_LIMIT_BYTES) {
        overflowed = true;
        break;
      }
      chunks.push(chunk.value);
    }
  } catch {
    return portError("unavailable", STATIC_API);
  } finally {
    if (overflowed) {
      try {
        await reader.cancel();
      } catch {
        // Best-effort stream stop; the static failure below is unaffected.
      }
    }
  }
  if (overflowed) return portError("invalid", STATIC_API);
  const bytes = new Uint8Array(readBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return portOk(new TextDecoder().decode(bytes));
}

export function requireStatus(
  response: OwnerDevelopmentInstallApiResponseV1,
  expected: number,
): PortResultV1<unknown> {
  if (response.status === expected) return portOk(response.value);
  if (response.status === 404) return portError("not_found", STATIC_API);
  if (response.status === 401 || response.status === 403) {
    return portError("auth_failed", STATIC_API);
  }
  if (response.status === 409 || response.status === 422) {
    return portError("conflict", STATIC_API);
  }
  return portError("unavailable", STATIC_API);
}

/**
 * Strict positive compare parse mirroring the hosted revision verifier: the
 * requested revision must be the compare base and merge base, and only
 * `ahead`/`identical` counters prove ancestry of the current development ref.
 */
export function compareConfirmsAncestor(
  value: unknown,
  revision: GitSha,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const base = readNestedSha(obj, "base_commit");
  const merge = readNestedSha(obj, "merge_base_commit");
  const ahead = readCountField(obj, "ahead_by");
  const behind = readCountField(obj, "behind_by");
  const total = readCountField(obj, "total_commits");
  if (base !== revision || merge !== revision) return false;
  if (ahead === null || behind === null || total === null) return false;
  if (total !== ahead + behind) return false;
  if (obj.status === "identical") return ahead === 0 && behind === 0;
  if (obj.status === "ahead") return ahead > 0 && behind === 0;
  return false;
}

/**
 * Strict one-page check listing: a truncated listing is never a successful
 * verification, and the check must bind the exact head, be completed and have
 * concluded success.
 */
export function testLocalCheckSucceeded(
  value: unknown,
  revision: GitSha,
): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  const runs = obj.check_runs;
  const total = readCountField(obj, "total_count");
  if (total === null || !Array.isArray(runs) || total !== runs.length) {
    return false;
  }
  return runs.some((run) => {
    if (typeof run !== "object" || run === null) return false;
    const item = run as Record<string, unknown>;
    return item.name === OWNER_DEVELOPMENT_INSTALL_TEST_LOCAL_CHECK &&
      item.head_sha === revision &&
      item.status === "completed" &&
      item.conclusion === "success";
  });
}

export function readShaField(value: unknown, key: string): GitSha | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return isGitSha(field) ? field : null;
}

export function readNestedSha(value: unknown, key: string): GitSha | null {
  if (typeof value !== "object" || value === null) return null;
  const nested = (value as Record<string, unknown>)[key];
  return readShaField(nested, "sha");
}

export function readCountField(value: unknown, key: string): number | null {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0
    ? field
    : null;
}

export function base64Text(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Raw UTF-8 SHA-256 hex, exactly how the release store addresses a record. */
export async function sha256HexText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function isToken(value: string | undefined): value is string {
  return typeof value === "string" && value.length >= 20 &&
    !/[\p{Cc}]/u.test(value);
}
