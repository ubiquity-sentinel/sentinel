/** Repair loop internals: types. */
import type { BudgetControllerV1 } from "../budget/mod.ts";
import type {
  CiEffectKindV1,
  CiEffectV1,
  CiMinuteControllerV1,
} from "../contracts/ci-minute-budget.ts";
import { causedWait } from "./loop-wait-cause.ts";
import { persistTransition } from "./loop-state.ts";
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
import type { PendingStepInputsV1 } from "./step-inputs.ts";
import type { DeliveryTrainHoldV1 } from "../contracts/delivery-train-ledger.ts";

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
  /** Required trusted CI capability; hosts supply the explicit inactive capability by default. */
  ciMinutes: CiMinuteControllerV1;
  /** Matrix-owned implementations settle only through authenticated artifact ingestion. */
  externalImplementations?: boolean;
  /**
   * Persist `wait.cause` on the waits that know it (#335). Off by default:
   * every rollback target's strict parser must accept the state this runtime
   * writes, so the trusted host turns it on only once the installed rollback
   * target parses the optional key.
   */
  recordWaitCauses?: boolean;
  /**
   * The one-time legacy review class's cutoff (`review-round-cap.ts`): the
   * one instant no later than the first CI-first runtime's activation
   * (`LEGACY_REVIEW_CUTOFF`), handed over by the launcher to runs of a pinned
   * CI-first revision. Absent or null means no record is legacy (no final
   * round is ever granted).
   */
  legacyReviewCutoff?: number | null;
}

/** Calendar holds are nonfailure state, never transport errors or model-start charges. */
export async function guardCiMinuteEffect(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  kind: CiEffectKindV1,
  override: Partial<
    Pick<CiEffectV1, "head" | "base" | "ref" | "pr" | "publicationAfter">
  > = {},
): Promise<StepResultV1 | null> {
  if (deps.ciMinutes === undefined) {
    return { kind: "state_error", detail: "CI admission capability missing" };
  }
  if (!deps.ciMinutes.active) return null;
  const baseBranch = kind === "merge"
    ? deps.configs.find((c) =>
      c.repository.owner === record.repository.owner &&
      c.repository.name === record.repository.name &&
      c.repository.installationId === record.repository.installationId
    )?.baseBranch
    : undefined;
  if (kind === "merge" && baseBranch === undefined) {
    return { kind: "state_error", detail: "CI base branch missing" };
  }
  const decision = await deps.ciMinutes.reserve({
    repository: record.repository,
    kind,
    head: record.target.head,
    base: record.target.base,
    ref: baseBranch !== undefined
      ? `refs/heads/${baseBranch}`
      : record.target.branch === null
      ? ""
      : `refs/heads/${record.target.branch}`,
    pr: record.target.pr,
    ...override,
  }, context.bounds.runDeadline);
  if (
    decision.kind === "inactive" || decision.kind === "admitted" ||
    (kind === "base_refresh" && decision.kind === "reconciled")
  ) {
    return deps.clock.now() < context.bounds.runDeadline
      ? null
      : { kind: "margin", detail: "CI admission crossed operation deadline" };
  }
  if (decision.kind === "unavailable") {
    return { kind: "deferred", detail: "CI minute evidence unavailable" };
  }
  if (decision.kind === "reconciled") {
    return {
      kind: "deferred",
      detail: "CI effect awaits native reconciliation",
    };
  }
  const now = deps.clock.now();
  if (!Number.isSafeInteger(decision.retryAt) || decision.retryAt <= now) {
    return { kind: "state_error", detail: "CI admission wait invalid" };
  }
  if (
    record.wait?.reason === "backoff" && record.wait.until === decision.retryAt
  ) {
    return { kind: "deferred", detail: "CI minute calendar hold" };
  }
  return await persistTransition(deps, context, (draft) => {
    const index = draft.work.findIndex((r) => r.id === record.id);
    if (index < 0) throw new Error("CI wait record missing");
    const current = draft.work[index];
    draft.work[index] = {
      ...current,
      updatedAt: now,
      wait: causedWait(deps, {
        reason: "backoff",
        since: current.wait?.reason === "backoff" ? current.wait.since : now,
        until: decision.retryAt,
      }, { port: "ci", status: "none", code: "minute_budget" }),
    };
  });
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
  /** The aggregate delegates fresh branch assignment to batched matrix intake. */
  matrixIntakeOwnsBranches?: boolean;
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
  /**
   * Trusted host confirmation that this is the model-disabled BOOTSTRAP
   * execution. It performs intake, maintenance and health only and never walks
   * the work queue: no record is stepped, so a large state cannot spend the
   * bootstrap bound on deterministic work the next ordinary run owns. Omitted
   * keeps the ordinary lifecycle unchanged.
   */
  bootstrap?: boolean;
  /**
   * Fan-out repository pass only (issue #328): told the id of each record
   * about to be stepped, before its step runs, so the pass can attribute an
   * interval to its record. It observes and never changes the pass.
   */
  onStep?: (id: string) => void;
  /**
   * Records this pass never selects for a step (issue #328): the trusted
   * serial pass skips the records a repository cell steps, and a cell skips
   * its repository's records that were not delegated to it. They stay
   * visible to every other read of the pass.
   */
  excludeRecords?: ReadonlySet<string>;
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
  /**
   * The serial pass's settled step stamps not yet written (issue #326). Every
   * trusted write of this context folds them into the records they still
   * describe; absent outside the serial pass (planner, ingester).
   */
  pendingStepInputs?: Map<string, PendingStepInputsV1>;
  /**
   * The launcher's open delivery trains read when the context was loaded
   * (sentinel #330); absent or empty holds nothing.
   */
  deliveryTrainHolds?: readonly DeliveryTrainHoldV1[];
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
  | {
    kind: "progress";
    readonly queueHold?: true;
    /** Applied state remains progress, but this record waits for a later invocation. */
    readonly yield?: true;
  }
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
