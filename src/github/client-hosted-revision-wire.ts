// client hosted revision wire.

import {
  expectArray,
  expectBoolean,
  expectCount,
  expectEnum,
  expectGitSha,
  expectNonEmptyString,
  expectPositiveInt,
  expectRecord,
  fail,
  MaxText,
} from "../contracts/validation.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  expectHostedControllerRepository,
  isHostedControllerRepository,
} from "../contracts/hosted-controller-deployment.ts";
import { ACTIONS_RELEASE_BRANCH } from "./client-hosted-policy.ts";

/** ISO-8601 UTC timestamp with millisecond precision, as milliseconds. */
export function expectIsoMs(value: unknown, path: string): number {
  const text = expectNonEmptyString(value, path, 64);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) {
    fail(path, "invalid_timestamp", "expected ISO-8601 UTC timestamp");
  }
  const ms = Date.parse(text);
  if (!Number.isSafeInteger(ms) || ms < 0) {
    fail(path, "invalid_timestamp", "expected a valid timestamp");
  }
  return ms;
}

/** Merged self PR bound to the exact request source base/head/revision. */
export function parseActionsReleasePull(
  value: unknown,
  request: ReleaseRequestV1,
): void {
  const obj = expectRecord(value, "$");
  if (
    expectPositiveInt(obj.number, "$.number") !== request.source.pullRequest
  ) {
    fail("$.number", "invalid_value", "pull request number mismatch");
  }
  expectEnum(obj.state, ["closed"], "$.state");
  if (expectBoolean(obj.merged, "$.merged") !== true) {
    fail("$.merged", "invalid_value", "pull request is not merged");
  }
  if (
    expectNonEmptyString(obj.merge_commit_sha, "$.merge_commit_sha", 40) !==
      request.revision
  ) {
    fail(
      "$.merge_commit_sha",
      "invalid_value",
      "merge commit does not match the request revision",
    );
  }
  const head = expectRecord(obj.head, "$.head");
  if (
    expectNonEmptyString(head.sha, "$.head.sha", 40) !== request.source.head
  ) {
    fail("$.head.sha", "invalid_value", "pull request head mismatch");
  }
  expectHostedControllerRepository(head.repo, "$.head.repo");
  const base = expectRecord(obj.base, "$.base");
  if (
    expectNonEmptyString(base.ref, "$.base.ref", MaxText.branch) !==
      ACTIONS_RELEASE_BRANCH
  ) {
    fail("$.base.ref", "invalid_value", "unexpected pull request base ref");
  }
  expectHostedControllerRepository(base.repo, "$.base.repo");
}

/** Exact merge commit whose two parents are the request base and head. */
export function parseActionsReleaseCommit(
  value: unknown,
  request: ReleaseRequestV1,
): void {
  const obj = expectRecord(value, "$");
  if (
    expectNonEmptyString(obj.sha, "$.sha", 40) !== request.revision
  ) {
    fail("$.sha", "invalid_value", "commit does not match the revision");
  }
  const parents = expectArray(obj.parents, "$.parents", 2, (item) => item);
  if (parents.length !== 2) {
    fail("$.parents", "invalid_value", "merge commit requires two parents");
  }
  const shas = parents.map((parent, index) =>
    expectNonEmptyString(
      expectRecord(parent, `$.parents[${index}]`).sha,
      `$.parents[${index}].sha`,
      40,
    )
  );
  if (
    !shas.includes(request.source.base) ||
    !shas.includes(request.source.head)
  ) {
    fail(
      "$.parents",
      "invalid_value",
      "merge parents do not contain the request source",
    );
  }
}

// ---------------------------------------------------------------------------
// Hosted supervisor execution wire validation
// ---------------------------------------------------------------------------

export interface HostedAttemptV1 {
  status: string;
  completedAt: number | null;
}

export interface HostedRuntimeStepV1 {
  status: string | null;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface HostedRepairJobV1 {
  id: number;
  status: string;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
  runtimeStep: HostedRuntimeStepV1 | null;
}

export interface HostedJobsV1 {
  repair: HostedRepairJobV1 | null;
  allCompleted: boolean;
}

/** Exact scope-0 production open reviewed request. */
export function hostedSelfRequest(request: ReleaseRequestV1): boolean {
  const repository = request.target.repository;
  return isHostedControllerRepository(repository) &&
    request.target.environment === "production" &&
    request.status === "open" && request.source.reviewReceiptId !== null;
}

/**
 * Compare wire (real GitHub shape, no head_commit): the requested SHA must be
 * the compare base AND the merge base, counters must be consistent, and only
 * ahead/identical are positive; behind/diverged are definitive negatives.
 */
export function parseHostedCompare(value: unknown, revision: GitSha): boolean {
  const obj = expectRecord(value, "$");
  const status = expectEnum(
    obj.status,
    ["ahead", "behind", "diverged", "identical"],
    "$.status",
  );
  const baseCommit = expectRecord(obj.base_commit, "$.base_commit");
  const baseSha = expectGitSha(baseCommit.sha, "$.base_commit.sha");
  const mergeCommit = expectRecord(
    obj.merge_base_commit,
    "$.merge_base_commit",
  );
  const mergeSha = expectGitSha(mergeCommit.sha, "$.merge_base_commit.sha");
  const aheadBy = expectCount(obj.ahead_by, "$.ahead_by");
  const behindBy = expectCount(obj.behind_by, "$.behind_by");
  const totalCommits = expectCount(obj.total_commits, "$.total_commits");
  if (totalCommits !== aheadBy + behindBy) {
    fail(
      "$.total_commits",
      "invalid_value",
      "compare counters are inconsistent",
    );
  }
  if (status === "identical") {
    if (aheadBy !== 0 || behindBy !== 0 || totalCommits !== 0) {
      fail(
        "$.status",
        "invalid_value",
        "identical compare must have zero counters",
      );
    }
    return baseSha === revision && mergeSha === revision;
  }
  if (status === "ahead") {
    if (aheadBy === 0 || behindBy !== 0) {
      fail(
        "$.status",
        "invalid_value",
        "ahead compare counters are inconsistent",
      );
    }
    return baseSha === revision && mergeSha === revision;
  }
  // behind/diverged: definitive negatives; malformed counters already failed.
  if (behindBy === 0) {
    fail(
      "$.status",
      "invalid_value",
      "behind/diverged compare counters are inconsistent",
    );
  }
  return false;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Strict complete nonrecursive tree proof, without mutable-ref selection. */
export function parseMatrixTreeEntry(
  value: unknown,
  treeSha: GitSha,
  name: string,
  maxItems: number,
): { sha: GitSha; type: string; mode: string } | null {
  const obj = expectRecord(value, "$");
  if (
    expectGitSha(obj.sha, "$.sha") !== treeSha ||
    expectBoolean(obj.truncated, "$.truncated")
  ) {
    fail(
      "$",
      "invalid_value",
      "matrix capability tree is incomplete or foreign",
    );
  }
  const entries = expectArray(obj.tree, "$.tree", maxItems, (item) => item);
  const names = new Set<string>();
  let selected: { sha: GitSha; type: string; mode: string } | null = null;
  for (const [index, value] of entries.entries()) {
    const at = `$.tree[${index}]`;
    const entry = expectRecord(value, at);
    const path = expectNonEmptyString(entry.path, `${at}.path`, MaxText.path);
    if (path.includes("/") || names.has(path)) {
      fail(`${at}.path`, "invalid_value", "tree entry path is ambiguous");
    }
    names.add(path);
    const sha = expectGitSha(entry.sha, `${at}.sha`);
    const type = expectEnum(
      entry.type,
      ["tree", "blob", "commit"],
      `${at}.type`,
    );
    const mode = expectNonEmptyString(entry.mode, `${at}.mode`, 6);
    if (
      (type === "tree" && mode !== "040000") ||
      (type === "blob" && !["100644", "100755", "120000"].includes(mode)) ||
      (type === "commit" && mode !== "160000")
    ) {
      fail(at, "invalid_value", "tree entry type and mode disagree");
    }
    if (path === name) selected = { sha, type, mode };
  }
  return selected;
}
