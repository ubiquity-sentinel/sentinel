/** Read-only retained publication identity; original author never becomes merge actor authority. */
import { isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  ExistingPrTakeoverPort,
  TakeoverBinding,
  TakeoverPublicationProof,
  TakeoverPublicationRequest,
} from "../contracts/existing-pr-takeover.ts";
import {
  type Clock,
  portError,
  portOk,
  type StateReadView,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { reviewTaskStatementDigest } from "../contracts/review-task-acceptance.ts";
import type { GitHubPrAssociationsClient } from "./client-pr-associations.ts";
import type { TakeoverProofDependencies } from "./existing-pr-takeover-proof.ts";
import {
  hasTakeoverCustody,
  readTakeoverAnchor,
  takeoverBindingDigest,
} from "./existing-pr-takeover-provenance.ts";

const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
const proofs = new WeakMap<
  object,
  { record: string; revision: string; author: string; live(): boolean }
>();
const unavailable = () =>
  portError("unavailable", "existing PR publication custody unavailable");

/** A copied/serialized proof cannot supply the original-publication identity alternative. */
export function takeoverPublicationMatches(
  proof: TakeoverPublicationProof | undefined,
  record: WorkRecordV1,
  revision: string,
  author: string,
): boolean {
  try {
    if (proof === undefined) return false;
    const saved = proofs.get(proof);
    return saved !== undefined && saved.live() &&
      saved.record === canonicalStringify(record) &&
      saved.revision === revision && saved.author === author;
  } catch {
    return false;
  }
}

export function createTakeoverPublicationReader(input: {
  repository: RepositoryIdentityV1;
  baseBranch: string;
  state: Pick<StateReadView, "readRepair" | "readRepairAt">;
  clock: Clock;
  client: Pick<
    GitHubPrAssociationsClient,
    "readIssuePullAssociations" | "readAssociationPull" | "readQueueLegacyPull"
  >;
  readCandidate: TakeoverProofDependencies["readCandidate"];
}): ExistingPrTakeoverPort["resolvePublication"] {
  return async (raw: TakeoverPublicationRequest) => {
    try {
      const request = structuredClone(raw);
      const { record } = request;
      const live = () =>
        Number.isSafeInteger(request.deadline) &&
        input.clock.now() < request.deadline;
      if (
        !live() || !isGitSha(request.revision) ||
        !isGitSha(request.expectedStateHead) ||
        !hasTakeoverCustody(record) ||
        !same(record.repository, input.repository) ||
        record.source.kind !== "issue" || record.related.issueNumber === null ||
        record.source.id !== String(record.related.issueNumber) ||
        record.related.incidentId !== null ||
        record.target.pr === null || record.target.head === null ||
        record.target.branch === null ||
        record.target.candidateState?.publishedHead !== record.target.head ||
        !same(request.snapshot.work.find((row) => row.id === record.id), record)
      ) return unavailable();
      const before = await input.state.readRepair();
      if (
        !before.ok || before.value.status !== "found" ||
        before.value.head !== request.expectedStateHead ||
        !same(before.value.snapshot, request.snapshot)
      ) return unavailable();
      const anchor = await readTakeoverAnchor({
        ...request,
        state: input.state,
      });
      if (anchor === null) return unavailable();
      const [source, pull, merged] = await Promise.all([
        input.client.readIssuePullAssociations(
          record.related.issueNumber,
          request.deadline,
        ),
        input.client.readAssociationPull(record.target.pr, request.deadline),
        input.client.readQueueLegacyPull(record.target.pr, request.deadline),
      ]);
      if (
        !live() || source.status !== "complete" || pull.status !== "complete" ||
        merged.status !== "complete"
      ) return unavailable();
      const issue = source.value.issue;
      const native = pull.value;
      const exact = (repo: { owner: string; name: string }) =>
        repo.owner === input.repository.owner &&
        repo.name === input.repository.name;
      if (
        issue.number !== record.related.issueNumber ||
        !exact(issue.repository) ||
        native.state !== "merged" || native.number !== record.target.pr ||
        native.head !== record.target.head ||
        native.headRef !== record.target.branch ||
        native.baseRef !== input.baseBranch ||
        !exact(native.repository) || !exact(native.baseRepository) ||
        native.headRepository === null || !exact(native.headRepository) ||
        merged.value.pull.state !== "merged" ||
        merged.value.pull.number !== record.target.pr ||
        merged.value.pull.mergeSha !== request.revision ||
        merged.value.pull.head !== record.target.head ||
        merged.value.pull.headRef !== record.target.branch ||
        merged.value.pull.baseRef !== input.baseBranch ||
        merged.value.pull.author !== native.author.login
      ) return unavailable();
      // The original authenticated association is retained in the immutable anchor.
      // A merged PR may disappear from the OPEN association list; that absence never
      // becomes authority. Reconstruct every original identity and task digest instead.
      const binding: TakeoverBinding = {
        repository: input.repository,
        taskId: record.id,
        issueNumber: issue.number,
        issueNodeId: issue.nodeId,
        issueDigest: await reviewTaskStatementDigest({
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body,
        }),
        pullRequest: native.number,
        pullNodeId: native.nodeId,
        headRepositoryId: native.headRepository.nodeId,
        headRepository: {
          owner: native.headRepository.owner,
          name: native.headRepository.name,
        },
        headRef: native.headRef,
        baseRef: native.baseRef,
        author: native.author.login,
      };
      if (await takeoverBindingDigest(binding) !== anchor.bindingDigest) {
        return unavailable();
      }
      const candidate = await input.readCandidate({
        record,
        snapshot: request.snapshot,
        expectedStateHead: request.expectedStateHead,
        expectedHead: record.target.head,
        operation: "review",
        deadline: request.deadline,
        anchor,
      });
      if (
        !candidate.ok || !candidate.value.anchorRestored ||
        !candidate.value.currentDescendsFromAnchor ||
        candidate.value.currentHead !== record.target.head ||
        candidate.value.currentBase !== record.target.base
      ) return unavailable();
      const original = record.target.head === anchor.record.target.head &&
        record.target.base === anchor.record.target.base;
      if (
        original
          ? candidate.value.custody?.kind !== "native" ||
            record.target.candidateState.preserved !== null
          : candidate.value.custody === null ||
            candidate.value.custody.kind === "native" ||
            record.target.candidateState.preserved === null ||
            !same(
              candidate.value.custody.candidate,
              record.target.candidateState.preserved,
            )
      ) return unavailable();
      const [finalSource, finalPull, finalMerge, after] = await Promise.all([
        input.client.readIssuePullAssociations(issue.number, request.deadline),
        input.client.readAssociationPull(native.number, request.deadline),
        input.client.readQueueLegacyPull(native.number, request.deadline),
        input.state.readRepair(),
      ]);
      if (
        !live() || !same(source, finalSource) || !same(pull, finalPull) ||
        !same(merged, finalMerge) ||
        !after.ok || after.value.status !== "found" ||
        after.value.head !== before.value.head ||
        !same(after.value.snapshot, before.value.snapshot)
      ) return unavailable();
      const expires = Math.min(request.deadline, input.clock.now() + 30_000);
      const proof: TakeoverPublicationProof = Object.freeze({
        kind: "verified_existing_pr_publication",
      });
      proofs.set(proof, {
        record: canonicalStringify(record),
        revision: request.revision,
        author: native.author.login,
        live: () => input.clock.now() < expires,
      });
      return portOk(proof);
    } catch {
      return unavailable();
    }
  };
}
