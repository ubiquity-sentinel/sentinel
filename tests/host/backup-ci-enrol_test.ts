/**
 * Automatic backup CI enrolment (2026-11-17): a targets row with `id: null`
 * is resolved from the target's own repository read and bound to the store's
 * calibration file; the supervisor-side stand-in rule binds the same pinned
 * id. Fake reads and store only.
 */
import assert from "node:assert/strict";
import {
  backupCiCalibrationPath,
  type BackupCiTargetV1,
  parseBackupCiTargets,
} from "../../src/contracts/backup-ci.ts";
import { selectBackupStandIns } from "../../src/github/backup-ci-substitute.ts";
import { resolveBackupCiTargets } from "../../ops/backup-ci-enrol.ts";
import type { BackupCiTargetReadsV1 } from "../../ops/backup-ci-plan-reads.ts";
import {
  calibration,
  CHECK,
  checkCalibration,
  commitFile,
  H,
  NAME,
  OWNER,
  REPO,
  REPO_ID,
  result,
  T0,
  WORKFLOW,
} from "../github/backup-ci-fixtures.ts";

const ENROLLED: BackupCiTargetV1 = { repository: REPO, id: null };

function reads(
  id: number | null,
): (o: string, n: string) => BackupCiTargetReadsV1 {
  return () =>
    ({
      repository: () =>
        Promise.resolve(
          id === null ? null : { id, defaultBranch: "main", private: false },
        ),
    }) as unknown as BackupCiTargetReadsV1;
}

function store(files: Record<string, unknown>) {
  return { read: (path: string) => Promise.resolve(files[path] ?? null) };
}

Deno.test("a null id row parses; a missing id key still refuses", () => {
  assert.deepEqual(parseBackupCiTargets([{ repository: REPO, id: null }]), [
    ENROLLED,
  ]);
  assert.throws(() => parseBackupCiTargets([{ repository: REPO }]));
  assert.throws(() =>
    parseBackupCiTargets(
      Array.from(
        { length: 65 },
        (_, i) => ({ repository: `o/r${i}`, id: i + 1 }),
      ),
    )
  );
});

Deno.test("an enrolled row takes the target's own id before any calibration", async () => {
  const lines: string[] = [];
  const resolved = await resolveBackupCiTargets({
    targets: [ENROLLED, { repository: "ubiquity/other", id: 7 }],
    store: store({}),
    targetReads: reads(REPO_ID),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(resolved, [
    { repository: REPO, id: REPO_ID },
    { repository: "ubiquity/other", id: 7 },
  ]);
  assert.deepEqual(lines, []);
});

Deno.test("a calibration pinned to another id refuses the enrolled row", async () => {
  const lines: string[] = [];
  const pinned = calibration();
  const resolved = await resolveBackupCiTargets({
    targets: [ENROLLED],
    store: store({ [backupCiCalibrationPath(OWNER, NAME)]: pinned }),
    targetReads: reads(REPO_ID + 1),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(resolved, []);
  assert.deepEqual(lines, [`backup-ci:${REPO}:unsupported:repository_id`]);
  const same = await resolveBackupCiTargets({
    targets: [ENROLLED],
    store: store({ [backupCiCalibrationPath(OWNER, NAME)]: pinned }),
    targetReads: reads(REPO_ID),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(same, [{ repository: REPO, id: REPO_ID }]);
});

Deno.test("an unreadable enrolled target is skipped with a closed code", async () => {
  const lines: string[] = [];
  const resolved = await resolveBackupCiTargets({
    targets: [ENROLLED],
    store: store({}),
    targetReads: reads(null),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(resolved, []);
  assert.deepEqual(lines, [`backup-ci:${REPO}:enrol:repository_unavailable`]);
});

Deno.test("the stand-in rule binds an enrolled row to its calibration's id", () => {
  const base = {
    target: ENROLLED,
    commit: H,
    mode: "on" as const,
    latest: [{
      checkRunId: 102,
      name: CHECK,
      app: "github-actions",
      suiteId: 11,
      status: "completed",
      conclusion: "failure",
      startedAt: T0,
      completedAt: T0 + 1,
      notStarted: true,
    }],
    suites: [{ suiteId: 11, workflowPath: WORKFLOW, event: "push" }],
    statusContexts: new Set<string>(),
    file: commitFile([result()]),
    suspensions: [],
    checks: checkCalibration(),
    excluded: { all: false, runnerIds: [] },
  };
  const bound = selectBackupStandIns({
    ...base,
    all: base.latest,
    calibration: calibration(),
  });
  assert.deepEqual([...bound.standIns.keys()], [102]);
  const unpinned = selectBackupStandIns({
    ...base,
    all: base.latest,
    calibration: null,
  });
  assert.deepEqual(unpinned.refusals, ["binding:file"]);
  assert.equal(unpinned.standIns.size, 0);
  const other = selectBackupStandIns({
    ...base,
    all: base.latest,
    file: commitFile([result()], {
      repository: { owner: OWNER, name: NAME, id: REPO_ID + 1 },
    }),
    calibration: calibration(),
  });
  assert.deepEqual(other.refusals, ["binding:file"]);
});
