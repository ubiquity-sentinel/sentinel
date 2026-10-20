/**
 * T03 checkpoint: bounded trusted Git review snapshot manifest.
 *
 * One concrete immutable manifest of the exact candidate change a structured
 * review is performed against. The manifest is built from the trusted local
 * Git OBJECT repository (never from mutable working files) with fixed argv,
 * a cleared credential-free child environment and finite bounds on the whole
 * operation, every read and the aggregate review prompt.
 *
 * The snapshot deliberately carries NO diff text and NO file contents: it is
 * a complete changed-path manifest with the exact Git object identities and
 * modes of both sides plus the candidate line count. The reviewer inspects
 * the exact base/head blobs through the attached independent checkout, so an
 * aggregate diff or a single large blob can never overflow the review prompt.
 *
 * Trusted process lifetime reuses the accepted `DenoReplayRuntime` (owned
 * process group, complete child environment, deadline over the full
 * subprocess + stream lifetime). Executing trusted Git with fixed argv does
 * not assert any sandbox for target code; no shell, network, fetch, hook,
 * external-diff/text-conversion, replace-object, fsmonitor or global/system
 * configuration is reachable.
 *
 * Fail-closed: binary blobs, symlinks, submodules, unsupported modes, unsafe
 * paths, nonintegrated (stale) bases, non-UTF-8 content and any over-bound
 * output are rejected as `unavailable` — content is never omitted, truncated
 * or fabricated.
 */

import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import { containsSecretShapedText } from "../replay/fixture.ts";
import { GitSnapshotCapture } from "./snapshot-capture.ts";
import {
  DETERMINISTIC_PUBLICATION_DETAILS,
  MAX_FILE_BYTES,
  MAX_METADATA_BYTES,
  MAX_NEW_COMMITS,
  MAX_NEW_OBJECTS,
  MAX_PROMPT_BYTES,
  MAX_TREE_ENTRY_BYTES,
  MAX_TREE_READ_BYTES,
  NO_SUBMODULE_IGNORE,
  PUBLICATION_BINARY_DETAIL,
  PUBLICATION_BOUND_DETAIL,
  PUBLICATION_COMMIT_BOUND_DETAIL,
  PUBLICATION_COMMIT_DETAIL,
  PUBLICATION_EMPTY_DETAIL,
  PUBLICATION_FILE_BOUND_DETAIL,
  PUBLICATION_INPUT_DETAIL,
  PUBLICATION_ISSUE_DETAIL,
  PUBLICATION_LIST_DETAIL,
  PUBLICATION_METADATA_BOUND_DETAIL,
  PUBLICATION_METADATA_DETAIL,
  PUBLICATION_METADATA_SECRET_DETAIL,
  PUBLICATION_OBJECT_BOUND_DETAIL,
  PUBLICATION_PROTECTED_DETAIL,
  PUBLICATION_PROTECTED_INPUT_DETAIL,
  PUBLICATION_PUBLISHED_HEAD_DETAIL,
  PUBLICATION_SECRET_DETAIL,
  PUBLICATION_STALE_BASE_DETAIL,
  PUBLICATION_STRUCTURE_DETAIL,
  PUBLICATION_UTF8_DETAIL,
  RAW_READ_BYTES,
  SCALAR_READ_BYTES,
  SNAPSHOT_OVERBOUND_DETAIL,
} from "./snapshot-policy.ts";
import {
  hasIssueClosingReference,
  isDirectoryTreeEntry,
  normalizeProtectedPaths,
  parseCommitParents,
  parseProtectedTreeEntry,
  parseRawChanges,
  parseRootTreeBlobs,
  parseShaList,
  protectedAncestorPaths,
  type ProtectedTreeEntryV1,
  publicationReadDetail,
  publicationStructureDetail,
  sameProtectedAncestor,
  sameProtectedEntry,
  shaListBytes,
} from "./snapshot-git-wire.ts";
import type { GitReadV1 } from "./snapshot-reader.ts";

export class GitReviewSnapshot extends GitSnapshotCapture {
  /**
   * Bounded negative publication check for one exact candidate head.
   *
   * The caller supplies the authenticated exact `base`, the candidate `head`
   * and the prior published head (or null). This method has no credentials and
   * no remote transport: it reads only the trusted local Git object repository
   * through the same fixed argv, cleared child environment, whole-operation
   * deadline, runtime and finite output bounds `capture` uses.
   *
   * The checked publication set is exactly `Reach(head)` minus `Reach(base)`
   * minus `Reach(publishedHead)` — every newly exposed commit and object, not
   * merely the final `base...head` tree diff. Each newly exposed commit's raw
   * metadata must be bounded text without secret-shaped material and without
   * GitHub issue-closing references; every parent edge must have a complete,
   * bounded, structurally supported changed-path/type/mode view; and every
   * newly exposed blob (including intermediate content that later commits
   * delete or revert) must be bounded text, valid UTF-8, NUL-free and free of
   * secret-shaped material.
   *
   * Protected paths are the repository config's exact relative path or
   * trailing-slash subtree entries. For each newly exposed commit, each
   * protected path and each of its ancestors is read as one exact literal
   * `ls-tree -z --full-tree` entry from the trusted local object repository
   * (empty exit-0 output proves absence; malformed, multiple or over-bound
   * output fails closed). A protected entry's existence, mode, type and object
   * SHA — the subtree SHA for a directory — must equal the trusted `base`
   * entry exactly, so an explicit empty tree entry is never hidden by an empty
   * leaf diff. Ancestors compare existence, mode and type only and must be
   * directories when present: ancestor tree SHAs are deliberately not compared
   * because they legitimately change for allowed siblings, while a blocked or
   * replaced ancestor makes the protected entry unprovable.
   *
   * Success is only this negative publication check. It is never a complete
   * sanitization claim and never a durability receipt: textual, structurally
   * supported, non-secret-shaped, non-issue-closing content can still be a bad
   * candidate. A nonnull `publishedHead` is trusted as already validated, so
   * its history is excluded rather than re-inspected; in the H2 refresh case
   * (an old candidate merged with an authenticated new base) the merge commit
   * is validated against the new base while protected base changes on the
   * `publishedHead` parent edge stay legitimate.
   */
  async validatePublication(input: {
    base: GitSha;
    head: GitSha;
    publishedHead: GitSha | null;
    protectedPaths: readonly string[];
  }): Promise<PortResultV1<void>> {
    const base = input?.base;
    const head = input?.head;
    const publishedHead = input?.publishedHead ?? null;
    if (
      !isGitSha(base) || !isGitSha(head) ||
      (publishedHead !== null && !isGitSha(publishedHead))
    ) {
      return portError("unavailable", PUBLICATION_INPUT_DETAIL);
    }
    const protectedPaths = normalizeProtectedPaths(input?.protectedPaths);
    if (protectedPaths === null) {
      return portError("unavailable", PUBLICATION_PROTECTED_INPUT_DETAIL);
    }
    const deadline = this.now() + this.totalDeadlineMs;
    let inspectedBytes = 0;
    const fail = (detail: string): PortResultV1<never> => {
      const normalized = publicationReadDetail(detail);
      return portError(
        DETERMINISTIC_PUBLICATION_DETAILS.includes(normalized)
          ? "invalid"
          : "unavailable",
        normalized,
      );
    };
    const readTracked = async (
      args: readonly string[],
      allowExitCodes: readonly number[],
      maxOutputBytes: number,
    ): Promise<GitReadV1> => {
      const result = await this.read(
        args,
        allowExitCodes,
        maxOutputBytes,
        deadline,
      );
      if (!result.ok) return result;
      inspectedBytes += result.bytes.byteLength;
      return inspectedBytes > MAX_PROMPT_BYTES
        ? { ok: false, detail: PUBLICATION_BOUND_DETAIL }
        : result;
    };

    const trustedShas: GitSha[] = publishedHead === null
      ? [base, head]
      : [base, head, publishedHead];
    for (const sha of trustedShas) {
      const resolved = await readTracked(
        ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
        [0],
        SCALAR_READ_BYTES,
      );
      if (!resolved.ok) return fail(resolved.detail);
      if (this.text(resolved.bytes)?.trim() !== sha) {
        return fail(PUBLICATION_COMMIT_DETAIL);
      }
    }

    const ancestor = await readTracked(
      ["merge-base", "--is-ancestor", base, head],
      [0, 1],
      SCALAR_READ_BYTES,
    );
    if (!ancestor.ok) return fail(ancestor.detail);
    if (ancestor.exitCode !== 0) return fail(PUBLICATION_STALE_BASE_DETAIL);
    if (publishedHead !== null) {
      const publishedAncestor = await readTracked(
        ["merge-base", "--is-ancestor", publishedHead, head],
        [0, 1],
        SCALAR_READ_BYTES,
      );
      if (!publishedAncestor.ok) return fail(publishedAncestor.detail);
      if (publishedAncestor.exitCode !== 0) {
        return fail(PUBLICATION_PUBLISHED_HEAD_DETAIL);
      }
    }

    const excluded = publishedHead === null
      ? [`^${base}`]
      : [`^${base}`, `^${publishedHead}`];
    const commitList = await readTracked(
      ["rev-list", head, ...excluded],
      [0],
      shaListBytes(MAX_NEW_COMMITS),
    );
    if (!commitList.ok) return fail(commitList.detail);
    const commitListText = this.text(commitList.bytes);
    if (commitListText === null) return fail(PUBLICATION_LIST_DETAIL);
    const newCommits = parseShaList(commitListText);
    if (newCommits === null) return fail(PUBLICATION_LIST_DETAIL);
    if (newCommits.length > MAX_NEW_COMMITS) {
      return fail(PUBLICATION_COMMIT_BOUND_DETAIL);
    }
    if (newCommits.length === 0) return fail(PUBLICATION_EMPTY_DETAIL);

    const objectList = await readTracked(
      ["rev-list", "--objects", "--no-object-names", head, ...excluded],
      [0],
      shaListBytes(MAX_NEW_OBJECTS),
    );
    if (!objectList.ok) return fail(objectList.detail);
    const objectListText = this.text(objectList.bytes);
    if (objectListText === null) return fail(PUBLICATION_LIST_DETAIL);
    const newObjects = parseShaList(objectListText);
    if (newObjects === null) return fail(PUBLICATION_LIST_DETAIL);
    if (newObjects.length > MAX_NEW_OBJECTS) {
      return fail(PUBLICATION_OBJECT_BOUND_DETAIL);
    }
    const newlyExposed = new Set(newObjects);
    for (const commit of newCommits) {
      if (!newlyExposed.has(commit)) return fail(PUBLICATION_LIST_DETAIL);
    }

    // Candidate blobs are collected only from complete parent-edge views and
    // from the recursive tree of a newly exposed root commit; the set filter
    // below then keeps exactly the objects that are newly exposed, so trusted
    // base history is never re-inspected and no intermediate blob is hidden.
    const candidateBlobs = new Set<string>();

    // Exact protected-entry identity: for every newly exposed commit, each
    // configured protected path and each of its ancestors is read as one
    // literal `ls-tree` entry instead of inferring identity from a diff.
    // Entries are immutable within each commit: shared ancestors and entries
    // are read at most once per commit in this invocation. Absence is proven
    // only by exit-0 empty output; malformed,
    // multiple or over-bound output fails closed.
    const trustedProtectedEntries = new Map<string, ProtectedTreeEntryV1>();
    const protectedEntries = new Map<string, ProtectedTreeEntryV1>();
    const readProtectedEntry = async (
      commit: string,
      path: string,
    ): Promise<PortResultV1<ProtectedTreeEntryV1>> => {
      const key = `${commit}:${path}`;
      const cached = protectedEntries.get(key);
      if (cached !== undefined) return portOk(cached);
      const read = await readTracked(
        ["ls-tree", "-z", "--full-tree", commit, "--", path],
        [0],
        MAX_TREE_ENTRY_BYTES,
      );
      if (!read.ok) {
        return fail(
          read.detail === SNAPSHOT_OVERBOUND_DETAIL
            ? PUBLICATION_PROTECTED_DETAIL
            : read.detail,
        );
      }
      const text = this.text(read.bytes);
      if (text === null) {
        return fail(PUBLICATION_PROTECTED_DETAIL);
      }
      const entry = parseProtectedTreeEntry(text, path);
      if (entry === null) {
        return fail(PUBLICATION_PROTECTED_DETAIL);
      }
      protectedEntries.set(key, entry);
      return portOk(entry);
    };
    const readTrustedProtectedEntry = async (
      path: string,
    ): Promise<PortResultV1<ProtectedTreeEntryV1>> => {
      const cached = trustedProtectedEntries.get(path);
      if (cached !== undefined) return portOk(cached);
      const read = await readProtectedEntry(base, path);
      if (!read.ok) return read;
      trustedProtectedEntries.set(path, read.value);
      return read;
    };

    for (const commit of newCommits) {
      const metadata = await readTracked(
        ["cat-file", "commit", commit],
        [0],
        MAX_METADATA_BYTES,
      );
      if (!metadata.ok) {
        return fail(
          metadata.detail === SNAPSHOT_OVERBOUND_DETAIL
            ? PUBLICATION_METADATA_BOUND_DETAIL
            : metadata.detail,
        );
      }
      const metadataText = this.text(metadata.bytes);
      if (metadataText === null) {
        return portError("invalid", PUBLICATION_METADATA_DETAIL);
      }
      if (containsSecretShapedText(metadata.bytes)) {
        return portError("invalid", PUBLICATION_METADATA_SECRET_DETAIL);
      }
      if (hasIssueClosingReference(metadataText)) {
        return portError("invalid", PUBLICATION_ISSUE_DETAIL);
      }
      const parents = parseCommitParents(metadataText);
      if (parents === null) {
        return portError("invalid", PUBLICATION_METADATA_DETAIL);
      }

      if (protectedPaths.length > 0) {
        for (const protectedPath of protectedPaths) {
          for (const ancestor of protectedAncestorPaths(protectedPath)) {
            const candidateAncestor = await readProtectedEntry(
              commit,
              ancestor,
            );
            if (!candidateAncestor.ok) {
              return fail(candidateAncestor.error.detail);
            }
            const trustedAncestor = await readTrustedProtectedEntry(ancestor);
            if (!trustedAncestor.ok) return fail(trustedAncestor.error.detail);
            if (
              !sameProtectedAncestor(
                candidateAncestor.value,
                trustedAncestor.value,
              ) ||
              !isDirectoryTreeEntry(candidateAncestor.value) ||
              !isDirectoryTreeEntry(trustedAncestor.value)
            ) {
              return fail(PUBLICATION_PROTECTED_DETAIL);
            }
          }
          const candidateEntry = await readProtectedEntry(
            commit,
            protectedPath,
          );
          if (!candidateEntry.ok) return fail(candidateEntry.error.detail);
          const trustedEntry = await readTrustedProtectedEntry(protectedPath);
          if (!trustedEntry.ok) return fail(trustedEntry.error.detail);
          if (!sameProtectedEntry(candidateEntry.value, trustedEntry.value)) {
            return fail(PUBLICATION_PROTECTED_DETAIL);
          }
        }
      }

      if (parents.length === 0) {
        const rootTree = await readTracked(
          ["ls-tree", "-r", "-z", "--full-tree", commit],
          [0],
          MAX_TREE_READ_BYTES,
        );
        if (!rootTree.ok) return fail(rootTree.detail);
        const rootTreeText = this.text(rootTree.bytes);
        if (rootTreeText === null) return fail(PUBLICATION_STRUCTURE_DETAIL);
        const listed = parseRootTreeBlobs(rootTreeText);
        if (!listed.ok) return fail(listed.detail);
        for (const blob of listed.blobs) candidateBlobs.add(blob);
        continue;
      }
      // A commit with the trusted base as a parent is completely described by
      // its base edge: every entry missing from that edge IS the trusted base
      // entry. Its other edges (H1 -> H2 of a base refresh) only replay trusted
      // base history, which grows with every base movement and must never make
      // a refresh structurally over-bound; any other parent is trusted history
      // (base or `publishedHead`) or newly exposed and inspected on its own.
      const edgeParents = parents.includes(base) ? [base] : parents;
      for (const parent of edgeParents) {
        const edge = await readTracked(
          [
            "diff",
            "--raw",
            "-z",
            "--no-renames",
            "--no-abbrev",
            "--no-ext-diff",
            NO_SUBMODULE_IGNORE,
            parent,
            commit,
          ],
          [0],
          RAW_READ_BYTES,
        );
        if (!edge.ok) return fail(edge.detail);
        const edgeText = this.text(edge.bytes);
        if (edgeText === null) return fail(PUBLICATION_STRUCTURE_DETAIL);
        const changes = parseRawChanges(edgeText);
        if (changes === null) return fail(PUBLICATION_STRUCTURE_DETAIL);
        const structuralDetail = this.validateChanges(changes);
        if (structuralDetail !== null) {
          return fail(publicationStructureDetail(structuralDetail));
        }
        for (const change of changes) {
          if (change.status !== "D") candidateBlobs.add(change.newBlob);
        }
      }
    }

    for (const blob of candidateBlobs) {
      if (!newlyExposed.has(blob)) continue;
      const content = await readTracked(
        ["cat-file", "blob", blob],
        [0],
        MAX_FILE_BYTES,
      );
      if (!content.ok) {
        return fail(
          content.detail === SNAPSHOT_OVERBOUND_DETAIL
            ? PUBLICATION_FILE_BOUND_DETAIL
            : content.detail,
        );
      }
      if (content.bytes.includes(0)) return fail(PUBLICATION_BINARY_DETAIL);
      if (this.text(content.bytes) === null) {
        return fail(PUBLICATION_UTF8_DETAIL);
      }
      if (containsSecretShapedText(content.bytes)) {
        return fail(PUBLICATION_SECRET_DETAIL);
      }
    }

    return portOk(undefined);
  }
}

export { MAX_SNAPSHOT_TOTAL_MS } from "./snapshot-policy.ts";
export { MAX_CHANGED_PATHS } from "./snapshot-policy.ts";
export { MAX_PROMPT_BYTES } from "./snapshot-policy.ts";
export { MAX_FILE_BYTES } from "./snapshot-policy.ts";
export { MAX_CAPTURE_BLOB_BYTES } from "./snapshot-policy.ts";
export { MAX_PATH_CHARS } from "./snapshot-policy.ts";
export { SNAPSHOT_VERSION } from "./snapshot-policy.ts";
export { MAX_NEW_COMMITS } from "./snapshot-policy.ts";
export { MAX_NEW_OBJECTS } from "./snapshot-policy.ts";
export { MAX_COMMIT_PARENTS } from "./snapshot-policy.ts";
export { MAX_PROTECTED_PATHS } from "./snapshot-policy.ts";
export { SNAPSHOT_DIGEST_DETAIL } from "./snapshot-policy.ts";
export { isSafeReviewPath } from "./snapshot-manifest.ts";
export { isGeneratedArtifactPath } from "./snapshot-manifest.ts";
export { generatedArtifactOnly } from "./snapshot-manifest.ts";
export { countCandidateLines } from "./snapshot-manifest.ts";
export type { ReviewSnapshotFileV1 } from "./snapshot-manifest.ts";
export type { ReviewSnapshotV1 } from "./snapshot-manifest.ts";
export { reviewSnapshotDigest } from "./snapshot-manifest.ts";
export { verifyReviewSnapshotDigest } from "./snapshot-manifest.ts";
export { validateReviewSnapshotV1 } from "./snapshot-manifest.ts";
export { renderReviewPrompt } from "./snapshot-manifest.ts";
export type { GitReviewSnapshotOptionsV1 } from "./snapshot-reader.ts";
export { BASE_TASK_INSTRUCTIONS } from "./snapshot-manifest.ts";
