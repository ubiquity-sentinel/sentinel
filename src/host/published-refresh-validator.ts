/** Root-only fresh-store proof of an already-published deterministic refresh. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { Clock, GitHubCooldownGateV1 } from "../contracts/ports.ts";
import type {
  CandidatePreservationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { DenoGitExecutor } from "../github/git-executor.ts";
import { GitReviewSnapshot } from "../github/review-snapshot.ts";
import { headerMap, type HttpTransportV1 } from "../github/http.ts";
import { DenoReplayRuntime, type ReplayRuntimeV1 } from "../replay/runtime.ts";
import { freshStoreProof } from "./actions-candidates-proof.ts";
import type { PreserverGitRunV1 } from "./actions-candidates-objects.ts";
import { githubGitAuthEnv } from "./local-github-auth.ts";
import { createLocalRepositoryConfig } from "./local-config.ts";
import { selectTrustedTargetPolicyV1 } from "./target-policy.ts";
import { APP_LOGIN } from "./actions-target-cycles.ts";

export interface PublishedRefreshValidationInput {
  record: WorkRecordV1;
  candidate: CandidatePreservationV1;
  deadline: number;
}

const QUERY =
  `query($owner:String!,$name:String!,$number:Int!,$issue:Int!,$after:String){
  repository(owner:$owner,name:$name){
    issue(number:$issue){number state title body updatedAt
      assignees(first:100){nodes{login}pageInfo{hasNextPage}}
      labels(first:100){nodes{name}pageInfo{hasNextPage}}}
    pullRequest(number:$number){id number state body headRefOid baseRefOid headRefName baseRefName
      author{__typename login} repository{name owner{login}}
      headRepository{name owner{login}} baseRepository{name owner{login}}
      timelineItems(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor}
        nodes{__typename ...on Node{id}}}}
  }} `;

/** No model-facing port or write capability is returned. Tests replace transport/remote only. */
export function createPublishedRefreshValidator(input: {
  repository: RepositoryIdentityV1;
  token: string;
  clock: Clock;
  gate: GitHubCooldownGateV1;
  http: HttpTransportV1;
  runtime?: ReplayRuntimeV1;
  remoteUrl?: string;
  /** Task-owned private scratch; omitted production callers use the OS temporary directory. */
  scratch?: string;
}) {
  const remote = input.remoteUrl ??
    `https://github.com/${input.repository.owner}/${input.repository.name}.git`;
  if (input.remoteUrl !== undefined && !remote.startsWith("file:///")) {
    throw new TypeError("published refresh test remote must be local");
  }
  return async (
    { record, candidate, deadline }: PublishedRefreshValidationInput,
  ): Promise<boolean> => {
    const live = () =>
      Number.isSafeInteger(deadline) && input.clock.now() < deadline;
    const sameRepository = (
      value: { name?: unknown; owner?: { login?: unknown } } | null,
    ) =>
      value?.name === input.repository.name &&
      value.owner?.login === input.repository.owner;
    async function facts(): Promise<string | null> {
      let after: string | null = null,
        identity: string | null = null,
        total: number | null = null;
      const ids = new Set<string>(), cursors = new Set<string>();
      for (let page = 0; page < 16 && live(); page++) {
        if (
          !(await input.gate.beforeRequest(input.repository.installationId)).ok
        ) return null;
        const response = await input.http({
          method: "POST",
          url: "https://api.github.com/graphql",
          redirect: "error",
          headers: headerMap({
            authorization: `Bearer ${input.token}`,
            "content-type": "application/json",
          }),
          body: JSON.stringify({
            query: QUERY,
            variables: {
              owner: input.repository.owner,
              name: input.repository.name,
              number: record.target.pr,
              issue: record.related.issueNumber,
              after,
            },
          }),
          deadlineMs: Math.min(30_000, deadline - input.clock.now()),
        });
        if (
          !live() || response.status !== 200 ||
          response.bodyText.length > 1024 * 1024
        ) return null;
        const body = JSON.parse(response.bodyText);
        if (
          body.errors !== undefined &&
          (!Array.isArray(body.errors) || body.errors.length > 0)
        ) return null;
        const { issue, pullRequest: pull } = body.data.repository;
        if (
          issue?.number !== record.related.issueNumber ||
          issue.state !== "OPEN" ||
          typeof issue.title !== "string" || typeof issue.body !== "string" ||
          issue.title.length > 1024 || issue.body.length > 65_536 ||
          issue.assignees?.pageInfo?.hasNextPage !== false ||
          issue.labels?.pageInfo?.hasNextPage !== false ||
          !Array.isArray(issue.labels.nodes) ||
          issue.labels.nodes.some((label: { name: string }) =>
            label.name.toLowerCase() === "sentinel:skip"
          ) ||
          /^<!-- sentinel:skip -->(?:\r?\n|$)/.test(issue.body) ||
          pull?.number !== record.target.pr || pull.state !== "OPEN" ||
          pull.body !== `Resolves #${record.related.issueNumber}` ||
          pull.headRefOid !== candidate.head ||
          pull.baseRefOid !== candidate.base ||
          pull.headRefName !== record.target.branch ||
          pull.baseRefName !== "development" ||
          pull.author?.__typename !== "Bot" ||
          `${pull.author.login.replace(/\[bot\]$/, "")}[bot]` !== APP_LOGIN ||
          !sameRepository(pull.repository) ||
          !sameRepository(pull.headRepository) ||
          !sameRepository(pull.baseRepository)
        ) return null;
        const { timelineItems, ...pullIdentity } = pull;
        const observed = canonicalStringify({ issue, pull: pullIdentity });
        if (identity !== null && identity !== observed) return null;
        identity = observed;
        if (
          !Number.isSafeInteger(timelineItems?.totalCount) ||
          timelineItems.totalCount < 0 ||
          timelineItems.totalCount > 1600 ||
          !Array.isArray(timelineItems.nodes) ||
          timelineItems.nodes.length > 101 ||
          total !== null && total !== timelineItems.totalCount
        ) return null;
        total = timelineItems.totalCount;
        for (const event of timelineItems.nodes) {
          if (event.__typename === "PullRequestRevisionMarker") continue;
          if (
            typeof event.__typename !== "string" ||
            typeof event.id !== "string" ||
            event.id.length === 0 || ids.has(event.id) ||
            event.__typename === "AddedToMergeQueueEvent" ||
            event.__typename === "RemovedFromMergeQueueEvent"
          ) return null;
          ids.add(event.id);
        }
        const info = timelineItems.pageInfo;
        if (info?.hasNextPage === false) {
          return ids.size === total
            ? canonicalStringify({ identity, events: [...ids] })
            : null;
        }
        if (
          info?.hasNextPage !== true || typeof info.endCursor !== "string" ||
          info.endCursor.length === 0 || cursors.has(info.endCursor) ||
          timelineItems.nodes.length === 0
        ) return null;
        after = info.endCursor;
        cursors.add(after!);
      }
      return null;
    }
    let scratch: string | null = null, unsettled = false, safeToRemove = true;
    try {
      if (
        !live() ||
        canonicalStringify(record.repository) !==
          canonicalStringify(input.repository)
      ) return false;
      const first = await facts();
      if (first === null) return false;
      scratch = await Deno.makeTempDir({
        prefix: "sentinel-published-refresh-",
        dir: input.scratch,
      });
      await Deno.chmod(scratch, 0o700);
      const sourcePath = `${scratch}/objects.git`;
      await Deno.mkdir(sourcePath, { mode: 0o700 });
      const runtime = input.runtime ?? new DenoReplayRuntime(Deno.execPath());
      const trustedPath = "/usr/bin:/bin", gitExecutable = "/usr/bin/git";
      const runGit: PreserverGitRunV1 = async (cwd, args, credentials) => {
        if (!live()) return null;
        const result = await runtime.run({
          executable: gitExecutable,
          args: [
            "--no-replace-objects",
            "-c",
            "core.hooksPath=/dev/null",
            ...args,
          ],
          cwd,
          env: {
            PATH: trustedPath,
            HOME: scratch!,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            ...(credentials ? githubGitAuthEnv(input.token, remote) : {}),
          },
          maxDurationMs: Math.min(30_000, deadline - input.clock.now()),
          maxOutputBytes: 1024 * 1024,
        });
        unsettled ||= !result.settled;
        return {
          code: result.exitCode ?? 1,
          stdout: new TextDecoder().decode(result.stdout),
          settled: result.settled,
          exited: result.outcome === "exited",
          truncated: result.truncated,
        };
      };
      if (
        (await runGit(sourcePath, ["init", "--bare", "-q"], false))?.code !== 0
      ) return false;
      const protectedPaths = selectTrustedTargetPolicyV1(
        createLocalRepositoryConfig(),
        input.repository,
      ).protectedPaths;
      safeToRemove = false;
      const proof = await freshStoreProof({
        runGit,
        gate: input.gate,
        installationId: input.repository.installationId,
        remoteUrl: remote,
        ref: candidate.ref,
        candidate,
        publishedHead: record.target.head,
        protectedPaths,
        sourcePath,
        restoreSource: true,
        trustedPath,
        gitExecutable,
        scratch,
      });
      if (!proof.ok || !live() || record.target.head === null) return false;
      const old = await new GitReviewSnapshot({
        trustedPath,
        repositoryDir: sourcePath,
        gitExecutable,
        totalDeadlineMs: Math.max(
          1,
          Math.min(30_000, deadline - input.clock.now()),
        ),
      }).validatePublication({
        base: record.target.base,
        head: record.target.head,
        publishedHead: null,
        protectedPaths,
      });
      if (!old.ok || !live()) return false;
      const regenerated = await new DenoGitExecutor({
        localDir: sourcePath,
        remoteUrl: remote,
        gitHome: scratch,
        gitPath: gitExecutable,
        timeoutMs: Math.max(1, Math.min(30_000, deadline - input.clock.now())),
      }).integrateBase(record.target.head, candidate.base);
      if (regenerated.ok) safeToRemove = true;
      return regenerated.ok && regenerated.value === candidate.head && live() &&
        first === await facts();
    } catch {
      return false;
    } finally {
      if (scratch !== null && !unsettled && safeToRemove) {
        await Deno.remove(scratch, { recursive: true }).catch(() => {});
      }
    }
  };
}
