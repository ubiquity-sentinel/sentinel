import type {
  PortResultV1,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { ReviewTaskStatementV1 } from "../src/contracts/review-receipt.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { failed, readRepairSafely, skipped } from "./hosted-autonomy-state.ts";
import {
  historicalMergedPublication,
  readTrustedTask,
} from "./hosted-autonomy-delivery.ts";
import {
  releaseAuthorizingReceipt,
  treeCarriedReleaseProver,
} from "./hosted-autonomy-carried-release.ts";
import {
  hostedDeliveryProofMatches,
  resolveHostedDelivery,
  retainHostedDeliveryProvenance,
} from "./hosted-autonomy-delivery-proof.ts";
import { hasQueueIntentNamespace } from "./hosted-autonomy-queue-policy.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import { intentClosable } from "./hosted-autonomy-retries.ts";
import {
  acceptedReleases,
  applyHostedClosures,
  applyHostedRetirements,
  planHostedClosures,
  planHostedRetirements,
} from "./hosted-autonomy-closures.ts";
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  hostedDeliveryKey,
  hostedIssueKey,
  isHostedSelf,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyRecordV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";
import {
  carriedGatewayRequestBindsDelivery,
  gatewayClosureIntentBindsRequest,
  gatewayReleaseDeferred,
  gatewayRequestBindsDelivery,
  isGatewayVpsRepository,
  observeGatewayVpsDelivery,
} from "../src/repair/vps-delivery.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";
import { releaseRequestReceipt } from "../src/repair/loop-task-context.ts";
import { markBlocked, setIntent } from "../src/repair/transitions.ts";
import { closureIntentKey } from "../src/repair/keys.ts";
import { parseRepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";

/** Gateway merge evidence alone never enters the foreign closure authority. */
async function gatewayClosureGate(
  context: HostedAutonomyPassContextV1,
  record: HostedAutonomyRecordV1,
  revision: string,
): Promise<"accepted" | "wait" | { blocked: string }> {
  const scope = await context.scopeFor(record.repository);
  const pull = record.target.pr === null
    ? null
    : await context.readPull(scope, record.target.pr);
  const proof = await resolveHostedDelivery(
    context,
    record,
    scope,
    pull,
    "closure",
    revision,
  );
  if (proof === null) return "wait";
  const requests = context.snapshot.releaseRequests.filter((request) =>
    releaseRequestMatchesDelivery(request, record)
  );
  if (requests.length !== 1) return "wait";
  const request = requests[0];
  const referenced = releaseRequestReceipt(context.snapshot.reviews, request);
  if (
    referenced === null || referenced.id !== proof.reviewReceiptId ||
    request.source.reviewRequestId !== proof.reviewRequestId
  ) return "wait";
  // A carried request (Sentinel #152) binds only while the exact tree proof,
  // re-derived once in this pass, holds.
  const carried = treeCarriedReleaseProver(context, scope.surface, referenced);
  if (
    !await gatewayRequestBindsDelivery(request, record, referenced, revision) &&
    !await carriedGatewayRequestBindsDelivery(
      request,
      record,
      referenced,
      carried,
      revision,
    )
  ) return "wait";
  let optedOut: boolean | null = null;
  try {
    optedOut =
      await scope.surface?.readIssueOptedOut?.(record.related.issueNumber!) ??
        null;
  } catch { /* missing current source evidence refuses */ }
  if (record.related.issueNumber === null || optedOut !== false) return "wait";
  const authorized = releaseAuthorizingReceipt(
    { ...context.snapshot, reviews: [referenced] },
    record,
    await readTrustedTask(scope.surface, record),
  );
  if (authorized === null) return "wait";
  const accepted = await observeGatewayVpsDelivery(
    context.deps.state,
    record,
    request,
    authorized,
    carried,
  );
  return accepted.kind === "blocked"
    ? { blocked: accepted.reason }
    : accepted.kind;
}

async function persistGatewayDelivery(
  context: HostedAutonomyPassContextV1,
  record: HostedAutonomyRecordV1,
): Promise<HostedAutonomyResultV1> {
  const { deps, snapshot, observedHead, actions, revisions } = context;
  const now = deps.clock.now();
  if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
    return skipped("clock_invalid", observedHead, actions);
  }
  const next = parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: observedHead,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((item) => item.id === record.id ? record : item),
  });
  let write;
  try {
    write = await deps.state.writeRepair(next, observedHead as GitSha);
  } catch {
    return failed("write_unavailable", observedHead, actions);
  }
  if (!write.ok) return failed("write_unavailable", observedHead, actions);
  if (write.value.status === "conflict") {
    return skipped("write_conflict", observedHead, actions);
  }
  if (write.value.status === "ambiguous") {
    return failed("write_ambiguous", observedHead, actions);
  }
  const readback = await readRepairSafely(deps.state);
  if (
    readback === null || !readback.ok || readback.value.status !== "found" ||
    readback.value.head !== write.value.head ||
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) return failed("readback_unverified", observedHead, actions);
  return {
    kind: "hosted_autonomy",
    status: "applied",
    reason: "applied",
    beforeHead: observedHead,
    appliedHead: write.value.head,
    actions,
    revisions,
  };
}

function blockGatewayDelivery(
  context: HostedAutonomyPassContextV1,
  record: HostedAutonomyRecordV1,
  reason: string,
) {
  context.actions.push(`delivery:${record.id}:release_blocked`);
  if (queueRecordProtected(record, context.deps.queueCustody)) return null;
  return persistGatewayDelivery(
    context,
    markBlocked(record, "other", reason, context.deps.clock.now()),
  );
}

/**
 * Merged; release deferred while the release path is disabled (JAM B12): a
 * Gateway delivery with no intent whose one open production request the
 * release ref does not record. `gatewayClosureGate` could only answer `wait`
 * for it (`observeGatewayVpsDelivery` finds no VPS release record), so no
 * source, pull or release read is spent on it. The decision reads only the
 * repair and release snapshots this pass already holds and never the
 * record's wait, so it holds for every runtime generation's record shape, and
 * the full gate runs again on the first pass after the release ref records
 * the request (accepted, failed or rolled back alike).
 */
function gatewayReleaseDeferredIn(
  context: HostedAutonomyPassContextV1,
  record: HostedAutonomyRecordV1,
): boolean {
  if (
    !isGatewayVpsRepository(record.repository) ||
    record.nextStep !== "delivery" || record.intent !== null
  ) return false;
  const requests = context.snapshot.releaseRequests.filter((request) =>
    releaseRequestMatchesDelivery(request, record)
  );
  return requests.length === 1 &&
    gatewayReleaseDeferred(context.releaseSnapshot, requests[0]);
}

function gatewayIntentClosable(
  context: HostedAutonomyPassContextV1,
  record: HostedAutonomyRecordV1,
): boolean {
  // Candidate eligibility only: every gateway closure still needs fresh proof.
  return hasQueueIntentNamespace(record) ||
    intentClosable(record, context.snapshot.reservations) ||
    (isGatewayVpsRepository(record.repository) &&
      context.snapshot.releaseRequests.some((request) =>
        releaseRequestMatchesDelivery(request, record) &&
        gatewayClosureIntentBindsRequest(record, request)
      ));
}

export async function runHostedClosurePass(
  context: HostedAutonomyPassContextV1,
  deliveryOnly = false,
): Promise<HostedAutonomyResultV1 | null> {
  const { deps, actions, revisions, scopeFor, readPull } = context;
  if (deps.queueCustody?.ready === false) return null;
  let { snapshot, observedHead } = context;
  const { closedIssues, foreignMerged } = context;
  // A record an earlier write of this pass touched waits for the next pass.
  const settled = (id: string) => context.settled?.has(id) === true;
  // ---- closure pass -------------------------------------------------------
  const released = acceptedReleases(context.releaseSnapshot.hostedReleases);
  if (deliveryOnly) {
    let ready = false;
    let releaseDeferred = 0;
    for (const record of snapshot.work) {
      if (record.nextStep !== "delivery" || settled(record.id)) continue;
      const { pr, head, base } = record.target;
      if (
        record.related.issueNumber === null || pr === null || head === null ||
        base === null
      ) continue;
      if (!gatewayIntentClosable(context, record)) continue;
      if (gatewayReleaseDeferredIn(context, record)) {
        releaseDeferred++;
        continue;
      }
      const scope = await scopeFor(record.repository);
      if (
        releaseAuthorizingReceipt(
          snapshot,
          record,
          await readTrustedTask(scope.surface, record),
        ) === null
      ) continue;
      const key = hostedDeliveryKey(record.repository, pr, head, base);
      if (isHostedSelf(record.repository)) {
        if (released.has(key)) ready = true;
        continue;
      }
      const pull = await readPull(scope, pr);
      if (pull === null) continue;
      const evidence = await resolveHostedDelivery(
        context,
        record,
        scope,
        pull,
        "closure",
      );
      if (evidence === null) continue;
      if (isGatewayVpsRepository(record.repository)) {
        const gate = await gatewayClosureGate(
          context,
          record,
          evidence.revision,
        );
        if (typeof gate === "object") {
          return blockGatewayDelivery(context, record, gate.blocked);
        }
        if (gate !== "accepted") {
          actions.push(`delivery:${record.id}:release_unavailable`);
          continue;
        }
      }
      foreignMerged.set(key, evidence);
      actions.push(`delivery:${record.id}:foreign_merged`);
      revisions.push(evidence.revision);
      ready = true;
    }
    // One counted, owner-visible line per pass instead of one
    // `release_unavailable` line per merged record: `disabled` while the
    // release ref holds no VPS release record at all, `queued` once the
    // enabled release controller has records but not yet these requests.
    if (releaseDeferred > 0) {
      const path = (context.releaseSnapshot.vpsReleases ?? []).length === 0
        ? "disabled"
        : "queued";
      actions.push(
        `release-deferred:count=${releaseDeferred}:release_path=${path}`,
      );
    }
    // An open pull still needs the ordinary delivery pass before retirement;
    // only already-proven delivery bookkeeping may preempt unrelated retries.
    if (!ready) return null;
  }
  // A record whose source issue is closed and whose own pull request is
  // definitively closed without a merge can never deliver, whatever step it is
  // parked at. That verdict requires the read to succeed and the pull to be
  // neither merged nor open; a failed or empty read is not evidence and leaves
  // the record alone.
  const closedUnmerged = new Set<string>();
  for (const record of snapshot.work) {
    if (
      record.nextStep === "done" ||
      queueRecordProtected(record, deps.queueCustody)
    ) continue;
    const issueNumber = record.related.issueNumber;
    if (
      issueNumber === null ||
      !closedIssues.has(hostedIssueKey(record.repository, issueNumber))
    ) {
      continue;
    }
    const pullRequest = record.target.pr;
    if (pullRequest === null) continue;
    // Its release request was recorded only once its pull request merged, so
    // a deferred release is never closed unmerged: nothing to read.
    if (gatewayReleaseDeferredIn(context, record)) continue;
    const scope = await scopeFor(record.repository);
    const pull = await readPull(scope, pullRequest);
    if (pull === null) continue;
    if (pull.merged !== true && pull.state !== "open") {
      closedUnmerged.add(record.id);
    }
  }
  const retirements = planHostedRetirements(
    snapshot,
    closedIssues,
    closedUnmerged,
    deps.queueCustody,
  ).filter((plan) => !settled(plan.id));
  let retirementResult: HostedAutonomyResultV1 | null = null;
  if (retirements.length > 0) {
    const now = deps.clock.now();
    if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
      return skipped("clock_invalid", observedHead, actions);
    }
    let next: RepairStateSnapshotV1;
    try {
      next = applyHostedRetirements(
        snapshot,
        observedHead as GitSha,
        retirements,
        now,
      );
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
    for (const plan of retirements) {
      actions.push(`retire:${plan.id}:issue=${plan.issueNumber}`);
    }
    retirementResult = {
      kind: "hosted_autonomy",
      status: "applied",
      reason: "retired_records",
      beforeHead: observedHead,
      appliedHead: write.value.head,
      actions,
      revisions,
    };
    snapshot = readback.value.snapshot;
    observedHead = readback.value.head;
    context.snapshot = snapshot;
    context.observedHead = observedHead;
  }
  // A foreign record's delivery evidence is its OWN merged pull request: the
  // trusted release path is bound to the self scope by design and can never
  // authorize a foreign repository, so no release is ever fabricated for one.
  // The exact facts are re-read here for every foreign record with an
  // authorizing receipt; the ones the delivery pass verified in this same run
  // are already present and are not read twice.
  const recovered = new Map<string, HostedAutonomyRecordV1>();
  for (const original of snapshot.work) {
    if (deliveryOnly && original.nextStep !== "delivery") continue;
    if (settled(original.id)) continue;
    const record = await historicalMergedPublication(snapshot, original) ??
      original;
    if (record !== original) recovered.set(record.id, record);
    if (record.nextStep === "done") continue;
    if (isHostedSelf(record.repository)) continue;
    if (
      isGatewayVpsRepository(record.repository) &&
      record.nextStep !== "delivery"
    ) continue;
    const issueNumber = record.related.issueNumber;
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    if (
      issueNumber === null || pullRequest === null || head === null ||
      base === null
    ) {
      continue;
    }
    // Counted once by the delivery-only pass; nothing is read for it here.
    if (gatewayReleaseDeferredIn(context, record)) continue;
    const key = hostedDeliveryKey(record.repository, pullRequest, head, base);
    // A prior capability is revalidated below against the fresh task and exact row.
    const scope = await scopeFor(record.repository);
    // The same trusted, immediately-preceding source-issue read authorizes the
    // merge evidence this closure will consume, exactly as it did the merge.
    if (
      releaseAuthorizingReceipt(
        snapshot,
        record,
        await readTrustedTask(scope.surface, record),
      ) === null
    ) {
      continue;
    }
    const pull = await readPull(scope, pullRequest);
    if (pull === null) continue;
    if (
      recovered.has(record.id) && (
        pull.number !== pullRequest ||
        pull.author !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
        pull.mergedBy !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR
      )
    ) continue;
    const evidence = await resolveHostedDelivery(
      context,
      record,
      scope,
      pull,
      recovered.has(record.id) ? "adoption" : "closure",
    );
    if (evidence === null) continue;
    if (isGatewayVpsRepository(record.repository)) {
      const gate = await gatewayClosureGate(context, record, evidence.revision);
      if (typeof gate === "object") {
        return blockGatewayDelivery(context, record, gate.blocked);
      }
      if (gate !== "accepted") continue;
    }
    foreignMerged.set(key, evidence);
  }
  // The trusted task statement is read again for every record whose delivered
  // evidence is present, immediately before the closure plan that may close
  // its issue: issue text that drifted after the delivery read is a different
  // task and never authorizes this closure.
  const closureSnapshot = {
    ...snapshot,
    work: snapshot.work.map((record) => recovered.get(record.id) ?? record),
  };
  const closureTasks = new Map<
    string,
    ReviewTaskStatementV1 | null | "unavailable"
  >();
  for (const record of closureSnapshot.work) {
    if (deliveryOnly && record.nextStep !== "delivery") continue;
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    if (
      issueNumber === null || pullRequest === null || head === null ||
      base === null
    ) {
      continue;
    }
    const key = hostedDeliveryKey(record.repository, pullRequest, head, base);
    const delivered = isHostedSelf(record.repository)
      ? released.has(key)
      : foreignMerged.get(key) !== undefined;
    if (!delivered) continue;
    const scope = await scopeFor(record.repository);
    closureTasks.set(
      record.id,
      await readTrustedTask(scope.surface, record),
    );
  }
  const closureCandidates = planHostedClosures(
    {
      ...closureSnapshot,
      work: closureSnapshot.work.filter((record) =>
        !isGatewayVpsRepository(record.repository)
      ),
    },
    released,
    foreignMerged,
    closureTasks,
  );
  for (const record of closureSnapshot.work) {
    if (
      !isGatewayVpsRepository(record.repository) ||
      record.nextStep !== "delivery" ||
      record.related.issueNumber === null || record.target.pr === null ||
      record.target.head === null || record.target.base === null ||
      !hostedDeliveryProofMatches(
        foreignMerged.get(hostedDeliveryKey(
          record.repository,
          record.target.pr,
          record.target.head,
          record.target.base,
        )),
        snapshot,
        record,
        closureTasks.get(record.id) ?? "unavailable",
      ) ||
      !gatewayIntentClosable(context, record) ||
      releaseAuthorizingReceipt(
          snapshot,
          record,
          closureTasks.get(record.id) ?? "unavailable",
        ) === null
    ) continue;
    closureCandidates.push({
      id: record.id,
      issueNumber: record.related.issueNumber,
      repository: record.repository,
    });
  }
  const closures = closureCandidates.filter((plan) => !settled(plan.id)).filter(
    (plan) =>
      !deliveryOnly ||
      closureSnapshot.work.some((record) =>
        record.id === plan.id && record.nextStep === "delivery"
      ),
  );
  if (closures.length > 0) {
    for (const plan of closures) {
      const record = closureSnapshot.work.find((item) =>
        item.id === plan.id && sameRepository(item.repository, plan.repository)
      );
      if (record === undefined) continue;
      const scope = await scopeFor(plan.repository);
      if (isGatewayVpsRepository(record.repository)) {
        const pull = await readPull(scope, record.target.pr!);
        const evidence = pull === null ? null : await resolveHostedDelivery(
          context,
          record,
          scope,
          pull,
          "closure",
        );
        const gate = evidence === null
          ? "wait"
          : await gatewayClosureGate(context, record, evidence.revision);
        if (typeof gate === "object") {
          return blockGatewayDelivery(context, record, gate.blocked);
        }
        if (gate !== "accepted") {
          actions.push(`close:${plan.id}:issue=${plan.issueNumber}:refused`);
          continue;
        }
      }
      // The plan above is only a candidate list. Immediately before EVERY
      // actual closure, including a self closure, the CURRENT source-issue
      // statement is re-read over the record's own authenticated surface and
      // the full receipt/record authorization is re-applied to it: an earlier
      // action in this same pass that changed this issue's text (or an
      // unreadable context) refuses here, so a stale bulk read never closes.
      const authorized = releaseAuthorizingReceipt(
        snapshot,
        record,
        await readTrustedTask(scope.surface, record),
      );
      if (authorized === null) {
        actions.push(`close:${plan.id}:issue=${plan.issueNumber}:refused`);
        continue;
      }
      if (!isHostedSelf(record.repository)) {
        if (recovered.has(record.id)) {
          const pull = await readPull(scope, record.target.pr!);
          if (
            pull === null || pull.number !== record.target.pr ||
            pull.author !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
            pull.mergedBy !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR ||
            await resolveHostedDelivery(
                context,
                record,
                scope,
                pull,
                "adoption",
              ) === null
          ) {
            actions.push(`close:${plan.id}:issue=${plan.issueNumber}:refused`);
            continue;
          }
        }
        let checksGreen = false;
        try {
          checksGreen = scope.surface !== null && record.target.head !== null &&
            await scope.surface.hasAllChecksGreen(record.target.head) === true;
        } catch {
          checksGreen = false;
        }
        if (!checksGreen) {
          actions.push(`close:${plan.id}:issue=${plan.issueNumber}:refused`);
          continue;
        }
      }
      let closed = false;
      if (isGatewayVpsRepository(record.repository)) {
        const request = snapshot.releaseRequests.find((item) =>
          releaseRequestMatchesDelivery(item, record)
        );
        if (request === undefined) continue;
        const gate = await gatewayClosureGate(
          context,
          record,
          request.revision,
        );
        if (typeof gate === "object") {
          return blockGatewayDelivery(context, record, gate.blocked);
        }
        if (gate !== "accepted") continue;
        if (record.intent?.kind !== "issue_closure") {
          const proof = await resolveHostedDelivery(
            context,
            record,
            scope,
            await readPull(scope, record.target.pr!),
            "closure",
            request.revision,
          );
          const retained = proof === null
            ? null
            : retainHostedDeliveryProvenance(record, proof);
          if (retained === null) continue;
          const now = deps.clock.now();
          actions.push(`intent:${record.id}:issue_closure`);
          return persistGatewayDelivery(
            context,
            setIntent(retained, {
              kind: "issue_closure",
              key: closureIntentKey(plan.issueNumber),
              startedAt: now,
              branch: null,
              expectedHead: record.target.head,
              observedBase: record.target.base,
              pr: record.target.pr,
              requestId: request.id,
              resultId: null,
            }, now),
          );
        }
        if (!gatewayClosureIntentBindsRequest(record, request)) continue;
        let issueOpen: boolean | null = null;
        try {
          issueOpen = await scope.surface?.readIssueOpen(plan.issueNumber) ??
            null;
        } catch { /* unavailable is not an already-closed proof */ }
        if (issueOpen === null) continue;
        if (issueOpen === false) {
          if (
            releaseAuthorizingReceipt(
              snapshot,
              record,
              await readTrustedTask(scope.surface, record),
            ) === null
          ) continue;
          closed = true;
          actions.push(`reconcile:${record.id}:already_closed`);
        }
      }
      if (!isHostedSelf(record.repository)) {
        const pull = await readPull(scope, record.target.pr!);
        const request = snapshot.releaseRequests.find((item) =>
          releaseRequestMatchesDelivery(item, record)
        );
        const proof = await resolveHostedDelivery(
          context,
          record,
          scope,
          pull,
          "closure",
          request?.revision ?? null,
        );
        if (
          proof === null ||
          (request !== undefined &&
            (request.source.reviewReceiptId !== proof.reviewReceiptId ||
              request.source.reviewRequestId !== proof.reviewRequestId))
        ) continue;
      }
      if (scope.surface !== null) {
        try {
          if (!closed) {
            closed = await scope.surface.closeIssue(plan.issueNumber);
          }
        } catch {
          closed = false;
        }
      }
      if (!closed) {
        actions.push(`close:${plan.id}:issue=${plan.issueNumber}:refused`);
        continue;
      }
      actions.push(`close:${plan.id}:issue=${plan.issueNumber}`);
    }
    const closedIds = new Set(
      actions
        .filter((action) => /^close:[^:]+:issue=\d+$/.test(action))
        .map((action) =>
          action.slice("close:".length, action.indexOf(":issue="))
        ),
    );
    const applied = closures.filter((plan) => closedIds.has(plan.id));
    if (applied.length > 0) {
      const now = deps.clock.now();
      if (!Number.isSafeInteger(now) || now < snapshot.updatedAt) {
        return skipped("clock_invalid", observedHead, actions);
      }
      let next: RepairStateSnapshotV1;
      try {
        next = applyHostedClosures(
          {
            ...snapshot,
            work: snapshot.work.map((record) =>
              applied.some((plan) => plan.id === record.id)
                ? recovered.get(record.id) ?? record
                : record
            ),
          },
          observedHead as GitSha,
          applied,
          now,
        );
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
      return {
        kind: "hosted_autonomy",
        status: "applied",
        reason: "closed_issues",
        beforeHead: observedHead,
        appliedHead: write.value.head,
        actions,
        revisions,
      };
    }
  }

  if (retirementResult !== null) return retirementResult;
  return null;
}
