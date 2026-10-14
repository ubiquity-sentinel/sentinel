// snapshot capture.

import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import { GitSnapshotReader } from "./snapshot-reader.ts";
import {
  countCandidateLines,
  isRegularMode,
  isSafeReviewPath,
  renderReviewPrompt,
  reviewSnapshotDigest,
  type ReviewSnapshotFileV1,
  type ReviewSnapshotV1,
  utf8Bytes,
} from "./snapshot-manifest.ts";
import {
  MAX_CAPTURE_BLOB_BYTES,
  MAX_CHANGED_PATHS,
  MAX_PROMPT_BYTES,
  NO_SUBMODULE_IGNORE,
  RAW_READ_BYTES,
  SCALAR_READ_BYTES,
  SNAPSHOT_BINARY_DETAIL,
  SNAPSHOT_COMMIT_DETAIL,
  SNAPSHOT_EMPTY_DETAIL,
  SNAPSHOT_FILE_BOUND_DETAIL,
  SNAPSHOT_INPUT_DETAIL,
  SNAPSHOT_MERGE_BASE_DETAIL,
  SNAPSHOT_MODE_DETAIL,
  SNAPSHOT_OVERBOUND_DETAIL,
  SNAPSHOT_PATH_DETAIL,
  SNAPSHOT_PATHS_DETAIL,
  SNAPSHOT_PROMPT_BOUND_DETAIL,
  SNAPSHOT_RAW_DETAIL,
  SNAPSHOT_STALE_BASE_DETAIL,
  SNAPSHOT_STATUS_DETAIL,
  SNAPSHOT_SUBMODULE_DETAIL,
  SNAPSHOT_SYMLINK_DETAIL,
  SNAPSHOT_UTF8_DETAIL,
  SNAPSHOT_VERSION,
  ZERO_MODE,
  ZERO_SHA,
} from "./snapshot-policy.ts";
import {
  numstatHasBinary,
  numstatRecordCount,
  parseRawChanges,
  type RawChangeV1,
} from "./snapshot-git-wire.ts";

export abstract class GitSnapshotCapture extends GitSnapshotReader {
  /**
   * Capture the exact immutable changed-path manifest for `base...head`. Ready
   * and immutable on success; every unsupported/incomplete/over-bound input is
   * rejected as `unavailable` instead of being omitted or truncated.
   */
  async capture(input: {
    base: GitSha;
    head: GitSha;
  }): Promise<PortResultV1<ReviewSnapshotV1>> {
    if (!isGitSha(input?.base) || !isGitSha(input?.head)) {
      return portError("unavailable", SNAPSHOT_INPUT_DETAIL);
    }
    const deadline = this.now() + this.totalDeadlineMs;

    const baseRead = await this.read(
      ["rev-parse", "--verify", "--quiet", `${input.base}^{commit}`],
      [0],
      SCALAR_READ_BYTES,
      deadline,
    );
    if (!baseRead.ok) return portError("unavailable", baseRead.detail);
    if (this.text(baseRead.bytes)?.trim() !== input.base) {
      return portError("unavailable", SNAPSHOT_COMMIT_DETAIL);
    }
    const headRead = await this.read(
      ["rev-parse", "--verify", "--quiet", `${input.head}^{commit}`],
      [0],
      SCALAR_READ_BYTES,
      deadline,
    );
    if (!headRead.ok) return portError("unavailable", headRead.detail);
    if (this.text(headRead.bytes)?.trim() !== input.head) {
      return portError("unavailable", SNAPSHOT_COMMIT_DETAIL);
    }

    const ancestor = await this.read(
      ["merge-base", "--is-ancestor", input.base, input.head],
      [0, 1],
      SCALAR_READ_BYTES,
      deadline,
    );
    if (!ancestor.ok) return portError("unavailable", ancestor.detail);
    if (ancestor.exitCode !== 0) {
      return portError("unavailable", SNAPSHOT_STALE_BASE_DETAIL);
    }
    const mergeBase = await this.read(
      ["merge-base", input.base, input.head],
      [0],
      SCALAR_READ_BYTES,
      deadline,
    );
    if (!mergeBase.ok) return portError("unavailable", mergeBase.detail);
    if (this.text(mergeBase.bytes)?.trim() !== input.base) {
      return portError("unavailable", SNAPSHOT_MERGE_BASE_DETAIL);
    }

    const range = `${input.base}...${input.head}`;
    const raw = await this.read(
      [
        "diff",
        "--raw",
        "-z",
        "--no-renames",
        "--no-abbrev",
        "--no-ext-diff",
        NO_SUBMODULE_IGNORE,
        range,
      ],
      [0],
      RAW_READ_BYTES,
      deadline,
    );
    if (!raw.ok) return portError("unavailable", raw.detail);
    const rawText = this.text(raw.bytes);
    if (rawText === null) return portError("unavailable", SNAPSHOT_RAW_DETAIL);
    const changes = parseRawChanges(rawText);
    if (changes === null) return portError("unavailable", SNAPSHOT_RAW_DETAIL);
    if (changes.length === 0) {
      return portError("unavailable", SNAPSHOT_EMPTY_DETAIL);
    }
    const structuralDetail = this.validateChanges(changes);
    if (structuralDetail !== null) {
      return portError("unavailable", structuralDetail);
    }

    const numstat = await this.read(
      [
        "diff",
        "--numstat",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        NO_SUBMODULE_IGNORE,
        range,
      ],
      [0],
      RAW_READ_BYTES,
      deadline,
    );
    if (!numstat.ok) return portError("unavailable", numstat.detail);
    const numstatText = this.text(numstat.bytes);
    if (numstatText === null) {
      return portError("unavailable", SNAPSHOT_RAW_DETAIL);
    }
    if (numstatRecordCount(numstatText) !== changes.length) {
      return portError("unavailable", SNAPSHOT_RAW_DETAIL);
    }
    if (numstatHasBinary(numstatText)) {
      return portError("unavailable", SNAPSHOT_BINARY_DETAIL);
    }

    // Every nonzero old and new regular-file blob is inspected by one bounded
    // exact object read for NUL bytes and fatal UTF-8, including deleted and
    // replaced old blobs: a mutable `.gitattributes` forcing a textual diff
    // cannot make a binary blob pass the numstat heuristics unnoticed. The
    // cache holds only validity and derived line metadata keyed by exact
    // object identity for THIS capture; every decoded content value is
    // discarded immediately and no blob content enters the snapshot value.
    const blobCache = new Map<
      string,
      { ok: true; lines: number } | { ok: false; detail: string }
    >();
    const inspectBlob = async (
      sha: string,
    ): Promise<
      { ok: true; lines: number } | { ok: false; detail: string }
    > => {
      const cached = blobCache.get(sha);
      if (cached !== undefined) return cached;
      let inspected:
        | { ok: true; lines: number }
        | { ok: false; detail: string };
      const blob = await this.read(
        ["cat-file", "blob", sha],
        [0],
        MAX_CAPTURE_BLOB_BYTES,
        deadline,
      );
      if (!blob.ok) {
        inspected = {
          ok: false,
          detail: blob.detail === SNAPSHOT_OVERBOUND_DETAIL
            ? SNAPSHOT_FILE_BOUND_DETAIL
            : blob.detail,
        };
      } else if (blob.bytes.includes(0)) {
        inspected = { ok: false, detail: SNAPSHOT_BINARY_DETAIL };
      } else {
        const content = this.text(blob.bytes);
        inspected = content === null
          ? { ok: false, detail: SNAPSHOT_UTF8_DETAIL }
          : { ok: true, lines: countCandidateLines(content) };
      }
      blobCache.set(sha, inspected);
      return inspected;
    };

    const files: ReviewSnapshotFileV1[] = [];
    for (const change of changes) {
      if (change.oldBlob !== ZERO_SHA) {
        const old = await inspectBlob(change.oldBlob);
        if (!old.ok) return portError("unavailable", old.detail);
      }
      if (change.status === "D") {
        files.push({
          path: change.path,
          kind: "deleted",
          oldBlob: change.oldBlob,
          newBlob: change.newBlob,
          oldMode: change.oldMode,
          newMode: change.newMode,
          candidateLines: null,
        });
        continue;
      }
      const candidate = await inspectBlob(change.newBlob);
      if (!candidate.ok) return portError("unavailable", candidate.detail);
      files.push({
        path: change.path,
        kind: change.status === "A" ? "added" : "modified",
        oldBlob: change.oldBlob,
        newBlob: change.newBlob,
        oldMode: change.oldMode,
        newMode: change.newMode,
        candidateLines: candidate.lines,
      });
    }

    const draft: ReviewSnapshotV1 = {
      version: SNAPSHOT_VERSION,
      base: input.base,
      head: input.head,
      mergeBase: input.base,
      files,
      digest: "",
    };
    const digest = await reviewSnapshotDigest(draft);
    const snapshot: ReviewSnapshotV1 = { ...draft, digest };
    if (utf8Bytes(renderReviewPrompt(snapshot)) > MAX_PROMPT_BYTES) {
      return portError("unavailable", SNAPSHOT_PROMPT_BOUND_DETAIL);
    }
    return portOk(snapshot);
  }

  /**
   * Complete structural validation of one bounded raw changed-path view under
   * the shared safe path, regular-mode and status rules: symlinks, gitlinks,
   * unsupported modes, unsafe paths and malformed records are rejected, never
   * omitted. Returns a static detail for the first violation, or null when
   * every record is structurally supported. Empty views are valid here (a
   * merge may change nothing against one parent); callers decide whether an
   * empty view is meaningful.
   */
  protected validateChanges(changes: RawChangeV1[]): string | null {
    if (changes.length > MAX_CHANGED_PATHS) return SNAPSHOT_PATHS_DETAIL;
    const seenPaths = new Set<string>();
    for (const change of changes) {
      if (!isSafeReviewPath(change.path)) {
        return SNAPSHOT_PATH_DETAIL;
      }
      if (seenPaths.has(change.path)) {
        return SNAPSHOT_RAW_DETAIL;
      }
      seenPaths.add(change.path);
      if (change.oldMode === "120000" || change.newMode === "120000") {
        return SNAPSHOT_SYMLINK_DETAIL;
      }
      if (change.oldMode === "160000" || change.newMode === "160000") {
        return SNAPSHOT_SUBMODULE_DETAIL;
      }
      if (
        (change.oldMode !== ZERO_MODE && !isRegularMode(change.oldMode)) ||
        (change.newMode !== ZERO_MODE && !isRegularMode(change.newMode))
      ) {
        return SNAPSHOT_MODE_DETAIL;
      }
      if (
        !/^[0-9a-f]{40}$/.test(change.oldBlob) ||
        !/^[0-9a-f]{40}$/.test(change.newBlob)
      ) {
        return SNAPSHOT_RAW_DETAIL;
      }
      if (change.status === "A") {
        if (
          change.oldMode !== ZERO_MODE || change.oldBlob !== ZERO_SHA ||
          !isRegularMode(change.newMode) || change.newBlob === ZERO_SHA
        ) {
          return SNAPSHOT_RAW_DETAIL;
        }
      } else if (change.status === "D") {
        if (
          change.newMode !== ZERO_MODE || change.newBlob !== ZERO_SHA ||
          !isRegularMode(change.oldMode) || change.oldBlob === ZERO_SHA
        ) {
          return SNAPSHOT_RAW_DETAIL;
        }
      } else if (change.status === "M") {
        if (
          !isRegularMode(change.oldMode) || !isRegularMode(change.newMode) ||
          change.oldBlob === ZERO_SHA || change.newBlob === ZERO_SHA
        ) {
          return SNAPSHOT_MODE_DETAIL;
        }
      } else {
        return SNAPSHOT_STATUS_DETAIL;
      }
    }
    return null;
  }
}
