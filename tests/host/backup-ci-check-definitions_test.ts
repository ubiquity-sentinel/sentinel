/**
 * 2026-11-18 review (i), first half: every agreement is also counted under
 * the job definition its leg ran (workflow blob, job key, matrix) in the new
 * file `v1/<owner>/<repo>/check-defs.json`, so the stand-in rule can require
 * agreements under the stand-in's own definition without recalibrating.
 * The stand-in rule does not read the file yet. Fakes only.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { backupCiReceiptId } from "../../src/contracts/backup-ci.ts";
import {
  backupCiCheckDefinitionsPath,
  backupCiJobDefinition,
  isBackupCiDefinitionCalibrated,
  parseBackupCiCheckDefinitions,
} from "../../src/contracts/backup-ci-trust.ts";
import { mergeCheckDefinitions } from "../../src/github/backup-ci-check-store.ts";
import type { BackupCiComparisonV1 } from "../../src/github/backup-ci-store.ts";
import { backupCiStoreChanges } from "../../ops/backup-ci-dispatch.ts";
import type { BackupCiPassFileV1 } from "../../ops/backup-ci-pass.ts";
import type { BackupCiStoreView } from "../../ops/backup-ci-store-writer.ts";
import {
  CHECK,
  checkCalibration,
  REPO,
  REPOSITORY,
  RUNNER,
  T0,
  WORKFLOW,
} from "../github/backup-ci-fixtures.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0") as GitSha;
const DEF_A = backupCiJobDefinition({
  workflowBlob: sha(0xa),
  jobKey: "deno",
  matrix: null,
});
const DEF_B = backupCiJobDefinition({
  workflowBlob: sha(0xb),
  jobKey: "deno",
  matrix: null,
});
const KEY = {
  context: "push" as const,
  workflowPath: WORKFLOW,
  checkName: CHECK,
};

function compared(
  n: number,
  cls: "green" | "red" | "false_green" | "false_red",
  definition: string | undefined,
): BackupCiComparisonV1 {
  const native = cls === "green" || cls === "false_red" ? "success" : "failure";
  const backup = cls === "green" || cls === "false_green"
    ? "success" as const
    : "failure" as const;
  const k = { ...KEY, base: null };
  return {
    runnerId: RUNNER,
    sample: { commit: sha(n), checkName: CHECK, native, backup },
    nativeCheckRunId: 900 + n,
    receipt: backupCiReceiptId(REPO, sha(n), { ...k, attempt: 1 }),
    key: k,
    class: cls,
    ...(definition === undefined ? {} : { definition }),
  };
}

Deno.test("a job definition is the workflow blob, job key and matrix", () => {
  const base = { workflowBlob: sha(0xa), jobKey: "deno", matrix: null };
  assert.match(DEF_A, /^[0-9a-f]{64}$/);
  assert.equal(backupCiJobDefinition({ ...base }), DEF_A);
  assert.notEqual(DEF_B, DEF_A);
  assert.notEqual(backupCiJobDefinition({ ...base, jobKey: "lint" }), DEF_A);
  assert.notEqual(
    backupCiJobDefinition({ ...base, matrix: { os: "ubuntu-latest" } }),
    DEF_A,
  );
});

Deno.test("agreements under an older definition never calibrate the current one", () => {
  // Five agreements (a red among them) under definition A, two under B.
  const merged = mergeCheckDefinitions(
    null,
    REPOSITORY,
    [
      ...[1, 2, 3, 4, 5].map((n) =>
        compared(n, n === 1 ? "red" : "green", DEF_A)
      ),
      compared(6, "red", DEF_B),
      compared(7, "green", DEF_B),
      // An older launcher's comparison carries no definition: no count.
      compared(8, "green", undefined),
    ],
    T0,
    null,
  )!;
  assert.equal(
    isBackupCiDefinitionCalibrated(merged, RUNNER, KEY, DEF_A),
    true,
  );
  assert.equal(
    isBackupCiDefinitionCalibrated(merged, RUNNER, KEY, DEF_B),
    false,
  );
  assert.deepEqual(
    merged.rows.map((r) => [r.definition, r.greens.length, r.reds.length]),
    [[DEF_A, 4, 1], [DEF_B, 1, 1]],
  );
  // The same definition of another check or context is another row.
  assert.equal(
    isBackupCiDefinitionCalibrated(
      merged,
      RUNNER,
      { ...KEY, context: "pull_request" },
      DEF_A,
    ),
    false,
  );
  assert.equal(
    mergeCheckDefinitions(
      null,
      REPOSITORY,
      [compared(9, "green", undefined)],
      T0,
      null,
    ),
    null,
    "nothing to write without a definition",
  );
});

Deno.test("a disagreement revokes the commit under every definition; a dispute never re-counts", () => {
  const first = mergeCheckDefinitions(
    null,
    REPOSITORY,
    [compared(1, "green", DEF_A), compared(1, "red", DEF_B)],
    T0,
    null,
  )!;
  assert.deepEqual(first.rows.map((r) => r.greens.length + r.reds.length), [
    1,
    1,
  ]);
  const revoked = mergeCheckDefinitions(
    first,
    REPOSITORY,
    [compared(1, "false_red", DEF_A)],
    T0 + 1,
    null,
  )!;
  assert.deepEqual(revoked.rows.map((r) => r.greens.length + r.reds.length), [
    0,
    0,
  ]);
  // checks.json holds the commit as disputed: a later agreement stays out.
  const checks = checkCalibration([{ context: "push" }]);
  checks.rows[0].disputed = [sha(1)];
  const again = mergeCheckDefinitions(
    revoked,
    REPOSITORY,
    [compared(1, "green", DEF_A)],
    T0 + 2,
    checks,
  )!;
  assert.deepEqual(again.rows.map((r) => r.greens.length + r.reds.length), [
    0,
    0,
  ]);
  assert.throws(() =>
    mergeCheckDefinitions(
      first,
      { ...REPOSITORY, id: REPOSITORY.id + 1 },
      [compared(2, "green", DEF_A)],
      T0,
      null,
    )
  );
});

Deno.test("check-defs.json parses strictly", () => {
  const file = mergeCheckDefinitions(
    null,
    REPOSITORY,
    [compared(1, "green", DEF_A)],
    T0,
    null,
  )!;
  assert.deepEqual(
    parseBackupCiCheckDefinitions(JSON.parse(JSON.stringify(file))),
    file,
  );
  const bad = (over: Record<string, unknown>) => () =>
    parseBackupCiCheckDefinitions({
      ...file,
      rows: [{ ...file.rows[0], ...over }],
    });
  assert.throws(bad({ definition: "abc" }));
  assert.throws(bad({ disputed: [] }));
  assert.throws(() =>
    parseBackupCiCheckDefinitions({
      ...file,
      rows: [file.rows[0], file.rows[0]],
    })
  );
});

Deno.test("the commit step writes check-defs.json next to checks.json", async () => {
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
      comparisons: [compared(1, "green", DEF_A), compared(2, "red", DEF_A)],
    }],
  } as unknown as BackupCiPassFileV1;
  const changes = await backupCiStoreChanges(
    pass,
    [],
    [],
    {
      read: () => Promise.resolve(null),
    } as unknown as BackupCiStoreView,
    T0,
    () => {},
  );
  const defs = parseBackupCiCheckDefinitions(
    changes.get(
      backupCiCheckDefinitionsPath(REPOSITORY.owner, REPOSITORY.name),
    ),
  );
  assert.deepEqual(
    defs.rows.map((r) => [r.definition, r.greens, r.reds]),
    [[DEF_A, [sha(1)], [sha(2)]]],
  );
});
