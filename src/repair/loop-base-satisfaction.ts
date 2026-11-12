/** Trusted pre-ranking exact-base task review and issue-only closure. */
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  allReservationsV1,
  findReservationV1,
} from "../contracts/state-snapshots.ts";
import { type GitHubPort, portError } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  baseResultSatisfied,
  type BaseTaskReviewPortV1,
  parseBaseReviewEvidenceRef,
} from "../github/base-review-evidence.ts";
import {
  BASE_REVIEW_HOLD_MS,
  baseReviewHoldExpired,
  baseReviewOrigin,
  holdNoChange,
  MAX_NO_CHANGE_BASE_REVIEWS,
  noChangeOutcomes,
} from "./base-satisfaction-marker.ts";
import {
  persistAfterSettlement,
  settleReviewCharge,
} from "./loop-accounting.ts";
import {
  checkGithubCooldown,
  OPERATION_MARGIN_MS,
  REVIEW_BOUND_MS,
} from "./loop-bounds.ts";
import {
  loadSnapshot,
  persistWork,
  replaceWorkMutation,
} from "./loop-state.ts";
import { configFor } from "./loop-records.ts";
import { readBase } from "./loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { markBlocked, markDone } from "./transitions.ts";

/** Optional host capability is in-memory only; no contract/stdout variant. */
export type BaseTaskReviewGitHubV1 = GitHubPort & {
  baseTaskReview?: BaseTaskReviewPortV1;
};

/** Park of a hold whose bound passed before any base review completed. */
export const BASE_REVIEW_HOLD_EXPIRED =
  "base review did not complete within its hold bound";

/** A completed review gave neither satisfied acceptance nor "work needed". */
export const BASE_REVIEW_NOT_ESTABLISHED =
  "base review did not establish already-satisfied task acceptance";

/**
 * A review found work still needed after `MAX_NO_CHANGE_BASE_REVIEWS`
 * no-change implementation outcomes (the count follows the prefix). It
 * matches no launcher retry prefix: the owner decides the next step.
 */
export const BASE_REVIEW_WORK_NEEDED_PARK =
  "base review found the task still needs work; no-change implementation outcomes:";

/** Park of a satisfied review whose issue closure kept deferring. */
export const BASE_CLOSURE_HOLD_EXPIRED =
  "base closure did not complete within its hold bound";

function park(record: WorkRecordV1, detail: string, now: number): WorkRecordV1 {
  return markBlocked(record, "missing_evidence", detail, now);
}

export async function resumeBaseSatisfaction(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  attempted: Set<string>,
): Promise<StepResultV1 | null> {
  const port = (deps.github as BaseTaskReviewGitHubV1).baseTaskReview;
  if (port === undefined) return null;
  const record = context.snapshot.work.find((row) =>
    !attempted.has(row.id) && configFor(deps, row.repository) !== null &&
    baseReviewOrigin(row, context.snapshot) !== null
  );
  if (!record) return null;
  attempted.add(record.id);
  const origin = baseReviewOrigin(record, context.snapshot)!;
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind !== "ok") return cooling;
  if (record.nextStep === "blocked") {
    return persistWork(deps, context, holdNoChange(record, deps.clock.now()));
  }
  if (record.intent?.kind === "issue_closure") {
    const admission = record.intent.requestId;
    if (!admission) {
      return persistWork(
        deps,
        context,
        park(
          record,
          "base review admission identity unavailable",
          deps.clock.now(),
        ),
      );
    }
    const charge = findReservationV1(context.snapshot, admission);
    if (charge?.outcome === "reserved") {
      // A prior host may have started native work. Absence of output never refunds it.
      const settled = await settleReviewCharge(
        deps,
        context,
        admission,
        "ambiguous",
      );
      if (settled.kind !== "progress") return settled;
      return { kind: "progress" };
    }
  }
  // A hold written before the bound existed gets its full window now; every
  // hold then ends here once its bound passes without a completed review.
  if (record.wait !== null && record.wait.until === null) {
    const now = deps.clock.now();
    return persistWork(deps, context, {
      ...record,
      wait: { ...record.wait, until: now + BASE_REVIEW_HOLD_MS },
      updatedAt: now,
    });
  }
  const expired = baseReviewHoldExpired(record, deps.clock.now());
  if (record.intent?.kind === "issue_closure") {
    const admission = record.intent.requestId;
    if (record.intent.resultId !== null) {
      const proof = record.evidence.find((row) => {
        const binding = row.kind === "review_receipt"
          ? parseBaseReviewEvidenceRef(row.ref)
          : null;
        return binding?.admission === admission &&
          binding.resultDigest === record.intent!.resultId;
      });
      if (!proof) {
        return persistWork(
          deps,
          context,
          park(
            record,
            "base review durable evidence unavailable",
            deps.clock.now(),
          ),
        );
      }
      const closed = await port.close({
        record,
        ref: proof.ref,
        deadline: context.bounds.runDeadline,
      }).catch(() =>
        portError("unavailable", "base closure outcome unavailable")
      );
      if (closed.ok) {
        return persistWork(deps, context, markDone(record, deps.clock.now()));
      }
      if (closed.error.kind !== "conflict" && closed.error.kind !== "invalid") {
        return expired
          ? persistWork(
            deps,
            context,
            park(record, BASE_CLOSURE_HOLD_EXPIRED, deps.clock.now()),
          )
          : {
            kind: "deferred",
            detail: "base closure waits for exact native evidence",
          };
      }
      // Source/base drift or invalid native evidence requires a fresh,
      // separately charged review. Review rounds are accounting only.
    }
  }
  if (expired) {
    return persistWork(
      deps,
      context,
      park(record, BASE_REVIEW_HOLD_EXPIRED, deps.clock.now()),
    );
  }
  const latestStartAt = Math.min(
    context.bounds.modelCutoff,
    context.bounds.runDeadline - OPERATION_MARGIN_MS - REVIEW_BOUND_MS,
  );
  if (deps.clock.now() >= latestStartAt) {
    return {
      kind: "deferred",
      detail: "base review cannot fit the remaining run bounds",
    };
  }
  const base = await readBase(deps, record.repository);
  if (base === null) {
    return { kind: "deferred", detail: "base review current base unavailable" };
  }
  const currentBase = { ...record, target: { ...record.target, base } };
  const inspected = await port.inspect({
    record: currentBase,
    deadline: latestStartAt,
  }).catch(() => portError("unavailable", "base review task unavailable"));
  if (!inspected.ok) {
    return {
      kind: "deferred",
      detail: "base review waits for current task and green CI",
    };
  }
  if (deps.clock.now() >= latestStartAt) {
    return { kind: "deferred", detail: "base review start deadline reached" };
  }
  const round = Math.max(
    record.counters.reviewRounds,
    ...allReservationsV1(context.snapshot).filter((row) =>
      row.taskId === record.id && row.purpose === "review_request"
    ).map((row) => row.attempt),
  ) + 1;
  const reserved = await deps.budget.reserveModelStart({
    repository: record.repository,
    taskId: record.id,
    head: base,
    attempt: round,
    purpose: "review_request",
  });
  if (reserved.status !== "admitted" && reserved.status !== "duplicate") {
    return { kind: "deferred", detail: "base review admission unavailable" };
  }
  // A duplicate can be a lost start; never repeat that native invocation.
  if (reserved.status === "duplicate") {
    return settleReviewCharge(
      deps,
      context,
      reserved.reservation.id,
      "ambiguous",
    );
  }
  const admission = reserved.reservation.id;
  const fresh = await loadSnapshot(deps, context.bounds);
  if (fresh === null) {
    return {
      kind: "state_error",
      detail: "base review state unavailable after admission",
    };
  }
  const observed = fresh.snapshot.work.find((row) => row.id === record.id);
  if (
    !observed || canonicalStringify(observed) !== canonicalStringify(record)
  ) {
    return {
      kind: "state_error",
      detail: "base review record moved after admission",
    };
  }
  const now = deps.clock.now();
  const held: WorkRecordV1 = {
    ...currentBase,
    nextStep: "work",
    blocker: null,
    // A further round never extends the hold: the bound counts from the
    // no-change outcome (or the first bounded visit of an older hold).
    wait: {
      reason: "backoff",
      since: now,
      until: record.wait?.until ?? now + BASE_REVIEW_HOLD_MS,
    },
    counters: { ...record.counters, reviewRounds: round },
    intent: {
      kind: "issue_closure",
      key: `base-review:${origin}:${inspected.value.digest}`,
      startedAt: now,
      branch: null,
      expectedHead: base,
      observedBase: base,
      pr: null,
      requestId: admission,
      resultId: null,
    },
    updatedAt: now,
  };
  const saved = await persistWork(deps, fresh, held);
  if (saved.kind !== "progress") return saved;
  // Any exception or uncertain native outcome consumes this round permanently.
  const outcome = await port.run({
    record: held,
    task: inspected.value,
    admission,
    latestStartAt,
    settleBy: Math.min(
      context.bounds.runDeadline - OPERATION_MARGIN_MS,
      deps.clock.now() + REVIEW_BOUND_MS,
    ),
  }).catch(() =>
    portError("unavailable", "base review native outcome unavailable")
  );
  const settled = await settleReviewCharge(
    deps,
    fresh,
    admission,
    outcome.ok ? "submitted" : "ambiguous",
  );
  if (settled.kind !== "progress" || !outcome.ok) return settled;
  const binding = parseBaseReviewEvidenceRef(outcome.value.ref);
  if (
    !binding || binding.admission !== admission || binding.base !== base ||
    binding.issueNumber !== record.related.issueNumber ||
    binding.taskDigest !== inspected.value.digest
  ) {
    return {
      kind: "state_error",
      detail: "base review result binding unavailable",
    };
  }
  const withProof: WorkRecordV1 = {
    ...held,
    evidence: [
      ...held.evidence.filter((row) =>
        !row.ref.startsWith("artifact:base-review/")
      ),
      { kind: "review_receipt" as const, ref: outcome.value.ref },
    ].slice(-64),
    intent: { ...held.intent!, resultId: binding.resultDigest },
    updatedAt: deps.clock.now(),
  };
  const result = outcome.value.result;
  const task = result.taskAcceptance ?? null;
  // The review answered that work is still needed at this exact base.
  const workNeeded = result.verdict !== "unavailable" && task !== null &&
    task.issueNumber === binding.issueNumber &&
    task.taskDigest === binding.taskDigest &&
    (task.verdict === "not_fulfilled" || task.verdict === "uncertain");
  const outcomes = noChangeOutcomes(fresh.snapshot, record);
  const at = withProof.updatedAt;
  const next = baseResultSatisfied(result, binding)
    ? withProof
    : !workNeeded
    ? park(withProof, BASE_REVIEW_NOT_ESTABLISHED, at)
    : outcomes < MAX_NO_CHANGE_BASE_REVIEWS
    // Back to a fresh implementation at the reviewed base, carrying the
    // review receipt as evidence; that start is admitted and charged by the
    // ordinary gates (identical-attempt refusal included). Every charge so
    // far stays settled as it is.
    ? { ...withProof, nextStep: "work" as const, wait: null, intent: null }
    : park(withProof, `${BASE_REVIEW_WORK_NEEDED_PARK} ${outcomes}`, at);
  return persistAfterSettlement(
    deps,
    context.bounds,
    replaceWorkMutation(next),
  );
}
