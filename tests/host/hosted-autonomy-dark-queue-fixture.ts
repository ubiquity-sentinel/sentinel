/** Explicit test-owned direct operations; production queue proof stays active. */
import type { HostedQueueCustodyContext } from "../../ops/hosted-autonomy-queue-context.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import { latestPullReview } from "../../src/repair/carried-review.ts";
import { type GitSha, isGitSha } from "../../src/contracts/brands.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../../src/contracts/canonical.ts";
import { readTrustedTask } from "../../ops/hosted-autonomy-delivery.ts";
import { queueRecordProtected } from "../../ops/hosted-autonomy-queue-context.ts";
import {
  type HostedTreeChangeV1,
  sameTreeChanges,
  treeChangesDigest,
} from "../../ops/hosted-autonomy-github-trees.ts";
import type { HostedQueueCoordinatorDeps } from "../../ops/hosted-autonomy-queue-contracts.ts";
import { resolveQueueAwareDelivery } from "../../ops/hosted-autonomy-queue-proof.ts";
import type { QueueBinding } from "../../src/github/merge-queue-types.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";

type DarkQueueFixtureDeps = Pick<HostedAutonomyDepsV1, "state" | "githubFor">;
const APP = {
  type: "Bot" as const,
  nodeId: "FIXTURE_BOT_7",
  login: "ubiquity-sentinel[bot]",
};
/** Synthetic content applied by the modeled operation, never a real GitHub diff. */
export const DIRECT_FIXTURE_CHANGES: readonly HostedTreeChangeV1[] = [{
  path: "src/fixture-fix.ts",
  oldMode: "100644",
  oldSha: "1".repeat(40),
  newMode: "100644",
  newSha: "2".repeat(40),
}];
interface FixtureOperation {
  binding: QueueBinding;
  revision: GitSha;
  pullIdentity: string;
  changes: readonly HostedTreeChangeV1[];
}
const operations = new WeakMap<HostedAutonomyPullV1, FixtureOperation>();

/** Pin the explicit synthetic operation at fixture construction, before later test mutations.
 * Calling the resolver on an arbitrary merged=true response never grants this witness.
 */
export function pinFixtureDirectMerge(
  pull: HostedAutonomyPullV1,
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
  taskDigest: string,
  changes: readonly HostedTreeChangeV1[] = DIRECT_FIXTURE_CHANGES,
): void {
  if (
    record.target.pr === null || record.target.base === null ||
    record.target.head === null || !isGitSha(pull.mergeCommitSha)
  ) return;
  operations.set(pull, {
    binding: {
      repository: structuredClone(record.repository),
      pullRequest: record.target.pr,
      base: record.target.base,
      head: record.target.head,
      reviewRequestId: receipt.requestId,
      reviewReceiptId: receipt.id,
      taskDigest,
    },
    revision: pull.mergeCommitSha,
    pullIdentity: canonicalStringify(pull),
    changes: structuredClone(changes),
  });
}

export function darkQueueFixture(
  rig: DarkQueueFixtureDeps,
): HostedQueueCustodyContext {
  return {
    ready: true,
    proofActivated: false,
    protectedRecordIds: new Set(),
    resolveDelivery: async ({ snapshot, record, expectedRevision }) => {
      const surface = rig.githubFor(record.repository);
      const receipt = latestPullReview(snapshot, record, APP.login);
      const task = await readTrustedTask(surface, record);
      const pull = record.target.pr === null
        ? null
        : await surface?.readPull(record.target.pr, "development");
      if (
        queueRecordProtected(record) || receipt === null || task === null ||
        task === "unavailable" || pull?.merged !== true ||
        !isGitSha(pull.mergeCommitSha) ||
        (expectedRevision !== null &&
          expectedRevision !== pull.mergeCommitSha) ||
        record.target.pr === null || record.target.base === null ||
        record.target.head === null
      ) {
        return { status: "unavailable", reason: "not_merged" };
      }
      const operation = operations.get(pull);
      if (
        operation === undefined ||
        operation.pullIdentity !== canonicalStringify(pull)
      ) {
        return { status: "rejected", reason: "direct_provenance_missing" };
      }
      const binding = {
        repository: record.repository,
        pullRequest: record.target.pr,
        base: record.target.base,
        head: record.target.head,
        reviewRequestId: receipt.requestId,
        reviewReceiptId: receipt.id,
        taskDigest: task.digest,
      };
      const parents = pull.parents;
      if (!parents.every(isGitSha) || !isGitSha(pull.headSha)) {
        return { status: "rejected", reason: "identity_mismatch" };
      }
      const firstParent = parents[0];
      if (!isGitSha(firstParent)) {
        return { status: "rejected", reason: "invalid_parents" };
      }
      const current = surface?.mergeBaseTreeChanges === undefined
        ? { mergeBase: record.target.base, changes: operation.changes }
        : await surface.mergeBaseTreeChanges(
          record.target.base,
          record.target.head,
        );
      const original = receipt.pullRequest.base !== record.target.base ||
          receipt.pullRequest.head !== record.target.head
        ? await surface?.mergeBaseTreeChanges?.(
          receipt.pullRequest.base,
          receipt.pullRequest.head,
        )
        : null;
      if (
        (current != null && !isGitSha(current.mergeBase)) ||
        (original != null && !isGitSha(original.mergeBase))
      ) {
        return { status: "unavailable", reason: "tree_unavailable" };
      }
      const witnessDigest = await canonicalStringifySha256({
        domain: "sentinel.synthetic-direct-operation.v1",
        operation,
      });
      const witnesses = [{
        binding: operation.binding,
        revision: operation.revision,
        witnessDigest,
      }];
      const manifestDigest = await canonicalStringifySha256({
        domain: "sentinel.queue-historical-direct.v1",
        witnesses,
      });
      const actor = (login: string | null | undefined) =>
        login === APP.login
          ? APP
          : login == null
          ? null
          : { type: "User" as const, nodeId: "FIXTURE_USER", login };
      return await resolveQueueAwareDelivery({
        binding,
        record,
        receipt,
        latestReceiptId: receipt.id,
        task,
        optedOut: await surface?.readIssueOptedOut?.(task.issueNumber) ?? false,
        pull: {
          repository: record.repository,
          number: pull.number,
          nodeId: `FIXTURE_PR_${pull.number}`,
          baseRef: pull.baseRef ?? "",
          headRef: record.target.branch ?? "",
          head: pull.headSha,
        },
        publicationAuthor: pull.author ?? "",
        revision: pull.mergeCommitSha,
        mergedBy: actor(pull.mergedBy),
        commit: {
          sha: pull.mergeCommitSha,
          parents,
          author: actor(pull.mergedBy),
        },
        reachable: {
          status: "complete",
          value: {
            revision: pull.mergeCommitSha,
            branch: "development",
            reachable: pull.revisionOnBaseBranch === true,
          },
        },
        ancestry: {
          status: "complete",
          value: {
            ancestor: record.target.base,
            descendant: firstParent,
            isAncestor: pull.baseAncestorOfRevision === true,
          },
        },
        reviewedPatch: current == null || !isGitSha(current.mergeBase)
          ? { status: "unavailable", reason: "incomplete" }
          : {
            status: "complete",
            value: {
              base: record.target.base,
              head: record.target.head,
              ...current,
              mergeBase: current.mergeBase,
            },
          },
        integratedPatch: {
          status: "complete",
          value: {
            base: firstParent,
            head: pull.mergeCommitSha,
            mergeBase: firstParent,
            changes: operation.changes,
          },
        },
        originalPatch: original == null || !isGitSha(original.mergeBase)
          ? null
          : {
            status: "complete",
            value: {
              base: receipt.pullRequest.base,
              head: receipt.pullRequest.head,
              ...original,
              mergeBase: original.mergeBase,
            },
          },
        queue: { status: "complete", value: null },
        anyQueueEvidence: false,
        groupRuns: { status: "complete", value: [] },
        directWitness: {
          binding: operation.binding,
          revision: operation.revision,
          provenance: {
            kind: "historical_exact",
            manifestDigest,
            witnessDigest,
          },
        },
      }, {
        canaryDigest: null,
        appActor: APP,
        mergedActors: [APP],
        workflowId: null,
        historicalDirectManifestDigest: manifestDigest,
        historicalDirectWitnesses: witnesses,
      });
    },
  };
}

/** Historical preactivation grant; use only inside an explicitly dormant production graph. */
export function historicalDarkQueueFixture(
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
  custody: HostedQueueCustodyContext = darkQueueFixture(rig),
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
    resolveDelivery: custody.resolveDelivery,
  };
}
