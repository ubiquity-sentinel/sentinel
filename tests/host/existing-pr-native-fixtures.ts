import assert from "node:assert/strict";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { TakeoverPreserveRequest } from "../../src/contracts/existing-pr-takeover.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-task-acceptance.ts";
import { GitHubPrAssociationsClient } from "../../src/github/client-pr-associations.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import type { NativeQueueGuardV1 } from "../../src/github/native-queue-guard.ts";
import {
  takeoverAnchorRef,
  takeoverBindingDigest,
  takeoverNativeRef,
} from "../../src/github/existing-pr-takeover-provenance.ts";
import {
  createExistingPrTakeover,
  nativeTakeoverIntentKey,
  TAKEOVER_NATIVE_PRESERVING,
} from "../../src/host/existing-pr-takeover.ts";
import { composeGitHubHost } from "../../src/host/github.ts";
import {
  DenoReplayRuntime,
  type ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import { FakeAuthProvider, FakeReviewService } from "../github/helpers.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";
import {
  type CandidateCtxV1,
  FakeGate,
  gitRun,
  makeCandidateCtx,
  SELF_REPO,
  snapshot,
  TRUSTED_PATH,
} from "./actions-candidates-fixture.ts";

export async function nativeFixture(
  protectedPaths: string[] = [".github/"],
  prepare?: (ctx: CandidateCtxV1) => Promise<void>,
  repository: RepositoryIdentityV1 = SELF_REPO,
) {
  const ctx = await makeCandidateCtx();
  await prepare?.(ctx);
  const sourcePath = await ctx.clone();
  const branch = "human/issue-1";
  assert.ok(
    (await gitRun(`${ctx.tmp}/work`, [
      "push",
      "-q",
      "origin",
      `${ctx.head}:refs/heads/${branch}`,
    ], ctx.env)).ok,
  );
  const state = new MemoryState();
  const gate = new FakeGate();
  const clock = new FakeClock(T0 + 1);
  const controls = {
    failHttp: false,
    body: "Continue PR #7",
    author: "human-owner",
    hook: () => {},
    policy: { activated: true },
    fence: true,
    write: true,
    head: ctx.head,
    base: ctx.base,
    merged: false,
    mergeSha: null as GitSha | null,
    issueClosed: false,
    replies: new Map<string, unknown>(),
  };
  const repo = {
    id: "R_target",
    name: repository.name,
    owner: { login: repository.owner },
  };
  const restRepo = { ...repo, node_id: repo.id };
  const issue = { id: "I_1", number: 1, repository: repo };
  const graphPull = () => ({
    id: "PR_7",
    number: 7,
    state: controls.merged ? "MERGED" : "OPEN",
    repository: repo,
    headRepository: repo,
    baseRepository: repo,
    headRefName: branch,
    baseRefName: "development",
    headRefOid: controls.head,
    baseRefOid: controls.base,
  });
  const connection = (nodes: unknown[]) => ({
    totalCount: nodes.length,
    nodes,
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const reader = new DenoGitExecutor({
    localDir: sourcePath,
    remoteUrl: `file://${ctx.bare}`,
    gitHome: `${ctx.tmp}/home`,
    gitPath: "git",
  });
  const requests: { method: string; path: string }[] = [];
  const http: HttpTransportV1 = async (request) => {
    controls.hook();
    const path = new URL(request.url).pathname;
    requests.push({ method: request.method, path });
    const response = (body: unknown, status = 200) => ({
      status,
      headers: new Headers(),
      bodyText: JSON.stringify(body),
    });
    if (controls.failHttp) return response({}, 503);
    const key = `${request.method} ${path}`;
    if (controls.replies.has(key)) return response(controls.replies.get(key));
    if (path === "/graphql") {
      const query = JSON.parse(request.body!).query as string;
      if (query.includes("SentinelIssuePullAssociations")) {
        return response({
          data: {
            repository: {
              ...repo,
              issue: {
                ...issue,
                title: "Repair source",
                body: controls.body,
                state: controls.issueClosed ? "CLOSED" : "OPEN",
                closedByPullRequestsReferences: connection(
                  controls.merged ? [] : [graphPull()],
                ),
              },
            },
          },
        });
      }
      if (query.includes("SentinelPullClosingIssues")) {
        return response({
          data: {
            repository: {
              ...repo,
              pullRequest: {
                ...graphPull(),
                closingIssuesReferences: connection([issue]),
              },
            },
          },
        });
      }
    }
    if (path.endsWith("/pulls/7")) {
      return response({
        node_id: "PR_7",
        number: 7,
        title: "Repair source",
        body: "Resolves #1",
        state: controls.merged ? "closed" : "open",
        merged: controls.merged,
        created_at: new Date(T0).toISOString(),
        updated_at: new Date(T0).toISOString(),
        merged_at: controls.merged ? new Date(T0 + 1).toISOString() : null,
        merge_commit_sha: controls.mergeSha,
        merged_by: controls.merged
          ? {
            node_id: "BOT_sentinel",
            login: "ubiquity-sentinel[bot]",
            type: "Bot",
          }
          : null,
        review_decision: null,
        user: { node_id: "U_1", login: controls.author, type: "User" },
        head: { ref: branch, sha: controls.head, repo: restRepo },
        base: { ref: "development", sha: controls.base, repo: restRepo },
      });
    }
    if (path.endsWith("/protection")) return response({}, 404);
    if (path.includes("/rules/branches/")) return response([]);
    if (path.includes("/git/ref/")) {
      const ref = "refs/" + decodeURIComponent(path.split("/git/ref/")[1]);
      const result = await reader.readRemoteRef(ref);
      if (!result.ok) return response({}, 503);
      return result.value === null
        ? response({}, 404)
        : response({ ref, object: { sha: result.value } });
    }
    throw new Error("unexpected test HTTP path");
  };
  const auth = new FakeAuthProvider();
  const client = new GitHubPrAssociationsClient({
    repository,
    apiBaseUrl: "https://api.github.com",
    http,
    auth,
    cooldownGate: gate,
    clock,
  }, null);
  const nativeQueue = {
    inspectEffect: () => Promise.resolve({ status: "allow", basis: "self" }),
  } as unknown as NativeQueueGuardV1;
  const reviewService = new FakeReviewService();
  const host = composeGitHubHost({
    repository,
    http,
    auth,
    cooldownGate: gate,
    clock,
    nativeQueue,
    reviewService,
    trustedPrAuthor: "sentinel[bot]",
    trustedReviewer: "sentinel[bot]",
    trustedResolutionAuthors: [],
    git: {
      localDir: sourcePath,
      remoteUrl: `file://${ctx.bare}`,
      gitHome: `${ctx.tmp}/home`,
      gitPath: "git",
    },
  });
  const binding = {
    repository,
    taskId: workRecord("issue-1").id,
    issueNumber: 1,
    issueNodeId: "I_1",
    issueDigest: await reviewTaskStatementDigest({
      issueNumber: 1,
      title: "Repair source",
      body: controls.body,
    }),
    pullRequest: 7,
    pullNodeId: "PR_7",
    headRepositoryId: "R_target",
    headRepository: { owner: repository.owner, name: repository.name },
    headRef: branch,
    baseRef: "development",
    author: controls.author,
  };
  const bindingDigest = await takeoverBindingDigest(binding);
  const request: TakeoverPreserveRequest = {
    binding,
    bindingDigest,
    head: ctx.head,
    base: ctx.base,
    ref: await takeoverNativeRef({
      bindingDigest,
      head: ctx.head,
      base: ctx.base,
    }),
    expectedStateHead: SHA1,
    deadline: T0 + 240_000,
  };
  const record = workRecord("issue-1", {
    repository,
    source: { kind: "issue", id: "1", revision: ctx.base },
    related: { issueNumber: 1, incidentId: null },
    nextStep: "blocked",
    blocker: { kind: "other", message: TAKEOVER_NATIVE_PRESERVING, since: T0 },
    wait: null,
    target: {
      base: ctx.base,
      head: ctx.head,
      branch,
      pr: 7,
      checkpoint: null,
      candidateState: { preserved: null, publishedHead: ctx.head },
    },
    intent: {
      kind: "push",
      key: nativeTakeoverIntentKey(request),
      startedAt: T0,
      branch: request.ref,
      expectedHead: ctx.head,
      observedBase: ctx.base,
      pr: null,
      requestId: null,
      resultId: null,
    },
    evidence: [takeoverAnchorRef(bindingDigest)],
  });
  state.repair = snapshot([record]);
  state.repairHead = SHA1;
  const calls: { args: string[]; credentialed: boolean; cwd: string }[] = [];
  const underlying = new DenoReplayRuntime(TRUSTED_PATH);
  const runtime: ReplayRuntimeV1 = {
    run: (input) => {
      calls.push({
        args: input.args,
        credentialed: "GIT_CONFIG_COUNT" in input.env,
        cwd: input.cwd,
      });
      return underlying.run(input);
    },
  };
  const pushes: { ref: string; head: GitSha; expected: GitSha | null }[] = [];
  const originalPush = host.port.pushHead.bind(host.port);
  host.port.pushHead = async (ref, head, expected, takeover) => {
    pushes.push({ ref, head, expected });
    const result = await originalPush(ref, head, expected, takeover);
    if (
      result.ok && result.value === "applied" && ref === `refs/heads/${branch}`
    ) controls.head = head;
    return result;
  };
  const factoryInput = {
    repository,
    sourcePath,
    scratch: `${ctx.tmp}/home`,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    remoteUrl: `file://${ctx.bare}`,
    token: "fixture-token",
    clock,
    gate,
    protectedPaths,
    runtime,
    state,
    client,
    port: host.port,
    baseBranch: "development",
    policy: controls.policy,
    runtimeCapabilityAccepted: () => controls.fence,
    contentsWriteAllowed: () => controls.write,
    principal: { revalidate: () => Promise.resolve(portOk(undefined)) },
  };
  const port = createExistingPrTakeover(factoryInput);
  Object.defineProperty(host.port, "existingPrTakeover", {
    configurable: true,
    value: port,
  });
  return {
    ctx,
    state,
    gate,
    clock,
    controls,
    reader,
    client,
    host,
    reviewService,
    http,
    sourcePath,
    calls,
    requests,
    pushes,
    request,
    factoryInput,
    port,
    readHead: async (ref: string) => {
      const result = await reader.readRemoteRef(ref);
      assert.ok(result.ok);
      return result.value;
    },
    noWriteResult: () => portOk("ambiguous" as const),
  };
}
