/** Before-effects intent/hold, fresh native authorization, then one async queue submission. */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { hasTakeoverCustody } from "../src/github/existing-pr-takeover-provenance.ts";
import type {
  QueueBinding,
  QueueMembership,
  QueuePullIdentity,
  QueueRead,
  QueueSnapshot,
} from "../src/github/merge-queue-types.ts";
import type { HostedQueueAuthorizationPort } from "./hosted-autonomy-queue-contracts.ts";
import type {
  QueueRecordOutcome,
  QueueRecordPass,
} from "./hosted-autonomy-queue-reconcile.ts";
import {
  createQueueIntent,
  queueFailure,
  type QueueIntentState,
  queueReentryIntent,
} from "./hosted-autonomy-queue-intent.ts";
import { queueHold } from "./hosted-autonomy-queue-writer.ts";
import {
  decideQueuePolicy,
  hasCompleteQueueAuthorizationFacts,
  hasConsistentQueueAbsence,
  hasQueueDeliveryProvenance,
} from "./hosted-autonomy-queue-policy.ts";

type QueueAuthorizationRead = Awaited<
  ReturnType<HostedQueueAuthorizationPort["readAuthorization"]>
>;

export async function submitQueueAdmission(
  input: QueueRecordPass,
  binding: QueueBinding,
  pull: QueuePullIdentity,
  previous: QueueIntentState | null,
): Promise<QueueRecordOutcome> {
  const { deps, queue, writer } = input;
  const stop = (): QueueRecordOutcome => ({ ready: false, submitted: false });
  const tag = `queue:${input.record.id}`;
  let intent = previous === null
    ? await createQueueIntent(input.record, binding, deps.clock.now())
    : previous.stage === "dequeue_complete"
    ? queueReentryIntent(previous, deps.clock.now())
    : { ...previous.intent, requestId: null, resultId: null };
  // A proven ejection permits exactly one new admission, never an age-based retry reset.
  if (
    previous?.admission === 0 && previous.queueFailures === 1 &&
    (previous.stage === "ejected_ci_failed" ||
      previous.stage === "ejected_timeout")
  ) {
    intent = {
      ...intent,
      key: `${intent.key}:a1`,
      startedAt: deps.clock.now(),
    };
  }
  if (previous !== null && intent.failure !== undefined) {
    // Mark the next effect uncertain BEFORE submission without inventing another failed execution.
    intent = queueFailure(
      intent,
      "ambiguous",
      previous.refusals,
      previous.queueFailures,
      deps.clock.now(),
      false,
    );
  }
  let record = {
    ...queueHold(input.record, deps.clock.now()),
    intent,
    updatedAt: deps.clock.now(),
  };
  if (!await writer.update([record])) {
    writer.actions.push(`${tag}:intent_unverified`);
    return stop();
  }
  // #169: only this call knows that no effect followed its committed intent.
  // A definite preflight refusal records `not_submitted` for a first admission
  // or for a retry of a not-submitted result, and only when the pass's initial
  // snapshot, the fresh scan, the membership read and the authorization
  // membership all show the pull absent; otherwise the conservative mark stays.
  // Null means unproven, false means the recording write was not verified.
  const recordNotSubmitted = async (
    scanned: QueueRead<QueueSnapshot>,
    observed: QueueRead<QueueMembership>,
    authorization: QueueAuthorizationRead,
    reason: "queue_disabled" | "authorization_refused",
  ): Promise<boolean | null> => {
    if (
      (previous !== null && previous.stage !== "not_submitted") ||
      hasQueueDeliveryProvenance(record) ||
      deps.clock.now() >= input.deadline ||
      authorization.status !== "complete" ||
      canonicalStringify(authorization.value.binding) !==
        canonicalStringify(binding) ||
      canonicalStringify(authorization.value.pull) !==
        canonicalStringify(pull) ||
      !hasCompleteQueueAuthorizationFacts(authorization.value.facts) ||
      !hasConsistentQueueAbsence({
        repository: queue.repository,
        binding,
        pull,
        snapshots: [{ status: "complete", value: input.native }, scanned],
        memberships: [observed, authorization.value.facts.membership],
      })
    ) return null;
    record = {
      ...record,
      intent: queueFailure(
        intent,
        "not_submitted",
        previous?.refusals ?? 0,
        previous?.queueFailures ?? 0,
        deps.clock.now(),
        // A retry restores its earlier result; a first admission records one.
        previous === null,
      ),
      updatedAt: deps.clock.now(),
    };
    if (!await writer.update([record])) return false;
    writer.actions.push(`${tag}:pre_effect_not_submitted:${reason}`);
    return true;
  };
  // This call alone knows no effect preceded the freshly committed intent. A restart does not.
  const rules = await queue.readEffectiveQueueRule();
  const scan = await queue.surface.readQueue("development");
  const member = await queue.surface.readPullMembership(pull);
  if (
    rules.status !== "complete" || rules.value !== true ||
    scan.status !== "complete" ||
    member.status !== "complete" || member.value.entry !== null ||
    member.value.mergedRevision !== null ||
    canonicalStringify(member.value.pull) !== canonicalStringify(pull) ||
    deps.clock.now() >= input.deadline
  ) {
    writer.actions.push(`${tag}:pre_effect_observation_changed`);
    // Only an authenticated negative rule is a definite refusal. Unknown rules,
    // an incomplete read, an entry, a merge, another pull or the deadline are not.
    if (
      rules.status === "complete" && rules.value === false &&
      scan.status === "complete" && member.status === "complete" &&
      deps.clock.now() < input.deadline
    ) {
      await recordNotSubmitted(
        scan,
        member,
        await queue.authorization.readAuthorization({
          snapshot: writer.observed.snapshot,
          observedHead: writer.observed.head,
          record,
          binding,
          queue: scan.value,
        }),
        "queue_disabled",
      );
    }
    return stop();
  }
  const auth = await queue.authorization.readAuthorization({
    snapshot: writer.observed.snapshot,
    observedHead: writer.observed.head,
    record,
    binding,
    queue: scan.value,
  });
  if (
    auth.status !== "complete" ||
    canonicalStringify(auth.value.binding) !== canonicalStringify(binding) ||
    canonicalStringify(auth.value.pull) !== canonicalStringify(pull)
  ) {
    writer.actions.push(`${tag}:pre_effect_authorization_changed`);
    return stop();
  }
  const decision = decideQueuePolicy({
    ...auth.value.facts,
    binding,
    membership: member,
    ownsEntry: false,
    definitiveRefusals: previous?.refusals ?? 0,
    admissionStartedAt: previous?.intent.resultId ? null : intent.startedAt,
    now: deps.clock.now(),
    admissionAmbiguous: false,
    reentry: (previous?.queueFailures ?? 0) > 0,
    failedQueueAdmissions: previous?.queueFailures ?? 0,
  });
  if (decision.action !== "enqueue" && decision.action !== "reenter") {
    writer.actions.push(
      `${tag}:pre_effect_${decision.action}:${
        "reason" in decision ? decision.reason : "refused"
      }`,
    );
    if (
      decision.action === "hold" &&
      await recordNotSubmitted(scan, member, auth, "authorization_refused") ===
        false
    ) return stop();
    return { ready: true, submitted: false };
  }
  // A competing state writer between the readback and effect revokes this pass's authority.
  const current = await deps.state.readRepair();
  if (
    deps.clock.now() >= input.deadline ||
    !current.ok || current.value.status !== "found" ||
    current.value.head !== writer.observed.head ||
    canonicalStringify(current.value.snapshot) !==
      canonicalStringify(writer.observed.snapshot)
  ) return stop();
  let outcome;
  if (hasTakeoverCustody(record)) {
    const allowed = await queue.authorization.authorizeEnqueue?.({
      snapshot: writer.observed.snapshot,
      observedHead: writer.observed.head,
      record,
      binding,
      queue: scan.value,
      deadline: input.deadline,
    });
    if (!allowed?.ok) {
      writer.actions.push(`${tag}:existing_pr_enqueue_custody_unavailable`);
      return stop();
    }
  }
  if (deps.clock.now() >= input.deadline) return stop();
  try {
    outcome = await queue.surface.enqueue(pull);
  } catch {
    outcome = { status: "ambiguous", requestId: null } as const;
  }
  const now = deps.clock.now();
  if (outcome.status === "pending") {
    intent = { ...intent, requestId: outcome.requestId };
  } else if (outcome.status === "refused") {
    intent = queueFailure(
      intent,
      "refused",
      Math.min(3, (previous?.refusals ?? 0) + 1),
      previous?.queueFailures ?? 0,
      now,
      true,
    );
  } else if (outcome.status === "not_submitted") {
    intent = queueFailure(
      intent,
      "not_submitted",
      previous?.refusals ?? 0,
      previous?.queueFailures ?? 0,
      now,
      true,
    );
  } else {
    intent = { ...intent, requestId: outcome.requestId };
    if (outcome.status === "ambiguous") {
      intent = queueFailure(
        intent,
        "ambiguous",
        previous?.refusals ?? 0,
        previous?.queueFailures ?? 0,
        now,
        true,
      );
    }
  }
  record = { ...record, intent, updatedAt: now };
  if (!await writer.update([record])) {
    writer.actions.push(`${tag}:submission_state_unverified`);
    return { ready: false, submitted: true };
  }
  const after = await queue.surface.readPullMembership(pull);
  if (after.status !== "complete") {
    writer.actions.push(`${tag}:submission_membership_unavailable`);
    return { ready: false, submitted: true };
  }
  const entry = after.value.entry;
  if (
    entry !== null && queue.config.appActor !== null &&
    canonicalStringify(entry.enqueuer) ===
      canonicalStringify(queue.config.appActor) &&
    canonicalStringify(after.value.pull) === canonicalStringify(pull) &&
    entry.enqueuedAt >= Math.floor(intent.startedAt / 1000) * 1000 &&
    entry.enqueuedAt <= deps.clock.now()
  ) {
    record = {
      ...record,
      intent: { ...intent, resultId: entry.id },
      updatedAt: deps.clock.now(),
    };
    if (!await writer.update([record])) {
      return { ready: false, submitted: true };
    }
  }
  writer.actions.push(`${tag}:admission_${outcome.status}`);
  return { ready: true, submitted: outcome.status !== "not_submitted" };
}
