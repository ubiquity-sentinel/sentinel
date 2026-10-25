import type { NativeQueueGuardV1 } from "./native-queue-guard.ts";
// port contracts.

import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { HttpTransportV1 } from "./http.ts";
import type { GitHubAuthProviderV1 } from "./auth.ts";
import type { Clock, GitHubCooldownGateV1 } from "../contracts/ports.ts";
import type { GitExecutorV1 } from "./git-executor.ts";
import type { BackupCiConsumerV1 } from "./backup-ci-observations.ts";
import type {
  HumanResolutionVerifierV1,
  ReviewServiceTransportV1,
} from "./review-service.ts";

export interface GitHubPortOptionsV1 {
  /** Trusted queue custody capability; absent gateway effect authority fails closed. */
  readonly nativeQueue?: NativeQueueGuardV1;
  /** Protected host-only self strategy; ignored for every foreign target. */
  selfMergeEnabled?: boolean;
  repository: RepositoryIdentityV1;
  /** REST API base; default `https://api.github.com`. */
  apiBaseUrl?: string;
  http: HttpTransportV1;
  /** Installation token provider (injected; never created here). */
  auth: GitHubAuthProviderV1;
  /**
   * Durable cooldown gate in front of every authenticated request. Required
   * trusted capability: no permissive production default exists.
   */
  cooldownGate: GitHubCooldownGateV1;
  clock: Clock;
  /** Trusted git executor for push publication and base ancestry. */
  git: GitExecutorV1;
  /** Narrow injected review-service transport. */
  reviewService: ReviewServiceTransportV1;
  /** Actor login that authors Sentinel-owned PRs (e.g. `sentinel[bot]`). */
  trustedPrAuthor: string;
  /** Expected reviewer identity (e.g. `chatgpt-codex-connector[bot]`). */
  trustedReviewer: string;
  /** Humans authorized to resolve review findings (merge gate). This is a
   * secondary constraint only: an allowlist alone never authenticates a
   * resolution — `resolutionVerifier` must prove it. */
  trustedResolutionAuthors: string[];
  /**
   * Trusted authenticated human-resolution resolver. Required for merging
   * with resolved findings: the resolver authenticates the exact immutable
   * resolution reference bound to repo/PR/head/finding fingerprint and the
   * expected author. When absent, any resolved finding fail closes.
   */
  resolutionVerifier?: HumanResolutionVerifierV1;
  /** Paged read bounds. */
  perPage?: number;
  maxPages?: number;
  maxItems?: number;
  /**
   * Trusted opt-in: when exactly `true`, issue reads are enriched with native
   * dependency relations (`blockedBy`/sub-issue count). Absence leaves
   * relations unknown — never an empty list.
   */
  includeIssueRelations?: boolean;
  /** Finite whole-operation HTTP deadline (auth + request + body read). */
  requestDeadlineMs?: number;
  /** Finding normalization cap (default the contract 256). */
  findingCap?: number;
  /** Backup CI consumer for the port's one client (`client-backup-ci.ts`). */
  backupCi?: BackupCiConsumerV1;
}

export const DEFAULT_FINDING_CAP = 256;

export interface GitHubEffectiveProtectionsV1 {
  branch: string;
  /** Every active rule type that applies to the branch (sorted, unique). */
  activeRuleTypes: string[];
  /** Active rules the expected-head merge path cannot safely enforce. */
  unsupportedRuleTypes: string[];
  /** True when an active ruleset requires merge-queue merge semantics. */
  mergeQueueActive: boolean;
  /** Exact required status-check contexts from the active rules rule. */
  requiredCheckNames: string[];
  /** strict_required_status_checks_policy from the active rules rule. */
  strictRequiredChecks: boolean;
  /** required_approving_review_count from the active pull_request rule. */
  requiredApprovingReviewCount: number;
  /** True when the pull_request rule requires thread resolution we cannot
   * verify (unsupported requirement). */
  pullRequestThreadResolutionRequired: boolean;
  /** True when any contributing ruleset's bypass policy could not be read. */
  bypassUnknown: boolean;
  /** Bypass actors actually configured on contributing rulesets. */
  bypassActors: { actorType: string; actorId: number | null }[];
}

/**
 * Rules parsed from the actual branch-rules response that the expected-head
 * merge path can enforce: the merge is only ever checked against these.
 */
export const SUPPORTED_MERGE_RULE_TYPES = new Set([
  "pull_request",
  "required_status_checks",
  "non_fast_forward",
  "creation",
  "deletion",
  "update",
]);
