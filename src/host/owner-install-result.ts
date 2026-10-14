import type { GitSha } from "../contracts/brands.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { OwnerDevelopmentInstallResultV1 } from "./owner-install-types.ts";

export function failedResult(detail: string): OwnerDevelopmentInstallResultV1 {
  return {
    kind: "owner_development_install",
    status: "failed",
    action: null,
    priorRevision: null,
    priorGeneration: null,
    candidateRevision: null,
    candidateGeneration: null,
    stateHead: null,
    stateCommit: null,
    detail,
  };
}

export function waitingResult(
  detail: string,
  snapshot: ReleaseStateSnapshotV1 | null,
  head: GitSha | null,
): OwnerDevelopmentInstallResultV1 {
  const runtime = snapshot !== null && snapshot.hostedRuntimes.length === 1
    ? snapshot.hostedRuntimes[0]
    : null;
  return {
    kind: "owner_development_install",
    status: "waiting",
    action: null,
    priorRevision: runtime?.activeRevision ?? null,
    priorGeneration: runtime?.generation ?? null,
    candidateRevision: null,
    candidateGeneration: null,
    stateHead: head,
    stateCommit: null,
    detail,
  };
}

/** Sanitized bounded JSON line; never a token, payload or raw error. */
export function report(
  result: OwnerDevelopmentInstallResultV1,
  exitCode = 0,
): number {
  console.log(JSON.stringify(result));
  return exitCode;
}
