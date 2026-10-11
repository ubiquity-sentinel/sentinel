/** Authenticated historical matrix quarantine coordinator. */
import { canonicalStringify } from "../contracts/canonical.ts";
import { matrixDigestV1 } from "../contracts/matrix.ts";
import {
  MatrixMissingCellArtifactError,
  type MatrixRejectedWaveV1,
} from "./matrix-artifact-port.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedExecutionSettlementV1,
  type HostedRunProofV1,
  parseHostedExecutionSettlementV1,
  parseHostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import { implementationIntentKey } from "../repair/keys.ts";
import { MATRIX_ARTIFACT_RECOVERY_MAX_MS } from "./matrix-artifact-port.ts";
import {
  HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE,
  type HistoricalMatrixQuarantineDepsV1,
  type HistoricalProofCustodyV1,
  isHistoricalQuarantineBlocked,
  proofInCustody,
  quarantineRow,
} from "./matrix-quarantine-state.ts";

export async function runHistoricalMatrixQuarantine(
  deps: HistoricalMatrixQuarantineDepsV1,
  deadlineAt: number = deps.clock.now() + MATRIX_ARTIFACT_RECOVERY_MAX_MS,
): Promise<number> {
  // One shared, bounded window covers the whole pass: a wave with many
  // missing-cell artifacts quarantines one record per recursion and each
  // recursion must reuse this same deadline instead of minting a fresh
  // transport window, so the pass cannot multiply its way past the
  // maintenance budget.
  if (!Number.isSafeInteger(deadlineAt) || deps.clock.now() >= deadlineAt) {
    return 0;
  }
  const repair = await deps.state.readRepair();
  // Missing or temporarily unavailable repair custody defers this pass.
  if (!repair.ok || repair.value.status !== "found") return 0;
  const [witness, ...remainingWitnesses] = deps.historicalReleaseWitnesses ??
    [];
  const revalidate = deps.revalidateNotStarted === true;
  if (witness) {
    const selected = repair.value.snapshot.work.filter((row) =>
      row.blocker?.message !== HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE &&
      row.intent?.kind === "implementation" && row.nextStep !== "done" &&
      (row.nextStep === "work" ||
        (revalidate && isHistoricalQuarantineBlocked(row))) &&
      row.target.candidateState === undefined &&
      witness.reservationIds.some((id) =>
        row.intent?.requestId === id ||
        row.intent?.key === implementationIntentKey(id)
      )
    );
    if (selected.length === 0) {
      return runHistoricalMatrixQuarantine({
        ...deps,
        historicalReleaseWitnesses: remainingWitnesses,
      }, deadlineAt);
    }
    for (const work of selected) {
      const reservation = repair.value.snapshot.reservations.find((row) =>
        row.id === work.intent?.requestId
      );
      if (
        ((!revalidate || !isHistoricalQuarantineBlocked(work)) &&
          work.nextStep !== "work") ||
        work.target.candidateState !== undefined ||
        !reservation || !witness.reservationIds.includes(reservation.id) ||
        work.intent?.key !== implementationIntentKey(reservation.id) ||
        canonicalStringify(work.repository) !==
          canonicalStringify(reservation.repository) ||
        (reservation.outcome !== "reserved" &&
          reservation.outcome !== "ambiguous")
      ) {
        throw new Error(
          "historical matrix selected reservation binding unavailable",
        );
      }
    }
  }
  if (
    !repair.value.snapshot.work.some((row) =>
      row.blocker?.message !== HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE &&
      (row.nextStep === "work" ||
        (revalidate && isHistoricalQuarantineBlocked(row))) &&
      row.intent?.kind === "implementation" &&
      row.target.candidateState === undefined
    )
  ) return 0;
  const release = await deps.state.readRelease();
  // Missing or temporarily unavailable release custody defers this pass; the
  // next maintenance cycle re-runs it instead of failing the run.
  if (!release.ok || release.value.status !== "found") return 0;
  const runtime = release.value.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  const current = runtime?.execution ?? null;
  let currentNative: HostedExecutionSettlementV1 | null = null;
  if (current !== null) {
    if (
      !deps.transport.confirmCompletedExecution ||
      !await deps.transport.confirmCompletedExecution(current)
    ) {
      // The pass was explicitly selected to settle a known wave; an unsettled
      // native writer is a hard refusal, never a silent deferral.
      throw new Error("historical matrix current native writers unsettled");
    }
    const observed = await deps.readExecution(current);
    if (!observed.ok || observed.value === null) {
      throw new Error(
        "historical matrix current native settlement unavailable",
      );
    }
    currentNative = parseHostedExecutionSettlementV1(observed.value);
    if (
      canonicalStringify(currentNative.execution) !==
        canonicalStringify(current)
    ) {
      throw new Error("historical matrix current native binding changed");
    }
  }
  const freshRelease = await deps.state.readRelease();
  if (!freshRelease.ok || freshRelease.value.status !== "found") {
    throw new Error("historical matrix saved custody unavailable");
  }
  const freshRuntime = freshRelease.value.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  if (
    canonicalStringify(freshRuntime?.execution ?? null) !==
      canonicalStringify(current)
  ) {
    throw new Error("historical matrix current custody changed");
  }
  const savedProof = freshRuntime?.lastExecutionProof;
  let historical: HistoricalProofCustodyV1 | undefined;
  let witnessedProof: HostedRunProofV1 | undefined;
  if (witness) {
    const saved = await deps.state.readReleaseAt?.({
      commit: witness.commit,
      expectedHead: freshRelease.value.head,
    });
    if (
      !saved?.ok || saved.value.status !== "found" ||
      saved.value.head !== witness.commit
    ) {
      throw new Error("historical matrix release witness unavailable");
    }
    const prior = saved.value.snapshot.hostedRuntimes.find((row) =>
      row.id === HOSTED_RUNTIME_ID
    )?.lastExecutionProof;
    if (
      !prior || prior.outcome === "not_started" ||
      prior.execution.purpose !== "ordinary" ||
      prior.execution.id !== witness.executionId ||
      prior.logDigest !== witness.logDigest
    ) {
      throw new Error("historical matrix release witness binding changed");
    }
    witnessedProof = parseHostedRunProofV1(prior);
    historical = {
      commit: witness.commit,
      expectedHead: freshRelease.value.head,
      proofDigest: await matrixDigestV1({ ...witnessedProof, observedAt: 0 }),
    };
  }
  const execution = witnessedProof?.execution ??
    (current?.purpose === "ordinary" && currentNative !== null &&
        currentNative.outcome !== "not_started"
      ? current
      : savedProof?.execution.purpose === "ordinary" &&
          savedProof.outcome !== "not_started"
      ? savedProof.execution
      : null);
  if (!execution) {
    const verification = current ?? savedProof?.execution;
    if (
      verification &&
      ["bootstrap", "prior", "candidate", "rollback"].includes(
        verification.purpose,
      )
    ) {
      if (
        freshRelease.value.head !== release.value.head ||
        canonicalStringify(freshRuntime) !== canonicalStringify(runtime)
      ) {
        throw new Error("historical matrix verification custody changed");
      }
      if (
        current === null && (!deps.transport.confirmCompletedExecution ||
          !await deps.transport.confirmCompletedExecution(verification))
      ) {
        throw new Error(
          "historical matrix verification completion unavailable",
        );
      }
      const observed = current !== null
        ? { ok: true as const, value: currentNative }
        : await deps.readExecution(verification);
      if (
        !observed.ok || observed.value === null ||
        observed.value.outcome === "not_started"
      ) {
        throw new Error("historical matrix verification proof unavailable");
      }
      const verificationProof = parseHostedRunProofV1(observed.value);
      if (
        canonicalStringify(verificationProof.execution) !==
          canonicalStringify(verification) ||
        (current === null &&
          (!savedProof || savedProof.outcome === "not_started" ||
            canonicalStringify({
                ...savedProof,
                observedAt: verificationProof.observedAt,
              }) !== canonicalStringify(verificationProof)))
      ) {
        throw new Error("historical matrix verification binding changed");
      }
      const [afterRelease, afterRepair] = await Promise.all([
        deps.state.readRelease(),
        deps.state.readRepair(),
      ]);
      if (
        !afterRelease.ok || afterRelease.value.status !== "found" ||
        afterRelease.value.head !== release.value.head ||
        canonicalStringify(
            afterRelease.value.snapshot.hostedRuntimes.find((row) =>
              row.id === HOSTED_RUNTIME_ID
            ),
          ) !== canonicalStringify(runtime) ||
        !afterRepair.ok || afterRepair.value.status !== "found" ||
        canonicalStringify(afterRepair.value.snapshot.work) !==
          canonicalStringify(repair.value.snapshot.work) ||
        canonicalStringify(afterRepair.value.snapshot.reservations) !==
          canonicalStringify(repair.value.snapshot.reservations)
      ) {
        throw new Error("historical matrix verification observation changed");
      }
      return 0;
    }
    throw new Error("historical matrix saved execution unavailable");
  }
  const native = currentNative &&
      canonicalStringify(execution) === canonicalStringify(current)
    ? { ok: true as const, value: currentNative }
    : await deps.readExecution(execution);
  if (
    !native.ok || native.value === null ||
    native.value.outcome === "not_started"
  ) {
    throw new Error("historical matrix native settlement unavailable");
  }
  const proof = parseHostedRunProofV1(native.value);
  if (
    canonicalStringify(proof.execution) !== canonicalStringify(execution) ||
    !await proofInCustody(deps, proof, current, historical) ||
    !deps.transport.rejectHistorical
  ) {
    throw new Error("historical matrix native custody unavailable");
  }
  let waves: readonly MatrixRejectedWaveV1[];
  try {
    waves = historical
      ? await witness!.reject(
        proof,
        historical.expectedHead,
        revalidate,
        deadlineAt,
      )
      : await deps.transport.rejectHistorical({
        proof,
        revalidateNotStarted: revalidate,
        deadline: deadlineAt,
      });
  } catch (error) {
    if (!(error instanceof MatrixMissingCellArtifactError)) throw error;
    if (
      canonicalStringify(error.proof) !== canonicalStringify(proof) ||
      (witness &&
        !witness.reservationIds.includes(error.captured.reservation.id))
    ) throw new Error("historical matrix missing-cell identity unavailable");
    await quarantineRow(deps, error, error.captured, current, historical);
    if (deps.clock.now() >= deadlineAt) return 1;
    return 1 + await runHistoricalMatrixQuarantine(deps, deadlineAt);
  }
  if (historical && waves.length === 0) {
    // The shared pass deadline can shorten the witness scan to nothing; that
    // is a bounded stop, not an unavailable witness.
    if (deps.clock.now() >= deadlineAt) return 0;
    throw new Error("historical matrix selected witness rejection unavailable");
  }
  if (waves.length === 0) {
    const fresh = await deps.state.readRepair();
    if (
      !fresh.ok || fresh.value.status !== "found" ||
      !await proofInCustody(deps, proof, current, historical) ||
      canonicalStringify(fresh.value.snapshot.work) !==
        canonicalStringify(repair.value.snapshot.work) ||
      canonicalStringify(fresh.value.snapshot.reservations) !==
        canonicalStringify(repair.value.snapshot.reservations)
    ) throw new Error("historical matrix applicability changed");
  }
  let count = 0;
  for (const wave of waves) {
    if (
      canonicalStringify(wave.proof) !== canonicalStringify(proof) ||
      !/^[0-9a-f]{64}$/.test(wave.planDigest) ||
      !Number.isSafeInteger(wave.plannerJobId) || wave.plannerJobId <= 0
    ) {
      throw new Error("historical matrix rejection identity unavailable");
    }
    for (const captured of wave.affected) {
      if (
        witness && !witness.reservationIds.includes(captured.reservation.id)
      ) {
        throw new Error(
          "historical matrix rejection reservation outside witness",
        );
      }
      if (deps.clock.now() >= deadlineAt) return count;
      await quarantineRow(deps, wave, captured, current, historical);
      count++;
    }
  }
  if (!await proofInCustody(deps, proof, current, historical)) {
    throw new Error("historical matrix final custody changed");
  }
  if (historical) {
    count += await runHistoricalMatrixQuarantine({
      ...deps,
      historicalReleaseWitnesses: remainingWitnesses,
    }, deadlineAt);
  }
  return count;
}
