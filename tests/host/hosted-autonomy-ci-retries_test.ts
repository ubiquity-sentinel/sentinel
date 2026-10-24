/**
 * Launcher re-admission of reviewed heads parked on the runtime's merge-gate
 * CI failure: the exact eligible shape returns to `delivery` with nothing
 * charged, refreshed or counted, and every other shape stays parked.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { LEGACY_REVIEW_ROUND_CEILING } from "../../src/repair/review-round-cap.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { GREEN_SPENT_LEFT_TO_DELIVERY } from "../../ops/hosted-autonomy-retries.ts";
import {
  ciCorrectionRuntimeProven,
  ciGreenHeadKey,
  ciGreenRedeliveryEligible,
  ciRedeliveryEligible,
  HOSTED_AUTONOMY_CI_CORRECTION_MIN_GENERATION,
  HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES,
  HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS,
} from "../../ops/hosted-autonomy-ci-retries.ts";
import {
  HOSTED_AUTONOMY_CI_UNATTRIBUTED_PREFIX,
  HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS,
  hostedRepositoryKey,
} from "../../ops/hosted-autonomy-policy.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  CI_CORRECTION_REVIEW_ROUNDS,
  CI_UNATTRIBUTED_DETAIL,
  ciCorrectable,
  HOSTED_CI_CORRECTIONS,
} from "../../src/repair/ci-rejection.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION,
  OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_REVISION,
} from "../../src/host/owner-install-runtime-pins.ts";
import {
  releaseRequest,
  reservation,
  SHA1,
  SHA2,
  T0,
} from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  finding,
  FOREIGN_REPO,
  HEAD,
  SELF_REPO,
  selfTips,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import {
  healthyProof,
  makeRig,
  repairSnapshot,
} from "./hosted-autonomy-rig.ts";
import { releaseAt } from "./hosted-autonomy-preservation-fixtures.ts";
import {
  readHostedClosedIssues,
  runHostedRetryPass,
} from "../../ops/hosted-autonomy-retry-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyHeadRunV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import {
  assertGen78Parses,
  gen78Available,
  loadGen78Modules,
} from "../state/gen77-contracts.ts";

/** An installed runtime that carries the CI correction route. */
const RUNTIME = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as GitSha;
/** Test allowlist naming RUNTIME as a CI-correction runtime. */
const ALLOWLIST: ReadonlySet<string> = new Set([RUNTIME]);
/** The parked head's once-per-head flake re-run can no longer act. */
const SETTLED: ReadonlySet<string> = new Set([ciGreenHeadKey(SELF_REPO, HEAD)]);
/** The one unresolved severity that still rejects a review (2026-10-24). */
const P0_FINDING = {
  ...finding("P1"),
  severity: "P0" as const,
  message: "P0 finding",
};

/** The authenticated installed runtime record with its own healthy proof. */
function installed(
  overrides: Partial<HostedRuntimeRecordV1> = {},
  proof: { revision?: string; generation?: number } | null = {},
): HostedRuntimeRecordV1 {
  const revision = overrides.activeRevision ?? RUNTIME;
  const generation = overrides.generation ?? 78;
  return {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: revision,
    generation,
    lastHealthyProof: proof === null ? null : healthyProof(
      proof.revision ?? revision,
      proof.generation ?? generation,
      "ci-correction-release",
    ),
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  } as HostedRuntimeRecordV1;
}
const CI_BLOCKER = {
  kind: "other",
  message: "CI checks failed: verify-artifact(skipped), validate(failure)",
  since: T0 + 5000,
};

function ciBlocked(overrides: Record<string, unknown> = {}) {
  return blockedRecord({
    blocker: CI_BLOCKER,
    counters: { attempts: 4, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

const CHARGES = [
  reservation("ci-impl", {
    repository: SELF_REPO,
    taskId: TARGET,
    head: BASE,
    attempt: 4,
    purpose: "retry",
    outcome: "submitted",
    settledAt: T0 + 2000,
  }),
  reservation("ci-review", {
    repository: SELF_REPO,
    taskId: TARGET,
    head: HEAD,
    attempt: 1,
    purpose: "review_request",
    outcome: "submitted",
    settledAt: T0 + 2500,
  }),
];

Deno.test("hosted autonomy: a reviewed head parked on its CI gate returns to delivery uncharged", () => {
  const snapshot = repairSnapshot(
    [ciBlocked()],
    [authorizingReceipt()],
    [],
    CHARGES,
  );
  // A newer base is the runtime's to reconcile: the grant never refreshes.
  const plans = planHostedRetries(
    snapshot,
    T0 + 9000,
    RUNTIME,
    selfTips(SHA2),
    new Set(),
    undefined,
    { ciRuntime: installed(), ciAllowlist: ALLOWLIST, ciRerunSettled: SETTLED },
  );
  assert.equal(plans.length, 1);
  assert.equal(plans[0].nextStep, "delivery");
  assert.equal(plans[0].advanceBase, false);
  assert.equal(plans[0].observedBase, null);
  assert.equal(plans[0].reviewRounds, null);
  assert.equal(plans[0].detail, "other:CI checks failed:");
  const next = applyHostedRetries(snapshot, SHA1, plans, T0 + 9000);
  const record = next.work[0];
  assert.equal(record.nextStep, "delivery");
  assert.equal(record.blocker, null);
  assert.equal(record.wait, null);
  assert.equal(record.intent, null, "no refresh intent is written");
  assert.deepEqual(record.counters, snapshot.work[0].counters);
  assert.deepEqual(record.target, snapshot.work[0].target);
  assert.deepEqual(next.reservations, snapshot.reservations, "nothing charged");
  assert.deepEqual(next.reviews, snapshot.reviews);
});

Deno.test("hosted autonomy: only the exact reviewed, unreleased CI-gate shape is re-admitted", async (t) => {
  const plan = (
    records = [ciBlocked()],
    reviews: unknown[] = [authorizingReceipt()],
    releaseRequests: unknown[] = [],
  ) =>
    planHostedRetries(
      repairSnapshot(records, reviews, releaseRequests, CHARGES),
      T0 + 9000,
      RUNTIME,
      new Map(),
      new Set(),
      undefined,
      {
        ciRuntime: installed(),
        ciAllowlist: ALLOWLIST,
        ciRerunSettled: SETTLED,
      },
    );
  assert.equal(plan().length, 1, "control");
  await t.step("spent review rounds keep the terminal block", () => {
    assert.equal(
      plan([
        ciBlocked({ counters: { attempts: 4, retries: 0, reviewRounds: 3 } }),
      ])
        .length,
      0,
    );
  });
  await t.step("a retained closure intent is never replaced", () => {
    const closure = {
      kind: "already_satisfied_closure",
      key: `satisfied:51:${HEAD}:${BASE}`,
      startedAt: T0 + 3000,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      expectedHead: HEAD,
      observedBase: BASE,
      pr: 51,
      requestId: "review-req-1",
      resultId: "msg_0123456789abcdef",
    };
    assert.equal(plan([ciBlocked({ intent: closure })]).length, 0);
  });
  await t.step("the head must hold its own clean completed review", () => {
    assert.equal(plan(undefined, []).length, 0, "no receipt");
    assert.equal(
      plan(undefined, [authorizingReceipt({
        findings: [P0_FINDING],
        unresolvedSeverities: ["P0"],
      })]).length,
      0,
      "a rejecting receipt",
    );
    // Owner directive 2026-10-24: only P0 blocks; an unresolved P1 is clean.
    assert.equal(
      plan(undefined, [authorizingReceipt({
        findings: [finding("P1")],
        unresolvedSeverities: ["P1"],
      })]).length,
      1,
      "an unresolved P1 does not reject",
    );
    assert.equal(
      plan(undefined, [authorizingReceipt({
        pullRequest: { number: 51, head: HEAD, base: SHA2 },
      })]).length,
      0,
      "a receipt for another base",
    );
  });
  await t.step("a release-phase CI block belongs to a merged delivery", () => {
    const released = releaseRequest("ci-release", {
      target: { repository: SELF_REPO, environment: "production" },
      revision: SHA2,
      source: {
        pullRequest: 51,
        reviewRequestId: "review-req-1",
        reviewReceiptId: null,
        head: HEAD,
        base: BASE,
      },
    });
    assert.equal(plan(undefined, undefined, [released]).length, 0);
  });
  await t.step("an undescribed candidate cannot resume a correction", () => {
    const record = ciBlocked();
    assert.equal(
      plan([blockedRecord({
        blocker: CI_BLOCKER,
        counters: record.counters,
        target: {
          ...record.target,
          candidateState: { preserved: null, publishedHead: HEAD },
        },
      })]).length,
      0,
    );
  });
  await t.step(
    "the runtime's own unattributed block is not this rule's",
    () => {
      assert.equal(
        plan([ciBlocked({
          blocker: {
            ...CI_BLOCKER,
            message: "CI checks failed without base evidence: lint(failure)",
          },
        })]).length,
        0,
      );
    },
  );
});

Deno.test("hosted autonomy: the CI re-admission activates only for an allowlisted, healthy generation-78+ runtime", async (t) => {
  const snapshot = repairSnapshot([ciBlocked()], [authorizingReceipt()], [], [
    ...CHARGES,
  ]);
  const plan = (
    ciRuntime: HostedRuntimeRecordV1 | null | undefined,
    ciAllowlist: ReadonlySet<string> | undefined = ALLOWLIST,
    runtimeSha: GitSha = RUNTIME,
  ) =>
    planHostedRetries(
      snapshot,
      T0 + 9000,
      runtimeSha,
      new Map(),
      new Set(),
      undefined,
      ciRuntime === undefined
        ? undefined
        : { ciRuntime, ciAllowlist, ciRerunSettled: SETTLED },
    ).length;
  assert.equal(plan(installed()), 1, "control");
  await t.step("no runtime proof at all keeps the rule inert", () => {
    assert.equal(plan(undefined), 0);
    assert.equal(plan(null), 0);
  });
  await t.step("a runtime outside the allowlist is inert", () => {
    assert.equal(plan(installed(), new Set()), 0);
    // The production allowlist is pinned by the integration owner once the
    // reviewed generation-78 revision exists; it never names 74 through 77.
    // With no test allowlist the planner reads exactly that pinned set.
    assert.equal(
      planHostedRetries(
        snapshot,
        T0 + 9000,
        RUNTIME,
        new Map(),
        new Set(),
        undefined,
        { ciRuntime: installed(), ciRerunSettled: SETTLED },
      ).length,
      HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES.has(RUNTIME) ? 1 : 0,
    );
    assert.equal(ciCorrectionRuntimeProven(installed()), false);
    for (
      const [revision, generation] of [
        [OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_REVISION, 74],
        [OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_REVISION, 75],
        [OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_REVISION, 76],
        [OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION, 77],
      ] as const
    ) {
      assert.equal(HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES.has(revision), false);
      const legacy = installed({
        activeRevision: revision as GitSha,
        generation,
      });
      assert.equal(
        plan(legacy, new Set([revision]), revision as GitSha),
        0,
        "a pre-78 generation never activates the rule",
      );
    }
  });
  await t.step(
    "a pre-78 generation of an allowlisted revision is inert",
    () => {
      assert.equal(
        plan(installed({
          generation: HOSTED_AUTONOMY_CI_CORRECTION_MIN_GENERATION - 1,
        })),
        0,
      );
    },
  );
  await t.step("the healthy proof must bind this exact pointer", () => {
    assert.equal(plan(installed({}, null)), 0, "no healthy proof");
    assert.equal(
      plan(installed({}, { revision: "6".repeat(40) })),
      0,
      "a proof for another revision",
    );
    assert.equal(
      plan(installed({ generation: 78 }, { generation: 77 })),
      0,
      "a proof for another generation",
    );
    const failedProof = installed();
    failedProof.lastHealthyProof = {
      ...failedProof.lastHealthyProof!,
      outcome: "failed",
    };
    assert.equal(plan(failedProof), 0, "a failed run is never health");
    assert.equal(
      ciCorrectionRuntimeProven(installed({ generation: 79 }), ALLOWLIST),
      true,
      "a later proven generation of the same revision stays active",
    );
  });
  await t.step(
    "the proven runtime must be the authenticated installed one",
    () => {
      assert.equal(plan(installed(), ALLOWLIST, "6".repeat(40) as GitSha), 0);
    },
  );
});

Deno.test("hosted autonomy: the CI re-admission and the runtime correction share one review-round ceiling", () => {
  // The launcher may only re-admit a head the runtime can still correct: a
  // re-admitted head the runtime cannot correct is blocked again at once and
  // would be re-admitted on every pass. Both sides read one ceiling, which
  // also mirrors the hosted delivery ceiling for spent records.
  assert.equal(CI_CORRECTION_REVIEW_ROUNDS, HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS);
  const reviews = [authorizingReceipt()];
  for (
    let rounds = 0;
    rounds <= HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS + 1;
    rounds++
  ) {
    const record = ciBlocked({
      counters: { attempts: 4, retries: 0, reviewRounds: rounds },
    });
    const snapshot = repairSnapshot([record], reviews, [], CHARGES);
    assert.equal(
      ciRedeliveryEligible(snapshot, snapshot.work[0]),
      ciCorrectable(snapshot.work[0], snapshot),
      `review rounds ${rounds}`,
    );
  }
});

Deno.test("hosted autonomy: the CI correction route is open from generation 78, whose rollback target isolates its cell", () => {
  // Generation 77 (R77), the rollback target of 78, isolates the correction
  // cell (matrix-ci-correction-gen77) and bounds an awaiting record's
  // rollback cost (ci-correction-rollback-gen77), so the hosted route opens
  // in the runtime of this tree and the launcher re-admits only under a
  // runtime cut from it.
  assert.equal(HOSTED_CI_CORRECTIONS, true);
  assert.equal(HOSTED_AUTONOMY_CI_CORRECTION_MIN_GENERATION, 78);
});

Deno.test("hosted autonomy: no runtime at or before generation 77 is allowlisted for CI re-admission", () => {
  for (
    const revision of [
      OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_REVISION,
      OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_REVISION,
      OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_REVISION,
      OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION,
    ]
  ) {
    assert.equal(
      HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES.has(revision),
      false,
      revision,
    );
  }
  // A failed generation 78 restores R77 at generation 79: the pinned
  // allowlist excludes it by revision, whatever its generation and proof.
  for (const generation of [77, 79, 80]) {
    assert.equal(
      ciCorrectionRuntimeProven(installed({
        activeRevision: OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION,
        generation,
      })),
      false,
      `R77 at generation ${generation}`,
    );
  }
});

Deno.test("hosted autonomy: every allowlisted CI-correction runtime present locally opens the hosted route", async () => {
  const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
  const git = async (args: string[]) => {
    const output = await new Deno.Command("git", {
      args: ["-C", root, ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
    return output.success ? new TextDecoder().decode(output.stdout) : null;
  };
  for (const revision of HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES) {
    assert.match(revision, /^[0-9a-f]{40}$/);
    if (await git(["cat-file", "-e", `${revision}^{commit}`]) === null) {
      continue;
    }
    const source = await git([
      "show",
      `${revision}:src/repair/ci-rejection.ts`,
    ]);
    assert.ok(source !== null, revision);
    assert.match(
      source,
      /^export const HOSTED_CI_CORRECTIONS = true;$/m,
      `${revision} keeps the hosted CI correction route closed`,
    );
  }
});

// ---- flake first and the per-pass cap -------------------------------------

Deno.test("hosted autonomy: a CI-parked head is re-admitted for correction only after its flake re-run settled", () => {
  const snapshot = repairSnapshot(
    [ciBlocked()],
    [authorizingReceipt()],
    [],
    CHARGES,
  );
  const plan = (options: Record<string, unknown>) =>
    planHostedRetries(
      snapshot,
      T0 + 9000,
      RUNTIME,
      selfTips(BASE),
      new Set(),
      undefined,
      { ciRuntime: installed(), ciAllowlist: ALLOWLIST, ...options },
    );
  assert.equal(plan({ ciRerunSettled: SETTLED }).length, 1, "control");
  assert.equal(plan({}).length, 0, "no settled set: the re-run may act");
  assert.equal(plan({ ciRerunSettled: new Set() }).length, 0);
  assert.equal(
    plan({
      ciRerunSettled: new Set([ciGreenHeadKey(SELF_REPO, SHA2 as GitSha)]),
    }).length,
    0,
    "another head settled",
  );
  assert.equal(
    plan({
      ciRerunSettled: new Set([ciGreenHeadKey(FOREIGN_REPO, HEAD)]),
    }).length,
    0,
    "the same head in another repository",
  );
  // A head that turned green needs no correction and no settled re-run.
  const green = plan({
    ciGreenHeads: new Set([ciGreenHeadKey(SELF_REPO, HEAD)]),
  });
  assert.equal(green.length, 1);
  assert.equal(green[0].detail, "other:CI checks failed::green");
});

/**
 * `count` CI-parked heads with a review round left, in snapshot (id) order,
 * each with its own pull request (70 + index) and authorizing review.
 */
function ciFleet(count: number) {
  const heads = Array.from(
    { length: count },
    (_, index) => (index + 1).toString(16).repeat(40) as GitSha,
  );
  const records = heads.map((head, index) =>
    ciBlocked({
      id: `issue-ubiquity-sentinel-${60 + index}`,
      source: { kind: "issue", id: String(60 + index), revision: SHA1 },
      related: { incidentId: null, issueNumber: 60 + index },
      target: {
        base: BASE,
        branch: `sentinel/repair/issue-ubiquity-sentinel-${60 + index}`,
        checkpoint: null,
        head,
        pr: 70 + index,
      },
    })
  );
  const reviews = records.map((record, index) =>
    authorizingReceipt({
      id: `review-receipt:${String(index).repeat(64)}`,
      pullRequest: { number: record.target.pr, head: heads[index], base: BASE },
    })
  );
  return { heads, records, snapshot: repairSnapshot(records, reviews, [], []) };
}

Deno.test("hosted autonomy: the planner plans every CI correction candidate; the per-pass cap is the retry pass's", () => {
  assert.equal(HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS, 12);
  const { heads, records, snapshot } = ciFleet(6);
  const plans = planHostedRetries(
    snapshot,
    T0 + 9000,
    RUNTIME,
    selfTips(BASE),
    new Set(),
    undefined,
    {
      ciRuntime: installed(),
      ciAllowlist: ALLOWLIST,
      ciRerunSettled: new Set(
        heads.map((head) => ciGreenHeadKey(SELF_REPO, head)),
      ),
      ciGreenHeads: new Set([ciGreenHeadKey(SELF_REPO, heads[5])]),
    },
  );
  // The planner cannot know which pull requests are still open, so it caps
  // nothing: a candidate the pass later drops must never hold a slot.
  assert.deepEqual(
    plans.map((plan) => plan.detail),
    [
      ...Array(5).fill("other:CI checks failed:"),
      "other:CI checks failed::green",
    ],
  );
  assert.deepEqual(
    plans.map((plan) => plan.id),
    records.map((record) => record.id),
  );
});

/** The allowlisted generation-78 runtime with its own healthy proof. */
const PROVEN_RELEASE = releaseAt({
  revision: RUNTIME,
  generation: 78,
  healthy: {
    revision: RUNTIME,
    generation: 78,
    createdAt: T0,
    observedAt: T0 + 10,
  },
});

/**
 * Pins RUNTIME in the production allowlist, the only one the retry pass
 * reads, for `body` alone; the pinned set is restored afterwards.
 */
async function withPinnedRuntime<T>(body: () => Promise<T>): Promise<T> {
  const pinned = HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES as Set<string>;
  assert.equal(pinned.has(RUNTIME), false);
  pinned.add(RUNTIME);
  try {
    return await body();
  } finally {
    pinned.delete(RUNTIME);
  }
}

/** One real retry pass over the rig's repair state, as the runner drives it. */
async function retryPass(rig: Awaited<ReturnType<typeof makeRig>>["rig"]) {
  const deps = {
    state: rig.state,
    githubFor: rig.githubFor,
    clock: { now: () => T0 + 5_000_000 },
  } as unknown as HostedAutonomyDepsV1;
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const context = {
    deps,
    actions: [] as string[],
    revisions: [],
    snapshot: read.value.snapshot,
    observedHead: read.value.head,
    initialHead: read.value.head,
    releaseSnapshot: PROVEN_RELEASE,
    closedIssues: new Set<string>(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set<string>(),
    ...createHostedAutonomyScopes(deps),
  } as unknown as HostedAutonomyPassContextV1;
  await readHostedClosedIssues(context);
  const result = await runHostedRetryPass(context, SHA1);
  const after = await rig.state.readRepair();
  assert.ok(after.ok && after.value.status === "found");
  return { result, actions: context.actions, after: after.value.snapshot };
}

/** An unmerged pull request at the record's head, open or closed. */
function pullAt(number: number, head: string, open: boolean) {
  return {
    number,
    state: open ? "open" : "closed",
    merged: false,
    mergeCommitSha: null,
    headSha: head,
    baseRef: "development",
    author: "ubiquity-sentinel[bot]",
  } as unknown as HostedAutonomyPullV1;
}

Deno.test("hosted autonomy: closed or unreadable pull requests never hold one of the pass's CI correction slots", async () => {
  // Four records whose pull requests a maintainer closed (their issues stay
  // open, so nothing retires them) and one whose pull request cannot be read
  // sort ahead of the one open pull request. The base moved, so every
  // head's flake re-run is settled.
  const { heads, records, snapshot } = ciFleet(6);
  const { rig, github } = await makeRig("ci-correction-cap-closed", {
    repair: snapshot,
    baseTip: SHA2,
    issueOpen: true,
  });
  const reads: number[] = [];
  rig.githubFor = () => ({
    ...github,
    readPull: (number: number) => {
      reads.push(number);
      const index = number - 70;
      if (index === 4) return Promise.reject(new Error("offline"));
      return Promise.resolve(pullAt(number, heads[index], index === 5));
    },
    hasAllChecksGreen: () => Promise.resolve(false),
  });
  try {
    const { result, actions, after } = await withPinnedRuntime(() =>
      retryPass(rig)
    );
    assert.equal(result?.status, "applied", JSON.stringify(actions));
    assert.deepEqual(actions, [
      ...records.slice(0, 4).map((record) =>
        `retry:${record.id}:skipped:pr_not_open`
      ),
      `retry:${records[4].id}:skipped:pr_read_failed`,
      `retry:${records[5].id}:grant=0:other:CI checks failed:`,
    ]);
    assert.deepEqual(reads, [70, 71, 72, 73, 74, 75]);
    assert.deepEqual(
      after.work.map((record) => record.nextStep),
      ["blocked", "blocked", "blocked", "blocked", "blocked", "delivery"],
    );
    const admitted = after.work[5];
    assert.equal(admitted.blocker, null);
    assert.deepEqual(admitted.counters, records[5].counters);
    assert.deepEqual(after.reservations, snapshot.reservations);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("hosted autonomy: one retry pass admits at most HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS verified CI corrections, green heads uncounted", async () => {
  // Two open correction candidates past the cap and one head green again on
  // its unchanged base. No re-run capability, so every flake re-run is
  // settled.
  const CAP = HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS;
  const GREEN = CAP + 2;
  const { heads, records, snapshot } = ciFleet(CAP + 3);
  const { rig, github } = await makeRig("ci-correction-cap-open", {
    repair: snapshot,
    baseTip: BASE,
    issueOpen: true,
  });
  const reads: number[] = [];
  rig.githubFor = () => ({
    ...github,
    readPull: (number: number) => {
      reads.push(number);
      return Promise.resolve(pullAt(number, heads[number - 70], true));
    },
    hasAllChecksGreen: (sha: string) => Promise.resolve(sha === heads[GREEN]),
  });
  try {
    const { result, actions, after } = await withPinnedRuntime(() =>
      retryPass(rig)
    );
    assert.equal(result?.status, "applied", JSON.stringify(actions));
    assert.deepEqual(actions, [
      `retry:${records[CAP].id}:skipped:ci_correction_cap`,
      `retry:${records[CAP + 1].id}:skipped:ci_correction_cap`,
      ...records.slice(0, CAP).map((record) =>
        `retry:${record.id}:grant=0:other:CI checks failed:`
      ),
      `retry:${records[GREEN].id}:grant=0:other:CI checks failed::green`,
    ]);
    // A candidate past the cap costs no pull request read.
    assert.deepEqual(reads, [
      ...Array.from({ length: CAP }, (_, index) => 70 + index),
      70 + GREEN,
    ]);
    assert.deepEqual(
      after.work.map((record) => record.nextStep),
      [...Array(CAP).fill("delivery"), "blocked", "blocked", "delivery"],
    );
    assert.deepEqual(after.reservations, snapshot.reservations);
    // The next pass admits the two that waited.
    const next = await withPinnedRuntime(() => retryPass(rig));
    assert.equal(next.result?.status, "applied");
    assert.deepEqual(
      next.after.work.map((record) => record.nextStep),
      Array(CAP + 3).fill("delivery"),
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

// ---- a head GitHub will no longer re-run ----------------------------------

/** GitHub refuses a re-run more than 30 days after the run's first attempt. */
const GITHUB_RERUN_WINDOW_MS = 30 * 86_400_000;
/** A run a minute past that window. */
const EXPIRED = GITHUB_RERUN_WINDOW_MS + 60_000;
/** The retry pass's own clock (`retryPass`). */
const PASS_NOW = T0 + 5_000_000;

/** A CI-parked, correction-eligible head whose candidate is preserved. */
function preservedCiBlocked() {
  const record = ciBlocked();
  return {
    ...record,
    target: {
      ...record.target,
      candidateState: {
        preserved: {
          operationKey: `impl:${"d".repeat(64)}`,
          base: BASE,
          head: HEAD,
          ref: `refs/heads/sentinel-candidates/${"c".repeat(64)}`,
        },
        publishedHead: HEAD,
      },
    },
  };
}

/**
 * One retry pass over that record on its unchanged base, its only failed run
 * first created `age` milliseconds before the pass. The surface can list and
 * re-run runs, so only the run's age can settle the head.
 */
async function windowPass(name: string, age: number) {
  const record = preservedCiBlocked();
  const snapshot = repairSnapshot(
    [record],
    [authorizingReceipt()],
    [],
    CHARGES,
  );
  const { rig, github } = await makeRig(`ci-rerun-window-${name}`, {
    repair: snapshot,
    baseTip: BASE,
    issueOpen: true,
  });
  const listed: string[] = [];
  const reruns: number[] = [];
  rig.githubFor = () => ({
    ...github,
    readPull: (number: number) => Promise.resolve(pullAt(number, HEAD, true)),
    hasAllChecksGreen: () => Promise.resolve(false),
    listHeadRuns: (head: string) => {
      listed.push(head);
      return Promise.resolve([{
        id: 4242,
        headSha: head,
        status: "completed",
        conclusion: "failure",
        runAttempt: 1,
        createdAt: PASS_NOW - age,
      } as HostedAutonomyHeadRunV1]);
    },
    rerunFailedJobs: (id: number) => {
      reruns.push(id);
      return Promise.reject(new Error("the retry pass never re-runs"));
    },
  });
  try {
    const pass = await withPinnedRuntime(() => retryPass(rig));
    return { ...pass, record, snapshot, listed, reruns };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("hosted autonomy: a CI-parked head whose failed run is past GitHub's re-run window is admitted for its correction", async () => {
  const { result, actions, after, record, snapshot, listed, reruns } =
    await windowPass("expired", EXPIRED);
  assert.equal(result?.status, "applied", JSON.stringify(actions));
  assert.deepEqual(actions, [
    `retry:${record.id}:grant=0:other:CI checks failed:`,
  ]);
  assert.deepEqual(listed, [HEAD], "one listing, no re-run request");
  assert.deepEqual(reruns, []);
  const admitted = after.work[0];
  assert.equal(admitted.nextStep, "delivery");
  assert.equal(admitted.blocker, null);
  assert.equal(admitted.intent, null);
  // Nothing is charged or refunded and the preserved candidate is untouched:
  // the installed runtime's own CI gate decides from here.
  assert.deepEqual(admitted.counters, record.counters);
  assert.deepEqual(admitted.target, record.target);
  assert.deepEqual(after.reservations, snapshot.reservations);
  assert.deepEqual(after.reviews, snapshot.reviews);
});

Deno.test("hosted autonomy: a CI-parked head inside GitHub's re-run window waits for its re-run", async () => {
  const { result, actions, after, record, listed, reruns } = await windowPass(
    "inside",
    GITHUB_RERUN_WINDOW_MS - 2 * 3_600_000,
  );
  assert.equal(result, null, JSON.stringify(actions));
  assert.deepEqual(actions, []);
  assert.deepEqual(listed, [HEAD]);
  assert.deepEqual(reruns, [], "the delivery pass re-runs, never this one");
  assert.deepEqual(after.work[0], record);
});

Deno.test({
  name:
    "hosted autonomy: the rollback runtime (generation 78) parses the window re-admission and agrees the head is correctable",
  ignore: !(await gen78Available()),
  fn: async () => {
    const { after, record } = await windowPass("gen78", EXPIRED);
    assert.equal(after.work[0].nextStep, "delivery");
    await assertGen78Parses(after);
    const loaded = await loadGen78Modules(["src/repair/ci-rejection.ts"]);
    try {
      const [gen78] = loaded.modules as [{
        ciCorrectable(record: unknown): boolean;
        CI_CORRECTION_REVIEW_ROUNDS: number;
        HOSTED_CI_CORRECTIONS: boolean;
      }];
      assert.equal(gen78.ciCorrectable(structuredClone(record)), true);
      assert.equal(gen78.CI_CORRECTION_REVIEW_ROUNDS, 3);
      assert.equal(gen78.HOSTED_CI_CORRECTIONS, true);
      assert.equal(ciCorrectable(record, after), true);
    } finally {
      await loaded.dispose();
    }
  },
});

Deno.test("hosted autonomy: the runtime's unattributed CI block keeps the free re-run and green re-admission, never a correction", () => {
  assert.equal(
    HOSTED_AUTONOMY_CI_UNATTRIBUTED_PREFIX,
    `${CI_UNATTRIBUTED_DETAIL}: `,
  );
  const unattributed = (rounds: number) =>
    ciBlocked({
      counters: { attempts: 4, retries: 0, reviewRounds: rounds },
      blocker: {
        ...CI_BLOCKER,
        message: `${CI_UNATTRIBUTED_DETAIL}: lint(failure)`,
      },
    });
  for (const rounds of [1, 2]) {
    const snapshot = repairSnapshot(
      [unattributed(rounds)],
      [authorizingReceipt()],
      [],
      CHARGES,
    );
    assert.equal(ciGreenRedeliveryEligible(snapshot, snapshot.work[0]), true);
    assert.equal(ciRedeliveryEligible(snapshot, snapshot.work[0]), false);
    const plan = (green: boolean) =>
      planHostedRetries(
        snapshot,
        T0 + 9000,
        RUNTIME,
        selfTips(BASE),
        new Set(),
        undefined,
        {
          ciRuntime: installed(),
          ciAllowlist: ALLOWLIST,
          ciRerunSettled: SETTLED,
          ciGreenHeads: green
            ? new Set([ciGreenHeadKey(SELF_REPO, HEAD)])
            : new Set(),
        },
      );
    // Not green: the correction rule never takes it, so it never churns.
    assert.equal(plan(false).length, 0, `rounds ${rounds}`);
    const plans = plan(true);
    assert.equal(plans.length, 1, `rounds ${rounds}`);
    assert.equal(plans[0].nextStep, "delivery");
    assert.equal(
      plans[0].detail,
      "other:CI checks failed without base evidence::green",
    );
    const next = applyHostedRetries(snapshot, SHA1, plans, T0 + 9000);
    assert.equal(next.work[0].blocker, null);
    assert.deepEqual(next.work[0].counters, snapshot.work[0].counters);
    assert.deepEqual(next.reservations, snapshot.reservations);
  }
});

// ---- green-head re-admission ---------------------------------------------

/** The self scope's base tip and green-head set, as the retry pass builds them. */
function greenPlan(
  snapshot: ReturnType<typeof repairSnapshot>,
  options: {
    tip?: string | null;
    green?: ReadonlySet<string>;
    ciRuntime?: HostedRuntimeRecordV1 | null;
  } = {},
) {
  return planHostedRetries(
    snapshot,
    T0 + 9000,
    RUNTIME,
    selfTips(options.tip === undefined ? BASE : options.tip),
    new Set(),
    undefined,
    {
      ciRuntime: options.ciRuntime ?? null,
      ciGreenHeads: options.green ?? new Set([ciGreenHeadKey(SELF_REPO, HEAD)]),
    },
  );
}

/** A CI-parked reviewed head (below the review-round ceiling by default). */
const spent = (rounds = 2) =>
  ciBlocked({ counters: { attempts: 4, retries: 0, reviewRounds: rounds } });

Deno.test("hosted autonomy: a head whose CI turned green on its current base returns to delivery uncharged below the ceiling", () => {
  // The flake path: no CI-correction runtime is installed (the route is
  // closed under generation 77) and the exact reviewed head is now green on
  // the unchanged base.
  for (const rounds of [0, 2]) {
    const snapshot = repairSnapshot(
      [spent(rounds)],
      [authorizingReceipt()],
      [],
      CHARGES,
    );
    const plans = greenPlan(snapshot);
    assert.equal(plans.length, 1, `review rounds ${rounds}`);
    assert.equal(plans[0].nextStep, "delivery");
    assert.equal(plans[0].grant, 0);
    assert.equal(plans[0].reviewRounds, null);
    assert.equal(plans[0].advanceBase, false);
    assert.equal(plans[0].observedBase, null);
    assert.equal(plans[0].detail, "other:CI checks failed::green");
    // The existing grant shape: no charge, counters, target and publication
    // unchanged; blocker, wait and intent cleared.
    const next = applyHostedRetries(snapshot, SHA1, plans, T0 + 9000);
    const record = next.work[0];
    assert.equal(record.nextStep, "delivery");
    assert.equal(record.blocker, null);
    assert.equal(record.wait, null);
    assert.equal(record.intent, null);
    assert.deepEqual(record.counters, snapshot.work[0].counters);
    assert.deepEqual(record.target, snapshot.work[0].target);
    assert.deepEqual(next.reservations, snapshot.reservations);
    assert.deepEqual(next.reviews, snapshot.reviews);
    assert.deepEqual(parseWorkRecordV1(structuredClone(record)), record);
  }
});

Deno.test("hosted autonomy: a green head whose ordinary rounds are spent is left to the spent-round rule", () => {
  // Integration review (generation 80): the retry pass runs before the
  // delivery pass, which skips a record an earlier write of the pass
  // settled. Re-admitted to the runtime's delivery step, a spent head would
  // be refreshed and reviewed a fourth time by R79 once the base moved; the
  // delivery pass's spent-round rule merges it at its exact base instead.
  for (const rounds of [3, 4, 7]) {
    const snapshot = repairSnapshot(
      [spent(rounds)],
      [authorizingReceipt()],
      [],
      CHARGES,
    );
    assert.equal(ciGreenRedeliveryEligible(snapshot, snapshot.work[0]), true);
    const denials: string[] = [];
    const plans = planHostedRetries(
      snapshot,
      T0 + 9000,
      RUNTIME,
      selfTips(BASE),
      new Set(),
      (denial) => denials.push(denial.reason),
      { ciGreenHeads: new Set([ciGreenHeadKey(SELF_REPO, HEAD)]) },
    );
    assert.deepEqual(plans, [], `review rounds ${rounds}`);
    assert.deepEqual(denials, [GREEN_SPENT_LEFT_TO_DELIVERY]);
  }
  // The ledger counts too: a lagging counter does not hand it back.
  const rounds = [2, 3].map((attempt) =>
    reservation(`ci-review-${attempt}`, {
      repository: SELF_REPO,
      taskId: TARGET,
      head: HEAD,
      attempt,
      purpose: "review_request",
      outcome: "submitted",
      settledAt: T0 + 2500 + attempt,
    })
  );
  const lagging = repairSnapshot(
    [spent(1)],
    [authorizingReceipt()],
    [],
    [...CHARGES, ...rounds],
  );
  assert.deepEqual(greenPlan(lagging), []);
});

Deno.test("hosted autonomy: the green-head re-admission needs the exact green head on the unchanged reviewed base", async (t) => {
  const snapshot = (
    records = [spent()],
    reviews: unknown[] = [authorizingReceipt()],
    releaseRequests: unknown[] = [],
  ) => repairSnapshot(records, reviews, releaseRequests, CHARGES);
  assert.equal(greenPlan(snapshot()).length, 1, "control");
  await t.step("a head that is not green stays parked", () => {
    assert.equal(greenPlan(snapshot(), { green: new Set() }).length, 0);
    assert.equal(
      greenPlan(snapshot(), {
        green: new Set([ciGreenHeadKey(SELF_REPO, SHA2 as GitSha)]),
      }).length,
      0,
      "another head",
    );
    assert.equal(
      greenPlan(snapshot(), {
        green: new Set([ciGreenHeadKey(FOREIGN_REPO, HEAD)]),
      }).length,
      0,
      "the same head in another repository",
    );
  });
  await t.step("a moved or unreadable base stays parked", () => {
    assert.equal(greenPlan(snapshot(), { tip: SHA2 }).length, 0);
    assert.equal(greenPlan(snapshot(), { tip: null }).length, 0);
  });
  await t.step("the reviewed, unreleased shape is still required", () => {
    assert.equal(greenPlan(snapshot(undefined, [])).length, 0, "no receipt");
    assert.equal(
      greenPlan(snapshot(undefined, [authorizingReceipt({
        findings: [P0_FINDING],
        unresolvedSeverities: ["P0"],
      })])).length,
      0,
      "a rejecting receipt",
    );
    // Owner directive 2026-10-24: only P0 blocks; an unresolved P1 is clean.
    assert.equal(
      greenPlan(snapshot(undefined, [authorizingReceipt({
        findings: [finding("P1")],
        unresolvedSeverities: ["P1"],
      })])).length,
      1,
      "an unresolved P1 does not reject",
    );
    const released = releaseRequest("ci-green-release", {
      target: { repository: SELF_REPO, environment: "production" },
      revision: SHA2,
      source: {
        pullRequest: 51,
        reviewRequestId: "review-req-1",
        reviewReceiptId: null,
        head: HEAD,
        base: BASE,
      },
    });
    assert.equal(
      greenPlan(snapshot(undefined, undefined, [released])).length,
      0,
    );
    const record = spent();
    assert.equal(
      greenPlan(snapshot([blockedRecord({
        blocker: CI_BLOCKER,
        counters: record.counters,
        target: {
          ...record.target,
          candidateState: { preserved: null, publishedHead: HEAD },
        },
      })])).length,
      0,
      "an undescribed candidate",
    );
    assert.equal(
      greenPlan(snapshot([ciBlocked({
        counters: spent().counters,
        blocker: { ...CI_BLOCKER, message: "model run ended" },
      })])).length,
      0,
      "another blocker",
    );
  });
});

Deno.test("hosted autonomy: the green-head rule is the CI re-admission shape without the review-round ceiling", () => {
  const reviews = [authorizingReceipt()];
  for (
    let rounds = 0;
    rounds <= HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS + 3;
    rounds++
  ) {
    const snapshot = repairSnapshot([spent(rounds)], reviews, [], CHARGES);
    const record = snapshot.work[0];
    assert.equal(ciGreenRedeliveryEligible(snapshot, record), true);
    // The fixture records predate the CI-first era, so they keep the
    // 2026-10-16 ceiling of three (owner decision 2026-10-24 raised only the
    // CI-first era to five).
    assert.equal(
      ciRedeliveryEligible(snapshot, record),
      rounds < LEGACY_REVIEW_ROUND_CEILING,
    );
  }
  assert.equal(
    ciGreenHeadKey(SELF_REPO, HEAD),
    `${hostedRepositoryKey(SELF_REPO)}@${HEAD}`,
  );
});
