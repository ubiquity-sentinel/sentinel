/**
 * One-time owner releases of exact parked records (owner decision 2026-11-15,
 * "all", to "Which parked sentinel issues should I release? Thirteen are
 * parked and never come back by themselves"; docs/DECISIONS.md, 2026-11-15).
 *
 * Each entry names ONE record by repository and id together with the exact
 * park it held when the owner decided: blocker kind, message and `since`.
 * Nothing matches by pattern or class, so a later park of the same record or
 * the same park on any other record is never released. A release changes no
 * persisted shape and records nothing new: once written, the record holds no
 * blocker, and any later park carries a later `since`, so the entry can never
 * match again ("released at most once" is derived from the park itself).
 *
 * Of the thirteen parked sentinel records only one is released here. The
 * others either need a protected-path change that no model candidate may
 * make, sit at an accounting bound the owner did not lift (the six-charge
 * preservation cap, the three no-change base-review bound), repair work that
 * is already merged, or have no actionable task text; their dispositions are
 * in the decision record.
 *
 * - `issue-ubiquity-sentinel-177`: a repeat-failure park of four transient
 *   "model run failed (unavailable)" outcomes (2026-10-17 to 2026-11-05).
 *   Its release is the bound's own one-time re-arm (`owner_release`,
 *   `hosted-autonomy-repeat-failure.ts`): an ordinary uncharged work grant
 *   through every gate of `planHostedRetries`. The runtime then refreshes the
 *   record's stale base and admits and charges one implementation start
 *   normally; an identical failure re-parks it at once.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { sameRepository } from "./hosted-autonomy-policy.ts";

/** One exact park the owner released. */
export interface OwnerReleaseV1 {
  readonly repository: RepositoryIdentityV1;
  readonly id: string;
  readonly blocker: Readonly<NonNullable<WorkRecordV1["blocker"]>>;
}

const SENTINEL: RepositoryIdentityV1 = Object.freeze({
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
});

/**
 * The owner's 2026-11-15 releases, verbatim from sentinel-state/repair at
 * 554559876818 (sequence 96323).
 */
export const OWNER_RELEASES_2026_11_15: readonly OwnerReleaseV1[] = Object
  .freeze([
    Object.freeze({
      repository: SENTINEL,
      id: "issue-ubiquity-sentinel-177",
      blocker: Object.freeze({
        kind: "other" as const,
        message:
          "repeated identical failure; owner action required (close or edit the issue, or change the model route): 4x other|ba872ff9154d4db3 issue=c37a034f80c5 route=e4b22974d0b1 prompt=29921b7659c5: model run failed (unavailable)",
        since: 1793882330918,
      }),
    }),
  ]);

/** True only for a blocked record holding exactly one released park. */
export function ownerReleased(
  record: WorkRecordV1,
  releases: readonly OwnerReleaseV1[] = OWNER_RELEASES_2026_11_15,
): boolean {
  const blocker = record.blocker;
  return record.nextStep === "blocked" && blocker !== null &&
    releases.some((entry) =>
      entry.id === record.id &&
      sameRepository(entry.repository, record.repository) &&
      entry.blocker.kind === blocker.kind &&
      entry.blocker.message === blocker.message &&
      entry.blocker.since === blocker.since
    );
}
