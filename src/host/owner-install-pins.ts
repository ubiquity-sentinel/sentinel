import type { GitSha } from "../contracts/brands.ts";
import {
  HOSTED_SUPERVISOR_REPOSITORY,
} from "../contracts/hosted-supervisor.ts";

/** The only repository this operation may touch; fixed, never configurable. */
export const OWNER_DEVELOPMENT_INSTALL_REPOSITORY =
  HOSTED_SUPERVISOR_REPOSITORY;
/** The only remote the release-state store may read; fixed. */
export const OWNER_DEVELOPMENT_INSTALL_REMOTE_URL =
  "https://github.com/ubiquity-sentinel/sentinel.git";
/** Moving development ref the installed revisions must remain ancestors of. */
export const OWNER_DEVELOPMENT_INSTALL_DEVELOPMENT_BRANCH = "development";
/** The fixed release-state branch; only its ref is ever updated. */
export const OWNER_DEVELOPMENT_INSTALL_RELEASE_BRANCH =
  "sentinel-state/release";
/** The deterministic CI check a freshly installed revision must carry. */
export const OWNER_DEVELOPMENT_INSTALL_TEST_LOCAL_CHECK = "test-local";

/** Exact first installed revision of the fixed owner development chain. */
export const OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION =
  "20aae115b44ed740c37e2452de4d5530b66430ec" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION = 5;
/** Exact middle revision installed only after the original healthy proof. */
export const OWNER_DEVELOPMENT_INSTALL_READER_REVISION =
  "864d7a0cbb595616b4e90293338f496788b8321a" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_READER_GENERATION = 6;
/** Exact final revision installed only after the reader healthy proof. */
export const OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION =
  "92f3a87f0d0bfb0f0784bf9af4e5402800086852" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION = 7;
/**
 * Exact revision carrying the review no-verdict recovery fix, installed only
 * after the aggregate generation 7 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION =
  "fd5902a8998a7dd906fa15666c448fdb4b845aec" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_RECOVERY_GENERATION = 8;
/**
 * Exact revision carrying the review-step base-refresh reconciliation,
 * installed only after the review recovery generation 8 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION =
  "87193550640078f190ab94d7f8ca0f00bbef9124" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_GENERATION = 9;
/**
 * Exact revision accepting the agent unified-exec command sources in review
 * evidence, installed only after the review-step generation 9 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION =
  "80384fc3668c246297621aa1c588c0e49ea516c6" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_REVIEWER_GENERATION = 10;
/**
 * Exact revision carrying the one-shot exit contract, installed only after the
 * reviewer provenance generation 10 healthy proof. Its install is also what
 * gives the runtime an immediate health-gap execution after a bounded grant.
 */
export const OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION =
  "3f500514f464c7c1ae66cc02bfe6fc4963387d04" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_GENERATION = 11;
/**
 * Exact revision carrying the corrected closed grant set; its install is also
 * what gives the runtime an immediate health-gap execution that consumes the
 * grant in the same run the maintenance job applies it.
 */
export const OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION =
  "e2bb6c2b1d0cafaefe9e16c16b421522819c823e" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_ROUND8_GENERATION = 12;
/**
 * Exact revision that carries the review findings into a correction prompt; its
 * install is also what gives the runtime an immediate health-gap execution.
 */
export const OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION =
  "664a52ddeb4f23eafa58a32e8394754f3303f0c4" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_FINDINGS_GENERATION = 13;
/**
 * Exact revision folding earlier rejections into a correction prompt; its
 * install also gives the runtime an immediate health-gap execution.
 */
export const OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION =
  "4c209ddaf21a94be2c226d1ce31060dca8543f68" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_HISTORY_GENERATION = 14;
/**
 * Exact revision building a settled review receipt from its durable request
 * reservation (the CI-verified revision, which contains the capped-submission
 * fix); its install also triggers an immediate health-gap execution.
 */
export const OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION =
  "9fcc959bcdc903aed21f2bbe968c8838d86010ef" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_RECEIPT_GENERATION = 15;
/**
 * Exact revision carrying the delivery-evidence ledger and the local case
 * evaluator (the CI-verified development tip); its install also triggers an
 * immediate execution, so a delivered review round is observed without waiting
 * for the hourly ordinary cadence.
 */
export const OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION =
  "2b6a25b7d9992c6a027448e43d5ce104d8f1a93e" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_LEDGER_GENERATION = 16;
/**
 * Exact revision carrying the honest cancelled-execution settlement and the
 * delivery ledger; its install also triggers an immediate execution after a
 * further bounded correction grant.
 */
export const OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION =
  "fc25d716981870ce6b7038c2eda94ed2430cca58" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_GENERATION = 17;
/**
 * Exact revision the hosted promotion accepted for the delivered self-repair
 * (generation 18). It is the pointer the trigger install below starts from.
 */
export const OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION =
  "1ed66cd191271cc206aaf436d0f93d245aaee936" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_RELEASED_GENERATION = 18;
/**
 * Exact revision carrying default-include intake, the autonomous delivery pass
 * and the automatic issue closure. Its install also triggers an immediate
 * execution, which is how the owner asks the fleet to start working now instead
 * of waiting for the hourly ordinary cadence.
 */
export const OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION =
  "0853a5c0454d17ab73856d3c9621dc534a0fa706" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_TRIGGER_GENERATION = 19;
/**
 * Exact revision carrying the base-advance recovery for a wedged attempt
 * budget. Its install triggers an immediate execution, which is how the loop
 * reconciles the pending refresh and runs the next model session now.
 */
export const OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION =
  "33ff7fb27c5cb272d953f9ddaae3be1271212afd" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_ADVANCE_GENERATION = 20;
/**
 * Exact revision carrying the cadence-based retry policy. Its install triggers
 * the immediate execution that retries the wedged tasks.
 */
export const OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION =
  "9f1bde9e342547c23dc1dc69f7650704d0f43e7f" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_CADENCE_GENERATION = 21;
/**
 * Exact revision carrying the closed-issue retry guard, so the next execution
 * spends its model session on a repairable task instead of a closed one.
 */
export const OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION =
  "6c5ab021deff64f0df38e1841cbed259cc6287fb" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_GUARD_GENERATION = 22;
/**
 * Exact revision carrying the retirement pass. Its install triggers the
 * immediate execution that records the pending review verdict and starts the
 * correction round.
 */
export const OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION =
  "cf8e6610b206f80b976785d12eef9d8fa1706311" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_RETIRE_GENERATION = 23;
/**
 * Exact revision and generation the live pointer may carry when the App
 * identity install is authorized: the delivered self-repair merge advanced
 * the pointer one generation past the retirement link through an ordinary
 * correction round. Its own healthy proof authorizes the next install.
 */
export const OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION =
  "38c70a5bf3e58ff3fb1c7cfeb7a91e98105c3d1a" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_GENERATION = 24;
/**
 * Exact revision carrying the single ubiquity-sentinel App identity. Installed
 * only after the retirement revision's own healthy proof, so every
 * repository-visible code change the runtime publishes is attributed to
 * `ubiquity-sentinel[bot]` instead of the native Actions bot.
 */
export const OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION =
  "c07fc944759a3fb1eaddfc4d180a17b9ac15136d" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_GENERATION = 25;
/**
 * Exact revision carrying the DeepSeek-direct fallback model route together
 * with the launcher pass-through that lets the child actually receive it.
 * Installed only after the App identity revision's own healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION =
  "c09c9fd84614298a6b3fd6eeabd42e9a6b4d6eb8" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_GENERATION = 26;
/**
 * Exact revision switching the gateway model id to the separately metered
 * `gpt-reserve` (luna under its own quota class). Installed only after the
 * model-route revision's own healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION =
  "cbfa39cb8fc35630ea01281bcc5bdf9075d89d1a" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_GENERATION = 27;
/**
 * Exact revision addressing EVERY committed target. It gives each target its
 * own private source mirror seeded from that target's authenticated remote,
 * so a foreign target's base commit can actually be resolved, and it restores
 * each target's candidate objects from that target's own remote under the
 * `ubiquity-sentinel` App installation scope. Installed only after the
 * reserve-model revision's own healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION =
  "dfd283e83e634dad4473c612bb3ee1aefe25f6b8" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_GENERATION = 28;
/**
 * Exact revision whose repair cooldown gate admits each target's own
 * installation scope. Generation 28 still latched the shared gate on the first
 * foreign-scope request, which faulted the ONE gate every target shares, so
 * generation 29 is what actually lets a foreign target run. Installed only
 * after the multi-target revision's own healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION =
  "dbae19f218141a44becd7d1fffc22d792913b4f0" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_GENERATION = 29;
/**
 * Exact revision scoping the candidate Git auth header to the target's own
 * remote. Generation 29 ran a full multi-target cycle and produced a genuine
 * ai.ubq.fi candidate, but every candidate push was anonymous because the
 * header named the sentinel URL, so nothing landed on the foreign remote.
 * Installed only after the scope-gate revision's own healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION =
  "4da7f5a87a159d36aad1e20d8698d41e777c52fe" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_GENERATION = 30;
/**
 * Exact revision binding candidate preservation to the target repository and
 * widening the session bound so a larger codebase's session can finish.
 * Generation 30 produced genuine ai.ubq.fi candidates but could never publish
 * them: the preserver and loss prover still filtered durable records by the
 * sentinel self-identity. Installed only after the generation 30 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_REVISION =
  "fa419afb2a2b4960c95daeb9041fd86ddc2c3a7a" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_GENERATION = 31;
/**
 * Exact revision authenticating a foreign target's mirror with the App token.
 * Generation 31 could not clone or fetch a foreign repository at all: the
 * mirror inherited the sentinel-scoped native token, so Git sent a credential
 * the server rejected and never fell back to anonymous access. Installed only
 * after the preserve-scope generation 31 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_REVISION =
  "30803374b8eb9bd6e3c2636096493b3371a4f543" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_GENERATION = 32;
/**
 * Exact revision whose advisory diagnostic names the seam a failed model run
 * died at. Without it a failure reports only `unavailable`, so the failing
 * check is unknowable without another full hourly cycle. Installed only after
 * the foreign-auth generation 32 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION =
  "5b42603a28e04abed407cb850e3e7025d02b658e" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_REASON_CODE_GENERATION = 33;
/**
 * Exact owner-approved revision that re-reads settlement before declaring a
 * failure and whose checkout error names the failing command. Installed only
 * after the reason-code generation 33 healthy proof. A failed generation 34
 * candidate settles exactly once by rolling back to the recorded generation 33
 * revision with a monotonic generation 35.
 */
export const OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_REVISION =
  "83a7cd8162d808887a27ad733c64db6e3a7c77ac" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_GENERATION = 34;
/**
 * Exact owner-approved revision whose only behavior change is supported
 * `optOutNotificationMethods` for three unused reasoning streams on the
 * implementation and reviewer sessions; accounting, bounds and policy are
 * unchanged. Installed only after the settlement-recovery generation 34
 * healthy proof. A failed generation 35 candidate settles exactly once by
 * rolling back to the recorded generation 34 revision with a monotonic
 * generation 36; that post-rollback pointer is terminal.
 */
export const OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_REVISION =
  "db16f8af810ee24f434938a3e9dd17c04c3e8084" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_GENERATION = 35;
/**
 * Exact owner-approved revision that fetches a newly advanced target base
 * before deterministic integration through the existing same-target
 * authenticated fetch and shared cooldown; bounds, models, review, merge and
 * state admission policy are unchanged. Installed only after the quiet
 * reasoning generation 35 healthy proof. A failed generation 36 candidate
 * settles exactly once by rolling back to the recorded generation 35 revision
 * with a monotonic generation 37; that post-rollback pointer is terminal.
 */
export const OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_REVISION =
  "ae4629faeb75a80c1badf1ff37a58c8be00adf99" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_GENERATION = 36;
/**
 * Exact owner-approved revision that binds the trusted route's model through
 * the reviewer thread, acknowledgement, turn, reroute, verifier and journal
 * instead of the hardcoded `gpt-reserve`; route/model policy, max reasoning,
 * limits, quotas and the review/merge guards are unchanged. Installed only
 * after the base fetch generation 36 healthy proof. A failed generation 37
 * candidate settles exactly once by rolling back to the recorded generation 36
 * revision with a monotonic generation 38; that post-rollback pointer is
 * terminal.
 */
export const OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_REVISION =
  "59940aece2d051b79c8e2e8ab7c611a0d45600b2" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_GENERATION = 37;
/**
 * Exact owner-approved successor revision that is locally validated,
 * integrated and published; route/model policy, max reasoning, limits,
 * quotas and the review/merge guards are unchanged. Installed only after the
 * review model generation 37 healthy proof. A failed generation 38 candidate
 * settles exactly once by rolling back to the recorded generation 37 revision
 * with a monotonic generation 39; that post-rollback pointer is terminal.
 */
export const OWNER_DEVELOPMENT_INSTALL_APP_AUTH_REVISION =
  "3b6d3736e353ccfdb6da2902bb5be4184335803d" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_APP_AUTH_GENERATION = 38;
/**
 * Exact revision carrying the retirement-aware unfinished-PR count shared by
 * the selection and publish gates, and the on-demand fetch of a target base
 * that moved after the run fetched its mirror; installed only after the app
 * auth generation 38 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_REVISION =
  "b022ec2fd554254aa7f0e9333d7faf2b09a99a68" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_GENERATION = 39;
/**
 * Exact revision publishing the owner-directed GitHub closing keyword
 * (`Resolves #N`) as the whole body of an issue-backed repair pull request;
 * installed only after the publish-gate generation 39 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_REVISION =
  "5e2a828420150f46631ea4b0f96a989307b74bdb" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_GENERATION = 40;
/**
 * Exact revision re-driving a repair whose preserved candidate is permanently
 * missing instead of retrying the lost candidate forever; installed only after
 * the closing-keyword generation 40 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_REVISION =
  "09d2efbe962dec3e2f64ed45e76bc05ecbac0ab5" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_GENERATION = 41;
/**
 * Exact revision republishing a repair whose own pull request was closed
 * unmerged while its source issue stayed open; installed only after the
 * candidate-loss generation 41 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_REVISION =
  "58ae6135a01a0887e8f167b117c7d69420649dc1" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_GENERATION = 42;
/**
 * Exact revision recovering a closed-unmerged own pull request whose frozen
 * head predates the refreshed candidate; installed only after the closed-PR
 * generation 42 healthy proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_REVISION =
  "a683d27e95a661e2cf7fba410f4a141257a659f3" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_GENERATION = 43;
/**
 * Exact revision assigning the trusted publication identity to the source
 * issue before any pull request, as the organization's anti-spam policy
 * requires; installed only after the closed-PR head generation 43 healthy
 * proof.
 */
export const OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION =
  "b58cce6d05d29ed493b60ae610b9950f3496386c" as GitSha;
export const OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_GENERATION = 44;
