/**
 * The closed cause of an `unresolved` backup refusal (`unresolvedBackupCode`)
 * and the target's runner state (`backupRunnerState`), reported beside the
 * unchanged `refusals` of the `sentinel_backup_ci_refused` line. Advisory
 * only: no stand-in, refusal or verdict changes. The first case is the live
 * Passport shape of 2026-11-17 (head fe7f6b75, PR context): a final
 * `unsupported:checkout_inputs` entry and the only runner suspended for a
 * false green, which logged only `unresolved:deno`. All synthetic.
 */
import assert from "node:assert/strict";
import {
  type BackupCiObservationV1,
  type BackupCiSelectInputV1,
  backupRunnerState,
  selectBackupStandIns,
} from "../../src/github/backup-ci-substitute.ts";
import {
  createBackupCiLog,
  reportBackupCiSelection,
} from "../../src/github/backup-ci-observations.ts";
import {
  calibration,
  CHECK,
  commitFile,
  dispatched,
  H,
  key,
  noEvidence,
  OTHER,
  REPO,
  result,
  RUNNER,
  RUNNER2,
  suspension,
  T0,
  TARGET,
  WORKFLOW,
} from "./backup-ci-fixtures.ts";

const PUSH_SUITE = 11;
const PR_SUITE = 12;
const SUITES = [
  { suiteId: PUSH_SUITE, workflowPath: WORKFLOW, event: "push" },
  { suiteId: PR_SUITE, workflowPath: WORKFLOW, event: "pull_request" },
];
const PR = key({ context: "pull_request" });

function obs(
  checkRunId: number,
  suiteId = PUSH_SUITE,
): BackupCiObservationV1 {
  return {
    checkRunId,
    name: CHECK,
    app: "github-actions",
    suiteId,
    status: "completed",
    conclusion: "failure",
    startedAt: T0 + checkRunId,
    completedAt: T0 + checkRunId + 1_000,
    notStarted: true,
  };
}

/** A never-started push observation, calibrated runner, mode `on`. */
function input(
  over: Partial<BackupCiSelectInputV1> = {},
): BackupCiSelectInputV1 {
  return {
    target: TARGET,
    commit: H,
    mode: "on",
    latest: [obs(102)],
    all: [obs(101), obs(102)],
    suites: SUITES,
    statusContexts: new Set(),
    file: commitFile([result()]),
    suspensions: [],
    calibration: calibration(),
    ...over,
  };
}

const prObservations = {
  latest: [obs(102, PR_SUITE)],
  all: [obs(101, PR_SUITE), obs(102, PR_SUITE)],
};

/** The selection's [refusals, unresolved, runner]. */
function detail(i: BackupCiSelectInputV1): [string[], string[], string] {
  const s = selectBackupStandIns(i);
  return [s.refusals, s.unresolved, s.runner];
}

Deno.test("the live Passport refusal names its checkout refusal and suspension", () => {
  const live = input({
    ...prObservations,
    file: commitFile([
      noEvidence(PR, {
        reason: "unsupported:checkout_inputs",
        final: true,
        nextAt: null,
        legRuns: 0,
      }),
    ]),
    calibration: calibration([{ runnerId: RUNNER, falseGreens: 1 }]),
    suspensions: [suspension()],
  });
  const selection = selectBackupStandIns(live);
  assert.equal(selection.standIns.size, 0);
  assert.deepEqual(detail(live), [
    ["unresolved:deno"],
    ["no_evidence.unsupported.checkout_inputs:deno"],
    "suspended",
  ]);
});

Deno.test("each unresolved cause has its own closed code", () => {
  const cases: [string, Partial<BackupCiSelectInputV1>][] = [
    ["missing", { file: commitFile([]) }],
    ["in_flight", { file: commitFile([dispatched()]) }],
    ["no_evidence.leg_failed", { file: commitFile([noEvidence()]) }],
    [
      "suspended",
      { suspensions: [suspension({ reason: "false_red" })] },
    ],
    [
      "uncalibrated",
      { file: commitFile([result(key(), { runnerId: RUNNER2 })]) },
    ],
    [
      "workflow_blob",
      { file: commitFile([result(key(), { blob: OTHER })]) },
    ],
    [
      "confirming",
      { file: commitFile([result(key(), { conclusion: "failure" })]) },
    ],
    ["context", { ...prObservations, file: commitFile([result()]) }],
  ];
  for (const [code, over] of cases) {
    const [refusals, unresolved] = detail(input(over));
    assert.deepEqual([refusals, unresolved], [
      ["unresolved:deno"],
      [`${code}:deno`],
    ], code);
  }
});

Deno.test("a resolved stand-in and every other refusal add no detail", () => {
  assert.deepEqual(detail(input()), [[], [], "calibrated"]);
  const started = input({
    latest: [{ ...obs(102), notStarted: false }],
    all: [obs(101), { ...obs(102), notStarted: false }],
  });
  assert.deepEqual(detail(started), [["started:deno"], [], "calibrated"]);
});

Deno.test("the runner state reads calibration rows and suspensions", () => {
  assert.equal(backupRunnerState(null, [], REPO), "uncalibrated");
  assert.equal(backupRunnerState(calibration(), [], REPO), "calibrated");
  assert.equal(
    backupRunnerState(
      calibration([{ runnerId: RUNNER, agreements: 4 }]),
      [],
      REPO,
    ),
    "uncalibrated",
  );
  assert.equal(
    backupRunnerState(calibration(), [suspension()], REPO),
    "suspended",
  );
  // One calibrated, unsuspended runner is enough.
  assert.equal(
    backupRunnerState(
      calibration([{ runnerId: RUNNER }, { runnerId: RUNNER2 }]),
      [suspension()],
      REPO,
    ),
    "calibrated",
  );
  assert.equal(
    backupRunnerState(calibration(), [suspension({ scope: "o/other" })], REPO),
    "calibrated",
  );
});

Deno.test("the refused line keeps refusals and adds the closed detail", () => {
  const lines: string[] = [];
  const log = createBackupCiLog((line) => lines.push(line));
  const report = (i: BackupCiSelectInputV1) =>
    reportBackupCiSelection(
      log,
      TARGET,
      H,
      {
        selection: selectBackupStandIns(i),
      } as Parameters<typeof reportBackupCiSelection>[3],
      "on",
    );
  report(input({ file: commitFile([]) }));
  report(input({
    latest: [{ ...obs(102), app: "other" }],
    all: [obs(101), { ...obs(102), app: "other" }],
  }));
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [
    {
      kind: "sentinel_backup_ci_refused",
      repo: REPO,
      commit12: H.slice(0, 12),
      refusals: ["unresolved:deno"],
      unresolved: ["missing:deno"],
      runner: "calibrated",
    },
    {
      kind: "sentinel_backup_ci_refused",
      repo: REPO,
      commit12: H.slice(0, 12),
      refusals: ["other_app:deno"],
    },
  ]);
});
