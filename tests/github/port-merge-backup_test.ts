/**
 * The merge port over backup CI evidence (docs/backup-ci-spec.md §11.2): the
 * port's required-check judgement reads the same `readChecks` as every gate,
 * so a verified stand-in for a never-started required check lets the exact
 * head merge; an attempt that started natively refuses the stand-in; and a
 * suspension written while the merge is being prepared refuses it on the
 * re-read once the store tip's 10 s cache has expired. The real port, a
 * scripted GitHub API, and for the suspension a real temporary store remote
 * read through the production anonymous git runner. All synthetic.
 */
import assert from "node:assert/strict";
import {
  BACKUP_CI_TIP_TTL_MS,
  backupCiCalibrationPath,
  backupCiCommitPath,
  backupCiSuspensionPath,
  type BackupCiTargetV1,
} from "../../src/contracts/backup-ci.ts";
import { createBackupCiReader } from "../../src/github/backup-ci-reader.ts";
import { BoundedAnonymousGitRunner } from "../../src/host/backup-ci-compose.ts";
import {
  checkRunWire,
  checksPageWire,
  FakeClock,
  httpRespond,
  makePort,
  mergeResponseWire,
  REPO,
  type ScriptEntry,
  SHA1,
  SHA3,
  statusesPageWire,
  T0,
} from "./helpers.ts";
import {
  CHECKS_PATH,
  happyScript,
  mergeRequest,
  putCount,
  STATUSES_PATH,
  trustedService,
} from "./merge-helpers.ts";
import {
  calibration,
  commitFile,
  coverage,
  key,
  REPO_ID,
  result,
  RUNNER,
  suspension,
} from "./backup-ci-fixtures.ts";
import {
  ACTIONS,
  EARLIER,
  FakeBackupCiReader,
  neverStartedJob,
  okRead,
  PUSH_SUITE,
  RUN,
  startedJob,
  tempStore,
  workflowRun,
} from "./backup-ci-consumer-fixtures.ts";

const SLUG = `${REPO.owner}/${REPO.name}` as const;
const API = `/repos/${SLUG}`;
const TARGET: BackupCiTargetV1 = { repository: SLUG, id: REPO_ID };
const BOUND = { owner: REPO.owner, name: REPO.name, id: REPO_ID };
const CI = "ci";

const FILE = commitFile([result(key({ checkName: CI }), { commit: SHA1 })], {
  repository: BOUND,
  commit: SHA1,
  workflows: [coverage({ expected: [CI] })],
});
const CALIBRATION = { ...calibration(), repository: BOUND };

function ciRun(id: number) {
  return checkRunWire({
    id,
    name: CI,
    conclusion: "failure",
    head_sha: SHA1,
    app: ACTIONS,
    check_suite: { id: PUSH_SUITE },
    started_at: "2026-09-07T00:00:00Z",
    completed_at: "2026-09-07T00:00:01Z",
  });
}

function repeat(entry: ScriptEntry): ScriptEntry {
  return { ...entry, repeat: true };
}

/** The happy merge script, every backup listing answering repeatedly. */
function script(
  all: unknown[],
  jobs: Record<number, unknown>,
): ScriptEntry[] {
  return happyScript({
    checks: [ciRun(RUN)],
    extra: [
      repeat(
        httpRespond("GET", CHECKS_PATH, 200, checksPageWire([ciRun(RUN)])),
      ),
      repeat(httpRespond("GET", STATUSES_PATH, 200, statusesPageWire([]))),
      repeat(httpRespond(
        "GET",
        `${API}/commits/${SHA1}/check-runs?filter=all&per_page=100&page=1`,
        200,
        checksPageWire(all),
      )),
      repeat(httpRespond(
        "GET",
        `${API}/actions/runs?head_sha=${SHA1}&per_page=100&page=1`,
        200,
        {
          total_count: 1,
          workflow_runs: [workflowRun(PUSH_SUITE, "push", {}, SHA1)],
        },
      )),
      ...Object.entries(jobs).map(([id, body]) =>
        repeat(httpRespond("GET", `${API}/actions/jobs/${id}`, 200, body))
      ),
      httpRespond("PUT", `${API}/pulls/1/merge`, 200, mergeResponseWire(SHA3)),
    ],
  });
}

Deno.test("merge port backup: a stand-in for a never-started required check merges the exact head", async () => {
  const reader = new FakeBackupCiReader(
    () => okRead(FILE, { calibration: CALIBRATION }),
    [TARGET],
  );
  const { port, transport } = makePort({
    clock: new FakeClock(T0 + 200_000),
    review: trustedService(),
    script: script([ciRun(RUN)], { [RUN]: neverStartedJob(RUN, SHA1) }),
    backupCi: { mode: "on", reader, log: { once: () => {} } },
  });
  const merged = await port.mergePullRequest(mergeRequest());
  assert.ok(merged.ok, JSON.stringify(merged));
  assert.equal(merged.value.outcome, "merged", JSON.stringify(merged.value));
  assert.equal(putCount(transport), 1);
  // Without the consumer the same head is refused (its required check
  // reads as the never-started failure).
  const native = makePort({
    clock: new FakeClock(T0 + 200_000),
    review: trustedService(),
    script: script([ciRun(RUN)], { [RUN]: neverStartedJob(RUN, SHA1) }),
  });
  const refused = await native.port.mergePullRequest(mergeRequest());
  assert.ok(refused.ok);
  assert.notEqual(refused.value.outcome, "merged");
  assert.equal(putCount(native.transport), 0);
});

Deno.test("merge port backup: a natively started attempt 1 under a never-started attempt 2 refuses", async () => {
  const reader = new FakeBackupCiReader(
    () => okRead(FILE, { calibration: CALIBRATION }),
    [TARGET],
  );
  const { port, transport } = makePort({
    clock: new FakeClock(T0 + 200_000),
    review: trustedService(),
    script: script([ciRun(EARLIER), ciRun(RUN)], {
      [RUN]: neverStartedJob(RUN, SHA1),
      [EARLIER]: startedJob(EARLIER, SHA1),
    }),
    backupCi: { mode: "on", reader, log: { once: () => {} } },
  });
  const refused = await port.mergePullRequest(mergeRequest());
  assert.ok(refused.ok, JSON.stringify(refused));
  assert.notEqual(refused.value.outcome, "merged");
  assert.equal(putCount(transport), 0);
});

Deno.test("merge port backup: a suspension written after a gate read refuses the merge once the tip TTL expires", async () => {
  const store = await tempStore();
  try {
    await store.publish({
      [backupCiCommitPath(REPO.owner, REPO.name, SHA1)]: FILE,
      [backupCiCalibrationPath(REPO.owner, REPO.name)]: CALIBRATION,
    });
    const clock = new FakeClock(T0 + 200_000);
    const reader = createBackupCiReader({
      git: new BoundedAnonymousGitRunner(`${store.root}/home`, 20_000, "file"),
      scratchRoot: `${store.root}/scratch`,
      clock,
      targets: [TARGET],
      remoteUrl: store.url,
    });
    const { port, transport } = makePort({
      clock,
      review: trustedService(),
      script: script([ciRun(RUN)], { [RUN]: neverStartedJob(RUN, SHA1) }),
      backupCi: { mode: "on", reader, log: { once: () => {} } },
    });
    // The delivery gate's read: the receipt stands in.
    const gate = await port.readChecks(SHA1);
    assert.ok(gate.ok);
    assert.equal(gate.value.checks[0].conclusion, "success");
    // The ingest found a false green meanwhile: the runner is suspended.
    await store.publish({
      [backupCiSuspensionPath(REPO.owner, REPO.name)]: suspension({
        scope: SLUG,
        runnerIds: [RUNNER],
      }),
    });
    // Inside the 10 s tip cache the earlier tip still answers (accepted, B11).
    clock.advance(1_000);
    const cached = await port.readChecks(SHA1);
    assert.ok(cached.ok);
    assert.equal(cached.value.checks[0].conclusion, "success");
    // Past it, the merge port's own read sees the suspension and refuses.
    clock.advance(BACKUP_CI_TIP_TTL_MS);
    const refused = await port.mergePullRequest(mergeRequest());
    assert.ok(refused.ok, JSON.stringify(refused));
    assert.notEqual(refused.value.outcome, "merged");
    assert.equal(putCount(transport), 0);
  } finally {
    await store.close();
  }
});
