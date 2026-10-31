import { guardQueueOperation } from "./loop-queue-guard.ts";
import { guardQueueDelivery } from "./loop-queue-guard.ts";
/** Repair loop internals: closure. */
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { reviewEvidenceRef } from "./keys.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import { gateDeliveryOnChecks } from "./loop-checks.ts";
import { releaseRequestMatchesDelivery } from "./loop-records.ts";
import { persistWork } from "./loop-state.ts";
import {
  type CarriedReleaseProverV1,
  gitCarriedReleaseProver,
  releaseDeliveryTaskRefusal,
} from "./carried-release.ts";
import {
  readDeliveryTaskContext,
  releaseRequestReceipt,
  semanticRefusalKind,
} from "./loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { classifyReviewTerminalDisposition } from "./review-gate.ts";
import { clearIntent, markBlocked, markDone, setWait } from "./transitions.ts";
import {
  gatewayClosureIntentBindsRequest,
  isGatewayVpsRepository,
  observeGatewayVpsDelivery,
} from "./vps-delivery.ts";

export async function retryAlreadySatisfiedClosure(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueOperation(deps, context, record, "resume");
  if (queueGuard !== null) return queueGuard;
  const intent = record.intent;
  const close = deps.github.closeAlreadySatisfiedTask;
  if (intent?.kind !== "already_satisfied_closure" || close === undefined) {
    return {
      kind: "deferred",
      detail: "already-satisfied closure capability unavailable",
    };
  }
  const now = deps.clock.now();
  if (now >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "already-satisfied closure crossed the total run deadline",
    };
  }
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind !== "ok") {
    return { kind: cooling.kind, detail: cooling.detail };
  }
  const receipt = context.snapshot.reviews.find((review) =>
    review.requestId === intent.requestId &&
    review.resultId === intent.resultId && record.evidence.some((evidence) =>
      evidence.kind === "review_receipt" &&
      evidence.ref === reviewEvidenceRef(review.id)
    )
  );
  const task = await readDeliveryTaskContext(deps, record);
  if (task === "unavailable") {
    return {
      kind: "deferred",
      detail: "already-satisfied task context unavailable",
    };
  }
  const disposition = classifyReviewTerminalDisposition(
    receipt,
    record,
    deps.github.reviewerIdentity,
    task,
  );
  if (disposition.kind !== "qualified_already_satisfied") {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "missing_evidence",
        disposition.kind === "refused"
          ? disposition.reason
          : "already-satisfied verdict changed",
        now,
      ),
    );
  }
  const ciGate = await gateDeliveryOnChecks(deps, context, record, now);
  if (ciGate !== null) return ciGate;
  const closed = await close.call(deps.github, {
    record,
    review: receipt!,
    deadline: context.bounds.runDeadline,
  });
  if (!closed.ok) {
    if (closed.error.kind === "invalid" || closed.error.kind === "conflict") {
      return persistWork(
        deps,
        context,
        markBlocked(record, "missing_evidence", closed.error.detail, now),
      );
    }
    return persistWork(
      deps,
      context,
      setWait(record, {
        reason: "unavailable",
        since: now,
        until: now + CHECK_POLL_MS,
      }, now),
    );
  }
  return persistWork(deps, context, markDone(record, deps.clock.now()));
}

/**
 * Retry one durable issue closure. A carried delivery (Sentinel #152) is
 * revalidated through the carried binders, its git patch proof re-derived by
 * `carried` (the step's one prover).
 */
export async function retryClosure(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  carried: CarriedReleaseProverV1 | undefined = gitCarriedReleaseProver(deps),
): Promise<StepResultV1> {
  const queueGuard = await guardQueueDelivery(deps, context, record);
  if (queueGuard !== null) return queueGuard;
  const issueNumber = record.related.issueNumber;
  if (issueNumber === null) {
    if (isGatewayVpsRepository(record.repository)) {
      return {
        kind: "deferred",
        detail: "gateway closure requires exact issue identity",
      };
    }
    return persistWork(
      deps,
      context,
      markDone(clearIntent(record, deps.clock.now()), deps.clock.now()),
    );
  }
  const now = deps.clock.now();
  // The issue_closure intent is durable: the closure mutation never starts
  // at/after the total deadline (the release read may have crossed it), so
  // the next run retries the exact closure once. The shared cooldown gate is
  // checked before the closure write: a deferral keeps the closure intent.
  if (now >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "issue closure crossed the total run deadline",
    };
  }
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
  // The durable intent was written from an EARLIER read of the trusted task
  // context, which may have changed since (an edited issue body, a vanished or
  // different issue). Revalidate the exact recorded delivery proof through the
  // release request this intent names BEFORE the external closure and the done
  // transition: a missing, mismatched or no-longer-bound proof blocks instead
  // of closing the issue, and a transient read failure keeps the intent for the
  // next run.
  const intentRequestId = record.intent?.requestId ?? null;
  const referencedRequest = context.snapshot.releaseRequests.find((item) =>
    item.id === intentRequestId && releaseRequestMatchesDelivery(item, record)
  );
  const referenced = referencedRequest === undefined
    ? null
    : releaseRequestReceipt(context.snapshot.reviews, referencedRequest);
  if (isGatewayVpsRepository(record.repository)) {
    const accepted = referencedRequest === undefined ||
        !gatewayClosureIntentBindsRequest(record, referencedRequest)
      ? { kind: "wait" as const }
      : await observeGatewayVpsDelivery(
        deps.state,
        record,
        referencedRequest,
        referenced,
        carried,
      );
    if (accepted.kind === "blocked") {
      return persistWork(
        deps,
        context,
        markBlocked(record, "other", accepted.reason, now),
      );
    }
    if (accepted.kind !== "accepted") {
      return persistWork(
        deps,
        context,
        setWait(record, {
          reason: "unavailable",
          since: now,
          until: now + CHECK_POLL_MS,
        }, now),
      );
    }
    const checks = await gateDeliveryOnChecks(deps, context, record, now);
    if (checks !== null) return checks;
  }
  const semantic = await releaseDeliveryTaskRefusal(
    deps,
    record,
    referencedRequest,
    referenced,
    carried,
  );
  if (semantic === "wait") {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }
  if (semantic !== null) {
    return persistWork(
      deps,
      context,
      markBlocked(
        clearIntent(record, now),
        semanticRefusalKind(semantic),
        semantic,
        now,
      ),
    );
  }
  // The revalidation read is awaited wall-clock time: it may have crossed the
  // total deadline, and the closure mutation must not start then. The closure
  // intent stays durable; the next run revalidates and closes once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "issue closure crossed the total run deadline",
    };
  }
  const closed = await deps.github.closeIssue(issueNumber);
  if (!closed.ok) {
    // Closure-only retry: the issue_closure intent remains and only the
    // closure operation is retried.
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }
  return persistWork(deps, context, markDone(clearIntent(record, now), now));
}
