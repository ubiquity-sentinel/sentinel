/** Repair loop internals: types. */
import type { BudgetControllerV1 } from "../budget/mod.ts";
import type { FixtureDigest, GitSha } from "../contracts/brands.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
  ImplementationPort,
  IncidentAdapter,
  IsolatedReplayResultV1,
  ModelRunRequestV1,
  PortResultV1,
  ReplayPort,
  StateReadView,
  StateWriteResultV1,
} from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

export interface RepairCycleDepsV1 {
  clock: Clock;
  /** Repair read view plus the one trusted repair writer; never release write. */
  state: StateReadView & {
    writeRepair(
      next: RepairStateSnapshotV1,
      expectedHead: GitSha | null,
    ): Promise<PortResultV1<StateWriteResultV1>>;
  };
  /** Complete trusted repository configuration set (budget agreement + commands). */
  configs: readonly RepositoryConfigV1[];
  /** Exact Sentinel controller SHA that owns every new work record; immutable. */
  controllerSha: GitSha;
  github: GitHubPort;
  /**
   * The one durable GitHub cooldown gate. The trusted host MUST supply the
   * same DurableGitHubCooldownGate instance it injected into the GitHub
   * client/token acquisition and the GitHubPort implementation — there is no
   * independent/default gate here. beforeRequest is checked before any GitHub
   * read (issue intake, published ref reads) and before any model reservation
   * or publication; an ordinary rate_limited denial defers the operation
   * (a cooling installation never reaches a fake port, a state write or a
   * model reservation) and a gate fault fails closed as state_error.
   */
  githubCooldown: GitHubCooldownGateV1;
  incidents: IncidentAdapter;
  replay: ReplayPort;
  /**
   * Trusted fixture metadata source. The frozen ReplayPort intentionally only
   * executes a request; its resolver remains host-owned. A host may also
   * expose this method on the injected replay object for one shared adapter.
   */
  fixtureIdentities?: ReplayFixtureIdentitySourceV1;
  model: ImplementationPort;
  /**
   * Trusted route-selected implementation model id for every start this run
   * admits. When omitted the injected implementation port's own configured
   * model id is used, and when neither is available the frozen gateway default
   * (`gpt-reserve`) applies. The id is submitted verbatim and recorded in the
   * receipt; it is never rewritten per request.
   */
  modelId?: string;
  /** The one production admission controller (RollingStartBudget). */
  budget: BudgetControllerV1;
  /** Matrix-owned implementations settle only through authenticated artifact ingestion. */
  externalImplementations?: boolean;
  /**
   * The one-time legacy review class's cutoff (`review-round-cap.ts`): the
   * one instant no later than the first CI-first runtime's activation
   * (`LEGACY_REVIEW_CUTOFF`), handed over by the launcher to runs of a pinned
   * CI-first revision. Absent or null means no record is legacy (no final
   * round is ever granted).
   */
  legacyReviewCutoff?: number | null;
}

/** Read-only trusted identity lookup paired with the concrete fixture resolver. */
export interface ReplayFixtureIdentitySourceV1 {
  resolveTestIds(
    fixtureRef: string,
    fixtureDigest: FixtureDigest,
  ): Promise<PortResultV1<readonly string[]>>;
}

export interface RepairCycleOptionsV1 {
  /** Absolute deadline of this run; declared operations must fit the margin. */
  deadline: number;
  /** Bounded persisted transitions per run. */
  stepLimit?: number;
  /**
   * Trusted ORIGINAL run start instant (the entrypoint captured it once). The
   * 90-minute model cutoff and the 120-minute ceiling are anchored to this
   * instant, so a shortened loop deadline can never shift the model cutoff
   * later. Direct callers that omit it keep the previous behavior (the cycle
   * start is the run start).
   */
  runStartedAt?: number;
  /**
   * Trusted host confirmation that NEW model starts are available. `false`
   * makes the existing pre-admission model cutoff unreachable so the run does
   * deterministic bookkeeping only: no budget, record or total-deadline
   * behavior changes, and an omitted value keeps the existing cutoff.
   */
  modelStartsEnabled?: boolean;
}

export type RepairCycleOutcomeV1 =
  | { status: "idle"; detail: string }
  | { status: "margin"; detail: string }
  | { status: "step_limit"; steps: number }
  | { status: "state_error"; detail: string }
  | { status: "source_error"; detail: string };

/** One-shot deterministic continuation retained by the entrypoint during drain. */
export type PostDrainReviewContinuationV1 = (
  operationKeys: readonly string[],
) => Promise<RepairCycleOutcomeV1 | null>;

/**
 * One loaded run context. Exported for the matrix planner/ingester, which are
 * trusted consumers of the same selection, preparation and receipt paths.
 */
export interface LoopContextV1 {
  snapshot: RepairStateSnapshotV1;
  head: GitSha | null;
  /** Run-relative bounds for every start decision in this run. */
  bounds: RunBoundsV1;
  /**
   * The record one in-flight execution was planned against, or null outside an
   * execution. Every write that execution performs is compared with THIS
   * baseline, so the per-record no-progress budget is counted once per
   * execution instead of once per bookkeeping write.
   */
  executionBaseline: WorkRecordV1 | null;
  /**
   * The legacy review cutoff every round count of this run uses
   * (`RepairCycleDepsV1.legacyReviewCutoff`, copied when the context is
   * loaded); absent or null means no record is legacy.
   */
  legacyReviewCutoff?: number | null;
}

/** Effective run bounds: caller deadline clamped by the fixed ceiling. */
export interface RunBoundsV1 {
  /** Total deadline: min(caller deadline, run start + 120 minutes). */
  runDeadline: number;
  /** No NEW model work may start at/after this point of the run. */
  modelCutoff: number;
}

export type StepResultV1 =
  // Non-enumerable and in-memory only: a persisted hold is loop progress,
  // but does not establish consumption of a producer result or receipt.
  | { kind: "progress"; readonly queueHold?: true }
  | { kind: "idle" }
  | { kind: "margin"; detail: string }
  | { kind: "state_error"; detail: string }
  | { kind: "deferred"; detail: string };

/**
 * One fully prepared, durably admitted implementation start: the exact
 * `ModelRunRequestV1` a matrix cell may run, the persisted record carrying its
 * implementation intent and the fresh context after that write. Produced by
 * `prepareImplementationStart` and consumed either in-process by
 * `executeImplementationStep` or by the trusted matrix cell/ingester. The
 * `kind` discriminant is shared with `StepResultV1`, so a caller can tell the
 * two apart without casts.
 */
export interface PreparedImplementationV1 {
  kind: "prepared";
  /** Persisted record with the implementation intent and counted attempt. */
  record: WorkRecordV1;
  /** Fresh authoritative context after the admission/intent write. */
  context: LoopContextV1;
  /** Durable reservation identity that admitted this exact start. */
  reservationId: string;
  /** Exact secret-free request the cell must run. */
  request: ModelRunRequestV1;
}

export interface CarryV1 {
  beforeRun: IsolatedReplayResultV1 | null;
  fixtureRef: string | null;
  fixtureDigest: string | null;
  testIds: string[] | null;
  replayCommandId: string | null;
  beforeReason: string;
}

/** Mutable run-local state shared with the one-shot post-drain continuation. */
export interface RepairCycleTrackingV1 {
  steps: number;
  lastSnapshot: RepairStateSnapshotV1 | null;
  postDrainAllowed: boolean;
  continued: boolean;
}
