/** #334: the launcher re-grants an identical-attempt refusal only on change. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  attemptFindingsDigestV1,
  attemptInputFingerprintV1,
  attemptPatchDigestV1,
} from "../../src/contracts/attempt-input.ts";
import type { AttemptInputV1 } from "../../src/contracts/attempt-input.ts";
import { attemptMemoryIdV1 } from "../../src/contracts/attempt-memory.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import type { RetryDenialV1 } from "../../ops/hosted-autonomy-retries.ts";
import { attemptInputsForRecordV1 } from "../../src/repair/identical-attempt.ts";
import { SHA1 as RUNTIME, SHA2, T0 } from "../state/helpers.ts";
import {
  BASE,
  blockedRecord,
  HEAD,
  selfTips,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";

const PRIOR = "c".repeat(64);
const MOVED_BASE = "0123456789abcdef0123456789abcdef01234567" as GitSha;

function refusedRecord(): WorkRecordV1 {
  return blockedRecord({
    blocker: {
      kind: "other",
      message:
        `identical_attempt_refused: prior attempt ${PRIOR} ran with the identical base tip, candidate patch, review findings and runtime revision`,
      since: T0 + 3000,
    },
    counters: { attempts: 3, retries: 2, reviewRounds: 2 },
  });
}

async function withRow(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  row: Omit<
    AttemptInputV1,
    "attemptId" | "atMs" | "refusals" | "lastRefusedAtMs"
  >,
): Promise<RepairStateSnapshotV1> {
  const id = await attemptMemoryIdV1({
    repository: record.repository,
    taskId: record.id,
    base: record.target.base,
    purpose: "implementation",
  });
  return parseRepairStateSnapshotV1({
    ...snapshot,
    attemptMemory: [{
      version: "v1",
      kind: "attempt_memory",
      id,
      repository: record.repository,
      taskId: record.id,
      base: record.target.base,
      purpose: "implementation",
      entries: [],
      inputs: [{
        ...row,
        attemptId: PRIOR,
        atMs: T0 + 2000,
        refusals: 1,
        lastRefusedAtMs: T0 + 3000,
      }],
    }],
  });
}

/** A prior row with the record's inputs except the overridden ones. */
function rowWith(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  change: { patchDigest?: string; findingsDigest?: string } = {},
) {
  const current = attemptInputsForRecordV1(snapshot, record, RUNTIME);
  const patchDigest = change.patchDigest ?? current.patchDigest;
  const findingsDigest = change.findingsDigest ?? current.findingsDigest;
  return {
    controllerSha: RUNTIME,
    baseTip: current.baseTip,
    patchDigest,
    findingsDigest,
    fingerprint: attemptInputFingerprintV1({
      taskId: TARGET,
      purpose: "implementation",
      controllerSha: RUNTIME,
      baseTip: current.baseTip,
      patchDigest,
      findingsDigest,
    }),
  };
}

function plan(snapshot: RepairStateSnapshotV1, tip: string) {
  const denials: RetryDenialV1[] = [];
  const plans = planHostedRetries(
    snapshot,
    T0 + 5000,
    RUNTIME,
    selfTips(tip),
    new Set(),
    (denial) => denials.push(denial),
  );
  return { plans, denials };
}

Deno.test("identical attempt: an unchanged fingerprint is never re-granted", async () => {
  const record = refusedRecord();
  const base = repairSnapshot([record]);
  const snapshot = await withRow(base, record, rowWith(base, record));
  const { plans, denials } = plan(snapshot, BASE);
  assert.equal(plans.length, 0);
  assert.deepEqual(denials.map((denial) => denial.reason), [
    "identical_attempt_unchanged",
  ]);
  // A different runtime revision is changed evidence and is re-granted.
  assert.equal(
    planHostedRetries(snapshot, T0 + 5000, SHA2, selfTips(BASE)).length,
    1,
  );
});

Deno.test("identical attempt: a moved base, changed findings or new head re-grants work", async (t) => {
  const record = refusedRecord();
  const base = repairSnapshot([record]);
  const cases: [string, Parameters<typeof rowWith>[2], string][] = [
    ["moved base", {}, MOVED_BASE],
    [
      "changed findings",
      {
        findingsDigest: attemptFindingsDigestV1([
          { severity: "P0", path: "src/a.ts", message: "an older finding" },
        ]),
      },
      BASE,
    ],
    [
      "new candidate head",
      { patchDigest: attemptPatchDigestV1({ base: BASE, head: SHA2 }) },
      BASE,
    ],
  ];
  for (const [name, change, tip] of cases) {
    await t.step(name, async () => {
      const snapshot = await withRow(
        base,
        record,
        rowWith(base, record, change),
      );
      const { plans, denials } = plan(snapshot, tip);
      assert.equal(plans.length, 1, JSON.stringify(denials));
      assert.equal(plans[0]!.nextStep, "work");
      const applied = applyHostedRetries(snapshot, HEAD, plans, T0 + 5000);
      const granted = applied.work[0]!;
      assert.equal(granted.nextStep, "work");
      assert.equal(granted.blocker, null);
      assert.deepEqual(granted.counters, record.counters, "no counter moves");
      assert.deepEqual(applied.reservations, snapshot.reservations);
      assert.deepEqual(applied.attemptMemory, snapshot.attemptMemory);
    });
  }
});
