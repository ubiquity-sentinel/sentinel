/**
 * The later census rows (Part A): review, the review-round ceiling, the
 * carried delivery, delivery CI, base refresh, merge and release, the
 * terminal classes and configuration. See `census-classes.ts`.
 */
import {
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_REFRESH_LIMIT_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX,
  REVIEW_ROUND_CEILING_REJECTED,
  REVIEW_ROUND_CEILING_REVIEWED,
  REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX,
  REVIEW_ROUND_CEILING_UNACCEPTED,
  REVIEW_ROUND_CEILING_UNREVIEWED,
} from "../../src/repair/review-round-cap.ts";
import {
  REVIEW_TASK_SHAPE_DETAIL,
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
  TASK_ACCEPTANCE_DIGEST_DETAIL,
  TASK_ACCEPTANCE_MISMATCH_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
  TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
  TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
} from "../../src/contracts/review-task-acceptance.ts";
import {
  RETIRED_MERGED_MESSAGE,
  RETIRED_TARGET_MESSAGE,
} from "../../src/repair/selection.ts";
import {
  BASE_REFRESH_CAPABILITY_DETAIL,
  BASE_REFRESH_FOREIGN_HEAD_DETAIL,
  BASE_REFRESH_PR_OBSERVATION_DETAIL,
  BASE_REFRESH_PRESERVE_DETAIL,
} from "../../src/repair/loop-base-refresh-failure.ts";
import { LEGACY_LOSS_DETAIL } from "../../src/repair/loop-legacy-loss.ts";
import { CI_BASE_RED_DETAIL } from "../../src/repair/ci-rejection.ts";
import { BASE, type RecordShapeV1, SELF } from "./world.ts";
import {
  cleared,
  NO_INTENT,
  type ParkClassV1,
  pub,
  type TriggerV1,
  W,
} from "./census-shapes.ts";

import { baseRefreshRefusedMessage } from "../../src/repair/loop-base-refresh-failure.ts";
import { CONFLICT_PROTECTED_DETAIL } from "../../src/repair/conflict-resolution.ts";
import {
  failureSignature,
  REPEAT_FAILURE_DEFAULT_ROUTE,
  repeatFailureParkMessage,
} from "../../ops/hosted-autonomy-repeat-failure.ts";
import { DEFAULT_SHAPE, taskStatement } from "./world.ts";
import { TASK_ACCEPTANCE_OWNER_GATE_DETAIL } from "../../src/repair/acceptance-correction.ts";

export const LATE_CLASSES: ParkClassV1[] = [
  {
    id: "impl.repeat_failure",
    message: repeatFailureParkMessage({
      count: 3,
      signature: failureSignature("other", "model run did not complete"),
      issue: (await taskStatement(DEFAULT_SHAPE.issue)).digest.slice(0, 12),
      route: REPEAT_FAILURE_DEFAULT_ROUTE,
    }, "model run did not complete"),
    kind: "other",
    writer: W(
      "ops/hosted-autonomy-repeat-failure.ts",
      "message: repeatFailureParkMessage(park, record.blocker!.message),",
      "w.impl.repeat_failure",
    ),
    trigger: "pipeline",
    variants: [{ tag: "fresh", candidate: "fresh", intent: "none" }],
  },
  {
    id: "ref.refused",
    message: baseRefreshRefusedMessage(CONFLICT_PROTECTED_DETAIL),
    kind: "other",
    writer: W(
      "src/repair/loop-base-refresh-failure.ts",
      "baseRefreshRefusedMessage(reason),",
      "w.ref.refused",
    ),
    trigger: "pipeline",
    variants: [pub("round1", 1, "clean")],
  },
  {
    id: "rev.acceptance_owner",
    message: TASK_ACCEPTANCE_OWNER_GATE_DETAIL,
    kind: "other",
    writer: W(
      "src/repair/loop-review-result.ts",
      "corrected ?? receipt,\n          TASK_ACCEPTANCE_OWNER_GATE_DETAIL,",
      "w.rev.acceptance_owner",
    ),
    trigger: "pipeline",
    variants: [pub("spent", 3, "unaccepted")],
  },
  // ------------------------------------------------------------------ review
  {
    id: "rev.not_fulfilled",
    message: TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
    kind: "other",
    writer: W(
      "src/repair/loop-review-result.ts",
      "markBlocked(record, semanticRefusalKind(refusal), refusal, now)",
      "w.rev.acceptance_refusal",
    ),
    trigger: "pipeline",
    variants: [pub("round1", 1, "none"), pub("spent", 3, "none")],
  },
  {
    id: "rev.uncertain",
    message: TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
    kind: "other",
    writer: "w.rev.acceptance_refusal",
    trigger: "pipeline",
    variants: [pub("round1", 1, "none")],
  },
  {
    id: "rev.digest_drift",
    message: TASK_ACCEPTANCE_DIGEST_DETAIL,
    kind: "missing_evidence",
    writer: "w.rev.acceptance_refusal",
    trigger: "human",
    variants: [pub("round1", 1, "none")],
  },
  {
    id: "rev.acceptance_mismatch",
    message: TASK_ACCEPTANCE_MISMATCH_DETAIL,
    kind: "missing_evidence",
    writer: "w.rev.acceptance_refusal",
    trigger: "contradiction",
    variants: [pub("round1", 1, "none")],
  },
  {
    id: "rev.acceptance_missing",
    message: TASK_ACCEPTANCE_MISSING_DETAIL,
    kind: "missing_evidence",
    writer: "w.rev.acceptance_refusal",
    trigger: "pipeline",
    variants: [pub("round1", 1, "unaccepted")],
  },
  {
    id: "rev.already_satisfied",
    message: TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
    kind: "other",
    writer: "w.rev.acceptance_refusal",
    trigger: "legacy",
    variants: [pub("round1", 1, "none")],
  },
  {
    id: "rev.stale_source",
    message: "source issue is not open: no task-bound review can be requested",
    kind: "stale_source",
    writer: W(
      "src/repair/loop-review-request.ts",
      `"source issue is not open: no task-bound review can be requested",`,
      "w.rev.stale_source",
    ),
    trigger: "human",
    variants: [pub("new", 0, "none")],
  },
  {
    id: "rev.task_shape",
    message: REVIEW_TASK_SHAPE_DETAIL,
    kind: "missing_evidence",
    writer: W(
      "src/repair/loop-review-request.ts",
      "REVIEW_TASK_SHAPE_DETAIL,",
      "w.rev.task_shape",
    ),
    trigger: "human",
    variants: [pub("new", 0, "none")],
  },
  {
    id: "rev.settled_without_intent",
    message: "review admission already settled without an intent",
    kind: "unavailable",
    writer: W(
      "src/repair/loop-review-request.ts",
      `"review admission already settled without an intent",`,
      "w.rev.settled_without_intent",
    ),
    trigger: "contradiction",
    variants: [cleared("round1", 1, "none")],
  },
  {
    id: "rev.admission_refused",
    message: "review admission refused: disabled",
    kind: "unavailable",
    writer: W(
      "src/repair/loop-review-request.ts",
      "`review admission refused: ${reservation.status}`",
      "w.rev.admission_refused",
    ),
    trigger: "pipeline",
    variants: [cleared("new", 0, "none")],
  },
  {
    id: "rev.rounds_exhausted_legacy",
    message:
      "review rounds exhausted without an accepted verdict (structured review unavailable)",
    kind: "review_quota",
    writer: W(
      "ops/hosted-autonomy-policy.ts",
      `prefix: "review rounds exhausted without an accepted verdict",`,
      "w.rev.rounds_exhausted_legacy",
    ),
    trigger: "legacy",
    variants: [pub("round1", 1, "none"), pub("spent", 3, "clean")],
  },
  {
    id: "rev.no_verdict_legacy",
    message: "review produced no verdict within the bounded review wait",
    kind: "other",
    writer: W(
      "ops/hosted-autonomy-policy.ts",
      `prefix: "review produced no verdict within the bounded review wait",`,
      "w.rev.no_verdict_legacy",
    ),
    trigger: "legacy",
    variants: [pub("round1", 1, "none")],
  },
  // ----------------------------------------------------- review-round ceiling
  ...[
    ["ceil.unreviewed", REVIEW_ROUND_CEILING_UNREVIEWED, "none"],
    ["ceil.rejected", REVIEW_ROUND_CEILING_REJECTED, "p1"],
    ["ceil.unaccepted", REVIEW_ROUND_CEILING_UNACCEPTED, "unaccepted"],
    ["ceil.reviewed", REVIEW_ROUND_CEILING_REVIEWED, "clean"],
  ].map(([id, message, review]): ParkClassV1 => ({
    id,
    message,
    kind: "other",
    writer: W(
      "src/repair/loop-review-round-cap.ts",
      'markBlocked(record, "other", message, deps.clock.now())',
      "w.ceil.park",
    ),
    trigger: "pipeline",
    variants: [pub("spent", 3, review as RecordShapeV1["review"])],
  })),
  {
    id: "ceil.base_moved",
    message: REVIEW_ROUND_CEILING_BASE_MOVED,
    kind: "other",
    writer: "w.ceil.park",
    trigger: "pipeline",
    tips: ["moved"],
    variants: [pub("spent", 3, "clean")],
  },
  ...[
    [
      "carried.reviewed_ci_pending",
      REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX,
    ],
    [
      "carried.patch_changed",
      REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
    ],
    ["carried.ci_failed", REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX],
    ["carried.ci_pending", REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX],
    ["carried.stalled", REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX],
    [
      "carried.refresh_limit",
      REVIEW_ROUND_CEILING_CARRIED_REFRESH_LIMIT_PREFIX,
    ],
    ["carried.off_tip", REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX],
  ].map(([id, prefix]): ParkClassV1 => ({
    id,
    message: `${prefix}validate(failure)`,
    kind: "other",
    writer: W(
      "src/repair/loop-carried-delivery.ts",
      'markBlocked(record, "other", park, now),',
      "w.carried.park",
    ),
    trigger: "pipeline",
    tips: ["moved"],
    variants: [pub("spent", 3, "clean")],
  })),
  // ---------------------------------------------------------------- delivery
  {
    id: "del.ci_failed",
    message: "CI checks failed: validate(failure)",
    kind: "other",
    writer: W(
      "src/repair/loop-checks.ts",
      'markBlocked(record, "other", decision.blocked, now)',
      "w.del.ci_failed",
    ),
    trigger: "legacy",
    variants: [
      pub("round1", 1, "clean"),
      pub("spent", 3, "clean"),
      pub("legacy", 3, "clean", { legacy: true }),
    ],
  },
  {
    id: "del.ci_unattributed",
    message: "CI checks failed without base evidence: validate(failure)",
    kind: "other",
    writer: W(
      "src/repair/loop-ci-correction.ts",
      'markBlocked(record, "other", detail, now)',
      "w.del.ci_unattributed",
    ),
    trigger: "pipeline",
    variants: [pub("round1", 1, "clean"), pub("spent", 3, "clean")],
  },
  {
    // Issue #155: a legacy final-round head on a moved base, red only
    // through its red reviewed base, that its review cannot carry (or whose
    // tip stayed red past the bound): owner-gated, named every pass.
    id: "del.legacy_base_red",
    message: `${CI_BASE_RED_DETAIL}: validate(failure)`,
    kind: "other",
    writer: W(
      "src/repair/loop-carried-delivery.ts",
      'markBlocked(record, "other", park, deps.clock.now()),',
      "w.del.legacy_base_red",
    ),
    trigger: "pipeline",
    variants: [pub("legacy", 3, "clean", { legacy: true })],
  },
  // ------------------------------------------------------------ base refresh
  {
    id: "ref.conflict",
    message: `base refresh has conflicts at ${BASE}`,
    kind: "other",
    writer: W(
      "src/repair/loop-base-refresh.ts",
      "`base refresh has conflicts at ${expectedBase}`",
      "w.ref.conflict",
    ),
    trigger: "pipeline",
    tips: ["moved"],
    variants: [cleared("round1", 1, "clean")],
  },
  ...[
    [
      "ref.failed_unavailable",
      `unavailable ${BASE_REFRESH_CAPABILITY_DETAIL}`,
      "pipeline",
    ],
    [
      "ref.failed_auth_legacy",
      `auth_failed ${BASE_REFRESH_PR_OBSERVATION_DETAIL}`,
      "legacy",
    ],
    [
      "ref.failed_permission",
      `auth_failed ${BASE_REFRESH_PR_OBSERVATION_DETAIL} (permission refused)`,
      "pipeline",
    ],
    [
      "ref.failed_invalid",
      `invalid ${BASE_REFRESH_PRESERVE_DETAIL}`,
      "pipeline",
    ],
    [
      "ref.failed_conflict",
      `conflict ${BASE_REFRESH_FOREIGN_HEAD_DETAIL}`,
      "pipeline",
    ],
  ].map(([id, detail, trigger]): ParkClassV1 => ({
    id,
    message: `base refresh failed 3 consecutive times: ${detail}`,
    kind: "other",
    writer: W(
      "src/repair/loop-base-refresh-failure.ts",
      "`base refresh failed ${failures} consecutive times: ${failure.kind} ${detail}`",
      "w.ref.failed",
    ),
    trigger: trigger as TriggerV1,
    tips: ["moved"],
    variants: [cleared("round1", 1, "clean")],
  })),
  // ---------------------------------------------------------- merge, release
  {
    id: "merge.pr_closed",
    message: "pull request closed before merge",
    kind: "other",
    writer: W(
      "src/repair/loop-merge.ts",
      `"pull request closed before merge",`,
      "w.merge.pr_closed",
    ),
    trigger: "human",
    terminal: "pr_closed",
    world: { pull: "closed_unmerged" },
    variants: [cleared("round1", 1, "clean")],
  },
  {
    id: "merge.head_mismatch",
    message: "observed merged head identity mismatch",
    kind: "other",
    writer: W(
      "src/repair/loop-merge.ts",
      `"observed merged head identity mismatch",`,
      "w.merge.head_mismatch",
    ),
    trigger: "human",
    world: { pull: "merged" },
    variants: [cleared("round1", 1, "clean")],
  },
  {
    id: "merge.release_identity",
    message: "release request identity invalid",
    kind: "other",
    writer: W(
      "src/repair/loop-merge.ts",
      `"release request identity invalid",`,
      "w.merge.release_identity",
    ),
    trigger: "contradiction",
    world: { pull: "merged" },
    variants: [cleared("round1", 1, "clean")],
  },
  {
    id: "rel.failed",
    message: "release failed",
    kind: "other",
    writer: W(
      "src/repair/loop-release.ts",
      'markTerminalBlocked(record, "other", `release ${phase}`, now)',
      "w.rel.failed",
    ),
    trigger: "pipeline",
    world: { pull: "merged" },
    variants: [{ ...cleared("self", 1, "clean"), repository: SELF }],
  },
  {
    id: "rel.cancelled",
    message: "release request cancelled",
    kind: "other",
    writer: W(
      "src/repair/loop-release.ts",
      "request.failureReason ?? `release request ${request.status}`,",
      "w.rel.cancelled",
    ),
    trigger: "pipeline",
    world: { pull: "merged" },
    variants: [cleared("round1", 1, "clean")],
  },
  // ---------------------------------------------------------------- terminal
  {
    id: "term.retired",
    message: RETIRED_TARGET_MESSAGE,
    kind: "other",
    writer: W(
      "ops/hosted-autonomy-closures.ts",
      "message: HOSTED_AUTONOMY_RETIRED,",
      "w.term.retired",
    ),
    // Terminal by design only while the issue stays closed: the census
    // worlds keep it open, i.e. the issue was reopened after retirement.
    trigger: "human",
    world: { pull: "closed_unmerged" },
    variants: [pub("reopened", 1, "clean"), {
      tag: "reopened_fresh",
      candidate: "fresh",
      intent: "none",
    }],
  },
  {
    id: "term.merged_outside",
    message: RETIRED_MERGED_MESSAGE,
    kind: "other",
    writer: W(
      "src/repair/loop-review-observation.ts",
      'markTerminalBlocked(record, "other", RETIRED_MERGED_MESSAGE, now)',
      "w.term.merged_outside",
    ),
    trigger: "human",
    terminal: "merged_outside",
    world: { pull: "merged" },
    variants: [cleared("round1", 1, "clean")],
  },
  // -------------------------------------------------------------------- misc
  {
    id: "misc.unconfigured",
    message: "repository not configured",
    kind: "unavailable",
    writer: W(
      "src/repair/loop-work.ts",
      `"repository not configured",`,
      "w.misc.unconfigured",
    ),
    trigger: "human",
    variants: [NO_INTENT],
  },
  {
    id: "misc.legacy_loss",
    message: LEGACY_LOSS_DETAIL,
    kind: "missing_evidence",
    writer: W(
      "src/repair/loop-legacy-loss.ts",
      "export const LEGACY_LOSS_DETAIL =",
      "w.misc.legacy_loss",
    ),
    trigger: "legacy",
    variants: [pub("round1", 1, "p1")],
  },
];
