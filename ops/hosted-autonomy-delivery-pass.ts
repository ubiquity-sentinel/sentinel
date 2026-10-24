import { hasTakeoverCustody } from "../src/github/existing-pr-takeover-provenance.ts";
import type {
  PortResultV1,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { QUEUE_PROOF_ACTIVATED } from "../src/github/queue-runtime-policy.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import {
  type HostedDeliveryProof,
  resolveHostedDelivery,
  retainHostedDeliveryProvenance,
} from "./hosted-autonomy-delivery-proof.ts";
import { queueBookingDraft } from "./hosted-autonomy-queue-booking.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { ReleaseRequestV1 } from "../src/contracts/release.ts";
import { orderRecords } from "../src/state/state-records.ts";
import { failed, readRepairSafely, skipped } from "./hosted-autonomy-state.ts";
import {
  baseAndHeadAreMerged,
  boundReviewReceipts,
  buildHostedReleaseRequest,
  mergedExactlyOn,
  readTrustedTask,
} from "./hosted-autonomy-delivery.ts";
import {
  adoptableSpentMerge,
  carriedAuthorizingReceipt,
  carriedDeliveryAction,
  carriedMergeAction,
  carriedMergeAwaited,
  carriedMergeEvidence,
  carriedMergeGate,
  carriedMergeReceipt,
  carriedPatchRefusal,
  carriedRecordAwaited,
  carriedRequestBindsDelivery,
  HOSTED_AUTONOMY_SPENT_MOVED_BASE_MERGE,
  latestAuthorizingReceipt,
  parkedStep,
  preMergeGate,
  spentDelivered,
  spentDeliveryAdmissible,
  spentOnTip,
  spentReadWindow,
} from "./hosted-autonomy-spent-delivery.ts";
import {
  type HostedAutonomyPassContextV1,
  type HostedAutonomyScopeV1,
  hostedPassDeadlineReached,
} from "./hosted-autonomy-scopes.ts";
import {
  deliveryEligible,
  HOSTED_AUTONOMY_RETIRED,
  HOSTED_AUTONOMY_SELF_SCOPE,
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  hostedDeliveryKey,
  isHostedSelf,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyPullV1,
  HostedAutonomyRecordV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";
import {
  gatewayRequestBindsDelivery,
  isGatewayVpsRepository,
} from "../src/repair/vps-delivery.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";
import { REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX } from "../src/repair/review-round-cap.ts";
import { markBlocked } from "../src/repair/transitions.ts";
import { runHostedCiRerunPass } from "./hosted-autonomy-ci-rerun.ts";
import { ciFirstApprovalEligible } from "./hosted-autonomy-ci-first.ts";
import {
  acceptanceOwnerGateActions,
  acceptanceOwnerGated,
} from "./hosted-autonomy-acceptance.ts";

export async function runHostedDeliveryPass(
  context: HostedAutonomyPassContextV1,
): Promise<HostedAutonomyResultV1 | null> {
  const { deps, actions, revisions, scopeFor, readTip, readPull } = context;
  const { snapshot, observedHead } = context;
  if (deps.queueCustody?.ready === false) return null;
  const defer = () => {
    actions.push("continuation:delivery:deferred_deadline");
    return skipped("no_change", observedHead, actions);
  };
  if (hostedPassDeadlineReached(context)) return defer();
  const protectedRecord = (record: HostedAutonomyRecordV1) =>
    queueRecordProtected(record, deps.queueCustody);
  const strictGateway = (record: HostedAutonomyRecordV1) =>
    isGatewayVpsRepository(record.repository) &&
    (QUEUE_PROOF_ACTIVATED || deps.queueCustody?.proofActivated === true ||
      protectedRecord(record));
  // JAM B6b: a not-fulfilled acceptance no correction can follow is owner
  // gated. It is named once in the run summary and then neither approved,
  // read nor delivered (it used to report `spent_not_admissible` per pass).
  actions.push(
    ...acceptanceOwnerGateActions(snapshot, context.closedIssues),
  );
  // A record an earlier write of this pass touched waits for the next pass:
  // it is neither approved nor delivered here (nor re-run, see the module).
  const eligible = (record: (typeof snapshot.work)[number]) =>
    ((strictGateway(record) && record.nextStep !== "done") ||
      (deliveryEligible(record, snapshot) &&
        !acceptanceOwnerGated(record, snapshot, context.closedIssues))) &&
    context.settled?.has(record.id) !== true;
  // ---- check-approval pass ------------------------------------------------
  // A candidate pushed to a pull request by the bot produces a CI run that
  // GitHub parks for approval, so the deterministic check the merge requires
  // can never complete on its own. The job approves exactly those runs for the
  // exact reviewed head, on the record's OWN repository surface; the check
  // itself stays credential-free and unchanged. Under CI first a head's CI
  // must be green BEFORE its review, so a published head waiting at `work`
  // (or parked by the pre-review gate) is approved too.
  for (const record of snapshot.work) {
    if (hostedPassDeadlineReached(context)) return defer();
    if (protectedRecord(record)) continue;
    // Terminal source retirement and rejected unpublished candidates cannot
    // acquire approval authority. Ambiguous preservation intents stay eligible.
    const candidate = record.target.candidateState;
    if (
      record.nextStep === "blocked" && record.intent === null &&
      record.blocker?.kind === "other" &&
      (record.blocker.message === HOSTED_AUTONOMY_RETIRED ||
        (record.blocker.message === "candidate touches a protected path" &&
          candidate?.preserved === null &&
          record.target.head !== candidate.publishedHead))
    ) continue;
    if (
      !eligible(record) &&
      !(ciFirstApprovalEligible(snapshot, record) &&
        context.settled?.has(record.id) !== true)
    ) {
      continue;
    }
    const head = record.target.head;
    if (head === null || record.target.pr === null) continue;
    const scope = await scopeFor(record.repository);
    if (hostedPassDeadlineReached(context)) return defer();
    if (scope.surface === null) {
      actions.push(`approve:${record.id}:surface_unreadable`);
      continue;
    }
    let parked: number[] = [];
    try {
      parked = await scope.surface.listParkedRuns(head);
    } catch {
      parked = [];
    }
    for (const id of parked.slice(0, 3)) {
      if (hostedPassDeadlineReached(context)) return defer();
      let approved = false;
      try {
        approved = await scope.surface.approveRun(id);
      } catch {
        approved = false;
      }
      actions.push(
        `approve:${record.id}:run=${id}:${approved ? "approved" : "refused"}`,
      );
    }
  }
  if (hostedPassDeadlineReached(context)) return defer();
  // A clean-reviewed head parked on a failed CI run against its green,
  // current base gets that run re-run once (state-free; see the module).
  await runHostedCiRerunPass({
    ...context,
    settled: new Set([
      ...context.settled ?? [],
      ...snapshot.work.filter(protectedRecord).map((record) => record.id),
    ]),
  });

  if (hostedPassDeadlineReached(context)) return defer();
  // ---- delivery pass ------------------------------------------------------
  // Each repository's base tip is read once in this pass from that repository's
  // OWN surface. A missing tip or a missing default branch is an explicit skip,
  // never a guessed base, and never another repository's branch.
  const deliveryTips = new Map<string, string | null>();
  const deliveryTip = async (
    scope: HostedAutonomyScopeV1,
  ): Promise<string | null> => {
    if (hostedPassDeadlineReached(context)) return null;
    const cached = deliveryTips.get(scope.key);
    if (cached !== undefined) return cached;
    const tip = await readTip(scope);
    deliveryTips.set(scope.key, tip);
    return tip;
  };
  // Verified merge facts for FOREIGN records delivered in this pass, keyed by
  // exact repository/pull/head/base. The closure pass owns the actual closure
  // and consumes these only as the evidence it re-checks below.
  const foreignMerged = context.foreignMerged;

  // The self scope keeps its exact pre-existing refusal: once sentinel has a
  // record to deliver, an unreadable `development` tip stops the pass before
  // any delivery, exactly as it always did. A foreign-only snapshot never
  // reads the self scope at all.
  if (
    snapshot.work.some((record) =>
      eligible(record) && isHostedSelf(record.repository)
    )
  ) {
    const selfTip = await deliveryTip(
      await scopeFor(HOSTED_AUTONOMY_SELF_SCOPE),
    );
    if (hostedPassDeadlineReached(context)) return defer();
    if (selfTip === null) {
      return actions.length > 0
        ? skipped("retried", observedHead, actions)
        : skipped("base_moved", observedHead, actions);
    }
  }

  // Spent-round records parked in `work`/`blocked` need live reads before
  // the spent gates can refuse them; at most a fixed number are read per
  // pass, starting at an offset that rotates with the pass clock so no record
  // is starved by the ones ordered before it.
  // A record an earlier write of this pass settled takes no read slot.
  // #156 (6): the tip of each repository with a spent record reviewed on its
  // own head is read once (cached for the gates), before the window; a
  // record whose base is not that tip (D3 off) can only end `base_moved`, so
  // it is left out and only its pull request is read, for the lost write of
  // a merge that moved the tip itself (`behindTip`).
  const spentCandidates = spentReadWindow(
    snapshot,
    deps.clock.now(),
    context.settled,
  );
  const spentTips = new Map<string, string | null>();
  for (const record of snapshot.work) {
    if (
      !spentCandidates.has(record.id) || !eligible(record) ||
      strictGateway(record) ||
      boundReviewReceipts(snapshot, record).length === 0
    ) continue;
    spentTips.set(
      record.id,
      await deliveryTip(await scopeFor(record.repository)),
    );
    if (hostedPassDeadlineReached(context)) return defer();
  }
  const movedBaseMerge = deps.spentMovedBaseMerge ??
    HOSTED_AUTONOMY_SPENT_MOVED_BASE_MERGE;
  const spentReadable = spentReadWindow(
    snapshot,
    deps.clock.now(),
    context.settled,
    (record) =>
      spentOnTip(record, spentTips.get(record.id) ?? null, movedBaseMerge),
  );
  const behindTip = new Set(
    [...spentCandidates].filter((id) => !spentReadable.has(id)),
  );
  // The tip's own CI, read at most once per repository per pass (a2).
  const tipGreen = new Map<string, boolean>();
  // Set as soon as `surface.merge` is called, whatever it answers (merged,
  // refused, lost, thrown): that merge may have landed, so the base tip and
  // the tip CI read above are stale and every later gate would admit a merge
  // onto a commit whose CI was never checked. No further merge is attempted
  // in this pass; an already-merged pull is still settled read-only.
  let mergeCalled = false;

  for (const record of snapshot.work) {
    if (hostedPassDeadlineReached(context)) return defer();
    if (!eligible(record)) continue;
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    let mergedThisRecord = false;
    // The tip re-read immediately before this pass's merge call (#156).
    let mergedOnto: string | null = null;
    if (pullRequest === null || head === null || base === null) continue;
    if (strictGateway(record)) {
      const booking = await queueBookingDraft(context, record);
      if (hostedPassDeadlineReached(context)) return defer();
      if (booking !== null) {
        return await writeDeliveryState(
          context,
          booking.snapshot,
          `request:${record.id}:${booking.requestId}`,
          booking.revision,
        );
      }
      continue;
    }
    // A record outside the runtime's own review/delivery steps is merged only
    // under the closed spent shape; nothing else about it is read.
    const parked = parkedStep(record);
    if (parked && !spentDeliveryAdmissible(record, snapshot)) {
      actions.push(`delivery:${record.id}:spent_not_admissible`);
      continue;
    }
    // A refreshed head merged under its carried review is delivered
    // bookkeeping already: its proof is reported, nothing is read.
    const carriedDone = carriedDeliveryAction(snapshot, record);
    if (carriedDone !== null) {
      actions.push(carriedDone);
      continue;
    }
    // The exact receipts bound to this delivery identity decide whether the
    // candidate is even a delivery candidate. A record without one changes
    // nothing and is reported exactly as before, without an extra read,
    // unless it is a spent record's mechanically refreshed head that may
    // carry its earlier review (option (b), `carriedMergeGate`).
    const carried = boundReviewReceipts(snapshot, record).length === 0;
    if (carried && carriedMergeReceipt(snapshot, record) === null) continue;
    // The runtime proves the carried patch from git and the refreshed head's
    // green CI, then holds the exact carried-merge marker for this merge; a
    // merged pull it waits on (`unavailable`) is adopted. Anything else is
    // still the runtime's.
    if (carried && !carriedRecordAwaited(record)) {
      actions.push(`delivery:${record.id}:carried_awaiting_runtime`);
      continue;
    }
    if (
      parked && !spentReadable.has(record.id) && !behindTip.has(record.id)
    ) {
      actions.push(`delivery:${record.id}:spent_deferred`);
      continue;
    }
    const scope = await scopeFor(record.repository);
    if (hostedPassDeadlineReached(context)) return defer();
    // #156 (3, 6): a record this pass can only adopt, never merge (a carried
    // head the runtime waits on with `unavailable`, which may precede any
    // merge, or a spent record behind the tip), reads its pull request first
    // and nothing else unless that pull request is already merged.
    const onlyAdoptable = carried && !carriedMergeAwaited(record)
      ? "carried_awaiting_runtime"
      : behindTip.has(record.id)
      ? "base_moved"
      : null;
    let prefetched: HostedAutonomyPullV1 | null = null;
    if (
      onlyAdoptable !== null && scope.surface !== null &&
      scope.baseBranch !== null
    ) {
      prefetched = await readPull(scope, pullRequest);
      if (hostedPassDeadlineReached(context)) return defer();
      if (prefetched === null || prefetched.headSha !== head) continue;
      if (prefetched.merged !== true) {
        actions.push(`delivery:${record.id}:${onlyAdoptable}`);
        continue;
      }
    }
    // The trusted live source-issue statement is read over the record's OWN
    // authenticated surface immediately before the merge and the release
    // request; the shared predicate then binds the LATEST completed review's
    // acceptance to that exact text. A later P0/P1 on the same head, a legacy
    // quality-only receipt, a wrong-task digest or an unreadable context
    // refuses here, before any external effect.
    const authorize = carried
      ? carriedAuthorizingReceipt
      : latestAuthorizingReceipt;
    const verdict = authorize(
      snapshot,
      record,
      await readTrustedTask(scope.surface, record),
    );
    if (hostedPassDeadlineReached(context)) return defer();
    if (verdict.kind !== "authorized") {
      actions.push(
        `delivery:${record.id}:${
          verdict.kind === "blocking"
            ? "latest_review_blocking"
            : "task_acceptance_refused"
        }`,
      );
      continue;
    }
    let receipt = verdict.receipt;
    const self = isHostedSelf(record.repository);
    const gateway = isGatewayVpsRepository(record.repository);
    if (
      (self || gateway) &&
      snapshot.releaseRequests.some((request) =>
        sameRepository(request.target.repository, record.repository) &&
        request.source.pullRequest === pullRequest &&
        request.source.head === head && request.source.base === base &&
        request.target.environment === "production"
      )
    ) {
      actions.push(`delivery:${record.id}:already_recorded`);
      continue;
    }
    if (scope.surface === null) {
      actions.push(`delivery:${record.id}:surface_unreadable`);
      continue;
    }
    if (scope.baseBranch === null) {
      actions.push(`delivery:${record.id}:default_branch_unreadable`);
      continue;
    }
    let pull = prefetched ?? await readPull(scope, pullRequest);
    if (hostedPassDeadlineReached(context)) return defer();
    if (pull === null || pull.headSha !== head) continue;
    if (
      typeof pull.author !== "string" ||
      (!(hasTakeoverCustody(record) && !self && pull.merged) &&
        !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author))
    ) {
      actions.push(`delivery:${record.id}:foreign_author`);
      continue;
    }

    let revision: string | null = null;
    let foreignProof: HostedDeliveryProof | null = null;
    if (!self && pull.merged) {
      foreignProof = await resolveHostedDelivery(
        context,
        record,
        scope,
        pull,
        parked ? "adoption" : "delivery",
      );
      if (hostedPassDeadlineReached(context)) return defer();
    }
    // True when this record is merged (or adopted) under the spent rule: a
    // parked record always, a review/delivery record only onto a moved base.
    let spentMerge = parked;
    if (pull.state === "open" && pull.merged === false) {
      if (hasTakeoverCustody(record)) {
        actions.push(
          `delivery:${record.id}:existing_pr_requires_repair_principal`,
        );
        continue;
      }
      if (gateway && deps.queueCustody?.ready !== true) {
        actions.push(`delivery:${record.id}:queue_context_unavailable`);
        continue;
      }
      if (mergeCalled) {
        actions.push(`delivery:${record.id}:merge_deferred`);
        continue;
      }
      if (carried && !carriedMergeAwaited(record)) {
        actions.push(`delivery:${record.id}:carried_awaiting_runtime`);
        continue;
      }
      // The base must be exactly the reviewed base (except for the moved-base
      // rule of a spent Gateway record), the spent gates must hold, and the
      // required CI must be green on the exact head (and, onto a moved base,
      // on the tip it lands on). A carried merge has its own gate: the exact
      // tip its refreshed head contains, that head's own green CI and the
      // patch proof (`carriedMergeGate`).
      const baseTip = await deliveryTip(scope);
      if (hostedPassDeadlineReached(context)) return defer();
      if (baseTip === null) {
        actions.push(`delivery:${record.id}:base_unreadable`);
        continue;
      }
      let evidence: string | undefined;
      let proofLine: string | null = null;
      if (carried) {
        const gate = await carriedMergeGate({
          context,
          scope,
          record,
          receipt,
          pull,
          baseTip,
        });
        if (gate.refusal === "clock_invalid") {
          return skipped("clock_invalid", observedHead, actions);
        }
        if (gate.refusal !== null || gate.proof === null) {
          actions.push(`delivery:${record.id}:${gate.refusal}`);
          continue;
        }
        evidence = carriedMergeEvidence(gate.proof);
        proofLine = carriedMergeAction(record, gate.proof);
        spentMerge = true;
      } else {
        const gate = await preMergeGate({
          context,
          scope,
          record,
          receipt,
          pull,
          baseTip,
          tipGreen,
        });
        if (gate.refusal === "clock_invalid") {
          return skipped("clock_invalid", observedHead, actions);
        }
        if (gate.refusal !== null) {
          actions.push(`delivery:${record.id}:${gate.refusal}`);
          continue;
        }
        spentMerge = gate.spent;
      }
      if (hostedPassDeadlineReached(context)) return defer();
      // One more trusted source-issue read immediately before the external
      // merge: issue text that drifted while the other gates were read is a
      // different task and never authorizes this merge.
      const reread = authorize(
        snapshot,
        record,
        await readTrustedTask(scope.surface, record),
      );
      if (hostedPassDeadlineReached(context)) return defer();
      if (reread.kind !== "authorized" || reread.receipt.id !== receipt.id) {
        actions.push(`delivery:${record.id}:task_acceptance_refused`);
        continue;
      }
      if (gateway) {
        let optedOut: boolean | null = null;
        try {
          optedOut = await scope.surface.readIssueOptedOut?.(
            record.related.issueNumber!,
          ) ?? null;
        } catch { /* current source must remain eligible */ }
        if (record.related.issueNumber !== null && optedOut !== false) {
          actions.push(`delivery:${record.id}:task_acceptance_refused`);
          continue;
        }
      }
      if (hostedPassDeadlineReached(context)) return defer();
      // The tip is re-read UNCACHED as the last read before the merge (round-2
      // recheck P3): the gates above read it once, before up to a dozen
      // reads, and GitHub's merge API guards only the head, so a tip that
      // moved meanwhile would merge a tree no CI ran on. A carried merge needs
      // exactly its refreshed head's base; any other merge the tip its gates
      // admitted. A moved tip refreshes this pass's view and merges nothing.
      const tipNow = await readTip(scope);
      if (hostedPassDeadlineReached(context)) return defer();
      if (tipNow !== (carried ? base : baseTip)) {
        deliveryTips.set(scope.key, tipNow);
        tipGreen.delete(scope.key);
        actions.push(
          `delivery:${record.id}:${
            tipNow === null
              ? "base_unreadable"
              : carried
              ? "carried_base_moved"
              : "base_moved"
          }`,
        );
        continue;
      }
      if (proofLine !== null) actions.push(proofLine);
      let merged: { merged: boolean; sha: string | null } | null;
      mergeCalled = true;
      // Once admitted, preserve the existing merge verification/bookkeeping
      // settlement even if the cutoff is crossed inside the effect.
      mergedThisRecord = true;
      mergedOnto = tipNow;
      try {
        merged = evidence === undefined
          ? await scope.surface.merge(pullRequest, head)
          : await scope.surface.merge(pullRequest, head, evidence);
      } catch {
        merged = null;
      }
      if (merged === null) {
        actions.push(`delivery:${record.id}:merge_refused`);
        continue;
      }
      if (merged.merged !== true || merged.sha === null) {
        actions.push(`delivery:${record.id}:merge_not_observed`);
        continue;
      }
      revision = merged.sha;
      actions.push(`merge:${record.id}:pr=${pullRequest}:sha=${revision}`);
      const after = await readPull(scope, pullRequest);
      if (after === null) continue;
      pull = after;
    } else if (parked && pull.merged === true) {
      // Crash window: the merge succeeded but its state write was lost. Only
      // the App's own verified merge with green required CI on the exact head
      // is adopted (a carried one only with its patch proof); a hand merge is
      // reported and nothing is recorded. A carried merge off its tip is
      // reported (and parked) below on its parents alone, so the expensive
      // patch proof is read only for one that landed exactly on T (#156).
      if (
        (!self && foreignProof === null) ||
        !await adoptableSpentMerge(
          scope.surface,
          pull,
          self,
          head,
        ) ||
        (carried &&
          (foreignProof?.kind === "queue" ||
            mergedExactlyOn(pull, base, head)) &&
          (await carriedPatchRefusal(scope.surface, receipt, head, base))
              .refusal !== null)
      ) {
        actions.push(`delivery:${record.id}:merged_outside_trusted_path`);
        continue;
      }
    }
    if (carried && !self && !gateway) {
      actions.push(`delivery:${record.id}:carried_unsupported`);
      continue;
    }
    if (!mergedThisRecord && hostedPassDeadlineReached(context)) return defer();
    if (pull.merged !== true || pull.mergeCommitSha === null) continue;
    // #156 (1): a merge THIS pass made is booked only when its commit's
    // parents are exactly [the tip re-read immediately before the call, the
    // head]. GitHub has no compare-and-swap on the base, so a commit that
    // landed meanwhile (an owner merge) makes the merge a tree no CI ran on:
    // it is reported and nothing is written. (A carried merge parks below.)
    if (
      mergedOnto !== null && !carried && pull.mergeCommitSha === revision &&
      !mergedExactlyOn(pull, mergedOnto, head)
    ) {
      actions.push(`delivery:${record.id}:merged_off_tip:sha=${revision}`);
      continue;
    }
    // The same refusal is durable across passes: an App-made merge of a
    // non-carried record is booked only on exactly [its reviewed base, its
    // head], so a later pass never adopts a refused off-tip merge as an
    // outside merge (review finding, upheld 3 of 3). A queue merge has the
    // queue's parents and keeps its own proof; an owner's merge is not the
    // App's. With the moved-base merge rule (D3) on, an App merge onto a
    // moved tip is intended, so only the same-pass check above applies.
    if (
      !movedBaseMerge && !carried && foreignProof?.kind !== "queue" &&
      pull.mergedBy === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR &&
      (base === null || !mergedExactlyOn(pull, base, head))
    ) {
      actions.push(
        `delivery:${record.id}:merged_off_tip:sha=${pull.mergeCommitSha}`,
      );
      continue;
    }
    if (!self) {
      foreignProof ??= await resolveHostedDelivery(
        context,
        record,
        scope,
        pull,
        "delivery",
        revision,
      );
      if (foreignProof === null) {
        actions.push(
          `delivery:${record.id}:${
            gateway ? "merge_proof_unavailable" : "merge_not_observed"
          }`,
        );
        continue;
      }
      receipt = foreignProof.receipt;
    }
    // A merge performed earlier in THIS pass is an external write and keeps
    // the one-merge bound; an already-merged pull is read-only.
    if (revision === null) revision = pull.mergeCommitSha;
    if (revision !== pull.mergeCommitSha) continue;
    // A carried merge is booked only when it landed exactly on the refreshed
    // head's own base, so the merged tree is the one its CI tested. A merge
    // that landed off that tip (the tip moved between the re-read and the
    // merge) is reported and, on the Gateway, parked precisely instead.
    if (
      carried && foreignProof?.kind !== "queue" &&
      !mergedExactlyOn(pull, base, head)
    ) {
      actions.push(
        `delivery:${record.id}:carried_merged_off_tip:sha=${revision}`,
      );
      // A self record is never rewritten here: its runtime reads the merge
      // commit's parents itself and parks it with the same blocker (#156).
      if (!gateway) continue;
      const now = deps.clock.now();
      if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
        return skipped("clock_invalid", observedHead, actions);
      }
      let parkedRecord: HostedAutonomyRecordV1;
      try {
        parkedRecord = markBlocked(
          record,
          "other",
          `${REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX}merge ${revision} has parents ${
            pull.parents.join(",") || "none"
          }, not ${base},${head}`,
          now,
        );
      } catch {
        return skipped("snapshot_invalid", observedHead, actions);
      }
      return await writeDeliveryState(
        context,
        {
          ...snapshot,
          stateHead: observedHead,
          sequence: snapshot.sequence + 1,
          updatedAt: now,
          work: snapshot.work.map((item) =>
            item.id === record.id ? parkedRecord : item
          ),
        },
        `park:${record.id}:carried_merged_off_tip`,
        null,
      );
    }
    if (
      self &&
      (!baseAndHeadAreMerged(pull, base, head) || !pull.revisionOnBaseBranch)
    ) {
      actions.push(`delivery:${record.id}:merge_not_observed`);
      continue;
    }

    if (!self && !gateway) {
      // A foreign repository has no sentinel release authority: nothing is
      // recorded and no release is invented. The verified merge facts are
      // handed to the closure pass, which closes the record's OWN issue from
      // exactly this evidence.
      const evidence = foreignProof;
      if (evidence === null) {
        actions.push(`delivery:${record.id}:merge_not_observed`);
        continue;
      }
      foreignMerged.set(
        hostedDeliveryKey(record.repository, pullRequest, head, base),
        evidence,
      );
      actions.push(`delivery:${record.id}:foreign_merged`);
      revisions.push(revision);
      // The direct effect cap only stops another merge. Already-merged queue
      // deliveries can still be booked after this external merge.
      continue;
    }

    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    const request = await buildHostedReleaseRequest(
      record.repository,
      revision,
      head,
      base,
      pullRequest,
      receipt,
      now,
    );
    if (!mergedThisRecord && hostedPassDeadlineReached(context)) return defer();
    if (request === null) {
      return skipped("snapshot_invalid", observedHead, actions);
    }
    if (gateway && record.related.issueNumber !== null) {
      let optedOut: boolean | null = null;
      try {
        optedOut =
          await scope.surface.readIssueOptedOut?.(record.related.issueNumber) ??
            null;
      } catch { /* unavailable source cannot authorize a request */ }
      if (optedOut !== false) {
        actions.push(`delivery:${record.id}:task_acceptance_refused`);
        continue;
      }
    }
    if (!mergedThisRecord && hostedPassDeadlineReached(context)) return defer();
    // A spent Gateway record moves to `delivery` with the runtime's own
    // transition (blocker and wait cleared; counters, evidence, intent and
    // target unchanged); a record merged from review/delivery at its exact
    // base keeps today's write byte for byte. A self record is never
    // rewritten here. The binding and duplicate checks run against the
    // record exactly as it is written.
    let delivered: HostedAutonomyRecordV1 = record;
    if (gateway) {
      const retained = foreignProof === null
        ? null
        : retainHostedDeliveryProvenance(record, foreignProof);
      if (retained === null) continue;
      const advanced = spentMerge
        ? spentDelivered(retained, now)
        : { ...retained, nextStep: "delivery" as const, updatedAt: now };
      if (advanced === null) {
        return skipped("snapshot_invalid", observedHead, actions);
      }
      delivered = advanced;
    }
    if (
      gateway &&
      (!await (carried
        ? carriedRequestBindsDelivery
        : gatewayRequestBindsDelivery)(
          request,
          delivered,
          receipt,
          revision,
        ) ||
        snapshot.releaseRequests.some((existing) =>
          existing.id === request.id ||
          releaseRequestMatchesDelivery(existing, record)
        ))
    ) {
      actions.push(`delivery:${record.id}:already_recorded`);
      continue;
    }
    if (!mergedThisRecord && hostedPassDeadlineReached(context)) return defer();
    return await writeDeliveryState(
      context,
      {
        ...snapshot,
        stateHead: observedHead,
        sequence: snapshot.sequence + 1,
        updatedAt: now,
        work: gateway
          ? snapshot.work.map((item) =>
            item.id === record.id ? delivered : item
          )
          : snapshot.work,
        // The store reads records back ordered by id; build the written list
        // with its exact comparator so the readback below compares equal.
        releaseRequests: orderRecords<ReleaseRequestV1>(
          [...snapshot.releaseRequests, request].map((row) => ({
            id: row.id,
            value: row,
          })),
        ),
      },
      `request:${record.id}:${request.id}`,
      revision,
    );
  }

  return null;
}

/**
 * The delivery pass's one state write (a booked delivery, or the precise park
 * of a carried merge that landed off its tip): parsed, written against the
 * observed head and read back byte for byte; `done` is reported once it is.
 */
async function writeDeliveryState(
  context: HostedAutonomyPassContextV1,
  draft: unknown,
  done: string,
  revision: string | null,
): Promise<HostedAutonomyResultV1> {
  const { deps, actions, revisions, observedHead } = context;
  let next: RepairStateSnapshotV1;
  try {
    next = parseRepairStateSnapshotV1(draft);
  } catch {
    return skipped("snapshot_invalid", observedHead, actions);
  }
  let write: PortResultV1<StateWriteResultV1> | null;
  try {
    write = await deps.state.writeRepair(next, observedHead as GitSha);
  } catch {
    return failed("write_unavailable", observedHead, actions);
  }
  if (write === null || !write.ok) {
    return failed("write_unavailable", observedHead, actions);
  }
  if (write.value.status === "conflict") {
    return skipped("write_conflict", observedHead, actions);
  }
  if (write.value.status === "ambiguous") {
    return failed("write_ambiguous", observedHead, actions);
  }
  const readback = await readRepairSafely(deps.state);
  if (
    readback === null || !readback.ok ||
    readback.value.status !== "found" ||
    readback.value.head !== write.value.head ||
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) {
    return failed("readback_unverified", observedHead, actions);
  }
  actions.push(done);
  if (revision !== null) revisions.push(revision);
  return {
    kind: "hosted_autonomy",
    status: "applied",
    reason: actions.some((action) => action.startsWith("retry:"))
      ? "retried"
      : "applied",
    beforeHead: observedHead,
    appliedHead: write.value.head,
    actions,
    revisions,
  };
}
