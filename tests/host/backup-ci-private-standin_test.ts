/**
 * Owner decision 2026-11-18, "no private repos": a private repository's CI
 * evidence comes only from its own CI. The supervisor's stand-in read (the
 * shared `selectBackupCiForCommit`, which the runtime check read uses too)
 * substitutes nothing for a target whose own workflow-run listing does not
 * show it public, even when the store holds a verified, calibrated receipt
 * for the commit (Passport keeps hundreds of such old receipts). The
 * never-started run stays marked: no evidence, its PR waits, never red.
 * Synthetic wire values only.
 */
import assert from "node:assert/strict";
import {
  SENTINEL_BACKUP_FIELD,
  SENTINEL_NEVER_STARTED_FIELD,
  substituteBackupRuns,
} from "../../ops/hosted-autonomy-backup-ci-read.ts";
import { commitFile, H, key, result } from "../github/backup-ci-fixtures.ts";
import {
  consumer,
  FakeBackupCiReader,
  neverStartedJob,
  okRead,
  PUSH_SUITE,
  rawRun,
  REPOSITORY,
  RUN,
  workflowRun,
} from "../github/backup-ci-consumer-fixtures.ts";

/** The target's run listing: one run per `repository` value (undefined: absent). */
function surface(repositories: unknown[]) {
  // An old, verified and calibrated receipt of the never-started check.
  const reader = new FakeBackupCiReader(() =>
    okRead(commitFile([result(key())]))
  );
  const { backupCi, lines } = consumer("on", reader);
  const runs = repositories.map((repository) => {
    const run = workflowRun(PUSH_SUITE, "push");
    if (repository === undefined) delete run.repository;
    else run.repository = repository;
    return run;
  });
  return {
    lines,
    ctx: {
      backupCi,
      repository: REPOSITORY,
      listAll: () => Promise.resolve([rawRun(RUN)]),
      listRuns: () => Promise.resolve(runs),
      listStatuses: () => Promise.resolve([]),
      readJob: (id: number) =>
        Promise.resolve(id === RUN ? neverStartedJob(RUN) : null),
      verdicts: new Map<string, boolean>(),
    },
  };
}

const PUBLIC = { full_name: "ubiquity/passport.ubq.fi", private: false };
const PRIVATE = { full_name: "ubiquity/passport.ubq.fi", private: true };

Deno.test("a public target's verified receipt still stands in", async () => {
  const { ctx, lines } = surface([PUBLIC]);
  const [run] = await substituteBackupRuns(ctx, H, [rawRun(RUN)]);
  assert.notEqual(run[SENTINEL_BACKUP_FIELD], undefined);
  assert.equal(run.conclusion, "success");
  assert.equal(JSON.parse(lines[0]).kind, "sentinel_backup_ci_standin");
});

Deno.test("an old receipt of a private target stands in for nothing (closed reason)", async () => {
  const { ctx, lines } = surface([PRIVATE]);
  const [run] = await substituteBackupRuns(ctx, H, [rawRun(RUN)]);
  assert.equal(run[SENTINEL_BACKUP_FIELD], undefined);
  assert.equal(run[SENTINEL_NEVER_STARTED_FIELD], true);
  assert.equal(run.conclusion, "failure");
  const refused = lines.map((line) => JSON.parse(line));
  assert.deepEqual(refused.map((line) => line.kind), [
    "sentinel_backup_ci_refused",
  ]);
  assert.deepEqual(refused[0].refusals, ["private_repository"]);
});

Deno.test("a visibility the listing does not prove public refuses every stand-in", async () => {
  const cases: [string, unknown[], string][] = [
    ["absent", [undefined], "visibility_unknown"],
    ["not a boolean", [{ ...PUBLIC, private: "false" }], "visibility_unknown"],
    ["one run unproven", [PUBLIC, undefined], "visibility_unknown"],
    ["one run private", [PUBLIC, PRIVATE], "private_repository"],
  ];
  for (const [label, repositories, reason] of cases) {
    const { ctx, lines } = surface(repositories);
    const [run] = await substituteBackupRuns(ctx, H, [rawRun(RUN)]);
    assert.equal(run[SENTINEL_BACKUP_FIELD], undefined, label);
    assert.equal(run[SENTINEL_NEVER_STARTED_FIELD], true, label);
    assert.deepEqual(JSON.parse(lines[0]).refusals, [reason], label);
  }
});
