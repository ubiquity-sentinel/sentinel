// Sanitized revision shapes and strict Link continuation validation.
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  DENO_REVISION_CURSOR_MAX_CHARS,
  DENO_REVISIONS_PAGE_LIMIT,
} from "./config.ts";
const DENO_CONSOLE_ORIGIN = "https://console.deno.com";

export interface RevisionListItemV1 {
  id: string;
  status: string;
  labels: Record<string, string | string[]>;
  createdAt: number | null;
}

export interface RevisionResourceV1 {
  id: string;
  status: string;
  labels: Record<string, string | string[]>;
}

export function parseRevisionListItem(
  input: unknown,
): RevisionListItemV1 | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  const id = obj.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return null;
  }
  const status = obj.status;
  if (typeof status !== "string" || status !== "succeeded") return null;
  const labels = parseLabels(obj.labels);
  if (labels === null) return null;
  const createdAt = typeof obj.created_at === "string"
    ? parseIsoMs(obj.created_at)
    : null;
  return { id, status, labels, createdAt };
}

export function parseRevisionResource(
  input: unknown,
): RevisionResourceV1 | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const obj = input as Record<string, unknown>;
  const id = obj.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return null;
  }
  const status = obj.status;
  if (typeof status !== "string") return null;
  const labels = parseLabels(obj.labels);
  if (labels === null) return null;
  return { id, status, labels };
}

export function parseLabels(
  input: unknown,
): Record<string, string | string[]> | null {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const labels: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") {
      labels[key] = value;
      continue;
    }
    if (
      Array.isArray(value) && value.every((item) => typeof item === "string")
    ) {
      labels[key] = value as string[];
      continue;
    }
    return null;
  }
  return labels;
}

export const LINK_VALUE_RE = /^<([^>]*)>([\s\S]*)$/;
export const LINK_REL_RE = /^rel\s*=\s*(?:"([^"]*)"|([^\s;]+))$/i;

/**
 * Parses the rel=next Link header of one revision page. Returns the single
 * validated continuation cursor or null when the page has no rel=next link.
 * Multiple/conflicting next links, malformed link-values and any next link
 * that is not for the configured project on the configured API origin or the
 * official Deno console origin are rejected. The returned cursor is replayed
 * on the configured API origin by the caller; the Link URL is never fetched.
 */
export function parseNextLinkCursor(
  linkHeader: string | null,
  projectId: string,
  apiBaseUrl: string,
): PortResultV1<string | null> {
  if (linkHeader === null) return portOk(null);
  const linkValues = linkHeader.split(",");
  let nextUrl: string | null = null;
  let malformed = false;
  for (const part of linkValues) {
    const value = part.trim();
    if (value.length === 0) {
      malformed = true;
      continue;
    }
    const parsed = parseLinkValue(value);
    if (parsed === null) {
      malformed = true;
      continue;
    }
    if (!parsed.isNext) continue;
    if (nextUrl !== null) {
      return portError(
        "invalid",
        "revision listing has multiple or conflicting next links",
      );
    }
    nextUrl = parsed.url;
  }
  if (malformed) {
    return portError("invalid", "revision listing has a malformed Link header");
  }
  if (nextUrl === null) return portOk(null);
  return parseNextLinkUrl(nextUrl, projectId, apiBaseUrl);
}

export function parseLinkValue(
  raw: string,
): { url: string; isNext: boolean } | null {
  const match = LINK_VALUE_RE.exec(raw);
  if (match === null) return null;
  const params = match[2];
  let isNext = false;
  if (params.length > 0) {
    for (const param of params.split(";")) {
      const trimmed = param.trim();
      if (trimmed.length === 0) continue;
      const relMatch = LINK_REL_RE.exec(trimmed);
      if (relMatch === null) continue;
      const rel = (relMatch[1] ?? relMatch[2] ?? "").toLowerCase();
      if (rel.split(/\s+/).includes("next")) isNext = true;
    }
  }
  return { url: match[1], isNext };
}

export function parseNextLinkUrl(
  rawUrl: string,
  projectId: string,
  apiBaseUrl: string,
): PortResultV1<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return portError("invalid", "revision next link is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") {
    return portError("invalid", "revision next link carries credentials");
  }
  if (url.hash !== "") {
    return portError("invalid", "revision next link carries a fragment");
  }
  const accepted = (url.origin === new URL(apiBaseUrl).origin &&
    url.pathname === `/v2/apps/${projectId}/revisions`) ||
    (url.origin === DENO_CONSOLE_ORIGIN &&
      url.pathname === `/api/v2/apps/${projectId}/revisions`);
  if (!accepted) {
    return portError(
      "invalid",
      "revision next link is not for the configured project",
    );
  }
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (seen.has(key)) {
      return portError(
        "invalid",
        "revision next link repeats a query parameter",
      );
    }
    seen.add(key);
    if (key === "cursor") continue;
    if (key === "status" && url.searchParams.get("status") === "succeeded") {
      continue;
    }
    if (
      key === "limit" &&
      url.searchParams.get("limit") === String(DENO_REVISIONS_PAGE_LIMIT)
    ) {
      continue;
    }
    return portError(
      "invalid",
      "revision next link changes the listing semantics",
    );
  }
  const cursors = url.searchParams.getAll("cursor");
  if (cursors.length !== 1) {
    return portError(
      "invalid",
      "revision next link has an absent or duplicate cursor",
    );
  }
  const cursor = cursors[0];
  if (cursor.length === 0 || cursor.length > DENO_REVISION_CURSOR_MAX_CHARS) {
    return portError("invalid", "revision next link has an invalid cursor");
  }
  return portOk(cursor);
}

export function parseIsoMs(text: string): number | null {
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}
