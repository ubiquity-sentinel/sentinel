/**
 * The false-green diagnosis probe (2026-11-17 review): while a runner is
 * excluded, the pass re-reads the native run of its suspension's evidence
 * and logs closed facts only (event, start, conclusion, failing step number,
 * merge base against the leg's base). Fakes only.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  backupCiCommitPath,
  backupCiReceiptId,
  backupCiSuspensionPath,
} from "../../src/contracts/backup-ci.ts";
import { backupCiStoreChanges } from "../../ops/backup-ci-dispatch.ts";
import { runBackupCiPass } from "../../ops/backup-ci-pass.ts";
import {
  backupCiProbePath,
  parseBackupCiProbeRecord,
  probeBackupCiFalseGreen,
} from "../../ops/backup-ci-probe.ts";
import type { BackupCiTargetReadsV1 } from "../../ops/backup-ci-plan-reads.ts";
import type { BackupCiStoreView } from "../../ops/backup-ci-store-writer.ts";
import {
  B,
  CHECK,
  commitFile,
  H,
  key,
  NAME,
  OWNER,
  REPO,
  REPO_ID,
  result,
  RUNNER,
  suspension,
  T0,
} from "../github/backup-ci-fixtures.ts";
import { passDeps, passWorld } from "./backup-ci-pass-fakes.ts";

const OTHER_BASE = "c".repeat(40) as GitSha;
const PR_KEY = key({ context: "pull_request" });
const RECEIPT = backupCiReceiptId(REPO, H, PR_KEY);

function evidence() {
  return suspension({
    evidence: {
      commit: H,
      checkName: CHECK,
      nativeCheckRunId: 501,
      receipt: RECEIPT,
    },
  });
}

function reads(log: string | null): BackupCiTargetReadsV1 {
  return {
    checkRuns: () =>
      Promise.resolve([{ id: 501, name: CHECK, check_suite: { id: 12 } }]),
    suites: () =>
      Promise.resolve([{
        suiteId: 12,
        runId: 13,
        workflowPath: ".github/workflows/ci.yml",
        event: "pull_request",
      }]),
    job: () =>
      Promise.resolve({
        id: 501,
        head_sha: H,
        status: "completed",
        conclusion: "failure",
        runner_id: 4,
        steps: [
          { name: "Set up job", number: 1, conclusion: "success" },
          { name: "Run actions/checkout@v4", number: 2, conclusion: "success" },
          { name: "Run deno test", number: 3, conclusion: "failure" },
        ],
      }),
    jobLogPrefix: () => Promise.resolve(log),
  } as unknown as BackupCiTargetReadsV1;
}

const LOG = [
  "##[group]Run actions/checkout@v4",
  `HEAD is now at 1a2b3c4 Merge ${H} into ${OTHER_BASE}`,
  "##[group]Run deno test",
].join("\n");

Deno.test("the probe logs the native event, step and merge base against the leg's", async () => {
  const line = await probeBackupCiFalseGreen({
    repository: REPO,
    suspension: evidence(),
    file: commitFile([result(PR_KEY)]),
    reads: reads(LOG),
  });
  assert.equal(
    line,
    `sentinel_backup_ci_false_green_probe ${
      JSON.stringify({
        receipt: RECEIPT,
        legContext: "pull_request",
        nativeEvent: "pull_request",
        nativeStarted: true,
        nativeConclusion: "failure",
        nativeFailingStep: 3,
        legBase12: B.slice(0, 12),
        nativeBase12: OTHER_BASE.slice(0, 12),
        sameBase: false,
        // Version 2: no other run of the check on the commit.
        pullRequestRuns: [],
      })
    }`,
  );
  // An unreadable log leaves the base unknown, never guessed.
  const unknown = await probeBackupCiFalseGreen({
    repository: REPO,
    suspension: evidence(),
    file: commitFile([result(PR_KEY)]),
    reads: reads(null),
  });
  assert.match(unknown!, /"nativeBase12":null,"sameBase":null/);
  // A suspension without evidence, or not a false green, is not probed.
  assert.equal(
    await probeBackupCiFalseGreen({
      repository: REPO,
      suspension: suspension(),
      file: null,
      reads: reads(LOG),
    }),
    null,
  );
});

Deno.test("an excluded runner's pass probes its false green once", async () => {
  const world = passWorld();
  world.store.set(backupCiSuspensionPath(OWNER, NAME), evidence());
  world.store.set(
    backupCiCommitPath(OWNER, NAME, H),
    commitFile([result(PR_KEY)]),
  );
  await runBackupCiPass(
    passDeps(world, [{ repository: REPO, id: REPO_ID }], {
      targetReads: () => reads(LOG),
    }),
  );
  const probes = world.lines.filter((l) =>
    l.startsWith("sentinel_backup_ci_false_green_probe ")
  );
  assert.equal(probes.length, 1);
  assert.match(probes[0], /"sameBase":false/);
  assert(
    world.lines.includes(
      `sentinel_backup_ci_runner ${
        JSON.stringify({ runnerId: RUNNER, state: "excluded" })
      }`,
    ),
  );
});

function storeView(store: Map<string, unknown>): BackupCiStoreView {
  return {
    read: (path: string) => Promise.resolve(store.get(path) ?? null),
  } as unknown as BackupCiStoreView;
}

Deno.test("a complete probe answer is remembered and never re-read", async () => {
  const world = passWorld();
  world.store.set(backupCiSuspensionPath(OWNER, NAME), evidence());
  world.store.set(
    backupCiCommitPath(OWNER, NAME, H),
    commitFile([result(PR_KEY)]),
  );
  let targetReads = 0;
  const first = await runBackupCiPass(
    passDeps(world, [{ repository: REPO, id: REPO_ID }], {
      targetReads: () => {
        targetReads++;
        return reads(LOG);
      },
    }),
  );
  assert.equal(targetReads, 1);
  assert.equal(first.probes?.length, 1);
  const record = first.probes![0].record;
  assert.equal(record.nativeCheckRunId, 501);
  assert.equal(record.facts.receipt, RECEIPT);
  assert.equal(record.facts.sameBase, false);
  // The commit step keeps it (a new file, once per evidence receipt).
  const path = backupCiProbePath(OWNER, NAME);
  const changes = await backupCiStoreChanges(
    first,
    [],
    [],
    storeView(world.store),
    T0,
    () => {},
  );
  assert.deepEqual(parseBackupCiProbeRecord(changes.get(path)), record);
  world.store.set(path, changes.get(path));
  const again = await backupCiStoreChanges(
    first,
    [],
    [],
    storeView(world.store),
    T0,
    () => {},
  );
  assert.equal(again.has(path), false, "an unchanged answer is not rewritten");
  // Every later pass logs the same line from the store, no target read.
  const before = world.lines.length;
  const second = await runBackupCiPass(
    passDeps(world, [{ repository: REPO, id: REPO_ID }], {
      targetReads: () => {
        throw new Error("a remembered probe reads no target");
      },
    }),
  );
  assert.deepEqual(second.probes, []);
  const probe = (lines: string[]) =>
    lines.filter((l) => l.startsWith("sentinel_backup_ci_false_green_probe "));
  const later = world.lines.slice(before);
  assert.equal(probe(later).length, 1);
  assert.equal(probe(later)[0], probe(world.lines)[0]);
  assert(later.includes("backup-ci:probe:remembered"));
});

Deno.test("an incomplete probe answer is logged but not remembered", async () => {
  const world = passWorld();
  world.store.set(backupCiSuspensionPath(OWNER, NAME), evidence());
  const pass = await runBackupCiPass(
    passDeps(world, [{ repository: REPO, id: REPO_ID }], {
      targetReads: () =>
        ({
          ...reads(LOG),
          job: () => Promise.resolve(null),
        }) as unknown as BackupCiTargetReadsV1,
    }),
  );
  assert.deepEqual(pass.probes, []);
  assert(
    world.lines.some((l) => l.includes('"nativeStarted":null')),
    world.lines.join("\n"),
  );
});

/**
 * Version 2 (2026-11-18): the evidence run is a push run; the same check also
 * ran for the pull request (once failing at step 9 against base B, once a
 * billing stop that never started) and once in another workflow's suite.
 */
function pushEvidenceReads(calls: string[]): BackupCiTargetReadsV1 {
  const job = (id: number, conclusion: string, started: boolean) => ({
    id,
    head_sha: H,
    status: "completed",
    conclusion,
    runner_id: started ? 4 : 0,
    steps: started
      ? [
        { name: "Set up job", number: 1, conclusion: "success" },
        { name: "Run deno test", number: 9, conclusion: conclusion },
      ]
      : [],
  });
  const jobs = new Map<number, unknown>([
    [501, job(501, "failure", true)],
    [601, job(601, "failure", true)],
    [602, job(602, "failure", false)],
  ]);
  return {
    checkRuns: () => {
      calls.push("checkRuns");
      return Promise.resolve([
        { id: 501, name: CHECK, check_suite: { id: 12 } },
        { id: 602, name: CHECK, check_suite: { id: 14 } },
        { id: 601, name: CHECK, check_suite: { id: 14 } },
        { id: 603, name: "lint", check_suite: { id: 14 } },
      ]);
    },
    suites: () =>
      Promise.resolve([
        {
          suiteId: 12,
          runId: 13,
          workflowPath: ".github/workflows/ci.yml",
          event: "push",
        },
        {
          suiteId: 14,
          runId: 15,
          workflowPath: ".github/workflows/ci.yml",
          event: "pull_request",
        },
      ]),
    job: (id: number) => {
      calls.push(`job:${id}`);
      return Promise.resolve(jobs.get(id) ?? null);
    },
    jobLogPrefix: (id: number) => {
      calls.push(`log:${id}`);
      return Promise.resolve([
        "##[group]Run actions/checkout@v4",
        `HEAD is now at 1a2b3c4 Merge ${H} into ${B}`,
        "##[group]Run deno test",
      ].join("\n"));
    },
  } as unknown as BackupCiTargetReadsV1;
}

Deno.test("v2: the probe reports the native pull_request runs of the same check", async () => {
  const calls: string[] = [];
  const line = await probeBackupCiFalseGreen({
    repository: REPO,
    suspension: evidence(),
    file: commitFile([result(PR_KEY)]),
    reads: pushEvidenceReads(calls),
  });
  const facts = JSON.parse(line!.slice(line!.indexOf("{")));
  assert.equal(facts.nativeEvent, "push");
  assert.equal(facts.sameBase, null);
  assert.deepEqual(facts.pullRequestRuns, [
    {
      started: true,
      conclusion: "failure",
      failingStep: 9,
      base12: B.slice(0, 12),
    },
    { started: false, conclusion: "failure", failingStep: null, base12: null },
  ]);
  // Bounded: one job read per pull_request run, a log only for a started one.
  assert.deepEqual(calls.filter((c) => c.startsWith("log:")), ["log:601"]);
  assert(!calls.includes("job:603"));
});

Deno.test("v2: a stored version 1 answer is read once more, then replayed", async () => {
  const world = passWorld();
  world.store.set(backupCiSuspensionPath(OWNER, NAME), evidence());
  world.store.set(
    backupCiCommitPath(OWNER, NAME, H),
    commitFile([result(PR_KEY)]),
  );
  const path = backupCiProbePath(OWNER, NAME);
  const v1 = {
    version: 1,
    kind: "sentinel_backup_ci_probe",
    nativeCheckRunId: 501,
    facts: {
      receipt: RECEIPT,
      legContext: "pull_request",
      nativeEvent: "push",
      nativeStarted: true,
      nativeConclusion: "failure",
      nativeFailingStep: 9,
      legBase12: B.slice(0, 12),
      nativeBase12: null,
      sameBase: null,
    },
    probedAt: T0,
  };
  assert.equal(parseBackupCiProbeRecord(v1).version, 1);
  world.store.set(path, v1);
  const calls: string[] = [];
  const first = await runBackupCiPass(
    passDeps(world, [{ repository: REPO, id: REPO_ID }], {
      targetReads: () => pushEvidenceReads(calls),
    }),
  );
  assert.equal(calls.filter((c) => c === "checkRuns").length, 1);
  const record = first.probes![0].record;
  assert.equal(record.version, 2);
  assert.equal(record.facts.pullRequestRuns?.length, 2);
  // The commit step replaces the version 1 answer once.
  const changes = await backupCiStoreChanges(
    first,
    [],
    [],
    storeView(world.store),
    T0,
    () => {},
  );
  assert.deepEqual(parseBackupCiProbeRecord(changes.get(path)), record);
  world.store.set(path, changes.get(path));
  const again = await backupCiStoreChanges(
    first,
    [],
    [],
    storeView(world.store),
    T0,
    () => {},
  );
  assert.equal(again.has(path), false);
  // Later passes replay it with no target read.
  const second = await runBackupCiPass(
    passDeps(world, [{ repository: REPO, id: REPO_ID }], {
      targetReads: () => {
        throw new Error("a remembered version 2 probe reads no target");
      },
    }),
  );
  assert.deepEqual(second.probes, []);
  assert(world.lines.includes("backup-ci:probe:remembered"));
  assert(
    world.lines.some((l) =>
      l.startsWith("sentinel_backup_ci_false_green_probe ") &&
      l.includes('"pullRequestRuns":[{"started":true')
    ),
  );
});
