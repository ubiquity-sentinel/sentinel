/**
 * A green delivery train's ordered merges (sentinel #330). Every member's
 * gate is re-read before the first merge; then each member, in line order,
 * re-reads its gate and the uncached tip (exactly the tip the previous member
 * left), persists its merge intent, merges under its expected-head guard and
 * the per-target method, and is booked only on its verified landing: parent
 * exactly that tip (a merge commit's second parent the reviewed head) and
 * tree exactly the train commit's tree after it. A merge intent the ledger
 * holds without an outcome is adopted from the pull, never repeated blind.
 */
import { resolveHostedDelivery } from "./hosted-autonomy-delivery-proof.ts";
import { hostedDeliveryKey } from "./hosted-autonomy-policy.ts";
import { trainMemberGate } from "./hosted-autonomy-train-members.ts";
import { DELIVERY_TRAIN_MAX_LANDINGS } from "./hosted-autonomy-train-types.ts";
import type { HostedAutonomyRecordV1 } from "./hosted-autonomy-types.ts";
import type { Outcome, TrainRun } from "./hosted-autonomy-train-run.ts";

export async function mergeTrain(run: TrainRun): Promise<Outcome> {
  // Every member's gate is re-read before the first merge, so a train
  // seldom stops between members (a stop leaves the merged prefix).
  if (
    run.train.pendingMerge === null &&
    run.train.members.every((m) => m.revision === null)
  ) {
    for (const m of run.train.members) {
      if (run.late()) return "deferred";
      const record = run.record(m);
      if (record === null) {
        return await run.end(`stopped:${m.recordId}:record_changed`);
      }
      const gate = await trainMemberGate(
        run.context,
        run.scope,
        record,
        m.receiptId,
      );
      if (gate.refusal !== null) {
        return await run.end(`stopped:${m.recordId}:${gate.refusal}`);
      }
    }
  }
  for (let index = 0; index < run.train.members.length; index++) {
    const train = run.train;
    const m = train.members[index];
    if (m.revision !== null) continue;
    if (run.late()) return "deferred";
    // A record an earlier write of this pass touched waits for the next.
    if (run.context.settled?.has(m.recordId) === true) {
      run.act(`train:${train.operationId}:member_settled:${m.recordId}`);
      return "done";
    }
    const landedOn = index === 0
      ? train.tip
      : train.members[index - 1].revision!;
    const record = run.record(m);
    if (record === null) {
      return await run.end(`stopped:${m.recordId}:record_changed`);
    }
    if (train.pendingMerge === index) {
      // A merge call whose outcome the ledger did not record: adopt the
      // landing it made, or retry it below when the pull is still open.
      const pull = await run.context.readPull(run.scope, m.pullRequest);
      if (pull === null) {
        run.act(`delivery:${m.recordId}:merge_not_observed`);
        return "done";
      }
      if (pull.merged === true && pull.mergeCommitSha !== null) {
        const landed = await landMember(
          run,
          index,
          record,
          landedOn,
          pull.mergeCommitSha,
          false,
        );
        if (landed !== "landed") return landed;
        continue;
      }
    }
    const gate = await trainMemberGate(
      run.context,
      run.scope,
      record,
      m.receiptId,
    );
    if (run.late()) return "deferred";
    if (gate.refusal !== null) {
      return await run.end(`stopped:${m.recordId}:${gate.refusal}`);
    }
    const tipNow = await run.context.readTip(run.scope);
    if (run.late()) return "deferred";
    if (tipNow !== landedOn) {
      return await run.end(
        `stopped:${m.recordId}:${
          tipNow === null ? "base_unreadable" : "base_moved"
        }`,
      );
    }
    if (
      !await run.persist({
        ...run.ledger,
        train: { ...train, pendingMerge: index },
      })
    ) return "done";
    // Once the intent is durable the merge settles even past the cutoff.
    run.input.dropTip(run.key);
    let merged: { merged: boolean; sha: string | null } | null = null;
    try {
      merged = await run.surface.merge(m.pullRequest, m.head);
    } catch {
      merged = null;
    }
    let revision = merged?.merged === true ? merged.sha : null;
    if (revision === null) {
      run.act(
        `delivery:${m.recordId}:${
          merged === null ? "merge_refused" : "merge_not_observed"
        }`,
      );
      // A lost response may still have landed: the pull decides.
      const pull = await run.context.readPull(run.scope, m.pullRequest);
      if (pull === null) return "done";
      if (pull.merged !== true || pull.mergeCommitSha === null) {
        return await run.end(`stopped:${m.recordId}:merge_refused`);
      }
      revision = pull.mergeCommitSha;
    }
    const landed = await landMember(
      run,
      index,
      record,
      landedOn,
      revision,
      true,
    );
    if (landed !== "landed") return landed;
  }
  return await run.end(`landed:merges=${run.train.members.length}`);
}

/** Verify one merge against the train and record its landing. */
async function landMember(
  run: TrainRun,
  index: number,
  record: HostedAutonomyRecordV1,
  landedOn: string,
  revision: string,
  madeThisPass: boolean,
): Promise<Outcome | "landed"> {
  const train = run.train;
  const m = train.members[index];
  const after = await run.context.readPull(run.scope, m.pullRequest);
  const tree = await run.tree(m.commit);
  const landedTree = await run.tree(revision);
  if (after === null || tree === null || landedTree === null) {
    // Unread facts: the durable merge intent stays for the next pass.
    run.act(`delivery:${m.recordId}:merge_not_observed`);
    return "done";
  }
  if (
    after.merged !== true || after.mergeCommitSha !== revision ||
    after.headSha !== m.head || after.parents[0] !== landedOn ||
    !(after.parents.length === 1 ||
      (after.parents.length === 2 && after.parents[1] === m.head)) ||
    landedTree !== tree
  ) {
    // Nothing is booked for a merge whose result is not the train's.
    run.act(`delivery:${m.recordId}:merged_off_train:sha=${revision}`);
    return await run.end(`stopped:${m.recordId}:merged_off_train`);
  }
  if (madeThisPass) {
    run.act(`merge:${m.recordId}:pr=${m.pullRequest}:sha=${revision}`);
  }
  run.act(
    `delivery:${m.recordId}:train_merged:op=${train.operationId}:on=${landedOn}:tree=${tree}`,
  );
  const members = train.members.map((member, at) =>
    at === index ? { ...member, landedOn, revision } : member
  );
  const landings = [...run.ledger.landings, {
    operationId: train.operationId,
    recordId: m.recordId,
    pullRequest: m.pullRequest,
    head: m.head,
    base: m.base,
    landedOn,
    revision,
    tree,
  }].slice(-DELIVERY_TRAIN_MAX_LANDINGS);
  // A lost landing write leaves the merge intent durable: the next pass
  // adopts this exact merge instead of merging anything else.
  if (
    !await run.persist({
      ...run.ledger,
      landings,
      train: { ...train, members, pendingMerge: null },
    })
  ) return "done";
  run.held.add(record.id);
  const proof = await resolveHostedDelivery(
    run.context,
    record,
    run.scope,
    after,
    "delivery",
    revision,
  );
  if (proof === null) {
    run.act(`delivery:${m.recordId}:merge_proof_unavailable`);
  } else {
    run.context.foreignMerged.set(
      hostedDeliveryKey(record.repository, m.pullRequest, m.head, m.base),
      proof,
    );
    run.act(`delivery:${m.recordId}:foreign_merged`);
    run.context.revisions.push(revision);
  }
  return "landed";
}
