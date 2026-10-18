/** Durable reference to authenticated admission custody, using only existing V1 fields. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { Clock, StateReadView } from "../contracts/ports.ts";
import { type EvidenceRefV1, parseEvidenceRef } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { queueIntentBinding } from "../../ops/hosted-autonomy-queue-intent.ts";
import {
  isVerifiedDeliveryProof,
  type QueueProofPolicy,
} from "../../ops/hosted-autonomy-queue-proof.ts";
import type { VerifiedDelivery } from "./merge-queue-types.ts";
import type { QueueDeliveryReaderOptions } from "./queue-delivery-reader.ts";

const NAMESPACE = "artifact:review-receipt/merge-queue-v1";
const PREFIX = `${NAMESPACE}/`;
const REF =
  /^artifact:review-receipt\/merge-queue-v1\/([A-Za-z0-9._:-]{1,256})\/([0-9a-f]{40})$/;
const equal = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);

export { hasQueueDeliveryProvenance } from "../../ops/hosted-autonomy-queue-policy.ts";

/** A serialized, forged, or subsequently mutated proof cannot mint this reference. */
export function queueDeliveryProvenanceRef(
  delivery: VerifiedDelivery,
  record: WorkRecordV1,
  observedHead: GitSha,
): EvidenceRefV1 | null {
  if (
    !isVerifiedDeliveryProof(delivery) || delivery.kind !== "queue" ||
    !isGitSha(observedHead) || !equal(record.repository, delivery.repository) ||
    record.target.pr !== delivery.pullRequest ||
    record.target.base !== delivery.base ||
    record.target.head !== delivery.head ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(delivery.reviewReceiptId)
  ) return null;
  const previous = record.evidence.filter((item) =>
    item.ref.startsWith(NAMESPACE)
  );
  if (previous.length > 0) {
    if (previous.length !== 1 || previous[0].kind !== "review_receipt") {
      return null;
    }
    const parsed = REF.exec(previous[0].ref);
    return parsed !== null && parsed[1] === delivery.reviewReceiptId
      ? previous[0]
      : null;
  }
  try {
    return parseEvidenceRef({
      kind: "review_receipt",
      ref: `${PREFIX}${delivery.reviewReceiptId}/${observedHead}`,
    }, "$queue.provenance");
  } catch {
    return null;
  }
}

/**
 * Entry IDs are retained only after exact native App-entry observation and CAS
 * readback. Later consumers recover that ancestor, never infer custody from a
 * branch name, a request UUID, a queue response hint, or an arbitrary timeline.
 */
export function createQueueProvenanceReader(options: {
  state: StateReadView;
  clock: Clock;
  policy: QueueProofPolicy;
}): NonNullable<QueueDeliveryReaderOptions["provenance"]> {
  return async (input) => {
    const unavailable = () => ({
      status: "unavailable" as const,
      reason: "incomplete" as const,
    });
    const { state, clock, policy } = options;
    if (
      clock.now() >= input.deadline || policy.appActor === null ||
      policy.canaryDigest === null ||
      !/^[0-9a-f]{64}$/.test(policy.canaryDigest)
    ) return unavailable();
    const current = await state.readRepair();
    if (
      !current.ok || current.value.status !== "found" ||
      !equal(current.value.snapshot, input.snapshot) ||
      !equal(
        input.snapshot.work.find((row) => row.id === input.record.id) ?? null,
        input.record,
      )
    ) return unavailable();
    let admissionSnapshot = input.snapshot;
    let admissionRecord = input.record;
    const references = input.record.evidence.filter((item) =>
      item.ref.startsWith(NAMESPACE)
    );
    if (references.length > 0) {
      if (references.length !== 1 || references[0].kind !== "review_receipt") {
        return unavailable();
      }
      const parsed = REF.exec(references[0].ref);
      if (
        parsed === null || parsed[1] !== input.binding.reviewReceiptId ||
        !isGitSha(parsed[2])
      ) return unavailable();
      if (parsed[2] !== current.value.head) {
        if (state.readRepairAt === undefined) return unavailable();
        const ancestor = await state.readRepairAt({
          commit: parsed[2],
          expectedHead: current.value.head,
        });
        if (
          !ancestor.ok || ancestor.value.status !== "found" ||
          ancestor.value.head !== parsed[2]
        ) return unavailable();
        admissionSnapshot = ancestor.value.snapshot;
      }
      const prior = admissionSnapshot.work.find((row) =>
        row.id === input.record.id
      );
      if (prior === undefined) return unavailable();
      admissionRecord = prior;
    }
    if (
      !equal(admissionRecord.repository, input.record.repository) ||
      !equal(admissionRecord.target, input.record.target) ||
      !equal(admissionRecord.related, input.record.related)
    ) return unavailable();
    const admission = await queueIntentBinding(
      admissionSnapshot,
      admissionRecord,
    );
    if (
      admission === null || !equal(admission.binding, input.binding) ||
      admission.state.intent.resultId === null ||
      admission.state.stage === "dequeue_pending" ||
      !equal(
        input.snapshot.reviews.find((receipt) =>
          receipt.id === input.binding.reviewReceiptId
        ) ?? null,
        admission.receipt,
      )
    ) return unavailable();
    const { evidence } = input;
    if (
      !equal(evidence.pull.repository, input.binding.repository) ||
      evidence.pull.number !== input.binding.pullRequest ||
      evidence.pull.head !== input.binding.head ||
      evidence.pull.headRef !== input.record.target.branch ||
      evidence.pull.baseRef !== "development"
    ) return unavailable();
    // GitHub DateTime is second precision. Admit the containing second only;
    // the exact observed entry ID and App actor, not this timestamp, own custody.
    const earliest = Math.floor(admission.state.intent.startedAt / 1000) * 1000;
    const added = evidence.added.filter((event) => event.at >= earliest);
    const removed = evidence.removed.filter((event) => event.at >= earliest);
    if (
      added.length !== 1 || !equal(added[0].actor, policy.appActor) ||
      added[0].at > clock.now() || removed.length > 1 ||
      removed.some((event) => event.at < added[0].at || event.at > clock.now())
    ) return unavailable();
    if (evidence.entry !== null) {
      if (
        evidence.entry.id !== admission.state.intent.resultId ||
        !equal(evidence.entry.enqueuer, policy.appActor) ||
        !equal(evidence.entry.pull, evidence.pull) ||
        evidence.entry.enqueuedAt < earliest || removed.length !== 0
      ) return unavailable();
    } else {
      // Successful dequeue/ejection is not successful queue delivery. An exact
      // canary-pinned merged-removal value is mandatory once the entry is gone.
      if (
        removed.length !== 1 || removed[0].reason === null ||
        policy.mergedRemovalBeforeCommit === undefined ||
        removed[0].beforeCommit !==
          (policy.mergedRemovalBeforeCommit === "pull_head"
            ? input.binding.head
            : input.revision) ||
        !(policy.mergedRemovalReasons ?? []).includes(removed[0].reason) ||
        removed[0].actor === null ||
        !policy.mergedActors.some((actor) => equal(actor, removed[0].actor))
      ) return unavailable();
    }
    const after = await state.readRepair();
    if (
      !after.ok || after.value.status !== "found" ||
      after.value.head !== current.value.head || clock.now() >= input.deadline
    ) return unavailable();
    return {
      status: "complete",
      value: {
        binding: input.binding,
        enqueuer: policy.appActor,
        evidenceIds: [
          admission.state.intent.resultId,
          added[0].id,
          ...removed.map((event) => event.id),
        ],
      },
    };
  };
}
