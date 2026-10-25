// client contracts.

import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { HttpResponseV1, HttpTransportV1 } from "./http.ts";
import type { GitHubAuthProviderV1 } from "./auth.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPullRequestV1,
  PortErrorV1,
} from "../contracts/ports.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { GitHubReviewWireV1 } from "./wire.ts";
import type { BackupCiConsumerV1 } from "./backup-ci-observations.ts";

export const MAX_OPEN_ISSUES = 10_000;

export const MAX_OPEN_ISSUE_PAGES = 500;

export interface GitHubApiClientOptionsV1 {
  repository: RepositoryIdentityV1;
  apiBaseUrl: string;
  http: HttpTransportV1;
  auth: GitHubAuthProviderV1;
  /**
   * Durable cooldown gate in front of every authenticated request. Required
   * trusted capability: no permissive production default exists.
   */
  cooldownGate: GitHubCooldownGateV1;
  /** Injectable clock for rate-limit observation timestamps. */
  clock: Clock;
  /**
   * Trusted opt-in: when exactly `true`, `listOpenIssues` and `readIssue`
   * enrich each real REST issue record with native dependency relations
   * (`blockedBy`/sub-issue count). Any other value (including absence) leaves
   * `relations` unknown; it is never synthesized as empty.
   */
  includeIssueRelations?: boolean;
  /** Paged read bounds (safety limits; exceeding them is unavailable). */
  perPage?: number;
  maxPages?: number;
  maxItems?: number;
  /**
   * Finite whole-operation deadline in ms, beginning before authentication
   * and covering the HTTP request and body read (default
   * `DEFAULT_HTTP_DEADLINE_MS`). Injected auth/transport/body reads that
   * ignore abort signals still cannot block indefinitely.
   */
  requestDeadlineMs?: number;
  /**
   * Backup CI consumer (docs/backup-ci-spec.md §11.2): the receipt store
   * reader and the lower-only mode. Absent, or mode `off`, the check read is
   * exactly the native one.
   */
  backupCi?: BackupCiConsumerV1;
}

export type CreatePullWireV1 =
  | { status: "created"; pr: GitHubPullRequestV1 }
  | { status: "exists" };

export type MergePutWireV1 =
  | { status: "merged"; mergeSha: GitSha }
  | { status: "rejected" }
  | { status: "ambiguous" };

/**
 * Mutating review-operation outcome. `ambiguous` means the request was
 * submitted but its response was lost — the write may have applied and the
 * caller must reconcile against exact authoritative state; it never retries
 * and never creates a second object.
 */
export type ReviewMutationOutcomeV1 =
  | { status: "applied"; review: GitHubReviewWireV1 }
  | { status: "ambiguous" };

/** Exact candidate identity for one self-target CI approval. */
export interface ApproveExactCiRunInputV1 {
  number: number;
  head: GitSha;
  headRef: string;
}

/**
 * Exact approval outcome. `approved` means the approval POST was submitted
 * (201) or an ambiguous response reconciled to a run that is no longer
 * awaiting approval — never that CI passed. `pending` means no qualifying
 * `action_required` run currently exists; nothing was submitted.
 */
export type CiApprovalOutcomeV1 =
  | { status: "approved"; runId: number }
  | { status: "pending" };

/**
 * Raw transport outcome: `lost` means no response reached the caller at all
 * (a write may have applied); `response` carries a status even when it is
 * 5xx (a definite server answer); `error` is an auth/transport boundary
 * failure where absolutely nothing was written.
 */
export type RawSendResult =
  | { status: "response"; response: HttpResponseV1 }
  | { status: "lost" }
  | { status: "error"; error: PortErrorV1 };
