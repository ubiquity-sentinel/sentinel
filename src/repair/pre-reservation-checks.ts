/**
 * Deterministic pre-reservation admission checks (#333).
 *
 * Every admission and preservation refusal that is decidable from the work
 * record, the trusted target configuration and already-observed live facts is
 * evaluated here, BEFORE the implementation start is reserved, charged or run.
 * A refused record is never reserved: the caller persists the precise reason
 * code on the record through the existing trusted work write. Checks that need
 * the produced candidate (its diff, blobs and protected entries) cannot run
 * before the turn; the post-inference refusal names that check instead
 * (`preservationRefusalMessage`).
 *
 * Pure: no clock, port, state or network access; every input is a value.
 */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { ReservationPurposeV1 } from "../contracts/budget-reservation.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { allReservationsV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { admittedImplementationWork } from "../budget/budget-state.ts";
import { sameLogicalIdentity } from "../budget/budget-rolling.ts";
import { normalizeProtectedPaths } from "../github/snapshot-git-wire.ts";
import {
  PUBLICATION_BINARY_DETAIL,
  PUBLICATION_BOUND_DETAIL,
  PUBLICATION_COMMIT_BOUND_DETAIL,
  PUBLICATION_COMMIT_DETAIL,
  PUBLICATION_EMPTY_DETAIL,
  PUBLICATION_FILE_BOUND_DETAIL,
  PUBLICATION_ISSUE_DETAIL,
  PUBLICATION_LIST_DETAIL,
  PUBLICATION_METADATA_BOUND_DETAIL,
  PUBLICATION_METADATA_DETAIL,
  PUBLICATION_METADATA_SECRET_DETAIL,
  PUBLICATION_MODE_DETAIL,
  PUBLICATION_OBJECT_BOUND_DETAIL,
  PUBLICATION_OVERBOUND_DETAIL,
  PUBLICATION_PATH_DETAIL,
  PUBLICATION_PROTECTED_DETAIL,
  PUBLICATION_PUBLISHED_HEAD_DETAIL,
  PUBLICATION_SECRET_DETAIL,
  PUBLICATION_STALE_BASE_DETAIL,
  PUBLICATION_STATUS_DETAIL,
  PUBLICATION_STRUCTURE_DETAIL,
  PUBLICATION_SUBMODULE_DETAIL,
  PUBLICATION_SYMLINK_DETAIL,
  PUBLICATION_UTF8_DETAIL,
} from "../github/snapshot-policy.ts";

/** Names of the deterministic checks, in evaluation order. */
export type PreReservationCheckV1 =
  | "repository_identity"
  | "task_identity"
  | "base_revision"
  | "source_freshness"
  | "opt_out_marker"
  | "candidate_ref"
  | "protected_paths"
  | "output_bounds"
  | "attempt_identity"
  | "admission_transition";

export type PreReservationResultV1 =
  | { ok: true }
  | { ok: false; refused: string; check: PreReservationCheckV1 };

/** The trusted configuration slice the checks read. */
export type PreReservationTargetPolicyV1 = Pick<
  RepositoryConfigV1,
  "protectedPaths" | "sessionBound"
>;

/** Already-observed live facts; nothing here is read by this module. */
export interface PreReservationLiveFactsV1 {
  /** The issue observed for the model, or null for non-issue work. */
  issue: { number: number; title: string; body: string } | null;
  /**
   * The configured base tip read for this admission, when the caller read it
   * (queued issue work). Undefined means freshness was not observed here; an
   * unreadable base is a transient wait the caller owns, never a refusal.
   */
  latestBase?: GitSha;
  /** The branch the implementation intent will publish to. */
  candidateRef: string | null;
  /** The exact admission the budget would be asked to reserve. */
  admission: {
    reservationId: string;
    attempt: number;
    purpose: ReservationPurposeV1;
    nextWork: WorkRecordV1;
    now: number;
    snapshot: RepairStateSnapshotV1;
  };
}

/** Same task id grammar the budget's frozen request parser accepts. */
const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
/** The exact standalone first-line opt-out marker (`local-github.ts`). */
const SKIP_MARKER_PATTERN = /^<!-- sentinel:skip -->(?:\r?\n|$)/;
const MAX_REF_CHARS = 255;

/** Message prefix every pre-reservation refusal is persisted under. */
export const PRE_RESERVATION_REFUSED_PREFIX =
  "model admission refused: pre-reservation";

/** The persisted blocker message for one pre-reservation refusal. */
export function preReservationRefusalMessage(
  refusal: { refused: string; check: PreReservationCheckV1 },
): string {
  return `${PRE_RESERVATION_REFUSED_PREFIX} ${refusal.check}: ${refusal.refused}`;
}

/**
 * `git check-ref-format --branch` rules for a branch name, without a process:
 * no empty, dot-leading or `.lock` component, no `..`, `@{`, `//`, control,
 * space or `~^:?*[\` character, no trailing `/` or `.`, never `@`.
 */
export function isValidBranchName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (name.length > MAX_REF_CHARS || name === "@") return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) {
    return false;
  }
  if (name.endsWith("/") || name.endsWith(".") || name.startsWith("/")) {
    return false;
  }
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split("/").every((part) =>
    part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")
  );
}

const refuse = (
  check: PreReservationCheckV1,
  refused: string,
): PreReservationResultV1 => ({ ok: false, refused, check });

function boundsValid(policy: PreReservationTargetPolicyV1): boolean {
  const bound = policy.sessionBound;
  if (bound === null) return false;
  const positive = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  return positive(bound.maxDurationMs) && positive(bound.maxOutputChars);
}

/**
 * Evaluate every deterministic admission/preservation precondition for one
 * implementation start. Returns ok, or the FIRST refused check with its
 * precise reason code. Never mutates its inputs.
 */
export function preReservationChecks(
  record: WorkRecordV1,
  targetPolicy: PreReservationTargetPolicyV1,
  liveFacts: PreReservationLiveFactsV1,
): PreReservationResultV1 {
  try {
    parseRepositoryIdentity(record.repository, "$.repository");
  } catch {
    return refuse("repository_identity", "repository_identity_invalid");
  }
  if (typeof record.id !== "string" || !TASK_ID_PATTERN.test(record.id)) {
    return refuse("task_identity", "task_id_invalid");
  }
  if (!isGitSha(record.target.base)) {
    return refuse("base_revision", "base_not_commit_sha");
  }
  if (
    liveFacts.latestBase !== undefined &&
    liveFacts.latestBase !== record.target.base
  ) {
    return refuse("source_freshness", "base_stale");
  }
  if (
    liveFacts.issue !== null && SKIP_MARKER_PATTERN.test(liveFacts.issue.body)
  ) {
    return refuse("opt_out_marker", "sentinel_skip_marker");
  }
  if (liveFacts.candidateRef === null) {
    return refuse("candidate_ref", "candidate_ref_absent");
  }
  if (!isValidBranchName(liveFacts.candidateRef)) {
    return refuse("candidate_ref", "candidate_ref_invalid");
  }
  if (normalizeProtectedPaths(targetPolicy.protectedPaths) === null) {
    return refuse("protected_paths", "protected_paths_malformed");
  }
  if (!boundsValid(targetPolicy)) {
    return refuse("output_bounds", "session_bound_invalid");
  }

  const admission = liveFacts.admission;
  if (!Number.isSafeInteger(admission.attempt) || admission.attempt < 1) {
    return refuse("attempt_identity", "attempt_invalid");
  }
  const request = {
    repository: record.repository,
    taskId: record.id,
    head: record.target.base,
    attempt: admission.attempt,
    purpose: admission.purpose,
  };
  const reservations: readonly BudgetReservationV1[] = allReservationsV1(
    admission.snapshot,
  );
  // The budget refuses as `invalid` an id owned by a different logical
  // identity and the same identity under a different id; the exact same
  // identity under the same id is its `duplicate`, which keeps its own
  // existing recovery and is left to the budget.
  let duplicate = false;
  for (const reservation of reservations) {
    const same = sameLogicalIdentity(
      reservation,
      request.repository,
      request.taskId,
      request.head,
      request.attempt,
      request.purpose,
    );
    if (reservation.id === admission.reservationId && !same) {
      return refuse("attempt_identity", "reservation_id_collision");
    }
    if (reservation.id !== admission.reservationId && same) {
      return refuse("attempt_identity", "logical_identity_collision");
    }
    if (same) duplicate = true;
  }
  if (duplicate) return { ok: true };
  const admitted = admittedImplementationWork(
    {
      ...request,
      implementationTransition: {
        expectedStateHead: "0".repeat(40) as GitSha,
        expectedWork: record,
        nextWork: admission.nextWork,
      },
    },
    admission.reservationId,
    admission.snapshot,
    admission.now,
  );
  if (admitted === null) {
    return refuse("admission_transition", "transition_not_admissible");
  }
  return { ok: true };
}

/** The runtime's post-inference preservation refusal prefix (unchanged). */
export const PRESERVATION_REFUSED_PREFIX =
  "candidate preservation validation refused";

/**
 * Post-inference publication checks: each needs the produced candidate, so it
 * cannot be evaluated before the turn. The refusal names the exact check.
 */
const POST_INFERENCE_CHECKS: ReadonlyArray<readonly [string, string]> = [
  [PUBLICATION_OVERBOUND_DETAIL, "git_read_bound"],
  [PUBLICATION_COMMIT_DETAIL, "commit_identity"],
  [PUBLICATION_STALE_BASE_DETAIL, "base_ancestry"],
  [PUBLICATION_PUBLISHED_HEAD_DETAIL, "published_head_ancestry"],
  [PUBLICATION_EMPTY_DETAIL, "empty_candidate"],
  [PUBLICATION_COMMIT_BOUND_DETAIL, "commit_count_bound"],
  [PUBLICATION_OBJECT_BOUND_DETAIL, "object_count_bound"],
  [PUBLICATION_LIST_DETAIL, "object_list"],
  [PUBLICATION_BOUND_DETAIL, "aggregate_bytes_bound"],
  [PUBLICATION_METADATA_DETAIL, "commit_metadata_text"],
  [PUBLICATION_METADATA_BOUND_DETAIL, "commit_metadata_bound"],
  [PUBLICATION_METADATA_SECRET_DETAIL, "commit_metadata_secret"],
  [PUBLICATION_ISSUE_DETAIL, "issue_closing_reference"],
  [PUBLICATION_PROTECTED_DETAIL, "protected_entry"],
  [PUBLICATION_STRUCTURE_DETAIL, "structural_change"],
  [PUBLICATION_PATH_DETAIL, "changed_path"],
  [PUBLICATION_MODE_DETAIL, "file_mode"],
  [PUBLICATION_SYMLINK_DETAIL, "symlink"],
  [PUBLICATION_SUBMODULE_DETAIL, "submodule"],
  [PUBLICATION_STATUS_DETAIL, "change_status"],
  [PUBLICATION_BINARY_DETAIL, "binary_blob"],
  [PUBLICATION_UTF8_DETAIL, "utf8_text"],
  [PUBLICATION_FILE_BOUND_DETAIL, "file_size_bound"],
  [PUBLICATION_SECRET_DETAIL, "secret_shaped_text"],
];

/** The post-inference check a trusted publication refusal detail names. */
export function postInferenceCheckName(detail: unknown): string {
  return POST_INFERENCE_CHECKS.find(([known]) => known === detail)?.[1] ??
    "unclassified";
}

/**
 * The persisted post-inference preservation refusal: the unchanged prefix and
 * the specific check that could not be evaluated before the turn.
 */
export function preservationRefusalMessage(detail: unknown): string {
  return `${PRESERVATION_REFUSED_PREFIX}: ${postInferenceCheckName(detail)}`;
}

/** A historical exact or a check-named preservation refusal message. */
export function isPreservationRefusalMessage(message: string): boolean {
  return message === PRESERVATION_REFUSED_PREFIX ||
    message.startsWith(`${PRESERVATION_REFUSED_PREFIX}: `);
}
