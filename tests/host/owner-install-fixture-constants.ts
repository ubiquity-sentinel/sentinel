import type { GitSha } from "../../src/contracts/brands.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION,
  OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION,
  OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION,
  OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
  OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION,
  OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION,
  OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
  OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION,
  OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION,
} from "../../src/host/owner-development-install.ts";

export const T0 = 1_700_000_000_000;
export const NOW = T0 + 10_000;
export const LAUNCHER = "f".repeat(40) as GitSha;
export const STATE_HEAD = "a".repeat(40) as GitSha;
export const PRIOR_STATE_HEAD = "b".repeat(40) as GitSha;
export const UNRELATED = "e".repeat(40) as GitSha;
export const DIGEST = "d".repeat(64);

export const ORIGINAL = OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION;
export const READER = OWNER_DEVELOPMENT_INSTALL_READER_REVISION;
export const AGGREGATE = OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION;
export const RECOVERY = OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION;
export const REVIEW_STEP = OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION;
export const REVIEWER = OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION;
export const EXIT_CONTRACT = OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION;
export const ROUND8 = OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION;
export const FINDINGS = OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION;
export const HISTORY = OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION;
export const RECEIPT = OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION;
export const LEDGER = OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION;
export const SETTLEMENT = OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION;
export const RELEASED = OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION;
export const TRIGGER = OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION;
export const ADVANCE = OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION;
export const CADENCE = OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION;
export const GUARD = OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION;
export const RETIRE = OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION;
export const DELIVERED_ROUND2 =
  OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION;
export const APP_IDENTITY = OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION;
export const MODEL_ROUTE = OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION;
export const RESERVE_MODEL = OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION;
export const MULTI_TARGET = OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION;
export const SCOPE_GATE = OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION;
export const CANDIDATE_AUTH = OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION;
export const PRESERVE_SCOPE = OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_REVISION;
export const FOREIGN_AUTH = OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_REVISION;
export const REASON_CODE = OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION;
export const SETTLEMENT_RECOVERY =
  OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_REVISION;
// The quiet-reasoning pins stay test-local exact literals: this suite must also
// compile against pre-rung production source, where the newly exported
// constants do not exist, so the expected red is a semantic plan mismatch and
// never a missing import.
export const QUIET_REASONING =
  "db16f8af810ee24f434938a3e9dd17c04c3e8084" as GitSha;
export const QUIET_REASONING_GENERATION = 35;
// The base-fetch pins stay test-local exact literals for the same reason: this
// suite must compile against pre-rung production source, so the expected red is
// a semantic plan mismatch and never a missing import.
export const BASE_FETCH = "ae4629faeb75a80c1badf1ff37a58c8be00adf99" as GitSha;
export const BASE_FETCH_GENERATION = 36;
// The review-model pins stay test-local exact literals for the same reason: this
// suite must compile against pre-rung production source, so the expected red is
// a semantic plan mismatch and never a missing import.
export const REVIEW_MODEL =
  "59940aece2d051b79c8e2e8ab7c611a0d45600b2" as GitSha;
export const REVIEW_MODEL_GENERATION = 37;
// The successor install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
export const SUCCESSOR_REVISION =
  "3b6d3736e353ccfdb6da2902bb5be4184335803d" as GitSha;
export const SUCCESSOR_GENERATION = 38;
// The publish-gate install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
export const PUBLISH_GATE_REVISION =
  "b022ec2fd554254aa7f0e9333d7faf2b09a99a68" as GitSha;
export const PUBLISH_GATE_GENERATION = 39;
// The closing-keyword install pin stays a test-local exact literal for the
// same reason: this suite must compile against pre-rung production source, so
// the expected red is a semantic plan mismatch and never a missing import.
export const CLOSING_KEYWORD_REVISION =
  "5e2a828420150f46631ea4b0f96a989307b74bdb" as GitSha;
export const CLOSING_KEYWORD_GENERATION = 40;
// The candidate-loss install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
export const CANDIDATE_LOSS_REVISION =
  "09d2efbe962dec3e2f64ed45e76bc05ecbac0ab5" as GitSha;
export const CANDIDATE_LOSS_GENERATION = 41;
// The closed-PR install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
export const CLOSED_PR_REVISION =
  "58ae6135a01a0887e8f167b117c7d69420649dc1" as GitSha;
export const CLOSED_PR_GENERATION = 42;
// The closed-PR head install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
export const CLOSED_PR_HEAD_REVISION =
  "a683d27e95a661e2cf7fba410f4a141257a659f3" as GitSha;
export const CLOSED_PR_HEAD_GENERATION = 43;
// The assign-first install pin stays a test-local exact literal for the same
// reason: this suite must compile against pre-rung production source, so the
// expected red is a semantic plan mismatch and never a missing import.
export const ASSIGN_FIRST_REVISION =
  "b58cce6d05d29ed493b60ae610b9950f3496386c" as GitSha;
export const ASSIGN_FIRST_GENERATION = 44;
// The review-phase PR install pin stays a test-local exact literal for the
// same reason: this suite must compile against pre-rung production source, so
// the expected red is a semantic plan mismatch and never a missing import.
export const REVIEW_PHASE_PR_REVISION =
  "529c2d3b81cf66f66d46d6c4cb1a573b3b4ba603" as GitSha;
export const REVIEW_PHASE_PR_GENERATION = 45;
// The retry pin is the same owner-approved revision re-installed after a real
// candidate failure rolled the pointer to its recorded prior.
export const REVIEW_PHASE_PR_RETRY_REVISION = REVIEW_PHASE_PR_REVISION;
export const REVIEW_PHASE_PR_RETRY_GENERATION = 47;
// The livelock-bound install pin stays a test-local exact literal: this suite
// must compile against pre-rung production source, so the expected red is a
// semantic plan mismatch and never a missing import.
export const LIVELOCK_BOUND_REVISION =
  "4304d1acd77d0e49874a2a59398c7fe00b94741c" as GitSha;
export const LIVELOCK_BOUND_GENERATION = 48;
// The review-wait-bound install pin stays a test-local exact literal for the
// same reason: this suite must compile against pre-rung production source, so
// the expected red is a semantic plan mismatch and never a missing import.
export const REVIEW_WAIT_BOUND_REVISION =
  "d0b9ac8542949ed2d880329f666f638103b0226c" as GitSha;
export const REVIEW_WAIT_BOUND_GENERATION = 49;
// The cooldown-bound install pin stays a test-local exact literal: this suite
// must compile against pre-rung production source, so the expected red is a
// semantic plan mismatch and never a missing import.
export const COOLDOWN_BOUND_REVISION =
  "46a182b0713f60279b3f1a521849e745ab3432b4" as GitSha;
export const COOLDOWN_BOUND_GENERATION = 50;
// The child-deadline install pin stays a test-local exact literal: this suite
// must compile against pre-rung production source, so the expected red is a
// semantic plan mismatch and never a missing import.
export const CHILD_DEADLINE_REVISION =
  "1f90f0a0b122bdcd424eb8fa6016a509bd3f6ed5" as GitSha;
export const CHILD_DEADLINE_GENERATION = 51;
// The generation 52 rung pin stays a test-local exact literal: this suite must
// also compile against pre-rung production source, where the new constant does
// not exist, so the expected red is a semantic plan mismatch and never a
// missing import.
export const RUNTIME52_REVISION =
  "80cc73a4a38d58a53e215b1b8daaccb8e6fe97b1" as GitSha;
export const RUNTIME52_GENERATION = 52;
// The owner-repair generation 53 pin stays a test-local exact literal: this
// suite must also compile against pre-rung production source, where the new
// constant does not exist, so the expected red is a semantic plan mismatch and
// never a missing import.
export const OWNER_REPAIR53_REVISION =
  "573d862429ab49eefbfcb99bd1878926024af96d" as GitSha;
export const OWNER_REPAIR53_GENERATION = 53;
// Keep the new rung's exact pins test-local so RED is a semantic plan failure.
export const RUNTIME54_REVISION =
  "a6c40a95ceb93fbdf1f85343409393c68d4fe13c" as GitSha;
export const RUNTIME54_GENERATION = 54;
export const RUNTIME55_REVISION =
  "275fee6dba74800b47e555f3f316b60be566ccb4" as GitSha;
export const RUNTIME55_GENERATION = 55;
export const CONCURRENCY_PRIOR_REVISION =
  "0fcdb5505417798e3ec7626333d4621fff67c26d" as GitSha;
export const CONCURRENCY_REVISION =
  "be9946b2e8ef1570df9b07307ca07dfafc471b86" as GitSha;
// Keep the new pin test-local so RED remains a behavior mismatch.
export const CONCURRENCY_RETRY_REVISION =
  "c79b2b87a6a2dd0adc201895af10806ef7a9c600" as GitSha;
export const CONCURRENCY_PLANNER_REVISION =
  "ddc98af7062b63e2b6b0f1e6b877e32f4675d442" as GitSha;
export const ROLLBACK_TARGET_GENERATION = 46;
// The memory generation 68 revision and the staged learning generation 69
// revision stay test-local exact literals, mirroring the production pins.
export const MEMORY_RUNTIME_REVISION =
  "335727744517fab37fa9939da49366c9b315207b" as GitSha;
export const LEARNING_RUNTIME_REVISION =
  "6db6166d23deddcf1894d493b25b4c1f4e616282" as GitSha;
export const VERSIONED_RUNTIME_REVISION =
  "7f43cf0b93b82c521a55d3fae26996831dc8c27e" as GitSha;
export const CANCELLED_RELEASE_RUNTIME_REVISION =
  "7c3baee145310141a666bd05360f4e03c56cfd04" as GitSha;
export const STACKED_MERGE_RUNTIME_REVISION =
  "dc5e08af05ed04be2e45a0acca72505fcad0b922" as GitSha;
export const EARLY_FRAME_RUNTIME_REVISION =
  "37c81e771cfedcf0b1e6b4cb70cbed04c8bb6e87" as GitSha;
