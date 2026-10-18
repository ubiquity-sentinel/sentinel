/** Unconditional launcher custody prelude. No model, release, refund, or direct merge. */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { isGitSha } from "../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import type { QueueSnapshot } from "../src/github/merge-queue-types.ts";
import type { HostedAutonomyDepsV1 } from "./hosted-autonomy-types.ts";
import type { QueueCustodyResult } from "./hosted-autonomy-queue-context.ts";
import {
  queueProtectedIds,
  queueRecordProtected,
} from "./hosted-autonomy-queue-context.ts";
import {
  hasQueueIntentNamespace,
  isQueueHeld,
  queueCustodyRequired,
} from "./hosted-autonomy-queue-policy.ts";
import {
  QueueCustodyWriter,
  queueHold,
} from "./hosted-autonomy-queue-writer.ts";
import { reconcileQueueRecord } from "./hosted-autonomy-queue-reconcile.ts";
import { readRepairSafely } from "./hosted-autonomy-state.ts";

export async function runHostedQueueCustody(
  deps: HostedAutonomyDepsV1,
  deadline: number,
): Promise<QueueCustodyResult> {
  const read = await readRepairSafely(deps.state);
  if (
    read === null || !read.ok || read.value.status !== "found" ||
    !isGitSha(read.value.head)
  ) {
    return {
      ready: false,
      observed: null,
      protectedRecordIds: new Set(),
      actions: ["queue:state_unavailable"],
      write: null,
    };
  }
  const writer = new QueueCustodyWriter(deps, {
    head: read.value.head,
    snapshot: read.value.snapshot,
  });
  const queue = deps.queue;
  const gateway = read.value.snapshot.work.filter((record) =>
    record.repository.owner === "ubiquity" &&
    record.repository.name === "ai.ubq.fi"
  );
  if (queue === undefined) {
    // Non-gateway offline hosts need no foreign capability. Production always composes it.
    if (gateway.length === 0) return writer.result(true);
    writer.actions.push("queue:coordinator_unavailable");
    return writer.result(false);
  }
  let native: QueueSnapshot;
  try {
    const rules = await queue.readEffectiveQueueRule();
    const effective = rules.status === "complete" ? rules.value : null;
    if (
      !queueCustodyRequired({
        mode: queue.config.mode,
        effectiveQueueRule: effective,
        records: gateway,
      })
    ) {
      writer.actions.push("queue:inactive_no_rule");
      return writer.result(true);
    }
    const scan = await queue.surface.readQueue("development");
    if (scan.status !== "complete") {
      writer.actions.push("queue:observation_unavailable");
      return writer.result(false);
    }
    native = scan.value;
    if (
      canonicalStringify(native.repository) !==
        canonicalStringify(queue.repository) ||
      native.baseRef !== "development" ||
      (effective !== false && native.queueId === null)
    ) {
      writer.actions.push("queue:observation_inconsistent");
      return writer.result(false);
    }
    // Unknown effective rules cannot turn a successful queue read into admission readiness.
    if (effective === null) {
      writer.actions.push("queue:rules_unavailable");
      // Still acquire known native custody before refusing the rest of the pipeline.
    }
    const now = deps.clock.now();
    if (
      !Number.isSafeInteger(now) || now < read.value.snapshot.updatedAt ||
      now >= deadline
    ) {
      writer.actions.push("queue:deadline");
      return writer.result(false);
    }
    if (!await acquireSnapshotHolds(writer, native, now)) {
      writer.actions.push("queue:hold_unverified");
      return writer.result(false);
    }
    if (effective === null) return writer.result(false);
    if (effective && !queue.config.proofActivated) {
      writer.actions.push("queue:activation_unaccepted");
      return writer.result(false);
    }
    let submitted = false;
    const ids = writer.observed.snapshot.work.map((record) => record.id);
    for (const id of ids) {
      if (deps.clock.now() >= deadline) {
        writer.actions.push("queue:deadline");
        return writer.result(false);
      }
      const record = writer.observed.snapshot.work.find((row) =>
        row.id === id
      )!;
      if (
        record.repository.owner !== "ubiquity" ||
        record.repository.name !== "ai.ubq.fi" ||
        record.nextStep === "done" || record.target.pr === null ||
        !isGitSha(record.target.head)
      ) continue;
      const held = queueRecordProtected(record);
      if (
        !held &&
        (queue.config.mode !== "on" || !queue.config.proofActivated ||
          (queue.config.probation && submitted))
      ) continue;
      const outcome = await reconcileQueueRecord({
        deps,
        queue,
        writer,
        record,
        native,
        deadline,
        allowSubmission: queue.config.mode === "on" &&
          queue.config.proofActivated &&
          (!queue.config.probation || !submitted),
      });
      submitted ||= outcome.submitted;
      if (!outcome.ready) return writer.result(false);
      // Every mutation requires a complete fresh queue scan before another candidate.
      if (outcome.submitted) {
        const after = await queue.surface.readQueue("development");
        if (after.status !== "complete") {
          writer.actions.push("queue:post_effect_observation_unavailable");
          return writer.result(false);
        }
        native = after.value;
        if (
          canonicalStringify(native.repository) !==
            canonicalStringify(queue.repository) ||
          native.baseRef !== "development" ||
          (effective !== false && native.queueId === null) ||
          !await acquireSnapshotHolds(writer, native, deps.clock.now())
        ) {
          writer.actions.push("queue:post_effect_custody_unverified");
          return writer.result(false);
        }
      }
    }
    return writer.result(true, queueProtectedIds(writer.observed.snapshot));
  } catch {
    writer.actions.push("queue:unexpected_unavailable");
    return writer.result(false);
  }
}

/** Every complete scan protects late/foreign enqueuers before probation can skip them. */
async function acquireSnapshotHolds(
  writer: QueueCustodyWriter,
  native: QueueSnapshot,
  now: number,
): Promise<boolean> {
  const changed: WorkRecordV1[] = [];
  for (const record of writer.observed.snapshot.work) {
    if (
      record.repository.owner !== "ubiquity" ||
      record.repository.name !== "ai.ubq.fi"
    ) continue;
    const entry = native.entries.find((entry) =>
      entry.pull.number === record.target.pr
    );
    if (entry === undefined && !queueRecordProtected(record)) continue;
    // Completed provenance remains strict for delivery/follow-up without reopening custody.
    if (
      entry === undefined && record.nextStep === "done" &&
      !isQueueHeld(record) && !hasQueueIntentNamespace(record)
    ) continue;
    if (
      record.nextStep === "done" || !isGitSha(record.target.head) ||
      record.target.pr === null
    ) {
      writer.actions.push(`queue:${record.id}:invalid_custody`);
      return false;
    }
    const held = queueHold(record, now);
    if (held !== record) changed.push(held);
  }
  return await writer.update(changed);
}
