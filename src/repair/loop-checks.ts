/** Repair loop internals: checks. */
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { markBlocked, setWait } from "./transitions.ts";

/**
 * Pure CI gate decision. Returns "proceed" only when every (deduped by name)
 * check is completed with `success` conclusion. Returns "wait" when any check
 * is still running or when no checks are recorded (no evidence CI ran).
 * Returns a block detail when any check failed (including skipped/neutral,
 * matching requiredChecksState semantics). Exported for focused testing.
 */
export function decideCiGate(
  checks: GitHubCheckV1[],
): "proceed" | "wait" | { blocked: string } {
  if (checks.length === 0) return "wait";
  // Dedupe: GitHub returns historical observations; only the latest per name
  // counts. Recency is by startedAt (when the run began): a newer in-progress
  // rerun must override an older completed run, otherwise we'd merge while
  // CI is still running.
  const latest = new Map<string, GitHubCheckV1>();
  for (const check of checks) {
    const prev = latest.get(check.name);
    const time = (c: GitHubCheckV1) => c.startedAt ?? c.completedAt ?? -1;
    if (prev === undefined || time(check) > time(prev)) {
      latest.set(check.name, check);
    }
  }
  const deduped = [...latest.values()];
  // Failed checks are terminal: classify them before pending so a queued
  // check cannot mask a failure (CodeRabbit #131 review).
  const failed = deduped.filter(
    (check) => check.status === "completed" && check.conclusion !== "success",
  );
  if (failed.length > 0) {
    const names = failed.map((check) =>
      `${check.name}(${check.conclusion ?? "unknown"})`
    ).join(", ");
    return { blocked: `CI checks failed: ${names}` };
  }
  const pending = deduped.some((check) => check.status !== "completed");
  if (pending) return "wait";
  return "proceed";
}

/**
 * Delivery-phase CI gate. Returns null when checks are green (or absent) and
 * the merge may proceed; otherwise returns the step result (deferred wait for
 * in-progress checks, terminal block for failed checks). Never blocks the
 * turn: in-progress checks persist a bounded `ci_pending` wait.
 */
export async function gateDeliveryOnChecks(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  now: number,
): Promise<StepResultV1 | null> {
  const head = record.target.head;
  if (head === null) {
    return { kind: "state_error", detail: "delivery without PR/head identity" };
  }
  // CI observation is a GitHub read: gate before the external call, like the
  // surrounding operations. A cooldown deferral mutates nothing.
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  const observed = await deps.github.readChecks(head);
  if (!observed.ok) {
    // Transient read failure: defer without a wait so the next turn retries.
    return { kind: "deferred", detail: "CI check observation unavailable" };
  }
  const decision = decideCiGate(observed.value.checks);
  if (decision === "proceed") {
    // Every (deduped) check completed with `success`: the CI gate passes and
    // the merge authorization proceeds.
    return null;
  }
  if (decision === "wait") {
    const since =
      record.wait?.reason === "ci_pending" && record.wait.since < now
        ? record.wait.since
        : now;
    return persistWork(
      deps,
      context,
      setWait(
        record,
        {
          reason: "ci_pending",
          since,
          until: deps.clock.now() + CHECK_POLL_MS,
        },
        now,
      ),
    );
  }
  return persistWork(
    deps,
    context,
    markBlocked(record, "other", decision.blocked, now),
  );
}
