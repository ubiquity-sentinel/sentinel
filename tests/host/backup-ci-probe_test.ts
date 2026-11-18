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
