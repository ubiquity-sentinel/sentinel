/**
 * The single trusted writer's application of fan-out repair deltas
 * (issue #328).
 *
 * Every delta is opened (sealed, bound to this run, attempt, plan and its
 * repository) and validated against the CURRENT authoritative head: its
 * repository projection there must still be exactly the one it was planned
 * on (`repairProjectionDigestV1`), each replaced row must still be its
 * recorded `before`, and every transition must satisfy the shared rule. All
 * accepted deltas land together in ONE expected-head, non-force write through
 * the existing repair-state writer (`persistTransition`), so the hot/cold
 * layout, intent persistence and the maintenance index stay its own. A
 * rejected delta contributes nothing (no partial write); its repository is
 * recomputed by the next pass. A lost compare-and-swap re-reads and
 * re-validates every delta before trying again, bounded.
 *
 * Nothing here reserves, charges, settles, refunds or creates a record.
 */
import type { GitSha } from "../contracts/brands.ts";
import {
  canonicalDigestV1,
  openRepairDeltaV1,
  type RepairDeltaBindingV1,
  type RepairDeltaV1,
  repairProjectionDigestV1,
} from "../contracts/repair-delta.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { persistTransition } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  RunBoundsV1,
} from "./loop-types.ts";
import { repairTransitionRefusalV1 } from "./repair-delta-rules.ts";
import { logFanoutSummary } from "./fanout-summary-line.ts";

export type RepairDeltaRejectionV1 =
  | "unauthenticated"
  | "invalid"
  | "duplicate"
  | "base_moved"
  | "transition_refused";

export interface RepairDeltaArtifactV1 {
  /** The repository the authenticated artifact was planned for. */
  repository: RepositoryIdentityV1;
  /** The parsed artifact body (still untrusted until opened). */
  envelope: unknown;
}

export interface RepairDeltaApplyInputV1 {
  binding: RepairDeltaBindingV1;
  artifacts: readonly RepairDeltaArtifactV1[];
  /** Shared run deadline: no write starts at or after it. */
  deadline: number;
}

export interface RepairDeltaApplyResultV1 {
  status: "applied" | "none" | "state_error";
  /** The authoritative head after the write (or as read when none). */
  head: GitSha | null;
  applied: { repository: RepositoryIdentityV1; transitions: number }[];
  rejected: {
    repository: RepositoryIdentityV1;
    reason: RepairDeltaRejectionV1;
  }[];
  /** Wall time of each opened delta's repository pass (milliseconds). */
  repositoryWallMs: number[];
  /** Wall time of this application (milliseconds). */
  applyMs: number;
}

const APPLY_CAS_ATTEMPTS = 3;

/** Every application prints its one advisory fan-out summary. */
function logged(result: RepairDeltaApplyResultV1): RepairDeltaApplyResultV1 {
  logFanoutSummary(result);
  return result;
}

type Deps = Pick<RepairCycleDepsV1, "state" | "clock">;

function key(repository: RepositoryIdentityV1): string {
  return `${repository.installationId}/${repository.owner}/${repository.name}`;
}

async function validate(
  delta: RepairDeltaV1,
  snapshot: RepairStateSnapshotV1,
): Promise<RepairDeltaRejectionV1 | null> {
  if (
    await repairProjectionDigestV1(snapshot, delta.repository) !==
      delta.baseDigest
  ) return "base_moved";
  for (const transition of delta.transitions) {
    const current = snapshot.work.find((row) => row.id === transition.after.id);
    if (current === undefined) return "base_moved";
    if (await canonicalDigestV1(current) !== transition.before) {
      return "base_moved";
    }
    if (
      repairTransitionRefusalV1(current, transition.after, delta.repository) !==
        null
    ) return "transition_refused";
  }
  return null;
}

/** Apply every valid delta in one trusted write; reject the rest whole. */
export async function applyRepairDeltas(
  deps: Deps,
  input: RepairDeltaApplyInputV1,
): Promise<RepairDeltaApplyResultV1> {
  const started = deps.clock.now();
  const rejected: RepairDeltaApplyResultV1["rejected"] = [];
  const opened: RepairDeltaV1[] = [];
  const seen = new Set<string>();
  for (const artifact of input.artifacts) {
    const result = await openRepairDeltaV1(artifact.envelope, {
      binding: input.binding,
      repository: artifact.repository,
    });
    if (!result.ok) {
      rejected.push({ repository: artifact.repository, reason: result.reason });
      continue;
    }
    if (seen.has(key(result.delta.repository))) {
      rejected.push({ repository: artifact.repository, reason: "duplicate" });
      continue;
    }
    seen.add(key(result.delta.repository));
    opened.push(result.delta);
  }
  const repositoryWallMs = opened.map((delta) =>
    delta.finishedAt - delta.startedAt
  ).sort((left, right) => right - left);
  const finish = (
    status: RepairDeltaApplyResultV1["status"],
    head: GitSha | null,
    applied: RepairDeltaV1[],
    late: RepairDeltaApplyResultV1["rejected"],
  ): RepairDeltaApplyResultV1 =>
    logged({
      status,
      head,
      applied: applied.map((delta) => ({
        repository: delta.repository,
        transitions: delta.transitions.length,
      })),
      rejected: [...rejected, ...late],
      repositoryWallMs,
      applyMs: Math.max(0, deps.clock.now() - started),
    });

  for (let attempt = 1; attempt <= APPLY_CAS_ATTEMPTS; attempt++) {
    const read = await deps.state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      return finish("state_error", null, [], []);
    }
    const { snapshot, head } = read.value;
    const accepted: RepairDeltaV1[] = [];
    const stale: RepairDeltaApplyResultV1["rejected"] = [];
    for (const delta of opened) {
      const refusal = await validate(delta, snapshot);
      if (refusal === null) accepted.push(delta);
      else stale.push({ repository: delta.repository, reason: refusal });
    }
    const rows = accepted.flatMap((delta) =>
      delta.transitions.map((transition) => transition.after)
    );
    if (rows.length === 0) return finish("none", head, accepted, stale);
    if (deps.clock.now() >= input.deadline) {
      return finish("none", head, [], [
        ...stale,
        ...accepted.map((delta) => ({
          repository: delta.repository,
          reason: "base_moved" as const,
        })),
      ]);
    }
    const bounds: RunBoundsV1 = {
      runDeadline: input.deadline,
      modelCutoff: input.deadline,
    };
    const context: LoopContextV1 = {
      snapshot,
      head,
      bounds,
      executionBaseline: null,
    };
    const replacements = new Map(rows.map((row) => [row.id, row]));
    // `head` is the proof: the write is refused unless the authoritative head
    // is still exactly the one every accepted delta was validated against.
    const written = await persistTransition(
      deps as RepairCycleDepsV1,
      context,
      (draft) => {
        draft.work = draft.work.map((row) => replacements.get(row.id) ?? row);
      },
      head,
    );
    if (written.kind === "progress") {
      return finish("applied", context.head, accepted, stale);
    }
    if (written.kind !== "deferred") {
      return finish("state_error", head, [], []);
    }
  }
  return finish(
    "none",
    null,
    [],
    opened.map((delta) => ({
      repository: delta.repository,
      reason: "base_moved" as const,
    })),
  );
}
