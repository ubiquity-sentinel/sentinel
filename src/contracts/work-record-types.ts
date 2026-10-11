import type {
  GitSha,
  IncidentFingerprint,
  SourceSnapshotDigest,
  WorkItemId,
} from "./brands.ts";
import type {
  EvidenceRefV1,
  RepositoryIdentityV1,
  SeverityV1,
} from "./shared.ts";

export type NextStepV1 = "work" | "review" | "delivery" | "blocked" | "done";
export type WorkWaitReasonV1 =
  | "budget_cap"
  | "review_pending"
  /**
   * Explicit TRANSIENT quota-exhausted / review-unavailable state. Distinct
   * from a terminal `blocked` record: the shared model-start quota (which also
   * charges review requests) is exhausted, or the review transport is
   * transiently unavailable. A record in this state keeps producing/updating
   * its publication and is retroactively drained by the review pass when quota
   * returns; it never terminally blocks by itself. A healthy review that has
   * simply not posted yet keeps the ordinary bounded `review_pending` poll.
   */
  | "review_quota"
  /**
   * Explicit TRANSIENT CI-not-yet-green state for the delivery phase. The
   * repair PR's checks are still running; the record waits bounded (like
   * `review_pending`) and the next turn re-observes. Never blocks by itself;
   * a failed check transitions to a terminal blocker instead.
   */
  | "ci_pending"
  | "backoff"
  | "unavailable"
  | "manual";
export type BlockerKindV1 =
  | "stale_source"
  | "missing_evidence"
  | "evidence_expired"
  | "dependency"
  | "review_quota"
  | "unavailable"
  | "other";
export type IncompleteOpKindV1 =
  | "pull_request"
  | "review_request"
  | "merge"
  | "issue_closure"
  | "already_satisfied_closure"
  | "push"
  | "implementation"
  | "replay"
  | "base_refresh"
  | "candidate_preservation";
export type TaskSourceKindV1 = "issue" | "incident" | "review_backlog";

export interface WorkWaitV1 {
  reason: WorkWaitReasonV1;
  since: number;
  /** Timestamp the wait ends (next retry/review arrival); null when unknown. */
  until: number | null;
}

export interface WorkBlockerV1 {
  kind: BlockerKindV1;
  message: string;
  since: number;
}

/**
 * Bounded, durable record of the last failed execution of an incomplete
 * operation. Only closed port failure identities are stored (never raw
 * upstream text, request bodies or credentials), and `attempts` counts the
 * consecutive failed executions of THIS exact intent so a livelock is visible
 * and can be bounded instead of re-arming a silent wait forever.
 */
export interface OperationFailureV1 {
  /** Closed port error kind (e.g. `unavailable`, `conflict`, `invalid`). */
  kind: string;
  /** Bounded port error detail constant for that kind. */
  detail: string;
  atMs: number;
  /** Consecutive failed executions of this exact intent. */
  attempts: number;
}

/**
 * Typed exact identity of an incomplete external operation. Recovery after a
 * push/review/merge needs the exact head, observed base, deterministic branch,
 * PR number and the external request/result identities — never a free-text
 * detail or model-supplied JSON. `pr`/`requestId`/`resultId` stay null until
 * the object exists; the key remains the deterministic idempotency key.
 *
 * `base_refresh` reuses these fields: `expectedHead` is the old candidate,
 * `observedBase` the newly observed configured base and `resultId` the exact
 * deterministic prepared commit once generated (null before preparation). It
 * has no external request id, and `target` stays on the old base/head until the
 * prepared commit was actually published.
 */
export interface IncompleteOperationV1 {
  kind: IncompleteOpKindV1;
  /** Deterministic idempotency key for the persisted-before-effects intent. */
  key: string;
  startedAt: number;
  /** Deterministic branch the operation uses; null when not branch-scoped. */
  branch: string | null;
  /** Exact head expected/pushed; null when not applicable. */
  expectedHead: GitSha | null;
  /** Base observed before starting; null when not applicable. */
  observedBase: GitSha | null;
  /** PR number; null before creation or for non-PR operations. */
  pr: number | null;
  /** External request id (e.g. review request); null before it exists. */
  requestId: string | null;
  /** External result id (e.g. review result, merge SHA); null before result. */
  resultId: string | null;
  /**
   * Last failed execution of this exact intent. ABSENT means no failed
   * execution was ever recorded — the exact shape of every row written before
   * this field existed — and a default is never injected, so legacy bytes
   * round-trip exactly. A present key must carry the complete bounded record;
   * clearing a failure deletes the key.
   */
  failure?: OperationFailureV1;
}

/** Explicit selection urgency attached to a work item at intake. */
export interface SelectionUrgencyV1 {
  /** Active production incident feeding this work item. */
  activeProduction: boolean;
  /** Reproducible unresolved 5xx group. */
  reproducible5xx: boolean;
  /** Known severe security/data-loss work. */
  severeSecurityOrDataLoss: boolean;
}

/**
 * V1 candidate-preservation binding for one produced Git candidate. Written
 * only by the trusted future candidate-preservation writer; this reader never
 * produces it. `operationKey` is the producing operation key (the existing
 * bounded intent-key identity), and `ref` is the exact preservation ref.
 */
export interface CandidatePreservationV1 {
  operationKey: string;
  base: GitSha;
  head: GitSha;
  ref: string;
}

/**
 * V1 candidate state attached to a work target. `preserved: null` means the
 * record is parked before/without a preserved candidate and is NOT evidence
 * that any candidate is durable. Absence of the whole group is the exact
 * legacy shape and is never defaulted when parsing.
 */
export interface CandidateStateV1 {
  preserved: CandidatePreservationV1 | null;
  publishedHead: GitSha | null;
}

export interface WorkTargetV1 {
  /** Target base validated at the last action. */
  base: GitSha;
  /** Checkpoint branch name; null when no checkpoint branch exists. */
  branch: string | null;
  checkpoint: { branch: string; sha: GitSha } | null;
  /** Candidate head; null until a candidate is produced. */
  head: GitSha | null;
  /** PR number; null until published. */
  pr: number | null;
  /**
   * Optional V1 candidate state. Absent on every legacy record; present only
   * for records the candidate-preservation writer owns. Never injected.
   */
  candidateState?: CandidateStateV1;
}

export interface WorkCountersV1 {
  /** Total candidate invocations (work actions actually run). */
  attempts: number;
  /** Automatic retries of failed work; observation never increments either. */
  retries: number;
  /** Codex review rounds used on this work item. */
  reviewRounds: number;
  /**
   * Consecutive executions of this record that advanced nothing durable (the
   * lifecycle, target, intent identity, blocker and counters all stayed put, so
   * the execution only re-armed a wait). ABSENT means zero — the exact shape of
   * every row written before this counter existed — and a default is never
   * injected, so legacy bytes round-trip exactly. Selection uses it as a
   * per-record no-progress budget: a record past the budget is ordered behind
   * records that did advance, inside its own plan bucket.
   */
  stalled?: number;
  /**
   * Consecutive matrix-cell host timeouts (the runner was killed before the
   * cell wrote its result artifact, so the model run's work was discarded).
   * ABSENT means zero — the exact shape of every row written before this
   * counter existed — and a default is never injected, so legacy bytes
   * round-trip exactly. When this reaches MATRIX_DECOMPOSE_AFTER_TIMEOUTS the
   * planner decomposes the issue into serial sub-tasks instead of granting
   * the whole issue again, so a timeout discards at most one part's work.
   */
  timeouts?: number;
}

export interface WorkRecordV1 {
  version: "v1";
  kind: "work";
  /** Repository this work item belongs to (stable source identity). */
  repository: RepositoryIdentityV1;
  id: WorkItemId;
  /** Immutable source identity: kind plus the exact captured revision. */
  source: { kind: TaskSourceKindV1; id: string; revision: string };
  related: { incidentId: string | null; issueNumber: number | null };
  /** Stable incident fingerprint for incident tasks; null otherwise. */
  fingerprint: IncidentFingerprint | null;
  /** Original failing target revision; immutable, never rewritten on resume. */
  failingRevision: GitSha | null;
  /** Digest of the captured source snapshot (provenance), if captured. */
  sourceSnapshotDigest: SourceSnapshotDigest | null;
  classification: { severity: SeverityV1; priority: number | null };
  /** Explicit selection urgency; no module-owned side map is required. */
  urgency: SelectionUrgencyV1;
  /** Other work items that must complete first (bounded, exact ids). */
  dependencies: WorkItemId[];
  /** Sentinel controller commit that owns this record; immutable. */
  controller: { sha: GitSha };
  target: WorkTargetV1;
  nextStep: NextStepV1;
  wait: WorkWaitV1 | null;
  blocker: WorkBlockerV1 | null;
  counters: WorkCountersV1;
  evidence: EvidenceRefV1[];
  intent: IncompleteOperationV1 | null;
  /** Source first seen (incident) / issue creation; null when unknown. */
  firstSeenAt: number | null;
  createdAt: number;
  updatedAt: number;
}
