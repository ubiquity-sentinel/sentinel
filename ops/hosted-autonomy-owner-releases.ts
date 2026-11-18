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
 *   normally; an identical failure re-parks it at once. Later attempts, if
 *   any, are ordinary grants under the ordinary bounds, not capped here.
 *
 * 2026-11-16 (owner answered "OK" to "#249 one more attempt (cap 6→7)";
 * docs/DECISIONS.md, 2026-11-16):
 *
 * - `issue-ubiquity-sentinel-249`: not a release but a one-park allowance
 *   (`OWNER_PRESERVATION_ALLOWANCES_2026_11_16`): the preservation
 *   disposition's six-charge cap is seven for its exact refused park, so the
 *   disposition re-enters it once through its own gates and the ordinary
 *   retry grant, and the runtime charges one more start (the seventh).
 *
 * 2026-11-17 (owner: "dude give sentinel full access please this is
 * unnecessarily nerfed", then "dude so confusing just make sentinel close out
 * all my issues"; docs/DECISIONS.md, 2026-11-17):
 *
 * - `OWNER_PROTECTED_RELEASES_2026_11_17`: the eleven exact "candidate
 *   touches a protected path" parks, each released once by
 *   `hosted-autonomy-protected-release.ts`, and only while the INSTALLED
 *   runtime carries the 2026-11-17 publication policy.
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

/** The ubiquity organisation's App installation (every target below). */
const UBIQUITY_INSTALLATION = 155687488;

/** One exact protected-path park of `name` (`ubiquity-sentinel` or ubiquity). */
function protectedPark(
  name: string,
  issue: number,
  since: number,
): OwnerReleaseV1 {
  const self = name === "sentinel";
  return Object.freeze({
    repository: self ? SENTINEL : Object.freeze({
      owner: "ubiquity",
      name,
      installationId: UBIQUITY_INSTALLATION,
    }),
    id: `issue-ubiquity-${name}-${issue}`,
    blocker: Object.freeze({
      kind: "other" as const,
      message: "candidate touches a protected path",
      since,
    }),
  });
}

/**
 * The owner's 2026-11-17 protected-path releases, verbatim from
 * sentinel-state/repair at b53e355a4571 (sequence 97103). Every one holds
 * `candidateState.preserved: null`: its protected candidate survives only in
 * an expired artifact, so a release returns the record to a new charged run
 * under the 2026-11-17 policy, which publishes what the old one parked. Ten
 * of the eleven parks: Sentinel 270 stays parked (below).
 */
export const OWNER_PROTECTED_RELEASES_2026_11_17: readonly OwnerReleaseV1[] =
  Object.freeze([
    protectedPark("sentinel", 177, 1794786847840),
    protectedPark("sentinel", 240, 1793933334355),
    // Sentinel 270 is not released (2026-11-18): its fix needs Sentinel's own
    // `.github/workflows/` (finalize chaining supervisor-dispatch), which
    // never publishes, so a release would only spend a charge and park.
    protectedPark("sentinel", 277, 1794542552067),
    protectedPark("sentinel", 383, 1794532634705),
    protectedPark("sentinel", 406, 1794668251018),
    protectedPark("ai.ubq.fi", 1370, 1794904678248),
    protectedPark("deno-deploy-workflow", 25, 1794532725068),
    protectedPark("demo.ubq.fi", 23, 1793886871055),
    protectedPark("arbitrage-bot", 7, 1793886841514),
    protectedPark("notifications.ubq.fi", 13, 1793881337642),
  ]);

/**
 * One exact refused-preservation park whose record the owner allowed more
 * charges: the preservation disposition's reservation cap for that record
 * while, and only while, it holds exactly this park. It is never a retry
 * rule: the disposition's own gates (consumed charge, unpublished shape, a
 * day's pacing and an advanced base) still decide.
 */
export interface OwnerPreservationAllowanceV1 extends OwnerReleaseV1 {
  /** The record's `PRESERVATION_REFUSED_MAX_RESERVATIONS` for this park. */
  readonly cap: number;
}

/**
 * The owner's 2026-11-16 allowance (owner answered "OK" to "#249 one more
 * attempt (cap 6→7)"), verbatim from sentinel-state/repair at 048efadb4e7d
 * (sequence 96671) and unchanged at 5581f19e3d: sentinel 249 holds six
 * submitted charges (2026-11-01 to 11-07), its candidates refused by the
 * trusted validator (`secret_shaped_text`: the `sk-` pattern matched inside
 * a finding id in docs/DECISIONS.md, fixed in `src/replay/fixture.ts`), is
 * parked on that refusal since 2026-11-12T23:08:40.682Z and is retained at
 * the six-charge cap. Seven lets the disposition re-enter it once more; that
 * re-entry rewrites the park, so the allowance never matches again and any
 * later refusal of 249 meets the ordinary cap with seven charges held.
 */
export const OWNER_PRESERVATION_ALLOWANCES_2026_11_16:
  readonly OwnerPreservationAllowanceV1[] = Object.freeze([
    Object.freeze({
      repository: SENTINEL,
      id: "issue-ubiquity-sentinel-249",
      blocker: Object.freeze({
        kind: "other" as const,
        message: "candidate preservation validation refused",
        since: 1794524920682,
      }),
      cap: 7,
    }),
  ]);

/**
 * The refused-preservation reservation cap of one record: `cap`, or the
 * owner's allowance while the record holds exactly that allowance's park.
 */
export function preservationRefusedCap(
  record: WorkRecordV1,
  cap: number,
  allowances: readonly OwnerPreservationAllowanceV1[] =
    OWNER_PRESERVATION_ALLOWANCES_2026_11_16,
): number {
  const allowance = allowances.find((entry) => ownerReleased(record, [entry]));
  return allowance === undefined ? cap : Math.max(cap, allowance.cap);
}
