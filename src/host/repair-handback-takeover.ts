/**
 * The serial repair pass's same-run takeover of its repository cells'
 * hand-backs (issue #328).
 *
 * The serial pass starts beside this run's repository cells and never steps
 * a record the plan delegated to them. A cell hands back a delegated record
 * whose step needs a trusted effect (a refresh, a review start, a
 * publication, a merge); it used to wait for the next plan, a whole
 * supervisor cycle per effectful step. Once the cells completed, their
 * authenticated deltas name those records (`repairHandbacks`); this pass
 * removes each from its exclusion and wakes it, so the ordinary trusted step
 * (every CI, review, line, custody and accounting gate unchanged) runs in
 * this same run.
 *
 * Exactly the records a completed cell handed back are taken over, each once,
 * and only while the plan still delegates it: the cell never steps a record
 * again after handing it back, and its delta binds only the records it kept,
 * so finalize's application of that delta stays valid whatever this pass
 * does with them. Anything not read in time is handed back by finalize as
 * before.
 */
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import { sameRepositoryV1 } from "../contracts/repair-delta.ts";
import type {
  MatrixArtifactTransportV1,
  RepairHandbackRequestV1,
  RepairHandbackV1,
} from "./matrix-artifact-port.ts";

/** Longest the serial job reads for its cells' hand-backs after it starts. */
export const REPAIR_HANDBACK_WAIT_MS = 10 * 60_000;
export const REPAIR_HANDBACK_KIND = "sentinel_repair_handback";

export interface RepairHandbackTakeoverV1 {
  /**
   * Resolves when the hand-backs arrive, until `poll` consumed them; then
   * never (the consumer's wait never spins on it).
   */
  arrival(): Promise<void>;
  /** Wake the arrived hand-backs (once); true when it woke any record. */
  poll(): boolean;
  /** Await the bounded read, then `poll`. */
  settle(): Promise<boolean>;
  /** Stop a read still in flight. */
  close(): void;
}

const NEVER = new Promise<void>(() => {});

/**
 * Start reading this run's hand-backs; null when this pass has no delegation
 * or no authenticated reader (no takeover: finalize hands back as before).
 */
export function startRepairHandbackTakeover(input: {
  transport: Pick<MatrixArtifactTransportV1, "repairHandbacks">;
  /** The plan digest the native outputs carried; absent: no delegation. */
  planDigest: string | undefined;
  /** The serial pass's own exclusion (the plan's delegated records). */
  exclude: Set<string> | undefined;
  configs: readonly RepositoryConfigV1[];
  request: Omit<RepairHandbackRequestV1, "planDigest" | "signal">;
  /**
   * Wake records of one target (`createActionsTargetFlow().wake`); false when
   * that target's cycle already ended, so nothing was woken.
   */
  wake: (config: RepositoryConfigV1, ids: readonly string[]) => boolean;
  log?: (line: string) => void;
}): RepairHandbackTakeoverV1 | null {
  const read = input.transport.repairHandbacks;
  const exclude = input.exclude;
  if (
    read === undefined || exclude === undefined ||
    input.planDigest === undefined
  ) return null;
  const controller = new AbortController();
  let result: readonly RepairHandbackV1[] | null | undefined;
  const settled = read.call(input.transport, {
    ...input.request,
    planDigest: input.planDigest,
    signal: controller.signal,
  }).then(
    (value) => {
      result = value;
    },
    () => {
      result = null;
    },
  );
  let polled = false;
  const poll = (): boolean => {
    if (polled || result === undefined) return false;
    polled = true;
    let woken = 0;
    for (const handback of result ?? []) {
      const config = input.configs.find((entry) =>
        sameRepositoryV1(entry.repository, handback.repository)
      );
      if (config === undefined) continue;
      // Only a record the plan still delegates, each once.
      const ids = handback.records.filter((id) => exclude.delete(id));
      if (ids.length === 0) continue;
      // A target whose cycle already ended steps nothing more in this run
      // (finalize hands its records back as before): only woken ones count.
      if (input.wake(config, ids)) woken += ids.length;
    }
    // One advisory line; it carries no `status` property, so the launcher's
    // child-status scan never reads it as the child's result.
    try {
      (input.log ?? console.log)(JSON.stringify({
        kind: REPAIR_HANDBACK_KIND,
        outcome: result === null ? "unavailable" : "read",
        records: woken,
      }));
    } catch { /* advisory */ }
    return woken > 0;
  };
  return {
    arrival: () => polled ? NEVER : settled,
    poll,
    settle: async () => {
      await settled;
      return poll();
    },
    close: () => controller.abort(),
  };
}
