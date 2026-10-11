/** Repair loop internals: records. */
import type { GitSha } from "../contracts/brands.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type {
  EvidenceRefV1,
  RepositoryIdentityV1,
} from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";
import { clearIntent, setCandidateState } from "./transitions.ts";

/**
 * Exact repository identity match: owner, name AND GitHub App installation id
 * are one identity — a different installation is a different repository scope,
 * never a compatible evidence source.
 */
export function sameRepositoryIdentity(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

export function configFor(
  deps: RepairCycleDepsV1,
  repository: RepositoryIdentityV1,
): RepositoryConfigV1 | null {
  // Full scope identity: the same owner/name under a different installation
  // (positive App id vs the explicit no-App local scope 0) must never be
  // authorized through another scope's configuration.
  return deps.configs.find(
    (config) =>
      config.repository.owner === repository.owner &&
      config.repository.name === repository.name &&
      config.repository.installationId === repository.installationId,
  ) ?? null;
}

export function touchesProtected(
  protectedPaths: readonly string[],
  path: string,
): boolean {
  const candidate = normalizePathPrefix(path);
  return protectedPaths.some(
    (protectedPath) => {
      const prefix = normalizePathPrefix(protectedPath);
      if (prefix.length === 0) return true;
      return candidate === prefix ||
        candidate.startsWith(`${prefix}/`) ||
        prefix.startsWith(`${candidate}/`);
    },
  );
}

/** Normalize trusted repository-relative path prefixes before boundary checks. */
export function normalizePathPrefix(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
}

export function mergeEvidence(
  evidence: readonly EvidenceRefV1[],
  next: readonly EvidenceRefV1[],
): EvidenceRefV1[] {
  const merged = [...evidence];
  for (const ref of next) {
    if (
      !merged.some(
        (existing) => existing.kind === ref.kind && existing.ref === ref.ref,
      )
    ) {
      merged.push(ref);
    }
  }
  return merged;
}

/** Deterministic change test: an unchanged summary must not rewrite state. */
export function summaryChanged(
  previous: RepairStateSnapshotV1["incidents"][number],
  next: RepairStateSnapshotV1["incidents"][number],
): boolean {
  return next.count !== previous.count ||
    next.lastSeenAt !== previous.lastSeenAt ||
    next.severity !== previous.severity ||
    next.context.message !== previous.context.message ||
    next.coverage.status !== previous.coverage.status ||
    JSON.stringify(next.evidenceRef) !== JSON.stringify(previous.evidenceRef);
}

/**
 * Retire one closed-unmerged own publication identity. The exact preserved
 * candidate stays published on the task branch and the next publish step
 * creates its replacement; no counter, base, head or descriptor changes.
 */
export function retireClosedPublication(
  record: WorkRecordV1,
  now: number,
  nextStep: WorkRecordV1["nextStep"] = record.nextStep,
): WorkRecordV1 {
  return {
    ...record,
    nextStep,
    target: { ...record.target, pr: null },
    updatedAt: now,
  };
}

export function legacyDependenciesDone(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): boolean {
  for (const dependency of record.dependencies) {
    const dep = snapshot.work.find((work) => work.id === dependency);
    if (dep === undefined || dep.nextStep !== "done") return false;
  }
  return true;
}

/**
 * Exact delivery/release-request binding. PR and reviewed head alone are not
 * enough: the request must belong to the record's exact repository scope
 * (owner, name and installation id), be a production request, and carry the
 * same reviewed base as the record. A receipt for another scope or another
 * base is therefore never observed against this record.
 */
export function releaseRequestMatchesDelivery(
  request: ReleaseRequestV1,
  record: WorkRecordV1,
): boolean {
  if (record.target.pr === null || record.target.head === null) return false;
  if (request.source.pullRequest !== record.target.pr) return false;
  if (request.source.head !== record.target.head) return false;
  if (request.source.base !== record.target.base) return false;
  if (request.target.environment !== "production") return false;
  const target = request.target.repository;
  const repository = record.repository;
  return target.owner === repository.owner &&
    target.name === repository.name &&
    target.installationId === repository.installationId;
}

/**
 * Clear a completed push intent and persist the exact publication proof
 * (publishedHead = the pushed head) for a V1 candidate-state record. Legacy
 * records only clear the completed intent: their target has no candidate
 * state group to advance.
 */
export function withPublishedHead(
  record: WorkRecordV1,
  head: GitSha,
  now: number,
): WorkRecordV1 {
  const cleared = clearIntent(record, now);
  const candidateState = cleared.target.candidateState;
  if (candidateState === undefined) return cleared;
  return setCandidateState(cleared, {
    preserved: candidateState.preserved,
    publishedHead: head,
  }, now);
}
