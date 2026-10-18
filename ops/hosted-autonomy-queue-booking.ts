/** Already-merged strict deliveries consume proof, never the direct-merge effect budget. */
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyRecordV1 } from "./hosted-autonomy-types.ts";
import { parseRepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { orderRecords } from "../src/state/state-records.ts";
import { gatewayRequestBindsDelivery } from "../src/repair/vps-delivery.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";
import { buildHostedReleaseRequest } from "./hosted-autonomy-delivery.ts";
import {
  resolveHostedDelivery,
  retainHostedDeliveryProvenance,
} from "./hosted-autonomy-delivery-proof.ts";
import { carriedRequestBindsDelivery } from "./hosted-autonomy-spent-delivery.ts";

export async function queueBookingDraft(
  context: HostedAutonomyPassContextV1,
  record: HostedAutonomyRecordV1,
) {
  const scope = await context.scopeFor(record.repository);
  const pull = record.target.pr === null
    ? null
    : await context.readPull(scope, record.target.pr);
  const proof = await resolveHostedDelivery(
    context,
    record,
    scope,
    pull,
    "delivery",
  );
  if (proof === null) {
    context.actions.push(`delivery:${record.id}:merge_proof_unavailable`);
    return null;
  }
  if (
    context.snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, record)
    )
  ) {
    context.actions.push(
      `delivery:${record.id}:${
        proof.receipt.pullRequest.head !== proof.head
          ? "carried_release_pending"
          : "already_recorded"
      }`,
    );
    return null;
  }
  const now = context.deps.clock.now();
  if (!Number.isSafeInteger(now) || now < context.snapshot.updatedAt) {
    return null;
  }
  const request = await buildHostedReleaseRequest(
    record.repository,
    proof.revision,
    proof.head,
    proof.base,
    proof.pullRequest,
    proof.receipt,
    now,
  );
  // Keep queue custody while the existing release/closure lifecycle settles.
  const retained = retainHostedDeliveryProvenance(record, proof);
  if (retained === null) return null;
  const delivered = {
    ...retained,
    nextStep: "delivery" as const,
    blocker: null,
    updatedAt: now,
  };
  if (
    request === null ||
    !await (proof.receipt.pullRequest.head === proof.head
      ? gatewayRequestBindsDelivery
      : carriedRequestBindsDelivery)(
        request,
        delivered,
        proof.receipt,
        proof.revision,
      )
  ) return null;
  const snapshot = parseRepairStateSnapshotV1({
    ...context.snapshot,
    stateHead: context.observedHead,
    sequence: context.snapshot.sequence + 1,
    updatedAt: now,
    work: context.snapshot.work.map((row) =>
      row.id === record.id ? delivered : row
    ),
    releaseRequests: orderRecords(
      [...context.snapshot.releaseRequests, request].map((value) => ({
        id: value.id,
        value,
      })),
    ),
  });
  return { snapshot, revision: proof.revision, requestId: request.id };
}
