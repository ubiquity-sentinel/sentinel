/** Sanitized 65-attempt/70-review shape: unchanged candidates cost no new start. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import {
  ATTEMPT_DETAIL_INCOMPLETE,
  attemptEquivalenceRefusalForRecordV1,
  attemptMemorySettlementMutationV1,
} from "../../src/repair/attempt-policy.ts";
import { prepareImplementationStart } from "../../src/repair/loop-implementation.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { buildPrompt } from "../../src/repair/model-port-prompt.ts";
import {
  gitRun,
  makeRemoteCtx,
  reviewReceipt,
  SHA1,
  SHA2,
  SHA3,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";

function rig() {
  const clock = new FakeClock(T0 + 10_000);
  const state = new MemoryState();
  const githubOptions = { baseSha: SHA1 };
  const github = new FakeGithub(githubOptions);
  let patch = "a".repeat(64);
  github.proveCarriedPatch = (request) =>
    Promise.resolve(portOk({
      reviewedMergeBase: request.reviewedBase,
      reviewedPatch: patch,
      refreshedMergeBase: request.base,
      refreshedPatch: patch,
      refreshedFrom: null,
      refreshes: 0,
    }));
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const budget = new RollingStartBudget({ clock, state, configs });
  let reservations = 0;
  const deps: RepairCycleDepsV1 = {
    clock,
    state,
    configs,
    github,
    budget: {
      reserveModelStart: (request) => {
        reservations++;
        return budget.reserveModelStart(request);
      },
      settleModelStart: (request) => budget.settleModelStart(request),
    },
    controllerSha: SHA1,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
    model: new FakeModel(),
  };
  const record = workRecord("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA1 },
    target: {
      base: SHA1,
      head: SHA2,
      pr: 12,
      branch: candidateBranch(workRecord("issue-1").id),
      checkpoint: null,
    },
    counters: { attempts: 65, retries: 64, reviewRounds: 70 },
  });
  state.repair = seededSnapshot([record]);
  state.repairHead = SHA1;
  function review(
    message = "same unresolved defect",
    fingerprint = "b".repeat(64),
  ) {
    const head = state.repair!.work[0].target.head;
    state.repair!.reviews.push(
      reviewReceipt(`review-${state.repair!.reviews.length}`, {
        pullRequest: {
          number: 12,
          head,
          base: state.repair!.work[0].target.base,
        },
        outcome: "completed",
        observedReviewer: "chatgpt-codex-connector[bot]",
        resultId: `result-${clock.now()}`,
        summary: "fix required",
        completedAt: clock.now(),
        observedAt: clock.now(),
        unresolvedSeverities: ["P0"],
        findings: [{
          id: `finding-${clock.now()}`,
          severity: "P0",
          path: "src/app.ts",
          message,
          fingerprint,
          resolved: false,
          resolutionEvidence: null,
        }],
      }),
    );
  }
  async function prepare() {
    const context: LoopContextV1 = {
      snapshot: state.repair!,
      head: state.repairHead,
      executionBaseline: state.repair!.work[0],
      bounds: {
        runDeadline: clock.now() + 3_600_000,
        modelCutoff: clock.now() + 3_600_000,
      },
    };
    return await prepareImplementationStart(
      deps,
      context,
      state.repair!.work[0],
      configs[0],
    );
  }
  async function next(
    target: Partial<WorkRecordV1["target"]> = {},
    outcome: "submitted" | "confirmed_not_submitted" = "submitted",
  ) {
    const reservation = state.repair!.reservations.at(-1)!;
    const settled = await budget.settleModelStart({
      id: reservation.id,
      outcome,
      proofRef: outcome === "submitted"
        ? null
        : "artifact://attempt-progress/unsent",
    });
    assert.ok(
      settled.status === "settled" || settled.status === "idempotent",
      JSON.stringify(settled),
    );
    const current = state.repair!.work[0];
    state.repair!.work[0] = {
      ...current,
      target: { ...current.target, ...target },
      nextStep: "work",
      intent: null,
      wait: null,
      blocker: null,
    };
    clock.advance(1000);
    review();
  }
  review();
  return {
    state,
    clock,
    github,
    prepare,
    next,
    review,
    reservations: () => reservations,
    setBase: (base: typeof SHA1) => {
      githubOptions.baseSha = base;
    },
    setPatch: (digest: string) => {
      patch = digest;
    },
  };
}

Deno.test("65-attempt shape refuses the second identical fingerprint before reservation; changed findings proceed", async () => {
  const r = rig();
  const first = await r.prepare();
  assert.equal(first.kind, "prepared", first.kind);
  const priorId = r.state.repair!.reservations.at(-1)!.id;
  await r.next({ head: SHA3 }); // A different commit with the SAME content is not progress.
  const second = await r.prepare();
  assert.equal(second.kind, "progress", second.kind);
  assert.equal(
    r.reservations(),
    1,
    "the duplicate never reaches reserveModelStart",
  );
  const refused = r.state.repair!.work[0];
  assert.match(
    refused.blocker!.message,
    new RegExp(`identical_attempt_refused.*${priorId}`),
  );
  assert.equal(
    refused.counters.attempts,
    66,
    "no charge or counter reset for a refusal",
  );
  assert.equal(refused.counters.reviewRounds, 70, "no artificial round cap");

  r.clock.advance(1000);
  r.review("new review evidence");
  r.state.repair!.work[0] = { ...refused, nextStep: "work", blocker: null };
  const distinct = await r.prepare();
  assert.equal(distinct.kind, "prepared", distinct.kind);
  assert.equal(r.reservations(), 2);
  if (distinct.kind !== "prepared") return;
  const prompt = buildPrompt(distinct.request, false);
  assert.match(prompt, /identical_attempt_refused/);
  assert.ok(
    prompt.includes(priorId),
    "the next distinct attempt sees the exact prior attempt id",
  );
});

Deno.test("candidate progress admits a changed base or patch with the same review findings", async () => {
  for (const changed of ["base", "patch"] as const) {
    const r = rig();
    assert.equal((await r.prepare()).kind, "prepared");
    if (changed === "base") {
      r.setBase(SHA3);
      await r.next({ base: SHA3 });
    } else {
      r.setPatch("c".repeat(64));
      await r.next({ head: SHA3 });
    }
    assert.equal(
      (await r.prepare()).kind,
      "prepared",
      `${changed} is new evidence`,
    );
    assert.equal(r.reservations(), 2);
  }
});

Deno.test("candidate progress does not refuse a proven unsubmitted start", async () => {
  const r = rig();
  assert.equal((await r.prepare()).kind, "prepared");
  await r.next({}, "confirmed_not_submitted");
  assert.equal((await r.prepare()).kind, "prepared");
  assert.equal(r.reservations(), 2);
  assert.equal(r.state.repair!.work[0].target.attemptFingerprints!.length, 1);
});

Deno.test("an unavailable candidate patch proof defers without a reservation", async () => {
  const r = rig();
  r.github.proveCarriedPatch = undefined;
  const result = await r.prepare();
  assert.equal(result.kind, "deferred");
  assert.equal(r.reservations(), 0);
  assert.equal(r.state.repair!.work[0].counters.attempts, 65);
});

Deno.test("candidate progress lifecycle uses real Git patch bytes, not candidate commit ids", async () => {
  const tmp = await Deno.makeTempDir({
    dir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
    prefix: "sentinel-attempt-progress-",
  });
  try {
    const env = testGitEnv(tmp);
    const { work } = await makeRemoteCtx(tmp, env);
    const commit = async (content: string): Promise<GitSha> => {
      await Deno.writeTextFile(`${work}/app.ts`, content);
      const added = await gitRun(work, ["add", "app.ts"], env);
      assert.ok(added.ok, added.stderr);
      const committed = await gitRun(work, [
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "candidate",
      ], env);
      assert.ok(committed.ok, committed.stderr);
      const head = await gitRun(work, ["rev-parse", "HEAD"], env);
      assert.ok(head.ok, head.stderr);
      return head.stdout.trim() as GitSha;
    };
    const base = await commit("base\n");
    const head = await commit("candidate patch\n");
    const equivalentHead = await commit("candidate patch\n");
    assert.notEqual(head, equivalentHead);
    const git = new DenoGitExecutor({
      localDir: work,
      remoteUrl: work,
      gitHome: tmp,
    });
    const r = rig();
    r.setBase(base);
    const record = r.state.repair!.work[0];
    r.state.repair!.work[0] = {
      ...record,
      target: { ...record.target, base, head },
    };
    r.github.proveCarriedPatch = git.carriedPatchProof.bind(git);
    r.review();
    const first = await r.prepare();
    assert.equal(first.kind, "prepared", first.kind);
    const priorId = r.state.repair!.reservations.at(-1)!.id;
    await r.next({ head: equivalentHead });
    assert.equal((await r.prepare()).kind, "progress");
    assert.equal(r.reservations(), 1);
    assert.ok(r.state.repair!.work[0].blocker!.message.includes(priorId));

    r.clock.advance(1000);
    r.review("a distinct finding on the same patch");
    const refused = r.state.repair!.work[0];
    r.state.repair!.work[0] = { ...refused, nextStep: "work", blocker: null };
    assert.equal((await r.prepare()).kind, "prepared");
    assert.equal(r.reservations(), 2);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("candidate progress treats a changed finding fingerprint as distinct review evidence", async () => {
  const r = rig();
  assert.equal((await r.prepare()).kind, "prepared");
  await r.next();
  r.clock.advance(1000);
  r.review("same unresolved defect", "e".repeat(64));
  assert.equal((await r.prepare()).kind, "prepared");
  assert.equal(r.reservations(), 2);
});

Deno.test("upstream legacy outcome counts cannot veto distinct candidate findings", async () => {
  const r = rig();
  assert.equal((await r.prepare()).kind, "prepared");
  const record = r.state.repair!.work[0];
  // Historical outcomes lack patch/findings bindings. Preserve their counts,
  // but let the pre-reservation candidate-input gate compare current evidence.
  for (let n = 0; n < 3; n++) {
    const remember = await attemptMemorySettlementMutationV1({
      record,
      detail: ATTEMPT_DETAIL_INCOMPLETE,
      now: r.clock.now(),
      runtimeSha: SHA1,
    });
    remember(r.state.repair!);
  }
  assert.equal(r.state.repair!.attemptMemory[0].entries[0].count, 3);
  assert.equal(
    attemptEquivalenceRefusalForRecordV1({
      record,
      snapshot: r.state.repair!,
      now: r.clock.now(),
      runtimeSha: SHA1,
    }).refuse,
    false,
  );
  await r.next();
  r.clock.advance(1000);
  r.review("changed findings must still reach admission");
  assert.equal((await r.prepare()).kind, "prepared");
  assert.equal(r.reservations(), 2);
  assert.equal(
    r.state.repair!.attemptMemory[0].entries[0].count,
    3,
    "historical accounting retained",
  );
});
