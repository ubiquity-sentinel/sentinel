/** Exact native membership + durable operation reconciliation, before enqueue decisions. */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import type {
  QueueBinding,
  QueueMembership,
  QueuePullIdentity,
  QueueRead,
  QueueSnapshot,
} from "../src/github/merge-queue-types.ts";
import type { HostedQueueCoordinatorDeps } from "./hosted-autonomy-queue-contracts.ts";
import type { HostedAutonomyDepsV1 } from "./hosted-autonomy-types.ts";
import {
  decideQueuePolicy,
  hasCompleteQueueAuthorizationFacts,
  hasConsistentQueueAbsence,
  hasQueueDeliveryProvenance,
  hasQueueIntentNamespace,
  isProvenQueueDequeueRemoval,
  isQueueHeld,
  type QueueAuthorizationFacts,
} from "./hosted-autonomy-queue-policy.ts";
import {
  isDefinitelyNotSubmitted,
  parseQueueIntent,
  queueDequeueComplete,
  queueFailure,
  queueIntentBinding,
} from "./hosted-autonomy-queue-intent.ts";
import {
  type QueueCustodyWriter,
  queueHold,
} from "./hosted-autonomy-queue-writer.ts";
import { submitQueueAdmission } from "./hosted-autonomy-queue-submit.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import { acknowledgeBaseRefresh } from "../src/repair/loop-base-refresh.ts";
import { candidatePreservationRef } from "../src/repair/keys.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";

export interface QueueRecordPass {
  deps: HostedAutonomyDepsV1;
  queue: HostedQueueCoordinatorDeps;
  writer: QueueCustodyWriter;
  record: WorkRecordV1;
  native: QueueSnapshot;
  deadline: number;
  allowSubmission: boolean;
}
export interface QueueRecordOutcome {
  ready: boolean;
  submitted: boolean;
}
const ready = (): QueueRecordOutcome => ({ ready: true, submitted: false });
const stop = (): QueueRecordOutcome => ({ ready: false, submitted: false });

export async function reconcileQueueRecord(
  input: QueueRecordPass,
): Promise<QueueRecordOutcome> {
  const { queue, writer, deps } = input;
  let { record } = input;
  const tag = `queue:${record.id}`;
  if (isQueueHeld(record) && record.intent?.kind === "base_refresh") {
    const recovered = await queue.authorization.readPublishedRefreshRecovery?.({
      snapshot: writer.observed.snapshot,
      observedHead: writer.observed.head,
      record,
      binding: null,
      queue: input.native,
      deadline: input.deadline,
    });
    if (recovered?.status !== "complete") {
      writer.actions.push(`${tag}:published_refresh_unavailable`);
      return ready();
    }
    const { candidate, at } = recovered.value;
    if (
      candidate.operationKey !== record.intent.key ||
      candidate.head !== record.intent.resultId ||
      candidate.base !== record.intent.observedBase ||
      candidate.ref !== await candidatePreservationRef(
          record.repository,
          record.id,
          record.intent.key,
        ) ||
      deps.clock.now() >= input.deadline ||
      at > deps.clock.now() || at < record.updatedAt
    ) return stop();
    const acknowledged = acknowledgeBaseRefresh(
      record,
      record.intent,
      candidate.ref,
      at,
    );
    if (!await writer.update([acknowledged])) return stop();
    writer.actions.push(`${tag}:published_refresh_acknowledged`);
    return ready();
  }
  const saved = await queueIntentBinding(writer.observed.snapshot, record);
  if (hasQueueIntentNamespace(record) && saved === null) {
    writer.actions.push(`${tag}:invalid_intent_owner_action`);
    return ready();
  }
  const auth = await queue.authorization.readAuthorization({
    snapshot: writer.observed.snapshot,
    observedHead: writer.observed.head,
    record,
    binding: saved?.binding ?? null,
    queue: input.native,
  });
  if (auth.status !== "complete") {
    writer.actions.push(`${tag}:authorization_unavailable`);
    return ready();
  }
  const { binding, pull } = auth.value;
  if (
    saved !== null &&
    canonicalStringify(binding) !== canonicalStringify(saved.binding)
  ) {
    writer.actions.push(`${tag}:binding_changed_owner_action`);
    return ready();
  }
  const member = await queue.surface.readPullMembership(pull);
  if (member.status !== "complete") {
    writer.actions.push(`${tag}:membership_unavailable`);
    return stop();
  }
  if (member.value.entry !== null) {
    const held = queueHold(record, deps.clock.now());
    if (held !== record) {
      if (!await writer.update([held])) return stop();
      record = held;
    }
  }
  if (member.value.mergedRevision !== null) {
    writer.actions.push(`${tag}:merged_proof_required`);
    return ready();
  }
  let state = saved?.state ?? null;
  const entry = member.value.entry;
  const actor = queue.config.appActor;
  if (state?.stage === "dequeue_pending") {
    // The marker is not cleared by membership absence.  Only the exact
    // complete timeline read can convert it into a durable completion proof.
    if (
      entry !== null || state.intent.resultId === null || actor === null ||
      member.value.pull.head !== binding.head ||
      canonicalStringify(member.value.pull) !== canonicalStringify(pull)
    ) {
      writer.actions.push(`${tag}:dequeue_pending_owner_action`);
      return ready();
    }
    const removed = await queue.authorization.readRemoval({
      snapshot: writer.observed.snapshot,
      observedHead: writer.observed.head,
      record,
      binding,
      entryId: state.intent.resultId,
    });
    if (
      removed.status !== "complete" ||
      !isProvenQueueDequeueRemoval(removed.value)
    ) {
      writer.actions.push(`${tag}:dequeue_pending_owner_action`);
      return ready();
    }
    const intent = queueDequeueComplete(state, deps.clock.now());
    record = { ...record, intent, updatedAt: deps.clock.now() };
    if (!await writer.update([record])) return stop();
    state = parseQueueIntent(record);
    if (state === null || state.stage !== "dequeue_complete") return stop();
    writer.actions.push(`${tag}:dequeue_complete`);
  }
  if (state?.stage === "dequeue_complete" && entry !== null) {
    // A new/foreign entry cannot be adopted as the entry whose removal was
    // just proved.  Leave the durable proof in place for owner reconciliation.
    writer.actions.push(`${tag}:dequeue_complete_entry_owner_action`);
    return ready();
  }
  if (state === null && entry === null && queueRecordProtected(record)) {
    writer.actions.push(`${tag}:foreign_hold_absent_owner_action`);
    return ready();
  }
  if (
    state !== null && entry !== null && actor !== null &&
    state.intent.resultId === null &&
    member.value.pull.head === binding.head &&
    canonicalStringify(member.value.pull) === canonicalStringify(pull) &&
    entry.enqueuedAt >= Math.floor(state.intent.startedAt / 1000) * 1000 &&
    entry.enqueuedAt <= deps.clock.now() &&
    canonicalStringify(entry.enqueuer) === canonicalStringify(actor)
  ) {
    record = {
      ...record,
      intent: { ...state.intent, resultId: entry.id },
      updatedAt: deps.clock.now(),
    };
    if (!await writer.update([record])) return stop();
    state = parseQueueIntent(record);
  }
  const ownsEntry = state !== null && entry !== null && actor !== null &&
    entry.id === state.intent.resultId &&
    canonicalStringify(entry.enqueuer) === canonicalStringify(actor);
  if (state !== null && entry === null && state.intent.requestId !== null) {
    const polled = await queue.surface.poll(pull, state.intent.requestId);
    if (polled.status !== "complete") {
      writer.actions.push(`${tag}:operation_unavailable`);
      // Unknown operation is never resubmitted, even after HTTP 404 or a timeout.
    } else if (polled.value.status === "failed") {
      const intent = queueFailure(
        { ...state.intent, requestId: null },
        "refused",
        Math.min(3, state.refusals + 1),
        state.queueFailures,
        deps.clock.now(),
        true,
      );
      record = { ...record, intent, updatedAt: deps.clock.now() };
      if (!await writer.update([record])) return stop();
      state = parseQueueIntent(record);
      writer.actions.push(`${tag}:admission_refused`);
    } else {
      writer.actions.push(`${tag}:operation_${polled.value.status}`);
    }
  }
  if (
    state !== null && entry === null && state.intent.resultId !== null &&
    state.stage !== "dequeue_complete" &&
    state.stage !== "ejected_ci_failed" && state.stage !== "ejected_timeout"
  ) {
    const removed = await queue.authorization.readRemoval({
      snapshot: writer.observed.snapshot,
      observedHead: writer.observed.head,
      record,
      binding,
      entryId: state.intent.resultId,
    });
    if (
      removed.status !== "complete" || removed.value.eventId === null ||
      (removed.value.classification !== "ci_failed" &&
        removed.value.classification !== "timeout")
    ) {
      writer.actions.push(`${tag}:removal_unproven_owner_action`);
      return ready();
    }
    const intent = queueFailure(
      { ...state.intent, requestId: null },
      removed.value.classification === "ci_failed"
        ? "ejected_ci_failed"
        : "ejected_timeout",
      state.refusals,
      Math.min(2, state.queueFailures + 1),
      deps.clock.now(),
      true,
    );
    record = { ...record, intent, updatedAt: deps.clock.now() };
    if (!await writer.update([record])) return stop();
    state = parseQueueIntent(record);
  }
  const retryable = state?.stage === "refused" ||
    state?.stage === "not_submitted" ||
    state?.stage === "ejected_ci_failed" || state?.stage === "ejected_timeout";
  const facts = {
    ...auth.value.facts,
    binding,
    membership: member,
    ownsEntry,
    definitiveRefusals: state?.refusals ?? 0,
    admissionStartedAt:
      entry !== null || state?.intent.resultId !== null && state !== null
        ? null
        : state?.intent.startedAt ?? null,
    now: deps.clock.now(),
    admissionAmbiguous: state !== null && state.stage !== "dequeue_complete" &&
      !retryable,
    reentry: state?.stage === "dequeue_complete" ||
      (state?.queueFailures ?? 0) > 0,
    failedQueueAdmissions: state?.queueFailures ?? 0,
  };
  const decision = decideQueuePolicy(facts);
  if (
    decision.action === "hold" && state !== null &&
    isDefinitelyNotSubmitted(state)
  ) {
    const reconciled = await reconcileNotSubmitted(
      input,
      record,
      binding,
      pull,
      member,
      auth.value.facts,
    );
    if (reconciled !== null) return reconciled;
  }
  if (decision.action === "dequeue_owned") {
    if (
      state === null || state.intent.resultId !== decision.entryId ||
      deps.clock.now() >= input.deadline
    ) {
      return stop();
    }
    record = {
      ...record,
      intent: { ...state.intent, key: `${state.intent.key}:d1` },
      updatedAt: deps.clock.now(),
    };
    // A crash anywhere after this CAS is uncertain. Never replay a PR-scoped dequeue.
    if (!await writer.update([record])) return stop();
    const current = await deps.state.readRepair();
    if (
      deps.clock.now() >= input.deadline || !current.ok ||
      current.value.status !== "found" ||
      current.value.head !== writer.observed.head ||
      canonicalStringify(current.value.snapshot) !==
        canonicalStringify(writer.observed.snapshot)
    ) return stop();
    const result = await queue.surface.dequeue({
      pull: member.value.pull,
      entryId: decision.entryId,
    });
    writer.actions.push(`${tag}:dequeue_${result.status}:${decision.reason}`);
    return { ready: result.status === "submitted", submitted: true };
  }
  if (decision.action === "hold" || decision.action === "owner_park") {
    writer.actions.push(`${tag}:${decision.action}:${decision.reason}`);
    return ready();
  }
  if (!input.allowSubmission) {
    writer.actions.push(`${tag}:enqueue_disabled`);
    return ready();
  }
  if (record.intent !== null && state === null) {
    writer.actions.push(`${tag}:existing_intent_retained`);
    return ready();
  }
  return await submitQueueAdmission({ ...input, record }, binding, pull, state);
}

/**
 * #169: a definitely-unsent first admission that the fresh authorization now
 * refuses returns to the runtime instead of holding until the six-hour owner
 * park, but only under an authenticated negative effective merge_queue rule
 * (the direct path the runtime then takes is allowed only there).  Besides the pass's initial snapshot, the membership read and the
 * authorization membership, it needs one more fresh queue scan; any entry,
 * incomplete fact, durable provenance or deadline keeps strict custody (null).
 * Charges, counters and review rounds are untouched, and elapsed time is
 * never the reason.
 */
async function reconcileNotSubmitted(
  input: QueueRecordPass,
  record: WorkRecordV1,
  binding: QueueBinding,
  pull: QueuePullIdentity,
  member: QueueRead<QueueMembership>,
  authorization: QueueAuthorizationFacts,
): Promise<QueueRecordOutcome | null> {
  const { deps, queue, writer } = input;
  if (
    hasQueueDeliveryProvenance(record) ||
    writer.observed.snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, record)
    ) ||
    !hasCompleteQueueAuthorizationFacts(authorization) ||
    deps.clock.now() >= input.deadline
  ) return null;
  // Release only when the runtime's direct path can take the record: an
  // authenticated negative effective rule. Under an active (or unknown) rule a
  // released record is refused `queue_required` and held with no intent for
  // good, so it keeps its retryable unsent custody instead (review finding,
  // upheld 3 of 3).
  const rules = await queue.readEffectiveQueueRule();
  if (rules.status !== "complete" || rules.value !== false) return null;
  const scan = await queue.surface.readQueue("development");
  const now = deps.clock.now();
  if (
    now >= input.deadline ||
    !hasConsistentQueueAbsence({
      repository: queue.repository,
      binding,
      pull,
      snapshots: [{ status: "complete", value: input.native }, scan],
      memberships: [member, authorization.membership],
    })
  ) return null;
  const released: WorkRecordV1 = {
    ...record,
    intent: null,
    wait: { reason: "unavailable", since: now, until: now },
    updatedAt: now,
  };
  if (!await writer.update([released])) return stop();
  writer.actions.push(`queue:${record.id}:not_submitted_reconciled`);
  return ready();
}
