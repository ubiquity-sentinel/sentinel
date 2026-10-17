/**
 * The carried merge's exact patch proof over GitHub's Git data (round-2
 * recheck P3: the merge used to rest on equal SHA-256 digests of GitHub's
 * RENDERED compare diffs, which carry 9-hex abbreviated blob ids, detect
 * renames and render a binary change as "Binary files ... differ", so two
 * different binary payloads whose abbreviated ids collide rendered alike).
 *
 * A pull request's patch against a base is the set of every path whose entry
 * differs between the merge base's tree and the head's tree, each as
 * (path, old mode, old blob id, new mode, new blob id) with full 40-hex ids,
 * no rename detection and an absent side as null. Two patches are the same
 * exactly when those sets are equal: equal full blob ids mean equal bytes,
 * text or binary, and the old side binds the base content each change
 * applies to, so a base move that touched a reviewed path changes the set.
 * GitHub's compare `files[]` carry only the new blob id (no mode, no old
 * blob, renames folded), so the sets are read from the recursive Git Trees
 * API instead, and a tree GitHub truncates (past its entry or size limit) is
 * no proof. The merge base is the one GitHub's compare names (a criss-cross
 * history has several; the runtime's git proof, which must hold before the
 * runtime writes its carried-merge marker, refuses those).
 */
import { MAX_COMPARE_RESPONSE_BYTES } from "./hosted-autonomy-github-listing.ts";

/** One changed path of a merge-base patch (null: absent on that side). */
export interface HostedTreeChangeV1 {
  readonly path: string;
  readonly oldMode: string | null;
  readonly oldSha: string | null;
  readonly newMode: string | null;
  readonly newSha: string | null;
}

/** The exact merge-base patch of `head` against `base`. */
export interface HostedTreeChangesV1 {
  /** The merge base GitHub's compare of `base...head` names. */
  readonly mergeBase: string;
  /** Every changed path, ordered by path (UTF-16 code unit order). */
  readonly changes: readonly HostedTreeChangeV1[];
}

const OBJECT_ID = /^[0-9a-f]{40}$/;
/** Entry modes a tree may hold for a non-directory path. */
const FILE_MODES: Readonly<Record<string, "blob" | "commit">> = {
  "100644": "blob",
  "100755": "blob",
  "120000": "blob",
  "160000": "commit",
};

type Entry = { readonly mode: string; readonly sha: string };

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function objectId(value: unknown): string | null {
  return typeof value === "string" && OBJECT_ID.test(value) ? value : null;
}

/**
 * One recursive tree read whole: path -> (mode, id) for every file, symlink
 * and submodule entry (directories are implied by their paths), or null for
 * a truncated, foreign or malformed answer.
 */
export function parseRecursiveTree(
  body: unknown,
  tree: string,
): Map<string, Entry> | null {
  if (field(body, "sha") !== tree || field(body, "truncated") !== false) {
    return null;
  }
  const rows = field(body, "tree");
  if (!Array.isArray(rows)) return null;
  const entries = new Map<string, Entry>();
  for (const row of rows) {
    const path = field(row, "path");
    const mode = field(row, "mode");
    const type = field(row, "type");
    const sha = objectId(field(row, "sha"));
    if (
      typeof path !== "string" || path.length === 0 || path.includes("\0") ||
      typeof mode !== "string" || sha === null
    ) return null;
    if (type === "tree" && mode === "040000") continue;
    if (FILE_MODES[mode] === undefined || FILE_MODES[mode] !== type) {
      return null;
    }
    if (entries.has(path)) return null;
    entries.set(path, { mode, sha });
  }
  return entries;
}

/** Every path whose entry differs between two trees, ordered by path. */
export function treeChanges(
  before: ReadonlyMap<string, Entry>,
  after: ReadonlyMap<string, Entry>,
): HostedTreeChangeV1[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  const changes: HostedTreeChangeV1[] = [];
  for (const path of paths) {
    const old = before.get(path) ?? null;
    const next = after.get(path) ?? null;
    if (old?.mode === next?.mode && old?.sha === next?.sha) continue;
    changes.push({
      path,
      oldMode: old?.mode ?? null,
      oldSha: old?.sha ?? null,
      newMode: next?.mode ?? null,
      newSha: next?.sha ?? null,
    });
  }
  return changes;
}

/** True exactly when two merge-base patches change the same entries. */
export function sameTreeChanges(
  a: readonly HostedTreeChangeV1[],
  b: readonly HostedTreeChangeV1[],
): boolean {
  return a.length === b.length && a.every((change, index) => {
    const other = b[index];
    return change.path === other.path && change.oldMode === other.oldMode &&
      change.oldSha === other.oldSha && change.newMode === other.newMode &&
      change.newSha === other.newSha;
  });
}

/** SHA-256 (lowercase hex) of the canonical change list, as evidence. */
export async function treeChangesDigest(
  changes: readonly HostedTreeChangeV1[],
): Promise<string> {
  const canonical = JSON.stringify(
    changes.map((change) => [
      change.path,
      change.oldMode,
      change.oldSha,
      change.newMode,
      change.newSha,
    ]),
  );
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonical),
    ),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The bounded JSON reader of one repository (`createHostedAutonomyRequest`). */
type Request = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
  maxBytes?: number,
) => Promise<unknown | null>;

/**
 * The surface member `mergeBaseTreeChanges` for one repository: the compare
 * of `base...head` names the merge base and its tree, the head's commit names
 * its tree, and both recursive trees are read whole (GitHub caps one at 7 MB,
 * inside the compare bound). Null for anything unreadable, truncated or
 * malformed.
 */
export function createMergeBaseTreeChanges(request: Request, scope: string) {
  const readTree = async (tree: string) =>
    parseRecursiveTree(
      await request(
        "GET",
        `/repos/${scope}/git/trees/${tree}?recursive=1`,
        undefined,
        MAX_COMPARE_RESPONSE_BYTES,
      ),
      tree,
    );
  return async function mergeBaseTreeChanges(
    base: string,
    head: string,
  ): Promise<HostedTreeChangesV1 | null> {
    if (objectId(base) === null || objectId(head) === null) return null;
    const compare = await request(
      "GET",
      `/repos/${scope}/compare/${base}...${head}`,
      undefined,
      MAX_COMPARE_RESPONSE_BYTES,
    );
    const mergeBaseCommit = field(compare, "merge_base_commit");
    const mergeBase = objectId(field(mergeBaseCommit, "sha"));
    const mergeBaseTree = objectId(
      field(field(field(mergeBaseCommit, "commit"), "tree"), "sha"),
    );
    if (mergeBase === null || mergeBaseTree === null) return null;
    const commit = await request("GET", `/repos/${scope}/git/commits/${head}`);
    const headTree = objectId(field(field(commit, "tree"), "sha"));
    if (field(commit, "sha") !== head || headTree === null) return null;
    const before = await readTree(mergeBaseTree);
    if (before === null) return null;
    const after = await readTree(headTree);
    if (after === null) return null;
    return { mergeBase, changes: treeChanges(before, after) };
  };
}
