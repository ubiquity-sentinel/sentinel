/**
 * Base-drift carry of a reviewed change (2026-11-12; sentinel PRs 304 and 307
 * parked "the refreshed head does not carry the reviewed patch" although every
 * added and removed line of their reviewed patches was byte-identical).
 *
 * The carried review's exact identity (the runtime's `git-carried-patch.ts`,
 * the launcher's `ops/hosted-autonomy-github-trees.ts`) binds the full old and
 * new blob ids of every reviewed path, so a base move that edits a reviewed
 * file anywhere, even only beside a hunk (its context lines), reads as a
 * changed patch. This module decides, from exact blob bytes alone, whether a
 * refreshed change set nevertheless carries the reviewed change unaltered:
 *
 * - both change sets name exactly the same paths with the same old and new
 *   modes; a path whose old and new blob ids are both equal is carried
 *   exactly, as before;
 * - any other path is carried only when, on both sides, it is a content-only
 *   change (no mode change) of a regular file whose four blobs are NUL-free
 *   and bounded, the base changed its old content (the old blob ids differ),
 *   and the refreshed new content is EXACTLY the clean line merge of the
 *   reviewed change and the base's change to that file: the reviewed edit
 *   hunks (reviewed merge base -> reviewed head) and the base's edit hunks
 *   (reviewed merge base -> refreshed merge base) are all separated by at
 *   least one unchanged line (git's own clean-merge rule: edits that overlap
 *   or touch conflict), and applying both to the reviewed merge base's lines
 *   gives the refreshed head's lines byte for byte.
 *
 * The refreshed file is then a pure function of the reviewed old and new
 * content and the tip's content: every reviewed hunk is present verbatim (the
 * same removed and added lines, in the same order) at the position its
 * unchanged neighbours map it to, and nothing else differs from the tip. The
 * same added lines anywhere else in the file, a dropped, reordered or extra
 * edit, a binary, symlink, submodule or mode change, an added or deleted
 * path, or a different path set is never carried. Every blob read is checked
 * against its object id (`gitBlobId`): an unreadable or mismatched blob is
 * `unavailable` (retryable), never a proof; an exceeded bound is `changed`
 * (deterministic, exactly the exact identity's answer). No I/O but the
 * injected blob reader, no clock.
 *
 * Only repositories whose every carried-identity consumer applies this rule
 * carry drift (`carriedDriftAllowed`): a native queue target's delivery proof
 * (`queue-legacy-direct.ts`) still compares the exact tree identity, so its
 * carried records keep the exact patch identity.
 */
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";

/** One changed path of a merge-base change set (null: absent on that side). */
export interface CarriedPathChangeV1 {
  readonly path: string;
  readonly oldMode: string | null;
  readonly oldSha: string | null;
  readonly newMode: string | null;
  readonly newSha: string | null;
}

/**
 * One exact blob read: its bytes, `too_large` past the reader's bound (the
 * reader's bound must be `CARRIED_DRIFT_MAX_BLOB_BYTES`), or null when it
 * could not be read.
 */
export type CarriedBlobReadV1 = Uint8Array | "too_large" | null;

/** Reads one blob of the repository by its full object id. */
export type CarriedBlobReaderV1 = (sha: string) => Promise<CarriedBlobReadV1>;

/**
 * The drift verdict: every path carried (exactly, or `drifted` of them across
 * base drift), not carried, or not decidable now (a blob was unreadable).
 */
export type CarriedDriftVerdictV1 =
  | { readonly kind: "carried"; readonly drifted: number }
  | { readonly kind: "changed" }
  | { readonly kind: "unavailable" };

/** Bound on the drifted paths one proof reads (four blobs each). */
export const CARRIED_DRIFT_MAX_PATHS = 32;

/** Bound on one blob a drift proof reads. */
export const CARRIED_DRIFT_MAX_BLOB_BYTES = 2 * 1024 * 1024;

/**
 * Bound on the edit distance of one line diff (beyond a common prefix and
 * suffix); a larger one proves nothing. Its trace holds about MAX_EDITS^2
 * integers (16 MiB).
 */
const MAX_EDITS = 2048;

/** Regular-file modes whose content drift may be carried. */
const TEXT_MODES = new Set(["100644", "100755"]);
const OBJECT_ID = /^[0-9a-f]{40}$/;
const CHANGED: CarriedDriftVerdictV1 = { kind: "changed" };
const UNAVAILABLE: CarriedDriftVerdictV1 = { kind: "unavailable" };

/**
 * Whether a carried review of `repository` may carry its reviewed change
 * across base drift: every repository except a native queue target
 * (`isNativeQueueTarget`, mirrored here so this module stays a leaf of the
 * import graph; a test pins the two), whose merged-delivery proof keeps the
 * exact tree identity.
 */
export function carriedDriftAllowed(repository: RepositoryIdentityV1): boolean {
  return !(repository.owner === "ubiquity" && repository.name === "ai.ubq.fi");
}

/** The git object id of a blob with exactly these bytes (SHA-1, hex). */
export async function gitBlobId(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  const input = new Uint8Array(header.byteLength + bytes.byteLength);
  input.set(header, 0);
  input.set(bytes, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** One code unit per byte: equal strings exactly for equal bytes. */
export function byteString(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.byteLength; at += 4096) {
    text += String.fromCharCode(...bytes.subarray(at, at + 4096));
  }
  return text;
}

/** The lines of a file, each with its own line feed (the last may lack it). */
function splitLines(bytes: Uint8Array): string[] {
  const text = byteString(bytes);
  const lines: string[] = [];
  for (let start = 0; start < text.length;) {
    const feed = text.indexOf("\n", start);
    const next = feed === -1 ? text.length : feed + 1;
    lines.push(text.slice(start, next));
    start = next;
  }
  return lines;
}

/** Line ids shared by every file of one path (equal ids: equal bytes). */
function lineIds(lines: string[], ids: Map<string, number>): Int32Array {
  const out = new Int32Array(lines.length);
  for (let index = 0; index < lines.length; index++) {
    let id = ids.get(lines[index]);
    if (id === undefined) {
      id = ids.size;
      ids.set(lines[index], id);
    }
    out[index] = id;
  }
  return out;
}

/** One maximal edit of a line diff: lines [start, end) of the old side
 * replaced by `lines` (an empty range is an insertion before `start`). */
export interface CarriedLineHunkV1 {
  readonly start: number;
  readonly end: number;
  readonly lines: Int32Array;
}

/**
 * The x a furthest path on diagonal `k` starts its snake at in round `d` > 0
 * (Myers): from diagonal k + 1 by an insertion (same x) or from k - 1 by a
 * deletion (x + 1), whichever reaches further (the insertion on a tie), every
 * move kept inside the n x m edit grid; -1 when neither exists.
 */
function snakeStart(
  prior: (k: number) => number,
  k: number,
  d: number,
  n: number,
  m: number,
): { x: number; from: number } {
  const down = k < d ? prior(k + 1) : -1;
  const right = k > -d ? prior(k - 1) : -1;
  const downX = down >= 0 && down - k <= m ? down : -1;
  const rightX = right >= 0 && right + 1 <= n ? right + 1 : -1;
  return rightX > downX
    ? { x: rightX, from: k - 1 }
    : { x: downX, from: k + 1 };
}

/**
 * The matched line pairs (flattened x, y, ascending) of one shortest edit
 * script of `a` into `b` (Myers' greedy O(ND) algorithm), or null past
 * `MAX_EDITS`.
 */
function matchedPairs(a: Int32Array, b: Int32Array): number[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3).fill(-1);
  // trace[d]: furthest x of every diagonal -d..d after round d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    for (let k = -d; k <= d; k += 2) {
      const x0 = d === 0
        ? 0
        : snakeStart((diagonal) => v[offset + diagonal], k, d, n, m).x;
      if (x0 < 0) {
        v[offset + k] = -1;
        continue;
      }
      let x = x0;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x === n && y === m) return backtrack(trace, d, n, m);
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  return null;
}

/** Walk one shortest path back from (n, m) through the recorded rounds. */
function backtrack(
  trace: readonly Int32Array[],
  rounds: number,
  n: number,
  m: number,
): number[] {
  const reversed: number[] = [];
  let x = n;
  let y = m;
  for (let d = rounds; d > 0; d--) {
    const prior = trace[d - 1];
    const k = x - y;
    const step = snakeStart(
      (diagonal) => prior[diagonal + d - 1],
      k,
      d,
      n,
      m,
    );
    while (x > step.x) {
      x--;
      y--;
      reversed.push(y, x);
    }
    x = prior[step.from + d - 1];
    y = x - step.from;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    reversed.push(y, x);
  }
  return reversed.reverse();
}

/**
 * The maximal edits turning `a` into `b`, ascending (consecutive edits are
 * separated by at least one unchanged line), or null past the edit bound.
 */
export function lineHunks(
  a: Int32Array,
  b: Int32Array,
): CarriedLineHunkV1[] | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < a.length - prefix && suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) suffix++;
  const middleA = a.subarray(prefix, a.length - suffix);
  const middleB = b.subarray(prefix, b.length - suffix);
  const pairs = middleA.length === 0 || middleB.length === 0
    ? []
    : matchedPairs(middleA, middleB);
  if (pairs === null) return null;
  pairs.push(middleA.length, middleB.length);
  const hunks: CarriedLineHunkV1[] = [];
  let x = 0;
  let y = 0;
  for (let index = 0; index < pairs.length; index += 2) {
    const matchX = pairs[index];
    const matchY = pairs[index + 1];
    if (matchX > x || matchY > y) {
      hunks.push({
        start: prefix + x,
        end: prefix + matchX,
        lines: middleB.subarray(y, matchY),
      });
    }
    x = matchX + 1;
    y = matchY + 1;
  }
  return hunks;
}

/**
 * The clean line merge of two edit lists of the same `base`, or null on a
 * conflict: an edit of one list that overlaps or touches (no unchanged line
 * between) an edit of the other, as git's merge decides.
 */
export function cleanLineMerge(
  base: Int32Array,
  ours: readonly CarriedLineHunkV1[],
  theirs: readonly CarriedLineHunkV1[],
): Int32Array | null {
  const hunks = [...ours, ...theirs].sort((p, q) =>
    p.start - q.start || p.end - q.end
  );
  for (let index = 1; index < hunks.length; index++) {
    if (hunks[index - 1].end >= hunks[index].start) return null;
  }
  const merged: number[] = [];
  let at = 0;
  for (const hunk of hunks) {
    for (; at < hunk.start; at++) merged.push(base[at]);
    for (const line of hunk.lines) merged.push(line);
    at = hunk.end;
  }
  for (; at < base.length; at++) merged.push(base[at]);
  return Int32Array.from(merged);
}

function sameIds(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** One verified blob: its exact bytes, or the verdict it forces. */
async function readVerified(
  read: CarriedBlobReaderV1,
  sha: string,
): Promise<Uint8Array | CarriedDriftVerdictV1> {
  let bytes: CarriedBlobReadV1;
  try {
    bytes = await read(sha);
  } catch {
    return UNAVAILABLE;
  }
  if (bytes === null) return UNAVAILABLE;
  if (
    bytes === "too_large" || bytes.byteLength > CARRIED_DRIFT_MAX_BLOB_BYTES
  ) {
    return CHANGED;
  }
  if (await gitBlobId(bytes) !== sha) return UNAVAILABLE;
  return bytes.includes(0) ? CHANGED : bytes;
}

/**
 * True when `reviewed` and `refreshed` (one path, same path and modes) may
 * differ only by base drift: a content-only regular-file change on both
 * sides with full object ids, whose old content the base changed.
 */
function driftCandidate(
  reviewed: CarriedPathChangeV1,
  refreshed: CarriedPathChangeV1,
): boolean {
  const ids = [
    reviewed.oldSha,
    reviewed.newSha,
    refreshed.oldSha,
    refreshed.newSha,
  ];
  return reviewed.oldMode !== null && reviewed.oldMode === reviewed.newMode &&
    TEXT_MODES.has(reviewed.oldMode) &&
    ids.every((id) => id !== null && OBJECT_ID.test(id)) &&
    reviewed.oldSha !== refreshed.oldSha;
}

/** One drifted path: carried exactly when its refreshed lines are the merge. */
async function pathCarried(
  reviewed: CarriedPathChangeV1,
  refreshed: CarriedPathChangeV1,
  read: CarriedBlobReaderV1,
): Promise<CarriedDriftVerdictV1> {
  const files: Uint8Array[] = [];
  for (
    const sha of [
      reviewed.oldSha!,
      reviewed.newSha!,
      refreshed.oldSha!,
      refreshed.newSha!,
    ]
  ) {
    const bytes = await readVerified(read, sha);
    if (!(bytes instanceof Uint8Array)) return bytes;
    files.push(bytes);
  }
  const ids = new Map<string, number>();
  const [base, reviewedHead, tip, refreshedHead] = files.map((file) =>
    lineIds(splitLines(file), ids)
  );
  const reviewedEdits = lineHunks(base, reviewedHead);
  const baseEdits = lineHunks(base, tip);
  if (reviewedEdits === null || baseEdits === null) return CHANGED;
  const merged = cleanLineMerge(base, reviewedEdits, baseEdits);
  return merged !== null && sameIds(merged, refreshedHead)
    ? { kind: "carried", drifted: 1 }
    : CHANGED;
}

function byPath(
  changes: readonly CarriedPathChangeV1[],
): CarriedPathChangeV1[] {
  return [...changes].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
}

/**
 * Whether the refreshed change set carries the reviewed one across base
 * drift (module comment): `carried` with the number of drifted paths when
 * every path is carried exactly or across drift, `changed` when any path is
 * not, `unavailable` when a drifted path's blob could not be read.
 */
export async function carriedAcrossDrift(
  reviewed: readonly CarriedPathChangeV1[],
  refreshed: readonly CarriedPathChangeV1[],
  read: CarriedBlobReaderV1,
): Promise<CarriedDriftVerdictV1> {
  if (reviewed.length !== refreshed.length) return CHANGED;
  const before = byPath(reviewed);
  const after = byPath(refreshed);
  const drifted: [CarriedPathChangeV1, CarriedPathChangeV1][] = [];
  for (let index = 0; index < before.length; index++) {
    const old = before[index];
    const next = after[index];
    if (
      old.path !== next.path || old.oldMode !== next.oldMode ||
      old.newMode !== next.newMode ||
      (index > 0 && before[index - 1].path === old.path)
    ) return CHANGED;
    if (old.oldSha === next.oldSha && old.newSha === next.newSha) continue;
    if (!driftCandidate(old, next)) return CHANGED;
    drifted.push([old, next]);
  }
  if (drifted.length > CARRIED_DRIFT_MAX_PATHS) return CHANGED;
  for (const [old, next] of drifted) {
    const verdict = await pathCarried(old, next, read);
    if (verdict.kind !== "carried") return verdict;
  }
  return { kind: "carried", drifted: drifted.length };
}
