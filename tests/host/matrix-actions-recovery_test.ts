import { SHA1 as ATTEMPT_RUNTIME } from "../state/helpers.ts";
/** Closed C mixed ingestion, charge retention and fresh-mirror recovery. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ImplementationPort } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-actions.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import type { ActionsTargetCyclesInputV1 } from "../../src/host/actions.ts";
import {
  closedCWaveHandledReservations,
  closedCWaveNeedsRecovery,
  ingestClosedCWave,
} from "../../src/host/modern-matrix-recovery.ts";
import { createGitBundleImporter } from "../../src/host/matrix-git.ts";
import {
  applyHostedRetirements,
  applyHostedRetries,
  hostedIssueKey,
  planHostedRetirements,
  planHostedRetries,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import {
  createRunBounds,
  loadRepairContext,
  prepareImplementationStart,
  runRepairCycle,
} from "../../src/repair/loop.ts";
import { gitRun } from "../state/helpers.ts";
import { checked, issue, PROVIDER, rig } from "./matrix-actions-fixtures.ts";

Deno.test("closed C recovery: real mixed ingestion preserves charges and rehydrates fresh mirrors", async () => {
  const r = await rig();
  try {
    for (
      const [slug, count] of [["Ubiquity-Sentinel/sentinel", 1], [
        "ubiquity/ai.ubq.fi",
        4,
      ]] as const
    ) {
      const rows = Array.from(
        { length: count },
        (_, index) => issue(index + 1),
      );
      const port = r.github.get(slug)!;
      port.listOpenIssues = () => Promise.resolve(portOk(rows));
      port.readIssue = (number) =>
        Promise.resolve(portOk(rows[number - 1] ?? null));
    }
    const refusing: ImplementationPort = {
      modelId: "gpt-reserve",
      runModel: () => {
        throw Error("recovery cannot start a model");
      },
    };
    const planner = await runActionsMatrixHost({
      ...await r.job("closed-plan", "matrix_plan"),
      model: refusing,
    });
    assert.ok("plan" in planner);
    assert.equal(planner.plan.cells.length, 5);
    const producerRepair = await r.store.readRepair();
    assert.ok(producerRepair.ok && producerRepair.value.status === "found");
    const results: MatrixCellResultV1[] = [];
    const archive = r.root + "/closed-archive";
    await Deno.mkdir(archive);
    for (const cell of planner.plan.cells) {
      const deps = await r.job("closed-cell-" + cell.cellId, "matrix_cell");
      const artifactRoot = deps.workDir + "/../.sentinel-matrix";
      await Deno.mkdir(artifactRoot);
      await Deno.writeTextFile(
        artifactRoot + "/plan.json",
        JSON.stringify(planner.plan),
      );
      const number = cell.request.issue!.number;
      const model: ImplementationPort = {
        modelId: "gpt-reserve",
        runModel: async (request) => {
          if (
            request.repository.name === "ai.ubq.fi" &&
            (number === 2 || number === 3)
          ) {
            return portOk({
              invocationId: cell.cellId,
              outcome: "interrupted",
              actual: {
                evidenceKind: "request-runtime",
                provider: PROVIDER,
                threadId: "thread-" + cell.cellId,
                turnId: "turn-" + cell.cellId,
                terminalOrigin: "runtime",
                observedTerminalStatus: "interrupted",
                observedModel: request.model,
                observedReasoning: "max",
                durationMs: 1,
                outputChars: 1,
              },
              candidate: null,
              error: null,
            });
          }
          const source = deps.workDir + "/.sentinel-actions-state/" +
            (request.repository.name === "sentinel"
              ? "source"
              : "sources/ubiquity-ai.ubq.fi");
          const path = request.repository.name === "sentinel" || number === 4
            ? "repair.txt"
            : "deno.json";
          await Deno.writeTextFile(source + "/" + path, "candidate\n");
          await checked(source, ["add", path], r.env);
          await checked(source, ["commit", "-q", "-m", "candidate"], r.env);
          const head = await checked(
            source,
            ["rev-parse", "HEAD"],
            r.env,
          ) as GitSha;
          return portOk({
            invocationId: cell.cellId,
            outcome: "completed",
            actual: {
              evidenceKind: "request-runtime",
              provider: PROVIDER,
              threadId: "thread-" + cell.cellId,
              turnId: "turn-" + cell.cellId,
              terminalOrigin: "runtime",
              observedTerminalStatus: "completed",
              observedModel: request.model,
              observedReasoning: "max",
              durationMs: 1,
              outputChars: 1,
            },
            candidate: {
              head,
              checkpointSha: request.repository.name === "sentinel"
                ? head
                : null,
              changedPaths: [path],
            },
            error: null,
          });
        },
      };
      const result = await runActionsMatrixHost({
        ...deps,
        model,
        carrier: { planDigest: planner.planDigest, cellId: cell.cellId },
      });
      assert.ok("cellId" in result);
      results.push(result);
      if (result.bundle) {
        await Deno.copyFile(
          artifactRoot + "/" + result.bundle.file,
          archive + "/" + result.bundle.file,
        );
      }
      await Deno.remove(deps.workDir + "/..", { recursive: true });
    }
    let assembly: ActionsTargetCyclesInputV1 | undefined;
    const capture = await r.job("closed-capture", "repair");
    await runActionsRepairHost({
      ...capture,
      model: refusing,
      runTargetCycles: (input) => {
        assembly = input;
        return Promise.resolve({
          outcome: { status: "idle", detail: "captured leaf dependencies" },
          addressed: [],
          skipped: [],
          failed: [],
        });
      },
    });
    assert.ok(assembly);
    const release = await r.release.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    const runtime = release.value.snapshot.hostedRuntimes[0]!;
    assert.ok(runtime.execution && runtime.lastHealthyProof);
    const failedProof = {
      ...runtime.lastHealthyProof,
      execution: runtime.execution,
      startedAt: runtime.execution.createdAt,
      finishedAt: r.clock.now(),
      observedAt: r.clock.now(),
      outcome: "failed" as const,
      terminalAt: null,
      logDigest: "c".repeat(64),
    };
    const saved = await r.release.writeRelease(
      parseReleaseStateSnapshotV1({
        ...release.value.snapshot,
        stateHead: release.value.head,
        sequence: release.value.snapshot.sequence + 1,
        updatedAt: r.clock.now(),
        hostedRuntimes: [{
          ...runtime,
          execution: null,
          lastExecutionProof: failedProof,
          updatedAt: r.clock.now(),
        }],
      }),
      release.value.head,
    );
    assert.ok(
      saved.ok && saved.value.status === "applied",
      JSON.stringify(saved),
    );
    const binding = {
      runtimeSha: r.sha,
      generation: 1,
      run: planner.plan.run,
      repairCommit: producerRepair.value.head,
      releaseCommit: saved.value.head,
      planDigest: planner.planDigest,
      expectedProvider: PROVIDER,
      cells: planner.plan.cells.map((cell) => ({
        reservationId: cell.reservationId,
        taskId: cell.taskId,
        repository: cell.repository,
        base: cell.expectedBase,
      })),
    };
    const input = assembly;
    const deps = {
      state: r.store,
      clock: r.clock,
      configs: input.configs,
      cycleFor: (config: typeof input.configs[number]) => ({
        ...input,
        github: input.composeGithub(config),
        model: refusing,
        externalImplementations: true,
      }),
      prepareTarget: (config: typeof input.configs[number]) =>
        input.prepareTarget!(config),
      importerFor: (config: typeof input.configs[number], bundlesDir: string) =>
        createGitBundleImporter({
          repositoryDir: input.host!.sourcePathFor(config),
          bundlesDir,
        }),
      transportFor: () => ({
        confirmCompletedExecution: () => Promise.resolve(true),
        recover: (
          { requests }: { requests: readonly { reservationId: string }[] },
        ) =>
          Promise.resolve([{
            plan: planner.plan,
            planDigest: planner.planDigest,
            results: results.filter((result) =>
              requests.some((request) =>
                request.reservationId === result.reservationId
              )
            ),
            bundlesDir: archive,
            provenance: {
              run: planner.plan.run,
              plannerJobId: 101,
              cellJobIds: [102, 103, 104, 105],
            },
          }]),
      }),
      readExecution: () => Promise.resolve(portOk(failedProof)),
      binding,
    };
    assert.equal(
      closedCWaveNeedsRecovery(producerRepair.value.snapshot, binding),
      true,
      "unsettled original charges cannot retire",
    );
    const writeRepair = input.state.writeRepair.bind(input.state);
    let refusedCandidate = false;
    input.state.writeRepair = (snapshot, expectedHead) => {
      if (
        snapshot.work.some((row) =>
          row.repository.name === "sentinel" &&
          row.intent?.kind === "candidate_preservation"
        )
      ) {
        refusedCandidate = true;
        return Promise.resolve(
          portOk({ status: "conflict", currentHead: expectedHead }),
        );
      }
      return writeRepair(snapshot, expectedHead);
    };
    await assert.rejects(
      () => ingestClosedCWave(deps),
      /ingestion incomplete|readback unavailable/,
    );
    input.state.writeRepair = writeRepair;
    assert.equal(refusedCandidate, true);
    const partial = await r.store.readRepair();
    assert.ok(partial.ok && partial.value.status === "found");
    assert.equal(
      partial.value.snapshot.reservations.filter((row) =>
        row.outcome === "submitted"
      ).length,
      1,
    );
    assert.equal(
      closedCWaveNeedsRecovery(partial.value.snapshot, binding),
      true,
      "settled charge plus still-active original implementation cannot retire partial ingestion",
    );
    await assert.rejects(
      () =>
        ingestClosedCWave({
          ...deps,
          transportFor: () => ({
            confirmCompletedExecution: () => Promise.resolve(true),
            recover: () => {
              throw new Error("original archive unavailable");
            },
          }),
        }),
      /original archive unavailable/,
    );
    assert.deepEqual(
      await r.store.readRepair(),
      partial,
      "partial/unsettled scope cannot silently bypass custody or change state",
    );
    const first = await ingestClosedCWave(deps);
    const maintenance = await runHostedAutonomy({
      state: r.store,
      clock: r.clock,
      githubFor: () => {
        throw new Error(
          "maintenance must not follow ingestion with ordinary actions",
        );
      },
      historicalMatrix: {
        state: r.store,
        clock: r.clock,
        budget: input.budget,
        readExecution: () => {
          throw new Error(
            "legacy rejection must follow successful C ingestion on a later pass",
          );
        },
        transport: deps.transportFor(),
      },
      closedMatrix: () => Promise.resolve(deps),
    });
    assert.equal(maintenance.status, "skipped");
    assert.equal(
      first.dispositions.filter((row) => row.outcome === "submitted").length,
      3,
    );
    assert.equal(
      first.dispositions.filter((row) => row.outcome === "ambiguous").length,
      2,
    );
    assert.equal(
      first.dispositions.filter((row) =>
        row.intentKind === "candidate_preservation"
      ).length,
      2,
    );
    const protectedRow = first.dispositions.find((row) =>
      row.taskId.includes("ai.ubq.fi-1")
    )!;
    assert.equal(protectedRow.nextStep, "blocked");
    assert.equal(protectedRow.intentKind, null);
    assert.ok(protectedRow.head);
    assert.equal(protectedRow.checkpoint, null);
    const settled = await r.store.readRepair();
    assert.ok(settled.ok && settled.value.status === "found");
    assert.equal(
      closedCWaveHandledReservations(settled.value.snapshot, binding).size,
      5,
    );
    for (const config of input.configs) {
      const source = input.host!.sourcePathFor(config);
      await Deno.remove(source, { recursive: true });
      await checked(r.root, [
        "clone",
        "-q",
        config.repository.name === "sentinel"
          ? r.root + "/seed"
          : r.root + "/foreign",
        source,
      ], r.env);
    }
    const replay = await ingestClosedCWave(deps);
    assert.equal(
      replay.repairHead,
      first.repairHead,
      "rehydration must not resettle or mutate state",
    );
    for (
      const result of results.filter((row) =>
        row.bundle !== null && !row.taskId.endsWith("ai.ubq.fi-1")
      )
    ) {
      const config = input.configs.find((row) =>
        row.repository.name === result.repository.name
      )!;
      assert.ok(
        (await gitRun(input.host!.sourcePathFor(config), [
          "cat-file",
          "-e",
          result.bundle!.head + "^{commit}",
        ], r.env)).ok,
      );
    }
    const originalCharges = await r.store.readRepair();
    assert.ok(originalCharges.ok && originalCharges.value.status === "found");
    const retryPlans = planHostedRetries(
      originalCharges.value.snapshot,
      r.clock.now(),
      ATTEMPT_RUNTIME,
    );
    assert.equal(
      retryPlans.length,
      2,
      "real incomplete receipts produce two legitimate maintenance retry plans",
    );
    const retried = await r.store.writeRepair(
      applyHostedRetries(
        originalCharges.value.snapshot,
        originalCharges.value.head,
        retryPlans,
        r.clock.now(),
      ),
      originalCharges.value.head,
    );
    assert.ok(retried.ok && retried.value.status === "applied");
    const afterRetry = await r.store.readRepair();
    assert.ok(afterRetry.ok && afterRetry.value.status === "found");
    const closing = afterRetry.value.snapshot.work.find((row) =>
      row.id.endsWith("ai.ubq.fi-3")
    )!;
    const retirementPlans = planHostedRetirements(
      afterRetry.value.snapshot,
      new Set([
        hostedIssueKey(closing.repository, closing.related.issueNumber!),
      ]),
    );
    assert.equal(retirementPlans.length, 1);
    const closed = await r.store.writeRepair(
      applyHostedRetirements(
        afterRetry.value.snapshot,
        afterRetry.value.head,
        retirementPlans,
        r.clock.now(),
      ),
      afterRetry.value.head,
    );
    assert.ok(closed.ok && closed.value.status === "applied");
    const beforeRecovered = await r.store.readRepair();
    assert.ok(beforeRecovered.ok && beforeRecovered.value.status === "found");
    assert.deepEqual(
      beforeRecovered.value.snapshot.reservations,
      originalCharges.value.snapshot.reservations,
      "retry and source retirement preserve all original charges",
    );
    const recoveredAfterProgress = await ingestClosedCWave(deps);
    assert.equal(
      recoveredAfterProgress.repairHead,
      beforeRecovered.value.head,
      "recovery hydrates active preservation without reopening consumed ambiguous operations",
    );
    await assert.rejects(
      () =>
        ingestClosedCWave({
          ...deps,
          readExecution: () =>
            Promise.resolve(
              portOk({ ...failedProof, logDigest: "d".repeat(64) }),
            ),
        }),
      /native failure proof changed/,
    );
    const self = input.configs.find((config) =>
      config.repository.name === "sentinel"
    )!;
    await runRepairCycle({ ...deps.cycleFor(self), configs: [self] }, {
      deadline: r.clock.now() + 240_000,
      stepLimit: 1,
      modelStartsEnabled: false,
    });
    let published = await r.store.readRepair();
    assert.ok(published.ok && published.value.status === "found");
    for (
      let step = 0;
      step < 3 &&
      published.value.snapshot.work.find((row) =>
          row.repository.name === "sentinel"
        )!.target.pr === null;
      step++
    ) {
      await runRepairCycle({ ...deps.cycleFor(self), configs: [self] }, {
        deadline: r.clock.now() + 240_000,
        stepLimit: 1,
        modelStartsEnabled: false,
      });
      published = await r.store.readRepair();
      assert.ok(published.ok && published.value.status === "found");
    }
    const sibling = published.value.snapshot.work.find((row) =>
      row.repository.name === "sentinel"
    )!;
    assert.ok(
      sibling.target.pr !== null && sibling.target.head !== null &&
        sibling.target.candidateState?.preserved !== null,
      "actual consumer publishes the consumed sibling before refreshing its base",
    );
    const source = input.host!.sourcePathFor(self);
    await checked(
      source,
      ["checkout", "-q", "-b", "fixture-new-base", r.sha],
      r.env,
    );
    await Deno.writeTextFile(source + "/new-base.txt", "base moved\n");
    await checked(source, ["add", "new-base.txt"], r.env);
    await checked(source, ["commit", "-q", "-m", "new base"], r.env);
    const newBase = await checked(
      source,
      ["rev-parse", "HEAD"],
      r.env,
    ) as GitSha;
    await checked(source, [
      "checkout",
      "-q",
      "-b",
      "fixture-refreshed-head",
      sibling.target.head!,
    ], r.env);
    await checked(source, ["merge", "-q", "--no-edit", newBase], r.env);
    const refreshedHead = await checked(
      source,
      ["rev-parse", "HEAD"],
      r.env,
    ) as GitSha;
    const selfGithub = r.github.get("Ubiquity-Sentinel/sentinel")!;
    selfGithub.prepareBaseRefresh = () =>
      Promise.resolve(portOk(refreshedHead));
    const refresh = await r.store.writeRepair(
      applyHostedRetries(published.value.snapshot, published.value.head, [{
        id: sibling.id,
        repository: sibling.repository,
        grant: 0,
        nextStep: "work",
        reviewRounds: null,
        advanceBase: true,
        observedBase: newBase,
        detail: "fixture trusted base advancement",
      }], r.clock.now()),
      published.value.head,
    );
    assert.ok(refresh.ok && refresh.value.status === "applied");
    await runRepairCycle({ ...deps.cycleFor(self), configs: [self] }, {
      deadline: r.clock.now() + 240_000,
      stepLimit: 1,
      modelStartsEnabled: false,
    });
    const progressed = await r.store.readRepair();
    assert.ok(progressed.ok && progressed.value.status === "found");
    assert.equal(
      progressed.value.snapshot.work.find((row) => row.id === sibling.id)!
        .target.head,
      refreshedHead,
    );
    assert.equal(
      progressed.value.snapshot.work.find((row) => row.id === sibling.id)!
        .target.base,
      newBase,
    );
    const activeRecovery = await ingestClosedCWave(deps);
    assert.equal(
      activeRecovery.dispositions.length,
      1,
      "only the other still-actionable C preservation is read back",
    );
    assert.equal(
      activeRecovery.repairHead,
      progressed.value.head,
      "base-refreshed sibling remains unchanged while another candidate hydrates",
    );
    const foreign = input.configs.find((config) =>
      config.repository.name === "ai.ubq.fi"
    )!;
    await runRepairCycle({ ...deps.cycleFor(foreign), configs: [foreign] }, {
      deadline: r.clock.now() + 240_000,
      stepLimit: 1,
      modelStartsEnabled: false,
    });
    const ready = await r.store.readRepair();
    assert.ok(ready.ok && ready.value.status === "found");
    const newRetry = ready.value.snapshot.work.find((row) =>
      row.id.endsWith("ai.ubq.fi-2")
    )!;
    const retryCycle = { ...deps.cycleFor(foreign), configs: [foreign] };
    const retryContext = await loadRepairContext(
      retryCycle,
      createRunBounds(retryCycle, {
        deadline: input.deadline,
        runStartedAt: r.clock.now(),
        modelStartsEnabled: true,
      }),
    );
    assert.ok(retryContext);
    const nextAdmission = await prepareImplementationStart(
      retryCycle,
      retryContext,
      newRetry,
      foreign,
    );
    assert.equal(nextAdmission.kind, "prepared", JSON.stringify(nextAdmission));
    const retired = await r.store.readRepair();
    assert.ok(retired.ok && retired.value.status === "found");
    assert.equal(
      retired.value.snapshot.work.find((row) => row.id.includes("sentinel-1"))
        ?.intent,
      null,
      "actual preservation consumer must finish actionable custody",
    );
    const liveNewRetry = retired.value.snapshot.work.find((row) =>
      row.id === newRetry.id
    )!;
    assert.ok(liveNewRetry.intent?.requestId);
    assert.equal(
      closedCWaveHandledReservations(retired.value.snapshot, binding).has(
        liveNewRetry.intent!.requestId!,
      ),
      false,
      "new retry request is not in the retired original scope",
    );
    assert.equal(
      closedCWaveNeedsRecovery(retired.value.snapshot, binding),
      false,
      "handled protected BLOCKED candidate cannot keep old archives a global prerequisite",
    );
    for (const missing of [false, true]) {
      const unavailable = {
        ...deps,
        transportFor: () => ({
          recover: () => {
            throw new Error(missing ? "archive missing" : "archive expired");
          },
        }),
      };
      const noop = await ingestClosedCWave(unavailable);
      assert.equal(
        noop.dispositions.length,
        0,
        "fully retired scope performs no old artifact/history IO",
      );
      const maintenance = await runHostedAutonomy({
        state: r.store,
        clock: r.clock,
        githubFor: () => null,
        closedMatrix: () => Promise.resolve(unavailable),
      });
      assert.notEqual(
        maintenance.status,
        "failed",
        "retired protected disposition cannot block automatic maintenance on expired or missing archives",
      );
      assert.deepEqual(
        await r.store.readRepair(),
        retired,
        "retirement preserves blocked head/checkpoint, charges and all state",
      );
    }
  } finally {
    await r.cleanup();
  }
});
