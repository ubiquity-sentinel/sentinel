/**
 * Review MUST 2 (per-check half), probes P1 and P2: calibration is bound to
 * exactly what is stood in for. A runner agreeing only on job `lint` stood
 * in for `deno`, and five job names of one red commit calibrated a runner
 * with zero greens compared. Now a stand-in for (context, workflow path,
 * check name) needs that runner's agreements on that check and context: at
 * least five distinct commits, at least one green and one red, no false
 * green. Fakes only.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  backupCiCalibrationPath,
  backupCiReceiptId,
  isBackupCiCalibrated,
} from "../../src/contracts/backup-ci.ts";
import {
  backupCiCheckCalibrationPath,
  backupCiExcludedRunners,
  isBackupCiCheckCalibrated,
  parseBackupCiCheckCalibration,
} from "../../src/contracts/backup-ci-trust.ts";
import { mergeCheckCalibration } from "../../src/github/backup-ci-check-store.ts";
import {
  type BackupCiComparisonV1,
  mergeCalibration,
} from "../../src/github/backup-ci-store.ts";
import { selectBackupStandIns } from "../../src/github/backup-ci-substitute.ts";
import { backupCiStoreChanges } from "../../ops/backup-ci-dispatch.ts";
import type { BackupCiPassFileV1 } from "../../ops/backup-ci-pass.ts";
import type { BackupCiStoreView } from "../../ops/backup-ci-store-writer.ts";
import {
  CHECK,
  checkCalibration,
  checkDefinitions,
  commitFile,
  H,
  key,
  REPO,
  REPOSITORY,
  result,
  RUNNER,
  T0,
  TARGET,
  WORKFLOW,
} from "../github/backup-ci-fixtures.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0") as GitSha;

function compared(
  n: number,
  cls: "green" | "red" | "false_green" | "false_red",
  over: { checkName?: string; context?: "push" | "pull_request" } = {},
): BackupCiComparisonV1 {
  const checkName = over.checkName ?? CHECK;
  const context = over.context ?? "push";
  const native = cls === "green" || cls === "false_red" ? "success" : "failure";
  const backup = cls === "green" || cls === "false_green"
    ? "success" as const
    : "failure" as const;
  const k = {
    context,
    workflowPath: WORKFLOW,
    checkName,
    base: context === "pull_request" ? sha(0xb) : null,
  };
  return {
    runnerId: RUNNER,
    sample: { commit: sha(n), checkName, native, backup },
    nativeCheckRunId: 900 + n,
    receipt: backupCiReceiptId(REPO, sha(n), { ...k, attempt: 1 }),
    key: k,
    class: cls,
  };
}

function standIn(checks: ReturnType<typeof checkCalibration> | null) {
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
  return selectBackupStandIns({
    target: TARGET,
    commit: H,
    mode: "on",
    latest,
    all: latest,
    suites: [{ suiteId: 11, workflowPath: WORKFLOW, event: "push" }],
    statusContexts: new Set<string>(),
    file: commitFile([result(key())]),
    suspensions: [],
    calibration: mergeCalibration(
      null,
      REPOSITORY,
      [0, 1, 2, 3, 4].map((n) => compared(n, n === 0 ? "red" : "green")),
      T0,
    ).calibration,
    checks,
    // The receipt's own job definition is calibrated (2026-11-18): this
    // file tests the per-check gate alone.
    definitions: checkDefinitions([{ context: "push" }]),
    excluded: { all: false, runnerIds: [] },
  });
}

Deno.test("P1: agreements on job lint never calibrate job deno", () => {
  const lint = [0, 1, 2, 3, 4].map((n) =>
    compared(n, n === 0 ? "red" : "green", { checkName: "lint" })
  );
  // The pooled ledger still calls the runner calibrated (the old flaw)…
  const pooled = mergeCalibration(null, REPOSITORY, lint, T0).calibration;
  assert.equal(isBackupCiCalibrated(pooled, RUNNER), true);
  // …the per-check ledger does not, and the stand-in is refused visibly.
  const checks = mergeCheckCalibration(null, REPOSITORY, lint, T0)!.checks;
  assert.equal(
    isBackupCiCheckCalibrated(checks, RUNNER, {
      context: "push",
      workflowPath: WORKFLOW,
      checkName: CHECK,
    }),
    false,
  );
  const out = standIn(checks);
  assert.equal(out.standIns.size, 0);
  assert.deepEqual(out.refusals, [`uncalibrated:${CHECK}`]);
  // The same agreements on deno itself do calibrate it.
  const deno = [0, 1, 2, 3, 4].map((n) =>
    compared(n, n === 0 ? "red" : "green")
  );
  const own = mergeCheckCalibration(null, REPOSITORY, deno, T0)!.checks;
  assert.deepEqual([...standIn(own).standIns.keys()], [102]);
});

Deno.test("P2: five job names of one red commit are five uncalibrated rows", () => {
  const one = ["a", "b", "c", "d", "e"].map((checkName) =>
    compared(7, "red", { checkName })
  );
  assert.equal(
    isBackupCiCalibrated(
      mergeCalibration(null, REPOSITORY, one, T0).calibration,
      RUNNER,
    ),
    true,
    "the pooled ledger was fooled",
  );
  const checks = mergeCheckCalibration(null, REPOSITORY, one, T0)!.checks;
  assert.equal(checks.rows.length, 5);
  for (const row of checks.rows) {
    assert.equal(
      isBackupCiCheckCalibrated(checks, RUNNER, {
        context: "push",
        workflowPath: WORKFLOW,
        checkName: row.checkName,
      }),
      false,
      row.checkName,
    );
  }
});

Deno.test("the per-check gate needs five distinct commits, a green, a red and no false green", () => {
  const at = (rows: Parameters<typeof checkCalibration>[0]) =>
    isBackupCiCheckCalibrated(checkCalibration(rows), RUNNER, {
      context: "push",
      workflowPath: WORKFLOW,
      checkName: CHECK,
    });
  assert.equal(at([{ greens: 4, reds: 1 }]), true);
  assert.equal(at([{ greens: 5, reds: 0 }]), false, "no red");
  assert.equal(at([{ greens: 0, reds: 5 }]), false, "no green");
  assert.equal(at([{ greens: 3, reds: 1 }]), false, "four commits");
  assert.equal(at([{ greens: 4, reds: 1, falseGreens: 1 }]), false);
  // A push row never calibrates a pull_request stand-in.
  assert.equal(
    isBackupCiCheckCalibrated(checkCalibration([{ context: "push" }]), RUNNER, {
      context: "pull_request",
      workflowPath: WORKFLOW,
      checkName: CHECK,
    }),
    false,
  );
});

Deno.test("merging counts a commit once and never lets an agreement swallow a dispute", () => {
  const first = mergeCheckCalibration(null, REPOSITORY, [
    compared(1, "green"),
    compared(1, "green"),
    compared(2, "red"),
  ], T0)!;
  assert.deepEqual(first.checks.rows[0].greens, [sha(1)]);
  assert.deepEqual(first.checks.rows[0].reds, [sha(2)]);
  // A later false green on commit 1 (another base or attempt) revokes it.
  const second = mergeCheckCalibration(first.checks, REPOSITORY, [
    compared(1, "false_green"),
    compared(1, "green"),
  ], T0)!;
  assert.deepEqual(second.checks.rows[0].greens, []);
  assert.equal(second.checks.rows[0].falseGreens, 1);
  assert.deepEqual(second.disagreements.map((d) => d.kind), ["false_green"]);
  // Counted once.
  const third = mergeCheckCalibration(second.checks, REPOSITORY, [
    compared(1, "false_green"),
  ], T0)!;
  assert.equal(third.checks.rows[0].falseGreens, 1);
  // An older launcher's pass carries no key or class: nothing to write.
  const { key: _k, class: _c, ...unkeyed } = compared(3, "green");
  assert.equal(mergeCheckCalibration(null, REPOSITORY, [unkeyed], T0), null);
  assert.throws(() =>
    mergeCheckCalibration(first.checks, { ...REPOSITORY, id: 1 }, [
      compared(4, "green"),
    ], T0)
  );
  // A per-check false green excludes the runner everywhere.
  assert.deepEqual(
    backupCiExcludedRunners([], [], [second.checks]).runnerIds,
    [RUNNER],
  );
});

Deno.test("checks.json parses strictly", () => {
  const good = checkCalibration();
  assert.deepEqual(parseBackupCiCheckCalibration(good), good);
  assert.throws(() => parseBackupCiCheckCalibration({ ...good, extra: 1 }));
  assert.throws(() =>
    parseBackupCiCheckCalibration({
      ...good,
      rows: [good.rows[0], good.rows[0]],
    })
  );
  assert.throws(() =>
    parseBackupCiCheckCalibration({
      ...good,
      rows: [{ ...good.rows[0], reds: [good.rows[0].greens[0]] }],
    })
  );
});

Deno.test("the commit step writes checks.json and suspends on a per-check false green", async () => {
  const view = new Map<string, unknown>();
  const pass = {
    version: 1,
    kind: "sentinel_backup_ci_pass",
    runId: 1,
    launcherSha: "e".repeat(40),
    mode: "on",
    runnerId: RUNNER,
    createdAt: T0,
    files: [],
    units: [],
    comparisons: [{
      repository: { ...REPOSITORY },
      comparisons: [
        compared(1, "green", { context: "push" }),
        // The pooled ledger dedupes (commit, check name) across contexts and
        // swallows this false green; the per-check ledger must not.
        compared(1, "false_green", { context: "pull_request" }),
      ],
    }],
  } as unknown as BackupCiPassFileV1;
  const lines: string[] = [];
  const changes = await backupCiStoreChanges(
    pass,
    [],
    [],
    {
      read: (path: string) => Promise.resolve(view.get(path) ?? null),
    } as unknown as BackupCiStoreView,
    T0,
    (line) => lines.push(line),
  );
  const pooled = changes.get(
    backupCiCalibrationPath(REPOSITORY.owner, REPOSITORY.name),
  ) as { runners: { falseGreens: number }[] };
  assert.equal(pooled.runners[0].falseGreens, 0, "pooled swallowed it");
  const checks = parseBackupCiCheckCalibration(
    changes.get(
      backupCiCheckCalibrationPath(REPOSITORY.owner, REPOSITORY.name),
    ),
  );
  assert.equal(
    checks.rows.find((r) => r.context === "pull_request")?.falseGreens,
    1,
  );
  const suspension = changes.get(
    `v1/${REPOSITORY.owner}/${REPOSITORY.name}/suspended.json`,
  ) as { reason: string; runnerIds: string[] };
  assert.equal(suspension.reason, "false_green");
  assert.deepEqual(suspension.runnerIds, [RUNNER]);
});
