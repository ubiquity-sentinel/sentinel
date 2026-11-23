import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { AgentJobReviewRound } from "../../ops/agent-jobs-native-review.ts";
import {
  type AgentJobsReviewInput,
  reviewAgentJobsCell,
} from "../../ops/agent-jobs-review.ts";
import {
  AGENT_JOB_BUNDLE_REF,
  fetchAgentJobBase,
  importAgentJobBundle,
  validateAgentJobPublication,
} from "../../ops/agent-jobs-review-git.ts";
import { git, gitOk } from "../../ops/agent-jobs-git.ts";
import { planAgentJobs } from "../../ops/agent-jobs-plan.ts";

const DIGEST = "1".repeat(64);
const REPOSITORY = "ubiquity/example";
const JOB_ID = "review-fixture";
const BASE = "release/test";

async function fixture<T>(
  body: (fixture: {
    input: AgentJobsReviewInput;
    baseSha: string;
    rawHead: string;
    remote: string;
    changeRow: (patch: Record<string, unknown>) => Promise<void>;
    gitFixtureDir: string;
  }) => Promise<T>,
  options: { review?: boolean; emptyCommit?: boolean } = {},
): Promise<T> {
  const root = resolve(
    await Deno.makeTempDir({ dir: ".", prefix: ".agent-job-gate-test-" }),
  );
  try {
    const remote = resolve(root, "remote");
    const artifactDir = resolve(root, "cell");
    await Deno.mkdir(remote);
    await Deno.mkdir(artifactDir);
    const cwd = { cwd: remote };
    await gitOk(["init", "--quiet", "-b", BASE], cwd);
    await Deno.writeTextFile(resolve(remote, "value.txt"), "original\n");
    await gitOk(["add", "value.txt"], cwd);
    await gitOk(["commit", "--quiet", "-m", "base"], cwd);
    const baseSha = await gitOk(["rev-parse", "HEAD"], cwd);
    await gitOk(["checkout", "--quiet", "-b", "agent-job"], cwd);
    if (options.emptyCommit === true) {
      await gitOk([
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "no tree change",
      ], cwd);
    } else {
      await Deno.writeTextFile(resolve(remote, "value.txt"), "first edit\n");
      await gitOk(["commit", "--quiet", "-am", "first raw edit"], cwd);
      await Deno.writeTextFile(resolve(remote, "value.txt"), "rejected edit\n");
      await gitOk(["commit", "--quiet", "-am", "rejected raw edit"], cwd);
    }
    const rawHead = await gitOk(["rev-parse", "HEAD"], cwd);
    await gitOk([
      "bundle",
      "create",
      "--quiet",
      resolve(artifactDir, `${JOB_ID}.bundle`),
      `${baseSha}..${AGENT_JOB_BUNDLE_REF}`,
    ], cwd);
    await Deno.writeTextFile(
      resolve(artifactDir, `${JOB_ID}.md`),
      "untrusted message",
    );
    await Deno.writeTextFile(
      resolve(artifactDir, "other.txt"),
      "untrusted extra file",
    );
    const plan = planAgentJobs({
      jobs: [{
        id: JOB_ID,
        repository: REPOSITORY,
        prompt: "Fix value",
        base: BASE,
        minutes: 1,
      }],
    });
    Object.assign(plan.cells[0].jobs[0], { review: options.review, baseSha });
    const cellId = plan.cells[0].cellId;
    const changeRow = async (patch: Record<string, unknown>) => {
      await Deno.writeTextFile(
        resolve(artifactDir, "result.json"),
        JSON.stringify({
          schema: "sentinel.agent-jobs.cell-result/v1",
          cellId,
          results: [{
            id: JOB_ID,
            repository: REPOSITORY,
            base: BASE,
            baseSha,
            headSha: rawHead,
            status: "changed",
            bundle: `${JOB_ID}.bundle`,
            pr: false,
            ...patch,
          }],
        }),
      );
    };
    await changeRow({});
    const input: AgentJobsReviewInput = {
      plan: { ...plan, createdAtMs: Date.now() },
      cellId,
      artifactDir,
      reviewedDir: resolve(root, "reviewed"),
      workRoot: resolve(root, "scratch"),
      runTag: "123-1",
      modelToken: "",
      baseUrl: "https://example.invalid/v1",
      defaultModel: "fixture",
      ports: {
        publicRepository: (repository) => {
          assert.equal(repository, REPOSITORY);
          return Promise.resolve();
        },
        remoteUrl: () => remote,
        task: () =>
          Promise.resolve({
            digest: DIGEST,
            issueNumber: 1,
            title: "Fix value",
            body: "",
          }),
        review: () => Promise.reject(new Error("unexpected review")),
        correct: () => Promise.reject(new Error("unexpected correction")),
        verdict: (value) => {
          const disposition = (value as AgentJobReviewRound).disposition;
          return Promise.resolve(
            disposition === "blocked" ? null : disposition,
          );
        },
        log: () => {},
      },
    };
    return await body({
      input,
      baseSha,
      rawHead,
      remote,
      changeRow,
      gitFixtureDir: root,
    });
  } finally {
    await removeFixture(root);
  }
}

// A git child process can still be writing its object directory when the
// test body returns; removal then fails once with "Directory not empty".
async function removeFixture(root: string): Promise<void> {
  for (let attempt = 0;; attempt++) {
    try {
      await Deno.remove(root, { recursive: true });
      return;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

function roundResult(
  input: Parameters<AgentJobsReviewInput["ports"]["review"]>[0],
  disposition: AgentJobReviewRound["disposition"],
): AgentJobReviewRound {
  return {
    headSha: input.headSha,
    baseSha: input.job.baseSha!,
    round: input.round,
    taskDigest: DIGEST,
    requestId: `request-${input.round}`,
    disposition,
    result: null,
    execution: null,
    feedback: disposition === "correct" ? "P0: fix the rejected value" : "",
    snapshotDigest: null,
    resultSha256: null,
    detail: "fixture native judgment",
  };
}

Deno.test("dispatch agent-job authority: the same path is protected only in the controller", async () => {
  await fixture(async ({ baseSha, remote }) => {
    const cwd = { cwd: remote };
    await gitOk(["checkout", "--quiet", "--detach", baseSha], cwd);
    await Deno.mkdir(resolve(remote, "ops"));
    await Deno.writeTextFile(
      resolve(remote, "ops", "agent-jobs-git.ts"),
      "export const fixture = true;\n",
    );
    await gitOk(["add", "ops/agent-jobs-git.ts"], cwd);
    await gitOk(["commit", "--quiet", "-m", "fixture authority change"], cwd);
    const headSha = await gitOk(["rev-parse", "HEAD"], cwd);
    const candidate = {
      sourcePath: remote,
      baseSha,
      headSha,
      deadlineAtMs: Date.now() + 20_000,
    };
    await assert.rejects(
      validateAgentJobPublication({
        ...candidate,
        repository: "ubiquity-sentinel/sentinel",
      }),
      /protected/,
    );
    await validateAgentJobPublication({
      ...candidate,
      repository: REPOSITORY,
    });
  });
});

Deno.test("dispatch gate reviews an exact correction and seals only the accepted commit", async () => {
  await fixture(async ({ input, baseSha, rawHead, remote, gitFixtureDir }) => {
    const intents: string[] = [];
    input.ports.log = (line) => intents.push(line);
    const reviewed: string[] = [];
    input.ports.review = async (request) => {
      const cwd = { cwd: request.sourcePath };
      assert.notEqual(request.headSha, rawHead);
      assert.equal(
        await gitOk(["rev-parse", `${request.headSha}^`], cwd),
        baseSha,
      );
      assert.equal((await git(["cat-file", "-e", rawHead], cwd)).code, 1);
      const expected = request.round === 1 ? "rejected edit" : "fixed value";
      assert.equal(
        await gitOk(["show", `${request.headSha}:value.txt`], cwd),
        expected,
      );
      assert.ok(intents.at(-1)?.includes('"kind":"review"'));
      reviewed.push(request.headSha);
      return roundResult(request, request.round === 1 ? "correct" : "accepted");
    };
    input.ports.correct = async (request) => {
      assert.equal(request.headSha, reviewed[0]);
      assert.match(request.feedback, /P0/);
      assert.ok(intents.at(-1)?.includes('"kind":"correction"'));
      const checkout = resolve(request.workRoot, "checkout");
      await Deno.mkdir(request.workRoot);
      await gitOk([
        "clone",
        "--quiet",
        "--no-checkout",
        request.sourcePath,
        checkout,
      ]);
      const cwd = { cwd: checkout };
      await gitOk(["checkout", "--quiet", "--detach", request.headSha], cwd);
      await Deno.writeTextFile(resolve(checkout, "value.txt"), "fixed value\n");
      await gitOk(["commit", "--quiet", "-am", "worker correction"], cwd);
      const tip = await gitOk(["rev-parse", "HEAD"], cwd);
      await gitOk(["fetch", "--quiet", checkout, tip], {
        cwd: request.sourcePath,
      });
      return tip;
    };
    const result = await reviewAgentJobsCell(input);
    assert.equal(
      result.results[0].review.verdict,
      "accepted",
      result.results[0].detail,
    );
    assert.equal(result.results[0].headSha, reviewed[1]);
    assert.deepEqual(result.modelStarts.map((entry) => entry.kind), [
      "review",
      "correction",
      "review",
    ]);
    const names: string[] = [];
    for await (const entry of Deno.readDir(input.reviewedDir)) {
      names.push(entry.name);
    }
    assert.deepEqual(names.sort(), ["result.json", `${JOB_ID}.bundle`]);
    const output = resolve(gitFixtureDir, "verify-output.git");
    await Deno.mkdir(output);
    const gitInput = {
      sourcePath: output,
      deadlineAtMs: Date.now() + 20_000,
      baseSha,
    };
    await fetchAgentJobBase({ ...gitInput, base: BASE, remote });
    await importAgentJobBundle({
      ...gitInput,
      headSha: reviewed[1],
      bundlePath: resolve(input.reviewedDir, `${JOB_ID}.bundle`),
    });
    assert.equal(
      await gitOk(["rev-list", `${baseSha}..${reviewed[1]}`], { cwd: output }),
      reviewed[1],
    );
    assert.equal(
      (await git(["cat-file", "-e", reviewed[0]], { cwd: output })).code,
      1,
    );
  });
});

Deno.test("dispatch gate permits skipped review only for exact unchanged trees", async () => {
  await fixture(async ({ input, baseSha }) => {
    const result = await reviewAgentJobsCell(input);
    assert.equal(
      result.results[0].review.verdict,
      "skipped_no_diff",
      result.results[0].detail,
    );
    assert.equal(result.results[0].review.headSha, baseSha);
    assert.equal(result.results[0].bundle, null);
    assert.deepEqual(result.modelStarts, []);
  }, { review: false, emptyCommit: true });
  await fixture(async ({ input }) => {
    const result = await reviewAgentJobsCell(input);
    assert.match(result.results[0].detail, /only for an unchanged tree/);
    assert.deepEqual(result.modelStarts, []);
  }, { review: false });
  await fixture(async ({ input, changeRow }) => {
    await changeRow({ status: "no_changes", headSha: null, bundle: null });
    const result = await reviewAgentJobsCell(input);
    assert.match(result.results[0].detail, /also contains a candidate bundle/);
    assert.equal(result.results[0].review.verdict, "blocked");
    assert.deepEqual(result.modelStarts, []);
  }, { review: false });
});

Deno.test("dispatch gate reads the default review verdict for a no-diff job", async () => {
  await fixture(async ({ input, baseSha }) => {
    input.ports.review = (request) => {
      assert.equal(request.headSha, baseSha);
      return Promise.resolve(roundResult(request, "already_satisfied"));
    };
    const result = await reviewAgentJobsCell(input);
    assert.equal(
      result.results[0].review.verdict,
      "already_satisfied",
      result.results[0].detail,
    );
    assert.equal(result.results[0].headSha, null);
    assert.equal(result.results[0].bundle, null);
  }, { emptyCommit: true });

  await fixture(async ({ input, baseSha }) => {
    input.ports.review = (request) => {
      const atBase = request.headSha === baseSha;
      return Promise.resolve(
        roundResult(request, atBase ? "correct" : "already_satisfied"),
      );
    };
    const result = await reviewAgentJobsCell(input);
    assert.equal(result.results[0].review.verdict, "blocked");
    assert.match(result.results[0].detail, /did not confirm the task/);
    assert.deepEqual(result.modelStarts.map((entry) => entry.kind), [
      "review",
      "review",
    ]);
  });
});

Deno.test("dispatch gate refuses foreign, partial, forged and stale candidates before review", async () => {
  for (
    const [patch, expected] of [
      [{ repository: "ubiquity/foreign" }, /identity/],
      [{ status: "timed_out" }, /complete candidate/],
      [{ bundle: "../foreign.bundle" }, /identity or path/],
      [{ review: { verdict: "accepted" } }, /identity/],
      [{ headSha: "0".repeat(40) }, /bundle seal/],
    ] as const
  ) {
    await fixture(async ({ input, changeRow }) => {
      await changeRow(patch);
      const result = await reviewAgentJobsCell(input);
      assert.match(result.results[0].detail, expected);
      assert.deepEqual(result.modelStarts, []);
    });
  }
  await fixture(async ({ input, remote }) => {
    await gitOk(["branch", "-f", BASE, "HEAD"], { cwd: remote });
    const result = await reviewAgentJobsCell(input);
    assert.match(result.results[0].detail, /pinned base is stale/);
    assert.deepEqual(result.modelStarts, []);
  });
  await fixture(async ({ input }) => {
    input.plan.createdAtMs = Date.now() - 61_000;
    let publicReads = 0;
    input.ports.publicRepository = () => {
      publicReads++;
      return Promise.resolve();
    };
    const result = await reviewAgentJobsCell(input);
    assert.match(result.results[0].detail, /original job deadline elapsed/);
    assert.equal(publicReads, 0);
    assert.deepEqual(result.modelStarts, []);
  });
});
