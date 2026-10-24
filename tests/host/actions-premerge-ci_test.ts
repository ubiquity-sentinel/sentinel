/** Pre-merge CI dispatch: exact binding, one request per pass, no evidence. */
import assert from "node:assert/strict";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import {
  dispatchPremergeCi,
  pendingPremergeRecords,
  PREMERGE_CI_MARGIN_MS,
} from "../../src/host/actions-premerge-ci.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { premergeCiPolicyV1 } from "../../src/host/target-policy.ts";
import { createTargetConfigV1 } from "../../src/host/targets.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import { FakeGate, response, ScriptedHttp } from "./actions-ci-fixture.ts";

const APP_LOGIN = "ubiquity-sentinel[bot]";
const INSTALLATION = 173_913_802;
const GATEWAY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155_687_488,
};
const BRANCH = "sentinel/repair/issue-ubiquity-ai.ubq.fi-1212";
const REPO_PATH = "/repos/ubiquity/ai.ubq.fi";
const RUNS_PATH = `${REPO_PATH}/actions/workflows/deno-deploy.yml/runs`;
const DISPATCH_PATH =
  `${REPO_PATH}/actions/workflows/deno-deploy.yml/dispatches`;
/** First parent of the base commit SHA1 (the merge on `development`). */
const PARENT = "0123456789abcdef0123456789abcdef01234567";
/** The base branch tip read: the dispatch ref is the branch, not a SHA. */
const COMMIT_PATH = `${REPO_PATH}/commits/development`;

function gatewayConfig(): RepositoryConfigV1 {
  const config = createTargetConfigV1(
    createLocalRepositoryConfig(),
    { owner: "ubiquity", name: "ai.ubq.fi", slug: "ubiquity/ai.ubq.fi" },
    "development",
  );
  return { ...config, repository: { ...GATEWAY } };
}

function grant(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    appId: 4682172,
    installationId: INSTALLATION,
    appSlug: "ubiquity-sentinel",
    expiresAt: new Date(T0 + 3_600_000).toISOString().replace(".000Z", "Z"),
    permissions: {
      contents: "write",
      metadata: "read",
      actions: "write",
      pull_requests: "write",
    },
    repositoryIds: [1116191389, 1254699258],
    repositoryNames: ["ai.ubq.fi", "passport.ubq.fi"],
    ...overrides,
  });
}

function pendingRecord(
  pr: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(`issue-ubiquity-ai.ubq.fi-${pr}`, {
    repository: { ...GATEWAY },
    source: { kind: "issue", id: String(pr), revision: SHA1 },
    related: { incidentId: null, issueNumber: pr },
    target: { base: SHA1, branch: BRANCH, checkpoint: null, head: SHA2, pr },
    nextStep: "work",
    wait: { reason: "ci_pending", since: T0, until: T0 + 300_000 },
    ...overrides,
  });
}

function pullBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    number: 1254,
    state: "open",
    merged: false,
    user: { login: APP_LOGIN },
    head: {
      sha: SHA2,
      ref: BRANCH,
      repo: { full_name: "ubiquity/ai.ubq.fi" },
    },
    base: { sha: SHA1, ref: "development" },
    ...overrides,
  };
}

function runsBody(runs: unknown[]): unknown {
  return { total_count: runs.length, workflow_runs: runs };
}

interface RigOptions {
  work?: WorkRecordV1[];
  pull?: unknown;
  runsOnHead?: unknown[];
  runsAfterDispatch?: unknown[];
  /** Runs listed for the base SHA1 before and after a base dispatch. */
  runsOnBase?: unknown[];
  baseRunsAfterDispatch?: unknown[];
  dispatchStatus?: number;
  mintGrant?: string | undefined;
  deadline?: number;
}

function makeRig(options: RigOptions = {}) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  state.repair = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: options.work ?? [pendingRecord(1254)],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  const http = new ScriptedHttp();
  const gate = new FakeGate();
  let dispatched = false;
  let baseDispatched = false;
  http.on(
    "GET",
    `${REPO_PATH}/pulls/1254`,
    () => response(200, options.pull ?? pullBody()),
  );
  http.on("GET", RUNS_PATH, (request: HttpRequestV1) => {
    const sha = new URL(request.url).searchParams.get("head_sha");
    assert.ok(sha === SHA1 || sha === SHA2 || sha === SHA3);
    if (sha === SHA1) {
      return response(
        200,
        runsBody(
          baseDispatched
            ? options.baseRunsAfterDispatch ?? options.runsOnBase ?? []
            : options.runsOnBase ?? [],
        ),
      );
    }
    return response(
      200,
      runsBody(
        dispatched
          ? options.runsAfterDispatch ?? options.runsOnHead ?? []
          : options.runsOnHead ?? [],
      ),
    );
  });
  http.on(
    "GET",
    COMMIT_PATH,
    () =>
      response(200, { sha: SHA1, parents: [{ sha: PARENT }, { sha: SHA3 }] }),
  );
  http.on("POST", DISPATCH_PATH, (request: HttpRequestV1) => {
    if (JSON.parse(request.body ?? "null")?.ref === "development") {
      baseDispatched = true;
    } else dispatched = true;
    return response(options.dispatchStatus ?? 204, "");
  });
  const logs: Record<string, unknown>[] = [];
  const run = (config = gatewayConfig()) =>
    dispatchPremergeCi({
      http: http.transport,
      clock,
      state,
      gate,
      token: "target-token",
      mintGrant: "mintGrant" in options ? options.mintGrant : grant(),
      installationId: INSTALLATION,
      trustedAuthor: APP_LOGIN,
      deadline: options.deadline ?? T0 + 60 * 60_000,
      log: (line) => logs.push(line),
    }, config);
  return { clock, state, http, gate, logs, run };
}

type Rig = ReturnType<typeof makeRig>;

/** Run listings requested for the base SHA1. */
function baseRunReads(rig: Rig): number {
  return rig.http.calls.filter((call) =>
    new URL(call.url).pathname === RUNS_PATH &&
    new URL(call.url).searchParams.get("head_sha") === SHA1
  ).length;
}

function commitReads(rig: Rig): number {
  return rig.http.calls.filter((call) =>
    new URL(call.url).pathname === COMMIT_PATH
  ).length;
}

/** A head run that already exists, so the pass may request base evidence. */
const HEAD_RUN = {
  id: 7,
  head_sha: SHA2,
  status: "completed",
  conclusion: "failure",
};

Deno.test("premerge CI: policy exists for the gateway only", () => {
  assert.deepEqual(premergeCiPolicyV1(GATEWAY), {
    workflowFile: "deno-deploy.yml",
    baseRefInput: "base_ref",
    authorInput: "sentinel_pr_author",
    scopeBaseInput: "scope_base",
  });
  assert.equal(
    premergeCiPolicyV1({ owner: "ubiquity", name: "passport.ubq.fi" }),
    null,
  );
  assert.equal(
    premergeCiPolicyV1({ owner: "ubiquity-sentinel", name: "sentinel" }),
    null,
  );
});

Deno.test("premerge CI: pending records are the gateway's ci_pending published heads", () => {
  const config = gatewayConfig();
  const work = [
    pendingRecord(1258),
    pendingRecord(1254),
    pendingRecord(1255, {
      nextStep: "blocked",
      wait: null,
      blocker: { kind: "other", message: "x", since: T0 },
    }),
    pendingRecord(1256, { nextStep: "review" }),
    pendingRecord(1257, { wait: null }),
    pendingRecord(1259, {
      intent: {
        kind: "merge",
        key: `merge:1259:${SHA2}`,
        startedAt: T0,
        branch: BRANCH,
        expectedHead: SHA2,
        observedBase: SHA1,
        pr: 1259,
        requestId: `review-review:1259:${SHA2}`,
        resultId: "result-1259",
      },
    }),
    workRecord("issue-9", {
      nextStep: "work",
      wait: { reason: "ci_pending", since: T0, until: null },
    }),
  ];
  assert.deepEqual(
    pendingPremergeRecords(work, config).map((record) => record.target.pr),
    [1254, 1258],
  );
});

Deno.test("premerge CI: a head parked on the pre-review CI bound is dispatched after live waits (#204)", () => {
  const config = gatewayConfig();
  const parked = (pr: number, message: string) =>
    pendingRecord(pr, {
      nextStep: "blocked",
      wait: null,
      blocker: { kind: "other", message, since: T0 },
    });
  const work = [
    parked(1250, "CI did not finish before review within 6 hours: Gateway CI"),
    pendingRecord(1258),
    parked(1251, "CI checks failed: Gateway CI"),
    parked(1249, "CI did not finish before review within 6 hours: none"),
  ];
  assert.deepEqual(
    pendingPremergeRecords(work, config).map((record) => record.target.pr),
    [1258, 1249, 1250],
    "live waits first; a red park is never dispatched",
  );
});

Deno.test("premerge CI: one exact dispatch per pass with the workflow's inputs", async () => {
  const rig = makeRig({
    work: [
      pendingRecord(1254),
      pendingRecord(1258, {
        target: {
          base: SHA1,
          branch: `${BRANCH}x`,
          checkpoint: null,
          head: SHA3,
          pr: 1258,
        },
      }),
    ],
    runsAfterDispatch: [{ id: 1, head_sha: SHA2, status: "queued" }],
  });
  const report = await rig.run();
  assert.equal(report.decision, "dispatched");
  assert.equal(report.pr, 1254);
  assert.deepEqual(report.decisions, ["1254:dispatched:confirmed"]);
  const posts = rig.http.posts();
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].body ?? "null"), {
    ref: BRANCH,
    inputs: {
      base_ref: "development",
      sentinel_pr_author: APP_LOGIN,
      scope_base: SHA1,
    },
  });
  assert.equal(posts[0].headers.get("authorization"), "Bearer target-token");
  // The second pending record is never read in the same pass.
  assert.equal(
    rig.http.calls.filter((call) => call.url.endsWith("/pulls/1258")).length,
    0,
  );
  // Every request passed the shared cooldown gate under the target scope.
  assert.ok(rig.gate.admissions.length >= 3);
  assert.ok(rig.gate.admissions.every((id) => id === GATEWAY.installationId));
  // Nothing was written to state: a dispatch is a request, not evidence.
  assert.equal(rig.state.repairWrites, 0);
});

Deno.test("premerge CI: an existing run on the exact head is never duplicated", async () => {
  const rig = makeRig({
    runsOnHead: [{
      id: 7,
      head_sha: SHA2,
      status: "completed",
      conclusion: "failure",
    }],
    runsOnBase: [{ id: 8, head_sha: SHA1, status: "in_progress" }],
  });
  const report = await rig.run();
  assert.equal(report.decision, "nothing_pending");
  assert.deepEqual(report.decisions, [
    "1254:run_exists",
    "1254:base_run_exists",
  ]);
  assert.equal(rig.http.posts().length, 0);
  // A base that already has any run of the workflow is never re-requested,
  // so its commit is never read either.
  assert.equal(baseRunReads(rig), 1);
  assert.equal(commitReads(rig), 0);
});

Deno.test("premerge CI: the live pull request must bind author, head, ref, base and repository", async () => {
  for (
    const [name, pull] of Object.entries({
      author: pullBody({ user: { login: "someone-else" } }),
      head: pullBody({
        head: {
          sha: SHA3,
          ref: BRANCH,
          repo: { full_name: "ubiquity/ai.ubq.fi" },
        },
      }),
      ref: pullBody({
        head: {
          sha: SHA2,
          ref: "other",
          repo: { full_name: "ubiquity/ai.ubq.fi" },
        },
      }),
      fork: pullBody({
        head: { sha: SHA2, ref: BRANCH, repo: { full_name: "fork/ai.ubq.fi" } },
      }),
      base: pullBody({ base: { sha: SHA1, ref: "main" } }),
      closed: pullBody({ state: "closed" }),
      merged: pullBody({ merged: true }),
    })
  ) {
    const rig = makeRig({ pull });
    const report = await rig.run();
    assert.equal(report.decision, "nothing_pending", name);
    assert.deepEqual(report.decisions, ["1254:pull_mismatch"], name);
    assert.equal(rig.http.posts().length, 0, name);
  }
});

Deno.test("premerge CI: the dispatching token must be granted for the exact repository with actions write", async () => {
  for (
    const [name, mintGrant] of Object.entries({
      absent: undefined,
      wrongInstallation: grant({ installationId: 1 }),
      noActions: grant({
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
        },
      }),
      otherRepository: grant({
        repositoryIds: [1],
        repositoryNames: ["passport.ubq.fi"],
      }),
      unknownScope: grant({
        repositoryIds: undefined,
        repositoryNames: undefined,
      }),
    })
  ) {
    const rig = makeRig({ mintGrant });
    const report = await rig.run();
    assert.equal(report.decision, "grant_refused", name);
    assert.equal(rig.http.calls.length, 0, name);
  }
});

Deno.test("premerge CI: a refused dispatch ends the pass and a moved ref is reported", async () => {
  const refused = makeRig({ dispatchStatus: 422 });
  const report = await refused.run();
  assert.equal(report.decision, "dispatch_refused");
  assert.deepEqual(report.decisions, ["1254:dispatch_refused:http_422"]);
  assert.equal(refused.http.posts().length, 1);

  const moved = makeRig({ runsAfterDispatch: [] });
  const movedReport = await moved.run();
  assert.equal(movedReport.decision, "dispatched");
  assert.deepEqual(movedReport.decisions, [
    "1254:dispatched:pending_visibility",
  ]);
});

Deno.test("premerge CI: the deadline, cooldown and absent policy refuse before any request", async () => {
  const late = makeRig({ deadline: T0 + PREMERGE_CI_MARGIN_MS });
  assert.equal((await late.run()).decision, "deadline");
  assert.equal(late.http.calls.length, 0);

  const cooling = makeRig();
  cooling.gate.deny = true;
  assert.equal((await cooling.run()).decision, "cooldown");
  assert.equal(cooling.http.calls.length, 0);

  const passport = makeRig();
  const config = gatewayConfig();
  const other = {
    ...config,
    repository: {
      owner: "ubiquity",
      name: "passport.ubq.fi",
      installationId: 155_687_488,
    },
  };
  assert.equal((await passport.run(other)).decision, "no_policy");
  assert.equal(passport.http.calls.length, 0);
});

Deno.test("premerge CI: a rate-limited read is recorded on the gate and ends the pass", async () => {
  // Issue #198: the limit is persisted before any later request and no
  // further pending record is read in the same pass.
  const second = pendingRecord(1258, {
    target: {
      base: SHA1,
      branch: `${BRANCH}x`,
      checkpoint: null,
      head: SHA3,
      pr: 1258,
    },
  });
  const rig = makeRig({ work: [pendingRecord(1254), second] });
  rig.http.on(
    "GET",
    `${REPO_PATH}/pulls/1254`,
    () =>
      response(403, { message: "API rate limit exceeded" }, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(Math.floor((T0 + 600_000) / 1000)),
      }),
  );
  const report = await rig.run();
  assert.equal(report.decision, "rate_limited");
  assert.equal(rig.gate.recorded.length, 1);
  assert.equal(rig.gate.admissions.length, 1);
  assert.equal(
    rig.http.calls.filter((call) => call.url.endsWith("/pulls/1258")).length,
    0,
  );
  assert.equal(rig.http.posts().length, 0);
});

Deno.test("premerge CI: a deadline crossed mid-pass is reported as a deadline, not a cooldown", async () => {
  // Issue #199: the pull read succeeds, then the run deadline margin passes
  // before the runs read; the gate is never consulted for that request.
  const deadline = T0 + PREMERGE_CI_MARGIN_MS + 1_000;
  const rig = makeRig({ deadline });
  rig.http.on("GET", `${REPO_PATH}/pulls/1254`, () => {
    rig.clock.advance(2_000);
    return response(200, pullBody());
  });
  const report = await rig.run();
  assert.equal(report.decision, "deadline");
  assert.equal(rig.gate.admissions.length, 1);
  assert.equal(rig.http.posts().length, 0);
});

Deno.test("premerge CI: a base without any run gets one full-scope dispatch", async () => {
  // Gateway CI on a closed pull request reports on the PR head, so the
  // `development` merge commit carries no check run to attribute a red head.
  const second = pendingRecord(1258, {
    target: {
      base: SHA1,
      branch: `${BRANCH}x`,
      checkpoint: null,
      head: SHA3,
      pr: 1258,
    },
  });
  const rig = makeRig({
    work: [pendingRecord(1254), second],
    runsOnHead: [HEAD_RUN, { id: 9, head_sha: SHA3, status: "completed" }],
    baseRunsAfterDispatch: [{ id: 10, head_sha: SHA1, status: "queued" }],
  });
  rig.http.on("GET", `${REPO_PATH}/pulls/1258`, () =>
    response(
      200,
      pullBody({
        number: 1258,
        head: {
          sha: SHA3,
          ref: `${BRANCH}x`,
          repo: { full_name: "ubiquity/ai.ubq.fi" },
        },
      }),
    ));
  const report = await rig.run();
  assert.equal(report.decision, "base_dispatched");
  assert.equal(report.pr, 1254);
  assert.deepEqual(report.decisions, [
    "1254:run_exists",
    "1258:run_exists",
    "1254:base_dispatched:confirmed",
  ]);
  const posts = rig.http.posts();
  assert.equal(posts.length, 1, "one dispatch for the shared base");
  assert.deepEqual(JSON.parse(posts[0].body ?? "null"), {
    ref: "development",
    inputs: {
      base_ref: "development",
      sentinel_pr_author: APP_LOGIN,
      // The base itself: an empty diff the gateway runs as everything.
      scope_base: SHA1,
    },
  });
  assert.equal(posts[0].headers.get("authorization"), "Bearer target-token");
  // One existence read, one commit read and one confirming read of the base.
  assert.equal(baseRunReads(rig), 2);
  assert.equal(commitReads(rig), 1);
  assert.ok(rig.gate.admissions.every((id) => id === GATEWAY.installationId));
  // A request for evidence, never evidence: no record, wait or counter moves.
  assert.equal(rig.state.repairWrites, 0);

  // A base ref that moved before GitHub resolved it: reported, not retried.
  const moved = makeRig({ runsOnHead: [HEAD_RUN] });
  const movedReport = await moved.run();
  assert.equal(movedReport.decision, "base_dispatched");
  assert.deepEqual(movedReport.decisions, [
    "1254:run_exists",
    "1254:base_dispatched:pending_visibility",
  ]);
  assert.equal(moved.http.posts().length, 1);
});

Deno.test("premerge CI: base evidence is requested only for the record's live base", async () => {
  // The record's base is SHA1; the live pull request already sits on SHA3,
  // so the gate would not read the base this dispatch would test.
  const rig = makeRig({
    runsOnHead: [HEAD_RUN],
    pull: pullBody({ base: { sha: SHA3, ref: "development" } }),
  });
  const report = await rig.run();
  assert.equal(report.decision, "nothing_pending");
  assert.deepEqual(report.decisions, ["1254:run_exists", "1254:base_stale"]);
  assert.equal(rig.http.posts().length, 0);
  assert.equal(baseRunReads(rig), 0);
  assert.equal(commitReads(rig), 0);
});

Deno.test("premerge CI: a head without a run keeps priority over base evidence", async () => {
  const second = pendingRecord(1258, {
    target: {
      base: SHA1,
      branch: `${BRANCH}x`,
      checkpoint: null,
      head: SHA3,
      pr: 1258,
    },
  });
  const rig = makeRig({
    work: [pendingRecord(1254), second],
    runsOnHead: [HEAD_RUN],
    runsAfterDispatch: [HEAD_RUN, { id: 11, head_sha: SHA3, status: "queued" }],
  });
  rig.http.on("GET", `${REPO_PATH}/pulls/1258`, () =>
    response(
      200,
      pullBody({
        number: 1258,
        head: {
          sha: SHA3,
          ref: `${BRANCH}x`,
          repo: { full_name: "ubiquity/ai.ubq.fi" },
        },
      }),
    ));
  const report = await rig.run();
  assert.equal(report.decision, "dispatched");
  assert.equal(report.pr, 1258);
  assert.deepEqual(report.decisions, [
    "1254:run_exists",
    "1258:dispatched:confirmed",
  ]);
  const posts = rig.http.posts();
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body ?? "null").ref, `${BRANCH}x`);
  assert.equal(baseRunReads(rig), 0);
  assert.equal(commitReads(rig), 0);
});

Deno.test("premerge CI: an unreadable base branch tip skips the base dispatch", async () => {
  for (
    const [name, answer] of Object.entries({
      missing: response(404, { message: "Not Found" }),
      malformed: response(200, "{"),
      badSha: response(200, { sha: "abc", parents: [{ sha: PARENT }] }),
      noSha: response(200, { parents: [{ sha: PARENT }] }),
    })
  ) {
    const rig = makeRig({ runsOnHead: [HEAD_RUN] });
    rig.http.on("GET", COMMIT_PATH, () => answer);
    const report = await rig.run();
    assert.equal(report.decision, "nothing_pending", name);
    assert.deepEqual(
      report.decisions,
      ["1254:run_exists", "1254:base_tip_unreadable"],
      name,
    );
    assert.equal(rig.http.posts().length, 0, name);
  }
});

Deno.test("premerge CI: the base dispatch honours the deadline, cooldown and a refusal", async () => {
  // The run deadline margin passes after the commit read: no POST starts.
  const late = makeRig({
    runsOnHead: [HEAD_RUN],
    deadline: T0 + PREMERGE_CI_MARGIN_MS + 1_000,
  });
  late.http.on("GET", COMMIT_PATH, () => {
    late.clock.advance(2_000);
    return response(200, { sha: SHA1, parents: [{ sha: PARENT }] });
  });
  assert.equal((await late.run()).decision, "deadline");
  assert.equal(late.http.posts().length, 0);

  // The shared gate starts cooling down before the POST: the pass ends.
  const cooling = makeRig({ runsOnHead: [HEAD_RUN] });
  cooling.http.on("GET", COMMIT_PATH, () => {
    cooling.gate.deny = true;
    return response(200, { sha: SHA1, parents: [{ sha: PARENT }] });
  });
  assert.equal((await cooling.run()).decision, "cooldown");
  assert.equal(cooling.http.posts().length, 0);

  // A refused base dispatch ends the pass without a confirming read.
  const refused = makeRig({ runsOnHead: [HEAD_RUN], dispatchStatus: 422 });
  const report = await refused.run();
  assert.equal(report.decision, "dispatch_refused");
  assert.equal(report.pr, 1254);
  assert.deepEqual(report.decisions, [
    "1254:run_exists",
    "1254:base_dispatch_refused:http_422",
  ]);
  assert.equal(refused.http.posts().length, 1);
  assert.equal(baseRunReads(refused), 1);
  assert.equal(refused.state.repairWrites, 0);
});

Deno.test("premerge CI: a base branch that moved past the record base gets no dispatch", async () => {
  // The record and the live pull request still name SHA1, but `development`
  // already points at SHA3: a dispatch on the branch would test SHA3 and
  // repeat on every pass until the record refreshes.
  const rig = makeRig({ runsOnHead: [HEAD_RUN] });
  rig.http.on(
    "GET",
    COMMIT_PATH,
    () => response(200, { sha: SHA3, parents: [{ sha: SHA1 }] }),
  );
  const report = await rig.run();
  assert.equal(report.decision, "nothing_pending");
  assert.deepEqual(report.decisions, ["1254:run_exists", "1254:base_moved"]);
  assert.equal(rig.http.posts().length, 0);
  assert.equal(rig.state.repairWrites, 0);
});
