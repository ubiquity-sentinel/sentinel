import { hostedRuntimeBootstrapDisposition } from "./hosted-runtime-bootstrap.ts";
/** Hosted actions-supervisor-controller responsibility. */
import { canonicalStringify } from "../contracts/canonical.ts";
import { HOSTED_RUNTIME_ID } from "../contracts/hosted-supervisor.ts";
import type { HostedRuntimeRecordV1 } from "../contracts/hosted-supervisor.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { isOwnerStartupRecoveryTuple } from "./owner-startup-recovery.ts";
import {
  commitHosted,
  executionIdOfRun,
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
  STATIC_ACTIVE_RELEASE,
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
import type {
  HostedSupervisorInputV1,
  HostedSupervisorOutcomeV1,
} from "./actions-supervisor-state.ts";
import { STATIC_STATE } from "./actions-supervisor-bootstrap.ts";
import {
  allowsHostedExecution,
  allowsHostedRuntime,
  allowsHostedRuntimeMove,
  runtimeCompatibilityRefusal,
} from "./hosted-runtime-compatibility.ts";
import {
  authenticateSamePointerRecovery,
  authorizePromotionSource,
  buildRequestedReceipt,
  ordinaryDue,
  ownerSuccessorAcceptancePending,
  planReleaseWork,
  samePointerRecovery,
  selectSourceRequest,
  settleWithPreflight,
  startExecution,
} from "./actions-supervisor-source.ts";

/**
 * One bounded prepare. Order: reconcile the saved execution (idempotent replay
 * of the current run, exact settlement of a prior one), recover a persisted
 * pointer intent, bootstrap the initial generation-1 pointer, select an
 * eligible release, then the ordinary due pass.
 */
export async function runHostedSupervisorPrepare(
  input: HostedSupervisorInputV1,
): Promise<HostedSupervisorOutcomeV1> {
  if (invalidRunIdentity(input.run)) return pending(STATIC_RUN);
  const cursor = await readCursor(input);
  if (cursor === null) return pending(STATIC_STATE);
  let transitions = 0;
  while (transitions < MAX_TRANSITIONS) {
    const runtime = cursor.snapshot?.hostedRuntimes[0] ?? null;
    const releases = cursor.snapshot?.hostedReleases ?? [];
    const execution = runtime?.execution ?? null;

    if (input.ownerStartupRecoveryOnly === true) {
      if (
        cursor.snapshot?.hostedRuntimes.length !== 1 || runtime === null ||
        !isOwnerStartupRecoveryTuple(
          runtime.activeRevision,
          runtime.generation,
          true,
        )
      ) {
        return pending("owner startup recovery refuses an unrelated pointer");
      }
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
        (execution.id === executionIdOfRun(input.run) &&
          !isOwnerStartupRecoveryTuple(
            execution.revision,
            execution.generation,
          ))
      ) {
        return pending("owner startup recovery refuses an unrelated execution");
      }
    }

    if (runtime !== null && execution !== null) {
      if (
        execution.id === executionIdOfRun(input.run) &&
        execution.launcherSha === input.run.launcherSha
      ) {
        if (
          !allowsHostedExecution(
            execution,
            releases,
            input.queueRuntimeCapability,
            input.existingPrRuntimeCapability,
          ) || !allowsHostedRuntimeMove(
            runtime.activeRevision,
            execution.revision,
            input.queueRuntimeCapability,
            input.existingPrRuntimeCapability,
          )
        ) {
          return pending(
            runtimeCompatibilityRefusal(input.existingPrRuntimeCapability),
          );
        }
        return { status: "run", execution };
      }
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
      transitions++;
      continue;
    }
    if (runtime !== null && isSettledCurrentRun(runtime, input.run)) {
      return idle(STATIC_IDLE_SETTLED);
    }

    if (runtime === null) {
      if (releases.length > 0) return pending(STATIC_BOOTSTRAP_RELEASE);
      if (
        !allowsHostedRuntime(
          input.run.launcherSha,
          input.queueRuntimeCapability,
          input.existingPrRuntimeCapability,
        )
      ) {
        return pending(
          runtimeCompatibilityRefusal(input.existingPrRuntimeCapability),
        );
      }
      let verified: PortResultV1<boolean>;
      try {
        verified = await input.evidence.verifyRevision(input.run.launcherSha);
      } catch {
        return pending(STATIC_LAUNCHER);
      }
      if (!verified.ok || !verified.value) return pending(STATIC_LAUNCHER);
      const now = input.clock.now();
      const bootstrap: HostedRuntimeRecordV1 = {
        version: "v1",
        kind: "hosted_runtime",
        id: HOSTED_RUNTIME_ID,
        activeRevision: input.run.launcherSha,
        generation: 1,
        lastHealthyProof: null,
        lastExecutionProof: null,
        // No artificial ordinary-work cooldown: the next scheduled dispatch may run
        // ordinary work as soon as the previous execution actually settled. The
        // same run/attempt still cannot start a second execution.
        nextOrdinaryAt: now,
        execution: null,
        createdAt: now,
        updatedAt: now,
      };
      const applied = await commitHosted(input, cursor, bootstrap, releases);
      if (applied !== "applied") return pending(STATIC_CONFLICT);
      transitions++;
      continue;
    }

    const samePointer = samePointerRecovery(runtime);
    if (samePointer === "refused") {
      return pending("exact same-pointer recovery proof is unavailable");
    }
    if (
      samePointer === "verify" && (
        releases.some((release) =>
          !isTerminalPhase(release.phase) || release.pointerIntent !== null
        ) ||
        cursor.snapshot?.githubCooldowns.some((cooldown) =>
          cooldown.retryNotBefore === null ||
          input.clock.now() < cooldown.retryNotBefore
        )
      )
    ) return pending("exact same-pointer recovery admission is blocked");
    if (samePointer === "verify") {
      if (!await authenticateSamePointerRecovery(input, runtime)) {
        return pending(
          "exact same-pointer native completion proof is unavailable",
        );
      }
      const current = await readCursor(input);
      if (
        current === null || current.head !== cursor.head ||
        !sameCanonical(current.snapshot, cursor.snapshot)
      ) return pending(STATIC_CONFLICT);
    }

    const savedMove = releases.find((item) =>
      (item.phase === "promoting" || item.phase === "rollback_pending") &&
      item.pointerIntent !== null
    );
    if (
      savedMove?.pointerIntent !== undefined && savedMove.pointerIntent !== null
    ) {
      if (
        !allowsHostedRuntimeMove(
          savedMove.pointerIntent.expectedRevision,
          savedMove.pointerIntent.nextRevision,
          input.queueRuntimeCapability,
          input.existingPrRuntimeCapability,
        ) || !allowsHostedRuntimeMove(
          savedMove.priorRevision,
          savedMove.request.revision,
          input.queueRuntimeCapability,
          input.existingPrRuntimeCapability,
        )
      ) {
        return pending(
          runtimeCompatibilityRefusal(input.existingPrRuntimeCapability),
        );
      }
    }
    const recovery = planPointerRecovery(
      runtime,
      releases,
      input.clock.now(),
      input.queueRuntimeCapability,
      input.existingPrRuntimeCapability,
    );
    if (recovery !== null) {
      // A persisted promote intent is durable, not self-authorizing: before
      // the pointer actually moves on a RESUMED intent, the current trusted
      // WorkRecord/receipt/source issue are re-read and the same semantic
      // authorization is re-applied. An unavailable context or a changed task
      // blocks conservatively here: the old intent is never cleared,
      // rewritten or fabricated, and the active revision never moves.
      const promoting = releases.find((item) =>
        item.phase === "promoting" && item.pointerIntent !== null
      );
      if (promoting !== undefined) {
        const authorized = await authorizePromotionSource(input, promoting);
        if (!authorized.ok) return pending(authorized.detail);
      }
      const applied = await commitHosted(
        input,
        cursor,
        recovery.runtime,
        recovery.releases,
      );
      if (applied !== "applied") return pending(STATIC_CONFLICT);
      transitions++;
      continue;
    }

    if (
      runtime.generation === 1 &&
      runtime.activeRevision === input.run.launcherSha &&
      runtime.lastHealthyProof === null &&
      releases.length === 0
    ) {
      return await startExecution(
        input,
        cursor,
        runtime,
        releases,
        "bootstrap",
        input.run.launcherSha,
        null,
      );
    }

    const active = releases.filter((item) => !isTerminalPhase(item.phase));
    if (active.length > 1) return pending(STATIC_ACTIVE_RELEASE);
    const release = active[0] ?? null;
    if (release !== null) {
      const planned = await planReleaseWork(
        input,
        cursor,
        runtime,
        releases,
        release,
      );
      if (planned === "written") {
        transitions++;
        continue;
      }
      if (planned !== null) return planned;
      return idle(STATIC_IDLE_WAITING);
    }

    // The source-pinned newly installed runtime must establish its own health
    // before an unrelated request can preempt its model-disabled bootstrap.
    const bootstrap = hostedRuntimeBootstrapDisposition(
      runtime,
      input.queueRuntimeCapability,
      input.existingPrRuntimeCapability,
      input.runtimeRollout,
    );
    if (bootstrap === "hold") {
      return pending("future runtime own-health is unavailable");
    }
    if (bootstrap === "bootstrap") {
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

    if (await ownerSuccessorAcceptancePending(input, runtime, releases)) {
      return pending("owner successor task acceptance append is pending");
    }
    const selected = await selectSourceRequest(input, releases, runtime);
    if (selected.kind === "pending") return pending(selected.detail);
    if (selected.kind === "found") {
      if (
        !allowsHostedRuntimeMove(
          runtime.activeRevision,
          selected.request.revision,
          input.queueRuntimeCapability,
          input.existingPrRuntimeCapability,
        )
      ) {
        return pending(
          runtimeCompatibilityRefusal(input.existingPrRuntimeCapability),
        );
      }
      const receipt = buildRequestedReceipt(
        selected.request,
        runtime.activeRevision,
        input.clock.now(),
      );
      if (receipt === null) return pending(STATIC_REFUSED);
      const applied = await commitHosted(
        input,
        cursor,
        runtime,
        [...releases, receipt],
      );
      if (applied !== "applied") return pending(STATIC_CONFLICT);
      transitions++;
      continue;
    }

    if (ordinaryDue(runtime, releases)) {
      const verify = input.evidence.verifyMatrixOrdinaryRevision;
      if (verify === undefined) {
        return pending("ordinary matrix capability proof is unavailable");
      }
      let verified: PortResultV1<boolean>;
      try {
        verified = await verify.call(input.evidence, runtime.activeRevision);
      } catch {
        return pending("ordinary matrix capability proof is unavailable");
      }
      if (
        verified === null || typeof verified !== "object" ||
        !verified.ok || typeof verified.value !== "boolean"
      ) {
        return pending("ordinary matrix capability proof is unavailable");
      }
      // Keep the original cursor/head for the eventual CAS. A capability read
      // cannot authorize stale admission after any pointer or generation move.
      const current = await readCursor(input);
      if (
        current === null || current.head !== cursor.head ||
        canonicalStringify(current.snapshot) !==
          canonicalStringify(cursor.snapshot)
      ) {
        return pending(STATIC_CONFLICT);
      }
      if (!verified.value) {
        return idle("active runtime does not support ordinary matrix work");
      }
      return await startExecution(
        input,
        cursor,
        runtime,
        releases,
        samePointer === "verify" ? "bootstrap" : "ordinary",
        runtime.activeRevision,
        null,
        samePointer === "verify" ? undefined : input.clock.now(),
      );
    }

    if (
      runtime.lastHealthyProof === null ||
      runtime.lastHealthyProof.execution.revision !== runtime.activeRevision ||
      runtime.lastHealthyProof.execution.generation !== runtime.generation
    ) {
      // The active revision carries no current health proof, so one
      // verification execution is scheduled. It is deliberately NOT an
      // `ordinary` execution: only `ordinary` may start model work, so a
      // missing proof can never become a model-enabled run. The ordinary
      // cadence stays owned by `ordinaryDue`, which starts ordinary work as
      // soon as a healthy proof for the active revision/generation settles;
      // this verification neither brings that forward nor pushes it back.
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
    return idle(STATIC_IDLE_NONE);
  }
  return pending(STATIC_BOUND);
}

/**
 * Settle exactly the CURRENT run/attempt's saved intent. Pending evidence or a
 * mismatched identity changes nothing.
 */
export async function runHostedSupervisorFinalize(
  input: HostedSupervisorInputV1,
): Promise<HostedSupervisorOutcomeV1> {
  if (invalidRunIdentity(input.run)) return pending(STATIC_RUN);
  const cursor = await readCursor(input);
  if (cursor === null) return pending(STATIC_STATE);
  const runtime = cursor.snapshot?.hostedRuntimes[0] ?? null;
  const releases = cursor.snapshot?.hostedReleases ?? [];
  const saved = runtime?.execution ?? null;
  if (runtime === null || saved === null) {
    if (runtime !== null && isSettledCurrentRun(runtime, input.run)) {
      return idle(STATIC_IDLE_SETTLED);
    }
    return pending(STATIC_SETTLEMENT_PENDING);
  }
  if (
    saved.id !== executionIdOfRun(input.run) ||
    saved.launcherSha !== input.run.launcherSha
  ) {
    return pending(STATIC_EVIDENCE_BINDING);
  }
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
  if (settled !== "applied") return pending(STATIC_CONFLICT);
  return idle(STATIC_IDLE_SETTLED);
}
