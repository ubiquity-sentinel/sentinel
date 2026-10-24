/** Repair loop internals: checks. */
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { missingExpectedChecks } from "./ci-coverage.ts";
import { failedChecks, latestChecks } from "./ci-rejection.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import { routeFailedDeliveryChecks } from "./loop-ci-correction.ts";
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
 *
 * It judges only the checks that exist: GitHub creates a `needs:` job's
 * check run only once its dependencies finish. The CI-first review gate and
 * the carried delivery steps therefore also require coverage of the base the
 * head is tested against (`absentExpectedChecks`) before a "proceed" counts.
 */
export function decideCiGate(
  checks: GitHubCheckV1[],
): "proceed" | "wait" | { blocked: string } {
  if (checks.length === 0) return "wait";
  // Dedupe: GitHub returns historical observations; only the latest per name
  // counts. Recency is by startedAt (when the run began): a newer in-progress
  // rerun must override an older completed run, otherwise we'd merge while
  // CI is still running.
  const deduped = latestChecks(checks);
  // Failed checks are terminal: classify them before pending so a queued
  // check cannot mask a failure (CodeRabbit #131 review).
  const failed = failedChecks(deduped);
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
 * The expected checks `head` (the record's head's own check runs, green by
 * `decideCiGate`) does not report yet, against the base it is tested on (the
 * record's base): the names of each check suite of that base that shares a
 * name with the head
 * (`missingExpectedChecks`; sentinel issue #154). Empty when every expected
 * check exists; null when the base's runs cannot be read, which proves
 * nothing either way: every caller then waits like running CI (a bounded
 * `ci_pending` wait that parks under its own pending prefix), never a silent
 * deferral no launcher rule re-admits.
 *
 * The base read is the port's lenient `readCheckSuites` (name and suite
 * only), not the strict `readChecks`: a base may carry runs no pull request
 * head runs whose names exceed the strict label bound. The sentinel self
 * scope reads its base like every other target: `ci.yml`'s `test-local` is a
 * `needs: [quality, test-shards]` aggregate that GitHub creates only once
 * those jobs finish, so a head whose shards reported but whose aggregate has
 * not yet been created is awaited like running CI instead of admitting a
 * review before the aggregate ran. The `development` tip also carries the
 * five-minute `dispatch` runs and the supervisor.yml runs of
 * `sentinel-supervisor` (fast-forwarded with it); those suites share no name
 * with a pull request head and add no expectation.
 */
export async function absentExpectedChecks(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  head: readonly GitHubCheckV1[],
): Promise<string[] | null> {
  const observed = await deps.github.readCheckSuites(record.target.base);
  if (!observed.ok) return null;
  return missingExpectedChecks(head, observed.value.checks);
}

/**
 * Delivery-phase CI gate. Returns null when checks are green (or absent) and
 * the merge may proceed; otherwise returns the step result (deferred wait for
 * in-progress checks, terminal block for failed checks). Never blocks the
 * turn: in-progress checks persist a bounded `ci_pending` wait.
 *
 * `failed: "attribute"` is the pre-merge gate of a reviewed candidate: failed
 * checks are attributed against the reviewed base instead of blocking at once
 * (a candidate-caused failure opens a correction round while rounds remain, a
 * red base defers). Every other caller keeps the terminal block.
 */
export async function gateDeliveryOnChecks(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  now: number,
  failed: "block" | "attribute" = "block",
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
  if (failed === "attribute") {
    return routeFailedDeliveryChecks(
      deps,
      context,
      record,
      failedChecks(observed.value.checks),
      decision.blocked,
      now,
    );
  }
  return persistWork(
    deps,
    context,
    markBlocked(record, "other", decision.blocked, now),
  );
}
