/** Fresh native observation of historical PRIOR; no unknown saved-state timestamp is invented. */
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import { parseHostedRunProofV1 } from "../contracts/hosted-supervisor.ts";
import type {
  HostedOwnerSupersessionIntentV1,
  HostedReleaseRecordV1,
  HostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import type { GitHubApiClient } from "../github/client.ts";

export function originalPriorNativeFingerprint(
  proof: HostedRunProofV1,
): Promise<string> {
  const parsed = parseHostedRunProofV1(proof);
  return canonicalStringifySha256(
    Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== "observedAt"),
    ),
  );
}
export async function ownerDispositionBinds(
  receipt: HostedReleaseRecordV1,
): Promise<boolean> {
  try {
    const d = receipt.ownerDisposition;
    return receipt.phase === "owner_superseded" && d !== undefined &&
      d.intent.releaseId === receipt.id &&
      await canonicalStringifySha256(d.intent) === d.intentSha256 &&
      await canonicalStringifySha256(receipt.request) ===
        d.intent.requestSha256 &&
      await canonicalStringifySha256(receipt.request.source) ===
        d.intent.sourceSha256 &&
      await canonicalStringifySha256(d.failedPriorProof) ===
        d.intent.failedProofSha256 &&
      await canonicalStringifySha256(d.retainedHealthyProof) ===
        d.intent.retainedHealthyProofSha256 &&
      await originalPriorNativeFingerprint(d.originalFailedPriorProof) ===
        d.intent.originalFailedPriorNativeSha256;
  } catch {
    return false;
  }
}
export async function readOriginalPriorNativeObservation(
  client: GitHubApiClient,
  row: HostedOwnerSupersessionIntentV1,
) {
  const read = await client.readHostedExecution(
    row.originalFailedPriorExecution,
  );
  if (!read.ok || read.value === null || read.value.outcome === "not_started") {
    return;
  }
  const proof = parseHostedRunProofV1(read.value);
  if (
    proof.outcome !== "failed" || proof.execution.purpose !== "prior" ||
    proof.execution.releaseId !== row.releaseId ||
    proof.execution.revision !== row.fromRevision ||
    proof.execution.generation !== row.fromGeneration ||
    proof.jobId !== row.originalFailedPriorJobId ||
    proof.observedAt > Date.now() ||
    canonicalStringify(proof.execution) !==
      canonicalStringify(row.originalFailedPriorExecution) ||
    await originalPriorNativeFingerprint(proof) !==
      row.originalFailedPriorNativeSha256
  ) return;
  return proof;
}
