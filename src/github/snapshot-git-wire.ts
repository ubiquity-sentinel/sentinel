// snapshot git wire.

import { MaxText } from "../contracts/validation.ts";
import {
  MAX_COMMIT_PARENTS,
  MAX_PROTECTED_PATHS,
  MAX_PROTECTED_PATHSPEC_CHARS,
  PUBLICATION_DEADLINE_DETAIL,
  PUBLICATION_MODE_DETAIL,
  PUBLICATION_OVERBOUND_DETAIL,
  PUBLICATION_PATH_DETAIL,
  PUBLICATION_READ_DETAIL,
  PUBLICATION_STATUS_DETAIL,
  PUBLICATION_STRUCTURE_DETAIL,
  PUBLICATION_SUBMODULE_DETAIL,
  PUBLICATION_SYMLINK_DETAIL,
  PUBLICATION_UNSETTLED_DETAIL,
  SNAPSHOT_DEADLINE_DETAIL,
  SNAPSHOT_MODE_DETAIL,
  SNAPSHOT_OVERBOUND_DETAIL,
  SNAPSHOT_PATH_DETAIL,
  SNAPSHOT_READ_DETAIL,
  SNAPSHOT_STATUS_DETAIL,
  SNAPSHOT_SUBMODULE_DETAIL,
  SNAPSHOT_SYMLINK_DETAIL,
  SNAPSHOT_UNSETTLED_DETAIL,
} from "./snapshot-policy.ts";
import { isRegularMode, isSafeReviewPath } from "./snapshot-manifest.ts";

/** One parsed raw change record from `git diff --raw -z`. */
export interface RawChangeV1 {
  path: string;
  status: "A" | "M" | "D";
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
}

/** Parse NUL-delimited `--raw` output; null on any malformed structure. */
export function parseRawChanges(text: string): RawChangeV1[] | null {
  const tokens = text.split("\u0000");
  const changes: RawChangeV1[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "") continue;
    if (!token.startsWith(":")) return null;
    const meta = token.slice(1).split(" ");
    if (meta.length !== 5) return null;
    const [oldMode, newMode, oldBlob, newBlob, status] = meta;
    const path = tokens[index + 1];
    if (path === undefined || path === "") return null;
    index++;
    changes.push({
      path,
      status: status as RawChangeV1["status"],
      oldMode,
      newMode,
      oldBlob,
      newBlob,
    });
  }
  return changes;
}

/** True when the NUL-delimited numstat read reports any binary blob. */
export function numstatHasBinary(text: string): boolean {
  for (const token of text.split("\u0000")) {
    if (token === "") continue;
    const first = token.indexOf("\t");
    if (first <= 0) continue;
    const second = token.indexOf("\t", first + 1);
    if (second <= first) continue;
    if (
      token.slice(0, first) === "-" && token.slice(first + 1, second) === "-"
    ) {
      return true;
    }
  }
  return false;
}

export function numstatRecordCount(text: string): number {
  let count = 0;
  for (const token of text.split("\u0000")) {
    if (token !== "") count++;
  }
  return count;
}

/** Exact bytes a `rev-list` SHA list read may retain for `bound` entries. */
export function shaListBytes(bound: number): number {
  return (bound + 1) * 41;
}

/**
 * Validate and normalize caller-supplied protected paths. A protected entry is
 * the repository config's exact relative path or a trailing-slash subtree
 * entry; both normalize to one literal pathspec, because a directory entry's
 * exact object SHA is its subtree SHA. Bounded in count (`MaxItems`) and
 * length (`MaxText.path`), no pathspec magic, no control characters, no
 * absolute or dot-segment forms. Returns unique normalized paths, or null when
 * the value is malformed or over bound (which the caller rejects).
 */
export function normalizeProtectedPaths(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_PROTECTED_PATHS) return null;
  const paths = new Set<string>();
  let pathspecChars = 0;
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    if (path.length === 0 || path.length > MaxText.path) return null;
    if (!isSafeReviewPath(path)) return null;
    if (paths.has(path)) continue;
    paths.add(path);
    pathspecChars += path.length + 1;
    if (pathspecChars > MAX_PROTECTED_PATHSPEC_CHARS) return null;
  }
  return [...paths];
}

/**
 * Parse one bounded `rev-list` list: exactly one 40-hex object name per line
 * and no other content. Null when any line is malformed. The caller applies
 * the finite entry bound to the parsed list; the bounded read retains at most
 * one entry beyond that bound, which is what makes overflow provable.
 */
export function parseShaList(text: string): string[] | null {
  const shas: string[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === "") {
      if (index === lines.length - 1) continue;
      return null;
    }
    if (!/^[0-9a-f]{40}$/.test(line)) return null;
    shas.push(line);
  }
  return shas;
}

/**
 * Parse the parent edges of one raw commit object. The tree header must be
 * present and every `parent` header must be an exact 40-hex commit name; the
 * header section ends at the first empty line, so message content can never
 * fabricate a parent edge. Null when the metadata is malformed.
 */
export function parseCommitParents(text: string): string[] | null {
  const parents: string[] = [];
  let sawTree = false;
  for (const line of text.split("\n")) {
    if (line === "") break;
    if (line.startsWith("tree ")) {
      if (sawTree || !/^[0-9a-f]{40}$/.test(line.slice(5))) return null;
      sawTree = true;
      continue;
    }
    if (line.startsWith("parent ")) {
      if (!/^[0-9a-f]{40}$/.test(line.slice(7))) return null;
      parents.push(line.slice(7));
      if (parents.length > MAX_COMMIT_PARENTS) return null;
    }
  }
  return sawTree ? parents : null;
}

/**
 * Ordinary GitHub issue-closing references in raw commit metadata: one of
 * fix/fixes/fixed, close/closes/closed, resolve/resolves/resolved, then
 * ordinary whitespace or a colon, then `#N`, `owner/repo#N` or a GitHub issue
 * URL. This is a deterministic negative check on trusted-local bytes; the
 * candidate commit is never mutated and the simple PR-body keyword sanitizer
 * stays a separate API.
 */
export const ISSUE_CLOSING_RE =
  /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\b[\s:]+(?:#\d+|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)/i;

export function hasIssueClosingReference(text: string): boolean {
  return ISSUE_CLOSING_RE.test(text);
}

/**
 * Complete structural view of one newly exposed root commit's tree. Entries
 * must have safe paths and regular-file modes; every other mode or type is
 * rejected, never omitted. Returns the tree's candidate blob names; the caller
 * keeps only the objects that are actually newly exposed.
 */
export function parseRootTreeBlobs(
  text: string,
): { ok: true; blobs: string[] } | { ok: false; detail: string } {
  const blobs: string[] = [];
  const seenPaths = new Set<string>();
  for (const record of text.split("\u0000")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    if (tab <= 0) return { ok: false, detail: PUBLICATION_STRUCTURE_DETAIL };
    const meta = record.slice(0, tab).split(" ");
    if (meta.length !== 3) {
      return { ok: false, detail: PUBLICATION_STRUCTURE_DETAIL };
    }
    const [mode, type, sha] = meta;
    const path = record.slice(tab + 1);
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return { ok: false, detail: PUBLICATION_STRUCTURE_DETAIL };
    }
    if (!isSafeReviewPath(path) || seenPaths.has(path)) {
      return { ok: false, detail: PUBLICATION_PATH_DETAIL };
    }
    seenPaths.add(path);
    if (mode === "120000") {
      return { ok: false, detail: PUBLICATION_SYMLINK_DETAIL };
    }
    if (mode === "160000") {
      return { ok: false, detail: PUBLICATION_SUBMODULE_DETAIL };
    }
    if (!isRegularMode(mode) || type !== "blob") {
      return { ok: false, detail: PUBLICATION_MODE_DETAIL };
    }
    blobs.push(sha);
  }
  return { ok: true, blobs };
}

/**
 * One exact protected tree entry read for one literal path: either the path is
 * absent (exit-0 empty `ls-tree -z` output) or its complete mode/type/object
 * identity at exactly that full path.
 */
export type ProtectedTreeEntryV1 =
  | { readonly absent: true }
  | {
    readonly absent: false;
    readonly mode: string;
    readonly type: string;
    readonly sha: string;
  };

/**
 * Parse one exact `ls-tree -z --full-tree <commit> -- <path>` read. Empty
 * output means exactly that the literal path is absent. Otherwise the output
 * must be exactly one NUL-terminated record whose mode, type and object SHA
 * are valid and whose full path is the exact literal path requested; anything
 * malformed, multiple or foreign is rejected (null) and the caller fails
 * closed. Truncated output never reaches this parser: the bounded read rejects
 * it first.
 */
export function parseProtectedTreeEntry(
  text: string,
  path: string,
): ProtectedTreeEntryV1 | null {
  if (text !== "" && !text.endsWith("\u0000")) return null;
  const records = text.split("\u0000");
  if (records.length > 0 && records[records.length - 1] === "") records.pop();
  if (records.length === 0) return { absent: true };
  if (records.length !== 1) return null;
  const record = records[0];
  const tab = record.indexOf("\t");
  if (tab <= 0) return null;
  const meta = record.slice(0, tab).split(" ");
  if (meta.length !== 3) return null;
  const [mode, type, sha] = meta;
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  if (record.slice(tab + 1) !== path) return null;
  const expectedType = mode === "040000"
    ? "tree"
    : mode === "160000"
    ? "commit"
    : mode === "100644" || mode === "100755" || mode === "120000"
    ? "blob"
    : null;
  if (expectedType === null || type !== expectedType) return null;
  return { absent: false, mode, type, sha };
}

/** Exact protected identity: existence, mode, type and object SHA. */
export function sameProtectedEntry(
  a: ProtectedTreeEntryV1,
  b: ProtectedTreeEntryV1,
): boolean {
  if (a.absent || b.absent) return a.absent === b.absent;
  return a.mode === b.mode && a.type === b.type && a.sha === b.sha;
}

/**
 * Ancestor identity: existence, mode and type only. An ancestor tree SHA is
 * never compared, because it legitimately changes for allowed siblings.
 */
export function sameProtectedAncestor(
  a: ProtectedTreeEntryV1,
  b: ProtectedTreeEntryV1,
): boolean {
  if (a.absent || b.absent) return a.absent === b.absent;
  return a.mode === b.mode && a.type === b.type;
}

/** A present ancestor entry must be a directory tree; absence is allowed. */
export function isDirectoryTreeEntry(entry: ProtectedTreeEntryV1): boolean {
  return entry.absent || (entry.mode === "040000" && entry.type === "tree");
}

/** One safe protected path's proper ancestors, outermost first. */
export function protectedAncestorPaths(path: string): string[] {
  const segments = path.split("/");
  const ancestors: string[] = [];
  let prefix = "";
  for (let index = 0; index + 1 < segments.length; index++) {
    prefix = index === 0 ? segments[index] : `${prefix}/${segments[index]}`;
    ancestors.push(prefix);
  }
  return ancestors;
}

/** Map one shared snapshot structural detail onto its static publication reason. */
export function publicationStructureDetail(detail: string): string {
  switch (detail) {
    case SNAPSHOT_PATH_DETAIL:
      return PUBLICATION_PATH_DETAIL;
    case SNAPSHOT_MODE_DETAIL:
      return PUBLICATION_MODE_DETAIL;
    case SNAPSHOT_SYMLINK_DETAIL:
      return PUBLICATION_SYMLINK_DETAIL;
    case SNAPSHOT_SUBMODULE_DETAIL:
      return PUBLICATION_SUBMODULE_DETAIL;
    case SNAPSHOT_STATUS_DETAIL:
      return PUBLICATION_STATUS_DETAIL;
    default:
      return PUBLICATION_STRUCTURE_DETAIL;
  }
}

/**
 * Map one shared bounded-read failure onto its static publication reason.
 * Details that are already publication reasons pass through unchanged.
 */
export function publicationReadDetail(detail: string): string {
  switch (detail) {
    case SNAPSHOT_DEADLINE_DETAIL:
      return PUBLICATION_DEADLINE_DETAIL;
    case SNAPSHOT_OVERBOUND_DETAIL:
      return PUBLICATION_OVERBOUND_DETAIL;
    case SNAPSHOT_UNSETTLED_DETAIL:
      return PUBLICATION_UNSETTLED_DETAIL;
    case SNAPSHOT_READ_DETAIL:
      return PUBLICATION_READ_DETAIL;
    default:
      return detail;
  }
}
