/** Explicit pre-activation, no-rule/no-custody authority for legacy launcher fixtures. */
import type { HostedQueueCustodyContext } from "../../ops/hosted-autonomy-queue-context.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { latestPullReview } from "../../src/repair/carried-review.ts";
import { isGitSha } from "../../src/contracts/brands.ts";
import { readTrustedTask } from "../../ops/hosted-autonomy-delivery.ts";
import { queueRecordProtected } from "../../ops/hosted-autonomy-queue-context.ts";
import {
  sameTreeChanges,
  treeChangesDigest,
} from "../../ops/hosted-autonomy-github-trees.ts";
import type { HostedQueueCoordinatorDeps } from "../../ops/hosted-autonomy-queue-contracts.ts";

type DarkQueueFixtureDeps = Pick<HostedAutonomyDepsV1, "state" | "githubFor">;

export function darkQueueFixture(
  rig: DarkQueueFixtureDeps,
): HostedQueueCustodyContext {
  return {
    ready: true,
    proofActivated: false,
    protectedRecordIds: new Set(),
    resolveDelivery: async ({ snapshot, record, expectedRevision }) => {
      const surface = rig.githubFor(record.repository);
      const receipt = latestPullReview(
        snapshot,
        record,
        "ubiquity-sentinel[bot]",
      );
      const task = await readTrustedTask(surface, record);
      const pull = record.target.pr === null
        ? null
        : await surface?.readPull(record.target.pr, "development");
      if (
        queueRecordProtected(record) || receipt === null || task === null ||
        task === "unavailable" ||
        pull?.merged !== true || !isGitSha(pull.mergeCommitSha) ||
        (expectedRevision !== null &&
          expectedRevision !== pull.mergeCommitSha) ||
        record.target.pr === null || record.target.base === null ||
        record.target.head === null
      ) {
        return { status: "unavailable", reason: "not_merged" };
      }
      let carried;
      if (
        receipt.pullRequest.base !== record.target.base ||
        receipt.pullRequest.head !== record.target.head
      ) {
        const reviewed = await surface?.mergeBaseTreeChanges?.(
          receipt.pullRequest.base,
          receipt.pullRequest.head,
        );
        const current = await surface?.mergeBaseTreeChanges?.(
          record.target.base,
          record.target.head,
        );
        if (
          reviewed == null || current == null ||
          current.mergeBase !== record.target.base ||
          !sameTreeChanges(reviewed.changes, current.changes)
        ) {
          return { status: "unavailable", reason: "tree_unavailable" };
        }
        carried = {
          reviewedBase: receipt.pullRequest.base,
          reviewedHead: receipt.pullRequest.head,
          patchDigest: await treeChangesDigest(current.changes),
        };
      }
      return {
        status: "legacy_direct",
        revision: pull.mergeCommitSha,
        ...(carried === undefined ? {} : { carried }),
        binding: {
          repository: record.repository,
          pullRequest: record.target.pr,
          base: record.target.base,
          head: record.target.head,
          reviewRequestId: receipt.requestId,
          reviewReceiptId: receipt.id,
          taskDigest: task.digest,
        },
      };
    },
  };
}

/** Only a positive no-rule read is allowed; unexpected custody fails closed. */
export async function darkQueueCoordinatorFixture(
  rig: DarkQueueFixtureDeps,
): Promise<HostedQueueCoordinatorDeps> {
  const read = await rig.state.readRepair();
  const repository = read.ok && read.value.status === "found"
    ? read.value.snapshot.work.find((row) =>
      row.repository.owner === "ubiquity" && row.repository.name === "ai.ubq.fi"
    )?.repository
    : undefined;
  const unexpected = (): never => {
    throw new Error("dark fixture has no native queue authority");
  };
  return {
    repository: repository ??
      { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
    config: {
      mode: "off",
      proofActivated: false,
      appActor: null,
      probation: true,
    },
    readEffectiveQueueRule: () =>
      Promise.resolve({ status: "complete", value: false }),
    surface: {
      readQueue: unexpected,
      readPullMembership: unexpected,
      readPullEvidence: unexpected,
      enqueue: unexpected,
      poll: unexpected,
      dequeue: unexpected,
    },
    authorization: { readAuthorization: unexpected, readRemoval: unexpected },
    resolveDelivery: darkQueueFixture(rig).resolveDelivery,
  };
}
