/** Repair loop internals: checks. */
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { missingExpectedChecks } from "./ci-coverage.ts";
import {
  checkPending,
  failedChecks,
  latestChecks,
  readCiChecks,
} from "./ci-rejection.ts";
import {
  isCiEvidenceCheck,
  isPassportDeployCheck,
  selectMergeGateChecksV1,
} from "./merge-gate-checks.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import {
  actionsSuccessNames,
  ciExpectationSatisfied,
  type CiExpectationV1,
  headCiChange,
  readCiExpectation,
  recordBaseRef,
  runtimeCiReferenceReads,
} from "./ci-success-rule.ts";
import { routeFailedDeliveryChecks } from "./loop-ci-correction.ts";
import { isSelfScopeZero } from "./loop-legacy-loss.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { markBlocked, setWait } from "./transitions.ts";

/**
 * The self scope's `ci.yml`: the jobs the aggregate `needs:` (a shard is
 * `test-shards (<name>)`) and the aggregate itself.
 */
const SELF_SUITE_JOBS = ["quality", "test-shards"] as const;
const SELF_AGGREGATE_CHECK = "test-local";

/**
 * Pure CI gate decision. Returns "proceed" only when every (deduped by name)
 * check is completed with `success` conclusion. Returns "wait" when any check
 * is still running, when a GitHub Actions run's job never started (a billing
 * or spending-limit stop, `checkPending`), or when no checks are recorded (no
 * evidence CI ran).
 * Returns a block detail when any check completed non-green (failure,
 * timed_out, cancelled, action_required, stale; skipped and neutral are green,
 * matching requiredChecksState semantics). Exported for focused testing.
 *
 * A Passport deployment check is retained in the observation as evidence but
 * never judged here (owner directive 2026-10-30): only its own CI jobs gate.
 * A target with no CI check left after that selection is "wait" (a deployment
 * observation alone is no evidence CI ran), never "proceed"; so is a head
 * with no positive CI evidence (`isCiEvidenceCheck`: a GitHub Actions,
 * app-less or backup stand-in check concluded success, skipped or neutral). A check from any other app (a
 * review bot, scanner or deploy preview) is judged (a failure still blocks,
 * a pending one still waits) but never counts as CI evidence.
 *
 * It judges only the checks that exist: GitHub creates a `needs:` job's
 * check run only once its dependencies finish. The CI-first review gate and
 * the carried delivery steps therefore also require coverage of the base the
 * head is tested against (`absentExpectedChecks`) before a "proceed" counts.
 *
 * `requireSuccess` (2026-11-17, a head that changes a CI-executable path,
 * `ci-success-rule.ts`): such a head waits unless its GitHub Actions success
 * names meet `expectation` (every name the last merged pull request with an
 * Actions success passed, else the base's, else at least one job; an
 * absent or unknown expectation never does). Skipped, neutral, stand-in,
 * status and other-app observations never count. Every caller that omits it
 * decides exactly as before.
 */
export function decideCiGate(
  checks: GitHubCheckV1[],
  repository?: Pick<RepositoryIdentityV1, "owner" | "name">,
  options?: {
    readonly requireSuccess?: boolean;
    readonly expectation?: CiExpectationV1;
  },
): "proceed" | "wait" | { blocked: string } {
  const gating = selectMergeGateChecksV1(repository, checks).checks;
  if (gating.length === 0) return "wait";
  // Dedupe: GitHub returns historical observations; only the latest per name
  // counts. Recency is by startedAt (when the run began): a newer in-progress
  // rerun must override an older completed run, otherwise we'd merge while
  // CI is still running.
  const deduped = latestChecks(gating);
  // Failed checks are terminal: classify them before pending so a queued
  // check cannot mask a failure (CodeRabbit #131 review).
  const failed = failedChecks(deduped);
  if (failed.length > 0) {
    const names = failed.map((check) =>
      `${check.name}(${check.conclusion ?? "unknown"})`
    ).join(", ");
    return { blocked: `CI checks failed: ${names}` };
  }
  const pending = deduped.some(checkPending);
  if (pending) return "wait";
  // Positive evidence only: a head whose green checks all come from other
  // apps (the gateway's lone skipped `CodeRabbit`, a scanner or a preview,
  // before any `Gateway CI` run) waits exactly like a head with no checks.
  if (!deduped.some(isCiEvidenceCheck)) return "wait";
  if (
    options?.requireSuccess === true &&
    !ciExpectationSatisfied(
      options.expectation ?? { kind: "unknown" },
      actionsSuccessNames(gating),
    )
  ) return "wait";
  return "proceed";
}

/**
 * `decideCiGate` for `record`'s own head under the 2026-11-17 success rule
 * (`ci-success-rule.ts`): a head that would proceed and whose change set
 * (the local mirror's diff, else one exact comparison) changes a
 * CI-executable path is judged with `requireSuccess` against the expectation
 * read from the base branch's merged pull requests (unreadable: wait). A
 * head shown unchanged, or not shown at all, gets exactly `decideCiGate`'s
 * verdict; the merge executors hold the unknown case fail closed.
 */
export async function decideHeadCiGate(
  deps:
    & Pick<RepairCycleDepsV1, "github">
    & Partial<Pick<RepairCycleDepsV1, "configs">>,
  record: Pick<WorkRecordV1, "target" | "repository">,
  checks: GitHubCheckV1[],
  repository?: Pick<RepositoryIdentityV1, "owner" | "name">,
): Promise<"proceed" | "wait" | { blocked: string }> {
  const decision = decideCiGate(checks, repository);
  if (decision !== "proceed") return decision;
  if (await headCiChange(deps, record) !== "ci") return decision;
  return decideCiGate(checks, repository, {
    requireSuccess: true,
    expectation: await headCiExpectation(deps, record),
  });
}

/** The expectation for `record`'s CI-changing head (`ci-success-rule.ts`). */
export function headCiExpectation(
  deps:
    & Pick<RepairCycleDepsV1, "github">
    & Partial<Pick<RepairCycleDepsV1, "configs">>,
  record: Pick<WorkRecordV1, "target" | "repository">,
): Promise<CiExpectationV1> {
  return readCiExpectation(
    runtimeCiReferenceReads(
      deps.github,
      record.repository,
      recordBaseRef(deps, record),
    ),
    record.target.base,
  );
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
 * scope reads no base at all, like the launcher: its `development` tip carries
 * the supervisor.yml runs of `sentinel-supervisor` (fast-forwarded with it)
 * and the five-minute `dispatch` runs, whose listings are large and share no
 * name with a pull request head. Its gate is the one named `test-local` job
 * of `ci.yml`, since 2026-10-20 a `needs: [quality, test-shards]` aggregate
 * that GitHub creates only once those jobs finish: a head whose own `ci.yml`
 * jobs already report but whose aggregate does not exist yet is awaited like
 * running CI instead of admitting a review before the aggregate ran.
 */
export async function absentExpectedChecks(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  head: readonly GitHubCheckV1[],
): Promise<string[] | null> {
  if (isSelfScopeZero(record.repository)) {
    const names = new Set(head.map((check) => check.name));
    const suiteReported = [...names].some((name) =>
      SELF_SUITE_JOBS.some((job) => name === job || name.startsWith(`${job} (`))
    );
    return suiteReported && !names.has(SELF_AGGREGATE_CHECK)
      ? [SELF_AGGREGATE_CHECK]
      : [];
  }
  const observed = await deps.github.readCheckSuites(record.target.base);
  if (!observed.ok) return null;
  // A Passport deploy check is evidence, not an expected CI job: neither the
  // head's deploy observations nor a base deploy suite may park the review.
  const gatingHead = selectMergeGateChecksV1(record.repository, head).checks;
  const expected = observed.value.checks.filter((check) =>
    !isPassportDeployCheck(record.repository, check.name)
  );
  return missingExpectedChecks(gatingHead, expected);
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
  const observed = await readCiChecks(deps.github, head);
  if (!observed.ok) {
    // Transient read failure: defer without a wait so the next turn retries.
    return { kind: "deferred", detail: "CI check observation unavailable" };
  }
  const decision = await decideHeadCiGate(
    deps,
    record,
    observed.value.checks,
    record.repository,
  );
  if (decision === "proceed") {
    // Every selected (deduped) CI check completed green: the CI gate passes
    // and the merge authorization proceeds. Deploy observations stay evidence.
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
      failedChecks(
        selectMergeGateChecksV1(
          record.repository,
          observed.value.checks,
        ).checks,
      ),
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
