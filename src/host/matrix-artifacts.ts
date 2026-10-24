/** Read-only authenticated Actions transport for exact admitted matrix waves. */
import { isAbsolute, resolve, sep } from "node:path";
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS as TOLERANCE,
  HOSTED_RUNTIME_ID,
  type HostedExecutionIntentV1,
  parseHostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  matrixCellIdV1,
  MAX_MATRIX_ARCHIVE_BYTES,
} from "../contracts/matrix.ts";
import {
  candidatePreservationRef,
  implementationIntentKey,
} from "../repair/keys.ts";
import {
  createDeadline,
  type FetchLikeV1,
  fromFetch,
  type HttpTransportV1,
} from "../github/http.ts";
import {
  type MatrixArtifactRequestV1,
  type MatrixArtifactTransportV1,
  MatrixArtifactUnavailableError,
  type MatrixAuthenticatedWaveV1,
  MatrixMissingCellArtifactError,
  type MatrixRejectedWaveV1,
} from "./matrix-artifact-port.ts";
import {
  HISTORICAL_MATRIX_QUARANTINE,
  MATRIX_ARTIFACT_RECOVERY_MAX_MS,
  MatrixHistoricalRuntimeMismatch,
} from "./matrix-artifact-port.ts";
import { type Json, refuse, sameRepo } from "./matrix-artifact-values.ts";
import type {
  MatrixArtifactOptionsV1,
  MatrixArtifactRecoveryInputV1,
} from "./matrix-artifact-context.ts";
import { refusalFrames } from "./matrix-artifact-diagnostics.ts";
import { createMatrixArtifactHttp } from "./matrix-artifact-http.ts";
import { createMatrixArtifactArchive } from "./matrix-artifact-archive.ts";
import {
  confirmMatrixArtifactCompletion,
  createMatrixArtifactMarker,
} from "./matrix-artifact-native.ts";
import { recoverMatrixArtifactWaves } from "./matrix-artifact-wave.ts";
import {
  blockedImplementationBinding,
  blockedRecoveryBinding,
  blockedRecoveryMatchesProducer,
} from "./matrix-blocked-candidate.ts";

export function createActionsMatrixArtifactHttpTransport(
  fetchFn: FetchLikeV1 = globalThis.fetch as unknown as FetchLikeV1,
): HttpTransportV1 {
  const text = fromFetch(fetchFn);
  const archive = fromFetch(fetchFn, {
    maxBodyBytes: MAX_MATRIX_ARCHIVE_BYTES,
  });
  return (request) =>
    request.responseType === "bytes" ? archive(request) : text(request);
}

/** No shared-state or external write capability is accepted by this factory. */
export function createActionsMatrixArtifactTransport(
  options: MatrixArtifactOptionsV1,
): MatrixArtifactTransportV1 {
  const repositoryIdentity = { id: null as number | null };
  const recovery = {
    async run(input: MatrixArtifactRecoveryInputV1): Promise<{
      recovered: MatrixAuthenticatedWaveV1[];
      rejected: MatrixRejectedWaveV1[];
      completed?: boolean;
    }> {
      if (
        input.requests.length === 0 && !input.rejectionProof &&
        !input.completedExecution
      ) {
        return { recovered: [], rejected: [] };
      }
      if (
        input.deadline !== undefined && !Number.isSafeInteger(input.deadline)
      ) refuse();
      const startedAt = options.clock.now();
      const until = Math.min(
        startedAt + MATRIX_ARTIFACT_RECOVERY_MAX_MS,
        input.deadline ?? Number.POSITIVE_INFINITY,
      );
      if (until <= startedAt) return { recovered: [], rejected: [] };
      const deadline = createDeadline(until - startedAt);
      const controller = new AbortController();
      let staging: string | null = null;
      try {
        if (!options.token || !isAbsolute(options.artifactRoot)) refuse();
        if (
          input.currentRun && input.currentRun.launcherSha !== input.launcherSha
        ) refuse();
        const root = resolve(options.artifactRoot);
        const checkout = await Deno.realPath(Deno.cwd());
        if (root === checkout || root.startsWith(checkout + sep)) refuse();
        await Deno.mkdir(root, { recursive: true, mode: 0o700 });
        const realRoot = await Deno.realPath(root);
        if (realRoot === checkout || realRoot.startsWith(checkout + sep)) {
          refuse();
        }
        const [repair, release] = await deadline.race(
          Promise.all([
            options.state.readRepair(),
            options.state.readRelease(),
          ]),
        );
        if (
          !repair.ok || repair.value.status !== "found" || !release.ok ||
          release.value.status !== "found"
        ) refuse();
        const snapshot = repair.value.snapshot;
        const completionCustody = input.completedExecution
          ? canonicalStringify({
            head: release.value.head,
            runtime: release.value.snapshot.hostedRuntimes.find((row) =>
              row.id === HOSTED_RUNTIME_ID
            ),
          })
          : null;
        if (input.completedExecution) {
          const runtime = release.value.snapshot.hostedRuntimes.find((row) =>
            row.id === HOSTED_RUNTIME_ID
          );
          const current = runtime?.execution ??
            runtime?.lastExecutionProof?.execution;
          if (
            !current ||
            canonicalStringify(current) !==
              canonicalStringify(input.completedExecution) ||
            (!runtime?.execution &&
              !["bootstrap", "prior", "candidate", "rollback"].includes(
                current.purpose,
              ) &&
              (runtime?.activeRevision !== current.revision ||
                runtime.generation !== current.generation))
          ) refuse();
        }
        if (input.rejectionProof) {
          const proof = parseHostedRunProofV1(input.rejectionProof);
          const runtime = release.value.snapshot.hostedRuntimes.find((row) =>
            row.id === HOSTED_RUNTIME_ID
          );
          const active = runtime?.execution &&
            canonicalStringify(runtime.execution) ===
              canonicalStringify(proof.execution);
          const savedExecution = active
            ? runtime?.execution
            : runtime?.lastExecutionProof?.execution;
          if (
            !savedExecution || proof.execution.purpose !== "ordinary" ||
            canonicalStringify(savedExecution) !==
              canonicalStringify(proof.execution) ||
            (!active &&
              (runtime?.lastExecutionProof?.outcome === "not_started" ||
                !runtime?.lastExecutionProof ||
                canonicalStringify({
                    ...runtime.lastExecutionProof,
                    observedAt: proof.observedAt,
                  }) !== canonicalStringify(proof)))
          ) refuse();
          input = {
            ...input,
            requests: snapshot.work.flatMap((task) => {
              const intent = task.intent;
              // The exact original quarantine class is re-examined ONLY when the
              // trusted caller explicitly enabled authenticated not-started
              // revalidation; the default rejection pass leaves every
              // already-quarantined record closed exactly as before.
              const recoverable = task.nextStep === "work" ||
                (input.revalidateNotStarted === true &&
                  task.nextStep === "blocked" &&
                  task.blocker?.kind === "other" &&
                  task.blocker.message === HISTORICAL_MATRIX_QUARANTINE);
              if (
                !recoverable || intent?.kind !== "implementation" ||
                task.target.candidateState !== undefined
              ) return [];
              if (intent.requestId === null) refuse();
              return [{
                taskId: task.id,
                repository: task.repository,
                reservationId: intent.requestId,
                intentKey: intent.key,
                expectedBase: task.target.base,
                attempt: task.counters.attempts,
              }];
            }),
          };
        }
        const requested = new Map<string, MatrixArtifactRequestV1>();
        for (const request of input.requests) {
          if (requested.has(request.reservationId)) refuse();
          const reservations = snapshot.reservations.filter((row) =>
            row.id === request.reservationId
          );
          const work = snapshot.work.filter((row) =>
            row.id === request.taskId &&
            sameRepo(row.repository, request.repository)
          );
          if (reservations.length !== 1 || work.length !== 1) refuse();
          const reservation = reservations[0],
            task = work[0],
            intent = task.intent;
          const implementing = intent?.kind === "implementation" &&
            intent.expectedHead === null && intent.resultId === null;
          // Descriptor-bound producer recovery also admits an interrupted
          // submitted retry; its exact receipt must still verify before ingest.
          // The original quarantine requires explicit not-started revalidation.
          const recoverable = task.nextStep === "work" ||
            blockedRecoveryMatchesProducer(
              task,
              input.currentRun &&
                { ...input.currentRun, revision: input.runtimeSha },
            ) ||
            (input.revalidateNotStarted === true &&
              task.nextStep === "blocked" &&
              task.blocker?.kind === "other" &&
              task.blocker.message === HISTORICAL_MATRIX_QUARANTINE);
          const preserving = intent?.kind === "candidate_preservation" &&
            reservation.outcome === "submitted" &&
            reservation.settledAt !== null && task.target.head !== null &&
            task.target.head !== task.target.base &&
            intent.expectedHead === task.target.head &&
            intent.resultId === null && intent.pr === null &&
            task.target.candidateState?.preserved === null &&
            intent.startedAt >= reservation.createdAt &&
            intent.startedAt <= options.clock.now() + TOLERANCE &&
            intent.branch === await candidatePreservationRef(
                task.repository,
                task.id,
                request.intentKey,
              );
          if (
            reservation.taskId !== request.taskId ||
            !sameRepo(reservation.repository, request.repository) ||
            reservation.attempt !== request.attempt ||
            reservation.head !== request.expectedBase ||
            reservation.purpose === "review_request" ||
            reservation.outcome === "confirmed_not_submitted" ||
            (blockedImplementationBinding(task) !== null &&
              (reservation.purpose !== "retry" ||
                !((reservation.outcome === "reserved" &&
                  reservation.settledAt === null) ||
                  (reservation.outcome === "submitted" &&
                    reservation.settledAt !== null &&
                    Number.isSafeInteger(reservation.settledAt) &&
                    reservation.settledAt >= reservation.createdAt)))) ||
            !recoverable ||
            task.target.base !== request.expectedBase ||
            (!implementing && !preserving) ||
            intent?.key !== request.intentKey ||
            request.intentKey !==
              implementationIntentKey(request.reservationId) ||
            intent.requestId !== request.reservationId ||
            intent.observedBase !== request.expectedBase
          ) refuse();
          requested.set(request.reservationId, request);
        }
        const saved: HostedExecutionIntentV1[] = [];
        for (const runtime of release.value.snapshot.hostedRuntimes) {
          if (runtime.execution) saved.push(runtime.execution);
          if (runtime.lastExecutionProof) {
            saved.push(runtime.lastExecutionProof.execution);
          }
          if (runtime.lastHealthyProof) {
            saved.push(runtime.lastHealthyProof.execution);
          }
        }
        for (const row of release.value.snapshot.hostedReleases) {
          for (
            const proof of [
              row.priorProof,
              row.candidateProof,
              row.rollbackProof,
            ]
          ) if (proof) saved.push(proof.execution);
        }
        const reader = createMatrixArtifactHttp(
          options,
          until,
          deadline,
          repositoryIdentity,
        );
        const { pages } = reader;
        if (input.completedExecution) {
          return await confirmMatrixArtifactCompletion(
            options,
            input,
            completionCustody,
            reader,
          );
        }
        const archive = createMatrixArtifactArchive(
          reader.download,
          deadline,
          controller,
        );
        const marker = createMatrixArtifactMarker(
          options,
          reader.download,
          input,
        );
        const artifacts = await pages(
          input.currentRun
            ? `/runs/${input.currentRun.runId}/artifacts`
            : "/artifacts",
          "artifacts",
        );
        const possiblePlans = artifacts.filter((row) =>
          typeof row.name === "string" &&
          /^sentinel-matrix-plan-[1-9][0-9]*-[1-9][0-9]*$/.test(row.name)
        );
        const names = artifacts.map((row) => row.name);
        const plans: Json[] = [];
        for (const artifact of possiblePlans) {
          const [, runId, attempt] = (artifact.name as string).match(
            /^sentinel-matrix-plan-(\d+)-(\d+)$/,
          )!;
          if (input.currentRun) {
            if (
              Number(runId) === input.currentRun.runId &&
              Number(attempt) === input.currentRun.runAttempt
            ) plans.push(artifact);
            continue;
          }
          // Opaque native names select potential recoveries without reading unrelated archives.
          for (const request of requested.values()) {
            const cellId = await matrixCellIdV1(
              `${runId}:${attempt}:repair`,
              request.taskId,
              request.reservationId,
            );
            if (
              names.includes(
                `sentinel-matrix-cell-${runId}-${attempt}-${cellId}`,
              )
            ) {
              plans.push(artifact);
              break;
            }
          }
        }
        if (new Set(plans.map((row) => row.name)).size !== plans.length) {
          refuse();
        }
        for (const request of requested.values()) {
          const task = snapshot.work.find((row) => row.id === request.taskId)!;
          const binding = blockedRecoveryBinding(task);
          if (!binding) continue;
          const artifact = plans.find((row) =>
            row.name ===
              `sentinel-matrix-plan-${binding.runId}-${binding.runAttempt}`
          );
          if (
            artifact?.id !== binding.artifactId ||
            artifact.digest !== binding.archiveDigest
          ) refuse();
        }
        if (input.rejectionProof && requested.size > 0 && plans.length !== 1) {
          refuse();
        }
        staging = await Deno.makeTempDir({
          dir: realRoot,
          prefix: "authenticated-wave-",
        });
        const { recovered, rejected } = await recoverMatrixArtifactWaves({
          options,
          input,
          snapshot,
          repairHead: repair.value.head,
          requested,
          saved,
          artifacts,
          plans,
          staging,
          reader,
          archive,
          marker,
        });
        if (input.rejectionProof && staging) {
          await Deno.remove(staging, { recursive: true });
        }
        staging = null;
        return { recovered, rejected };
      } catch (error) {
        controller.abort();
        if (staging) {
          await Deno.remove(staging, { recursive: true }).catch(() => {});
        }
        if (error instanceof MatrixHistoricalRuntimeMismatch) throw error;
        try {
          console.error(JSON.stringify({
            kind: "sentinel_matrix_artifact_error",
            frames: refusalFrames(error),
          }));
        } catch {
          refuse();
        }
        if (
          error instanceof MatrixMissingCellArtifactError ||
          error instanceof MatrixArtifactUnavailableError
        ) throw error;
        refuse();
      } finally {
        controller.abort();
        deadline.dispose();
      }
    },
  };
  return {
    async confirmCompletedExecution(execution) {
      return (await recovery.run({
        requests: [],
        runtimeSha: execution.revision,
        launcherSha: execution.launcherSha,
        completedExecution: execution,
      })).completed === true;
    },
    async recover(input) {
      return (await recovery.run(input)).recovered;
    },
    async rejectHistorical({ proof, revalidateNotStarted, deadline }) {
      return (await recovery.run({
        requests: [],
        runtimeSha: proof.execution.revision,
        launcherSha: proof.execution.launcherSha,
        currentRun: {
          runId: proof.execution.runId,
          runAttempt: proof.execution.runAttempt,
          launcherSha: proof.execution.launcherSha,
        },
        rejectionProof: proof,
        revalidateNotStarted: revalidateNotStarted === true,
        ...(deadline === undefined ? {} : { deadline }),
      })).rejected;
    },
  };
}
