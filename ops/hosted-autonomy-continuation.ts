/**
 * One maintenance pass continues after a write. Each phase still returns its
 * own result from its own expected-head CAS and readback; the runner then
 * re-reads repair and release state, requires the repair head to be exactly
 * the head that write left, and runs the remaining phases there, each at most
 * once, in the fixed order. These helpers hold the bounds and the bookkeeping:
 * the start limit for continued phases, the records an earlier write of the
 * pass settled (later phases leave them to the next pass), and the one
 * aggregate result line.
 */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";

/**
 * No continued phase may still be running here, measured from the pass's
 * start: the maintenance job's `timeout-minutes: 15` less a minute of job
 * setup and teardown.
 */
export const HOSTED_AUTONOMY_PASS_DEADLINE_MS = 840_000;

/**
 * The time one continued phase may take: it starts only this long before the
 * deadline, so no later than 600 s into the pass. The live ingest pass spends
 * the walk's 300 s budget, and a whole pass that wrote nothing took at most
 * 534 s on 2026-10-16, so retry and delivery normally start well inside the
 * limit. The split per phase was never measured: the timing line a pass that
 * wrote prints (`sentinel_autonomy_continuation`) calibrates this reserve.
 */
export const HOSTED_AUTONOMY_PHASE_RESERVE_MS = 240_000;

/** The ordinary phases after maintenance, in their fixed order. */
export type HostedAutonomyPhaseV1 =
  | "closure-delivery"
  | "retry"
  | "delivery"
  | "closure";

/**
 * Why a pass that already wrote stopped before a phase. Together with the
 * phase's own closed reason when it refused or failed after an earlier
 * write, this is the whole `continuation:<phase>:<outcome>` vocabulary; no
 * record content ever enters it.
 */
export type HostedAutonomyContinuationStopV1 =
  | "deferred_deadline"
  | "head_changed"
  | "state_unavailable"
  | "release_not_terminal"
  | "deferred_unexpected_error";

/**
 * True once a continued phase may no longer start. A clock that cannot be
 * read, or that runs backwards, counts as past the limit: the pass then
 * defers with the writes it already made, which is never a failure.
 */
export function continuationLate(startedAt: number, now: number): boolean {
  return !Number.isSafeInteger(startedAt) || !Number.isSafeInteger(now) ||
    now < startedAt ||
    now - startedAt >
      HOSTED_AUTONOMY_PASS_DEADLINE_MS - HOSTED_AUTONOMY_PHASE_RESERVE_MS;
}

/**
 * Work ids an applied write of this pass touched: every row that differs
 * canonically from the pass baseline (or is new), and the task of every
 * charge that does. A later phase leaves these records to the next pass,
 * exactly as the pass that returned on its first write did; every other
 * record gets the decision a no-write pass would make on the same fresh
 * state.
 */
export function settledSince(
  baseline: RepairStateSnapshotV1,
  current: RepairStateSnapshotV1,
): Set<string> {
  const settled = new Set<string>();
  const rows = new Map<string, string>(
    baseline.work.map((row) => [row.id, canonicalStringify(row)]),
  );
  for (const row of current.work) {
    if (rows.get(row.id) !== canonicalStringify(row)) settled.add(row.id);
  }
  const charges = new Map<string, string>(
    baseline.reservations.map((row) => [row.id, canonicalStringify(row)]),
  );
  for (const row of current.reservations) {
    if (charges.get(row.id) !== canonicalStringify(row)) {
      settled.add(row.taskId);
    }
  }
  return settled;
}

/**
 * The applied writes of one pass, folded into its one result line: the
 * first write's before head, the last write's applied head and reason, and
 * the shared action and revision lists in order. A later phase that refused
 * or failed after an earlier write ends the pass; only a failure turns the
 * aggregate's status to `failed` (with that phase's own reason).
 */
export function createPassWrites(actions: string[], revisions: string[]) {
  let first: HostedAutonomyResultV1 | null = null;
  let last: HostedAutonomyResultV1 | null = null;
  return {
    get applied(): boolean {
      return last !== null;
    },
    get appliedHead(): string | null {
      return last?.appliedHead ?? null;
    },
    absorb(result: HostedAutonomyResultV1): void {
      if (result.actions !== actions) {
        // A maintenance result carries its own list; the restore result is a
        // copy of the shared one, so only what it adds is appended.
        const own = result.actions;
        const copied = own.length >= actions.length &&
          actions.every((action, index) => own[index] === action);
        actions.push(...(copied ? own.slice(actions.length) : own));
      }
      if (result.revisions !== revisions) revisions.push(...result.revisions);
      first ??= result;
      last = result;
    },
    result(
      failure: HostedAutonomyResultV1 | null = null,
    ): HostedAutonomyResultV1 {
      if (first === null || last === null) {
        throw new Error("no applied write to report");
      }
      const failed = failure?.status === "failed" ? failure : null;
      return {
        kind: "hosted_autonomy",
        status: failed === null ? "applied" : "failed",
        reason: failed?.reason ?? last.reason,
        beforeHead: first.beforeHead,
        appliedHead: last.appliedHead,
        actions,
        revisions,
      };
    },
  };
}
