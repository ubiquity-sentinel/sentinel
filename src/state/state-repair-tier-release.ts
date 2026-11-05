/**
 * Release-deferred cold families (Sentinel #325; pure, no I/O).
 *
 * While the release path is disabled a family that holds an OPEN release
 * request moves cold unchanged (state-repair-tier-plan.ts). Once the release
 * path is enabled again the same trusted writer promotes those families back,
 * unchanged, within a per-pass budget (the remainder is deferred, never an
 * error). A family is promoted only when every one of its open requests'
 * target tips was read this pass: right after the promotion the caller
 * re-checks each promoted open request against that tip and records a moved
 * tip as a terminal supersession, so re-enabling never re-admits a request
 * whose candidate is no longer the target tip.
 */

import type { GitSha } from "../contracts/brands.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { RepairColdTierV1 } from "./state-repair-tier-layout.ts";
import { repositoryTierKey } from "./state-repair-tier-plan.ts";
import type { RepairTierPolicyV1 } from "./state-repair-tier-plan.ts";

/** Terminal status and reason of a request whose candidate is not the tip. */
export const RELEASE_SUPERSEDED_STATUS = "cancelled" as const;
export const RELEASE_SUPERSEDED_REASON =
  "release request superseded: the target tip moved while release was disabled";

/** The cold work ids whose release-deferred families return hot this pass. */
export function planReleasePromotions(
  cold: RepairColdTierV1,
  policy: Pick<
    RepairTierPolicyV1,
    | "releasePath"
    | "releaseTargetTips"
    | "releasePromotionBudget"
    | "demotionBudget"
  >,
): { seeds: string[]; deferred: number } {
  if (policy.releasePath !== "enabled") return { seeds: [], deferred: 0 };
  const taskOf = new Map<string, string>();
  for (const row of [...cold.reservations, ...cold.reservationArchive]) {
    taskOf.set(row.id, String(row.taskId));
  }
  const coldWork = new Set<string>(cold.work.map((row) => row.id));
  const open = new Map<string, ReleaseRequestV1[]>();
  for (const request of cold.releaseRequests) {
    if (request.status !== "open") continue;
    const workId = taskOf.get(request.source.reviewRequestId);
    if (workId === undefined || !coldWork.has(workId)) continue;
    const rows = open.get(workId) ?? [];
    rows.push(request);
    open.set(workId, rows);
  }
  const size = new Map<string, number>();
  const familyReservations = new Map<string, Set<string>>();
  for (const [id, workId] of taskOf) {
    if (!open.has(workId)) continue;
    const ids = familyReservations.get(workId) ?? new Set<string>();
    ids.add(id);
    familyReservations.set(workId, ids);
  }
  for (const workId of open.keys()) {
    const reservations = familyReservations.get(workId) ?? new Set();
    const bound = (requestId: string) => reservations.has(requestId);
    size.set(
      workId,
      1 + reservations.size +
        cold.reviews.filter((row) => bound(row.requestId)).length +
        cold.releaseRequests.filter((row) => bound(row.source.reviewRequestId))
          .length,
    );
  }
  const tips = policy.releaseTargetTips ?? new Map<string, GitSha>();
  const budget = Math.max(
    0,
    Math.floor(policy.releasePromotionBudget ?? policy.demotionBudget),
  );
  const seeds: string[] = [];
  let taken = 0;
  let deferred = 0;
  let exhausted = false;
  for (const workId of [...open.keys()].sort()) {
    const rows = size.get(workId)!;
    const tipsRead = open.get(workId)!.every((request) =>
      tips.has(repositoryTierKey(request.target.repository))
    );
    if (!tipsRead) {
      deferred += rows;
      continue;
    }
    const fits = taken + rows <= budget || (taken === 0 && budget > 0);
    if (fits && !exhausted) {
      seeds.push(workId);
      taken += rows;
    } else {
      exhausted = true;
      deferred += rows;
    }
  }
  return { seeds, deferred };
}

/**
 * The supersession of one promoted open request: terminal, same shape as the
 * existing cancelled/failed path, every other field unchanged. Returns null
 * when the candidate is still the target tip (the request stays open).
 */
export function supersedeReleaseRequest(
  request: ReleaseRequestV1,
  tip: GitSha,
): ReleaseRequestV1 | null {
  if (request.status !== "open" || request.revision === tip) return null;
  return {
    ...request,
    status: RELEASE_SUPERSEDED_STATUS,
    failureReason: RELEASE_SUPERSEDED_REASON,
  };
}
