/**
 * One repository's fan-out repair pass (issue #328).
 *
 * A credential-free repository cell runs the ORDINARY serial step loop
 * (`advanceRepairCycle`) for its one repository against a private fork of the
 * hot repair state at the exact head the fan-out was planned on, and returns
 * a sealed, bounded delta instead of writing shared state. The loop keeps its
 * own bounds: the caller's shared run deadline, the five-minute operation
 * margin and the step limit are unchanged, and no model can start: the model,
 * budget and replay capabilities are fenced (starts stay in the planner/cell
 * path).
 *
 * The pass is speculative per interval. An interval ends at each progress
 * point the loop yields and at the loop's end. An interval is kept only when
 * it attempted no fenced effect, changed no collection but the repository's
 * own existing work records (and the cooldown/lesson bookkeeping a write
 * always refreshes), and every row it changed satisfies the shared transition
 * rule. Any other interval is discarded whole: the fork returns to the state
 * before it, its changed records are hidden for the rest of the pass and
 * listed as deferred to the trusted writer. A kept interval therefore never
 * reserves, charges, settles, publishes, merges, reviews or closes anything.
 */
import type { GitSha } from "../contracts/brands.ts";
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
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
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
  /** Exact authoritative repair state head the fan-out was planned on. */
  baseHead: GitSha;
  /** The shared run deadline (the loop applies its own operation margin). */
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
  baseHead: GitSha,
): Promise<RepairStateSnapshotV1 | null> {
  const read = await deps.state.readRepair();
  if (!read.ok || read.value.status !== "found") return null;
  if (read.value.head === baseHead) return read.value.snapshot;
  // The head moved since the plan: read the planned head itself, never a
  // newer one, so the delta's base is exactly what was planned.
  if (deps.state.readRepairAt === undefined) return null;
  const at = await deps.state.readRepairAt({
    commit: baseHead,
    expectedHead: read.value.head,
  });
  return at.ok && at.value.status === "found" && at.value.head === baseHead
    ? at.value.snapshot
    : null;
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
  const base = await readBase(deps, input.baseHead);
  if (base === null) return { status: "refused", reason: "base_unavailable" };
  const own = base.work.filter((record) =>
    sameRepositoryV1(record.repository, input.repository)
  );
  const fork = new RepairForkState(
    { snapshot: { ...base, work: own }, head: input.baseHead },
    deps.state,
  );
  const fence = new RepositoryPassFence();
  const judge = new IntervalJudge(fork, fence, input.repository);
  const passDeps = fencedRepositoryDeps(
    deps,
    fork,
    configs,
    fence,
  );
  const outcome = await drive(passDeps, input, judge);

  const finalRows = byId(fork.current().work);
  const transitions: RepairDeltaTransitionV1[] = [];
  for (const record of own) {
    if (fork.hidden.has(record.id)) continue;
    const after = finalRows.get(record.id);
    if (after === undefined) {
      judge.deferred.add(record.id);
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
    baseHead: input.baseHead,
    baseDigest: await repairProjectionDigestV1(base, input.repository),
    transitions,
    deferredToTrusted: [...judge.deferred].sort(),
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
): Promise<RepairCycleOutcomeV1["status"]> {
  const cycle = advanceRepairCycle(deps, {
    deadline: input.deadline,
    ...(input.stepLimit === undefined ? {} : { stepLimit: input.stepLimit }),
    ...(input.runStartedAt === undefined
      ? {}
      : { runStartedAt: input.runStartedAt }),
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
