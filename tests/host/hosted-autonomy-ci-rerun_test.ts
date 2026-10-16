/**
 * The launcher's flake path for reviewed heads parked on the runtime's
 * merge-gate CI failure: a Gateway record is merged only once it is admitted
 * to `review`/`delivery` (so its release request can always be recorded), and
 * a clean-reviewed head on its green, current base gets its failed CI run
 * re-run at most once per exact head, with no state written.
 */
import assert from "node:assert/strict";
import {
  BASE,
  finding,
  FOREIGN_PR,
  FOREIGN_REPO as UNRELATED_REPO,
  foreignPullFacts,
  foreignReceipt as unrelatedForeignReceipt,
  foreignRecord as unrelatedForeignRecord,
  HEAD,
  jsonResponse,
  MERGE,
  repositoryTask as unrelatedRepositoryTask,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";
import { releaseRequest, SHA1, SHA2, T0 } from "../state/helpers.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  hostedIssueKey,
  hostedRepositoryKey,
} from "../../ops/hosted-autonomy-policy.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyHeadRunV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import {
  ciRerunRuns,
  HOSTED_AUTONOMY_CI_RERUNS_PER_PASS,
  readCiRerunSettled,
  runHostedCiRerunPass,
} from "../../ops/hosted-autonomy-ci-rerun.ts";
import { ciGreenHeadKey } from "../../ops/hosted-autonomy-ci-retries.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";

const GATEWAY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 7,
} as const;
const CI_BLOCKER = {
  kind: "other",
  message: "CI checks failed: verify-artifact(skipped), validate(failure)",
  since: T0 + 3000,
};

const PRESERVED_REF = `refs/heads/sentinel-candidates/${"c".repeat(64)}`;

/** A Gateway record with every review round spent, optionally CI-blocked. */
function gatewayRecord(
  nextStep: "blocked" | "delivery",
  overrides: Record<string, unknown> = {},
) {
  const base = unrelatedForeignRecord();
  return {
    ...base,
    repository: GATEWAY,
    target: {
      ...base.target,
      candidateState: {
        preserved: {
          operationKey: `impl:${"d".repeat(64)}`,
          base: BASE,
          head: HEAD,
          ref: PRESERVED_REF,
        },
        publishedHead: HEAD,
      },
    },
    counters: { attempts: 3, retries: 0, reviewRounds: 4 },
    ...(nextStep === "blocked"
      ? { nextStep: "blocked", blocker: CI_BLOCKER }
      : {}),
    ...overrides,
  };
}
const gatewayReceipt = (overrides: Record<string, unknown> = {}) => ({
  ...unrelatedForeignReceipt(overrides),
  repository: GATEWAY,
});

async function gatewayDelivery(
  name: string,
  record: ReturnType<typeof gatewayRecord>,
  passes = 1,
) {
  const { rig, github } = await makeRig(`ci-rerun-guard-${name}`, {
    repair: repairSnapshot([record as never], [gatewayReceipt()]),
    pull: foreignPullFacts({
      state: "open",
      merged: false,
      mergeCommitSha: null,
    }),
    afterMerge: foreignPullFacts(),
    baseTip: BASE,
    foreignCheckGreen: true,
    issueOpen: true,
    issueTask: (n) =>
      Promise.resolve(unrelatedRepositoryTask(UNRELATED_REPO, n)),
  });
  const surface = {
    ...github,
    readIssueOptedOut: () => Promise.resolve(false as boolean | null),
  };
  rig.githubFor = () => surface;
  try {
    const results = [];
    for (let pass = 0; pass < passes; pass++) results.push(await run(rig));
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    return { rig, results, after: read.value.snapshot };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("gateway delivery: a spent-round record outside review/delivery is never merged", async (t) => {
  // deliveryEligible admits a `work`/`blocked` record once every review round
  // is spent, but gatewayRequestBindsDelivery binds only a `review`/`delivery`
  // record: merged from there, the PR's release request (and so its release
  // and issue closure) could never be recorded.
  const cases: [string, ReturnType<typeof gatewayRecord>][] = [
    [
      "blocked-conflict",
      gatewayRecord("blocked", {
        blocker: {
          ...CI_BLOCKER,
          message: `base refresh has conflicts at ${SHA2}`,
        },
      }),
    ],
    ["work", gatewayRecord("delivery", { nextStep: "work" })],
  ];
  for (const [name, record] of cases) {
    await t.step(name, async () => {
      const { rig, results, after } = await gatewayDelivery(name, record);
      assert.equal(rig.merges, 0, "no merge before admission");
      assert.ok(
        results[0].actions.includes(
          `delivery:${record.id}:gateway_not_admitted`,
        ),
        JSON.stringify(results[0].actions),
      );
      assert.equal(after.releaseRequests.length, 0);
      assert.deepEqual(after.work[0], record);
      assert.equal(rig.writes, 0, "nothing is written");
    });
  }
});

Deno.test("gateway delivery: the same admitted record merges and records its release request", async () => {
  const { rig, after } = await gatewayDelivery(
    "delivery",
    gatewayRecord("delivery"),
  );
  assert.equal(rig.merges, 1);
  assert.equal(after.releaseRequests.length, 1);
  assert.equal(after.releaseRequests[0].source.head, HEAD);
  assert.equal(after.releaseRequests[0].source.base, BASE);
  assert.equal(after.work[0].nextStep, "delivery");
});

Deno.test("gateway delivery: a CI-parked spent-round head that is green is re-admitted before it is merged", async () => {
  // The hazard's own shape (PRs 1087/1089 after a successful re-run): the
  // first pass re-admits through the existing grant without merging; the
  // next pass merges at the exact head and records the release request.
  const { rig, results, after } = await gatewayDelivery(
    "ci-green",
    gatewayRecord("blocked"),
    2,
  );
  assert.equal(results[0].status, "applied", JSON.stringify(results[0]));
  assert.ok(
    results[0].actions.includes(
      `retry:${after.work[0].id}:grant=0:other:CI checks failed::green`,
    ),
    JSON.stringify(results[0].actions),
  );
  assert.equal(rig.merges, 1);
  assert.equal(after.releaseRequests.length, 1);
  assert.equal(after.releaseRequests[0].source.head, HEAD);
  assert.equal(after.work[0].nextStep, "delivery");
  assert.deepEqual(after.work[0].counters, gatewayRecord("blocked").counters);
});

Deno.test("gateway delivery: a green head parked on the runtime's unattributed CI block is re-admitted before it is merged", async () => {
  // The generation-78 unattributed block keeps the free re-run and green
  // re-admission of the legacy CI block; it is never a correction.
  const record = gatewayRecord("blocked", {
    blocker: {
      ...CI_BLOCKER,
      message: "CI checks failed without base evidence: validate(failure)",
    },
  });
  const { rig, results, after } = await gatewayDelivery(
    "ci-green-unattributed",
    record,
    2,
  );
  assert.ok(
    results[0].actions.includes(
      `retry:${record.id}:grant=0:other:CI checks failed without base evidence::green`,
    ),
    JSON.stringify(results[0].actions),
  );
  assert.equal(rig.merges, 1);
  assert.equal(after.releaseRequests.length, 1);
  assert.equal(after.releaseRequests[0].source.head, HEAD);
  assert.deepEqual(after.work[0].counters, record.counters);
});

// ---- re-run pass ----------------------------------------------------------

const RUN_ID = 38866783198;

function headRun(
  overrides: Partial<HostedAutonomyHeadRunV1> = {},
): HostedAutonomyHeadRunV1 {
  return {
    id: RUN_ID,
    headSha: HEAD,
    status: "completed",
    conclusion: "failure",
    runAttempt: 1,
    ...overrides,
  };
}

interface FakeOptions {
  runs?: HostedAutonomyHeadRunV1[] | null;
  baseTip?: string | null;
  green?: (sha: string) => boolean;
  pull?: Partial<HostedAutonomyPullV1> | null;
  issueOpen?: boolean | null;
  accepted?: boolean;
  /** Whether the readback shows the attempt advanced. */
  confirm?: boolean;
  capabilities?: boolean;
}

function fakeSurface(options: FakeOptions = {}) {
  const reruns: number[] = [];
  let runs = options.runs === undefined ? [headRun()] : options.runs;
  const surface: HostedAutonomyGitHubV1 = {
    readDefaultBranch: () => Promise.resolve("main"),
    readBaseTip: () =>
      Promise.resolve(options.baseTip === undefined ? BASE : options.baseTip),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: (sha) =>
      Promise.resolve((options.green ?? ((value) => value === BASE))(sha)),
    readPull: () =>
      Promise.resolve(
        options.pull === null ? null : foreignPullFacts({
          state: "open",
          merged: false,
          mergeCommitSha: null,
          author: "ubiquity-sentinel[bot]",
          ...options.pull,
        }),
      ),
    readIssueOpen: () =>
      Promise.resolve(
        options.issueOpen === undefined ? true : options.issueOpen,
      ),
    merge: () => Promise.reject(new Error("the re-run pass never merges")),
    closeIssue: () => Promise.reject(new Error("the re-run pass never closes")),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    ...(options.capabilities === false ? {} : {
      listHeadRuns: (head: string) =>
        Promise.resolve(
          runs === null ? null : runs.filter((item) => item.headSha === head),
        ),
      rerunFailedJobs: (id: number) => {
        reruns.push(id);
        const accepted = options.accepted ?? true;
        if (accepted && (options.confirm ?? true) && runs !== null) {
          runs = runs.map((item) =>
            item.id === id
              ? {
                ...item,
                status: "queued",
                conclusion: null,
                runAttempt: item.runAttempt + 1,
              }
              : item
          );
        }
        return Promise.resolve(accepted);
      },
    }),
  };
  return { surface, reruns };
}

async function rerunPass(
  snapshot: RepairStateSnapshotV1,
  surface: HostedAutonomyGitHubV1,
  closedIssues: Set<string> = new Set(),
): Promise<string[]> {
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
    closedIssues,
    foreignMerged: new Map(),
    dedicatedReservations: new Set<string>(),
    ...createHostedAutonomyScopes(deps),
  } as unknown as HostedAutonomyPassContextV1;
  await runHostedCiRerunPass(context);
  return actions;
}

const blockedSnapshot = (
  records: unknown[] = [gatewayRecord("blocked")],
  reviews: unknown[] = [gatewayReceipt()],
  releaseRequests: unknown[] = [],
) => repairSnapshot(records as never, reviews, releaseRequests);

const SENT = `rerun:${unrelatedForeignRecord().id}:run=${RUN_ID}:sent`;

Deno.test("ci re-run: a clean-reviewed head on its green, current base re-runs its failed run once", async () => {
  const snapshot = blockedSnapshot();
  const before = structuredClone(snapshot);
  const { surface, reruns } = fakeSurface({
    runs: [headRun(), headRun({ id: RUN_ID + 1, conclusion: "success" })],
  });
  assert.deepEqual(await rerunPass(snapshot, surface), [SENT]);
  assert.deepEqual(reruns, [RUN_ID], "only the failed run");
  assert.deepEqual(snapshot, before, "the pass writes no state");
  // GitHub's run_attempt is the durable once-per-head record: the next pass
  // sees attempt 2 and never re-runs this head again, whatever it concludes.
  assert.deepEqual(await rerunPass(snapshot, surface), []);
  assert.deepEqual(reruns, [RUN_ID]);
});

Deno.test("ci re-run: a refused or unconfirmed re-run is reported, never retried blindly", async () => {
  const refused = fakeSurface({ accepted: false });
  assert.deepEqual(await rerunPass(blockedSnapshot(), refused.surface), [
    SENT.replace(":sent", ":refused"),
  ]);
  const unconfirmed = fakeSurface({ confirm: false });
  assert.deepEqual(await rerunPass(blockedSnapshot(), unconfirmed.surface), [
    SENT.replace(":sent", ":unconfirmed"),
  ]);
});

Deno.test("ci re-run: only the exact flake-candidate shape is re-run", async (t) => {
  const record = gatewayRecord("blocked");
  const cases: [string, RepairStateSnapshotV1, FakeOptions, Set<string>?][] = [
    ["a run already re-run on this head", blockedSnapshot(), {
      runs: [
        headRun(),
        headRun({ id: 2, conclusion: "success", runAttempt: 2 }),
      ],
    }],
    ["a run still in progress", blockedSnapshot(), {
      runs: [headRun({ status: "in_progress", conclusion: null })],
    }],
    ["a cancelled run", blockedSnapshot(), {
      runs: [headRun({ conclusion: "cancelled" })],
    }],
    ["an unprovable run listing", blockedSnapshot(), { runs: null }],
    ["no run on the head", blockedSnapshot(), { runs: [] }],
    ["a moved base", blockedSnapshot(), { baseTip: SHA2 }],
    ["an unreadable base", blockedSnapshot(), { baseTip: null }],
    ["a red base", blockedSnapshot(), { green: () => false }],
    ["a pull at another head", blockedSnapshot(), { pull: { headSha: SHA2 } }],
    ["an untrusted author", blockedSnapshot(), {
      pull: { author: "someone-else" },
    }],
    ["a pull targeting another branch", blockedSnapshot(), {
      pull: { baseRef: "release" },
    }],
    ["a merged pull", blockedSnapshot(), {
      pull: { state: "closed", merged: true, mergeCommitSha: MERGE },
    }],
    ["an unreadable pull", blockedSnapshot(), { pull: null }],
    ["a closed source issue", blockedSnapshot(), { issueOpen: false }],
    ["an unreadable source issue", blockedSnapshot(), { issueOpen: null }],
    ["a surface without the re-run capability", blockedSnapshot(), {
      capabilities: false,
    }],
    [
      "a source issue already known closed",
      blockedSnapshot(),
      {},
      new Set([hostedIssueKey(GATEWAY, record.related.issueNumber!)]),
    ],
    [
      "another blocker",
      blockedSnapshot([gatewayRecord("blocked", {
        blocker: { ...CI_BLOCKER, message: "model run ended" },
      })]),
      {},
    ],
    [
      "a record already in delivery",
      blockedSnapshot([
        gatewayRecord("delivery"),
      ]),
      {},
    ],
    [
      "an operation in flight",
      blockedSnapshot([gatewayRecord("blocked", {
        intent: {
          kind: "base_refresh",
          key: `base_refresh:${FOREIGN_PR}:${HEAD}:${SHA2}`,
          startedAt: T0 + 3000,
          branch: record.target.branch,
          expectedHead: HEAD,
          observedBase: SHA2,
          pr: FOREIGN_PR,
          requestId: null,
          resultId: null,
        },
      })]),
      {},
    ],
    [
      "a candidate without a preserved descriptor",
      blockedSnapshot([
        gatewayRecord("blocked", {
          target: {
            ...record.target,
            candidateState: { preserved: null, publishedHead: HEAD },
          },
        }),
      ]),
      {},
    ],
    [
      "a legacy record with no candidate state",
      blockedSnapshot([
        gatewayRecord("blocked", {
          target: { ...unrelatedForeignRecord().target },
        }),
      ]),
      {},
    ],
    ["no review receipt", blockedSnapshot(undefined, []), {}],
    [
      "a rejecting review",
      blockedSnapshot(undefined, [gatewayReceipt({
        findings: [finding("P1")],
        unresolvedSeverities: ["P1"],
      })]),
      {},
    ],
    [
      "a review of another base",
      blockedSnapshot(undefined, [gatewayReceipt({
        pullRequest: { number: FOREIGN_PR, head: HEAD, base: SHA2 },
      })]),
      {},
    ],
    [
      "a recorded release request",
      blockedSnapshot(undefined, undefined, [releaseRequest("ci-rerun", {
        target: { repository: GATEWAY, environment: "production" },
        revision: MERGE,
        source: {
          pullRequest: FOREIGN_PR,
          reviewRequestId: "review-req-1",
          reviewReceiptId: null,
          head: HEAD,
          base: BASE,
        },
      })]),
      {},
    ],
  ];
  const control = fakeSurface();
  assert.deepEqual(await rerunPass(blockedSnapshot(), control.surface), [SENT]);
  for (const [name, snapshot, options, closed] of cases) {
    await t.step(name, async () => {
      const { surface, reruns } = fakeSurface(options);
      assert.deepEqual(await rerunPass(snapshot, surface, closed), []);
      assert.deepEqual(reruns, []);
    });
  }
});

Deno.test("ci re-run: the runtime's unattributed CI block gets the same single re-run", async () => {
  const snapshot = blockedSnapshot([gatewayRecord("blocked", {
    blocker: {
      ...CI_BLOCKER,
      message: "CI checks failed without base evidence: validate(failure)",
    },
  })]);
  const { surface, reruns } = fakeSurface();
  assert.deepEqual(await rerunPass(snapshot, surface), [SENT]);
  assert.deepEqual(await rerunPass(snapshot, surface), [], "once per head");
  assert.deepEqual(reruns, [RUN_ID]);
});

Deno.test("ci re-run: a timed-out run is re-run, and the pass is bounded", async () => {
  const timedOut = fakeSurface({
    runs: [headRun({ conclusion: "timed_out" })],
  });
  assert.deepEqual(await rerunPass(blockedSnapshot(), timedOut.surface), [
    SENT,
  ]);
  // Five eligible records on five heads, one failed run each: one pass
  // re-runs at most HOSTED_AUTONOMY_CI_RERUNS_PER_PASS of them; the rest wait
  // for later passes.
  const heads = [1, 2, 3, 4, 5].map((digit) => String(digit).repeat(40));
  const records = heads.map((head, index) => {
    const issue = 600 + index;
    const record = gatewayRecord("blocked");
    return {
      ...record,
      id: `issue-ubiquity-ai.ubq.fi-${issue}`,
      related: { incidentId: null, issueNumber: issue },
      target: {
        ...record.target,
        head,
        branch: `sentinel/repair/issue-ubiquity-ai.ubq.fi-${issue}`,
        pr: FOREIGN_PR + 10 + index,
        candidateState: {
          preserved: {
            ...record.target.candidateState.preserved,
            head,
          },
          publishedHead: head,
        },
      },
    };
  });
  const reviews = records.map((record, index) =>
    gatewayReceipt({
      id: `review-receipt:${String(index).repeat(64)}`,
      pullRequest: { number: record.target.pr, head: heads[index], base: BASE },
    })
  );
  const many = fakeSurface({
    runs: heads.map((headSha, index) => headRun({ id: 500 + index, headSha })),
  });
  const surface: HostedAutonomyGitHubV1 = {
    ...many.surface,
    readPull: (number: number) =>
      Promise.resolve(foreignPullFacts({
        number,
        state: "open",
        merged: false,
        mergeCommitSha: null,
        author: "ubiquity-sentinel[bot]",
        headSha: heads[number - FOREIGN_PR - 10],
      })),
  };
  const actions = await rerunPass(blockedSnapshot(records, reviews), surface);
  assert.equal(HOSTED_AUTONOMY_CI_RERUNS_PER_PASS, 3);
  assert.equal(many.reruns.length, HOSTED_AUTONOMY_CI_RERUNS_PER_PASS);
  assert.equal(actions.length, HOSTED_AUTONOMY_CI_RERUNS_PER_PASS);
});

Deno.test("ci re-run: run selection is once per exact head", () => {
  assert.deepEqual(ciRerunRuns(null, HEAD), []);
  assert.deepEqual(ciRerunRuns([], HEAD), []);
  assert.deepEqual(ciRerunRuns([headRun()], HEAD), [RUN_ID]);
  assert.deepEqual(
    ciRerunRuns([headRun(), headRun({ id: 7, conclusion: "timed_out" })], HEAD),
    [RUN_ID, 7],
  );
  assert.deepEqual(ciRerunRuns([headRun({ headSha: SHA2 })], HEAD), []);
  assert.deepEqual(
    ciRerunRuns([headRun(), headRun({ id: 7, runAttempt: 2 })], HEAD),
    [],
    "any re-run attempt on the head ends the path",
  );
  for (const conclusion of ["success", "cancelled", "skipped", null]) {
    assert.deepEqual(ciRerunRuns([headRun({ conclusion })], HEAD), []);
  }
});

Deno.test("ci re-run: the launcher pass re-runs the flake, re-admits the green head and then delivers it", async () => {
  // The expected live sequence for PRs 1087/1089: pass 1 re-runs the failed
  // run (no state write, no merge), pass 2 re-admits the now-green head to
  // `delivery` through the existing grant, pass 3 merges at the exact head and
  // records the Gateway release request.
  let headGreen = false;
  const { rig, github } = await makeRig("ci-rerun-sequence", {
    repair: repairSnapshot([gatewayRecord("blocked") as never], [
      gatewayReceipt(),
    ]),
    pull: foreignPullFacts({
      state: "open",
      merged: false,
      mergeCommitSha: null,
    }),
    afterMerge: foreignPullFacts(),
    baseTip: BASE,
    issueOpen: true,
    issueTask: (n) =>
      Promise.resolve(unrelatedRepositoryTask(UNRELATED_REPO, n)),
  });
  const fake = fakeSurface();
  const surface: HostedAutonomyGitHubV1 = {
    ...github,
    readIssueOptedOut: () => Promise.resolve(false as boolean | null),
    hasAllChecksGreen: (sha: string) =>
      Promise.resolve(sha === BASE || (sha === HEAD && headGreen)),
    listHeadRuns: fake.surface.listHeadRuns,
    rerunFailedJobs: fake.surface.rerunFailedJobs,
  };
  rig.githubFor = () => surface;
  const read = async () => {
    const value = await rig.state.readRepair();
    assert.ok(value.ok && value.value.status === "found");
    return value.value.snapshot;
  };
  try {
    const first = await run(rig);
    assert.ok(first.actions.includes(SENT), JSON.stringify(first.actions));
    assert.equal(rig.writes, 0);
    assert.equal(rig.merges, 0);
    assert.deepEqual(fake.reruns, [RUN_ID]);

    headGreen = true;
    const second = await run(rig);
    assert.equal(second.status, "applied", JSON.stringify(second));
    assert.equal(rig.merges, 0);
    const readmitted = (await read()).work[0];
    assert.equal(readmitted.nextStep, "delivery");
    assert.equal(readmitted.blocker, null);
    assert.equal(readmitted.intent, null);
    assert.deepEqual(readmitted.counters, gatewayRecord("blocked").counters);

    await run(rig);
    assert.equal(rig.merges, 1);
    const delivered = await read();
    assert.equal(delivered.releaseRequests.length, 1);
    assert.equal(delivered.releaseRequests[0].source.head, HEAD);
    assert.deepEqual(fake.reruns, [RUN_ID], "never re-run twice");
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

// ---- flake first: when a correction may be re-admitted ---------------------

/** A CI-parked Gateway head with a review round left (correction-eligible). */
const correctable = (overrides: Record<string, unknown> = {}) =>
  gatewayRecord("blocked", {
    counters: { attempts: 3, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
const GATEWAY_HEAD = ciGreenHeadKey(GATEWAY, HEAD);

async function settledFor(
  snapshot: RepairStateSnapshotV1,
  surface: HostedAutonomyGitHubV1,
  tip: string | null = BASE,
  closedIssues: Set<string> = new Set(),
): Promise<{ settled: Set<string>; listings: number }> {
  let listings = 0;
  const counted: HostedAutonomyGitHubV1 = {
    ...surface,
    ...(surface.listHeadRuns === undefined ? {} : {
      listHeadRuns: (head: string) => {
        listings++;
        return surface.listHeadRuns!(head);
      },
    }),
  };
  const deps = {
    state: undefined,
    githubFor: () => counted,
    clock: { now: () => T0 },
  } as unknown as HostedAutonomyDepsV1;
  const context = {
    deps,
    actions: [],
    revisions: [],
    snapshot,
    observedHead: SHA1,
    initialHead: SHA1,
    releaseSnapshot: undefined,
    closedIssues,
    foreignMerged: new Map(),
    dedicatedReservations: new Set<string>(),
    ...createHostedAutonomyScopes(deps),
  } as unknown as HostedAutonomyPassContextV1;
  const settled = await readCiRerunSettled(
    context,
    new Map([[hostedRepositoryKey(GATEWAY), tip]]),
  );
  return { settled, listings };
}

Deno.test("ci re-run: a correction waits for the head's once-per-head re-run to settle", async (t) => {
  const snapshot = blockedSnapshot([correctable()]);
  const settled = async (
    options: FakeOptions,
    tip: string | null = BASE,
    target = snapshot,
  ) => (await settledFor(target, fakeSurface(options).surface, tip)).settled;
  await t.step("a re-run the pass may still send is pending", async () => {
    assert.deepEqual(await settled({}), new Set());
  });
  await t.step("an unprovable or unreadable listing is pending", async () => {
    assert.deepEqual(await settled({ runs: null }), new Set());
    const throwing: HostedAutonomyGitHubV1 = {
      ...fakeSurface().surface,
      listHeadRuns: () => Promise.reject(new Error("offline")),
    };
    assert.deepEqual(
      (await settledFor(snapshot, throwing)).settled,
      new Set(),
    );
  });
  await t.step("an unreadable base tip is pending", async () => {
    assert.deepEqual(await settled({}, null), new Set());
  });
  for (
    const [name, options] of [
      ["already re-run", {
        runs: [headRun({ runAttempt: 2, status: "in_progress" })],
      }],
      ["nothing re-runnable", { runs: [headRun({ conclusion: "cancelled" })] }],
      ["no run on the head", { runs: [] }],
      ["no re-run capability", { capabilities: false }],
      [
        "more failed runs than one pass may re-run",
        {
          runs: Array.from(
            { length: HOSTED_AUTONOMY_CI_RERUNS_PER_PASS + 1 },
            (_, index) => headRun({ id: 900 + index }),
          ),
        },
      ],
    ] as [string, FakeOptions][]
  ) {
    await t.step(`${name} is settled`, async () => {
      assert.deepEqual(await settled(options), new Set([GATEWAY_HEAD]));
    });
  }
  await t.step("a moved base is settled without a listing", async () => {
    const { settled, listings } = await settledFor(
      snapshot,
      fakeSurface().surface,
      SHA2,
    );
    assert.deepEqual(settled, new Set([GATEWAY_HEAD]));
    assert.equal(listings, 0);
  });
  await t.step(
    "a legacy record the re-run pass never acts on is settled",
    async () => {
      const legacy = blockedSnapshot([correctable({
        target: { ...unrelatedForeignRecord().target },
      })]);
      assert.deepEqual(
        await settled({}, BASE, legacy),
        new Set([ciGreenHeadKey(GATEWAY, legacy.work[0].target.head!)]),
      );
    },
  );
  await t.step("only a correction-eligible head is considered", async () => {
    for (
      const record of [
        gatewayRecord("blocked"),
        correctable({
          blocker: {
            ...CI_BLOCKER,
            message:
              "CI checks failed without base evidence: validate(failure)",
          },
        }),
      ]
    ) {
      const { settled, listings } = await settledFor(
        blockedSnapshot([record]),
        fakeSurface({ runs: [] }).surface,
      );
      assert.deepEqual(settled, new Set());
      assert.equal(listings, 0);
    }
    const closed = await settledFor(
      snapshot,
      fakeSurface({ runs: [] }).surface,
      BASE,
      new Set([hostedIssueKey(GATEWAY, correctable().related.issueNumber!)]),
    );
    assert.deepEqual(closed.settled, new Set());
  });
});

// ---- GitHub surface ---------------------------------------------------------

Deno.test("ci re-run: the GitHub surface lists a head's runs completely and re-runs failed jobs", async () => {
  const calls: { method: string; url: string }[] = [];
  const original = globalThis.fetch;
  const install = (
    handler: (url: string, method: string) => Response,
  ) => {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      return Promise.resolve(handler(url, method));
    }) as typeof fetch;
  };
  const surface = () =>
    createHostedAutonomyGitHub("fixture-token", GATEWAY as never);
  const wire = (overrides: Record<string, unknown> = {}) => ({
    id: RUN_ID,
    head_sha: HEAD,
    status: "completed",
    conclusion: "failure",
    run_attempt: 1,
    ...overrides,
  });
  const page = (url: string) => Number(new URL(url).searchParams.get("page"));
  try {
    // A second page is still read; the listing is bound to the exact head.
    install((url) =>
      jsonResponse({
        total_count: 51,
        workflow_runs: page(url) === 1
          ? Array.from({ length: 50 }, (_, index) =>
            wire({ id: 1000 + index, conclusion: "success" }))
          : [wire()],
      })
    );
    const listed = await surface().listHeadRuns!(HEAD);
    assert.equal(listed?.length, 51);
    assert.deepEqual(listed?.at(-1), headRun());
    assert.ok(
      calls.every((call) =>
        call.url.includes(
          `/repos/ubiquity/ai.ubq.fi/actions/runs?head_sha=${HEAD}`,
        )
      ),
    );
    for (
      const malformed of [
        wire({ head_sha: SHA2 }),
        wire({ run_attempt: 0 }),
        wire({ run_attempt: "1" }),
        wire({ status: 3 }),
        wire({ conclusion: 7 }),
      ]
    ) {
      install(() =>
        jsonResponse({ total_count: 1, workflow_runs: [malformed] })
      );
      assert.equal(await surface().listHeadRuns!(HEAD), null);
    }
    install(() => jsonResponse({ total_count: 2, workflow_runs: [wire()] }));
    assert.equal(
      await surface().listHeadRuns!(HEAD),
      null,
      "an incomplete listing is unprovable",
    );

    // GitHub answers the re-run with 201 and an empty body: any 2xx is sent.
    calls.length = 0;
    install(() => new Response(null, { status: 201 }));
    assert.equal(await surface().rerunFailedJobs!(RUN_ID), true);
    assert.deepEqual(calls, [{
      method: "POST",
      url:
        `https://api.github.com/repos/ubiquity/ai.ubq.fi/actions/runs/${RUN_ID}/rerun-failed-jobs`,
    }]);
    install(() => new Response("{}", { status: 403 }));
    assert.equal(await surface().rerunFailedJobs!(RUN_ID), false);
    install(() => {
      throw new Error("offline");
    });
    assert.equal(await surface().rerunFailedJobs!(RUN_ID), false);
  } finally {
    globalThis.fetch = original;
  }
});
