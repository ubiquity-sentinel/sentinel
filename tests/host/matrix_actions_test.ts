/** Real repair-startup preservation maintenance coverage. */
import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { runActionsMatrixAggregateCycles } from "../../src/host/matrix-actions.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import { runHostedAutonomy } from "../../ops/hosted-autonomy.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { markBlocked } from "../../src/repair/transitions.ts";
import {
  MATRIX_PRESERVATION_UNCERTAINTY_DETAIL,
  MATRIX_UNCERTAINTY_BINDING,
  MATRIX_UNCERTAINTY_DETAIL,
  runMatrixUncertaintyMaintenance,
} from "../../src/host/matrix-uncertainty-maintenance.ts";
import {
  releaseRequest,
  reservation,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { rig } from "./matrix-actions-fixtures.ts";

Deno.test("preservation maintenance: real repair startup skips five blocked candidates and retains PR893", async () => {
  const r = await rig(true, "prior");
  try {
    const repo = {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 155687488,
    };
    const implementationIds = MATRIX_UNCERTAINTY_BINDING.reservationIds;
    const implementations = implementationIds.map((requestId, index) => {
      const id = ("issue-ubiquity-ai.ubq.fi-" + (595 + index)) as WorkItemId;
      return workRecord(id, {
        repository: repo,
        target: {
          base: r.foreignSha,
          branch: candidateBranch(id),
          head: null,
          checkpoint: null,
          pr: null,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
        intent: {
          kind: "implementation",
          key: implementationIntentKey(requestId),
          requestId,
          startedAt: T0 + 3000,
          branch: candidateBranch(id),
          expectedHead: null,
          observedBase: r.foreignSha,
          pr: null,
          resultId: null,
        },
      });
    });
    const preservationIds = [
      "c0d668a23d4c5230f6349d8368d964ea566509bd2e23a9476279108bc74dbc8b",
      "536ffe5515e1bcee3105412af0f419566b76ae422095ac54039f7a6789e1f02b",
      "739b0d9b59604f1fa163f5f90bf9fb37fd33d93ae8eee8d606e0fa174016671d",
      "11acb1590ed849db9e3fa8c4fe071ed169142c74c122deb8b40bc4ad55d7c6b3",
      "971b6ea4516e09c84a94083705353228a5d2ef31d652ddc9346fd5cae34081d9",
    ];
    const preservation = await Promise.all(
      preservationIds.map(async (requestId, index) => {
        const number = [884, 880, 730, 754, 879][index];
        const id = ("issue-ubiquity-ai.ubq.fi-" + number) as WorkItemId;
        return workRecord(id, {
          repository: repo,
          source: { kind: "issue", id: String(number), revision: String(T0) },
          related: { incidentId: null, issueNumber: number },
          target: {
            base: r.foreignSha,
            branch: candidateBranch(id),
            head: r.sha,
            checkpoint: null,
            pr: number === 730 ? 893 : null,
            candidateState: {
              preserved: null,
              publishedHead: number === 730 ? r.foreignSha : null,
            },
          },
          counters: { attempts: 1, retries: 0, reviewRounds: 0 },
          intent: {
            kind: "candidate_preservation",
            key: implementationIntentKey(requestId),
            requestId,
            startedAt: T0 + 3000,
            branch: await candidatePreservationRef(
              repo,
              id,
              implementationIntentKey(requestId),
            ),
            expectedHead: r.sha,
            observedBase: r.foreignSha,
            pr: null,
            resultId: null,
          },
        });
      }),
    );
    const control = workRecord("issue-ubiquity-sentinel-1", {
      repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
      source: { kind: "issue", id: "1", revision: String(T0) },
      target: {
        base: r.sha,
        branch: null,
        head: null,
        checkpoint: null,
        pr: null,
      },
    });
    const charges = [...implementations, ...preservation].map((row) =>
      reservation(row.intent!.requestId!, {
        repository: repo,
        taskId: row.id,
        head: r.foreignSha,
        attempt: 1,
        createdAt: T0 + 1000,
        outcome: row.intent!.kind === "candidate_preservation"
          ? "submitted"
          : "reserved",
        settledAt: row.intent!.kind === "candidate_preservation"
          ? T0 + 3000
          : null,
      })
    );
    const capture = parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0 + 3000,
      incidents: [],
      evidence: [],
      work: [...implementations, ...preservation, control],
      reservations: charges,
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    });
    const saved = await r.store.writeRepair(capture, null);
    assert.ok(saved.ok && saved.value.status === "applied");
    const captureHead = saved.value.head;
    const parked = await r.store.writeRepair(
      parseRepairStateSnapshotV1({
        ...capture,
        stateHead: saved.value.head,
        sequence: 2,
        updatedAt: r.clock.now(),
        work: capture.work.map((row) =>
          implementationIds.includes(row.intent?.requestId ?? "")
            ? markBlocked(
              row,
              "other",
              MATRIX_UNCERTAINTY_DETAIL,
              r.clock.now(),
            )
            : row
        ),
        reservations: charges.map((row) =>
          implementationIds.includes(row.id)
            ? { ...row, outcome: "ambiguous", settledAt: r.clock.now() }
            : row
        ),
      }),
      saved.value.head,
    );
    assert.ok(parked.ok && parked.value.status === "applied");
    const request = releaseRequest("release:test", {
      target: {
        repository: { owner: "ubiquity", name: "sentinel", installationId: 0 },
        environment: "production",
      },
      revision: r.foreignSha,
      source: {
        pullRequest: 111,
        reviewRequestId: "review-111",
        reviewReceiptId: "review-111",
        head: r.foreignSha,
        base: r.sha,
      },
    });
    const live = await r.release.readRelease();
    assert.ok(live.ok && live.value.status === "found");
    const runtime = live.value.snapshot.hostedRuntimes[0];
    assert.ok(
      runtime.execution && runtime.lastExecutionProof &&
        runtime.lastExecutionProof.outcome !== "not_started",
    );
    const failed = {
      ...runtime.lastExecutionProof,
      execution: runtime.execution,
      startedAt: runtime.execution.createdAt,
      finishedAt: r.clock.now(),
      observedAt: r.clock.now(),
      terminalAt: r.clock.now(),
      outcome: "failed" as const,
      startupReady: false,
      baseSha: null,
    };
    const releaseSaved = await r.release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...live.value.snapshot,
        stateHead: live.value.head,
        sequence: live.value.snapshot.sequence + 1,
        hostedRuntimes: [{
          ...runtime,
          execution: null,
          lastExecutionProof: failed,
        }],
        hostedReleases: [{
          version: "v1",
          kind: "hosted_release",
          id: request.id,
          request,
          priorRevision: r.sha,
          phase: "requested",
          priorProof: null,
          candidateProof: null,
          rollbackProof: null,
          pointerIntent: null,
          createdAt: r.clock.now(),
          updatedAt: r.clock.now(),
        }],
      }),
      live.value.head,
    );
    assert.ok(
      releaseSaved.ok && releaseSaved.value.status === "applied",
      JSON.stringify(releaseSaved),
    );
    const state = {
      readRepair: () => r.store.readRepair(),
      readRepairAt: r.store.readRepairAt!.bind(r.store),
      writeRepair: r.store.writeRepair.bind(r.store),
      readRelease: () => r.release.readRelease(),
    };
    const heldRelease = await state.readRelease();
    const before = await state.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    await runHostedAutonomy({
      state,
      clock: r.clock,
      githubFor: () => {
        throw Error("ordinary publication refused");
      },
      uncertainMatrix: () =>
        runMatrixUncertaintyMaintenance({
          state,
          clock: r.clock,
          binding: {
            repairCommit: captureHead,
            runtimeSha: r.sha,
            generation: 1,
            reservationIds: implementationIds,
          },
          confirmCompletedExecution: () => Promise.resolve(true),
          readExecution: () => Promise.resolve(portOk(failed)),
        }),
    });
    const after = await state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.filter((row) =>
        row.blocker?.message === MATRIX_PRESERVATION_UNCERTAINTY_DETAIL
      ).length,
      5,
    );
    assert.deepEqual(
      after.value.snapshot.reservations,
      before.value.snapshot.reservations,
    );
    assert.deepEqual(await state.readRelease(), heldRelease);
    const releaseRead = await r.release.readRelease();
    assert.ok(releaseRead.ok && releaseRead.value.status === "found");
    r.clock.advance(1);
    const nextExecution = parseHostedExecutionIntentV1({
      ...failed.execution,
      id: "72:1:repair",
      runId: 72,
      createdAt: r.clock.now(),
    });
    const started = await r.release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...releaseRead.value.snapshot,
        sequence: releaseRead.value.snapshot.sequence + 1,
        stateHead: releaseRead.value.head,
        updatedAt: r.clock.now(),
        hostedRuntimes: releaseRead.value.snapshot.hostedRuntimes.map((
          row,
        ) => ({ ...row, execution: nextExecution, updatedAt: r.clock.now() })),
      }),
      releaseRead.value.head,
    );
    assert.ok(started.ok && started.value.status === "applied");
    const deps = await r.job("preservation-startup", "repair");
    const result = await runActionsRepairHost({
      ...deps,
      env: { ...deps.env, GITHUB_RUN_ID: "72" },
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          throw Error("startup must not implement");
        },
      },
      runTargetCycles: (input) =>
        runActionsMatrixAggregateCycles(
          { ...input, modelStartsEnabled: false },
          {
            recover: (input) => {
              assert.deepEqual(input.requests, []);
              return Promise.resolve([]);
            },
          },
        ),
    });
    assert.equal(result.startupReady, true);
    const settled = await r.store.readRepair();
    assert.ok(settled.ok && settled.value.status === "found");
    for (const original of preservation) {
      const row: WorkRecordV1 = settled.value.snapshot.work.find((work) =>
        work.id === original.id
      )!;
      assert.equal(row.nextStep, "blocked");
      assert.deepEqual(row.target, original.target);
      assert.deepEqual(row.intent, original.intent);
    }
    assert.equal(
      settled.value.snapshot.work.find((row) => row.id === control.id)!
        .nextStep,
      "work",
    );
    assert.deepEqual(
      settled.value.snapshot.reservations,
      after.value.snapshot.reservations,
    );
  } finally {
    await r.cleanup();
  }
});
