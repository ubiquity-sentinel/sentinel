/**
 * A delivery-train landing as merged-delivery evidence (sentinel #330).
 *
 * A train member lands on the tip the previous member left, not on its
 * reviewed base, so the exact-base proof (`baseAndHeadAreMerged`) cannot hold
 * for it. Its evidence is the ledger's verified landing instead, re-checked
 * here against the live pull and commit on every read: the pull is merged
 * under exactly the landed revision by a trusted author into the record's
 * base branch, its first (only, for a squash) parent is exactly the tip the
 * landing names, a merge commit's second parent is the reviewed head, the
 * revision is on the base branch and its tree is exactly the train commit's
 * tree recorded at the merge (the CI-tested composition). The receipt and
 * task are bound by the caller (`resolveHostedDelivery`) exactly as for any
 * other foreign delivery. Only foreign, non-Gateway repositories train.
 */
import { hasTakeoverCustody } from "../src/github/existing-pr-takeover-provenance.ts";
import { isGatewayVpsRepository } from "../src/repair/vps-delivery.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  isHostedSelf,
} from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedAutonomyRecordV1,
} from "./hosted-autonomy-types.ts";
import type { DeliveryTrainLandingV1 } from "./hosted-autonomy-train-types.ts";

/** The ledger landing that names exactly this record's merged delivery. */
export async function trainLandingFor(
  deps: Pick<HostedAutonomyDepsV1, "deliveryTrain">,
  record: HostedAutonomyRecordV1,
  revision: string,
): Promise<DeliveryTrainLandingV1 | null> {
  const journal = deps.deliveryTrain?.journal;
  const { pr, head, base } = record.target;
  if (journal === undefined || pr === null || head === null || base === null) {
    return null;
  }
  let read;
  try {
    read = await journal.read(record.repository);
  } catch {
    return null;
  }
  return read?.ledger.landings.find((landing) =>
    landing.recordId === record.id && landing.pullRequest === pr &&
    landing.head === head && landing.base === base &&
    landing.revision === revision
  ) ?? null;
}

/** The landing's live re-check (see the module); null when it fails. */
export async function verifiedTrainDelivery(
  deps: Pick<HostedAutonomyDepsV1, "deliveryTrain">,
  record: HostedAutonomyRecordV1,
  pull: HostedAutonomyPullV1,
  surface: HostedAutonomyGitHubV1 | null,
  baseBranch: string | null,
): Promise<{ revision: string } | null> {
  const head = record.target.head;
  const revision = pull.mergeCommitSha;
  if (
    deps.deliveryTrain === undefined || surface === null ||
    surface.readCommitTree === undefined || isHostedSelf(record.repository) ||
    isGatewayVpsRepository(record.repository) || hasTakeoverCustody(record) ||
    head === null || baseBranch === null || pull.merged !== true ||
    revision === null || pull.headSha !== head ||
    typeof pull.author !== "string" ||
    !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author) ||
    pull.baseRef !== baseBranch || !pull.revisionOnBaseBranch
  ) return null;
  const landing = await trainLandingFor(deps, record, revision);
  if (
    landing === null || pull.parents[0] !== landing.landedOn ||
    !(pull.parents.length === 1 ||
      (pull.parents.length === 2 && pull.parents[1] === head))
  ) return null;
  let tree: string | null = null;
  try {
    tree = await surface.readCommitTree(revision);
  } catch {
    tree = null;
  }
  return tree === landing.tree ? { revision } : null;
}
