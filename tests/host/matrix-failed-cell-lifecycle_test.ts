/** Sanitized failed issue93 carrier through real aggregate/state consumers. */
import assert from "node:assert/strict";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import { reservation, workRecord } from "../state/helpers.ts";
import { createFreshMatrixArchives } from "./matrix-actions-archive-fixtures.ts";
import { issue, rig } from "./matrix-actions-fixtures.ts";

// Public task/admission identities only. Payloads, source Git objects, native
// run/runtime identities and corresponding digests use inert fixture mappings.
const RETAINED = [
  [662, "5834b629e4e01874220e319b6e95742da165bdb9f8db864638441b5ce17de2fe", 4],
  [663, "292574ae3ad3f205012b1763bcef034718d2eecd501db02529fb2ecb053d902a", 4],
  [908, "76954c6249f013219ba2a6d443cf1fd82e04cd0c6cd3b744902e42a944fa34eb", 3],
  [657, "78def0cbc56c1805bc2f8545ad3407f45b2598dab00c3c4886a252b66e33f819", 4],
  [664, "dce747ddebe634cf01861ffe4b5d9ec53ccbf06033af90a54ee6d87db25687bf", 4],
  [905, "34b0e6dc54a7620d11817a472a6dab1749af8217c7b048c3ea93800cd3a2a5f6", 4],
  [660, "34067a0413f193c6faf5d5459893248ed2fdecc9f4578e5e1c7be842318999aa", 4],
  [650, "888c9f5560a3467c3f901f280e9c2450b0cd32d5a8bb6a813094b2b8c9eb4f83", 5],
  [661, "3730c8e97c4d78b60b2d80ff61c33c869e5a6a4253b2e815dc460254dcce3fb7", 4],
  [659, "6c4dc59748f9b196b88bbeb6f8b704dceefc85a4945c55bd8ce68a3174aa77b7", 4],
] as const;

async function failedCellScenario(
  retained: boolean,
  pendingNative = false,
  mismatchedNative = false,
) {
  const r = await rig();
  try {
    const self = r.github.get("ubiquity-sentinel/sentinel")!;
    self.listOpenIssues = () => Promise.resolve(portOk([issue(93)]));
    self.readIssue = (number) => Promise.resolve(portOk(issue(number)));
    const foreign = r.github.get("ubiquity/ai.ubq.fi")!;
    foreign.listOpenIssues = () => Promise.resolve(portOk([]));
    foreign.readIssue = (number) => Promise.resolve(portOk(issue(number)));
    foreign.preserveCandidate = () =>
      Promise.resolve(
        portError(
          "unavailable",
          "inert preserved producer remains unavailable",
        ),
      );
    const noModel = {
      modelId: "gpt-reserve",
      runModel: () => {
        throw new Error("no inference is permitted");
      },
    };
    const planner = await runActionsMatrixHost({
      ...await r.job("failed-plan", "matrix_plan"),
      model: noModel,
    });
    assert.ok("plan" in planner);
    assert.equal(planner.plan.cells.length, 1);
    const cell = planner.plan.cells[0];
    assert.equal(cell.taskId, "issue-ubiquity-sentinel-93");
    const cellDeps = await r.job("failed-cell", "matrix_cell");
    const artifactRoot = cellDeps.workDir + "/../.sentinel-matrix";
    await Deno.mkdir(artifactRoot);
    await Deno.writeTextFile(
      artifactRoot + "/plan.json",
      JSON.stringify(planner.plan),
    );
    let portCalls = 0;
    const produced = await runActionsMatrixHost({
      ...cellDeps,
      carrier: { planDigest: planner.planDigest, cellId: cell.cellId },
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          portCalls++;
          return Promise.resolve(portError("unavailable", "inert failed port"));
        },
      },
    });
    assert.ok("cellId" in produced);
    const failed: MatrixCellResultV1 = produced;
    assert.equal(portCalls, 1);
    assert.equal(failed.status, "failed");
    assert.equal(failed.detail, "model run failed (unavailable)");
    assert.equal(failed.receipt, null);
    assert.equal(failed.bundle, null);
    const archives = await createFreshMatrixArchives(
      r,
      planner,
      [failed],
      r.root,
      false,
      false,
      true,
    );
    const cellJob = archives.jobs.find((job) =>
      job.name.startsWith("matrix_cell")
    )!;
    if (pendingNative) {
      // The upload has become visible, but the producing job is still alive.
      Object.assign(cellJob, {
        status: "in_progress",
        conclusion: null,
        completed_at: null,
      });
      if (mismatchedNative) cellJob.head_sha = r.foreignSha;
    }
    const deps = await r.job("failed-aggregate", "repair");
    const cwd = Deno.cwd();
    let beforeCharges: unknown;
    let aggregateRequests = 0;
    try {
      Deno.chdir(deps.workDir);
      const aggregate = () =>
        runActionsRepairHost({
          ...deps,
          artifactHttp: archives.artifactHttp(() => true),
          model: noModel,
          runTargetCycles: async (input) => {
            if (retained) {
              const read = await r.store.readRepair();
              assert.ok(read.ok && read.value.status === "found");
              const repository = input.configs.find((config) =>
                config.repository.name === "ai.ubq.fi"
              )!.repository;
              const extra = await Promise.all(
                RETAINED.map(async ([number, id, attempt]) => {
                  const taskId = `issue-ubiquity-ai.ubq.fi-${number}`;
                  const key = `impl:${id}`;
                  const head = "d".repeat(40);
                  const ref = await candidatePreservationRef(
                    repository,
                    taskId as never,
                    key,
                  );
                  return {
                    work: workRecord(taskId, {
                      repository,
                      source: {
                        kind: "issue",
                        id: String(number),
                        revision: r.foreignSha,
                      },
                      related: { incidentId: null, issueNumber: number },
                      target: {
                        base: r.foreignSha,
                        head,
                        pr: null,
                        branch: `sentinel/repair/${taskId}`,
                        checkpoint: null,
                        candidateState: {
                          preserved: null,
                          publishedHead: null,
                        },
                      },
                      counters: {
                        attempts: attempt,
                        retries: 0,
                        reviewRounds: 0,
                      },
                      intent: {
                        kind: "candidate_preservation",
                        key,
                        startedAt: r.clock.now(),
                        branch: ref,
                        expectedHead: head,
                        observedBase: r.foreignSha,
                        pr: null,
                        requestId: id,
                        resultId: null,
                      },
                    }),
                    charge: reservation(id, {
                      repository,
                      taskId,
                      attempt,
                      head: r.foreignSha,
                      purpose: "retry",
                      createdAt: r.clock.now(),
                      outcome: "submitted",
                      settledAt: r.clock.now(),
                    }),
                  };
                }),
              );
              const saved = await r.store.writeRepair({
                ...read.value.snapshot,
                stateHead: read.value.head,
                sequence: read.value.snapshot.sequence + 1,
                updatedAt: r.clock.now(),
                work: [
                  ...read.value.snapshot.work,
                  ...extra.map((row) =>
                    row.work
                  ),
                ],
                reservations: [
                  ...read.value.snapshot.reservations,
                  ...extra.map((row) => row.charge),
                ],
              }, read.value.head);
              assert.ok(
                saved.ok && saved.value.status === "applied",
                JSON.stringify(saved),
              );
            }
            const read = await r.store.readRepair();
            assert.ok(read.ok && read.value.status === "found");
            beforeCharges = structuredClone(read.value.snapshot.reservations);
            aggregateRequests = read.value.snapshot.work.filter((row) =>
              row.intent?.kind === "implementation" ||
              row.intent?.kind === "candidate_preservation"
            ).length;
            return await runActionsMatrixAggregateCycles(
              { ...input, modelStartsEnabled: false },
              undefined,
              { planDigest: planner.planDigest },
              { maxWaitMs: 0 },
            );
          },
        });
      if (mismatchedNative) {
        await assert.rejects(
          aggregate,
          /matrix artifact provenance unavailable or conflicting/,
        );
      } else await aggregate();
    } finally {
      Deno.chdir(cwd);
    }
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    const record = after.value.snapshot.work.find((row) =>
      row.id === cell.taskId
    )!;
    const charge = after.value.snapshot.reservations.find((row) =>
      row.id === cell.reservationId
    )!;
    assert.equal(aggregateRequests, retained ? 11 : 1);
    if (pendingNative) {
      assert.equal(charge.outcome, "reserved");
      assert.equal(record.nextStep, "work");
      assert.equal(record.intent?.requestId, cell.reservationId);
      assert.deepEqual(after.value.snapshot.reservations, beforeCharges);
      if (!mismatchedNative) {
        Object.assign(cellJob, {
          status: "completed",
          conclusion: "success",
          completed_at: archives.iso,
        });
        const resumed = await r.job("failed-aggregate-resume", "repair");
        const previous = Deno.cwd();
        try {
          Deno.chdir(resumed.workDir);
          await runActionsRepairHost({
            ...resumed,
            artifactHttp: archives.artifactHttp(() => true),
            model: noModel,
            runTargetCycles: (input) =>
              runActionsMatrixAggregateCycles(
                { ...input, modelStartsEnabled: false },
                undefined,
                { planDigest: planner.planDigest },
                { maxWaitMs: 0 },
              ),
          });
        } finally {
          Deno.chdir(previous);
        }
        const completed = await r.store.readRepair();
        assert.ok(completed.ok && completed.value.status === "found");
        assert.equal(
          completed.value.snapshot.reservations.find((row) =>
            row.id === cell.reservationId
          )?.outcome,
          "ambiguous",
        );
        assert.equal(
          completed.value.snapshot.work.find((row) => row.id === cell.taskId)
            ?.nextStep,
          "blocked",
        );
        assert.equal(
          portCalls,
          1,
          "resuming native proof never restarts the failed model port",
        );
      }
    } else {
      assert.equal(charge.outcome, "ambiguous");
      assert.equal(record.nextStep, "blocked");
      assert.equal(record.target.head, null);
      const prior = beforeCharges as typeof after.value.snapshot.reservations;
      assert.deepEqual(
        after.value.snapshot.reservations.filter((row) =>
          row.id !== cell.reservationId
        ),
        prior.filter((row) => row.id !== cell.reservationId),
      );
      assert.equal(after.value.snapshot.reservations.length, retained ? 11 : 1);
    }
  } finally {
    await r.cleanup();
  }
}

Deno.test("failed cell93: completed authenticated carrier settles through isolated aggregate", () =>
  failedCellScenario(false));
Deno.test("failed cell93: completed carrier settles beside ten retained preservation charges", () =>
  failedCellScenario(true));
Deno.test("failed cell93: visible artifact with producing native job still running remains charged and pending", () =>
  failedCellScenario(false, true));
Deno.test("failed cell93: visible artifact with running foreign native identity still refuses", () =>
  failedCellScenario(false, true, true));
