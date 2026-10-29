/** Native matrix planner and cell executable composition. */
import { parseMatrixPlanV1 } from "../contracts/matrix.ts";
import { QUEUE_CUSTODY_IDLE_DETAIL } from "./actions-queue-custody.ts";
import type {
  MatrixCellGrantV1,
  MatrixCellResultV1,
} from "../contracts/matrix.ts";
import { createRunBounds, prepareMatrixIntakeV1 } from "../repair/loop.ts";
import {
  childRunDeadlineV1,
  runActionsRepairHost,
  runActionsTargetCycles,
} from "./actions.ts";
import {
  type MatrixPlanReportV1,
  runMatrixCell,
  runMatrixPlanEntrypoint,
  writeMatrixPlanReport,
} from "./matrix.ts";
import { createGitBundleExporter } from "./matrix-git.ts";
import {
  matrixPlanDiagnosticLineOf,
  type MatrixPlanDiagnosticLineV1,
} from "./matrix-plan-diagnostic.ts";
import {
  type ActionsMatrixHostDepsV1,
  configured,
  disabledResult,
  hostOf,
  matrixPlanCarrierOf,
  parseCarrier,
  readMatrixNativeCarrier,
  readPlan,
  targetDeps,
  writeResult,
} from "./matrix-actions-shared.ts";

export async function runActionsMatrixHost(
  deps: ActionsMatrixHostDepsV1 = {},
): Promise<
  (MatrixPlanReportV1 & { planDigest: string }) | MatrixCellResultV1
> {
  const job = deps.env === undefined
    ? Deno.env.get("GITHUB_JOB")
    : deps.env.GITHUB_JOB;
  if (job !== "matrix_plan" && job !== "matrix_cell") {
    throw new Error("matrix executable requires its native job identity");
  }
  const carrier = job === "matrix_cell"
    ? parseCarrier(deps.carrier ?? await readMatrixNativeCarrier(true), true)
    : null;
  let result:
    | (MatrixPlanReportV1 & { planDigest: string })
    | MatrixCellResultV1
    | null = null;
  const hosted = await runActionsRepairHost({
    ...deps,
    job,
    // The plan and its cells repair issues only, like the ordinary repair
    // job: no hosted gateway capability is ever composed here, so a gateway
    // adapter would only run an unavailable incident scan per plan and skip
    // the GitHub-only dependency gates before a cell's model start.
    issueOnly: deps.issueOnly ?? true,
    runTargetCycles: async (input) => {
      const host = hostOf(input);
      if (job === "matrix_plan") {
        const deadline = Math.min(
          input.deadline,
          childRunDeadlineV1(host.execution.createdAt),
        );
        // Only source intake and fresh branch assignment precede the manifest.
        // The serialized aggregate retains unrelated lifecycle reconciliation.
        const cycles = await runActionsTargetCycles({
          ...input,
          deadline,
          modelStartsEnabled: false,
          externalImplementations: true,
          runCycle: async (deps, options) => {
            const outcome = await prepareMatrixIntakeV1(deps, {
              ...options,
              runStartedAt: host.execution.createdAt,
            });
            if (outcome.status === "state_error") {
              throw new Error("matrix intake authoritative state failed");
            }
            return outcome;
          },
        });
        const configs = input.configs.filter((config) =>
          cycles.addressed.includes(
            config.repository.owner + "/" + config.repository.name,
          )
        );
        const first = configs[0];
        if (first === undefined) {
          throw new Error("matrix planner addressed no configured target");
        }
        const pooled = { ...input, configs };
        result = await runMatrixPlanEntrypoint({
          deps: targetDeps(pooled, first),
          options: {
            waveId: host.execution.id,
            run: host.run,
            runtimeSha: input.controllerSha,
            generation: host.execution.generation,
            deadline,
            runStartedAt: host.execution.createdAt,
            plannedAt: input.clock.now(),
            modelStartsEnabled: input.modelStartsEnabled,
            githubForRepository: (repository) =>
              pooled.composeGithub(configured(pooled, repository)),
          },
          planPath: host.artifactRoot + "/plan.json",
        });
        const planned = result;
        const include = planned.plan.cells.map((cell) => ({
          cellId: cell.cellId,
          planDigest: planned.planDigest,
        }));
        const output = deps.env === undefined
          ? Deno.env.get("GITHUB_OUTPUT")
          : deps.env.GITHUB_OUTPUT;
        if (output === undefined || output.length === 0) {
          throw new Error("native matrix planner output is unavailable");
        }
        await Deno.writeTextFile(
          output,
          "matrix=" + JSON.stringify({ include }) + "\nplanDigest=" +
            result.planDigest + "\nhasCells=" + String(include.length > 0) +
            "\n",
          { append: true },
        );
        console.log(JSON.stringify(matrixPlanCarrierOf({
          waveId: result.plan.waveId,
          run: host.run,
          controllerSha: input.controllerSha,
          generation: host.execution.generation,
          planDigest: result.planDigest,
          prepared: result.prepared,
        })));
        // A zero-cell plan says why, per repository (C5.1), after the carrier.
        if (planned.diagnostic !== undefined) {
          printPlanDiagnostic(() =>
            matrixPlanDiagnosticLineOf({
              waveId: planned.plan.waveId,
              prepared: planned.prepared,
              cause: "planner",
              diagnostic: planned.diagnostic,
            })
          );
        }
        return cycles;
      }
      if (carrier === null) {
        throw new Error("matrix cell lacks native selection");
      }
      const plan = await readPlan(host.artifactRoot, carrier.planDigest);
      if (
        plan.run.runId !== host.run.runId ||
        plan.run.runAttempt !== host.run.runAttempt ||
        plan.run.launcherSha !== host.run.launcherSha
      ) throw new Error("matrix plan belongs to another native execution");
      const cell = plan.cells.find((entry) => entry.cellId === carrier.cellId);
      if (cell === undefined) {
        throw new Error("native matrix cell is absent from its plan");
      }
      const grant: MatrixCellGrantV1 = {
        waveId: plan.waveId,
        run: plan.run,
        cell,
      };
      if (
        cell.runtimeSha !== input.controllerSha ||
        cell.generation !== host.execution.generation
      ) throw new Error("matrix cell runtime identity is stale");
      const config = configured(input, cell.repository);
      if (!input.modelStartsEnabled) {
        result = disabledResult(grant, input.clock.now());
      } else {
        await input.prepareTarget?.(config);
        const github = input.composeGithub(config);
        // A queued cell anchors its OWN bounded start window at this trusted
        // child invocation, never at the earlier prepare-time execution
        // creation: a long planner run or runner queue must not spend the
        // cell's window before its runner starts. The child's own absolute
        // deadline and every generation/lease/binding check below are
        // unchanged, so a cell with insufficient remaining time in its own
        // actual execution still refuses.
        const cellOrigin = input.runOrigin ?? host.execution.createdAt;
        result = await runMatrixCell(
          {
            clock: input.clock,
            bounds: createRunBounds(targetDeps(input, config), {
              deadline: Math.min(
                input.deadline,
                childRunDeadlineV1(cellOrigin),
              ),
              runStartedAt: cellOrigin,
              modelStartsEnabled: input.modelStartsEnabled,
            }),
            sessionBound: config.sessionBound,
            state: {
              readRepair: () => input.state.readRepair(),
              readRelease: () => input.state.readRelease(),
            },
            github: { readIssue: (number) => github.readIssue(number) },
            model: input.model,
            bundle: createGitBundleExporter({
              repositoryDir: host.sourcePathFor(config),
              outputDir: host.artifactRoot,
            }),
            ...(input.composeCiEvidence === undefined
              ? {}
              : { ciEvidence: input.composeCiEvidence(config) }),
          },
          grant,
          {
            run: host.run,
            runtimeSha: input.controllerSha,
            generation: host.execution.generation,
          },
          input.clock.now(),
        );
      }
      await writeResult(host.artifactRoot, result);
      return {
        outcome: { status: "idle", detail: "matrix cell settled" },
        addressed: [config.repository.owner + "/" + config.repository.name],
        skipped: [],
        failed: [],
      };
    },
  });
  if (
    result === null && job === "matrix_plan" &&
    hosted.outcome.status === "idle" &&
    hosted.outcome.detail === QUEUE_CUSTODY_IDLE_DETAIL
  ) {
    // The actual host verified this execution and started no ordinary cycle.
    // An empty manifest records zero grants; it claims no successful queue read.
    const execution = hosted.execution;
    const plan = parseMatrixPlanV1({
      version: "v1",
      kind: "matrix_plan",
      waveId: execution.id,
      run: {
        runId: execution.runId,
        runAttempt: execution.runAttempt,
        launcherSha: execution.launcherSha,
      },
      plannedAt: deps.clock?.now() ?? Date.now(),
      cells: [],
    });
    const root = (deps.workDir ?? Deno.cwd()) + "/../.sentinel-matrix";
    result = await writeMatrixPlanReport({
      plan,
      attempted: 0,
      prepared: 0,
      notReady: 0,
      deferred: 0,
      memoryRefused: 0,
    }, root + "/plan.json");
    const output = deps.env === undefined
      ? Deno.env.get("GITHUB_OUTPUT")
      : deps.env.GITHUB_OUTPUT;
    if (output === undefined || output.length === 0) {
      throw new Error("native matrix planner output is unavailable");
    }
    await Deno.writeTextFile(
      output,
      'matrix={"include":[]}\nplanDigest=' + result.planDigest +
        "\nhasCells=false\n",
      { append: true },
    );
    console.log(
      JSON.stringify(
        matrixPlanCarrierOf({
          waveId: plan.waveId,
          run: plan.run,
          controllerSha: hosted.controllerSha,
          generation: execution.generation,
          planDigest: result.planDigest,
          prepared: 0,
        }),
      ),
    );
    printPlanDiagnostic(() =>
      matrixPlanDiagnosticLineOf({
        waveId: plan.waveId,
        prepared: 0,
        cause: "queue_custody_idle",
      })
    );
  }
  if (result === null) throw new Error("matrix executable produced no result");
  return result;
}

/** Advisory only: building or printing the line never changes the plan. */
function printPlanDiagnostic(line: () => MatrixPlanDiagnosticLineV1): void {
  try {
    console.log(JSON.stringify(line()));
  } catch {
    // The carrier already printed; the diagnostic is a convenience.
  }
}
