import type { TakeoverPublicationProof } from "../contracts/existing-pr-takeover.ts";
import { hasTakeoverCustody } from "./existing-pr-takeover-provenance.ts";
import { takeoverPublicationMatches } from "./existing-pr-publication-proof.ts";
import { hasQueueDeliveryProvenance } from "./queue-delivery-provenance.ts";
/** One authenticated fact collector shared by launcher and native delivery guards. */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { Clock } from "../contracts/ports.ts";
import {
  checkReviewTaskStatement,
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  latestPullReview,
  reviewedIdentity,
} from "../repair/carried-review.ts";
import { decideCiGate } from "../repair/loop-checks.ts";
import { reviewAuthorizesMerge } from "../repair/review-gate.ts";
import {
  hasQueueIntentNamespace,
  isQueueHeld,
} from "../../ops/hosted-autonomy-queue-policy.ts";
import type {
  DirectMergeWitness,
  QueueDeliveryFacts,
  QueueProofPolicy,
  QueueProvenanceFact,
} from "../../ops/hosted-autonomy-queue-proof.ts";
import { HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR } from "../../ops/hosted-autonomy-policy.ts";
import type { GitHubQueueDeliveryClient } from "./client-queue-delivery.ts";
import { createDeadline } from "./http.ts";
import type {
  QueueBinding,
  QueueEvidence,
  QueuePullIdentity,
  QueueRead,
} from "./merge-queue-types.ts";

export interface QueueBindingObservation {
  binding: QueueBinding;
  receipt: ReviewReceiptV1;
  task: ReviewTaskStatementV1;
  optedOut: boolean;
  sourceOpen: boolean;
}
export interface QueueAuthorizationBasis {
  binding: QueueBinding;
  pull: QueuePullIdentity;
  receipt: ReviewReceiptV1;
  task: ReviewTaskStatementV1;
  optedOut: boolean;
  sourceOpen: boolean;
  headCiGreen: boolean;
  reviewAuthorized: boolean;
}
export interface QueueReaderRequest {
  record: WorkRecordV1;
  snapshot: RepairStateSnapshotV1;
  deadline: number;
}
export interface QueueDeliveryReadRequest extends QueueReaderRequest {
  /** Expected immutable admission evidence; independently rechecked against state/live source. */
  receipt: ReviewReceiptV1;
  currentTask: ReviewTaskStatementV1 | null | "unavailable";
  revision: GitSha;
  now: number;
}
export interface QueueDeliveryReaderOptions {
  repository: RepositoryIdentityV1;
  clock: Clock;
  client: GitHubQueueDeliveryClient;
  policy: QueueProofPolicy;
  /** Read-only retained publication identity; this never supplies effect authority. */
  publication?: (
    input: QueueReaderRequest & { revision: GitSha },
  ) => Promise<QueueRead<TakeoverPublicationProof>>;
  /** Strict coordinator codec binds native events to the retained admission, never list order. */
  provenance?: (
    input: QueueReaderRequest & {
      binding: QueueBinding;
      evidence: QueueEvidence;
      revision: GitSha;
    },
  ) => Promise<QueueRead<QueueProvenanceFact | null>>;
  /** Actual authenticated operation witness or exact pinned historical grant; absence grants nothing. */
  directWitness?: (
    input: QueueReaderRequest & { binding: QueueBinding; revision: GitSha },
  ) => Promise<QueueRead<DirectMergeWitness | null>>;
}
export interface QueueDeliveryReader {
  readPublication?(
    input: QueueReaderRequest & { revision: GitSha },
  ): Promise<QueueRead<TakeoverPublicationProof | null>>;
  readBinding(
    input: QueueReaderRequest,
  ): Promise<QueueRead<QueueBindingObservation>>;
  readAuthorizationBasis(
    input: QueueReaderRequest,
  ): Promise<QueueRead<QueueAuthorizationBasis>>;
  read(input: QueueDeliveryReadRequest): Promise<QueueRead<QueueDeliveryFacts>>;
}
const REQUIRED = [
  "validate",
  "verify-artifact",
  "darwin-native",
  "mac-containment",
];
const unavailable = (
  reason: "drift" | "incomplete" | "deadline" | "unsupported" = "incomplete",
): QueueRead<never> => ({ status: "unavailable", reason });
const equal = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);

export function createQueueDeliveryReader(
  options: QueueDeliveryReaderOptions,
): QueueDeliveryReader {
  const { client, clock, repository } = options;
  async function bounded<T>(
    until: number,
    run: () => Promise<QueueRead<T>>,
  ): Promise<QueueRead<T>> {
    const remaining = until - clock.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      return unavailable("deadline");
    }
    const deadline = createDeadline(remaining);
    try {
      return await deadline.race(run());
    } catch {
      return unavailable(deadline.fired() ? "deadline" : "incomplete");
    } finally {
      deadline.dispose();
    }
  }
  async function readPublication(
    input: QueueReaderRequest & { revision: GitSha },
  ): Promise<QueueRead<TakeoverPublicationProof | null>> {
    if (!hasTakeoverCustody(input.record)) {
      return { status: "complete", value: null };
    }
    return options.publication === undefined
      ? unavailable()
      : await options.publication(input);
  }
  async function readBinding(
    input: QueueReaderRequest,
  ): Promise<QueueRead<QueueBindingObservation>> {
    const { record, snapshot } = input;
    if (
      !equal(repository, record.repository) ||
      repository.owner !== "ubiquity" || repository.name !== "ai.ubq.fi" ||
      !equal(
        snapshot.work.find((row) => row.id === record.id) ?? null,
        record,
      ) || record.target.pr === null ||
      record.target.head === null || record.target.base === null ||
      record.related.issueNumber === null
    ) return unavailable("drift");
    const receipt = latestPullReview(
      snapshot,
      record,
      HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
    );
    if (receipt === null) return unavailable();
    const issue = await client.readIssue(record.related.issueNumber);
    if (
      !issue.ok || issue.value === null ||
      issue.value.number !== record.related.issueNumber
    ) return unavailable();
    const text = {
      issueNumber: issue.value.number,
      title: issue.value.title,
      body: issue.value.body,
    };
    const checked = await checkReviewTaskStatement({
      ...text,
      digest: await reviewTaskStatementDigest(text),
    });
    if (!checked.ok) return unavailable();
    const task = checked.statement;
    const binding: QueueBinding = {
      repository,
      pullRequest: record.target.pr,
      base: record.target.base,
      head: record.target.head,
      reviewRequestId: receipt.requestId,
      reviewReceiptId: receipt.id,
      taskDigest: task.digest,
    };
    return {
      status: "complete",
      value: {
        binding,
        receipt,
        task,
        optedOut:
          issue.value.labels.some((label) =>
            label.toLowerCase() === "sentinel:skip"
          ) || /^<!-- sentinel:skip -->(?:\r?\n|$)/.test(issue.value.body),
        sourceOpen: issue.value.state === "open",
      },
    };
  }
  async function basis(
    input: QueueReaderRequest,
  ): Promise<QueueRead<QueueAuthorizationBasis>> {
    const binding = await readBinding(input);
    if (binding.status !== "complete") return binding;
    const { record, deadline } = input;
    const { receipt, task } = binding.value;
    const pull = await client.readQueuePull(
      binding.value.binding.pullRequest,
      deadline,
    );
    if (pull.status !== "complete") return pull;
    if (
      pull.value.membership.pull.head !== record.target.head ||
      pull.value.membership.pull.headRef !== record.target.branch ||
      pull.value.membership.pull.baseRef !== "development"
    ) return unavailable("drift");
    const checks = await client.readBaseReviewChecks(
      binding.value.binding.head,
      REQUIRED,
    );
    if (!checks.ok || checks.value.head !== record.target.head) {
      return unavailable();
    }
    const allChecks = await client.readChecks(binding.value.binding.head);
    if (!allChecks.ok || allChecks.value.head !== record.target.head) {
      return unavailable();
    }
    return {
      status: "complete",
      value: {
        ...binding.value,
        pull: pull.value.membership.pull,
        headCiGreen:
          REQUIRED.every((name) =>
            checks.value.checks.some((check) => check.name === name)
          ) &&
          decideCiGate(checks.value.checks) === "proceed" &&
          decideCiGate(allChecks.value.checks) === "proceed",
        reviewAuthorized: reviewAuthorizesMerge(
          receipt,
          reviewedIdentity(record, receipt),
          HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
          task,
        ),
      },
    };
  }
  async function read(
    input: QueueDeliveryReadRequest,
  ): Promise<QueueRead<QueueDeliveryFacts>> {
    const initial = await basis(input);
    if (initial.status !== "complete") return initial;
    const { binding, receipt, task, optedOut } = initial.value;
    if (
      !equal(input.receipt, receipt) || !equal(input.currentTask, task) ||
      input.now > clock.now()
    ) return unavailable("drift");
    const pull = await client.readQueuePull(
      binding.pullRequest,
      input.deadline,
    );
    if (pull.status !== "complete") return pull;
    if (
      !equal(pull.value.membership.pull, initial.value.pull) ||
      pull.value.membership.mergedRevision !== input.revision
    ) return unavailable("drift");
    const commit = await client.readQueueCommit(input.revision, input.deadline);
    if (commit.status !== "complete") return commit;
    if (commit.value.parents.length !== 2) {
      return { status: "invalid", reason: "identity_mismatch" };
    }
    const parent = commit.value.parents[0];
    const tip = await client.readRef("refs/heads/development");
    if (!tip.ok || tip.value === null) return unavailable();
    const reachable = await client.readQueueAncestry(
      input.revision,
      tip.value.sha,
      input.deadline,
    );
    const ancestry = await client.readQueueAncestry(
      binding.base,
      parent,
      input.deadline,
    );
    const reviewedPatch = await client.readQueuePatch(
      binding.base,
      binding.head,
      input.deadline,
    );
    const integratedPatch = await client.readQueuePatch(
      parent,
      input.revision,
      input.deadline,
    );
    // The queue predecessor may change workflow meaning without touching this PR's patch.
    // Retain an unavailable fact: only the shared queue proof requires this witness.
    const workflow = await client.readQueueWorkflowDigest(
      input.revision,
      input.deadline,
    );
    const carried = receipt.pullRequest.base !== binding.base ||
      receipt.pullRequest.head !== binding.head;
    const originalPatch = carried
      ? await client.readQueuePatch(
        receipt.pullRequest.base,
        receipt.pullRequest.head,
        input.deadline,
      )
      : null;
    const evidence = await client.readPullEvidence(initial.value.pull);
    if (evidence.status !== "complete") return evidence;
    const anyQueueEvidence = evidence.value.entry !== null ||
      evidence.value.added.length > 0 || evidence.value.removed.length > 0 ||
      evidence.value.mergeGroupRuns.length > 0;
    const custody = isQueueHeld(input.record) ||
      hasQueueIntentNamespace(input.record) ||
      hasQueueDeliveryProvenance(input.record);
    let queue: QueueRead<QueueProvenanceFact | null>;
    if (!anyQueueEvidence && !custody) {
      queue = { status: "complete", value: null };
    } else if (options.provenance === undefined) queue = unavailable();
    else {
      queue = await options.provenance({
        ...input,
        binding,
        evidence: evidence.value,
      });
      if (queue.status === "complete" && queue.value === null) {
        queue = unavailable();
      }
    }
    const witness = options.directWitness === undefined
      ? { status: "complete" as const, value: null }
      : await options.directWitness({
        ...input,
        binding,
        revision: input.revision,
      });
    if (witness.status !== "complete") return witness;
    const publication = await readPublication(input);
    if (publication.status !== "complete") return publication;
    if (
      hasTakeoverCustody(input.record) &&
      !takeoverPublicationMatches(
        publication.value ?? undefined,
        input.record,
        input.revision,
        pull.value.author,
      )
    ) return unavailable("drift");
    // Re-read mutable source/PR after expensive tree/evidence collection. No stale observation grants a write.
    const final = await basis(input);
    if (final.status !== "complete") return final;
    if (!equal(initial.value, final.value)) return unavailable("drift");
    const finalPull = await client.readQueuePull(
      binding.pullRequest,
      input.deadline,
    );
    if (finalPull.status !== "complete") return finalPull;
    if (!equal(pull.value, finalPull.value)) return unavailable("drift");
    return {
      status: "complete",
      value: {
        binding,
        record: input.record,
        receipt,
        latestReceiptId: final.value.receipt.id,
        task,
        optedOut,
        pull: initial.value.pull,
        publicationAuthor: pull.value.author,
        ...(publication.value === null
          ? {}
          : { publicationProof: publication.value }),
        revision: input.revision,
        mergedBy: pull.value.mergedBy,
        commit: commit.value,
        reachable: reachable.status === "complete"
          ? {
            status: "complete",
            value: {
              revision: input.revision,
              branch: "development",
              reachable: reachable.value.isAncestor,
            },
          }
          : reachable,
        ancestry,
        reviewedPatch,
        integratedPatch,
        originalPatch,
        queue,
        anyQueueEvidence,
        groupRuns: { status: "complete", value: evidence.value.mergeGroupRuns },
        workflow,
        directWitness: witness.value,
      },
    };
  }
  return {
    readPublication: (input) =>
      bounded(input.deadline, () => readPublication(input)),
    readBinding: (input) => bounded(input.deadline, () => readBinding(input)),
    readAuthorizationBasis: (input) =>
      bounded(input.deadline, () => basis(input)),
    read: (input) => bounded(input.deadline, () => read(input)),
  };
}
