import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitHubCooldownV1 } from "../contracts/github-cooldown.ts";
import { validateHostedStateTransition } from "../contracts/hosted-supervisor.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { GitSha } from "../contracts/brands.ts";
import { validateRepairTransition } from "./state-repair-transition.ts";
import { validateVpsReleaseTransition } from "../contracts/vps-release.ts";

// ---------------------------------------------------------------------------
// Transition validation: fail-closed preservation and immutability rules.
// The store refuses any write that silently drops, rewrites or resets state.
// ---------------------------------------------------------------------------

export function sameCanonical(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

export function sameRepository(
  a: { owner: string; name: string; installationId: number },
  b: { owner: string; name: string; installationId: number },
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

export function validateSnapshotTransition(
  prior: RepairStateSnapshotV1 | ReleaseStateSnapshotV1 | null,
  next: RepairStateSnapshotV1 | ReleaseStateSnapshotV1,
  expectedHead: GitSha | null,
): string | null {
  if (next.stateHead !== expectedHead) {
    return "snapshot stateHead must equal the expected remote head";
  }
  if (prior === null) {
    if (next.sequence !== 1) {
      return "the first state snapshot must have sequence 1";
    }
    // Initial hosted validation: a first release snapshot cannot smuggle
    // historical proofs, a non-initial generation or terminal receipts.
    if (!("work" in next)) {
      const firstRelease = next as ReleaseStateSnapshotV1;
      const vpsError = validateVpsReleaseTransition(
        [],
        firstRelease.vpsReleases ?? [],
      );
      if (vpsError !== null) return vpsError;
      return validateHostedStateTransition(
        [],
        [],
        firstRelease.hostedRuntimes,
        firstRelease.hostedReleases,
        [],
        firstRelease.hostedInstallations ?? [],
      );
    }
  } else {
    if (next.sequence !== prior.sequence + 1) {
      return "snapshot sequence must be exactly prior sequence + 1";
    }
    if (next.updatedAt < prior.updatedAt) {
      return "snapshot updatedAt cannot move backward";
    }
    if ("work" in prior) {
      return validateRepairTransition(prior, next as RepairStateSnapshotV1);
    }
    return validateReleaseTransition(prior, next as ReleaseStateSnapshotV1);
  }
  return null;
}
/**
 * Durable GitHub cooldowns are fail-closed preservation state in both refs:
 * one record per affected installation, never dropped, never moved to a
 * different installation, and a hold may only ever become STRICTER. A manual
 * fail-closed hold (null deadline) can never be silently converted into a
 * finite retry deadline; a finite deadline can never be shortened (moving to
 * null is a stricter manual hold and stays allowed); and the bounded fallback
 * index can never decrease. A new observation may otherwise refresh deadline,
 * observation identity and observedAt for the same installation; the
 * role-owned writer owns that update policy.
 */
export function cooldownTransitionMessage(
  priorRecords: readonly GitHubCooldownV1[],
  nextRecords: readonly GitHubCooldownV1[],
): string | null {
  for (const priorRecord of priorRecords) {
    const nextRecord = nextRecords.find(
      (record) => record.installationId === priorRecord.installationId,
    );
    if (nextRecord === undefined) {
      return "existing github cooldown cannot be dropped";
    }
    if (nextRecord.observedAt < priorRecord.observedAt) {
      return "github cooldown observedAt cannot move backward";
    }
    if (
      priorRecord.retryNotBefore === null &&
      nextRecord.retryNotBefore !== null
    ) {
      return "a manual github cooldown hold cannot become a retry deadline";
    }
    if (
      priorRecord.retryNotBefore !== null &&
      nextRecord.retryNotBefore !== null &&
      nextRecord.retryNotBefore < priorRecord.retryNotBefore
    ) {
      return "a github cooldown deadline cannot be shortened";
    }
    if (nextRecord.secondaryBackoff < priorRecord.secondaryBackoff) {
      return "a github cooldown backoff cannot decrease";
    }
  }
  return null;
}

export function validateReleaseTransition(
  prior: ReleaseStateSnapshotV1,
  next: ReleaseStateSnapshotV1,
): string | null {
  const vpsError = validateVpsReleaseTransition(
    prior.vpsReleases ?? [],
    next.vpsReleases ?? [],
  );
  if (vpsError !== null) return vpsError;
  for (const priorRecord of prior.releases) {
    const nextRecord = next.releases.find(
      (record) => record.id === priorRecord.id,
    );
    if (nextRecord === undefined) {
      return "existing release record cannot disappear";
    }
    if (
      !sameRepository(priorRecord.repository, nextRecord.repository) ||
      priorRecord.environment !== nextRecord.environment ||
      priorRecord.requestId !== nextRecord.requestId ||
      priorRecord.requestRevision !== nextRecord.requestRevision ||
      !sameCanonical(priorRecord.candidate, nextRecord.candidate) ||
      !sameCanonical(priorRecord.prior, nextRecord.prior) ||
      priorRecord.createdAt !== nextRecord.createdAt
    ) {
      return "existing release record candidate/prior/request identity changed";
    }
    if (
      priorRecord.phase === "accepted" ||
      priorRecord.phase === "rolled_back" ||
      priorRecord.phase === "failed"
    ) {
      if (!sameCanonical(priorRecord, nextRecord)) {
        return "terminal release record cannot restart or reset acceptance/rollback";
      }
      continue;
    }
    if (nextRecord.updatedAt < priorRecord.updatedAt) {
      return "release record updatedAt cannot move backward";
    }
    // Same-phase persistence is the normal monitoring resume path (repeated
    // samples, saved intent, interrupted coverage restart); forward
    // transitions remain permitted; backward phase resets stay forbidden.
    const allowed: Record<string, string[]> = {
      requested: ["requested", "promoting", "monitoring", "failed"],
      promoting: ["promoting", "monitoring", "failed", "rolled_back"],
      monitoring: ["monitoring", "accepted", "failed", "rolled_back"],
    };
    if (!allowed[priorRecord.phase]?.includes(nextRecord.phase)) {
      return "release record phase transition is not allowed";
    }
  }
  // Durable cooldowns are preserved on this ref exactly as on the repair ref:
  // a record can never disappear, move backward or lift a manual hold.
  const cooldownMessage = cooldownTransitionMessage(
    prior.githubCooldowns,
    next.githubCooldowns,
  );
  if (cooldownMessage !== null) return cooldownMessage;
  // Hosted supervisor records share this ref through their own collections;
  // the existing Deno checks above run first, then the hosted preservation and
  // pointer-movement rules.
  return validateHostedStateTransition(
    prior.hostedRuntimes,
    prior.hostedReleases,
    next.hostedRuntimes,
    next.hostedReleases,
    prior.hostedInstallations ?? [],
    next.hostedInstallations ?? [],
  );
}
