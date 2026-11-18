/**
 * Automatic backup CI enrolment (2026-11-17): a targets row with `id: null`
 * is enrolled once, on demand, from the target's own repository read (exact
 * full name, public), pinned in the store, and read from the pin ever after
 * (review MUST 3, SHOULD 5); the supervisor-side stand-in rule binds the
 * same id. Fake reads and store only.
 */
import assert from "node:assert/strict";
import {
  backupCiCalibrationPath,
  type BackupCiTargetV1,
  parseBackupCiTargets,
} from "../../src/contracts/backup-ci.ts";
import { backupCiEnrolmentPath } from "../../src/contracts/backup-ci-trust.ts";
import { selectBackupStandIns } from "../../src/github/backup-ci-substitute.ts";
import {
  enrolBackupCiTarget,
  pinnedBackupCiTargets,
} from "../../ops/backup-ci-enrol.ts";
import type { BackupCiTargetReadsV1 } from "../../ops/backup-ci-plan-reads.ts";
import {
  calibration,
  CHECK,
  checkCalibration,
  checkDefinitions,
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
  over: { private?: boolean; fullName?: string | null } = {},
): BackupCiTargetReadsV1 {
  return {
    repository: () =>
      Promise.resolve(
        id === null ? null : {
          id,
          defaultBranch: "main",
          private: over.private ?? false,
          ...(over.fullName === null
            ? {}
            : { fullName: over.fullName ?? REPO }),
        },
      ),
  } as unknown as BackupCiTargetReadsV1;
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

Deno.test("pins come from the store only: no read for a committed or pinned row", async () => {
  const lines: string[] = [];
  const pin = {
    version: 1,
    kind: "sentinel_backup_ci_enrolment",
    repository: { owner: OWNER, name: NAME, id: REPO_ID },
    enrolledAt: T0,
  };
  const out = await pinnedBackupCiTargets(
    store({ [backupCiEnrolmentPath(OWNER, NAME)]: pin }),
    [ENROLLED, { repository: "ubiquity/other", id: 7 }, {
      repository: "ubiquity/new",
      id: null,
    }],
    (line) => lines.push(line),
  );
  assert.deepEqual(out.pinned, [
    { repository: REPO, id: REPO_ID },
    { repository: "ubiquity/other", id: 7 },
  ]);
  assert.deepEqual(out.unpinned, [{ repository: "ubiquity/new", id: null }]);
  // A pin of another repository skips the row with a closed code.
  const wrong = await pinnedBackupCiTargets(
    store({
      [backupCiEnrolmentPath(OWNER, NAME)]: {
        ...pin,
        repository: { owner: OWNER, name: "other", id: 1 },
      },
    }),
    [ENROLLED],
    (line) => lines.push(line),
  );
  assert.deepEqual(wrong, { pinned: [], unpinned: [] });
  assert.deepEqual(lines, [`backup-ci:${REPO}:enrol:pin_invalid`]);
});

Deno.test("first enrolment needs the exact full name and a public repository", async () => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  assert.deepEqual(
    await enrolBackupCiTarget(ENROLLED, reads(REPO_ID), store({}), log),
    { repository: REPO, id: REPO_ID },
  );
  // A renamed or transferred repository answers under another name.
  assert.equal(
    await enrolBackupCiTarget(
      ENROLLED,
      reads(REPO_ID, { fullName: "ubiquity/renamed" }),
      store({}),
      log,
    ),
    null,
  );
  // Backup legs publish the tree and logs publicly: no private repository.
  assert.equal(
    await enrolBackupCiTarget(
      ENROLLED,
      reads(REPO_ID, { private: true }),
      store({}),
      log,
    ),
    null,
  );
  assert.equal(
    await enrolBackupCiTarget(
      ENROLLED,
      reads(REPO_ID, { fullName: null }),
      store({}),
      log,
    ),
    null,
  );
  assert.equal(
    await enrolBackupCiTarget(ENROLLED, reads(null), store({}), log),
    null,
  );
  // A calibration of another id refuses.
  assert.equal(
    await enrolBackupCiTarget(
      ENROLLED,
      reads(REPO_ID + 1),
      store({ [backupCiCalibrationPath(OWNER, NAME)]: calibration() }),
      log,
    ),
    null,
  );
  assert.deepEqual(lines, [
    `backup-ci:${REPO}:enrol:renamed`,
    `backup-ci:${REPO}:enrol:private_repository`,
    `backup-ci:${REPO}:enrol:unverified_name`,
    `backup-ci:${REPO}:enrol:repository_unavailable`,
    `backup-ci:${REPO}:unsupported:repository_id`,
  ]);
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
    definitions: checkDefinitions(),
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
