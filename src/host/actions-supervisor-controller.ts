/** Trusted prepare/finalize: reconcile, install/bootstrap, then fair ordinary/release work. */
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import { hostedRuntimeBootstrapDisposition } from "./hosted-runtime-bootstrap.ts";
import { isOwnerStartupRecoveryTuple } from "./owner-startup-recovery.ts";
import { planLauncherInstallation } from "./actions-supervisor-installation.ts";
import { planOrdinaryWork } from "./actions-supervisor-ordinary.ts";
import {
  commitHosted,
  executionIdOfRun,
  type HostedSupervisorInputV1,
  type HostedSupervisorOutcomeV1,
  idle,
  invalidRunIdentity,
  isSettledCurrentRun,
  isTerminalPhase,
  MAX_TRANSITIONS,
  pending,
  planPointerRecovery,
  readCursor,
  readSettlement,
  sameCanonical,
  STATIC_BOOTSTRAP_RELEASE,
  STATIC_BOUND,
  STATIC_CONFLICT,
  STATIC_EVIDENCE_BINDING,
  STATIC_IDLE_NONE,
  STATIC_IDLE_SETTLED,
  STATIC_IDLE_WAITING,
  STATIC_LAUNCHER,
  STATIC_REFUSED,
  STATIC_RUN,
  STATIC_SETTLEMENT_PENDING,
} from "./actions-supervisor-state.ts";
import { STATIC_STATE } from "./actions-supervisor-bootstrap.ts";
import {
  authenticateSamePointerRecovery,
  authorizePromotionSource,
  buildRequestedReceipt,
  ordinaryDue,
  planReleaseWork,
  samePointerRecovery,
  selectSourceRequest,
  settleWithPreflight,
  startExecution,
} from "./actions-supervisor-source.ts";

export async function runHostedSupervisorPrepare(
  input: HostedSupervisorInputV1,
): Promise<HostedSupervisorOutcomeV1> {
  if (invalidRunIdentity(input.run)) return pending(STATIC_RUN);
  const cursor = await readCursor(input);
  if (cursor === null) return pending(STATIC_STATE);
  for (let transitions = 0; transitions < MAX_TRANSITIONS; transitions++) {
    const runtime = cursor.snapshot?.hostedRuntimes[0] ?? null;
    const releases = cursor.snapshot?.hostedReleases ?? [];
    const execution = runtime?.execution ?? null;
    if (input.ownerStartupRecoveryOnly === true) {
      if (
        !runtime || cursor.snapshot?.hostedRuntimes.length !== 1 ||
        !isOwnerStartupRecoveryTuple(
          runtime.activeRevision,
          runtime.generation,
          true,
        )
      ) return pending("owner startup recovery refuses an unrelated pointer");
      if (execution === null) {
        return idle(
          "owner startup recovery admits no ordinary or release work",
        );
      }
      if (
        execution.purpose !== "bootstrap" || execution.releaseId !== null ||
        !isOwnerStartupRecoveryTuple(
          execution.revision,
          execution.generation,
          true,
        ) ||
        execution.id === executionIdOfRun(input.run) &&
          !isOwnerStartupRecoveryTuple(execution.revision, execution.generation)
      ) return pending("owner startup recovery refuses an unrelated execution");
    }
    if (runtime && execution) {
      if (
        execution.id === executionIdOfRun(input.run) &&
        execution.launcherSha === input.run.launcherSha
      ) return { status: "run", execution };
      const settlement = await readSettlement(input, execution);
      if (!settlement.ok) return settlement.outcome;
      const settled = await settleWithPreflight(
        input,
        cursor,
        runtime,
        releases,
        settlement.settlement,
      );
      if (typeof settled === "object") return pending(settled.refused);
      if (settled !== "applied") return pending(STATIC_CONFLICT);
      continue;
    }
    if (runtime && isSettledCurrentRun(runtime, input.run)) {
      return idle(STATIC_IDLE_SETTLED);
    }
    if (!runtime) {
      if (releases.length > 0) return pending(STATIC_BOOTSTRAP_RELEASE);
      try {
        const verified = await input.evidence.verifyRevision(
          input.run.launcherSha,
        );
        if (!verified.ok || !verified.value) return pending(STATIC_LAUNCHER);
      } catch {
        return pending(STATIC_LAUNCHER);
      }
      const now = input.clock.now();
      const first: HostedRuntimeRecordV1 = {
        version: "v1",
        kind: "hosted_runtime",
        id: HOSTED_RUNTIME_ID,
        activeRevision: input.run.launcherSha,
        generation: 1,
        lastHealthyProof: null,
        lastExecutionProof: null,
        nextOrdinaryAt: now,
        execution: null,
        createdAt: now,
        updatedAt: now,
      };
      if (await commitHosted(input, cursor, first, releases) !== "applied") {
        return pending(STATIC_CONFLICT);
      }
      continue;
    }
    const samePointer = samePointerRecovery(runtime);
    if (samePointer === "refused") {
      return pending("exact same-pointer recovery proof is unavailable");
    }
    if (samePointer === "verify") {
      if (
        releases.some((r) =>
          !isTerminalPhase(r.phase) || r.pointerIntent !== null
        ) || cursor.snapshot?.githubCooldowns.some((c) =>
          c.retryNotBefore === null || input.clock.now() < c.retryNotBefore
        )
      ) return pending("exact same-pointer recovery admission is blocked");
      if (!await authenticateSamePointerRecovery(input, runtime)) {
        return pending(
          "exact same-pointer native completion proof is unavailable",
        );
      }
      const current = await readCursor(input);
      if (
        !current || current.head !== cursor.head ||
        !sameCanonical(current.snapshot, cursor.snapshot)
      ) return pending(STATIC_CONFLICT);
    }
    const installation = await planLauncherInstallation(
      input,
      cursor,
      runtime,
      releases,
    );
    if (installation === "written") continue;
    if (installation !== null) return installation;
    const due = ordinaryDue(runtime, releases);
    if (due && runtime.lastTurn === "verification") {
      return await planOrdinaryWork(
        input,
        cursor,
        runtime,
        releases,
        samePointer === "verify",
      );
    }
    const recovery = planPointerRecovery(runtime, releases, input.clock.now());
    if (recovery !== null) {
      const promoting = releases.find((r) =>
        r.phase === "promoting" && r.pointerIntent !== null
      );
      if (promoting) {
        const authorized = await authorizePromotionSource(input, promoting);
        if (!authorized.ok) {
          return due
            ? await planOrdinaryWork(input, cursor, runtime, releases)
            : pending(authorized.detail);
        }
      }
      if (
        await commitHosted(
          input,
          cursor,
          recovery.runtime,
          recovery.releases,
        ) !== "applied"
      ) return pending(STATIC_CONFLICT);
      continue;
    }
    const releaseVerification = releases.some((r) =>
      (r.phase === "verifying" &&
        r.request.revision === runtime.activeRevision) ||
      (r.phase === "rollback_pending" &&
        r.request.revision === runtime.activeRevision) ||
      (r.phase === "rollback_verifying" &&
        r.priorRevision === runtime.activeRevision)
    );
    const bootstrap = hostedRuntimeBootstrapDisposition(runtime);
    if (!releaseVerification && bootstrap === "bootstrap") {
      return await startExecution(
        input,
        cursor,
        runtime,
        releases,
        "bootstrap",
        runtime.activeRevision,
        null,
      );
    }
    if (!releaseVerification && bootstrap === "hold") {
      return pending(
        "runtime restoration verification failed; model starts remain stopped",
      );
    }
    const active = releases.filter((r) => !isTerminalPhase(r.phase));
    let deferred: HostedSupervisorOutcomeV1 | null = null;
    let written = false;
    for (const release of active) {
      if (
        (release.phase === "requested" || release.phase === "promoting") &&
        release.priorRevision !== runtime.activeRevision
      ) continue;
      const planned = await planReleaseWork(
        input,
        cursor,
        runtime,
        releases,
        release,
      );
      if (planned === "written") {
        written = true;
        break;
      }
      if (planned?.status === "run") return planned;
      if (planned) deferred = planned;
    }
    if (written) continue;
    const selected = await selectSourceRequest(input, releases, runtime);
    if (selected.kind === "found") {
      const receipt = buildRequestedReceipt(
        selected.request,
        runtime.activeRevision,
        input.clock.now(),
      );
      if (!receipt) deferred = pending(STATIC_REFUSED);
      else {
        if (
          await commitHosted(input, cursor, runtime, [...releases, receipt]) !==
            "applied"
        ) return pending(STATIC_CONFLICT);
        continue;
      }
    } else if (selected.kind === "pending") deferred = pending(selected.detail);
    if (due) {
      return await planOrdinaryWork(
        input,
        cursor,
        runtime,
        releases,
        samePointer === "verify",
      );
    }
    return deferred ??
      idle(active.length > 0 ? STATIC_IDLE_WAITING : STATIC_IDLE_NONE);
  }
  return pending(STATIC_BOUND);
}

export async function runHostedSupervisorFinalize(
  input: HostedSupervisorInputV1,
): Promise<HostedSupervisorOutcomeV1> {
  if (invalidRunIdentity(input.run)) return pending(STATIC_RUN);
  const cursor = await readCursor(input);
  if (cursor === null) return pending(STATIC_STATE);
  const runtime = cursor.snapshot?.hostedRuntimes[0] ?? null,
    releases = cursor.snapshot?.hostedReleases ?? [];
  const saved = runtime?.execution ?? null;
  if (!runtime || !saved) {
    return runtime && isSettledCurrentRun(runtime, input.run)
      ? idle(STATIC_IDLE_SETTLED)
      : pending(STATIC_SETTLEMENT_PENDING);
  }
  if (
    saved.id !== executionIdOfRun(input.run) ||
    saved.launcherSha !== input.run.launcherSha
  ) return pending(STATIC_EVIDENCE_BINDING);
  const settlement = await readSettlement(input, saved);
  if (!settlement.ok) return settlement.outcome;
  const settled = await settleWithPreflight(
    input,
    cursor,
    runtime,
    releases,
    settlement.settlement,
  );
  if (typeof settled === "object") return pending(settled.refused);
  return settled === "applied"
    ? idle(STATIC_IDLE_SETTLED)
    : pending(STATIC_CONFLICT);
}
