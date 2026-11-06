/**
 * Batched live GitHub inputs of one repository's live work records (issue
 * #326). One read answers, for every requested issue, pull request and base
 * branch of ONE repository, the facts the serial repair pass fingerprints
 * before deciding whether a record must be stepped again: issue state, PR
 * state/head/base, the head's check rollup, the latest review id and the
 * configured base tip. A requested item GitHub does not know is an explicit
 * `null`; every other failure is a typed port error (never an empty success).
 * These facts are advisory scheduling inputs only: a stepped record still
 * performs its own exact reads before any effect.
 */
import type { GitSha } from "./brands.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";

/** Maximum items (issues + pulls + refs) one batched read may request. */
export const MAX_LIVE_INPUT_ITEMS = 2_000;

export interface LiveInputsRequestV1 {
  /** Must be exactly the port's own repository; another one is `invalid`. */
  repository: RepositoryIdentityV1;
  issues: readonly number[];
  pulls: readonly number[];
  /** Branch names (without `refs/heads/`) whose current tip is read. */
  branches: readonly string[];
}

/**
 * The head commit's combined check state. `none`: no check or status exists;
 * `unbound`: the reported commit is not the PR head (a racing push), so the
 * rollup says nothing about the head.
 */
export type LiveCheckRollupV1 =
  | "success"
  | "failure"
  | "error"
  | "pending"
  | "expected"
  | "none"
  | "unbound";

export interface LivePullInputV1 {
  number: number;
  state: "open" | "closed" | "merged";
  head: GitSha;
  /** The base branch tip GitHub reports for this pull request. */
  base: GitSha;
  baseRef: string;
  checks: LiveCheckRollupV1;
  /** Id of the latest submitted review; null when none exists. */
  latestReview: number | null;
}

export interface LiveInputsV1 {
  issues: { number: number; state: "open" | "closed" | null }[];
  pulls: { number: number; pull: LivePullInputV1 | null }[];
  branches: { branch: string; tip: GitSha | null }[];
}
