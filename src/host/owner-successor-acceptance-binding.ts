/** Exact immutable owner task binding selected by revision/generation, never ordering. */
import { canonicalStringifySha256 } from "../contracts/canonical.ts";
import type { GitSha } from "../contracts/brands.ts";
import type {
  HostedOwnerSuccessorTaskBindingV1,
  HostedReleaseRecordV1,
} from "../contracts/hosted-supervisor.ts";
import { ownerDispositionBinds } from "./owner-install-supersession-original.ts";

export async function ownerSuccessorBindingFor(
  receipt: HostedReleaseRecordV1,
  revision: GitSha,
  generation: number,
) {
  const d = receipt.ownerDisposition;
  if (
    receipt.phase !== "owner_superseded" || !d ||
    !await ownerDispositionBinds(receipt)
  ) return;
  const i = d.intent;
  if (i.toRevision === revision && i.toGeneration === generation) {
    return {
      id: `disposition:${d.intentSha256}`,
      sha256: d.intentSha256,
      binding: {
        releaseId: receipt.id,
        requestSha256: i.requestSha256,
        intentSha256: d.intentSha256,
        successorRevision: i.toRevision,
        successorGeneration: i.toGeneration,
        taskSha256: i.taskSha256,
        issueNumber: i.issueNumber,
        workId: i.workId,
        acceptanceBaseRevision: i.acceptanceBaseRevision,
        controllerSourceRevision: i.controllerSourceRevision,
        controllerCodeSha256: i.controllerCodeSha256,
        ciRevision: i.ciRevision,
      } satisfies HostedOwnerSuccessorTaskBindingV1,
    };
  }
  const matches =
    receipt.ownerSuccessorBindings?.filter((r) =>
      r.binding.successorRevision === revision &&
      r.binding.successorGeneration === generation
    ) ?? [];
  if (matches.length !== 1) return;
  const r = matches[0], b = r.binding;
  const sha256 = await canonicalStringifySha256(b);
  if (
    r.bindingSha256 !== sha256 ||
    r.movementProofSha256 !== await canonicalStringifySha256(r.movementProof) ||
    r.id !== `owner-successor-binding:${sha256}` ||
    b.releaseId !== receipt.id || b.intentSha256 !== d.intentSha256 ||
    b.requestSha256 !== i.requestSha256 || b.taskSha256 !== i.taskSha256 ||
    b.issueNumber !== i.issueNumber || b.workId !== i.workId
  ) return;
  return { id: r.id, sha256, binding: b };
}
