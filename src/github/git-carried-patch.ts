/**
 * Carried-review patch proof over the trusted local object store (owner
 * decision 2026-10-16 (2), the coordinator's option (b)).
 *
 * A spent record whose base moved is refreshed mechanically (the runtime
 * merges the new tip T into the reviewed head H0, exactly as every base
 * refresh does). The refreshed head H1 may carry H0's completed review only
 * when the pull request's OWN patch is byte-identical: the merge-base patch of
 * H0 against its reviewed base B0 must equal the merge-base patch of H1
 * against T. This module derives that from git, nothing else:
 *
 * - each side's merge base is `git merge-base --all`, and it must be unique (a
 *   criss-cross history, or none, is no proof);
 * - each patch is `git diff` between that merge base and the head with every
 *   rendering choice fixed (`--binary --full-index --no-renames`, no external
 *   diff or textconv, no color, fixed prefixes, algorithm, submodule format
 *   and quoting), read as raw bytes (binary-safe) and hashed with SHA-256
 *   together with the side's raw listing (`git diff --raw --no-abbrev -z
 *   --no-renames`). `--full-index` puts both full blob ids of a content change
 *   on its index line, but a mode-only change prints no index line (#156): the
 *   raw listing names both modes and both full blob ids of EVERY changed path,
 *   so equal digests mean equal old and new contents, equal modes, equal
 *   renames (as a delete and an add) and equal binary payloads, the same
 *   (path, old mode, old blob, new mode, new blob) sets the launcher compares
 *   from GitHub's Git trees.
 *
 * The proof also names the refreshed head's first parent (the head the
 * refresh merged the tip into) and counts the first-parent commits from the
 * reviewed head to the refreshed one (the refreshes the patch was carried
 * through), so the runtime bounds both without a state field.
 *
 * When the refreshed head is on its tip and the two digests differ, the proof
 * also decides base drift (`carried-drift.ts`) over both raw listings and the
 * exact blobs (`git cat-file blob`, bounded): `driftCarried` is true exactly
 * when every differing path is a text file whose refreshed content is the
 * clean line merge of the reviewed change and the base's change. The digests
 * are unchanged by it; an unreadable blob makes the proof unavailable.
 *
 * Every command only reads the local object store: no checkout, index or ref
 * update, no hook, no network and no credential. A missing object, a bound or
 * an unreadable result is a typed failure, never a proof; the decision itself
 * is `carriedPatchHolds` (contracts).
 */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import {
  type CarriedPatchProofV1,
  type CarriedPatchRequestV1,
  portError,
  portOk,
  type PortResultV1,
} from "../contracts/ports.ts";
import {
  byteString,
  CARRIED_DRIFT_MAX_BLOB_BYTES,
  carriedAcrossDrift,
  type CarriedBlobReadV1,
  type CarriedPathChangeV1,
} from "./carried-drift.ts";

/** One bounded git run over the trusted local store (stdout bytes kept). */
export type CarriedPatchGitRunV1 = (
  args: string[],
  maxOutputBytes: number,
) => Promise<{
  ok: boolean;
  code: number;
  stdout: string;
  stdoutBytes?: Uint8Array;
  timeout?: boolean;
  overflow?: boolean;
}>;

/** Bound on one merge-base patch (bytes); a larger patch is no proof. */
export const CARRIED_PATCH_MAX_BYTES = 64 * 1024 * 1024;

/** Bound on one small plumbing read (commit check, merge bases). */
const SMALL_OUTPUT_BYTES = 64 * 1024;

const STATIC_INPUT = "carried patch input is invalid";
const STATIC_OBJECT = "carried patch input commit is unavailable";
const STATIC_MERGE_BASE = "carried patch merge base is not unique";
const STATIC_PATCH = "carried patch could not be read";
const STATIC_BOUND = "carried patch exceeded its bound";
const STATIC_LINEAGE = "carried patch lineage could not be read";
const STATIC_DRIFT = "carried patch drift could not be read";

/**
 * Fixed rendering of every patch: configuration in the local store can never
 * change the bytes compared (both sides are rendered by the same command).
 */
const PATCH_ARGS = [
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.noprefix=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.relative=false",
  "-c",
  "diff.suppressBlankEmpty=false",
  "-c",
  "diff.indentHeuristic=true",
  "-c",
  "diff.renames=false",
  "-c",
  "core.attributesFile=/dev/null",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--binary",
  "--full-index",
  "--no-renames",
  "--ignore-submodules=none",
  "--submodule=short",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--diff-algorithm=myers",
] as const;

async function commitExists(
  run: CarriedPatchGitRunV1,
  sha: GitSha,
): Promise<PortResultV1<boolean>> {
  const result = await run(
    ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
    SMALL_OUTPUT_BYTES,
  );
  if (result.ok) return portOk(result.stdout.trim() === sha);
  if (result.code === 1) return portOk(false);
  return portError("unavailable", STATIC_OBJECT);
}

/** The one merge base of `a` and `b`, or a typed failure. */
async function uniqueMergeBase(
  run: CarriedPatchGitRunV1,
  a: GitSha,
  b: GitSha,
): Promise<PortResultV1<GitSha>> {
  const result = await run(["merge-base", "--all", a, b], SMALL_OUTPUT_BYTES);
  if (!result.ok) {
    // Exit 1 with no output is "no common ancestor": no proof either way.
    return result.code === 1
      ? portError("conflict", STATIC_MERGE_BASE)
      : portError("unavailable", STATIC_MERGE_BASE);
  }
  const bases = result.stdout.split("\n").map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (bases.length !== 1 || !isGitSha(bases[0])) {
    return portError("conflict", STATIC_MERGE_BASE);
  }
  return portOk(bases[0] as GitSha);
}

/**
 * Fixed raw listing of every changed path (#156): both modes and both full
 * blob ids, NUL-terminated, so a mode-only change, which prints no index line
 * in the patch, still binds the content it applies to.
 */
const RAW_ARGS = [
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.relative=false",
  "-c",
  "diff.renames=false",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--raw",
  "--no-abbrev",
  "-z",
  "--no-renames",
  "--ignore-submodules=none",
] as const;

/** The exact bytes of one fixed diff rendering, bounded. */
async function diffBytes(
  run: CarriedPatchGitRunV1,
  args: readonly string[],
  from: GitSha,
  to: GitSha,
): Promise<PortResultV1<Uint8Array>> {
  const result = await run([...args, from, to, "--"], CARRIED_PATCH_MAX_BYTES);
  if (!result.ok) {
    return result.timeout === true || result.overflow === true
      ? portError("unavailable", STATIC_BOUND)
      : portError("unavailable", STATIC_PATCH);
  }
  const bytes = result.stdoutBytes;
  if (bytes === undefined) return portError("unavailable", STATIC_PATCH);
  return portOk(bytes);
}

/** One side's digest and the raw listing it hashed. */
interface SideDigest {
  digest: string;
  raw: Uint8Array;
}

/**
 * SHA-256 (lowercase hex) of one side's exact merge-base change: the decimal
 * byte length of its raw listing and a newline, that listing, then the patch
 * bytes (the length makes the boundary unambiguous).
 */
async function sideDigest(
  run: CarriedPatchGitRunV1,
  from: GitSha,
  to: GitSha,
): Promise<PortResultV1<SideDigest>> {
  const raw = await diffBytes(run, RAW_ARGS, from, to);
  if (!raw.ok) return raw;
  const patch = await diffBytes(run, PATCH_ARGS, from, to);
  if (!patch.ok) return patch;
  const header = new TextEncoder().encode(`${raw.value.byteLength}\n`);
  const input = new Uint8Array(
    header.byteLength + raw.value.byteLength + patch.value.byteLength,
  );
  input.set(header, 0);
  input.set(raw.value, header.byteLength);
  input.set(patch.value, header.byteLength + raw.value.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return portOk({
    digest: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    raw: raw.value,
  });
}

/** `sideDigest`'s digest alone. */
export async function patchDigest(
  run: CarriedPatchGitRunV1,
  from: GitSha,
  to: GitSha,
): Promise<PortResultV1<string>> {
  const side = await sideDigest(run, from, to);
  return side.ok ? portOk(side.value.digest) : side;
}

const RAW_ENTRY =
  /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ADMT])$/;
const ABSENT_MODE = "000000";

/**
 * The change set of one fixed raw listing (`RAW_ARGS`: no renames, so one
 * path per entry), each absent side as null; null for any other shape.
 */
export function parseRawChanges(raw: Uint8Array): CarriedPathChangeV1[] | null {
  const fields = byteString(raw).split("\0");
  if (fields.pop() !== "" || fields.length % 2 !== 0) return null;
  const changes: CarriedPathChangeV1[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const entry = RAW_ENTRY.exec(fields[index]);
    const path = fields[index + 1];
    if (entry === null || path.length === 0) return null;
    const [, oldMode, newMode, oldSha, newSha] = entry;
    changes.push({
      path,
      oldMode: oldMode === ABSENT_MODE ? null : oldMode,
      oldSha: oldMode === ABSENT_MODE ? null : oldSha,
      newMode: newMode === ABSENT_MODE ? null : newMode,
      newSha: newMode === ABSENT_MODE ? null : newSha,
    });
  }
  return changes;
}

/**
 * The drift verdict of two raw listings over the local object store: true
 * when the refreshed change set carries the reviewed one across base drift,
 * false when it does not (or a listing has another shape), a typed failure
 * when a blob it needs cannot be read.
 */
async function driftCarried(
  run: CarriedPatchGitRunV1,
  reviewedRaw: Uint8Array,
  refreshedRaw: Uint8Array,
): Promise<PortResultV1<boolean>> {
  const reviewed = parseRawChanges(reviewedRaw);
  const refreshed = parseRawChanges(refreshedRaw);
  if (reviewed === null || refreshed === null) return portOk(false);
  const verdict = await carriedAcrossDrift(
    reviewed,
    refreshed,
    async (sha): Promise<CarriedBlobReadV1> => {
      const result = await run(
        ["cat-file", "blob", sha],
        CARRIED_DRIFT_MAX_BLOB_BYTES,
      );
      if (result.overflow === true) return "too_large";
      return result.ok && result.stdoutBytes !== undefined
        ? result.stdoutBytes
        : null;
    },
  );
  if (verdict.kind === "unavailable") {
    return portError("unavailable", STATIC_DRIFT);
  }
  return portOk(verdict.kind === "carried");
}

/** The first parent of `head`, or null for a root commit. */
async function firstParent(
  run: CarriedPatchGitRunV1,
  head: GitSha,
): Promise<PortResultV1<GitSha | null>> {
  const result = await run(
    ["rev-list", "--parents", "--max-count=1", head],
    SMALL_OUTPUT_BYTES,
  );
  if (!result.ok) return portError("unavailable", STATIC_LINEAGE);
  const ids = result.stdout.trim().split(" ");
  if (ids[0] !== head || !ids.slice(1).every((id) => isGitSha(id))) {
    return portError("unavailable", STATIC_LINEAGE);
  }
  return portOk(ids.length > 1 ? ids[1] as GitSha : null);
}

/** First-parent commits reachable from `head` but not from `reviewed`. */
async function firstParentDistance(
  run: CarriedPatchGitRunV1,
  reviewed: GitSha,
  head: GitSha,
): Promise<PortResultV1<number>> {
  const result = await run(
    ["rev-list", "--first-parent", "--count", `${reviewed}..${head}`],
    SMALL_OUTPUT_BYTES,
  );
  const text = result.stdout.trim();
  if (!result.ok || !/^(0|[1-9][0-9]{0,8})$/.test(text)) {
    return portError("unavailable", STATIC_LINEAGE);
  }
  return portOk(Number(text));
}

/**
 * The full proof for one request: all four commits must exist locally, each
 * side's merge base must be unique, and each side's patch is hashed; then the
 * refreshed head's first parent and its first-parent distance from the
 * reviewed head.
 */
export async function proveCarriedPatchWithGit(
  run: CarriedPatchGitRunV1,
  request: CarriedPatchRequestV1,
): Promise<PortResultV1<CarriedPatchProofV1>> {
  const { reviewedBase, reviewedHead, base, head } = request;
  if (![reviewedBase, reviewedHead, base, head].every((sha) => isGitSha(sha))) {
    return portError("invalid", STATIC_INPUT);
  }
  for (const sha of [reviewedBase, reviewedHead, base, head]) {
    const exists = await commitExists(run, sha);
    if (!exists.ok) return exists;
    if (!exists.value) return portError("unavailable", STATIC_OBJECT);
  }
  const reviewedMergeBase = await uniqueMergeBase(
    run,
    reviewedBase,
    reviewedHead,
  );
  if (!reviewedMergeBase.ok) return reviewedMergeBase;
  const refreshedMergeBase = await uniqueMergeBase(run, base, head);
  if (!refreshedMergeBase.ok) return refreshedMergeBase;
  const reviewedPatch = await sideDigest(
    run,
    reviewedMergeBase.value,
    reviewedHead,
  );
  if (!reviewedPatch.ok) return reviewedPatch;
  const refreshedPatch = await sideDigest(
    run,
    refreshedMergeBase.value,
    head,
  );
  if (!refreshedPatch.ok) return refreshedPatch;
  const refreshedFrom = await firstParent(run, head);
  if (!refreshedFrom.ok) return refreshedFrom;
  const refreshes = await firstParentDistance(run, reviewedHead, head);
  if (!refreshes.ok) return refreshes;
  // Base drift is decided only where it could matter: a refreshed head on its
  // own tip whose exact digest differs from the reviewed one.
  let drift = false;
  if (
    refreshedMergeBase.value === base &&
    reviewedPatch.value.digest !== refreshedPatch.value.digest
  ) {
    const carried = await driftCarried(
      run,
      reviewedPatch.value.raw,
      refreshedPatch.value.raw,
    );
    if (!carried.ok) return carried;
    drift = carried.value;
  }
  return portOk({
    reviewedMergeBase: reviewedMergeBase.value,
    reviewedPatch: reviewedPatch.value.digest,
    refreshedMergeBase: refreshedMergeBase.value,
    refreshedPatch: refreshedPatch.value.digest,
    refreshedFrom: refreshedFrom.value,
    refreshes: refreshes.value,
    ...(drift ? { driftCarried: true } : {}),
  });
}
