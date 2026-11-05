/**
 * One repository's fan-out repair pass (issue #328).
 *
 * A credential-free repository cell runs the ORDINARY serial step loop
 * (`advanceRepairCycle`) for its one repository against a private fork of the
 * hot repair state it reads at its start, steps only the records the fan-out
 * plan delegated to it (every other record of the repository stays visible
 * and is never selected), and returns a sealed, bounded delta instead of
 * writing shared state. The loop keeps its own bounds: the shared run
 * deadline, the fixed run ceiling and the five-minute operation margin of the
 * production entrypoint are applied exactly as there, the step limit is
 * unchanged, and no model can start: the model, budget and replay
 * capabilities are fenced (starts stay in the planner/cell path).
 *
 * The pass is speculative per interval. An interval ends at each progress
 * point the loop yields and at the loop's end. An interval is kept only when
 * it attempted no fenced effect, changed no collection but the repository's
 * own existing work records (and the cooldown/lesson bookkeeping a write
 * always refreshes), and every row it changed satisfies the shared transition
 * rule, and changed only delegated records. Any other interval is discarded
 * whole: the fork returns to the state before it, its changed records are
 * hidden for the rest of the pass and listed as deferred to the trusted
 * writer. A kept interval therefore never reserves, charges, settles,
 * publishes, merges, reviews or closes anything. A delegated record deferred
 * to the trusted writer loses its step stamp in the delta, so the next plan
 * leaves it with the trusted serial pass, which performs the effect.
 */
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  canonicalDigestV1,
  type RepairDeltaBindingV1,
  type RepairDeltaEnvelopeV1,
  type RepairDeltaTransitionV1,
  repairProjectionDigestV1,
  sameRepositoryV1,
  sealRepairDeltaV1,
} from "../contracts/repair-delta.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { OPERATION_MARGIN_MS, REPAIR_RUN_CEILING_MS } from "./loop-bounds.ts";
import { advanceRepairCycle } from "./loop-cycle.ts";
import type { RepairCycleDepsV1, RepairCycleOutcomeV1 } from "./loop-types.ts";
import { repairTransitionRefusalV1 } from "./repair-delta-rules.ts";
import {
  type RepairForkCheckpointV1,
  RepairForkState,
} from "./repair-fork-state.ts";
import {
  fencedRepositoryDeps,
  RepositoryPassFence,
} from "./repository-pass-fence.ts";

export interface RepositoryPassInputV1 {
  repository: RepositoryIdentityV1;
  binding: RepairDeltaBindingV1;
  /** The record ids the plan delegated to this cell. */
  records: readonly string[];
  /** The shared run deadline (the operation margin is applied here). */
  deadline: number;
  /** Trusted original run start (the loop's model/ceiling anchor). */
  runStartedAt?: number;
  stepLimit?: number;
  /**
   * The run's own trusted model-start confirmation, forwarded unchanged so
   * eligibility and the #326 stamps match the serial pass. Starts stay
   * impossible here: the model, budget and replay capabilities are fenced.
   */
  modelStartsEnabled?: boolean;
}

export type RepositoryPassResultV1 =
  | {
    status: "sealed";
    envelope: RepairDeltaEnvelopeV1;
    /** The step loop's own terminal outcome. */
    outcome: RepairCycleOutcomeV1["status"];
  }
  | {
    status: "refused";
    reason: "unconfigured" | "base_unavailable";
  };

/** Snapshot keys every fork write refreshes without moving a record. */
const BOOKKEEPING = new Set([
  "work",
  "stateHead",
  "sequence",
  "updatedAt",
  "githubCooldowns",
  "lessons",
]);

function sharedRows(snapshot: RepairStateSnapshotV1): string {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    if (!BOOKKEEPING.has(key)) rest[key] = value;
  }
  return canonicalStringify(rest);
}

function byId(work: readonly WorkRecordV1[]): Map<string, WorkRecordV1> {
  return new Map(work.map((record) => [record.id, record]));
}

/** Ids whose row differs between two snapshots (added, removed or moved). */
function changedIds(
  before: RepairStateSnapshotV1,
  after: RepairStateSnapshotV1,
): { moved: string[]; structural: boolean } {
  const left = byId(before.work);
  const right = byId(after.work);
  const moved: string[] = [];
  let structural = false;
  for (const [id, record] of right) {
    const prior = left.get(id);
    if (prior === undefined) {
      structural = true;
      moved.push(id);
    } else if (canonicalStringify(prior) !== canonicalStringify(record)) {
      moved.push(id);
    }
  }
  for (const id of left.keys()) {
    if (!right.has(id)) {
      structural = true;
      moved.push(id);
    }
  }
  return { moved, structural };
}

async function readBase(
  deps: RepairCycleDepsV1,
): Promise<{ snapshot: RepairStateSnapshotV1; head: GitSha } | null> {
  const read = await deps.state.readRepair();
  if (!read.ok || read.value.status !== "found") return null;
  return { snapshot: read.value.snapshot, head: read.value.head };
}

/** True when two rows differ in nothing but their #326 step stamp. */
function stampOnly(left: WorkRecordV1, right: WorkRecordV1): boolean {
  const { stepInputs: _left, ...restLeft } = left;
  const { stepInputs: _right, ...restRight } = right;
  return canonicalStringify(restLeft) === canonicalStringify(restRight);
}

class IntervalJudge {
  readonly deferred = new Set<string>();
  private checkpoint: RepairForkCheckpointV1;
  /** The record the loop stepped in the open interval, if any. */
  private stepped: string | null = null;

  constructor(
    private readonly fork: RepairForkState,
    private readonly fence: RepositoryPassFence,
    private readonly repository: RepositoryIdentityV1,
    private readonly delegated: ReadonlySet<string>,
  ) {
    this.checkpoint = fork.checkpoint();
  }

  step(id: string): void {
    this.stepped = id;
  }

  /**
   * Keep or discard the interval since the last checkpoint. A discarded
   * interval also hides the record it stepped even when that step wrote
   * nothing: its step needed an effect, so no later write of this pass may
   * carry a step stamp (or anything else) for it.
   */
  close(force = false): void {
    const before = this.checkpoint.snapshot;
    const after = this.fork.current();
    const effect = this.fence.take();
    const { moved, structural } = changedIds(before, after);
    const prior = byId(before.work);
    const current = byId(after.work);
    const refused = moved.some((id) => {
      const left = prior.get(id);
      const right = current.get(id);
      return left === undefined || right === undefined ||
        !this.delegated.has(id) ||
        repairTransitionRefusalV1(left, right, this.repository) !== null ||
        this.fork.leaksSyntheticHead(right);
    });
    if (
      force || effect || structural || refused ||
      sharedRows(before) !== sharedRows(after)
    ) {
      if (before !== after) this.fork.restore(this.checkpoint);
      // A write of this interval may have carried stamps other records
      // settled in earlier, kept intervals (the loop folds pending stamps into
      // its next write). Those stamp-only rows are kept; every other moved row
      // and the stepped record are discarded and deferred.
      const stamps = moved.flatMap((id) => {
        const left = prior.get(id);
        const right = current.get(id);
        return id !== this.stepped && left !== undefined &&
            right !== undefined && stampOnly(left, right) &&
            !this.fork.leaksSyntheticHead(right)
          ? [right]
          : [];
      });
      this.fork.amend(stamps);
      const kept = new Set<string>(stamps.map((row) => row.id));
      const discarded = [
        ...moved.filter((id) => !kept.has(id)),
        ...(this.stepped === null ? [] : [this.stepped]),
      ];
      for (const id of discarded) {
        this.fork.hidden.add(id);
        this.deferred.add(id);
      }
    }
    this.stepped = null;
    this.checkpoint = this.fork.checkpoint();
  }
}

/** Run one repository's pass and seal its delta; never writes shared state. */
export async function runRepositoryRepairPass(
  deps: RepairCycleDepsV1,
  input: RepositoryPassInputV1,
): Promise<RepositoryPassResultV1> {
  const startedAt = deps.clock.now();
  const configs = deps.configs.filter((config) =>
    sameRepositoryV1(config.repository, input.repository)
  );
  if (configs.length === 0) {
    return { status: "refused", reason: "unconfigured" };
  }
  const read = await readBase(deps);
  if (read === null) return { status: "refused", reason: "base_unavailable" };
  const base = read.snapshot;
  const delegated = new Set(input.records);
  const own = base.work.filter((record) =>
    sameRepositoryV1(record.repository, input.repository)
  );
  const fork = new RepairForkState(
    { snapshot: { ...base, work: own }, head: read.head },
    deps.state,
  );
  const fence = new RepositoryPassFence();
  const judge = new IntervalJudge(fork, fence, input.repository, delegated);
  const passDeps = fencedRepositoryDeps(deps, fork, configs, fence);
  const excluded = new Set(
    own.filter((record) => !delegated.has(record.id)).map((record) =>
      record.id as string
    ),
  );
  const outcome = await drive(passDeps, input, judge, excluded);

  const finalRows = byId(fork.current().work);
  const transitions: RepairDeltaTransitionV1[] = [];
  const deferred = new Set<string>();
  for (const record of own) {
    if (!delegated.has(record.id)) continue;
    const after = fork.hidden.has(record.id)
      ? undefined
      : finalRows.get(record.id);
    if (after === undefined) {
      // Handed back: without its stamp the next plan keeps it trusted.
      deferred.add(record.id);
      if (record.stepInputs !== undefined) {
        const { stepInputs: _dropped, ...unstamped } = record;
        transitions.push({
          before: await canonicalDigestV1(record),
          after: unstamped as WorkRecordV1,
        });
      }
      continue;
    }
    if (canonicalStringify(after) === canonicalStringify(record)) continue;
    transitions.push({ before: await canonicalDigestV1(record), after });
  }
  transitions.sort((left, right) =>
    left.after.id < right.after.id ? -1 : left.after.id > right.after.id ? 1 : 0
  );
  const envelope = await sealRepairDeltaV1({
    version: "v1",
    kind: "repair_delta",
    repository: input.repository,
    binding: input.binding,
    baseHead: read.head,
    baseDigest: await repairProjectionDigestV1(
      base,
      input.repository,
      delegated,
    ),
    transitions,
    deferredToTrusted: [...deferred].sort(),
    startedAt,
    finishedAt: Math.max(startedAt, deps.clock.now()),
  });
  return { status: "sealed", envelope, outcome };
}

/**
 * Drive the ordinary loop exactly like `runRepairCycle` does (a waiting
 * advance ends the pass), judging each interval at its progress point.
 */
async function drive(
  deps: RepairCycleDepsV1,
  input: RepositoryPassInputV1,
  judge: IntervalJudge,
  excluded: ReadonlySet<string>,
): Promise<RepairCycleOutcomeV1["status"]> {
  // The production entrypoint's own bounds (`runRepairEntrypoint`): the
  // caller deadline clamped by the fixed run ceiling, less the margin.
  const runStartedAt = input.runStartedAt ?? deps.clock.now();
  const cycle = advanceRepairCycle(deps, {
    deadline: Math.min(input.deadline, runStartedAt + REPAIR_RUN_CEILING_MS) -
      OPERATION_MARGIN_MS,
    runStartedAt,
    excludeRecords: excluded,
    ...(input.stepLimit === undefined ? {} : { stepLimit: input.stepLimit }),
    ...(input.modelStartsEnabled === undefined
      ? {}
      : { modelStartsEnabled: input.modelStartsEnabled }),
    onStep: (id) => judge.step(id),
  });
  try {
    for (;;) {
      const next = await cycle.next(undefined);
      judge.close();
      if (next.done) return next.value.status;
      if (next.value.kind === "waiting") {
        await cycle.return(next.value.outcome);
        return next.value.outcome.status;
      }
    }
  } catch {
    // A loop fault discards only its open interval; kept intervals stand.
    judge.close(true);
    return "state_error";
  }
}
