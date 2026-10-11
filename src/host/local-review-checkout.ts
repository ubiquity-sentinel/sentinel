import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";

import { runTrustedGitResult } from "./local-git.ts";
import { dirnamePath, ensurePrivateDir, joinPath } from "./local-io.ts";

// ---------------------------------------------------------------------------
// Independent exact review checkout (trusted host ownership)
// ---------------------------------------------------------------------------

/** Static sanitized failure for one exact review checkout preparation. */
export const STATIC_REVIEW_CHECKOUT =
  "review checkout unavailable: the exact independent review checkout could not be prepared";

export interface PrepareReviewCheckoutInputV1 {
  /** Trusted persistent source object repository (never a model checkout). */
  sourcePath: string;
  /** Independent review checkout directory exposed to the model session. */
  reviewCheckout: string;
  /** Exact committed base that must exist in the review checkout. */
  base: GitSha;
  /** Exact candidate head the review checkout must be detached at. */
  head: GitSha;
  /** Trusted PATH for the Git child only. */
  trustedPath: string;
  /** Private scratch HOME for trusted Git invocations. */
  scratch: string;
}

/**
 * Narrow safe local configuration of a standard independent clone: the ONLY
 * accepted keys and values (exact match, no duplicates). Every other local
 * key, a repeated key or an unexpected value refuses the checkout, so local
 * authority such as hooks, fsmonitor, worktree redirection or checkout filters
 * can never be executed while the checkout is validated or reused.
 */
const REVIEW_CHECKOUT_SAFE_CONFIG = new Map<string, ReadonlySet<string>>([
  ["core.repositoryformatversion", new Set(["0"])],
  ["core.filemode", new Set(["true", "false"])],
  ["core.bare", new Set(["false"])],
  ["core.logallrefupdates", new Set(["true"])],
  ["core.ignorecase", new Set(["true", "false"])],
  ["core.precomposeunicode", new Set(["true", "false"])],
]);

const REVIEW_CHECKOUT_REQUIRED_CONFIG: readonly string[] = [
  "core.repositoryformatversion",
  "core.filemode",
  "core.bare",
  "core.logallrefupdates",
];

/**
 * True only when a `git config --local --no-includes --list` listing contains
 * allowed independent-clone keys with allowed values, no duplicate and every
 * required key. This is a strict equivalence check over Git's own config
 * listing, never a general config parser and never a denylist.
 */
function hasSafeReviewCheckoutConfig(text: string): boolean {
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) return false;
    const key = line.slice(0, separator);
    if (seen.has(key)) return false;
    seen.add(key);
    const allowed = REVIEW_CHECKOUT_SAFE_CONFIG.get(key);
    if (allowed === undefined || !allowed.has(line.slice(separator + 1))) {
      return false;
    }
  }
  for (const key of REVIEW_CHECKOUT_REQUIRED_CONFIG) {
    if (!seen.has(key)) return false;
  }
  return true;
}

/** Exact lstat classification of one critical metadata path (never followed). */
async function metadataEntryKind(
  path: string,
): Promise<"absent" | "file" | "directory" | "other"> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "absent";
    throw error;
  }
  if (info.isSymlink) return "other";
  if (info.isFile) return "file";
  if (info.isDirectory) return "directory";
  return "other";
}

/** Bounded whole-`.git` traversal limits: entries examined and depth below `.git`. */
const REVIEW_CHECKOUT_METADATA_MAX_ENTRIES = 100_000;

const REVIEW_CHECKOUT_METADATA_MAX_DEPTH = 64;

/**
 * Bounded link-free walk of the ENTIRE real `.git` directory. Every entry is
 * classified with `Deno.lstat` and never followed: a symlink, a non-file or
 * non-directory entry, and a regular file with more than one link (shared
 * writable metadata) all refuse the checkout. The walk fails closed beyond its
 * entry or depth bound and on any directory-read or lstat error, and it never
 * modifies anything, so every offending entry and its target are preserved.
 */
async function reviewCheckoutMetadataTreeSafe(
  gitDir: string,
): Promise<boolean> {
  let entries = 0;
  const visit = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > REVIEW_CHECKOUT_METADATA_MAX_DEPTH) return false;
    try {
      for await (const entry of Deno.readDir(directory)) {
        entries++;
        if (entries > REVIEW_CHECKOUT_METADATA_MAX_ENTRIES) return false;
        const path = joinPath(directory, entry.name);
        const info = await Deno.lstat(path);
        if (info.isSymlink) return false;
        if (info.isFile) {
          if (info.nlink !== 1) return false;
          continue;
        }
        if (!info.isDirectory) return false;
        if (!(await visit(path, depth + 1))) return false;
      }
    } catch {
      return false;
    }
    return true;
  };
  return await visit(gitDir, 1);
}

/**
 * Verify the exposed checkout's local Git metadata BEFORE any command that can
 * execute config hooks or filters: `.git` must be a real directory (never a
 * file pointer or symlink), commondir/alternates/grafts redirection must be
 * absent, and config, HEAD, index (when present), objects, refs and info must
 * be real local entries. A bounded link-free walk then classifies EVERY entry
 * of the real `.git` directory, including FETCH_HEAD, logs descendants and
 * objects/pack descendants: symlinks, special entries, hardlinked regular
 * files and any walk beyond its entry/depth bounds are refused. Every refusal
 * preserves the offending entry and its target exactly.
 */
async function reviewCheckoutMetadataSafe(
  reviewCheckout: string,
): Promise<boolean> {
  const gitDir = joinPath(reviewCheckout, ".git");
  if (await metadataEntryKind(gitDir) !== "directory") return false;
  const forbidden = [
    "commondir",
    joinPath("objects", "info", "alternates"),
    joinPath("objects", "info", "http-alternates"),
    joinPath("info", "grafts"),
  ];
  for (const relative of forbidden) {
    if (await metadataEntryKind(joinPath(gitDir, relative)) !== "absent") {
      return false;
    }
  }
  for (const relative of ["config", "HEAD"]) {
    if (await metadataEntryKind(joinPath(gitDir, relative)) !== "file") {
      return false;
    }
  }
  for (const relative of ["objects", "refs", "info"]) {
    if (await metadataEntryKind(joinPath(gitDir, relative)) !== "directory") {
      return false;
    }
  }
  const objectsInfo = await metadataEntryKind(
    joinPath(gitDir, "objects", "info"),
  );
  if (objectsInfo !== "absent" && objectsInfo !== "directory") return false;
  const index = await metadataEntryKind(joinPath(gitDir, "index"));
  if (index !== "absent" && index !== "file") return false;
  return await reviewCheckoutMetadataTreeSafe(gitDir);
}

/**
 * Classify the durable review checkout path: an absent path and an existing
 * EMPTY directory may be initialized, an existing nonempty directory is only
 * ever reused under verification (never deleted), and a symlink or plain file
 * is refused before any Git runs. Nothing is deleted or reset here.
 */
async function reviewCheckoutState(
  path: string,
): Promise<"fresh" | "reuse" | "blocked"> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "fresh";
    throw error;
  }
  if (info.isSymlink || !info.isDirectory) return "blocked";
  for await (const _entry of Deno.readDir(path)) return "reuse";
  return "fresh";
}

/**
 * Trusted preparation of the ONE independent review checkout.
 *
 * The checkout is a real `--no-hardlinks` clone of the trusted source object
 * repository with its own `.git` directory and independent objects: no `.git`
 * file pointer, symlinked metadata, alternates, shared writable metadata,
 * hooks or credential-bearing config, and no remote after preparation. Only
 * the exact base/head objects are fetched from the trusted local source (no
 * network, no credentials), then the checkout is detached at the exact head.
 * A reused nonempty directory is verified (real local `.git` metadata with no
 * commondir/alternates/graft redirection, symlinked or hardlinked metadata or
 * special `.git` entries, an exact safe-local-config allowlist through Git's
 * own `--local --no-includes` listing, no loose or packed `refs/replace/`
 * entry, and an actual `--absolute-git-dir`/`--show-toplevel` identity bound
 * to the exact real checkout paths) BEFORE any Git command that could execute a
 * config hook or filter, and clean tracked AND untracked state is proved before
 * it is changed; unexpected data is preserved and reported, never reset,
 * cleaned or erased. Every failure returns the same sanitized unavailable
 * result and never escapes as a thrown host error.
 */
export async function prepareReviewCheckout(
  input: PrepareReviewCheckoutInputV1,
): Promise<PortResultV1<void>> {
  if (!isGitSha(input.base) || !isGitSha(input.head)) {
    return portError("unavailable", STATIC_REVIEW_CHECKOUT);
  }
  const parent = dirnamePath(input.reviewCheckout);
  const git = (args: string[]) =>
    runTrustedGitResult({
      args,
      cwd: parent,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    });
  const trustedMetadata = async (): Promise<boolean> => {
    if (!(await reviewCheckoutMetadataSafe(input.reviewCheckout))) return false;
    // Git's own local listing without includes is read only AFTER the metadata
    // paths proved real, so no config hook or filter can run first.
    const config = await git([
      "-C",
      input.reviewCheckout,
      "config",
      "--local",
      "--no-includes",
      "--list",
    ]);
    if (config.code !== 0) return false;
    if (!hasSafeReviewCheckoutConfig(config.stdout)) return false;
    // Loose AND packed `refs/replace/` entries are refused here, BEFORE any
    // fetch, checkout or status: replacement refs would otherwise make model
    // Git read content other than the exact objects bound by the manifest.
    const replacements = await git([
      "-C",
      input.reviewCheckout,
      "for-each-ref",
      "--format=%(refname)",
      "refs/replace/",
    ]);
    return replacements.code === 0 &&
      replacements.stdout.trim().length === 0;
  };
  /**
   * Bind the actual repository identity Git would use to the exact real
   * checkout and `.git` paths before any fetch, checkout or status runs, so a
   * worktree/commondir redirection that survived metadata acceptance can never
   * operate on another directory.
   */
  const bindIdentity = async (): Promise<boolean> => {
    let realCheckout: string;
    let realGitDir: string;
    try {
      realCheckout = await Deno.realPath(input.reviewCheckout);
      realGitDir = await Deno.realPath(joinPath(input.reviewCheckout, ".git"));
    } catch {
      return false;
    }
    if (realGitDir !== joinPath(realCheckout, ".git")) return false;
    const absoluteGitDir = await git([
      "-C",
      input.reviewCheckout,
      "rev-parse",
      "--absolute-git-dir",
    ]);
    if (
      absoluteGitDir.code !== 0 ||
      absoluteGitDir.stdout.trim() !== realGitDir
    ) {
      return false;
    }
    const topLevel = await git([
      "-C",
      input.reviewCheckout,
      "rev-parse",
      "--show-toplevel",
    ]);
    return topLevel.code === 0 && topLevel.stdout.trim() === realCheckout;
  };
  const cleanCheckout = async (): Promise<boolean> => {
    const status = await git([
      "-C",
      input.reviewCheckout,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    return status.code === 0 && status.stdout.trim().length === 0;
  };
  const trustedCheckout = async (): Promise<boolean> =>
    await trustedMetadata() && await bindIdentity() && await cleanCheckout();
  try {
    await ensurePrivateDir(parent);
    const state = await reviewCheckoutState(input.reviewCheckout);
    if (state === "blocked") {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    if (state === "fresh") {
      await ensurePrivateDir(input.reviewCheckout);
      const cloned = await git([
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        input.sourcePath,
        input.reviewCheckout,
      ]);
      if (cloned.code !== 0) {
        return portError("unavailable", STATIC_REVIEW_CHECKOUT);
      }
      // Remove the clone's transport authority BEFORE the checkout is exposed
      // to any model tool: no origin, no push/fetch target remains.
      const removed = await git([
        "-C",
        input.reviewCheckout,
        "remote",
        "remove",
        "origin",
      ]);
      if (removed.code !== 0) {
        return portError("unavailable", STATIC_REVIEW_CHECKOUT);
      }
      // A fresh `--no-checkout` clone has an empty index, so metadata, safe
      // config and the bound repository identity are verified here;
      // tracked/untracked cleanliness is proved after the exact detached
      // checkout below.
      if (!(await trustedMetadata())) {
        return portError("unavailable", STATIC_REVIEW_CHECKOUT);
      }
      if (!(await bindIdentity())) {
        return portError("unavailable", STATIC_REVIEW_CHECKOUT);
      }
    } else if (!(await trustedCheckout())) {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    // Fetch only the exact base/head objects from the trusted local source; a
    // request denied for an object the local clone already carries is not
    // fatal, but the exact objects must then already be present below.
    for (const sha of [input.head, input.base]) {
      await git([
        "-C",
        input.reviewCheckout,
        "fetch",
        "--no-tags",
        input.sourcePath,
        sha,
      ]);
    }
    for (const sha of [input.head, input.base]) {
      const present = await git([
        "-C",
        input.reviewCheckout,
        "cat-file",
        "-e",
        `${sha}^{commit}`,
      ]);
      if (present.code !== 0) {
        return portError("unavailable", STATIC_REVIEW_CHECKOUT);
      }
    }
    const detached = await git([
      "-C",
      input.reviewCheckout,
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "--detach",
      input.head,
    ]);
    if (detached.code !== 0) {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    const head = await git(["-C", input.reviewCheckout, "rev-parse", "HEAD"]);
    if (head.code !== 0 || head.stdout.trim() !== input.head) {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    const symbolic = await git([
      "-C",
      input.reviewCheckout,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    if (symbolic.code !== 0 || symbolic.stdout.trim() !== "HEAD") {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    if (!(await trustedCheckout())) {
      return portError("unavailable", STATIC_REVIEW_CHECKOUT);
    }
    return portOk(undefined);
  } catch {
    return portError("unavailable", STATIC_REVIEW_CHECKOUT);
  }
}
