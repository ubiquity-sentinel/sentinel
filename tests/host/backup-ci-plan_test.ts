/**
 * The planner's pure rules (docs/backup-ci-spec.md §9.3): the record set
 * through `greenReadmissionCandidate`; priority classes p0-p8 with the
 * head-class rotation; the §5 observation groups; dedupe (final, in flight,
 * backoff, unsupported) with shadow results absent in `on`; free slots
 * (`p - inflight`, p from supervisor matrix cells read through the Actions
 * API); and the round-robin across targets. All synthetic.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { CI_PRE_REVIEW_RED_PREFIX } from "../../src/repair/ci-first-policy.ts";
import { createBackupCiLegReads } from "../../ops/backup-ci-ingest-reads.ts";
import {
  backupCiCandidates,
  backupCiDedupe,
  backupCiFairSelect,
  backupCiFreeSlots,
  backupCiGroups,
  type BackupCiPlanObservationV1,
  backupCiRecords,
  unconfirmedReds,
} from "../../ops/backup-ci-plan.ts";
import type { BackupCiApiV1 } from "../../ops/backup-ci-plan-reads.ts";
import { workRecord } from "../state/helpers.ts";
import {
  commitFile,
  dispatched,
  key,
  noEvidence,
  result,
  RUNNER,
  RUNNER2,
  T0,
  unit,
} from "../github/backup-ci-fixtures.ts";

const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 7,
};
const sha = (c: string) => c.repeat(40) as GitSha;

function rec(id: string, over: Record<string, unknown> = {}) {
  const { target, ...rest } = over as { target?: Record<string, unknown> };
  return workRecord(id, {
    repository: PASSPORT,
    source: { kind: "issue", id: "1", revision: sha("1") },
    target: {
      base: sha("b"),
      branch: `sentinel/${id}`,
      checkpoint: null,
      head: sha("a"),
      pr: 7,
      ...target,
    },
    ...rest,
  });
}

function snapshot(work: ReturnType<typeof rec>[]): RepairStateSnapshotV1 {
  return {
    work,
    reservations: [],
    reviews: [],
    releaseRequests: [],
  } as unknown as RepairStateSnapshotV1;
}

Deno.test("the record set: published heads in flight and green re-admission candidates", () => {
  const work = [
    rec("w", { nextStep: "work", target: { head: sha("1") } }),
    rec("r", { nextStep: "review", target: { head: sha("2") } }),
    rec("d", { nextStep: "delivery", target: { head: sha("3") } }),
    rec("n", {
      nextStep: "work",
      target: { head: null, pr: null, branch: null },
    }),
    rec("done", { nextStep: "done", target: { head: sha("4") } }),
    rec("parked", {
      nextStep: "blocked",
      related: { incidentId: null, issueNumber: 1 },
      blocker: {
        kind: "other",
        message: `${CI_PRE_REVIEW_RED_PREFIX}deno`,
        since: T0,
      },
      target: { head: sha("5") },
    }),
    rec("other-block", {
      nextStep: "blocked",
      blocker: { kind: "other", message: "something else", since: T0 },
      target: { head: sha("6") },
    }),
    workRecord("foreign", {
      nextStep: "work",
      target: {
        base: sha("b"),
        branch: "x",
        checkpoint: null,
        head: sha("7"),
        pr: 1,
      },
    }),
  ];
  const ids = backupCiRecords(snapshot(work), "ubiquity/passport.ubq.fi").map((
    r,
  ) => r.id);
  assert.deepEqual(ids, ["w", "r", "d", "parked"]);
});

Deno.test("candidates come in priority order p0 to p8, heads rotated by run id", () => {
  const tip = sha("c");
  const records = [
    rec("w", {
      nextStep: "work",
      target: { head: sha("1"), base: sha("8") },
      wait: { reason: "backoff", since: T0 + 5, until: null },
    }),
    rec("w2", {
      nextStep: "work",
      target: { head: sha("2"), base: tip },
      wait: { reason: "backoff", since: T0 + 1, until: null },
    }),
    rec("d", { nextStep: "delivery", target: { head: sha("3"), base: tip } }),
    rec("r", {
      nextStep: "review",
      target: { head: sha("4"), base: tip, pr: null },
    }),
  ];
  const red = commitFile([result(key(), { conclusion: "failure" })], {
    commit: sha("3"),
  });
  const files = new Map([
    [sha("3"), red],
    [sha("1"), commitFile([dispatched()], { commit: sha("1") })],
  ]);
  const candidates = backupCiCandidates({
    records,
    baseTip: tip,
    defaultBranch: "main",
    calibrationCommits: [sha("e"), sha("f"), sha("0")],
    calibrated: false,
    files,
    mode: "on",
    runnerId: RUNNER,
    runId: 0,
  });
  const view = candidates.map((
    c,
  ) => [c.priority, c.commit.slice(0, 1), c.purpose]);
  assert.deepEqual(view, [
    [0, "3", "confirm"],
    [1, "e", "calibration"],
    [1, "f", "calibration"],
    [2, "c", "stand_in"],
    [3, "8", "stand_in"],
    [4, "8", "peer"],
    [4, "1", "peer"],
    [4, "c", "peer"],
    [4, "3", "peer"],
    [5, "3", "stand_in"],
    [6, "4", "stand_in"],
    [7, "2", "stand_in"],
    [7, "1", "stand_in"],
  ]);
  const confirm = candidates[0];
  assert.equal(confirm.attempt, 2);
  assert.deepEqual(confirm.key, {
    context: "push",
    workflowPath: key().workflowPath,
    checkName: "deno",
    base: null,
  });
  const review = candidates.find((c) => c.priority === 6)!;
  assert.equal(review.pullRequest, null);
  assert.equal(review.base, null);
  const delivery = candidates.find((c) => c.priority === 5)!;
  assert.equal(delivery.pullRequest, 7);
  assert.equal(delivery.base, tip);
  // A calibrated runner plans no calibration commits.
  const calibrated = backupCiCandidates({
    records: [],
    baseTip: tip,
    defaultBranch: "main",
    calibrationCommits: [sha("e")],
    calibrated: true,
    files: new Map(),
    mode: "on",
    runnerId: RUNNER,
    runId: 0,
  });
  assert.deepEqual(calibrated.map((c) => c.purpose), ["stand_in"]);
  // Commits the runner settled or has in flight give way to later ones; a
  // retryable no-evidence commit stays eligible, another runner's entry is
  // not this runner's.
  const calibrationFiles = new Map([
    [sha("a"), commitFile([result()], { commit: sha("a") })],
    [sha("b"), commitFile([dispatched()], { commit: sha("b") })],
    [
      sha("c"),
      commitFile([noEvidence(key(), { final: true, nextAt: null })], {
        commit: sha("c"),
      }),
    ],
    [sha("d"), commitFile([noEvidence()], { commit: sha("d") })],
    [
      sha("e"),
      commitFile([result(key(), { runnerId: "f".repeat(16) })], {
        commit: sha("e"),
      }),
    ],
  ]);
  const later = backupCiCandidates({
    records: [],
    baseTip: null,
    defaultBranch: "main",
    calibrationCommits: ["a", "b", "c", "d", "e", "f"].map(sha),
    calibrated: false,
    files: calibrationFiles,
    mode: "on",
    runnerId: RUNNER,
    runId: 0,
  }).filter((c) => c.purpose === "calibration");
  assert.deepEqual(later.map((c) => c.commit.slice(0, 1)), ["d", "e"]);
  // Rotation moves the start within the head classes only.
  const heads = (runId: number) =>
    backupCiCandidates({
      records: [
        rec("a", { nextStep: "work", target: { head: sha("1"), base: tip } }),
        rec("b", { nextStep: "work", target: { head: sha("2"), base: tip } }),
        rec("c", { nextStep: "work", target: { head: sha("3"), base: tip } }),
      ],
      baseTip: null,
      defaultBranch: "main",
      calibrationCommits: [],
      calibrated: true,
      files: new Map(),
      mode: "on",
      runnerId: RUNNER,
      runId,
    }).map((c) => c.commit.slice(0, 1));
  assert.deepEqual(heads(0), ["1", "2", "3"]);
  assert.deepEqual(heads(1), ["2", "3", "1"]);
  assert.deepEqual(heads(5), ["3", "1", "2"]);
});

Deno.test("only reds of the mode class and runner without an attempt 2 are confirmed", () => {
  const red = result(key(), { conclusion: "failure" });
  assert.equal(unconfirmedReds(commitFile([red]), "on", RUNNER).length, 1);
  assert.equal(unconfirmedReds(commitFile([red]), "shadow", RUNNER).length, 0);
  assert.equal(unconfirmedReds(commitFile([red]), "on", RUNNER2).length, 0);
  const confirmed = commitFile([
    red,
    result(key({ attempt: 2 }), { conclusion: "success" }),
  ]);
  assert.equal(unconfirmedReds(confirmed, "on", RUNNER).length, 0);
  const inFlight = commitFile([red, dispatched(unit(key({ attempt: 2 })))]);
  assert.equal(unconfirmedReds(inFlight, "on", RUNNER).length, 0);
  assert.equal(unconfirmedReds(commitFile([result()]), "on", RUNNER).length, 0);
});

const obs = (
  over: Partial<BackupCiPlanObservationV1>,
): BackupCiPlanObservationV1 => ({
  checkRunId: 1,
  name: "deno",
  app: "github-actions",
  suiteId: 31,
  status: "completed",
  conclusion: "failure",
  notStarted: true,
  ...over,
});
const SUITES = [
  {
    suiteId: 31,
    runId: 41,
    workflowPath: ".github/workflows/ci.yml",
    event: "push",
  },
  {
    suiteId: 32,
    runId: 42,
    workflowPath: ".github/workflows/ci.yml",
    event: "pull_request",
  },
  {
    suiteId: 33,
    runId: 43,
    workflowPath: ".github/workflows/other.yml",
    event: "push",
  },
];

Deno.test("observation groups: one app, one path per name, no status context", () => {
  const groups = (all: BackupCiPlanObservationV1[], statuses: string[] = []) =>
    backupCiGroups({
      latest: all.slice(-1),
      all,
      suites: SUITES,
      statusContexts: new Set(statuses),
    });
  const [ok] = groups([
    obs({ checkRunId: 1 }),
    obs({ checkRunId: 2, suiteId: 32 }),
  ]);
  assert(ok.ok);
  assert.deepEqual(ok.group.events, ["pull_request", "push"]);
  assert.equal(ok.group.neverStarted, true);
  assert.deepEqual(ok.group.runIds, [41, 42]);
  const verdict = (all: BackupCiPlanObservationV1[], statuses?: string[]) => {
    const [v] = groups(all, statuses);
    return v.ok
      ? (v.group.neverStarted ? "never" : v.group.started ? "started" : "mixed")
      : v.reason;
  };
  assert.equal(
    verdict([obs({ app: "other-ci" }), obs({ checkRunId: 2 })]),
    "other_app",
  );
  assert.equal(
    verdict([obs({}), obs({ checkRunId: 2, suiteId: 33 })]),
    "mixed_paths",
  );
  assert.equal(verdict([obs({ suiteId: 99 })]), "unknown");
  assert.equal(verdict([obs({ suiteId: null })]), "unknown");
  assert.equal(verdict([obs({})], ["deno"]), "status_context");
  // An earlier started attempt hidden by the default listing.
  assert.equal(
    verdict([
      obs({ checkRunId: 1, notStarted: false }),
      obs({ checkRunId: 2 }),
    ]),
    "mixed",
  );
  assert.equal(verdict([obs({ notStarted: null })]), "mixed");
  assert.equal(
    verdict([obs({ notStarted: false, conclusion: "success" })]),
    "started",
  );
});

Deno.test("dedupe: final, in flight, backoff and unsupported; shadow is absent in on", () => {
  const k = key();
  const now = T0 + 60 * 60_000;
  assert.equal(backupCiDedupe(null, k, "on", RUNNER, now), null);
  assert.equal(
    backupCiDedupe(commitFile([result(k)]), k, "on", RUNNER, now),
    "final",
  );
  assert.equal(
    backupCiDedupe(
      commitFile([result(k, { mode: "shadow" })]),
      k,
      "on",
      RUNNER,
      now,
    ),
    null,
  );
  assert.equal(
    backupCiDedupe(
      commitFile([result(k, { mode: "shadow" })]),
      k,
      "shadow",
      RUNNER,
      now,
    ),
    "final",
  );
  assert.equal(
    backupCiDedupe(commitFile([result(k)]), k, "on", RUNNER2, now),
    null,
  );
  assert.equal(
    backupCiDedupe(commitFile([dispatched()]), k, "on", RUNNER, now),
    "in_flight",
  );
  assert.equal(
    backupCiDedupe(
      commitFile([noEvidence(k, { nextAt: now + 1 })]),
      k,
      "on",
      RUNNER,
      now,
    ),
    "backoff",
  );
  assert.equal(
    backupCiDedupe(
      commitFile([noEvidence(k, { nextAt: now })]),
      k,
      "on",
      RUNNER,
      now,
    ),
    null,
  );
  assert.equal(
    backupCiDedupe(
      commitFile([
        noEvidence(k, {
          reason: "unsupported:runs_on",
          nextAt: null,
          final: true,
          legRuns: 0,
        }),
      ]),
      k,
      "on",
      RUNNER2,
      now,
    ),
    "unsupported",
  );
  assert.equal(
    backupCiDedupe(
      commitFile([result(k)]),
      key({ attempt: 2 }),
      "on",
      RUNNER,
      now,
    ),
    null,
  );
});

Deno.test("free slots: p is 1 while matrix cells run, minus queued and running legs", async () => {
  assert.deepEqual(backupCiFreeSlots(0, false), { p: 2, free: 2 });
  assert.deepEqual(backupCiFreeSlots(1, false), { p: 2, free: 1 });
  assert.deepEqual(backupCiFreeSlots(3, false), { p: 2, free: 0 });
  assert.deepEqual(backupCiFreeSlots(0, true), { p: 1, free: 1 });
  assert.deepEqual(backupCiFreeSlots(1, true), { p: 1, free: 0 });
  const responses: Record<string, unknown> = {
    "/repos/ubiquity-sentinel/sentinel/actions/workflows/backup-ci-leg.yml/runs?status=queued&per_page=1":
      { total_count: 1 },
    "/repos/ubiquity-sentinel/sentinel/actions/workflows/backup-ci-leg.yml/runs?status=in_progress&per_page=1":
      { total_count: 1 },
    "/repos/ubiquity-sentinel/sentinel/actions/workflows/supervisor.yml/runs?status=in_progress&per_page=100&page=1":
      {
        total_count: 1,
        workflow_runs: [{ id: 77 }],
      },
    "/repos/ubiquity-sentinel/sentinel/actions/runs/77/jobs?filter=latest&per_page=100&page=1":
      {
        total_count: 2,
        jobs: [{ id: 1, name: "prepare", status: "completed" }, {
          id: 2,
          name: "matrix_cell (c-1)",
          status: "queued",
        }],
      },
  };
  const api: BackupCiApiV1 = {
    get: (path) => Promise.resolve(responses[path] ?? null),
    send: () => Promise.resolve(null),
    redirected: () => Promise.resolve(null),
  };
  const legs = createBackupCiLegReads(api);
  assert.equal(await legs.inflight(), 2);
  assert.equal(await legs.cellsActive(), true);
  (responses[
    "/repos/ubiquity-sentinel/sentinel/actions/runs/77/jobs?filter=latest&per_page=100&page=1"
  ] as { jobs: { status: string }[] }).jobs[1].status = "completed";
  assert.equal(await legs.cellsActive(), false);
  delete responses[
    "/repos/ubiquity-sentinel/sentinel/actions/workflows/backup-ci-leg.yml/runs?status=queued&per_page=1"
  ];
  assert.equal(await legs.inflight(), null);
});

Deno.test("round-robin: one unit per target per round, at most p per target", () => {
  const per = new Map([
    ["ubiquity/b", ["b1", "b2", "b3"]],
    ["ubiquity/a", ["a1", "a2"]],
    ["ubiquity/c", ["c1"]],
  ]);
  assert.deepEqual(backupCiFairSelect(per, 0, 2, 2), ["a1", "b1"]);
  assert.deepEqual(backupCiFairSelect(per, 1, 2, 2), ["b1", "c1"]);
  assert.deepEqual(backupCiFairSelect(per, 2, 4, 2), ["c1", "a1", "b1", "a2"]);
  assert.deepEqual(backupCiFairSelect(per, 0, 10, 2), [
    "a1",
    "b1",
    "c1",
    "a2",
    "b2",
  ]);
  assert.deepEqual(backupCiFairSelect(per, 0, 0, 2), []);
  assert.deepEqual(
    backupCiFairSelect(new Map([["x/y", ["1", "2", "3"]]]), 0, 2, 1),
    ["1"],
  );
});
