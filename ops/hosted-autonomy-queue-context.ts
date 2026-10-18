import type { TakeoverPublicationProof } from "../src/contracts/existing-pr-takeover.ts";
/** In-memory custody shared by every launcher phase; never a V1 wire field. */
import type { GitSha } from "../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import type {
  DeliveryProofResult,
  QueueBinding,
} from "../src/github/merge-queue-types.ts";
import {
  hasQueueIntentNamespace,
  isQueueHeld,
} from "./hosted-autonomy-queue-policy.ts";
import { hasQueueDeliveryProvenance } from "./hosted-autonomy-queue-policy.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";

export interface QueueDeliveryRequest {
  snapshot: RepairStateSnapshotV1;
  observedHead: GitSha;
  record: WorkRecordV1;
  expectedRevision: GitSha | null;
  purpose: "delivery" | "closure" | "follow_up" | "adoption";
}

/** Legacy is an explicit fresh root-authority classification, never verified queue proof. */
export type QueueDeliveryResolution = DeliveryProofResult | {
  status: "legacy_direct";
  publicationProof?: TakeoverPublicationProof;
  binding: QueueBinding;
  revision: GitSha;
  carried?: { reviewedBase: GitSha; reviewedHead: GitSha; patchDigest: string };
};

export interface HostedQueueCustodyContext {
  readonly ready: boolean;
  readonly proofActivated: boolean;
  readonly protectedRecordIds: ReadonlySet<string>;
  /** Absence never permits legacy fallback when strict proof is required. */
  readonly resolveDelivery?: (
    request: QueueDeliveryRequest,
  ) => Promise<QueueDeliveryResolution>;
  /** Trusted exact completed-proof transition; absence refuses protected writes. */
  readonly verifyProtectedWrite?: (
    before: RepairStateSnapshotV1,
    next: RepairStateSnapshotV1,
    expectedHead: GitSha,
  ) => Promise<boolean>;
}

export interface QueueCustodyResult {
  ready: boolean;
  observed: { head: GitSha; snapshot: RepairStateSnapshotV1 } | null;
  protectedRecordIds: ReadonlySet<string>;
  actions: readonly string[];
  /** Only an applied, exactly read-back CAS; ambiguity never masquerades as a write. */
  write: HostedAutonomyResultV1 | null;
}

/** Conservative even when a damaged intent cannot pass the strict queue codec. */
export function queueRecordProtected(
  record: WorkRecordV1,
  context?: Pick<HostedQueueCustodyContext, "protectedRecordIds">,
): boolean {
  return context?.protectedRecordIds.has(record.id) === true ||
    isQueueHeld(record) || hasQueueIntentNamespace(record) ||
    hasQueueDeliveryProvenance(record);
}

export function queueProtectedIds(
  snapshot: RepairStateSnapshotV1,
  previous: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  return new Set([
    ...previous,
    ...snapshot.work.filter((row) => queueRecordProtected(row)).map((row) =>
      row.id
    ),
  ]);
}
