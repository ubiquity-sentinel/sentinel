/**
 * Launcher half of the CI-first pipeline (owner decision 2026-10-16):
 *
 * - L1: CI runs GitHub holds for approval on a bot-pushed head are approved
 *   while the record waits for its pre-review CI at `work` (or is parked by
 *   the pre-review gate), not only once it is in review or delivery;
 * - L2: a head parked red before review (the exhausted park included) gets
 *   its failed run re-run once;
 * - L3: a pre-review park whose head is green again on its unchanged base
 *   returns to `work` under any runtime (the exhausted park included); under
 *   a proven CI-first runtime a red or pending park whose base moved returns
 *   to `work` for the runtime's deterministic, uncharged refresh (its CI is
 *   then gated before any review); a red one returns with the CI fix marker
 *   only under an allowlisted fix runtime (generation 81+, none pinned yet);
 * - L4: the launcher never re-admits a fix for a record whose three CI fixes
 *   are spent, and never refreshes its red head on a moved base.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  CI_CORRECTION_REVIEW_ROUNDS,
  ciCorrectable,
} from "../../src/repair/ci-rejection.ts";
import {
  CI_FIRST_REVIEW_ROUNDS,
  CI_FIX_ATTEMPTS,
  HOSTED_PRE_REVIEW_CI_FIXES,
  preReviewCiFixRouteOpen,
} from "../../src/repair/ci-first-policy.ts";
import {
  ciFirstFixRuntimeProven,
  ciFirstFixSelfInstalledRuntimeProven,
  ciFirstRuntimeProven,
  ciFirstSelfInstalledRuntimeProven,
  HOSTED_AUTONOMY_CI_FIRST_FIX_MIN_GENERATION,
  HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES,
  HOSTED_AUTONOMY_CI_FIRST_RUNTIMES,
  HOSTED_AUTONOMY_CI_FIRST_SELF_INSTALLED_MIN_GENERATION,
} from "../../ops/hosted-autonomy-ci-first.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy-retries.ts";
import {
  ciGreenHeadKey,
  HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES,
} from "../../ops/hosted-autonomy-ci-retries.ts";
import {
  HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS,
  HOSTED_AUTONOMY_RETRYABLE,
  hostedRepositoryKey,
} from "../../ops/hosted-autonomy-policy.ts";
import { runHostedCiRerunPass } from "../../ops/hosted-autonomy-ci-rerun.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyHeadRunV1,
} from "../../ops/hosted-autonomy-types.ts";
import { SHA1, SHA2, T0 } from "../state/helpers.ts";
import {
  assertGen79Parses,
  assertGen80Parses,
  gen79Available,
  gen80Available,
} from "../state/gen77-contracts.ts";
import {
  authorizingReceipt,
  BASE,
  deliveryRecord,
  foreignPullFacts,
  HEAD,
  pullFacts,
  SELF_REPO,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import {
  healthyProof,
  makeRig,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

/** The generation-79 and 80 sources are absent from shallow CI checkouts. */
const GEN79 = await gen79Available();
const GEN80 = await gen80Available();
/** R80, the pinned CI-first runtime and generation 81's rollback target. */
const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481";
const R81 = "da98f5f49c45b57cfa97a45fe647c36b1021f302";
const SELF_INSTALLED = "c019bcd5833eff5551201d1b46039a0996841b8b";
const R79 = "549c7a69186b3d2070aa4e69c92ee846d183ce8f";

const RED_PARK = "CI red before review; awaiting a CI fix: validate(failure)";
const PENDING_PARK =
  "CI did not finish before review within 6 hours: validate(in_progress)";
const EXHAUSTED_PARK = "CI fix attempts exhausted (3 of 3): validate(failure)";

const PRESERVED = {
  operationKey: `impl:${"d".repeat(64)}`,
  base: BASE,
  head: HEAD,
  ref: `refs/heads/sentinel-candidates/${"c".repeat(64)}`,
};

/** A published, never-reviewed head as the runtime's pre-review gate left it. */
function preReview(overrides: Record<string, unknown> = {}) {
  return deliveryRecord({
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      checkpoint: null,
      head: HEAD,
      pr: 51,
      candidateState: { preserved: PRESERVED, publishedHead: HEAD },
    },
    nextStep: "blocked",
    blocker: { kind: "other", message: RED_PARK, since: T0 + 3000 },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    evidence: [],
    ...overrides,
  });
}

const FIX_RUNTIME = "8181818181818181818181818181818181818181" as GitSha;
function installed(
  revision: string,
  generation: number,
): HostedRuntimeRecordV1 {
  return {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: revision,
    generation,
    lastHealthyProof: healthyProof(revision, generation, "ci-first-fix"),
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
  } as HostedRuntimeRecordV1;
}

const TIPS = new Map([[hostedRepositoryKey(SELF_REPO), BASE as string]]);
const HEAD_KEY = ciGreenHeadKey(SELF_REPO, HEAD);

/**
 * Plans under one installed runtime: by default a generation-81 runtime that
 * is neither CI-first nor a fix runtime; `ciFirst` lists it as a CI-first
 * runtime, `fixRuntime` as a CI-first fix runtime (which is CI-first too),
 * and `r80` plans under the exact pinned R80 with the production allowlists.
 */
function plan(
  snapshot: RepairStateSnapshotV1,
  options: {
    green?: boolean;
    settled?: boolean;
    ciFirst?: boolean;
    fixRuntime?: boolean;
    selfInstalled?: boolean;
    r80?: boolean;
    tip?: string;
  } = {},
) {
  const runtime = options.r80 === true
    ? R80
    : options.selfInstalled === true
    ? SELF_INSTALLED
    : options.fixRuntime === true
    ? FIX_RUNTIME
    : SHA2;
  const ciFirst = options.ciFirst === true || options.fixRuntime === true;
  const cast = {
    ciRuntime: installed(
      runtime,
      options.r80 === true ? 80 : options.selfInstalled === true ? 89 : 81,
    ),
    ...(options.r80 === true || options.selfInstalled === true ? {} : {
      ciAllowlist: new Set([runtime]),
      ciFirstAllowlist: new Set(ciFirst ? [runtime] : []),
      ciFirstFixAllowlist: new Set(
        options.fixRuntime === true ? [runtime] : [],
      ),
    }),
    ciGreenHeads: new Set(options.green === true ? [HEAD_KEY] : []),
    ciRerunSettled: new Set(options.settled === true ? [HEAD_KEY] : []),
  } as Parameters<typeof planHostedRetries>[6];
  return planHostedRetries(
    snapshot,
    T0 + 9000,
    runtime as GitSha,
    options.tip === undefined
      ? TIPS
      : new Map([[hostedRepositoryKey(SELF_REPO), options.tip]]),
    new Set(),
    undefined,
    cast,
  );
}

Deno.test("CI first L3: a pre-review park green again returns to work under any runtime", async () => {
  for (const message of [RED_PARK, PENDING_PARK]) {
    const snapshot = repairSnapshot([
      preReview({
        blocker: { kind: "other", message, since: T0 + 3000 },
      }),
    ], []);
    const plans = plan(snapshot, { green: true });
    assert.equal(plans.length, 1, message);
    assert.equal(plans[0].nextStep, "work");
    assert.equal(plans[0].advanceBase, false);
    assert.equal(plans[0].reviewRounds, null);
    const next = applyHostedRetries(snapshot, SHA1, plans, T0 + 9000);
    const work = next.work[0];
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.equal(work.wait, null, "no fix marker for a green head");
    assert.deepEqual(work.counters, snapshot.work[0].counters);
    assert.deepEqual(work.target, snapshot.work[0].target);
    if (GEN79) await assertGen79Parses(next);
    if (GEN80) await assertGen80Parses(next);
    // The green rule needs the unchanged base: on a moved base the green
    // read is of a stale head, and the runtime skips a blocked record, so
    // under a runtime not proven CI-first the park stays parked (the moved
    // base rule below needs a CI-first runtime).
    assert.deepEqual(plan(snapshot, { green: true, tip: SHA1 }), []);
  }
});

Deno.test("CI first L3: under a proven CI-first runtime a pre-review park on a moved base returns to work for its uncharged refresh", async () => {
  for (const message of [RED_PARK, PENDING_PARK]) {
    const snapshot = repairSnapshot([
      preReview({
        blocker: { kind: "other", message, since: T0 + 3000 },
      }),
    ], []);
    // The exact pinned R80 (production allowlists), a CI-first runtime that
    // is not a fix runtime, and a generation-81 fix runtime all return it,
    // green or red, settled or not: the refreshed head is a new head whose
    // CI the runtime gates before any review.
    for (
      const options of [
        { r80: true },
        { selfInstalled: true },
        { ciFirst: true },
        { fixRuntime: true, settled: true },
        { ciFirst: true, green: true },
        { selfInstalled: true, green: true },
      ]
    ) {
      const plans = plan(snapshot, { ...options, tip: SHA1 });
      assert.equal(plans.length, 1, `${message} ${JSON.stringify(options)}`);
      assert.equal(plans[0].nextStep, "work");
      assert.equal(plans[0].advanceBase, false, "the runtime reads the tip");
      assert.equal(plans[0].reviewRounds, null);
      assert.equal(plans[0].grant, 0);
      assert.equal(plans[0].ciFixMarker, undefined, "no fix marker");
      assert.match(plans[0].detail, /:base-moved$/);
      const next = applyHostedRetries(snapshot, SHA1, plans, T0 + 9000);
      const work = next.work[0];
      assert.equal(work.nextStep, "work");
      assert.equal(work.blocker, null);
      assert.equal(work.wait, null);
      assert.equal(work.intent, null, "the runtime's freshness gate refreshes");
      assert.deepEqual(work.counters, snapshot.work[0].counters, "uncharged");
      assert.deepEqual(work.target, snapshot.work[0].target);
      if (GEN80) await assertGen80Parses(next);
    }
    // Not under a runtime that is not proven CI-first, and not without a
    // review round left (the runtime's ceiling gate would park it before
    // any refresh).
    assert.deepEqual(plan(snapshot, { tip: SHA1 }), []);
    assert.deepEqual(plan(snapshot, { tip: SHA1, green: true }), []);
    const spent = repairSnapshot([
      preReview({
        blocker: { kind: "other", message, since: T0 + 3000 },
        counters: { attempts: 1, retries: 0, reviewRounds: 3 },
      }),
    ], []);
    assert.deepEqual(plan(spent, { r80: true, tip: SHA1 }), []);
    // An unknown tip is not a moved base.
    assert.deepEqual(
      planHostedRetries(
        snapshot,
        T0 + 9000,
        R80 as GitSha,
        new Map(),
        new Set(),
        undefined,
        { ciRuntime: installed(R80, 80) },
      ),
      [],
    );
  }
});

Deno.test("CI first L3: a red pre-review park returns with the fix marker only under a fix runtime", async () => {
  const snapshot = repairSnapshot([preReview()], []);
  assert.deepEqual(plan(snapshot), [], "nothing before the re-run settles");
  assert.deepEqual(plan(snapshot, { settled: true }), [], "not a fix runtime");
  assert.deepEqual(
    plan(snapshot, { settled: true, r80: true }),
    [],
    "R80 keeps the hosted pre-review fix route closed",
  );
  assert.deepEqual(
    plan(snapshot, { settled: true, ciFirst: true }),
    [],
    "CI-first alone opens no fix",
  );
  const plans = plan(snapshot, { settled: true, fixRuntime: true });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].nextStep, "work");
  const next = applyHostedRetries(snapshot, SHA1, plans, T0 + 9000);
  const work = next.work[0];
  assert.equal(work.nextStep, "work");
  assert.equal(work.blocker, null);
  assert.deepEqual(work.wait, {
    reason: "backoff",
    since: T0 + 9000,
    until: T0 + 9000,
  });
  assert.deepEqual(work.counters, snapshot.work[0].counters, "nothing charged");
  if (GEN79) await assertGen79Parses(next);
  if (GEN80) await assertGen80Parses(next);
  // No fix is re-admitted once three are spent or no review round is left.
  for (
    const counters of [
      { attempts: 4, retries: 3, reviewRounds: 0 },
      { attempts: 2, retries: 0, reviewRounds: 3 },
    ]
  ) {
    const spent = repairSnapshot([preReview({ counters })], []);
    assert.deepEqual(
      plan(spent, { settled: true, fixRuntime: true }),
      [],
      JSON.stringify(counters),
    );
  }
});

Deno.test("CI first L3/L4: the pre-review exhausted park gets the green rule, never a fix or a moved-base refresh", async () => {
  const exhausted = repairSnapshot([
    preReview({
      blocker: { kind: "other", message: EXHAUSTED_PARK, since: T0 + 3000 },
      counters: { attempts: 4, retries: 3, reviewRounds: 0 },
    }),
  ], []);
  // Red: no fix and no refresh, at any base, under any runtime.
  for (
    const options of [
      {},
      { settled: true, fixRuntime: true },
      { r80: true },
      { tip: SHA1, r80: true },
      { tip: SHA1, settled: true, fixRuntime: true },
      { tip: SHA1, green: true, fixRuntime: true },
    ]
  ) {
    assert.deepEqual(plan(exhausted, options), [], JSON.stringify(options));
  }
  // Green again on its unchanged base (a flake), it returns to `work` under
  // any runtime with nothing charged: the runtime's gate then requests the
  // review, and a red head parks exhausted again (no fourth fix).
  for (const options of [{ green: true }, { green: true, r80: true }]) {
    const plans = plan(exhausted, options);
    assert.equal(plans.length, 1, JSON.stringify(options));
    assert.equal(plans[0].nextStep, "work");
    assert.equal(plans[0].ciFixMarker, undefined);
    assert.match(plans[0].detail, /^other:CI fix attempts exhausted.*:green$/);
    const next = applyHostedRetries(exhausted, SHA1, plans, T0 + 9000);
    assert.equal(next.work[0].wait, null);
    assert.deepEqual(next.work[0].counters, exhausted.work[0].counters);
    if (GEN80) await assertGen80Parses(next);
  }
  // ...and only with a review round left.
  const spent = repairSnapshot([
    preReview({
      blocker: { kind: "other", message: EXHAUSTED_PARK, since: T0 + 3000 },
      counters: { attempts: 4, retries: 3, reviewRounds: 3 },
    }),
  ], []);
  assert.deepEqual(plan(spent, { green: true, r80: true }), []);
  // The merge gate writes the same message for a REVIEWED head (a completed
  // review binds it): green, it belongs to delivery, not to another review,
  // so that park keeps generation 80's terms and nothing re-admits it.
  const mergeGate = repairSnapshot([
    preReview({
      blocker: { kind: "other", message: EXHAUSTED_PARK, since: T0 + 3000 },
      counters: { attempts: 4, retries: 3, reviewRounds: 1 },
    }),
  ], [authorizingReceipt()]);
  for (
    const options of [
      { green: true },
      { green: true, r80: true },
      { green: true, settled: true, fixRuntime: true },
      { tip: SHA1, r80: true },
    ]
  ) {
    assert.deepEqual(plan(mergeGate, options), [], JSON.stringify(options));
  }
  for (const message of [EXHAUSTED_PARK, RED_PARK, PENDING_PARK]) {
    assert.equal(
      HOSTED_AUTONOMY_RETRYABLE.some((rule) => message.startsWith(rule.prefix)),
      false,
      `no retry-table prefix matches ${message}`,
    );
  }
  // L4: the runtime's own correctability counts the CI fixes.
  const reviewed = deliveryRecord({
    counters: { attempts: 4, retries: 3, reviewRounds: 1 },
  });
  assert.equal(ciCorrectable(reviewed, { reservations: [] }), false);
  assert.equal(
    ciCorrectable({
      ...reviewed,
      counters: { attempts: 3, retries: 2, reviewRounds: 1 },
    }, { reservations: [] }),
    true,
  );
});

Deno.test("CI first L1: a held CI run on a head waiting for its pre-review CI is approved", async () => {
  for (
    const record of [
      preReview({
        nextStep: "work",
        blocker: null,
        wait: { reason: "ci_pending", since: T0, until: T0 + 300_000 },
      }),
      preReview(),
    ]
  ) {
    const { rig, github } = await makeRig(
      `ci-first-approve-${record.nextStep}`,
      {
        repair: repairSnapshot([record], []),
        pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
        checkGreen: false,
        // Still red: the park stays parked through the retry pass.
        foreignCheckGreen: false,
      },
    );
    try {
      const calls: number[] = [];
      github.listParkedRuns = (head: string) => {
        assert.equal(head, HEAD);
        return Promise.resolve([4242]);
      };
      github.approveRun = (id: number) => {
        calls.push(id);
        return Promise.resolve(true);
      };
      const result = await run(rig, github);
      assert.deepEqual(calls, [4242], record.nextStep);
      assert.ok(
        result.actions.includes(`approve:${TARGET}:run=4242:approved`),
        JSON.stringify(result.actions),
      );
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  }
});

Deno.test("CI first L1: an unpublished record at work holds no approval", async () => {
  const record = deliveryRecord({
    nextStep: "work",
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      checkpoint: null,
      head: null,
      pr: null,
    },
    counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    evidence: [],
  });
  const { rig, github } = await makeRig("ci-first-approve-none", {
    repair: repairSnapshot([record], []),
    pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
  });
  try {
    const listed: string[] = [];
    github.listParkedRuns = (head: string) => {
      listed.push(head);
      return Promise.resolve([4242]);
    };
    await run(rig, github);
    assert.deepEqual(listed, []);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

function headRun(
  overrides: Partial<HostedAutonomyHeadRunV1> = {},
): HostedAutonomyHeadRunV1 {
  return {
    id: 9001,
    headSha: HEAD,
    status: "completed",
    conclusion: "failure",
    runAttempt: 1,
    createdAt: T0 - 60_000,
    ...overrides,
  };
}

Deno.test("CI first L2: a head parked red before review is re-run once on its green base", async () => {
  const reruns: number[] = [];
  let runs = [headRun()];
  const surface: HostedAutonomyGitHubV1 = {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: () => Promise.resolve(BASE),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: (sha) => Promise.resolve(sha === BASE),
    readPull: () =>
      Promise.resolve(foreignPullFacts({
        state: "open",
        merged: false,
        mergeCommitSha: null,
        author: "ubiquity-sentinel[bot]",
        headSha: HEAD,
        baseRef: "development",
      })),
    readIssueOpen: () => Promise.resolve(true),
    merge: () => Promise.reject(new Error("never merges")),
    closeIssue: () => Promise.reject(new Error("never closes")),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    listHeadRuns: (head: string) =>
      Promise.resolve(runs.filter((item) => item.headSha === head)),
    rerunFailedJobs: (id: number) => {
      reruns.push(id);
      runs = runs.map((item) =>
        item.id === id
          ? { ...item, status: "queued", conclusion: null, runAttempt: 2 }
          : item
      );
      return Promise.resolve(true);
    },
  };
  const pass = async (snapshot: RepairStateSnapshotV1) => {
    const actions: string[] = [];
    const deps = {
      state: undefined,
      githubFor: () => surface,
      clock: { now: () => T0 },
    } as unknown as HostedAutonomyDepsV1;
    const context = {
      deps,
      actions,
      revisions: [],
      snapshot,
      observedHead: SHA1,
      initialHead: SHA1,
      releaseSnapshot: undefined,
      closedIssues: new Set<string>(),
      foreignMerged: new Map(),
      dedicatedReservations: new Set<string>(),
      ...createHostedAutonomyScopes(deps),
    } as unknown as HostedAutonomyPassContextV1;
    await runHostedCiRerunPass(context);
    return actions;
  };
  const snapshot = repairSnapshot([preReview()], []);
  assert.deepEqual(await pass(snapshot), [`rerun:${TARGET}:run=9001:sent`]);
  assert.deepEqual(reruns, [9001]);
  assert.deepEqual(await pass(snapshot), [], "once per head");
  // The exhausted park gets the same one re-run (a flake that turns green
  // returns through the green rule; it is never fixed a fourth time).
  runs = [headRun({ id: 9002 })];
  const exhausted = repairSnapshot([
    preReview({
      blocker: { kind: "other", message: EXHAUSTED_PARK, since: T0 + 3000 },
      counters: { attempts: 4, retries: 3, reviewRounds: 0 },
    }),
  ], []);
  assert.deepEqual(await pass(exhausted), [`rerun:${TARGET}:run=9002:sent`]);
  assert.deepEqual(reruns, [9001, 9002]);
  assert.deepEqual(await pass(exhausted), [], "once per head");
  // The merge gate's exhausted park of a reviewed head is not re-run.
  runs = [headRun({ id: 9003 })];
  const mergeGate = repairSnapshot([
    preReview({
      blocker: { kind: "other", message: EXHAUSTED_PARK, since: T0 + 3000 },
      counters: { attempts: 4, retries: 3, reviewRounds: 1 },
    }),
  ], [authorizingReceipt()]);
  assert.deepEqual(await pass(mergeGate), []);
  assert.deepEqual(reruns, [9001, 9002]);
});

Deno.test("CI first: a healthy self-installed runtime is proven without a historical rollout row", () => {
  const runtime = installed(SELF_INSTALLED, 89);
  assert.equal(HOSTED_AUTONOMY_CI_FIRST_SELF_INSTALLED_MIN_GENERATION, 82);
  assert.equal(ciFirstRuntimeProven(runtime), false);
  assert.equal(ciFirstSelfInstalledRuntimeProven(runtime), true);
  assert.equal(ciFirstFixSelfInstalledRuntimeProven(runtime), true);
  assert.equal(
    ciFirstSelfInstalledRuntimeProven(installed(SELF_INSTALLED, 81)),
    false,
    "the self-install route starts at generation 82",
  );
  assert.equal(
    ciFirstSelfInstalledRuntimeProven(installed(R79, 89)),
    false,
    "a pre-CI-first rollback stays excluded at a higher generation",
  );
  const wrong = {
    ...runtime,
    lastHealthyProof: healthyProof(
      SELF_INSTALLED as GitSha,
      88,
      "ci-first-fix",
    ),
  } as HostedRuntimeRecordV1;
  assert.equal(ciFirstSelfInstalledRuntimeProven(wrong), false);
});

Deno.test("CI first: generation 81 opens the hosted pre-review fix route; its fix allowlist waits for the pin", () => {
  assert.equal(CI_FIX_ATTEMPTS, 3);
  assert.equal(
    CI_FIRST_REVIEW_ROUNDS,
    5,
    "owner decisions: 3 rounds (2026-10-16), raised to 5 (2026-10-24)",
  );
  assert.equal(CI_CORRECTION_REVIEW_ROUNDS, CI_FIRST_REVIEW_ROUNDS);
  assert.equal(HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS, CI_FIRST_REVIEW_ROUNDS);
  assert.equal(HOSTED_PRE_REVIEW_CI_FIXES, true, "R80 isolates the cell");
  assert.equal(preReviewCiFixRouteOpen({}), true, "open in process");
  assert.equal(
    preReviewCiFixRouteOpen({ externalImplementations: true }),
    true,
    "open in hosted generation-81 runs",
  );
  // R81 alone opens hosted pre-review fixes; rollback R80 remains CI-first.
  assert.deepEqual([...HOSTED_AUTONOMY_CI_FIRST_RUNTIMES], [R80, R81]);
  assert.deepEqual([...HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES], [R81]);
  assert.equal(ciFirstFixRuntimeProven(installed(R81, 81)), true);
  assert.equal(ciFirstFixRuntimeProven(installed(R81, 80)), false);
  assert.equal(ciFirstFixRuntimeProven(installed(FIX_RUNTIME, 81)), false);
  assert.equal(HOSTED_AUTONOMY_CI_FIRST_FIX_MIN_GENERATION, 81);
  for (const revision of HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES) {
    assert.ok(HOSTED_AUTONOMY_CI_FIRST_RUNTIMES.has(revision), revision);
    assert.ok(HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES.has(revision), revision);
  }
  // A fix runtime is proven only at generation 81+, listed as CI-first too,
  // with its own healthy proof: R80 (route closed) never is.
  const fix = new Set([FIX_RUNTIME]);
  assert.equal(
    ciFirstFixRuntimeProven(installed(FIX_RUNTIME, 81), fix, fix),
    true,
  );
  assert.equal(
    ciFirstFixRuntimeProven(installed(FIX_RUNTIME, 80), fix, fix),
    false,
    "below generation 81",
  );
  assert.equal(
    ciFirstFixRuntimeProven(installed(FIX_RUNTIME, 81), fix, new Set()),
    false,
    "not a CI-first runtime",
  );
  assert.equal(
    ciFirstFixRuntimeProven(installed(R80, 80), new Set([R80])),
    false,
    "R80 keeps the route closed",
  );
  assert.equal(ciFirstFixRuntimeProven(installed(R80, 80)), false);
  assert.equal(ciFirstFixRuntimeProven(null), false);
  // Generation 80's re-admission of exactly R80's hosted parks is the fix
  // rule's job once R81 is pinned, so R80 is not itself a fix runtime.
  assert.equal(HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES.has(R80), false);
});

Deno.test("CI first: every allowlisted CI-first fix runtime opens the hosted pre-review fix route in its own tree", async () => {
  const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
  const git = async (args: string[]) => {
    const output = await new Deno.Command("git", {
      args: ["-C", root, ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
    return output.success ? new TextDecoder().decode(output.stdout) : null;
  };
  // The tree that pins a fix runtime is that runtime's own launcher: its
  // route must be open here too.
  if (HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES.size > 0) {
    assert.equal(HOSTED_PRE_REVIEW_CI_FIXES, true);
  }
  for (const revision of HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES) {
    assert.match(revision, /^[0-9a-f]{40}$/);
    if (await git(["cat-file", "-e", `${revision}^{commit}`]) === null) {
      continue;
    }
    const source = await git([
      "show",
      `${revision}:src/repair/ci-first-policy.ts`,
    ]);
    assert.ok(source !== null, revision);
    assert.match(
      source,
      /^export const HOSTED_PRE_REVIEW_CI_FIXES = true;$/m,
      `${revision} keeps the hosted pre-review fix route closed`,
    );
  }
  // R80 keeps it closed: listing it would re-admit fixes it cannot run.
  if (await git(["cat-file", "-e", `${R80}^{commit}`]) !== null) {
    const source = await git(["show", `${R80}:src/repair/ci-first-policy.ts`]);
    assert.match(
      source ?? "",
      /^export const HOSTED_PRE_REVIEW_CI_FIXES = false;$/m,
    );
  }
});
