/** Timeout accounting, decomposition and retained start-window boundaries. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseMatrixModelRequestV1 } from "../../src/contracts/matrix.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import { T0 } from "../state/helpers.ts";
import {
  attemptFingerprintV1,
  attemptMemoryIdV1,
  parseAttemptMemoryRecordV1,
} from "../../src/contracts/attempt-memory.ts";
import { ATTEMPT_DETAIL_INCOMPLETE } from "../../src/repair/attempt-policy.ts";
import { tryParse } from "../../src/contracts/validation.ts";
import {
  freshIssue,
  makeRig,
  seedSnapshot,
} from "./matrix-runtime-fixtures.ts";

Deno.test(
  "matrix runtime: durable attempt memory refuses an equivalent planner admission until evidence changes",
  async () => {
    const rig = await makeRig([754], 1);
    try {
      const seeded = seedSnapshot([freshIssue(754, rig.base)]);
      const record = seeded.work[0];
      // Two recorded semantic no-progress outcomes at this exact base and
      // runtime revision, built with the production identity derivation.
      const id = await attemptMemoryIdV1({
        repository: record.repository,
        taskId: record.id,
        base: record.target.base,
        purpose: "implementation",
      });
      const fingerprint = await attemptFingerprintV1({
        taskId: record.id,
        base: record.target.base,
        purpose: "implementation",
        controllerSha: record.controller.sha,
        detail: ATTEMPT_DETAIL_INCOMPLETE,
      });
      const memory = parseAttemptMemoryRecordV1({
        version: "v1",
        kind: "attempt_memory",
        id,
        repository: record.repository,
        taskId: record.id,
        base: record.target.base,
        purpose: "implementation",
        entries: [
          {
            fingerprint,
            stage: "model",
            failureClass: "semantic_no_progress",
            detail: ATTEMPT_DETAIL_INCOMPLETE,
            controllerSha: record.controller.sha,
            count: 2,
            firstAtMs: T0,
            lastAtMs: T0 + 1000,
          },
        ],
      });
      const written = await rig.store.writeRepair(
        parseRepairStateSnapshotV1({ ...seeded, attemptMemory: [memory] }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // Equivalent attempt at the same base and revision: refused, nothing
      // charged, and the refusal is visible in the report.
      const refused = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(refused.memoryRefused, 1);
      assert.equal(refused.plan.cells.length, 0);
      assert.equal(refused.attempted, 1);

      // Changed evidence: the repository's default branch genuinely moves,
      // so the record's target base follows it. The durable memory stays
      // bound to the OLD base (append-only) and no longer applies, so this
      // admission proceeds.
      const otherBase = "0123456789abcdef0123456789abcdef01234567" as GitSha;
      (rig.github as unknown as { options: { baseSha?: GitSha } }).options
        .baseSha = otherBase;
      const movedRecord = {
        ...record,
        target: { ...record.target, base: otherBase },
        updatedAt: T0,
      };
      const rewritten = await rig.store.writeRepair(
        parseRepairStateSnapshotV1({
          ...seeded,
          stateHead: written.value.status === "applied"
            ? written.value.head
            : null,
          sequence: seeded.sequence + 1,
          updatedAt: T0,
          work: [movedRecord],
          attemptMemory: [memory],
          lessons: [],
        }),
        written.value.status === "applied" ? written.value.head : null,
      );
      assert.ok(rewritten.ok && rewritten.value.status === "applied");
      const admitted = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(admitted.memoryRefused, 0);
      assert.equal(admitted.plan.cells.length, 1);
      assert.equal(admitted.plan.cells[0].taskId, record.id);
    } finally {
      await Deno.remove(rig.tmp, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "matrix runtime: versioned regression facts round-trip through the strict request parser",
  () => {
    const base = "1ad85317e2e681b9deb5a2f4c7b653df34a691b7" as GitSha;
    const prior = "ee5e6518a4333c20d8bc6a4c3c577a2536ec6b9b" as GitSha;
    const request = {
      taskId: "issue-parser-1",
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      base,
      issue: null,
      evidence: [],
      regressions: [
        {
          detail: "model run did not complete with a trusted candidate",
          priorSuccessRevision: prior,
          priorSuccessAtMs: T0,
          failuresAtCurrentRevision: 3,
          lastFailureAtMs: T0 + 1000,
        },
      ],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 1000,
      maxOutputChars: 1000,
    };
    const parsed = parseMatrixModelRequestV1(request, "$");
    assert.equal(parsed.regressions?.length, 1);
    assert.equal(parsed.regressions?.[0].priorSuccessRevision, prior);

    const malformed = {
      ...request,
      regressions: [{ ...request.regressions[0], extra: true }],
    };
    const rejected = tryParse(
      (value) => parseMatrixModelRequestV1(value, "$"),
      malformed,
    );
    assert.equal(rejected.ok, false);
  },
);
