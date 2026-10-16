import type {
  PortResultV1,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { ReleaseRequestV1 } from "../src/contracts/release.ts";
import { orderRecords } from "../src/state/state-records.ts";
import { failed, readRepairSafely, skipped } from "./hosted-autonomy-state.ts";
import {
  authorizingReceipt,
  baseAndHeadAreMerged,
  boundReviewReceipts,
  buildHostedReleaseRequest,
  readTrustedTask,
  verifiedMergedDelivery,
} from "./hosted-autonomy-delivery.ts";
import type {
  HostedAutonomyPassContextV1,
  HostedAutonomyScopeV1,
} from "./hosted-autonomy-scopes.ts";
import {
  deliveryEligible,
  HOSTED_AUTONOMY_SELF_SCOPE,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  hostedDeliveryKey,
  isHostedSelf,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";
import {
  gatewayRequestBindsDelivery,
  isGatewayVpsRepository,
} from "../src/repair/vps-delivery.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";
import { runHostedCiRerunPass } from "./hosted-autonomy-ci-rerun.ts";

export async function runHostedDeliveryPass(
  context: HostedAutonomyPassContextV1,
): Promise<HostedAutonomyResultV1 | null> {
  const { deps, actions, revisions, scopeFor, readTip, readPull } = context;
  const { snapshot, observedHead } = context;
  // ---- check-approval pass ------------------------------------------------
  // A candidate pushed to a pull request by the bot produces a CI run that
  // GitHub parks for approval, so the deterministic check the merge requires
  // can never complete on its own. The job approves exactly those runs for the
  // exact reviewed head, on the record's OWN repository surface; the check
  // itself stays credential-free and unchanged.
  for (const record of snapshot.work) {
    if (!deliveryEligible(record)) {
      continue;
    }
    const head = record.target.head;
    if (head === null || record.target.pr === null) continue;
    const scope = await scopeFor(record.repository);
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
  // A clean-reviewed head parked on a failed CI run against its green,
  // current base gets that run re-run once (state-free; see the module).
  await runHostedCiRerunPass(context);

  // ---- delivery pass ------------------------------------------------------
  // Each repository's base tip is read once in this pass from that repository's
  // OWN surface. A missing tip or a missing default branch is an explicit skip,
  // never a guessed base, and never another repository's branch.
  const deliveryTips = new Map<string, string | null>();
  const deliveryTip = async (
    scope: HostedAutonomyScopeV1,
  ): Promise<string | null> => {
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
      deliveryEligible(record) && isHostedSelf(record.repository)
    )
  ) {
    const selfTip = await deliveryTip(
      await scopeFor(HOSTED_AUTONOMY_SELF_SCOPE),
    );
    if (selfTip === null) {
      return actions.length > 0
        ? skipped("retried", observedHead, actions)
        : skipped("base_moved", observedHead, actions);
    }
  }

  for (const record of snapshot.work) {
    if (!deliveryEligible(record)) {
      continue;
    }
    const pullRequest = record.target.pr;
    const head = record.target.head;
    const base = record.target.base;
    if (pullRequest === null || head === null || base === null) continue;
    const scope = await scopeFor(record.repository);
    // The exact receipts bound to this delivery identity decide whether the
    // candidate is even a delivery candidate. A record without one changes
    // nothing and is reported exactly as before, without an extra read.
    if (boundReviewReceipts(snapshot, record).length === 0) continue;
    // The trusted live source-issue statement is read over the record's OWN
    // authenticated surface immediately before the merge and the release
    // request; the shared predicate then binds the receipt's acceptance to
    // that exact text. A legacy quality-only receipt, a wrong-task digest or
    // an unreadable context refuses here, before any external effect.
    const receipt = authorizingReceipt(
      snapshot,
      record,
      await readTrustedTask(scope.surface, record),
    );
    if (receipt === null) {
      actions.push(`delivery:${record.id}:task_acceptance_refused`);
      continue;
    }
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
    let pull = await readPull(scope, pullRequest);
    if (pull === null || pull.headSha !== head) continue;
    if (
      typeof pull.author !== "string" ||
      !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)
    ) {
      actions.push(`delivery:${record.id}:foreign_author`);
      continue;
    }

    let revision: string | null = null;
    if (pull.state === "open" && pull.merged === false) {
      // A Gateway release request binds only a record in `review` or
      // `delivery` (gatewayRequestBindsDelivery). A spent-round record parked
      // `blocked` is merged only after a grant re-admits it; merged from
      // `blocked`, its request (and so its release and issue closure) could
      // never be recorded.
      if (
        gateway && record.nextStep !== "review" &&
        record.nextStep !== "delivery"
      ) {
        actions.push(`delivery:${record.id}:gateway_not_admitted`);
        continue;
      }
      // The base must be exactly the reviewed base, and the repository's own
      // deterministic check must already have succeeded on the exact head.
      const baseTip = await deliveryTip(scope);
      if (baseTip === null) {
        actions.push(`delivery:${record.id}:base_unreadable`);
        continue;
      }
      if (baseTip !== base) {
        actions.push(`delivery:${record.id}:base_moved`);
        continue;
      }
      // A foreign pull must target the exact branch its repository declares as
      // the delivered base; a mismatched base ref is never merged.
      if (!self && pull.baseRef !== scope.baseBranch) {
        actions.push(`delivery:${record.id}:base_mismatch`);
        continue;
      }
      let green: boolean;
      try {
        green = self
          ? await scope.surface.hasSuccessfulCheck(head)
          : await scope.surface.hasAllChecksGreen(head);
      } catch {
        green = false;
      }
      if (!green) {
        actions.push(`delivery:${record.id}:checks_pending`);
        continue;
      }
      // One more trusted source-issue read immediately before the external
      // merge: issue text that drifted while the other gates were read is a
      // different task and never authorizes this merge.
      if (
        authorizingReceipt(
          snapshot,
          record,
          await readTrustedTask(scope.surface, record),
        ) === null
      ) {
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
      let merged: { merged: boolean; sha: string | null } | null;
      try {
        merged = await scope.surface.merge(pullRequest, head);
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
    }
    if (pull.merged !== true || pull.mergeCommitSha === null) continue;
    // A merge performed earlier in THIS pass is an external write and keeps
    // the one-merge bound; an already-merged pull is read-only.
    const mergedThisPass = revision !== null;
    if (revision === null) revision = pull.mergeCommitSha;
    if (revision !== pull.mergeCommitSha) continue;
    if (
      !baseAndHeadAreMerged(pull, base, head) || !pull.revisionOnBaseBranch
    ) {
      actions.push(`delivery:${record.id}:merge_not_observed`);
      continue;
    }

    if (!self && !gateway) {
      // A foreign repository has no sentinel release authority: nothing is
      // recorded and no release is invented. The verified merge facts are
      // handed to the closure pass, which closes the record's OWN issue from
      // exactly this evidence.
      const evidence = verifiedMergedDelivery(record, pull, scope.baseBranch);
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
      // One external merge per pass stays the bound. An already-merged
      // verified delivery is read-only, so keep scanning and settle the rest
      // of the backlog in the same pass: with an unconditional break the four
      // stacked merges stalled 70 runs behind every newly verified delivery.
      if (mergedThisPass) break;
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
    if (
      gateway &&
      (!await gatewayRequestBindsDelivery(request, record, receipt, revision) ||
        snapshot.releaseRequests.some((existing) =>
          existing.id === request.id ||
          releaseRequestMatchesDelivery(existing, record)
        ))
    ) {
      actions.push(`delivery:${record.id}:already_recorded`);
      continue;
    }
    let next: RepairStateSnapshotV1;
    try {
      next = parseRepairStateSnapshotV1({
        ...snapshot,
        stateHead: observedHead,
        sequence: snapshot.sequence + 1,
        updatedAt: now,
        work: gateway
          ? snapshot.work.map((item) =>
            item.id === record.id
              ? { ...item, nextStep: "delivery", updatedAt: now }
              : item
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
      });
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
    actions.push(`request:${record.id}:${request.id}`);
    revisions.push(revision);
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

  return null;
}
