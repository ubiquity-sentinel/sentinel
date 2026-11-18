/**
 * 2026-11-18 review: a stand-in counts only for a receipt of this launcher's
 * runner (its pins and leg revision), so reverting a leg revision leaves the
 * newer runner's receipts inert by code. Fakes only.
 */
import assert from "node:assert/strict";
import {
  backupCiRunnerId,
  parseBackupCiPins,
} from "../../ops/backup-ci-act.ts";
import { BACKUP_CI_CURRENT_RUNNER_ID } from "../../src/github/backup-ci-runner.ts";
import {
  type BackupCiSelectInputV1,
  selectBackupStandIns,
} from "../../src/github/backup-ci-substitute.ts";
import {
  calibration,
  CHECK,
  checkCalibration,
  checkDefinitions,
  commitFile,
  H,
  result,
  RUNNER,
  RUNNER2,
  T0,
  TARGET,
  WORKFLOW,
} from "../github/backup-ci-fixtures.ts";

Deno.test("the supervisor's current runner is the one the trusted pass plans with", async () => {
  const pins = parseBackupCiPins(
    JSON.parse(await Deno.readTextFile("ops/backup-ci-pins.json")),
  );
  assert(pins !== null);
  assert.equal(BACKUP_CI_CURRENT_RUNNER_ID, backupCiRunnerId(pins));
});

function input(currentRunnerId?: string | null): BackupCiSelectInputV1 {
  const latest = [{
    checkRunId: 102,
    name: CHECK,
    app: "github-actions",
    suiteId: 11,
    status: "completed",
    conclusion: "failure",
    startedAt: T0,
    completedAt: T0 + 1,
    notStarted: true,
  }];
  return {
    target: TARGET,
    commit: H,
    mode: "on",
    latest,
    all: latest,
    suites: [{ suiteId: 11, workflowPath: WORKFLOW, event: "push" }],
    statusContexts: new Set<string>(),
    file: commitFile([result()]),
    suspensions: [],
    calibration: calibration(),
    checks: checkCalibration(),
    definitions: checkDefinitions(),
    excluded: { all: false, runnerIds: [] },
    ...(currentRunnerId === undefined ? {} : { currentRunnerId }),
  };
}

Deno.test("only the current runner's calibrated receipt stands in", () => {
  // The receipt's runner is this launcher's runner: it stands in.
  assert.deepEqual([...selectBackupStandIns(input(RUNNER)).standIns.keys()], [
    102,
  ]);
  // A reverted leg revision makes another runner current: the receipt is
  // inert, with a closed refusal, though it is calibrated and not excluded.
  const reverted = selectBackupStandIns(input(RUNNER2));
  assert.equal(reverted.standIns.size, 0);
  assert.deepEqual(reverted.refusals, [`runner_retired:${CHECK}`]);
  // Pins that do not parse: no runner is current, nothing stands in.
  assert.equal(selectBackupStandIns(input(null)).standIns.size, 0);
  // Older test inputs without the field keep their meaning.
  assert.equal(selectBackupStandIns(input()).standIns.size, 1);
});
