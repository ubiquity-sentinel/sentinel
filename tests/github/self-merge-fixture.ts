import assert from "node:assert/strict";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type {
  SelfMergeExecutionV1,
  SelfMergeProofV1,
} from "../../src/contracts/self-merge.ts";
import type { NativeCiProofV1 } from "../../src/contracts/native-ci.ts";
import { NATIVE_CI_MARKER } from "../../src/contracts/native-ci.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { reviewOperationKey, reviewReceiptId } from "../../src/repair/keys.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import { GitHubPortImpl } from "../../src/github/impl.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  FakeReviewService,
  issueWire,
  pullWire,
  REVIEWER,
  structuredCompletedFixture,
  T0,
} from "./helpers.ts";
import { completedCleanReceipt } from "./merge-helpers.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";

export async function selfMergeFixture() {
  const temp = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-native-self-merge-",
  });
  const work = `${temp}/work`, remote = `${temp}/remote.git`;
  const git = async (args: string[]): Promise<string> => {
    const r = await new Deno.Command("git", {
      args: [
        "-c",
        "user.name=Native merge fixture",
        "-c",
        "user.email=native@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      clearEnv: true,
      env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(r.code, 0, new TextDecoder().decode(r.stderr));
    return new TextDecoder().decode(r.stdout).trim();
  };
  await git(["init", "--bare", "-q", remote]);
  await git(["init", "-q", "-b", "development", work]);
  await Deno.mkdir(`${work}/.github/workflows`, { recursive: true });
  await Deno.mkdir(`${work}/ops`);
  for (
    const path of [
      ".github/workflows/ci.yml",
      "test-local.ts",
      "ops/native-ci-proof.ts",
    ]
  ) {
    await Deno.writeTextFile(
      `${work}/${path}`,
      `trusted native fixture ${path}\n`,
    );
  }
  await Deno.writeTextFile(`${work}/value.ts`, "export const value = 0;\n");
  await Deno.writeTextFile(`${work}/deno.json`, "{}\n");
  await Deno.writeTextFile(`${work}/deno.lock`, "{}\n");
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "base"]);
  const base = await git(["-C", work, "rev-parse", "HEAD"]) as GitSha;
  await git(["-C", work, "push", "-q", remote, "HEAD:refs/heads/development"]);
  await Deno.writeTextFile(`${work}/value.ts`, "export const value = 1;\n");
  await git(["-C", work, "commit", "-q", "-am", "candidate"]);
  const head = await git(["-C", work, "rev-parse", "HEAD"]) as GitSha;
  const executor = new DenoGitExecutor({ localDir: work, remoteUrl: remote });
  const built = await executor.integrateBase(base, head);
  assert.ok(built.ok);
  if (!built.ok) throw new Error();
  const commit = await executor.readSelfMergeCommit(built.value);
  assert.ok(commit.ok);
  if (!commit.ok) throw new Error();
  const issue = issueWire({
    number: 7,
    created_at: new Date(T0).toISOString(),
    updated_at: new Date(T0 + 1000).toISOString(),
  }) as Record<string, unknown>;
  const taskDigest = await reviewTaskStatementDigest({
    issueNumber: 7,
    title: String(issue.title),
    body: String(issue.body),
  });
  const acceptance = {
    issueNumber: 7,
    taskDigest,
    verdict: "fulfilled" as const,
    evidence: ["The exact candidate repairs the source task."],
  };
  const operation = reviewOperationKey(1, head);
  const structured = await structuredCompletedFixture({
    head,
    base,
    operationKey: operation,
    result: {
      verdict: "clean",
      summary: "no issues found",
      findings: [],
      taskAcceptance: acceptance,
    },
  });
  const service = new FakeReviewService();
  service.readResult = structured.service;
  const repository = {
    owner: "Ubiquity-Sentinel",
    name: "sentinel",
    installationId: 0,
  };
  const review = completedCleanReceipt({
    id: await reviewReceiptId(operation, head),
    repository,
    pullRequest: { number: 1, head, base },
    taskAcceptance: acceptance,
  });
  const ci: NativeCiProofV1 = {
    version: "v1",
    repository: "Ubiquity-Sentinel/sentinel",
    repositoryId: 17,
    runId: 500,
    attempt: 1,
    job: "test-local",
    pr: 1,
    headRef: "sentinel/fix-1",
    head,
    base,
    testedCommit: built.value,
    testedTree: commit.value.tree,
    workflowSource: head,
    sources: {
      workflow: commit.value.sources.workflow!,
      harness: commit.value.sources.harness!,
      emitter: commit.value.sources.emitter!,
    },
  };
  const calls: HttpRequestV1[] = [];
  let prState: "open" | "closed" = "open",
    issueState: "open" | "closed" = "open";
  const state = {
    ci,
    missingCi: false,
    foreignCi: false,
    failedCi: false,
    failPersist: "",
    saved: [] as SelfMergeProofV1[],
    race: false,
    ancestorRace: false,
    wrongCloseIdentity: false,
    pushes: [] as string[],
  };
  const originalPush = executor.push.bind(executor);
  executor.push = async (ref, sha, expected) => {
    state.pushes.push(ref);
    if (
      ref === "refs/heads/development" && (state.race || state.ancestorRace)
    ) {
      const competing = state.ancestorRace ? head : await git([
        "-C",
        work,
        "commit-tree",
        `${base}^{tree}`,
        "-p",
        base,
        "-m",
        "competing writer",
      ]);
      if (!state.ancestorRace) {
        await git([
          "-C",
          work,
          "push",
          "-q",
          remote,
          `${competing}:refs/heads/competing`,
        ]);
      }
      await git([
        "--git-dir",
        remote,
        "update-ref",
        "refs/heads/development",
        competing,
        base,
      ]);
    }
    return originalPush(ref, sha, expected);
  };
  const http = async (request: HttpRequestV1): Promise<HttpResponseV1> => {
    calls.push(request);
    const url = new URL(request.url), path = url.pathname;
    let body: unknown, status = 200;
    if (url.hostname === "productionresultssa17.blob.core.windows.net") {
      return {
        status: 200,
        headers: new Headers(),
        bodyText: `${new Date(T0 + 140_000).toISOString()} ${NATIVE_CI_MARKER}${
          JSON.stringify(state.ci)
        }\n`,
      };
    }
    if (path.endsWith("/pulls/1/reviews")) body = [structured.review];
    else if (path.endsWith("/pulls/1/comments")) body = [];
    else if (path.endsWith("/pulls/1")) {
      if (request.method === "PATCH") prState = "closed";
      const target = await executor.readRemoteRef("refs/heads/development");
      body = pullWire({
        number: state.wrongCloseIdentity && prState === "closed" ? 2 : 1,
        state: prState,
        body: "Resolves #7",
        head: { ref: "sentinel/fix-1", sha: head },
        base: { ref: "development", sha: target.ok ? target.value : base },
        user: { login: "ubiquity-sentinel[bot]" },
        created_at: new Date(T0).toISOString(),
        updated_at: new Date(T0 + 1000).toISOString(),
      });
    } else if (path.endsWith("/rules/branches/development")) body = [];
    else if (path.endsWith("/rulesets")) body = [];
    else if (path.endsWith("/branches/development/protection")) {
      status = 404;
      body = {};
    } else if (path.endsWith("/check-runs")) {
      body = {
        total_count: state.missingCi ? 0 : 1,
        check_runs: state.missingCi ? [] : [{
          id: 700,
          name: "test-local",
          head_sha: head,
          status: "completed",
          conclusion: state.failedCi ? "failure" : "success",
          started_at: new Date(T0 + 100_000).toISOString(),
          completed_at: new Date(T0 + 150_000).toISOString(),
          app: {
            id: 15368,
            slug: state.foreignCi ? "foreign-app" : "github-actions",
          },
          details_url:
            "https://github.com/Ubiquity-Sentinel/sentinel/actions/runs/500/job/600",
        }],
      };
    } else if (path.endsWith("/statuses")) body = [];
    else if (path.endsWith("/actions/runs/500")) {
      body = {
        id: 500,
        run_attempt: 1,
        workflow_id: 2,
        head_sha: head,
        event: "pull_request",
        status: "completed",
        conclusion: "success",
        path: ".github/workflows/ci.yml@refs/pull/1/merge",
        repository: { id: 17, full_name: "Ubiquity-Sentinel/sentinel" },
        pull_requests: [{
          number: 1,
          head: { sha: head, ref: "sentinel/fix-1", repo: { id: 17 } },
          base: { sha: base, ref: "development", repo: { id: 17 } },
        }],
      };
    } else if (path.endsWith("/actions/workflows/2")) {
      body = { id: 2, path: ".github/workflows/ci.yml", state: "active" };
    } else if (path.endsWith("/attempts/1/jobs")) {
      body = {
        total_count: 1,
        jobs: [{
          id: 600,
          run_id: 500,
          run_attempt: 1,
          name: "test-local",
          status: "completed",
          conclusion: "success",
          check_run_url:
            "https://api.github.com/repos/Ubiquity-Sentinel/sentinel/check-runs/700",
          steps: [{
            name: "Credential-free local harness",
            status: "completed",
            conclusion: "success",
            started_at: new Date(T0 + 130_000).toISOString(),
            completed_at: new Date(T0 + 150_000).toISOString(),
          }],
        }],
      };
    } else if (path.endsWith("/actions/jobs/600/logs")) {
      return {
        status: 302,
        headers: new Headers({
          location:
            "https://productionresultssa17.blob.core.windows.net/native-ci",
        }),
        bodyText: "",
      };
    } else if (path.endsWith("/issues/7")) {
      if (request.method === "PATCH") issueState = "closed";
      body = {
        ...issue,
        state: issueState,
        updated_at: issueState === "closed"
          ? new Date(T0 + 180_000).toISOString()
          : issue.updated_at,
        closed_at: issueState === "closed"
          ? new Date(T0 + 180_000).toISOString()
          : null,
      };
    } else {throw new Error(
        `Unrecorded native fixture ${request.method} ${path}`,
      );}
    return { status, headers: new Headers(), bodyText: JSON.stringify(body) };
  };
  const clock = new FakeClock(T0 + 200_000);
  const port = new GitHubPortImpl({
    repository,
    http,
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock,
    git: executor,
    reviewService: service,
    trustedPrAuthor: "ubiquity-sentinel[bot]",
    trustedReviewer: REVIEWER,
    trustedResolutionAuthors: [],
    selfMergeEnabled: true,
  });
  const execution: SelfMergeExecutionV1 = {
    taskId: "work-1" as WorkItemId,
    issueNumber: 7,
    headRef: "sentinel/fix-1",
    operationKey: `merge:1:${head}`,
    deadline: T0 + 500_000,
    proof: null,
    persist: (proof) => {
      if (state.failPersist === proof.stage) {
        state.failPersist = "";
        return Promise.resolve({
          ok: false,
          error: { kind: "unavailable", detail: "injected state CAS refusal" },
        });
      }
      state.saved.push(structuredClone(proof));
      return Promise.resolve({ ok: true, value: undefined });
    },
  };
  return {
    port,
    executor,
    request: {
      pullRequestNumber: 1,
      expectedHead: head,
      expectedBase: base,
      review,
    },
    execution,
    state,
    calls,
    clock,
    head,
    base,
    merge: built.value,
    cleanup: () => Deno.remove(temp, { recursive: true }),
  };
}
