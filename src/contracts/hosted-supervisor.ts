import { canonicalStringify } from "./canonical.ts";
import { parseReleaseRequestV1 } from "./release.ts";
import type { ReleaseRequestV1 } from "./release.ts";
import { tryParse } from "./validation.ts";
import type {
  HostedInstallationRecordV1,
  HostedReleasePhaseV1,
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "./hosted-supervisor-types.ts";
import { parseHostedReleaseRecordV1 } from "./hosted-supervisor-release.ts";
import {
  matchesInstallationMovement,
  validateHostedInstallationTransition,
} from "./hosted-supervisor-installation.ts";
import {
  validateHostedSchedulingTransition,
  validateHostedVerificationTransition,
} from "./hosted-supervisor-verification.ts";

/**
 * Hosted supervisor storage contracts (records only, no behavior).
 *
 * The protected supervisor runs its prepare/finalize phases on separate
 * runners from the ordinary runtime. These records persist that separation in
 * the EXISTING release state Git storage: they are separate collections
 * (`hostedRuntimes`, `hostedReleases`) and never fabricate a Deno
 * ReleaseRecordV1. Nothing here promotes, verifies or writes state by itself;
 * the parsers and the snapshot transition validator are the whole surface.
 *
 * Fixed identity of the one hosted scope: the self repository at the explicit
 * no-App installation scope 0, the fixed supervisor workflow and the fixed
 * supervisor ref. The runtime model policy is unchanged and lives elsewhere.
 */

/**
 * Strict full-request binding for a saved hosted receipt: the stored request
 * must canonical-equal a freshly parsed request. A foreign, malformed or
 * mutated request never binds.
 */
export function hostedReceiptBindsRequest(
  record: HostedReleaseRecordV1,
  request: ReleaseRequestV1,
): boolean {
  const parsedRecord = tryParse(parseHostedReleaseRecordV1, record);
  const parsedRequest = tryParse(parseReleaseRequestV1, request);
  if (!parsedRecord.ok || !parsedRequest.ok) return false;
  return parsedRecord.value.request.id === parsedRequest.value.id &&
    canonicalStringify(parsedRecord.value.request) ===
      canonicalStringify(parsedRequest.value);
}

function sameCanonical(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

/**
 * Fail-closed hosted transition validation over the two separate record
 * collections. It runs after the existing Deno release checks and returns a
 * bounded static message (never a payload) or null. Rules:
 *
 * - an existing runtime never disappears; id/createdAt are immutable and
 *   updatedAt never moves backward;
 * - the active revision/generation pair is unchanged or moves by exactly one
 *   generation, no active execution on either side and the PRIOR snapshot's
 *   matching persisted intent advanced in the same write; the same revision
 *   can never change generation;
 * - an execution is retained unchanged, cleared atomically with its exact
 *   settlement saved in `lastExecutionProof` (run proof or explicit
 *   no-execution settlement), or started as a NEW intent in a later write; an
 *   old execution is never replaced or rebound, so an unknown settlement is
 *   never silently lost;
 * - only a healthy settlement may also update `lastHealthyProof` (to the same
 *   exact proof), and a newly attached release proof must bind the exact
 *   execution settled in the same write;
 * - a first runtime starts at generation 1 with no historical health or
 *   execution proof;
 * - an existing release record never disappears; request, priorRevision and
 *   createdAt are immutable; a proof once present is immutable; terminal
 *   receipts are entirely immutable; phases only advance along the fixed
 *   order (same phase may persist repeatedly); a pointer intent once set only
 *   clears on the exact corresponding generation+1 movement;
 * - a new release record starts at `requested` with no proofs and no intent.
 */
export function validateHostedStateTransition(
  priorRuntimes: readonly HostedRuntimeRecordV1[],
  priorReleases: readonly HostedReleaseRecordV1[],
  nextRuntimes: readonly HostedRuntimeRecordV1[],
  nextReleases: readonly HostedReleaseRecordV1[],
  priorInstallations: readonly HostedInstallationRecordV1[] = [],
  nextInstallations: readonly HostedInstallationRecordV1[] = [],
): string | null {
  const installationError = validateHostedInstallationTransition(
    priorInstallations,
    nextInstallations,
    priorRuntimes[0],
    nextRuntimes[0],
  );
  if (installationError) return installationError;
  for (const priorRuntime of priorRuntimes) {
    const nextRuntime = nextRuntimes.find(
      (runtime) => runtime.id === priorRuntime.id,
    );
    if (nextRuntime === undefined) {
      return "existing hosted runtime cannot disappear";
    }
    if (nextRuntime.createdAt !== priorRuntime.createdAt) {
      return "hosted runtime createdAt is immutable";
    }
    if (nextRuntime.updatedAt < priorRuntime.updatedAt) {
      return "hosted runtime updatedAt cannot move backward";
    }
    const schedulingError = validateHostedSchedulingTransition(
      priorRuntime,
      nextRuntime,
    );
    if (schedulingError) return schedulingError;

    const priorExecution = priorRuntime.execution;
    const nextExecution = nextRuntime.execution;
    const priorSettlement = priorRuntime.lastExecutionProof;
    const nextSettlement = nextRuntime.lastExecutionProof;
    const ownerMove = matchesInstallationMovement(
      priorRuntime,
      nextRuntime,
      priorInstallations,
      nextInstallations,
    ) || priorReleases.some((r) => {
      const next = nextReleases.find((n) => n.id === r.id);
      const d = next?.ownerDisposition;
      return r.phase === "requested" && next?.phase === "owner_superseded" &&
        d !== undefined &&
        r.priorProof === null && r.candidateProof === null &&
        r.rollbackProof === null && r.pointerIntent === null &&
        priorRuntime.execution === null &&
        nextRuntime.execution?.purpose === "bootstrap" &&
        nextRuntime.execution.releaseId === null &&
        priorRuntime.activeRevision === d.intent.fromRevision &&
        priorRuntime.generation === d.intent.fromGeneration &&
        nextRuntime.activeRevision === d.intent.toRevision &&
        nextRuntime.generation === d.intent.toGeneration &&
        nextRuntime.execution.launcherSha === d.controllerRevision &&
        nextRuntime.execution.createdAt >= d.intent.authorizedAt &&
        sameCanonical(priorRuntime.lastExecutionProof, d.failedPriorProof) &&
        sameCanonical(
          priorRuntime.lastHealthyProof,
          d.retainedHealthyProof,
        ) &&
        sameCanonical(
          priorRuntime.lastExecutionProof,
          nextRuntime.lastExecutionProof,
        ) &&
        sameCanonical(
          priorRuntime.lastHealthyProof,
          nextRuntime.lastHealthyProof,
        );
    }) || priorReleases.some((r) => {
      const next = nextReleases.find((n) => n.id === r.id),
        old = r.ownerSuccessorBindings ?? [],
        bindings = next?.ownerSuccessorBindings ?? [];
      const added = bindings.length === old.length + 1
        ? bindings.at(-1)
        : undefined;
      return r.phase === "owner_superseded" &&
        next?.phase === "owner_superseded" && added !== undefined &&
        priorRuntime.execution === null &&
        nextRuntime.execution?.purpose === "bootstrap" &&
        nextRuntime.execution.releaseId === null &&
        priorRuntime.activeRevision === added.recoveryFromRevision &&
        priorRuntime.generation === added.recoveryFromGeneration &&
        nextRuntime.activeRevision === added.binding.successorRevision &&
        nextRuntime.generation === added.binding.successorGeneration &&
        nextRuntime.execution.launcherSha === added.controllerRevision &&
        sameCanonical(priorRuntime.lastExecutionProof, added.movementProof) &&
        sameCanonical(
          priorRuntime.lastExecutionProof,
          nextRuntime.lastExecutionProof,
        ) &&
        sameCanonical(
          priorRuntime.lastHealthyProof,
          nextRuntime.lastHealthyProof,
        );
    });

    // Execution lifetime: retained unchanged, cleared atomically with its exact
    // settlement proof, or newly started in a LATER write after a clear. A
    // direct old -> new replacement is never allowed, even with a proof.
    if (priorExecution !== null && nextExecution !== null) {
      if (!sameCanonical(priorExecution, nextExecution)) {
        return "an existing hosted runtime execution cannot be replaced";
      }
    } else if (priorExecution !== null && nextExecution === null) {
      if (
        nextSettlement === null ||
        !sameCanonical(nextSettlement.execution, priorExecution)
      ) {
        return "hosted runtime execution cannot be cleared without its exact settlement proof";
      }
    } else if (priorExecution === null && nextExecution !== null) {
      // An already settled execution is never rebound to the current attempt,
      // even with altered metadata: the deterministic execution id is the
      // identity and a rerun starts a NEW run/attempt id.
      if (
        (priorSettlement !== null &&
          priorSettlement.execution.id === nextExecution.id) ||
        (priorRuntime.lastHealthyProof !== null &&
          priorRuntime.lastHealthyProof.execution.id === nextExecution.id)
      ) {
        return "a settled hosted runtime execution cannot be rebound";
      }
    }

    // Proof pointers only move with the exact settlement of the execution
    // being cleared in this same write; arbitrary proofs are refused.
    if (!sameCanonical(priorSettlement, nextSettlement)) {
      if (priorExecution === null || nextExecution !== null) {
        return "hosted runtime lastExecutionProof can only change on its exact execution settlement";
      }
    }
    const settledNow = !sameCanonical(priorSettlement, nextSettlement);
    if (
      settledNow && nextSettlement !== null &&
      nextSettlement.outcome === "not_started"
    ) {
      // No-execution settlement only clears the intent: it never claims
      // health, attaches a release proof or moves the pointer in this write.
      if (
        !sameCanonical(
          priorRuntime.lastHealthyProof,
          nextRuntime.lastHealthyProof,
        )
      ) {
        return "a not_started settlement preserves lastHealthyProof";
      }
      if (
        nextRuntime.activeRevision !== priorRuntime.activeRevision ||
        nextRuntime.generation !== priorRuntime.generation
      ) {
        return "a not_started settlement cannot move the runtime pointer";
      }
    }
    if (
      priorRuntime.lastHealthyProof !== null &&
      nextRuntime.lastHealthyProof !== null &&
      nextRuntime.lastHealthyProof.execution.createdAt <
        priorRuntime.lastHealthyProof.execution.createdAt
    ) {
      return "hosted runtime healthy proof cannot move backward";
    }
    if (
      !sameCanonical(
        priorRuntime.lastHealthyProof,
        nextRuntime.lastHealthyProof,
      )
    ) {
      if (
        nextRuntime.lastHealthyProof === null ||
        nextRuntime.lastHealthyProof.outcome !== "healthy"
      ) {
        return "hosted runtime lastHealthyProof can only move to a healthy proof";
      }
      if (priorExecution === null || nextExecution !== null) {
        return "hosted runtime lastHealthyProof can only change on its exact execution settlement";
      }
      if (!sameCanonical(nextRuntime.lastHealthyProof, nextSettlement)) {
        return "a healthy settlement must update both runtime proofs to the same exact proof";
      }
    }

    // Pointer movement: exactly one generation, no active execution on either
    // side, and the exact prior persisted intent advanced in the same write.
    if (
      nextRuntime.activeRevision !== priorRuntime.activeRevision ||
      nextRuntime.generation !== priorRuntime.generation
    ) {
      if (nextRuntime.generation !== priorRuntime.generation + 1) {
        return "hosted runtime pointer movement requires exactly one generation increment";
      }
      if (nextRuntime.activeRevision === priorRuntime.activeRevision) {
        return "the same hosted runtime revision cannot change generation";
      }
      if (!ownerMove && (priorExecution !== null || nextExecution !== null)) {
        return "hosted runtime pointer movement requires no active execution";
      }
      const matched = priorReleases.some((release) => {
        const intent = release.pointerIntent;
        if (intent === null) return false;
        if (intent.expectedRevision !== priorRuntime.activeRevision) {
          return false;
        }
        if (intent.expectedGeneration !== priorRuntime.generation) {
          return false;
        }
        if (intent.nextRevision !== nextRuntime.activeRevision) {
          return false;
        }
        const advanced = nextReleases.find((item) => item.id === release.id);
        if (advanced === undefined || advanced.pointerIntent !== null) {
          return false;
        }
        if (intent.action === "promote") {
          return release.phase === "promoting" &&
            advanced.phase === "verifying";
        }
        return release.phase === "rollback_pending" &&
          advanced.phase === "rollback_verifying";
      });
      if (!matched && !ownerMove) {
        return "hosted runtime pointer movement has no exact persisted pointer intent and phase advance";
      }
    }
  }
  for (const nextRuntime of nextRuntimes) {
    if (priorRuntimes.some((runtime) => runtime.id === nextRuntime.id)) {
      continue;
    }
    if (priorRuntimes.length > 0) {
      return "a hosted runtime cannot introduce another runtime identity";
    }
    if (nextRuntime.generation !== 1) {
      return "the first hosted runtime must start at generation 1";
    }
    if (nextRuntime.lastHealthyProof !== null) {
      return "the first hosted runtime cannot claim a healthy proof";
    }
    if (nextRuntime.lastExecutionProof !== null) {
      return "the first hosted runtime cannot claim historical proof";
    }
    if (
      (nextRuntime.verificationFailures ?? 0) !== 0 ||
      (nextRuntime.failedVerificationIds?.length ?? 0) !== 0 ||
      nextRuntime.lastVerificationId != null ||
      nextRuntime.ordinaryAdmission !== undefined ||
      nextRuntime.lastTurn !== undefined ||
      nextRuntime.verificationBlocked === true
    ) return "the first hosted runtime cannot claim scheduling history";
  }

  const priorRuntimeRecord = priorRuntimes[0] ?? null;
  const nextRuntimeRecord = nextRuntimes[0] ?? null;
  const notStartedNow = priorRuntimeRecord !== null &&
    nextRuntimeRecord !== null &&
    !sameCanonical(
      priorRuntimeRecord.lastExecutionProof,
      nextRuntimeRecord.lastExecutionProof,
    ) &&
    nextRuntimeRecord.lastExecutionProof !== null &&
    nextRuntimeRecord.lastExecutionProof.outcome === "not_started";

  for (const priorRecord of priorReleases) {
    const nextRecord = nextReleases.find(
      (release) => release.id === priorRecord.id,
    );
    if (nextRecord === undefined) {
      return "existing hosted release cannot disappear";
    }
    const verificationError = validateHostedVerificationTransition(
      priorRecord,
      nextRecord,
      priorRuntimes[0],
      nextRuntimes[0],
    );
    if (verificationError) return verificationError;
    if (!sameCanonical(priorRecord.request, nextRecord.request)) {
      return "hosted release request is immutable";
    }
    if (priorRecord.priorRevision !== nextRecord.priorRevision) {
      return "hosted release priorRevision is immutable";
    }
    if (priorRecord.createdAt !== nextRecord.createdAt) {
      return "hosted release createdAt is immutable";
    }
    if (nextRecord.updatedAt < priorRecord.updatedAt) {
      return "hosted release updatedAt cannot move backward";
    }
    if (
      priorRecord.ownerDisposition !== undefined &&
      !sameCanonical(priorRecord.ownerDisposition, nextRecord.ownerDisposition)
    ) return "owner disposition is immutable";
    if (
      priorRecord.ownerAcceptance !== undefined &&
      !sameCanonical(priorRecord.ownerAcceptance, nextRecord.ownerAcceptance)
    ) return "owner acceptance is immutable";
    const oldBindings = priorRecord.ownerSuccessorBindings ?? [],
      nextBindings = nextRecord.ownerSuccessorBindings ?? [];
    if (
      nextBindings.length < oldBindings.length ||
      nextBindings.length > oldBindings.length + 1 ||
      oldBindings.some((b, index) => !sameCanonical(b, nextBindings[index]))
    ) return "owner successor bindings are append-only and immutable";
    for (
      const key of ["priorProof", "candidateProof", "rollbackProof"] as const
    ) {
      const priorProof = priorRecord[key];
      const nextProof = nextRecord[key];
      if (priorProof !== null) {
        if (nextProof === null || !sameCanonical(priorProof, nextProof)) {
          return "an existing hosted release proof is immutable";
        }
      } else if (nextProof !== null) {
        // A newly attached proof must be the EXACT full settlement recorded in
        // this same write (a real run proof, never no-execution), and it must
        // also bind the prior active execution being cleared; an unrelated
        // syntactically valid proof is never accepted.
        if (notStartedNow) {
          return "a not_started settlement cannot attach a release proof";
        }
        const priorExecution = priorRuntimes[0]?.execution ?? null;
        const nextRuntime = nextRuntimes[0] ?? null;
        const settlement = nextRuntime?.lastExecutionProof ?? null;
        if (
          priorExecution === null || nextRuntime === null ||
          nextRuntime.execution !== null || settlement === null ||
          settlement.outcome === "not_started" ||
          !sameCanonical(nextProof, settlement) ||
          !sameCanonical(nextProof.execution, priorExecution)
        ) {
          return "a newly attached hosted release proof must bind the exact settled execution";
        }
      }
    }
    if (
      priorRecord.phase === "accepted" || priorRecord.phase === "rolled_back" ||
      priorRecord.phase === "owner_superseded" ||
      priorRecord.phase === "abandoned"
    ) {
      const ownerAppend = priorRecord.phase === "owner_superseded" &&
        priorRecord.ownerAcceptance === undefined &&
        nextRecord.ownerAcceptance !== undefined &&
        sameCanonical(priorRecord, {
          ...Object.fromEntries(
            Object.entries(nextRecord).filter(([key]) =>
              key !== "ownerAcceptance"
            ),
          ),
          updatedAt: priorRecord.updatedAt,
        });
      const added = nextBindings.length === oldBindings.length + 1
        ? nextBindings.at(-1)
        : undefined;
      const before = priorRuntimes[0], after = nextRuntimes[0];
      const bindingAppend = priorRecord.phase === "owner_superseded" &&
        priorRecord.ownerAcceptance === undefined && added !== undefined &&
        before?.execution === null &&
        before.activeRevision === added.recoveryFromRevision &&
        before.generation === added.recoveryFromGeneration &&
        after?.activeRevision === added.binding.successorRevision &&
        after.generation === added.binding.successorGeneration &&
        after.execution?.purpose === "bootstrap" &&
        after.execution.releaseId === null &&
        after.execution.launcherSha === added.controllerRevision &&
        sameCanonical(priorRecord, {
          ...Object.fromEntries(
            Object.entries(nextRecord).filter(([key]) =>
              key !== "ownerSuccessorBindings"
            ),
          ),
          ...(priorRecord.ownerSuccessorBindings === undefined
            ? {}
            : { ownerSuccessorBindings: priorRecord.ownerSuccessorBindings }),
          updatedAt: priorRecord.updatedAt,
        });
      if (
        !sameCanonical(priorRecord, nextRecord) && !ownerAppend &&
        !bindingAppend
      ) {
        return "a terminal hosted release receipt is immutable";
      }
      continue;
    }
    const allowed: Record<HostedReleasePhaseV1, HostedReleasePhaseV1[]> = {
      requested: ["requested", "promoting", "owner_superseded", "abandoned"],
      promoting: ["promoting", "verifying", "abandoned"],
      verifying: ["verifying", "accepted", "rollback_pending", "abandoned"],
      accepted: ["accepted"],
      rollback_pending: ["rollback_pending", "rollback_verifying", "abandoned"],
      rollback_verifying: ["rollback_verifying", "rolled_back", "abandoned"],
      rolled_back: ["rolled_back"],
      owner_superseded: ["owner_superseded"],
      abandoned: ["abandoned"],
    };
    if (nextRecord.phase === "abandoned") {
      const a = nextRecord.abandonment;
      if (a?.fromPhase !== priorRecord.phase) {
        return "abandonment preserves the actual originating phase";
      }
      if (
        !a || priorRecord.pointerIntent !== null ||
        nextRecord.pointerIntent !== null
      ) return "abandonment cannot discard a pointer intent";
      if (a.reason === "included_in_successor") {
        const installation = nextInstallations.find((i) =>
          i.candidateRevision === a.successorRevision &&
          i.phase === "bootstrapping"
        );
        if (
          !installation || !priorRuntimes[0] || !nextRuntimes[0] ||
          !matchesInstallationMovement(
            priorRuntimes[0],
            nextRuntimes[0],
            priorInstallations,
            [installation],
          )
        ) return "successor abandonment requires the atomic installation";
      } else if (a.reason === "prior_verification_exhausted") {
        if (
          nextRecord.verification?.prior.failures !== 2 ||
          nextRuntimes[0]?.execution !== null ||
          priorRuntimes[0]?.activeRevision !== nextRuntimes[0]?.activeRevision
        ) {
          return "PRIOR abandonment requires settled exhaustion without pointer movement";
        }
      } else if (
        nextRecord.rollbackProof?.outcome !== "healthy" ||
        nextRuntimes[0]?.activeRevision !== nextRecord.priorRevision ||
        nextRuntimes[0]?.execution !== null
      ) return "candidate abandonment requires exact healthy restoration";
    }
    if (nextRecord.phase === "owner_superseded") {
      const runtime = priorRuntimes[0],
        nextRuntime = nextRuntimes[0],
        d = nextRecord.ownerDisposition;
      if (
        !runtime || !nextRuntime || !d || runtime.execution !== null ||
        nextRuntime.execution?.purpose !== "bootstrap" ||
        nextRuntime.activeRevision !== d.intent.toRevision ||
        nextRuntime.generation !== d.intent.toGeneration ||
        runtime.activeRevision !== d.intent.fromRevision ||
        runtime.generation !== d.intent.fromGeneration ||
        !sameCanonical(runtime.lastExecutionProof, d.failedPriorProof) ||
        !sameCanonical(runtime.lastHealthyProof, d.retainedHealthyProof)
      ) {
        return "owner supersession requires the exact atomic successor bootstrap";
      }
    }
    if (!allowed[priorRecord.phase].includes(nextRecord.phase)) {
      return "hosted release phase transition is not allowed";
    }
    // A promoting/rollback_pending phase advance is the ATOMIC pointer
    // movement: exactly one generation, no active execution anywhere, the
    // prior intent cleared, and the matching release advanced.
    if (
      (priorRecord.phase === "promoting" && nextRecord.phase === "verifying") ||
      (priorRecord.phase === "rollback_pending" &&
        nextRecord.phase === "rollback_verifying")
    ) {
      const priorRuntime = priorRuntimes[0] ?? null;
      const nextRuntime = nextRuntimes[0] ?? null;
      const intent = priorRecord.pointerIntent;
      const action = priorRecord.phase === "promoting" ? "promote" : "rollback";
      const moved = intent !== null && intent.action === action &&
        priorRuntime !== null && nextRuntime !== null &&
        priorRuntime.execution === null && nextRuntime.execution === null &&
        priorRuntime.activeRevision === intent.expectedRevision &&
        priorRuntime.generation === intent.expectedGeneration &&
        nextRuntime.activeRevision === intent.nextRevision &&
        nextRuntime.generation === intent.expectedGeneration + 1;
      if (!moved) {
        return "a hosted release phase advance requires the exact atomic pointer movement";
      }
    }
    if (priorRecord.pointerIntent !== null) {
      if (nextRecord.pointerIntent !== null) {
        if (
          !sameCanonical(priorRecord.pointerIntent, nextRecord.pointerIntent)
        ) {
          return "a set hosted release pointer intent cannot change";
        }
      } else {
        const priorRuntime = priorRuntimes[0] ?? null;
        const nextRuntime = nextRuntimes[0] ?? null;
        const intent = priorRecord.pointerIntent;
        const moved = priorRuntime !== null && nextRuntime !== null &&
          priorRuntime.activeRevision === intent.expectedRevision &&
          priorRuntime.generation === intent.expectedGeneration &&
          nextRuntime.activeRevision === intent.nextRevision &&
          nextRuntime.generation === intent.expectedGeneration + 1;
        if (!moved) {
          return "hosted release pointer intent can only clear on the exact pointer movement";
        }
      }
    }
  }
  for (const nextRecord of nextReleases) {
    if (priorReleases.some((release) => release.id === nextRecord.id)) {
      continue;
    }
    if (
      nextRecord.phase !== "requested" || nextRecord.priorProof !== null ||
      nextRecord.candidateProof !== null ||
      nextRecord.rollbackProof !== null || nextRecord.pointerIntent !== null ||
      nextRecord.verification !== undefined ||
      nextRecord.abandonment !== undefined
    ) {
      return "a new hosted release must start at requested with no proofs or pointer intent";
    }
  }
  return null;
}

export {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS,
  HOSTED_RUNTIME_ID,
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "./hosted-supervisor-types.ts";

export type {
  HostedAbandonmentV1,
  HostedExecutionIntentV1,
  HostedExecutionPurposeV1,
  HostedExecutionSettlementV1,
  HostedInstallationRecordV1,
  HostedNotStartedProofV1,
  HostedOwnerDispositionV1,
  HostedOwnerSuccessorBindingV1,
  HostedOwnerSuccessorTaskBindingV1,
  HostedOwnerSupersessionIntentV1,
  HostedPointerActionV1,
  HostedPointerIntentV1,
  HostedReleasePhaseV1,
  HostedReleaseRecordV1,
  HostedRunOutcomeV1,
  HostedRunProofV1,
  HostedRuntimeRecordV1,
  HostedVerificationJournalV1,
} from "./hosted-supervisor-types.ts";

export {
  parseHostedExecutionIntentV1,
  parseHostedExecutionSettlementV1,
  parseHostedNotStartedProofV1,
  parseHostedRunProofV1,
} from "./hosted-supervisor-execution.ts";

export {
  parseHostedPointerIntentV1,
  parseHostedRuntimeRecordV1,
} from "./hosted-supervisor-runtime.ts";

export {
  parseHostedOwnerDispositionV1,
  parseHostedOwnerSupersessionIntentV1,
  parseHostedReleaseRecordV1,
} from "./hosted-supervisor-release.ts";

export function isHostedReleaseTerminal(phase: HostedReleasePhaseV1): boolean {
  return phase === "accepted" || phase === "rolled_back" ||
    phase === "owner_superseded" || phase === "abandoned";
}

export { parseHostedInstallationRecordV1 } from "./hosted-supervisor-installation.ts";
