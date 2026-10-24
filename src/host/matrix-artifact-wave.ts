/** Authenticated wave, grant, cell and bundle recovery against frozen custody. */
import { hasBlockingSeverity } from "../contracts/review-receipt.ts";
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS as TOLERANCE,
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY as REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  type HostedExecutionIntentV1,
} from "../contracts/hosted-supervisor.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { isGitSha } from "../contracts/brands.ts";
import {
  matrixCellIdV1,
  type MatrixCellPlanV1,
  matrixDigestV1,
  parseMatrixCellResultV1,
  parseMatrixPlanV1,
} from "../contracts/matrix.ts";
import { candidateBranch } from "../repair/keys.ts";
import { isCiCorrectionFinding } from "../repair/ci-rejection.ts";
import { conflictResolutionInFlight } from "../repair/conflict-resolution.ts";
import {
  MATRIX_CELL_LOG_SETTLE_MS,
  type MatrixArtifactRequestV1,
  type MatrixAuthenticatedWaveV1,
  MatrixMissingCellArtifactError,
  type MatrixRejectedCellEvidenceV1,
  type MatrixRejectedWaveV1,
} from "./matrix-artifact-port.ts";
import { MatrixHistoricalRuntimeMismatch } from "./matrix-artifact-port.ts";
import {
  bytesDigest,
  instant,
  type Json,
  positive,
  record,
  refuse,
  sameRepo,
  sameRun,
  sha,
} from "./matrix-artifact-values.ts";
import type {
  MatrixArtifactOptionsV1,
  MatrixArtifactReaderV1,
  MatrixArtifactRecoveryInputV1,
} from "./matrix-artifact-context.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { createMatrixArtifactArchive } from "./matrix-artifact-archive.ts";
import {
  type createMatrixArtifactMarker,
  MatrixNativeLogUnserved,
  unservedLog,
} from "./matrix-artifact-native.ts";

const API = `https://api.github.com/repos/${REPOSITORY}/actions`;

export async function recoverMatrixArtifactWaves(context: {
  options: MatrixArtifactOptionsV1;
  input: MatrixArtifactRecoveryInputV1;
  snapshot: RepairStateSnapshotV1;
  repairHead: GitSha;
  requested: Map<string, MatrixArtifactRequestV1>;
  saved: HostedExecutionIntentV1[];
  artifacts: Json[];
  plans: Json[];
  staging: string;
  reader: MatrixArtifactReaderV1;
  archive: ReturnType<typeof createMatrixArtifactArchive>;
  marker: ReturnType<typeof createMatrixArtifactMarker>;
}) {
  const {
    options,
    input,
    snapshot,
    repairHead,
    requested,
    saved,
    artifacts,
    plans,
    staging,
    archive,
    marker,
  } = context;
  const { json, pages } = context.reader;
  const names = artifacts.map((row) => row.name);
  const recovered: MatrixAuthenticatedWaveV1[] = [];
  const rejected: MatrixRejectedWaveV1[] = [];
  const seen = new Set<string>();
  artifactWaves: for (const artifact of plans) {
    const [, runId, runAttempt] = (artifact.name as string).match(
      /^sentinel-matrix-plan-(\d+)-(\d+)$/,
    )!;
    const runIdentity = {
      runId: positive(Number(runId)),
      runAttempt: positive(Number(runAttempt)),
    };
    if (
      input.currentRun &&
      !sameRun(input.currentRun, {
        ...runIdentity,
        launcherSha: input.launcherSha,
      })
    ) continue;
    const planFiles = await archive(artifact);
    if (planFiles.size !== 1 || !planFiles.has("plan.json")) refuse();
    const plan = parseMatrixPlanV1(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          planFiles.get("plan.json"),
        ),
      ),
    );
    // Artifact contents only select relevant grants; native provenance below remains mandatory.
    if (
      !input.rejectionProof &&
      input.currentRun === undefined &&
      !plan.cells.some((cell) => requested.has(cell.reservationId))
    ) {
      continue;
    }
    const attempt = await json(
      `${API}/runs/${runIdentity.runId}/attempts/${runIdentity.runAttempt}`,
    );
    const repo = record(attempt.repository),
      headRepo = record(attempt.head_repository);
    // A historical selected run binds to its OWN authenticated native
    // attempt head, never to the current caller's launcher and never to
    // a plan-supplied SHA. Only the exact current run stays pinned to the
    // trusted caller launcher.
    const nativeLauncher = attempt.head_sha;
    if (!isGitSha(nativeLauncher)) refuse();
    const run = {
      ...runIdentity,
      launcherSha: input.currentRun === undefined
        ? nativeLauncher
        : input.launcherSha,
    };
    if (
      attempt.id !== run.runId ||
      attempt.run_attempt !== run.runAttempt ||
      attempt.workflow_id !== HOSTED_SUPERVISOR_WORKFLOW_ID ||
      attempt.path !== HOSTED_SUPERVISOR_WORKFLOW_PATH ||
      attempt.event !== "workflow_dispatch" ||
      attempt.head_branch !==
        HOSTED_SUPERVISOR_REF.replace("refs/heads/", "") ||
      attempt.head_sha !== run.launcherSha ||
      repo.full_name !== REPOSITORY || headRepo.full_name !== REPOSITORY
    ) refuse();
    positive(repo.id);
    positive(headRepo.id);
    const artifactIdentity = (row: Json) => {
      const provenance = record(row.workflow_run);
      if (
        provenance.id !== run.runId ||
        provenance.repository_id !== repo.id ||
        provenance.head_repository_id !== headRepo.id ||
        provenance.head_branch !== attempt.head_branch ||
        provenance.head_sha !== run.launcherSha
      ) refuse();
    };
    artifactIdentity(artifact);
    const jobs = await pages(
      `/runs/${run.runId}/attempts/${run.runAttempt}/jobs`,
      "jobs",
    );
    const planners = jobs.filter((job) => job.name === "matrix_plan");
    if (planners.length !== 1 || planners[0].conclusion !== "success") {
      refuse();
    }
    // Only the aggregate's separate trusted consumer identity can enable
    // rejection-only historical inspection. Current-run discovery and
    // every other caller retain their strict runtime match.
    const historical = input.currentRun === undefined &&
      input.consumerRun !== undefined &&
      (run.runId !== input.consumerRun.runId ||
        run.runAttempt !== input.consumerRun.runAttempt);
    const planner = await marker(
      planners[0],
      "Plan isolated issue matrix",
      "sentinel_matrix_plan",
      run,
      historical ? null : input.runtimeSha,
    );
    const waveRuntime = planner.runtimeSha as typeof input.runtimeSha;
    const runtimeMismatch = waveRuntime !== input.runtimeSha;
    const waveId = `${run.runId}:${run.runAttempt}:repair`;
    if (
      planner.waveId !== waveId ||
      !Number.isSafeInteger(planner.prepared) ||
      (planner.prepared as number) < 0 ||
      (planner.prepared as number) > 256
    ) refuse();
    for (
      const execution of saved.filter((value) =>
        value.runId === run.runId && value.runAttempt === run.runAttempt
      )
    ) {
      if (
        !sameRun(run, execution) || execution.id !== waveId ||
        execution.revision !== waveRuntime ||
        execution.generation !== planner.generation
      ) refuse();
    }
    const planDigest = sha(planner.planDigest);
    if (
      await matrixDigestV1(plan) !== planDigest ||
      plan.waveId !== waveId || !sameRun(run, plan.run) ||
      planner.prepared !== plan.cells.length
    ) refuse();
    if (
      input.rejectionProof &&
      (plan.plannedAt < input.rejectionProof.execution.createdAt ||
        plan.plannedAt > options.clock.now() + TOLERANCE)
    ) refuse();
    const selected: MatrixCellPlanV1[] = [];
    const affected: MatrixRejectedWaveV1["affected"][number][] = [];
    let malformed = false;
    const ids = new Set<string>();
    for (const cell of plan.cells) {
      if (
        ids.has(cell.cellId) ||
        cell.cellId !==
          await matrixCellIdV1(waveId, cell.taskId, cell.reservationId) ||
        cell.runtimeSha !== waveRuntime ||
        cell.generation !== planner.generation ||
        await matrixDigestV1(cell.request) !== cell.requestDigest ||
        cell.request.taskId !== cell.taskId ||
        !sameRepo(cell.request.repository, cell.repository) ||
        cell.request.base !== cell.expectedBase
      ) refuse();
      ids.add(cell.cellId);
      const request = requested.get(cell.reservationId);
      if (!request) continue;
      if (
        cell.taskId !== request.taskId ||
        !sameRepo(cell.repository, request.repository) ||
        cell.intentKey !== request.intentKey ||
        cell.expectedBase !== request.expectedBase ||
        seen.has(cell.reservationId)
      ) refuse();
      const task = snapshot.work.find((row) =>
        row.id === cell.taskId &&
        sameRepo(row.repository, cell.repository)
      )!;
      if (
        task.intent?.kind === "implementation" &&
        cell.request.checkoutBase !== undefined &&
        (task.source.kind !== "issue" ||
          cell.request.checkoutBase !== task.target.head ||
          task.target.pr === null ||
          // A conflict resolution continues the published candidate its
          // marked implementation intent was admitted for: no findings, the
          // durable base unchanged and the marker naming this exact merged
          // base (generation 78+; generation 77 refuses the key itself).
          (cell.request.mergeBase !== undefined
            ? cell.request.reviewFindings !== undefined ||
              cell.request.base !== task.target.base ||
              conflictResolutionInFlight(task.intent) !==
                cell.request.mergeBase
            : (cell.request.reviewFindings?.length ?? 0) === 0 ||
              // A correction continues only from a head that a completed review
              // refused, or from a head reviewed clean against this exact base
              // whose live CI attribution the trusted planner carried as its own
              // digest-bound CI finding (no CI evidence is ever persisted), or
              // (CI first, generation 80+) from a head no completed review
              // binds whose CI fix the planner charged in `counters.retries`
              // with that finding first against the record's exact base.
              (!snapshot.reviews.some((review) =>
                sameRepo(review.repository, task.repository) &&
                review.pullRequest.number === task.target.pr &&
                review.pullRequest.head === cell.request.checkoutBase &&
                review.outcome === "completed" &&
                review.unresolvedSeverities.length > 0
              ) &&
                !(isCiCorrectionFinding(cell.request.reviewFindings![0]) &&
                  cell.request.base === task.target.base &&
                  (snapshot.reviews.some((review) =>
                    sameRepo(review.repository, task.repository) &&
                    review.pullRequest.number === task.target.pr &&
                    review.pullRequest.head === cell.request.checkoutBase &&
                    review.pullRequest.base === task.target.base &&
                    review.outcome === "completed" &&
                    !hasBlockingSeverity(review.unresolvedSeverities)
                  ) ||
                    (task.counters.retries >= 1 &&
                      !snapshot.reviews.some((review) =>
                        sameRepo(review.repository, task.repository) &&
                        review.pullRequest.number === task.target.pr &&
                        review.pullRequest.head ===
                          cell.request.checkoutBase &&
                        review.outcome === "completed"
                      )))))))
      ) refuse();
      const reservation = snapshot.reservations.find((row) =>
        row.id === cell.reservationId
      )!;
      if (plan.plannedAt > options.clock.now() + TOLERANCE) refuse();
      if (reservation.createdAt > plan.plannedAt) {
        if (!input.rejectionProof) refuse();
        malformed = true;
      }
      if (input.rejectionProof) {
        if (
          task.intent?.kind !== "implementation" ||
          task.target.candidateState !== undefined ||
          (task.target.head !== null &&
            task.target.head !== task.target.base) ||
          task.source.kind !== "issue" ||
          cell.request.issue?.number !== task.related.issueNumber ||
          canonicalStringify(cell.request.evidence) !==
            canonicalStringify(task.evidence) ||
          (reservation.outcome !== "reserved" &&
            reservation.outcome !== "ambiguous") ||
          plan.plannedAt < input.rejectionProof.execution.createdAt ||
          reservation.createdAt <
            input.rejectionProof.execution.createdAt ||
          task.intent.startedAt < reservation.createdAt ||
          task.intent.startedAt > options.clock.now() + TOLERANCE ||
          reservation.createdAt > options.clock.now() + TOLERANCE
        ) refuse();
        affected.push({
          request: cell.request,
          requestDigest: cell.requestDigest,
          work: task,
          workDigest: await matrixDigestV1(task),
          reservation,
          reservationDigest: await matrixDigestV1(reservation),
        });
      }
      seen.add(cell.reservationId);
      selected.push(cell);
    }
    if (input.rejectionProof && !malformed) {
      // A non-malformed plan carries no reservation-after-manifest
      // claim: no reservation postdates the plan manifest. The
      // historical rejection skips it here, before downloading any
      // cell evidence — verifying cell results first would refuse on
      // legitimately executed cells (a healthy prior run whose records
      // remain in work for retry), deadlocking every later
      // maintenance on a plan the rejection skips anyway. No claim is
      // made, no record is touched.
      continue;
    }
    if (
      selected.length === 0 &&
      (input.rejectionProof || input.currentRun === undefined)
    ) continue;
    const bundlesDir = `${staging}/${run.runId}-${run.runAttempt}`;
    await Deno.mkdir(bundlesDir, { mode: 0o700 });
    const results = [], cellJobIds = [];
    let missingArtifacts = 0;
    const evidence: MatrixRejectedCellEvidenceV1[] = [];
    for (const cell of selected) {
      const name =
        `sentinel-matrix-cell-${run.runId}-${run.runAttempt}-${cell.cellId}`;
      if (names.filter((value) => value === name).length > 1) refuse();
      const cellArtifact = artifacts.find((row) => row.name === name);
      if (!cellArtifact) {
        if (input.rejectionProof) {
          // Trusted historical rejection: a missing cell artifact is its
          // own explicit uncertainty disposition. The trusted consumer
          // quarantines this exact record with a truthful reason instead
          // of re-selecting an endlessly unprovable historical wave.
          const captured = affected.find((row) =>
            row.reservation.id === cell.reservationId
          );
          const started = Date.parse(String(planners[0].started_at));
          const completed = Date.parse(String(planners[0].completed_at));
          if (
            !captured || typeof planners[0].started_at !== "string" ||
            typeof planners[0].completed_at !== "string" ||
            !Number.isSafeInteger(started) ||
            !Number.isSafeInteger(completed) || completed < started
          ) refuse();
          throw new MatrixMissingCellArtifactError(
            input.rejectionProof,
            captured,
          );
        }
        // Missing evidence never establishes non-submission, and a wave
        // that cannot be fully authenticated cannot isolate its
        // records: the unprovable cells stay charged and untouched
        // instead of deadlocking the supervisor on a permanently
        // missing artifact (never uploaded, expired or otherwise
        // lost). Only cells with complete authenticated evidence enter
        // the historical mismatch isolation below. Remove any
        // prematurely added affected entry so the unprovable record is
        // left untouched.
        missingArtifacts += 1;
        const affectedIndex = affected.findIndex(
          (entry) => entry.reservation.id === cell.reservationId,
        );
        if (affectedIndex >= 0) affected.splice(affectedIndex, 1);
        continue;
      }
      artifactIdentity(cellArtifact);
      const cellJobs = jobs.filter((job) =>
        job.name === `matrix_cell (${cell.cellId})`
      );
      if (cellJobs.length !== 1) refuse();
      if (cellJobs[0].status === "in_progress") {
        if (
          !input.currentRun || !sameRun(input.currentRun, run) ||
          attempt.status !== "in_progress" ||
          cellJobs[0].run_id !== run.runId ||
          cellJobs[0].run_attempt !== run.runAttempt ||
          cellJobs[0].head_sha !== run.launcherSha ||
          cellJobs[0].conclusion !== null
        ) refuse();
        positive(cellJobs[0].id);
        // Publication can precede native completion. Defer the entire wave:
        // omitted results otherwise become synthetic timeouts at ingestion.
        continue artifactWaves;
      }
      let cellMarker: Json;
      try {
        cellMarker = await marker(
          cellJobs[0],
          "Run isolated issue cell",
          "sentinel_matrix_cell",
          run,
          waveRuntime,
          unservedLog,
        );
      } catch (error) {
        if (!(error instanceof MatrixNativeLogUnserved)) throw error;
        // The job, its step and their times are already authenticated as
        // completed; only its log, or the marker in it, is not served yet.
        // Live (run 38881893136): a scan reached a cell seconds after its job
        // completed and refused the whole run; the next run authenticated the
        // same artifacts. For the consumer's own
        // in-progress run, shortly after completion, defer the entire wave
        // exactly like a running cell: nothing is ingested and every
        // producer stays charged. Elsewhere, or past the bound, it refuses.
        if (
          !input.rejectionProof && input.currentRun !== undefined &&
          sameRun(input.currentRun, run) &&
          attempt.status === "in_progress" &&
          options.clock.now() - instant(cellJobs[0].completed_at) <=
            MATRIX_CELL_LOG_SETTLE_MS
        ) continue artifactWaves;
        refuse();
      }
      if (
        cellMarker.cellId !== cell.cellId ||
        cellMarker.reservationId !== cell.reservationId ||
        cellMarker.generation !== cell.generation
      ) refuse();
      const files = await archive(cellArtifact);
      const raw = files.get("result.json");
      if (!raw) refuse();
      const result = parseMatrixCellResultV1(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
      );
      if (
        await matrixDigestV1(result) !== sha(cellMarker.resultDigest) ||
        result.waveId !== waveId || result.cellId !== cell.cellId ||
        result.taskId !== cell.taskId ||
        !sameRepo(result.repository, cell.repository) ||
        !sameRun(run, result.run) ||
        result.runtimeSha !== cell.runtimeSha ||
        result.generation !== cell.generation ||
        result.reservationId !== cell.reservationId ||
        result.intentKey !== cell.intentKey ||
        result.requestDigest !== cell.requestDigest ||
        result.status !== cellMarker.status ||
        result.completedAt > options.clock.now() + TOLERANCE
      ) refuse();
      const task = snapshot.work.find((row) =>
        row.id === cell.taskId &&
        sameRepo(row.repository, cell.repository)
      )!;
      if (
        input.rejectionProof && (result.status !== "not_started" ||
          result.receipt !== null || result.bundle !== null)
      ) refuse();
      if (task.intent?.kind === "candidate_preservation") {
        const reservation = snapshot.reservations.find((row) =>
          row.id === cell.reservationId
        )!;
        const checkpoint = task.target.checkpoint;
        if (
          result.status !== "completed" ||
          result.receipt?.outcome !== "completed" ||
          result.bundle === null ||
          result.bundle.head !== task.target.head ||
          result.receipt.candidate?.head !== task.target.head ||
          result.bundle.checkpointSha !== (checkpoint?.sha ?? null) ||
          result.receipt.candidate?.checkpointSha !==
            (checkpoint?.sha ?? null) ||
          (checkpoint !== null &&
            checkpoint.branch !== candidateBranch(task.id)) ||
          task.intent.startedAt + TOLERANCE < result.completedAt ||
          reservation.settledAt === null ||
          reservation.settledAt + TOLERANCE < result.completedAt
        ) refuse();
      }
      if (result.bundle) {
        const bundle = files.get(`${cell.cellId}.bundle`);
        if (
          files.size !== 2 || !bundle ||
          result.bundle.file !== `${cell.cellId}.bundle` ||
          result.bundle.digest !== cellMarker.bundleDigest ||
          await bytesDigest(bundle) !== result.bundle.digest
        ) refuse();
        await Deno.writeFile(
          `${bundlesDir}/${result.bundle.file}`,
          bundle,
          { createNew: true, mode: 0o600 },
        );
      } else if (files.size !== 1 || cellMarker.bundleDigest !== null) {
        refuse();
      }
      results.push(result);
      cellJobIds.push(positive(cellJobs[0].id));
      evidence.push({
        cellId: cell.cellId,
        taskId: cell.taskId,
        reservationId: cell.reservationId,
        status: result.status,
        receiptNull: result.receipt === null,
        bundleNull: result.bundle === null,
        completedAt: result.completedAt,
        resultDigest: sha(cellMarker.resultDigest),
      });
    }
    if (input.rejectionProof) {
      if (!malformed) continue;
      // The authenticated planner job interval is the only admission
      // window a legacy manifest rejection may use; a missing or
      // non-causal interval fails closed instead of inventing authority.
      const plannerStartedAt = planners[0].started_at;
      const plannerCompletedAt = planners[0].completed_at;
      const startedMs = typeof plannerStartedAt === "string"
        ? Date.parse(plannerStartedAt)
        : Number.NaN;
      const completedMs = typeof plannerCompletedAt === "string"
        ? Date.parse(plannerCompletedAt)
        : Number.NaN;
      if (
        typeof plannerStartedAt !== "string" ||
        typeof plannerCompletedAt !== "string" ||
        !Number.isSafeInteger(startedMs) ||
        !Number.isSafeInteger(completedMs) || completedMs < startedMs
      ) refuse();
      rejected.push({
        reason: "reservation_after_manifest",
        proof: input.rejectionProof,
        planDigest,
        plannerJobId: positive(planners[0].id),
        plannerStartedAt,
        plannerCompletedAt,
        affected,
        cells: evidence,
      });
      continue;
    }
    if (runtimeMismatch) {
      if (
        !historical || !input.consumerRun ||
        evidence.length + missingArtifacts !== selected.length
      ) refuse();
      // A partially authenticated wave isolates exactly the cells with
      // complete evidence; unprovable cells were left charged above and
      // are never claimed.
      if (evidence.length === 0) continue;
      throw new MatrixHistoricalRuntimeMismatch({
        consumerRun: input.consumerRun,
        expectedRuntimeSha: input.runtimeSha,
        run,
        runtimeSha: waveRuntime,
        generation: positive(planner.generation),
        repairHead: repairHead,
        planDigest,
        planArtifactId: positive(artifact.id),
        planArchiveDigest: String(artifact.digest),
        plannerJobId: positive(planners[0].id),
        affected: evidence.map((cell) => ({
          work: snapshot.work.find((row) =>
            row.id === cell.taskId &&
            row.intent?.requestId === cell.reservationId
          )!,
          reservation: snapshot.reservations.find((row) =>
            row.id === cell.reservationId
          )!,
          cell,
        })),
      });
    }
    recovered.push({
      plan,
      planDigest,
      results,
      bundlesDir,
      provenance: {
        run,
        plannerJobId: positive(planners[0].id),
        cellJobIds,
      },
    });
  }

  return { recovered, rejected };
}
