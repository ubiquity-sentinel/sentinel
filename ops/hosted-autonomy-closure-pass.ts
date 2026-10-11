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
  authorizingReceipt,
  historicalMergedPublication,
  readTrustedTask,
  verifiedMergedDelivery,
} from "./hosted-autonomy-delivery.ts";
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

export async function runHostedClosurePass(
  context: HostedAutonomyPassContextV1,
): Promise<HostedAutonomyResultV1 | null> {
  const { deps, actions, revisions, scopeFor, readPull } = context;
  let { snapshot, observedHead } = context;
  const { closedIssues, foreignMerged } = context;
  // ---- closure pass -------------------------------------------------------
  const released = acceptedReleases(context.releaseSnapshot.hostedReleases);
  // A record whose source issue is closed and whose own pull request is
  // definitively closed without a merge can never deliver, whatever step it is
  // parked at. That verdict requires the read to succeed and the pull to be
  // neither merged nor open; a failed or empty read is not evidence and leaves
  // the record alone.
  const closedUnmerged = new Set<string>();
  for (const record of snapshot.work) {
    if (record.nextStep === "done") continue;
    const issueNumber = record.related.issueNumber;
    if (
      issueNumber === null ||
      !closedIssues.has(hostedIssueKey(record.repository, issueNumber))
    ) {
      continue;
    }
    const pullRequest = record.target.pr;
    if (pullRequest === null) continue;
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
  ).slice(0, 5);
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
    const record = await historicalMergedPublication(snapshot, original) ??
      original;
    if (record !== original) recovered.set(record.id, record);
    if (record.nextStep === "done") continue;
    if (isHostedSelf(record.repository)) continue;
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
    if (foreignMerged.has(key)) continue;
    const scope = await scopeFor(record.repository);
    // The same trusted, immediately-preceding source-issue read authorizes the
    // merge evidence this closure will consume, exactly as it did the merge.
    if (
      authorizingReceipt(
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
    const evidence = verifiedMergedDelivery(record, pull, scope.baseBranch);
    if (evidence === null) continue;
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
      : foreignMerged.has(key);
    if (!delivered) continue;
    const scope = await scopeFor(record.repository);
    closureTasks.set(
      record.id,
      await readTrustedTask(scope.surface, record),
    );
  }
  const closures = planHostedClosures(
    closureSnapshot,
    released,
    foreignMerged,
    closureTasks,
  ).slice(0, 5);
  if (closures.length > 0) {
    for (const plan of closures) {
      const record = closureSnapshot.work.find((item) =>
        item.id === plan.id && sameRepository(item.repository, plan.repository)
      );
      if (record === undefined) continue;
      const scope = await scopeFor(plan.repository);
      // The plan above is only a candidate list. Immediately before EVERY
      // actual closure, including a self closure, the CURRENT source-issue
      // statement is re-read over the record's own authenticated surface and
      // the full receipt/record authorization is re-applied to it: an earlier
      // action in this same pass that changed this issue's text (or an
      // unreadable context) refuses here, so a stale bulk read never closes.
      const authorized = authorizingReceipt(
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
            verifiedMergedDelivery(record, pull, scope.baseBranch) === null
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
      if (scope.surface !== null) {
        try {
          closed = await scope.surface.closeIssue(plan.issueNumber);
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
