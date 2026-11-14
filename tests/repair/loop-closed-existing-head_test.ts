import {
  CalendarCiMinutes,
  INACTIVE_CI_MINUTES,
  proposedCiMinutePolicy,
} from "../../src/budget/ci-minutes.ts";
/** Closed ai.ubq.fi publications recover without regenerating their live head. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import {
  ciMinuteDigest,
  ciMonth,
  ciPolicyDigest,
  parseCiMinuteLedger,
  validateCiMinuteTransition,
} from "../../src/contracts/ci-minute-budget.ts";
import type {
  CiEffectV1,
  CiMinuteLedgerV1,
} from "../../src/contracts/ci-minute-budget.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { planMatrixWave } from "../../src/host/matrix-planner.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  candidateBranch,
  pullRequestIntentKey,
  reviewOperationKey,
} from "../../src/repair/keys.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop-eligibility.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { observeReview } from "../../src/repair/loop-review-observation.ts";
import { requestReviewFor } from "../../src/repair/loop-review-request.ts";
import { executeWorkStep } from "../../src/repair/loop-work.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
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
    ciMinutes: INACTIVE_CI_MINUTES,
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

Deno.test("closed publication without retirement evidence requires a PR or replacement intent", async (t) => {
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

Deno.test("closed preserved-null publication recovers after review retirement", async (t) => {
  for (const phase of ["observation", "request"] as const) {
    await t.step(phase, async () => {
      const r = setup();
      const record = phase === "observation"
        ? {
          ...r.record,
          nextStep: "review" as const,
          wait: {
            reason: "review_pending" as const,
            since: T0,
            until: T0 + 60_000,
          },
          intent: {
            kind: "review_request" as const,
            key: reviewOperationKey(1149, SHA2),
            startedAt: T0,
            branch: r.branch,
            expectedHead: SHA2,
            observedBase: SHA1,
            pr: 1149,
            requestId: "closed-review",
            resultId: null,
          },
        }
        : r.record;
      r.state.repair = seededSnapshot([record]);
      const retiredStep = phase === "observation"
        ? await observeReview(r.deps, r.context(), record)
        : await requestReviewFor(r.deps, r.context(), record, 1149);
      assert.equal(retiredStep.kind, "progress", JSON.stringify(retiredStep));
      const retired = r.state.repair!.work[0]!;
      assert.equal(retired.nextStep, "work");
      assert.equal(retired.intent, null, "the dead review is not reconciled");
      assert.equal(retired.target.pr, 1149, "retain replacement authority");
      assert.equal(retired.counters.attempts, record.counters.attempts);
      assert.equal(retired.counters.retries, record.counters.retries);
      assert.equal(retired.counters.reviewRounds, record.counters.reviewRounds);
      assert.equal(r.state.repair!.reservations.length, 0);
      assert.ok(!r.github.calls.includes("createPr"));

      // Resume from persisted state, not the review caller's in-memory record.
      const step = await executeWorkStep(r.deps, r.context(), retired);
      assert.equal(step.kind, "progress", JSON.stringify(step));
      const after = r.state.repair!.work[0]!;
      assert.notEqual(after.target.pr, null);
      assert.notEqual(after.target.pr, 1149);
      assert.equal(after.target.head, SHA2);
      assert.deepEqual(
        after.target.candidateState,
        record.target.candidateState,
      );
      assert.equal(after.nextStep, "review");
      assert.equal(after.counters.attempts, record.counters.attempts);
      assert.equal(after.counters.retries, record.counters.retries);
      assert.equal(r.github.reviewRequestIdentities[0]?.expectedHead, SHA2);
      assert.equal(r.state.repair!.reservations.length, 1);
      assert.equal(r.state.repair!.reservations[0]!.purpose, "review_request");
      assert.equal(r.model.requests.length, 0);
      assert.ok(!r.github.calls.includes("push"));
      assert.ok(!r.github.calls.includes("preserveCandidate"));
    });
  }
});

Deno.test("retired preserved-null publication recovers after review intent recovery", async (t) => {
  for (const phase of ["review wait", "ambiguous review intent"] as const) {
    await t.step(phase, async () => {
      const r = setup();
      const record = {
        ...r.record,
        counters: { ...r.record.counters, reviewRounds: 1 },
        wait: phase === "review wait"
          ? { reason: "review_pending" as const, since: T0, until: T0 + 60_000 }
          : null,
        intent: {
          kind: "review_request" as const,
          key: reviewOperationKey(1149, SHA2),
          startedAt: T0,
          branch: r.branch,
          expectedHead: SHA2,
          observedBase: SHA1,
          pr: 1149,
          requestId: "closed-review",
          resultId: null,
        },
      };
      r.state.repair = {
        ...seededSnapshot([record]),
        reservations: [reservation("closed-review", {
          repository: record.repository,
          taskId: record.id,
          head: SHA2,
          purpose: "review_request",
        })],
      };
      const recovery = await executeWorkStep(r.deps, r.context(), record);
      assert.equal(recovery.kind, "progress", JSON.stringify(recovery));
      const retired = r.state.repair!.work[0]!;
      assert.equal(retired.nextStep, "work");
      assert.equal(retired.wait, null);
      assert.equal(retired.intent, null);
      assert.equal(retired.target.pr, null);
      assert.equal(retired.target.retiredOwnPr, 1149);
      assert.deepEqual(retired.counters, record.counters);
      assert.equal(r.state.repair!.reservations[0]!.outcome, "ambiguous");
      assert.ok(!r.github.calls.includes("createPr"));

      // The next wave consumes the persisted retirement, not the old PR.
      const report = await planMatrixWave(r.deps, {
        waveId: "retired-review-publication",
        run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
        runtimeSha: SHA1,
        generation: 1,
        deadline: T0 + 60 * 60_000,
        plannedAt: T0,
      });
      assert.equal(report.plan.cells.length, 0);
      const after = r.state.repair!.work[0]!;
      assert.notEqual(after.target.pr, null, JSON.stringify(after.blocker));
      assert.notEqual(after.target.pr, 1149);
      assert.equal(after.target.head, SHA2);
      assert.equal(after.target.base, SHA1);
      assert.deepEqual(
        after.target.candidateState,
        record.target.candidateState,
      );
      assert.equal(after.nextStep, "review");
      assert.equal(after.counters.attempts, record.counters.attempts);
      assert.equal(after.counters.retries, record.counters.retries);
      assert.equal(r.github.reviewRequestIdentities[0]?.expectedHead, SHA2);
      assert.equal(r.state.repair!.reservations.length, 2);
      assert.equal(r.state.repair!.reservations[0]!.outcome, "ambiguous");
      assert.equal(r.state.repair!.reservations[1]!.purpose, "review_request");
      assert.equal(r.model.requests.length, 0);
      assert.ok(!r.github.calls.includes("push"));
      assert.ok(!r.github.calls.includes("preserveCandidate"));
    });
  }
});

Deno.test("retired preserved-null publication reconciles replacement creation after restart", async () => {
  const r = setup({ createOutcome: "ambiguous" });
  const record = {
    ...r.record,
    target: { ...r.record.target, pr: null, retiredOwnPr: 1149 },
  };
  r.state.repair = seededSnapshot([record]);
  const step = await executeWorkStep(r.deps, r.context(), record);
  assert.equal(step.kind, "progress", JSON.stringify(step));
  const pending = r.state.repair!.work[0]!;
  assert.equal(pending.target.pr, null);
  assert.equal(pending.intent?.kind, "pull_request");
  assert.equal(pending.intent?.key, `pull_request:${SHA2}:after-pr:1149`);
  assert.equal(r.state.repair!.reservations.length, 0);
  const published = await r.github.readPullRequest(7);
  assert.ok(published.ok && published.value?.state === "open");
  r.github.findPullRequestByHeadRef = () => Promise.resolve(published);
  await executeWorkStep(r.deps, r.context(), pending);
  await executeWorkStep(r.deps, r.context(), r.state.repair!.work[0]!);
  const after = r.state.repair!.work[0]!;
  assert.equal(after.target.pr, 7);
  assert.equal(after.target.head, SHA2);
  assert.equal(after.nextStep, "review");
  assert.equal(after.counters.attempts, record.counters.attempts);
  assert.equal(after.counters.retries, record.counters.retries);
  assert.equal(r.github.calls.filter((call) => call === "createPr").length, 1);
  assert.equal(r.github.reviewRequestIdentities.length, 1);
  assert.equal(r.model.requests.length, 0);
  assert.ok(!r.github.calls.includes("push"));
});

Deno.test("retired preserved-null publication requires its exact live published branch", async (t) => {
  for (
    const [name, publishedHead, branchRefSha] of [
      ["moved branch", SHA2, SHA3],
      ["deleted branch", SHA2, null],
      ["unbound published head", SHA3, SHA2],
    ] as const
  ) {
    await t.step(name, async () => {
      const r = setup({ branchRefSha }, publishedHead);
      const record = {
        ...r.record,
        target: { ...r.record.target, pr: null, retiredOwnPr: 1149 },
      };
      r.state.repair = seededSnapshot([record]);
      const step = await executeWorkStep(r.deps, r.context(), record);
      assert.equal(step.kind, "deferred", JSON.stringify(step));
      assert.deepEqual(r.state.repair!.work[0], record);
      assert.deepEqual(r.state.repair!.reservations, []);
      assert.ok(!r.github.calls.includes("createPr"));
      assert.ok(!r.github.calls.includes("push"));
      assert.equal(r.model.requests.length, 0);
    });
  }
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

/** Historical settled publication plus authenticated, not-yet-applied effects. */
function activePublicationCi(
  r: ReturnType<typeof setup>,
  publicationAfter?: number,
) {
  const proof = "a".repeat(64);
  const policy = {
    ...proposedCiMinutePolicy(),
    activated: true,
    storageAcceptance: proof,
    ceilingQualification: proof,
    targets: [{ ...r.record.repository, repositoryId: 1, ceilingMinutes: 20 }],
  };
  const original: CiEffectV1 = {
    repository: r.record.repository,
    kind: "pr_open",
    head: SHA2,
    base: SHA1,
    ref: `refs/heads/${r.branch}`,
    pr: null,
    ...(publicationAfter === undefined ? {} : { publicationAfter }),
  };
  const binding = {
    effect: original,
    repositoryId: 1,
    workflowBlob: SHA1,
    job: "validation",
  };
  const settled = {
    effectDigest: ciMinuteDigest({
      domain: "sentinel-ci-effect-v1",
      ...binding,
    }),
    policyDigest: ciPolicyDigest(policy),
    ceilingMinutes: 20,
    state: "settled" as const,
    createdAt: T0 - 60_000,
    settledAt: T0,
    chargedMinutes: 20,
    proofDigest: proof,
    binding,
  };
  let ledger: CiMinuteLedgerV1 = {
    version: 1,
    month: ciMonth(T0).month,
    policyDigest: ciPolicyDigest(policy),
    updatedAt: T0,
    sequence: 1,
    baselineMinutes: 0,
    watermark: T0,
    reservations: [settled],
    observed: [],
  };
  let head: GitSha = SHA1;
  const effects: CiEffectV1[] = [];
  const controller = new CalendarCiMinutes({
    policy,
    clock: r.clock,
    authorizePolicy: () => Promise.resolve(true),
    store: {
      read: () =>
        Promise.resolve(portOk({ head, ledger: structuredClone(ledger) })),
      readPrior: () => Promise.resolve(portOk({ head, ledger: null })),
      write(input) {
        assert.equal(input.expectedHead, head);
        const next = parseCiMinuteLedger(input.ledger);
        validateCiMinuteTransition(ledger, next);
        ledger = structuredClone(next);
        head = String(ledger.sequence).padStart(40, "0") as GitSha;
        return Promise.resolve(portOk({ status: "applied" as const, head }));
      },
    },
    resolve(effect) {
      effects.push(structuredClone(effect));
      return Promise.resolve({
        repositoryId: 1,
        workflowBlob: SHA1,
        job: "validation",
        jobs: 1,
        runner: "ubuntu-latest",
        timeoutMinutes: 20,
        ceilingMinutes: 20,
        qualificationDigest: proof,
        triggered: true,
        effectState: "not_applied",
      });
    },
    observe: (month) =>
      Promise.resolve({
        month,
        complete: true,
        watermark: r.clock.now(),
        jobs: [],
      }),
  });
  return { controller, effects, settled, ledger: () => ledger };
}

Deno.test("closed publication replacements reserve CI minutes after the latest retired PR", async (t) => {
  for (const phase of ["work", "observation", "request"] as const) {
    for (const previous of [undefined, 1148]) {
      await t.step(`${phase}/${previous ?? "original"}`, async () => {
        const r = setup();
        const ci = activePublicationCi(r, previous);
        r.deps.ciMinutes = ci.controller;
        const record = {
          ...r.record,
          nextStep: phase === "observation"
            ? "review" as const
            : "work" as const,
          target: {
            ...r.record.target,
            ...(previous === undefined ? {} : { retiredOwnPr: previous }),
          },
        };
        r.state.repair = seededSnapshot([record]);
        const intentKeys: string[] = [];
        const create = r.github.createPullRequest.bind(r.github);
        r.github.createPullRequest = (request) => {
          const intent = r.state.repair!.work[0]!.intent;
          assert.equal(intent?.kind, "pull_request");
          intentKeys.push(intent!.key);
          return create(request);
        };
        for (let replacement = 0; replacement < 2; replacement++) {
          const current: WorkRecordV1 = r.state.repair!.work[0]!;
          const closedPr: number = current.target.pr!;
          if (phase === "observation" || replacement > 0) {
            const step = await observeReview(r.deps, r.context(), current);
            assert.equal(step.kind, "progress", JSON.stringify(step));
          } else if (phase === "request") {
            const step = await requestReviewFor(
              r.deps,
              r.context(),
              current,
              closedPr,
            );
            assert.equal(step.kind, "progress", JSON.stringify(step));
          }
          // Resume only from the durable record, as a restarted worker does.
          const retired = r.state.repair!.work[0]!;
          const step = await executeWorkStep(r.deps, r.context(), retired);
          assert.equal(step.kind, "progress", JSON.stringify(step));
          const after: WorkRecordV1 = r.state.repair!.work[0]!;
          assert.equal(after.target.retiredOwnPr, closedPr);
          assert.equal(ci.effects.at(-1)!.publicationAfter, closedPr);
          assert.equal(intentKeys.at(-1), pullRequestIntentKey(SHA2, closedPr));
          assert.equal(ci.ledger().reservations.length, replacement + 2);
          assert.deepEqual(ci.ledger().reservations[0], ci.settled);
          assert.notEqual(after.target.pr, closedPr);
          assert.equal(after.target.head, SHA2);
          assert.deepEqual(
            after.target.candidateState,
            record.target.candidateState,
          );
          assert.equal(after.counters.attempts, record.counters.attempts);
          assert.equal(after.counters.retries, record.counters.retries);
          assert.equal(after.nextStep, "review");
          const live = r.github.candidatePullRequests.get(after.target.pr!)!;
          r.github.candidatePullRequests.set(live.number, {
            ...live,
            state: "closed",
          });
          r.clock.advance(60_000);
        }
        assert.equal(
          r.github.calls.filter((call) => call === "createPr").length,
          2,
        );
        assert.equal(r.model.requests.length, 0);
        assert.ok(!r.github.calls.includes("push"));
        assert.ok(!r.github.calls.includes("preserveCandidate"));
      });
    }
  }
});
