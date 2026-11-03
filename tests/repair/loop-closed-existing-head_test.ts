/** Closed ai.ubq.fi publications recover without regenerating their live head. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import { portError } from "../../src/contracts/ports.ts";
import { planMatrixWave } from "../../src/host/matrix-planner.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop-eligibility.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { executeWorkStep } from "../../src/repair/loop-work.ts";
import { SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  type FakeGithubOptionsV1,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { exactClosedPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";
import { seededSnapshot } from "./loop-rig.ts";

function setup(
  options: FakeGithubOptionsV1 = {},
  publishedHead: GitSha | null = SHA2,
) {
  const repository = {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    installationId: 1,
  };
  const branch = candidateBranch(asWorkItemId("issue-1"));
  const record = workRecord("issue-1", {
    repository,
    counters: { attempts: 2, retries: 1, reviewRounds: 0 },
    target: {
      base: SHA1,
      branch,
      checkpoint: null,
      head: SHA2,
      pr: 1149,
      candidateState: { preserved: null, publishedHead },
    },
  });
  const github = new FakeGithub({
    baseSha: SHA1,
    candidateLifecycle: {
      ...positiveLifecycle(),
      refs: { [`refs/heads/${branch}`]: SHA2 },
      pullRequests: [exactClosedPr(1149, SHA2, branch)],
    },
    ...options,
  });
  const state = new MemoryState();
  state.repair = seededSnapshot([record]);
  state.repairHead = SHA1;
  const clock = new FakeClock(T0);
  const configs = repairConfigs({
    repository,
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const model = new FakeModel();
  const deps: RepairCycleDepsV1 = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
    model,
    budget: new RollingStartBudget({ clock, state, configs }),
  };
  const context = (): LoopContextV1 => ({
    snapshot: state.repair!,
    head: state.repairHead,
    executionBaseline: state.repair!.work[0]!,
    bounds: {
      runDeadline: clock.now() + 60 * 60_000,
      modelCutoff: clock.now() + 60 * 60_000,
    },
  });
  return {
    deps,
    context,
    state,
    github,
    model,
    record,
    branch,
    clock,
    configs,
  };
}

Deno.test("closed publication requires a retained PR or a durable replacement intent", async (t) => {
  for (const branchRefSha of [SHA2, null]) {
    await t.step(
      branchRefSha === null ? "deleted branch" : "live branch",
      async () => {
        const r = setup({ branchRefSha });
        const record = {
          ...r.record,
          target: { ...r.record.target, pr: null },
        };
        r.state.repair = seededSnapshot([record]);
        const step = await executeWorkStep(r.deps, r.context(), record);
        assert.ok(
          !r.github.calls.includes("createPr"),
          "no replacement authority",
        );
        assert.equal(step.kind, "deferred", JSON.stringify(step));
        assert.deepEqual(r.state.repair!.work[0], record);
        assert.deepEqual(r.state.repair!.reservations, []);
        assert.equal(r.model.requests.length, 0);
        assert.ok(!r.github.calls.includes("push"));
      },
    );
  }
});

Deno.test("ai.ubq.fi: a closed unmerged preserved-null PR opens a fresh PR and reviews the same head", async () => {
  const r = setup();
  const step = await executeWorkStep(r.deps, r.context(), r.record);
  assert.equal(step.kind, "progress", JSON.stringify(step));
  assert.ok(r.github.calls.includes("createPr"), "replace the closed PR");
  const after = r.state.repair!.work[0]!;
  assert.notEqual(after.target.pr, 1149);
  assert.equal(after.target.head, SHA2);
  assert.equal(after.target.base, SHA1);
  assert.deepEqual(after.target.candidateState, r.record.target.candidateState);
  assert.equal(after.nextStep, "review");
  assert.equal(after.counters.attempts, 2);
  assert.equal(after.counters.retries, 1);
  assert.equal(r.github.reviewRequestIdentities[0]?.expectedHead, SHA2);
  assert.equal(
    r.state.repair!.reservations.length,
    1,
    "only the new review is charged",
  );
  assert.ok(!r.github.calls.includes("push"));
  assert.ok(!r.github.calls.includes("preserveCandidate"));
  assert.equal(r.model.requests.length, 0);
});

Deno.test("closed preserved-null PR with a deleted branch restarts from the base without refunding history", async () => {
  const r = setup({ branchRefSha: null });
  r.record.target.checkpoint = { branch: r.branch, sha: SHA2 };
  const step = await executeWorkStep(r.deps, r.context(), r.record);
  assert.equal(step.kind, "progress", JSON.stringify(step));
  const after = r.state.repair!.work[0]!;
  assert.equal(after.target.pr, null);
  assert.equal(after.target.head, null);
  assert.equal(after.target.checkpoint, null);
  assert.deepEqual(after.target.candidateState, {
    preserved: null,
    publishedHead: null,
  });
  assert.deepEqual(after.counters, r.record.counters);
  assert.ok(
    isMatrixImplementationReadyV1(
      after,
      r.state.repair!,
      r.configs[0]!,
      r.clock.now(),
    ),
  );
  assert.equal(r.state.repair!.reservations.length, 0);
  assert.equal(r.model.requests.length, 0);
});

Deno.test("closed preserved-null publication refuses an unrelated live branch head", async () => {
  const r = setup({ branchRefSha: SHA3 });
  await executeWorkStep(r.deps, r.context(), r.record);
  assert.deepEqual(r.state.repair!.work[0], r.record);
  assert.ok(!r.github.calls.includes("createPr"));
  assert.equal(r.state.repair!.reservations.length, 0);
});

Deno.test("closed preserved-null publication refuses an unavailable PR read", async () => {
  const r = setup();
  r.github.readPullRequest = () =>
    Promise.resolve(portError("unavailable", "offline fixture"));
  await executeWorkStep(r.deps, r.context(), r.record);
  assert.deepEqual(r.state.repair!.work[0], r.record);
  assert.ok(!r.github.calls.includes("createPr"));
  assert.equal(r.state.repair!.reservations.length, 0);
});

Deno.test("matrix planner: closed ai.ubq.fi publication is replaced before any implementation grant", async () => {
  const r = setup();
  const report = await planMatrixWave(r.deps, {
    waveId: "closed-publication",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 1,
    deadline: T0 + 60 * 60_000,
    plannedAt: T0,
  });
  assert.equal(report.plan.cells.length, 0);
  assert.ok(r.github.calls.includes("createPr"));
  assert.equal(r.state.repair!.work[0]!.nextStep, "review");
  assert.equal(r.state.repair!.work[0]!.counters.attempts, 2);
  assert.equal(r.state.repair!.reservations.length, 1);
  assert.equal(r.state.repair!.reservations[0]!.purpose, "review_request");
  assert.equal(r.model.requests.length, 0);
});

Deno.test("replacement publication reconciles an ambiguous create after restart without a duplicate PR", async () => {
  const r = setup({ createOutcome: "ambiguous" });
  await executeWorkStep(r.deps, r.context(), r.record);
  assert.equal(r.state.repair!.work[0]!.target.pr, null);
  assert.equal(r.state.repair!.work[0]!.intent?.kind, "pull_request");
  assert.equal(r.state.repair!.reservations.length, 0);
  // Production discovery prefers the one open PR over the closed predecessor;
  // the shared fake otherwise returns its first seeded (closed) PR.
  const published = await r.github.readPullRequest(7);
  assert.ok(published.ok && published.value?.state === "open");
  r.github.findPullRequestByHeadRef = (branch) => {
    assert.equal(branch, r.branch);
    return Promise.resolve(published);
  };
  await executeWorkStep(r.deps, r.context(), r.state.repair!.work[0]!);
  assert.notEqual(r.state.repair!.work[0]!.target.pr, null);
  await executeWorkStep(r.deps, r.context(), r.state.repair!.work[0]!);
  assert.equal(r.state.repair!.work[0]!.nextStep, "review");
  assert.equal(r.github.calls.filter((call) => call === "createPr").length, 1);
  assert.equal(r.github.reviewRequestIdentities.length, 1);
  assert.equal(r.model.requests.length, 0);
});

Deno.test("closed publication does not treat a merged PR as replacement authority", async () => {
  const r = setup();
  r.github.readPullRequest = () =>
    Promise.resolve({
      ok: true as const,
      value: { ...exactClosedPr(1149, SHA2, r.branch), mergeSha: SHA3 },
    });
  await executeWorkStep(r.deps, r.context(), r.record);
  assert.deepEqual(r.state.repair!.work[0], r.record);
  assert.ok(!r.github.calls.includes("createPr"));
  assert.equal(r.state.repair!.reservations.length, 0);
});

Deno.test("closed publication requires the exact owned branch and configured base", async () => {
  const r = setup();
  r.github.readPullRequest = () =>
    Promise.resolve({
      ok: true as const,
      value: { ...exactClosedPr(1149, SHA2, r.branch), baseRef: "other" },
    });
  await executeWorkStep(r.deps, r.context(), r.record);
  assert.deepEqual(r.state.repair!.work[0], r.record);
  assert.ok(!r.github.calls.includes("createPr"));
  assert.equal(r.state.repair!.reservations.length, 0);
});

Deno.test("matrix planner: a closed PR with no recorded published head is recovered before not-ready filtering", async () => {
  const r = setup({}, null);
  await planMatrixWave(r.deps, {
    waveId: "closed-publication-no-published-head",
    run: { runId: 2, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 1,
    deadline: T0 + 60 * 60_000,
    plannedAt: T0,
  });
  assert.ok(r.github.calls.includes("createPr"));
  assert.equal(r.state.repair!.work[0]!.nextStep, "review");
  assert.equal(
    r.state.repair!.work[0]!.target.candidateState?.publishedHead,
    SHA2,
  );
  assert.equal(r.model.requests.length, 0);
});

Deno.test("matrix planner: deleted closed-publication branch yields a charged fresh base implementation", async () => {
  const r = setup({ branchRefSha: null });
  const report = await planMatrixWave(r.deps, {
    waveId: "closed-publication-restart",
    run: { runId: 3, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 1,
    deadline: T0 + 60 * 60_000,
    plannedAt: T0,
  });
  assert.equal(report.plan.cells.length, 1);
  assert.equal(report.plan.cells[0]!.request.base, SHA1);
  assert.equal(r.state.repair!.work[0]!.counters.attempts, 3);
  assert.equal(r.state.repair!.work[0]!.counters.retries, 1);
  assert.equal(r.state.repair!.reservations.length, 1);
  // Prior attempts still make this a charged retry, never a first start/refund.
  assert.equal(r.state.repair!.reservations[0]!.purpose, "retry");
  assert.equal(
    r.model.requests.length,
    0,
    "the planner grants but never infers",
  );
});

Deno.test("matrix planner: deleted branch with a stale checkpoint restarts from the current base", async () => {
  const r = setup({ baseSha: SHA3, branchRefSha: null });
  r.record.target.checkpoint = { branch: r.branch, sha: SHA2 };
  const report = await planMatrixWave(r.deps, {
    waveId: "closed-publication-checkpoint-restart",
    run: { runId: 4, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 1,
    deadline: T0 + 60 * 60_000,
    plannedAt: T0,
  });
  assert.equal(report.plan.cells.length, 1);
  assert.equal(report.plan.cells[0]!.request.base, SHA3);
  const after = r.state.repair!.work[0]!;
  assert.equal(after.target.base, SHA3);
  assert.equal(after.target.checkpoint, null);
  assert.equal(after.counters.attempts, 3);
  assert.equal(after.counters.retries, 1);
  assert.equal(r.state.repair!.reservations.length, 1);
  assert.equal(r.state.repair!.reservations[0]!.purpose, "retry");
  assert.equal(r.model.requests.length, 0);
});

Deno.test("closed publication does not treat an unavailable branch read as deletion", async () => {
  const r = setup();
  r.github.readRef = () =>
    Promise.resolve(portError("unavailable", "offline fixture"));
  await executeWorkStep(r.deps, r.context(), r.record);
  assert.deepEqual(r.state.repair!.work[0], r.record);
  assert.ok(!r.github.calls.includes("createPr"));
  assert.equal(r.state.repair!.reservations.length, 0);
});
