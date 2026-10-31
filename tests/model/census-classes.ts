/**
 * The closed census of blocked classes (Part A rows): every blocker message
 * the installed runtime (or an older generation whose rows are still live)
 * writes, each with its writer anchor, how it is reached, the record shapes
 * it leaves and the worlds it can observe. Messages are built from the
 * source's own constants wherever the source exports them.
 */
import {
  ATTEMPT_DETAIL_ARTIFACT_ONLY,
  ATTEMPT_DETAIL_INCOMPLETE,
  ATTEMPT_DETAIL_INTERRUPTED_BOUND,
  ATTEMPT_DETAIL_LOOP_STOP,
  ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
  ATTEMPT_DETAIL_PROVIDER_THROTTLED,
  ATTEMPT_DETAIL_UNCERTAIN,
} from "../../src/repair/attempt-policy.ts";
import {
  CI_FIX_EXHAUSTED_PREFIX,
  CI_PRE_REVIEW_PENDING_PREFIX,
  CI_PRE_REVIEW_RED_PREFIX,
} from "../../src/repair/ci-first-policy.ts";
import { CONFLICT_PROTECTED_DETAIL } from "../../src/repair/conflict-resolution.ts";
import {
  MATRIX_PRESERVATION_UNCERTAINTY_DETAIL,
  MATRIX_UNCERTAINTY_DETAIL,
} from "../../src/host/matrix-uncertainty-maintenance.ts";
import { HISTORICAL_NOT_STARTED_DETAIL } from "../../src/host/matrix-quarantine-state.ts";
import { PRESERVATION_VALIDATION_REFUSED } from "../../ops/hosted-autonomy-blocked-candidate.ts";
import { PRESERVATION_ABSENT_BLOCKER } from "../../ops/hosted-autonomy-preservation-disposition.ts";
import { CANDIDATE_REF_IDENTITY_MISMATCH } from "../../ops/hosted-autonomy-candidate-refs.ts";
import {
  CAP,
  cleared,
  CORRECTION,
  FRESH,
  LEGACY_FIX,
  NO_INTENT,
  type ParkClassV1,
  pub,
  type TriggerV1,
  type VariantV1,
  W,
} from "./census-shapes.ts";
import { LATE_CLASSES } from "./census-classes-late.ts";

export type { ParkClassV1, TriggerV1, VariantV1 };

// ------------------------------------------------------------------ classes
const IMPL = "src/repair/loop-implementation-result.ts";
const IMPL_START = "src/repair/loop-implementation.ts";
const POLICY = "src/repair/attempt-policy.ts";

export const PARK_CLASSES: ParkClassV1[] = [
  {
    id: "impl.no_receipt",
    message: ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
    kind: "other",
    writer: W(
      POLICY,
      `"model run ended without a trusted receipt"`,
      "w.impl.no_receipt",
    ),
    trigger: "pipeline",
    variants: [FRESH, CORRECTION, CAP],
  },
  {
    id: "impl.failed",
    message: ATTEMPT_DETAIL_PROVIDER_THROTTLED,
    kind: "other",
    writer: W(POLICY, `"model run failed (unavailable)"`, "w.impl.failed"),
    trigger: "pipeline",
    variants: [FRESH, CORRECTION],
  },
  {
    id: "impl.cutoff",
    message:
      "implementation start is past the model cutoff or no longer fits the run bounds",
    kind: "other",
    writer: W(
      "ops/hosted-autonomy-policy.ts",
      `"implementation start is past the model cutoff or no longer fits the run bounds"`,
      "w.impl.cutoff",
    ),
    trigger: "pipeline",
    variants: [FRESH],
  },
  {
    id: "impl.incomplete",
    message: ATTEMPT_DETAIL_INCOMPLETE,
    kind: "other",
    writer: W(
      IMPL,
      "let incompleteMessage: string = ATTEMPT_DETAIL_INCOMPLETE;",
      "w.impl.incomplete",
    ),
    trigger: "pipeline",
    variants: [FRESH, CORRECTION],
  },
  {
    id: "impl.interrupted_bound",
    message: ATTEMPT_DETAIL_INTERRUPTED_BOUND,
    kind: "other",
    writer: W(
      "ops/hosted-autonomy-output-bound.ts",
      "ATTEMPT_DETAIL_INTERRUPTED_BOUND,",
      "w.impl.interrupted_bound",
    ),
    trigger: "pipeline",
    variants: [FRESH],
  },
  {
    id: "impl.loop_stop",
    message: ATTEMPT_DETAIL_LOOP_STOP,
    kind: "other",
    writer: W(
      IMPL,
      "if (loopStopped) incompleteMessage = ATTEMPT_DETAIL_LOOP_STOP;",
      "w.impl.loop_stop",
    ),
    trigger: "pipeline",
    variants: [FRESH, CORRECTION],
  },
  {
    id: "impl.artifact_only",
    message: ATTEMPT_DETAIL_ARTIFACT_ONLY,
    kind: "other",
    writer: W(
      IMPL,
      `"model candidate changed only generated/cache artifacts";`,
      "w.impl.artifact_only",
    ),
    trigger: "pipeline",
    variants: [FRESH, CORRECTION],
  },
  {
    id: "impl.uncertain",
    message: ATTEMPT_DETAIL_UNCERTAIN,
    kind: "other",
    writer: W(
      IMPL,
      `markBlocked(record, "other", ATTEMPT_DETAIL_UNCERTAIN, now)`,
      "w.impl.uncertain",
    ),
    trigger: "pipeline",
    variants: [FRESH, CORRECTION],
  },
  {
    id: "impl.matrix_uncertain",
    message: MATRIX_UNCERTAINTY_DETAIL,
    kind: "other",
    writer: W(
      "src/host/matrix-uncertainty-maintenance.ts",
      'markBlocked(saved, "other", MATRIX_UNCERTAINTY_DETAIL, row.updatedAt)',
      "w.impl.matrix_uncertain",
    ),
    trigger: "pipeline",
    variants: [FRESH, CORRECTION],
  },
  {
    id: "impl.budget_exhausted",
    message: "implementation attempt budget exhausted",
    kind: "review_quota",
    writer: W(
      "src/repair/loop-state.ts",
      `record.blocker.message === "implementation attempt budget exhausted"`,
      "w.impl.budget_exhausted",
    ),
    trigger: "legacy",
    variants: [FRESH],
  },
  {
    id: "impl.admission_duplicate",
    message: "model admission refused: duplicate",
    kind: "unavailable",
    writer: W(
      IMPL_START,
      "`model admission refused: ${reservation.status}`",
      "w.impl.admission",
    ),
    trigger: "contradiction",
    variants: [NO_INTENT],
  },
  {
    id: "impl.admission_disabled",
    message: "model admission refused: disabled",
    kind: "unavailable",
    writer: "w.impl.admission",
    trigger: "pipeline",
    variants: [NO_INTENT],
  },
  {
    id: "impl.historical_not_started",
    message: HISTORICAL_NOT_STARTED_DETAIL,
    kind: "other",
    writer: W(
      "src/host/matrix-quarantine-state.ts",
      "export const HISTORICAL_NOT_STARTED_DETAIL =",
      "w.impl.historical_not_started",
    ),
    trigger: "legacy",
    variants: [FRESH],
  },
  {
    id: "impl.manifest_rejected",
    message:
      "authenticated historical matrix manifest rejected: reservation_after_manifest; model outcome uncertain",
    kind: "other",
    writer: W(
      "src/host/matrix-artifact-port.ts",
      `"authenticated historical matrix manifest rejected: reservation_after_manifest; model outcome uncertain"`,
      "w.impl.manifest_rejected",
    ),
    trigger: "legacy",
    variants: [FRESH],
  },
  {
    id: "impl.protected_path",
    message: CONFLICT_PROTECTED_DETAIL,
    kind: "other",
    writer: W(
      IMPL,
      `"candidate touches a protected path",`,
      "w.impl.protected_path",
    ),
    trigger: "pipeline",
    variants: [
      { tag: "noted", candidate: "noted", intent: "none" },
      {
        tag: "conflict_marker",
        candidate: "published",
        intent: "conflict_spent",
        rounds: 1,
        review: "clean",
      },
    ],
  },
  {
    id: "impl.preservation_unrecoverable",
    message: PRESERVATION_ABSENT_BLOCKER,
    kind: "other",
    writer: W(
      "ops/hosted-autonomy-preservation-disposition.ts",
      'return { kind: "dispose", message: PRESERVATION_ABSENT_BLOCKER };',
      "w.impl.preservation_unrecoverable",
    ),
    trigger: "pipeline",
    variants: [NO_INTENT],
  },
  // ---------------------------------------------- matrix cell refusals
  // Every `failed`/`not_started` matrix cell is settled by the ingester with
  // the cell's own refusal detail as the blocker (`matrix-ingest.ts`).
  ...[
    [
      "cell.source_read_unavailable",
      "source issue read is unavailable",
      "pipeline",
    ],
    ["cell.source_changed", "source issue changed after planning", "human"],
    [
      "cell.native_dependencies",
      "source issue has open native dependencies",
      "human",
    ],
    [
      "cell.state_unavailable",
      "authoritative repair state is unavailable",
      "pipeline",
    ],
    ["cell.bundle_failed", "candidate bundle could not be created", "pipeline"],
    [
      "cell.bundle_capability",
      "candidate bundle capability is unavailable",
      "pipeline",
    ],
    [
      "cell.runtime_mismatch",
      "actual runtime revision/generation does not match grant",
      "contradiction",
    ],
    [
      "cell.base_not_current",
      "planned base is no longer current",
      "contradiction",
    ],
    ["cell.no_receipt", "matrix cell produced no trusted receipt", "pipeline"],
  ].map(([id, message, trigger]): ParkClassV1 => ({
    id,
    message,
    kind: "other",
    writer: W(
      id === "cell.no_receipt"
        ? "src/host/matrix-ingest.ts"
        : "src/host/matrix-cell.ts",
      `"${message}"`,
      `w.${id}`,
    ),
    trigger: trigger as TriggerV1,
    variants: [FRESH],
  })),
  // ------------------------------------------------------------ preservation
  {
    id: "pres.validation_refused",
    message: PRESERVATION_VALIDATION_REFUSED,
    kind: "other",
    writer: W(
      "src/repair/loop-preservation.ts",
      `"candidate preservation validation refused",`,
      "w.pres.validation_refused",
    ),
    trigger: "pipeline",
    variants: [{ tag: "noted", candidate: "noted", intent: "none" }],
  },
  {
    id: "pres.matrix_uncertainty",
    message: MATRIX_PRESERVATION_UNCERTAINTY_DETAIL,
    kind: "other",
    writer: W(
      "src/host/matrix-uncertainty-maintenance.ts",
      "export const MATRIX_PRESERVATION_UNCERTAINTY_DETAIL =",
      "w.pres.matrix_uncertainty",
    ),
    trigger: "pipeline",
    refsAbsentWorlds: true,
    variants: [{ tag: "noted", candidate: "noted", intent: "preservation" }],
  },
  {
    id: "pres.ref_identity_mismatch",
    message: CANDIDATE_REF_IDENTITY_MISMATCH,
    kind: "other",
    writer: W(
      "src/repair/loop-publication.ts",
      `"candidate branch ref identity mismatch",`,
      "w.pres.ref_identity_mismatch",
    ),
    trigger: "contradiction",
    variants: [cleared("published", 1, "none")],
  },
  {
    id: "pres.ref_missing",
    message: "published candidate ref is missing",
    kind: "other",
    writer: W(
      "src/repair/loop-publication.ts",
      `"published candidate ref is missing",`,
      "w.pres.ref_missing",
    ),
    trigger: "human",
    variants: [cleared("published", 1, "none")],
  },
  // ------------------------------------------------------------- publication
  {
    id: "pub.pr_base_mismatch",
    message: "PR base identity mismatch",
    kind: "other",
    writer: W(
      "src/repair/loop-publication.ts",
      `"PR base identity mismatch",`,
      "w.pub.pr_base_mismatch",
    ),
    trigger: "human",
    variants: [cleared("published", 0, "none")],
  },
  {
    id: "pub.pr_head_mismatch",
    message: "PR head identity mismatch",
    kind: "other",
    writer: W(
      "src/repair/loop-publication.ts",
      `"PR head identity mismatch",`,
      "w.pub.pr_head_mismatch",
    ),
    trigger: "human",
    variants: [cleared("published", 0, "none")],
  },
  {
    id: "pub.pr_identity_mismatch",
    message: "PR publication identity mismatch",
    kind: "other",
    writer: W(
      "src/repair/loop-publication-state.ts",
      `"PR publication identity mismatch",`,
      "w.pub.pr_identity_mismatch",
    ),
    trigger: "contradiction",
    variants: [cleared("published", 0, "none")],
  },
  // ---------------------------------------------------------------- CI first
  {
    id: "ci.pre_review_red",
    message: `${CI_PRE_REVIEW_RED_PREFIX}validate(failure)`,
    kind: "other",
    writer: W(
      "src/repair/loop-ci-first.ts",
      'markBlocked(record, "other", preReviewRedDetail(checks), now)',
      "w.ci.pre_review_red",
    ),
    trigger: "pipeline",
    variants: [
      pub("new", 0, "none"),
      pub("corrected", 2, "none", { ciFixes: 1 }),
      pub("legacy", 3, "none", LEGACY_FIX),
    ],
  },
  {
    id: "ci.pre_review_pending",
    message: `${CI_PRE_REVIEW_PENDING_PREFIX}validate(in_progress)`,
    kind: "other",
    writer: W(
      "src/repair/loop-ci-first.ts",
      'markBlocked(record, "other", detail(checks), now)',
      "w.ci.pre_review_pending",
    ),
    trigger: "pipeline",
    variants: [pub("new", 0, "none")],
  },
  {
    id: "ci.fix_exhausted",
    message: `${CI_FIX_EXHAUSTED_PREFIX}validate(failure)`,
    kind: "other",
    writer: W(
      "src/repair/ci-first-policy.ts",
      'export const CI_FIX_EXHAUSTED_PREFIX = "CI fix attempts exhausted (3 of 3): ";',
      "w.ci.fix_exhausted",
    ),
    trigger: "pipeline",
    variants: [pub("new", 0, "none", { ciFixes: 3 })],
  },
  ...LATE_CLASSES,
];
