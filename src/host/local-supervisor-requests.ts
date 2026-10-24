import {
  isLocalReleaseTerminalPhase,
  isLocalSentinelRepository,
} from "../contracts/local-release.ts";
import { hasBlockingSeverity } from "../contracts/review-receipt.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import { createRepairStateStore } from "../state/mod.ts";
import { listLocalReleaseReceipts } from "./local-release.ts";
import {
  DETAIL_RECEIPTS_UNREADABLE,
  DETAIL_STATE_ABSENT,
  DETAIL_STATE_READ,
  joinPath,
  type LocalSupervisorInputV1,
  STATE_GIT_DIR,
  STATE_SCRATCH_DIR,
} from "./local-supervisor-shared.ts";
import { sourceRevisionIsAncestor } from "./local-supervisor-runtime.ts";

// ---------------------------------------------------------------------------
// Request selection: the oldest exact eligible local production request
// ---------------------------------------------------------------------------

type SelectionV1 =
  | { kind: "none" }
  | { kind: "found"; request: ReleaseRequestV1 }
  | { kind: "error"; detail: string };

export async function selectLocalReleaseRequest(
  input: LocalSupervisorInputV1,
): Promise<SelectionV1> {
  const receipts = await listLocalReleaseReceipts(input.stateRoot);
  if (!receipts.ok) {
    return { kind: "error", detail: DETAIL_RECEIPTS_UNREADABLE };
  }
  const terminal = new Set(
    receipts.value
      .filter((receipt) => isLocalReleaseTerminalPhase(receipt.phase))
      .map((receipt) => receipt.request.id),
  );
  const store = createRepairStateStore({
    scratchDir: joinPath(input.stateRoot, STATE_SCRATCH_DIR),
    remoteUrl: joinPath(input.stateRoot, STATE_GIT_DIR),
  });
  const read = await store.readRepair();
  if (!read.ok) return { kind: "error", detail: DETAIL_STATE_READ };
  if (read.value.status !== "found") {
    return { kind: "error", detail: DETAIL_STATE_ABSENT };
  }
  const snapshot: RepairStateSnapshotV1 = read.value.snapshot;
  const candidates = snapshot.releaseRequests
    .filter((request) =>
      request.status === "open" &&
      request.target.environment === "production" &&
      isLocalSentinelRepository(request.target.repository) &&
      !terminal.has(request.id)
    )
    .sort((left, right) =>
      left.createdAt - right.createdAt ||
      (left.id < right.id ? -1 : 1)
    );
  for (const request of candidates) {
    const review = matchReviewReceipt(request, snapshot.reviews);
    if (review === null) continue;
    const ancestor = await sourceRevisionIsAncestor(input, request.revision);
    if (!ancestor.ok) return { kind: "error", detail: ancestor.detail };
    if (!ancestor.value) continue;
    return { kind: "found", request };
  }
  return { kind: "none" };
}

/**
 * The exact completed review receipt: same receipt/request identity, completed
 * with a timestamp, expected reviewer matching the observed reviewer, full
 * findings (none uncounted) and no unresolved P0/P1. Source PR/head/base and
 * repository bind exactly to the request. No new review is created here.
 */
function matchReviewReceipt(
  request: ReleaseRequestV1,
  reviews: readonly ReviewReceiptV1[],
): ReviewReceiptV1 | null {
  const receiptId = request.source.reviewReceiptId;
  if (receiptId === null) return null;
  const receipt = reviews.find((item) => item.id === receiptId);
  if (receipt === undefined) return null;
  if (receipt.requestId !== request.source.reviewRequestId) return null;
  if (receipt.outcome !== "completed" || receipt.completedAt === null) {
    return null;
  }
  if (
    receipt.observedReviewer === null ||
    receipt.observedReviewer !== receipt.expectedReviewer
  ) {
    return null;
  }
  if (receipt.findingsUncounted !== 0) return null;
  if (hasBlockingSeverity(receipt.unresolvedSeverities)) return null;
  const repository = receipt.repository;
  const target = request.target.repository;
  if (
    repository.owner !== target.owner ||
    repository.name !== target.name ||
    repository.installationId !== target.installationId
  ) {
    return null;
  }
  if (receipt.pullRequest.number !== request.source.pullRequest) return null;
  if (receipt.pullRequest.head !== request.source.head) return null;
  if (receipt.pullRequest.base !== request.source.base) return null;
  return receipt;
}
