/**
 * Automatic calibration commits (2026-11-17): sampled from the target's own
 * completed push runs once a record needed a stand-in, a red first, visited
 * or settled commits skipped, bounded per day, and idle, unusable or
 * reasoned otherwise. The calibration bar itself is unchanged. Fakes only.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BackupCiCommitFileV1 } from "../../src/contracts/backup-ci.ts";
import {
  BACKUP_CI_CALIBRATION_DISCOVERY,
  backupCiCalibrationLegsToday,
  sampleBackupCiCalibration,
  selectBackupCiCalibrationCommits,
} from "../../ops/backup-ci-calibrate.ts";
import {
  calibration,
  commitFile,
  dispatched,
  result,
  RUNNER,
  T0,
} from "../github/backup-ci-fixtures.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0") as GitSha;
const run = (n: number, conclusion: string) => ({
  headSha: sha(n),
  conclusion,
});

Deno.test("selection puts the newest red first and needs a red", () => {
  const runs = [
    run(1, "success"),
    run(2, "failure"),
    run(3, "cancelled"),
    run(4, "success"),
    run(2, "success"),
    run(5, "failure"),
    run(6, "success"),
    run(7, "success"),
    run(8, "success"),
    run(9, "success"),
    run(10, "failure"),
  ];
  assert.deepEqual(selectBackupCiCalibrationCommits(runs), {
    commits: [2, 1, 4, 6, 5, 7, 8, 9].map(sha),
    reason: null,
  });
  assert.deepEqual(
    selectBackupCiCalibrationCommits([run(1, "success")]).reason,
    "no_native_red",
  );
  assert.deepEqual(
    selectBackupCiCalibrationCommits([run(1, "cancelled")]).reason,
    "no_native_history",
  );
  // A dropped (visited never-started) red does not block the next red.
  assert.deepEqual(
    selectBackupCiCalibrationCommits(runs, (c) => c === sha(2)).commits[0],
    sha(5),
  );
});

function input(over: Partial<Parameters<typeof sampleBackupCiCalibration>[0]>) {
  return {
    calibration: null,
    runnerId: RUNNER,
    demand: true,
    defaultBranch: "main",
    pushRuns: () =>
      Promise.resolve([
        run(1, "success"),
        run(2, "failure"),
        run(3, "success"),
      ]),
    file: () => Promise.resolve(null),
    now: T0,
    ...over,
  };
}

Deno.test("sampling is idle without demand and stops for a calibrated or unusable runner", async () => {
  let listed = 0;
  const pushRuns = () => {
    listed++;
    return Promise.resolve([run(2, "failure")]);
  };
  assert.deepEqual(
    await sampleBackupCiCalibration(input({ demand: false, pushRuns })),
    { commits: [], reason: "idle" },
  );
  assert.deepEqual(
    await sampleBackupCiCalibration(
      input({ calibration: calibration(), pushRuns }),
    ),
    { commits: [], reason: "calibrated" },
  );
  // A false green can never be calibrated away: no legs are spent on it.
  assert.deepEqual(
    await sampleBackupCiCalibration(input({
      calibration: calibration([{ runnerId: RUNNER, falseGreens: 1 }]),
      pushRuns,
    })),
    { commits: [], reason: "unusable" },
  );
  assert.equal(listed, 0);
  assert.deepEqual(
    await sampleBackupCiCalibration(input({ pushRuns: undefined })),
    { commits: [], reason: "idle" },
  );
  assert.deepEqual(
    await sampleBackupCiCalibration(
      input({ pushRuns: () => Promise.resolve(null) }),
    ),
    { commits: [], reason: "unreadable" },
  );
});

Deno.test("sampling skips visited and settled commits and keeps in-flight ones", async () => {
  const files = new Map<GitSha, BackupCiCommitFileV1>([
    [sha(2), commitFile([], { commit: sha(2) })],
    [sha(1), commitFile([result()], { commit: sha(1) })],
    [sha(3), commitFile([dispatched()], { commit: sha(3) })],
  ]);
  const out = await sampleBackupCiCalibration(input({
    pushRuns: () =>
      Promise.resolve([
        run(1, "success"),
        run(2, "failure"),
        run(3, "success"),
        run(4, "failure"),
      ]),
    file: (c) => Promise.resolve(files.get(c) ?? null),
  }));
  assert.deepEqual(out, { commits: [sha(4), sha(3)], reason: "sampling" });
});

Deno.test("calibration legs are capped per runner per day", async () => {
  const legs = Array.from(
    { length: BACKUP_CI_CALIBRATION_DISCOVERY.legsPerDay },
    (_, i) =>
      commitFile([{ ...result(), purpose: "calibration" as const }], {
        commit: sha(i + 1),
      }),
  );
  assert.equal(
    backupCiCalibrationLegsToday(legs, RUNNER, T0 + 3_600_000),
    BACKUP_CI_CALIBRATION_DISCOVERY.legsPerDay,
  );
  assert.equal(
    backupCiCalibrationLegsToday(legs, RUNNER, T0 + 48 * 3_600_000),
    0,
  );
  const capped = await sampleBackupCiCalibration(input({
    pushRuns: () =>
      Promise.resolve([
        ...legs.map((f) => ({ headSha: f.commit, conclusion: "failure" })),
        run(99, "failure"),
      ]),
    file: (c) => Promise.resolve(legs.find((f) => f.commit === c) ?? null),
    now: T0 + 3_600_000,
  }));
  assert.deepEqual(capped, { commits: [], reason: "daily_cap" });
});
