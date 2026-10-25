/**
 * Train landing recognition (redesign 2026-10-25 C12, WP3.2). Pure: from the
 * landing commit C (its parents and message), the branch tip and the
 * ancestry fact, it proves that a pull request's exact head was delivered by
 * a delivery train, so C1's booking rule can accept a merge whose parents
 * are `[T, H_1..H_k]` instead of `[base, head]`. Booking stays the
 * launcher's (the runtime defers it as `train_booking_pending`).
 */
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import {
  type DeliveryTrainId,
  type DeliveryTrainManifestV1,
  type DeliveryTrainMemberV1,
  type DeliveryTrainRepositoryV1,
  hasDeliveryTrainParentsV1,
  hasDeliveryTrainTrailerV1,
  parseDeliveryTrainCommitMessageV1,
} from "../contracts/delivery-train.ts";
import { RecordParseError } from "../contracts/validation.ts";

export interface TrainLandingClaimV1 {
  readonly repository: DeliveryTrainRepositoryV1;
  readonly branch: string;
  /** The record and pull request whose delivery is being booked. */
  readonly recordId: WorkItemId;
  readonly pr: number;
  readonly head: GitSha;
  /** The commit GitHub names for the delivery (the train commit C). */
  readonly commit: {
    readonly sha: GitSha;
    readonly parents: readonly string[];
    readonly message: string;
  };
  /** The branch tip, read this pass. */
  readonly tip: GitSha;
  /** Whether `commit.sha` is an ancestor of `tip`; null when unread. */
  readonly commitReachable: boolean | null;
}

export type TrainLandingRefusalV1 =
  | "not_train"
  | "manifest_invalid"
  | "foreign_train"
  | "parents_mismatch"
  | "not_member"
  | "not_landed"
  | "ancestry_unknown";

export type TrainLandingVerdictV1 =
  | {
    readonly ok: true;
    readonly trainId: DeliveryTrainId;
    readonly manifest: DeliveryTrainManifestV1;
    readonly member: DeliveryTrainMemberV1;
    readonly landed: GitSha;
  }
  | { readonly ok: false; readonly reason: TrainLandingRefusalV1 };

function refuse(reason: TrainLandingRefusalV1): TrainLandingVerdictV1 {
  return { ok: false, reason };
}

/**
 * A train landing of the claimed pull request: C's message parses to a
 * manifest whose digest is its id, the manifest names this repository and
 * branch, C's parents are exactly `[T, H_1..H_k]`, the claim's (record, pr,
 * head) is a member, and C is the tip or an ancestor of it.
 */
export async function verifyTrainLandingV1(
  claim: TrainLandingClaimV1,
): Promise<TrainLandingVerdictV1> {
  if (!hasDeliveryTrainTrailerV1(claim.commit.message)) {
    return refuse("not_train");
  }
  let train;
  try {
    train = await parseDeliveryTrainCommitMessageV1(claim.commit.message);
  } catch (error) {
    if (error instanceof RecordParseError) return refuse("manifest_invalid");
    throw error;
  }
  const { manifest, trainId } = train;
  if (
    manifest.repository.owner !== claim.repository.owner ||
    manifest.repository.name !== claim.repository.name ||
    manifest.branch !== claim.branch
  ) return refuse("foreign_train");
  if (!hasDeliveryTrainParentsV1(manifest, claim.commit.parents)) {
    return refuse("parents_mismatch");
  }
  const member = manifest.members.find((candidate) =>
    candidate.pr === claim.pr && candidate.recordId === claim.recordId &&
    candidate.head === claim.head
  );
  if (member === undefined) return refuse("not_member");
  if (claim.tip !== claim.commit.sha) {
    if (claim.commitReachable === null) return refuse("ancestry_unknown");
    if (!claim.commitReachable) return refuse("not_landed");
  }
  return { ok: true, trainId, manifest, member, landed: claim.commit.sha };
}
