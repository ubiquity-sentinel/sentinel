/** Native task/PR discovery. Text references select observations, never write authority. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  NativeTakeoverObservation,
  TakeoverDiscovery,
  TakeoverParkReason,
} from "../contracts/existing-pr-takeover.ts";
import type { Clock, GitHubPort, PortResultV1 } from "../contracts/ports.ts";
import {
  checkReviewTaskStatement,
  reviewTaskStatementDigest,
} from "../contracts/review-task-acceptance.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { GitHubPrAssociationsClient } from "../github/client-pr-associations.ts";
import type { NativeAssociationPull } from "../github/pr-association-wire.ts";
import { takeoverBindingDigest } from "../github/existing-pr-takeover-provenance.ts";

export interface TakeoverDiscoveryDependencies {
  repository: RepositoryIdentityV1;
  baseBranch: string;
  clock: Clock;
  client: Pick<
    GitHubPrAssociationsClient,
    | "readIssuePullAssociations"
    | "readAssociationPull"
    | "readPullClosingIssues"
    | "readProtections"
    | "readBranchRules"
  >;
  port: Pick<GitHubPort, "readRef" | "nativeQueue">;
  /** Trusted Contents-write grant for this fixed repository; absence never implies it. */
  contentsWriteAllowed(): boolean;
  inspectNativeGit(
    pull: NativeAssociationPull,
    deadline: number,
  ): Promise<PortResultV1<{ protectedPathsClear: boolean }>>;
  /** Trusted enqueue-only observer: exact owned intent plus complete native absence. */
  observeQueueAdmission?: (
    pull: NativeAssociationPull,
    deadline: number,
  ) => Promise<boolean>;
}

const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
const repositoryMatches = (
  a: { owner: string; name: string },
  b: { owner: string; name: string },
) => a.owner === b.owner && a.name === b.name;
const unavailable = (
  reason: "source" | "pagination" | "deadline" | "identity",
): TakeoverDiscovery => ({ status: "unavailable", reason });
const park = (
  reason: TakeoverParkReason,
  prNumbers: number[],
): TakeoverDiscovery => ({ status: "owner_park", reason, prNumbers });

/** Explicit PR forms only. A bare #N may be an issue and is never inferred. */
export function explicitPullReferences(
  text: string,
  repository: RepositoryIdentityV1,
): { numbers: number[]; foreign: boolean; invalid: boolean } {
  const numbers = new Set<number>();
  let foreign = false;
  let invalid = false;
  const add = (value: string) => {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) invalid = true;
    else numbers.add(number);
  };
  for (
    const match of text.matchAll(
      /https?:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/pull\/(\d+)(?=$|[\s/#?.,;)\]])/gi,
    )
  ) {
    if (
      match[1].toLowerCase() !== repository.owner.toLowerCase() ||
      match[2].toLowerCase() !== repository.name.toLowerCase()
    ) foreign = true;
    else add(match[3]);
  }
  for (
    const match of text.matchAll(/\b(?:PR|pull\s+request)\s*#(\d+)\b/gi)
  ) add(match[1]);
  if (numbers.size > 100) invalid = true;
  return { numbers: [...numbers].sort((a, b) => a - b), foreign, invalid };
}

/** Complete discovery is required again before each later custody proof/effect. */
export function createTakeoverDiscovery(deps: TakeoverDiscoveryDependencies) {
  return async (
    input: { record: WorkRecordV1; deadline: number },
  ): Promise<TakeoverDiscovery> => {
    const live = () =>
      Number.isSafeInteger(input.deadline) &&
      deps.clock.now() < input.deadline;
    try {
      const record = input.record;
      const issueNumber = record.related.issueNumber;
      if (!live()) return unavailable("deadline");
      if (
        !same(record.repository, deps.repository) ||
        record.source.kind !== "issue" || issueNumber === null ||
        record.source.id !== String(issueNumber) ||
        record.related.incidentId !== null
      ) return unavailable("identity");
      const source = await deps.client.readIssuePullAssociations(
        issueNumber,
        input.deadline,
      );
      if (!live()) return unavailable("deadline");
      if (source.status !== "complete") return unavailable("source");
      const { issue } = source.value;
      if (
        issue.number !== issueNumber || issue.state !== "open" ||
        !repositoryMatches(issue.repository, deps.repository)
      ) return unavailable("source");
      const issueDigest = await reviewTaskStatementDigest({
        issueNumber,
        title: issue.title,
        body: issue.body,
      });
      if (
        !(await checkReviewTaskStatement({
          issueNumber,
          title: issue.title,
          body: issue.body,
          digest: issueDigest,
        })).ok
      ) return unavailable("source");
      const refs = explicitPullReferences(
        `${issue.title}\n${issue.body}`,
        deps.repository,
      );
      if (refs.invalid) return unavailable("identity");
      if (refs.foreign) return park("foreign_repository", refs.numbers);
      const numbers = new Set(refs.numbers);
      for (const pull of source.value.pulls) {
        if (!repositoryMatches(pull.repository, deps.repository)) {
          return park("foreign_repository", [pull.number]);
        }
        numbers.add(pull.number);
      }
      if (record.target.pr !== null) numbers.add(record.target.pr);
      if (numbers.size > 100) return unavailable("pagination");
      const open: NativeAssociationPull[] = [];
      for (const number of numbers) {
        const pull = await deps.client.readAssociationPull(
          number,
          input.deadline,
        );
        if (!live()) return unavailable("deadline");
        if (pull.status !== "complete") return unavailable("identity");
        const native = source.value.pulls.filter((p) => p.number === number);
        const { author: _, ...identity } = pull.value;
        if (
          native.length > 0 &&
          (native.length !== 1 || !same(native[0], identity))
        ) return park("head_moved", [number]);
        if (pull.value.state === "open") open.push(pull.value);
      }
      if (open.length > 1) return park("ambiguous", open.map((p) => p.number));
      // Even the negative answer is source-bound and reobserved, never a failed read.
      const finalSource = await deps.client.readIssuePullAssociations(
        issueNumber,
        input.deadline,
      );
      if (!live()) return unavailable("deadline");
      if (finalSource.status !== "complete") return unavailable("source");
      if (!same(source.value, finalSource.value)) {
        return park("source_changed", open.map((p) => p.number));
      }
      if (open.length === 0) return { status: "none", issueDigest };
      const pull = open[0];
      const prs = [pull.number];
      const linked = source.value.pulls.filter((p) =>
        p.number === pull.number && p.nodeId === pull.nodeId
      );
      if (linked.length !== 1) return park("association_unproven", prs);
      const reciprocal = await deps.client.readPullClosingIssues(
        pull.number,
        input.deadline,
      );
      if (!live()) return unavailable("deadline");
      if (reciprocal.status !== "complete") return unavailable("identity");
      const { author: _, ...identity } = pull;
      if (
        !same(reciprocal.value.pull, identity) || !same(linked[0], identity)
      ) {
        return park("head_moved", prs);
      }
      if (
        reciprocal.value.issues.filter((i) =>
          i.nodeId === issue.nodeId && i.number === issueNumber &&
          same(i.repository, issue.repository)
        ).length !== 1
      ) return park("association_unproven", prs);
      if (
        !repositoryMatches(pull.repository, deps.repository) ||
        !same(pull.baseRepository, issue.repository)
      ) return park("foreign_repository", prs);
      if (
        pull.headRepository === null ||
        !same(pull.headRepository, issue.repository)
      ) return park("fork_head", prs);
      if (pull.baseRef !== deps.baseBranch) {
        return park("custody_unproven", prs);
      }
      if (
        record.target.pr === null && record.target.head !== null &&
        record.target.head !== pull.head
      ) return park("candidate_divergent", prs);
      if (
        record.target.pr !== null &&
        (record.target.pr !== pull.number ||
          record.target.branch !== pull.headRef)
      ) return park("candidate_divergent", prs);
      const binding = {
        repository: deps.repository,
        taskId: record.id,
        issueNumber,
        issueNodeId: issue.nodeId,
        issueDigest,
        pullRequest: pull.number,
        pullNodeId: pull.nodeId,
        headRepositoryId: pull.headRepository.nodeId,
        headRepository: {
          owner: pull.headRepository.owner,
          name: pull.headRepository.name,
        },
        headRef: pull.headRef,
        baseRef: pull.baseRef,
        author: pull.author.login,
      };
      await takeoverBindingDigest(binding); // Also validates bounded branch/identity text.
      if (!deps.contentsWriteAllowed()) return park("unwritable_branch", prs);
      const protections = await deps.client.readProtections(pull.headRef);
      const rules = await deps.client.readBranchRules(pull.headRef);
      if (!live()) return unavailable("deadline");
      if (!protections.ok || !rules.ok) return unavailable("identity");
      if (protections.value.protected || rules.value.length > 0) {
        return park("unwritable_branch", prs);
      }
      const branch = await deps.port.readRef(`refs/heads/${pull.headRef}`);
      const base = await deps.port.readRef(`refs/heads/${pull.baseRef}`);
      if (!live()) return unavailable("deadline");
      if (!branch.ok || !base.ok) return unavailable("identity");
      if (branch.value?.sha !== pull.head || base.value?.sha !== pull.base) {
        return park("head_moved", prs);
      }
      const queueClear = deps.observeQueueAdmission === undefined
        ? (await deps.port.nativeQueue?.inspectEffect({
          operation: "publication",
          branch: pull.headRef,
          pullRequest: pull.number,
          expectedHead: pull.head,
          deadline: input.deadline,
        }))?.status === "allow"
        : await deps.observeQueueAdmission(pull, input.deadline);
      if (!queueClear) return park("queue_custody", prs);
      const git = await deps.inspectNativeGit(pull, input.deadline);
      if (!live()) return unavailable("deadline");
      if (!git.ok) return unavailable("identity");
      if (!git.value.protectedPathsClear) return park("protected_path", prs);
      const finalPull = await deps.client.readAssociationPull(
        pull.number,
        input.deadline,
      );
      if (!live()) return unavailable("deadline");
      if (finalPull.status !== "complete") return unavailable("identity");
      if (!same(finalPull.value, pull)) return park("head_moved", prs);
      const finalIssue = await deps.client.readIssuePullAssociations(
        issueNumber,
        input.deadline,
      );
      if (!live()) return unavailable("deadline");
      if (finalIssue.status !== "complete") return unavailable("source");
      if (!same(finalIssue.value, source.value)) {
        return park("source_changed", prs);
      }
      const candidate: NativeTakeoverObservation = {
        binding,
        head: pull.head,
        base: pull.base,
        state: "open",
        issueOpen: true,
        associationComplete: true,
        associated: true,
        reciprocalComplete: true,
        reciprocalIssues: reciprocal.value.issues.map((i) => ({
          number: i.number,
          nodeId: i.nodeId,
          repository: { owner: i.repository.owner, name: i.repository.name },
        })),
        openCandidates: [{ number: pull.number, nodeId: pull.nodeId }],
        headRefExists: true,
        sameRepository: true,
        writableBranch: true,
        protectedPathsClear: true,
        queueCustodyClear: true,
      };
      return { status: "candidate", candidate };
    } catch {
      return unavailable(live() ? "identity" : "deadline");
    }
  };
}
