// Release-deferred tier planning (Sentinel #325): which families holding an
// open release request move cold while release is disabled, which return
// when it is enabled, and what the cold tier accepts.
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { isGatewayVpsRepository } from "../../src/repair/vps-delivery.ts";
import {
  emptyColdTierV1,
  validateColdTier,
} from "../../src/state/state-repair-tier-layout.ts";
import {
  planRepairDemotions,
  repositoryTierKey,
} from "../../src/state/state-repair-tier-plan.ts";
import type { RepairTierPolicyV1 } from "../../src/state/state-repair-tier-plan.ts";
import {
  planReleasePromotions,
  supersedeReleaseRequest,
} from "../../src/state/state-repair-tier-release.ts";
import {
  releaseRequest,
  REPO,
  reservation,
  SHA2,
  SHA3,
  workRecord,
} from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_790_000_000_000;
const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 7,
};
const TARGET = {
  base: SHA2,
  branch: null,
  checkpoint: null,
  head: SHA3,
  pr: 9,
};

function deferredFamily(
  name: string,
  repository: RepositoryIdentityV1,
  nextStep: "delivery" | "done",
) {
  const work = workRecord(name, { repository, nextStep, target: TARGET });
  const charge = reservation(`r-${name}`, {
    repository,
    taskId: work.id,
    createdAt: NOW - 11 * DAY,
    outcome: "submitted",
    settledAt: NOW - 10 * DAY,
  });
  const request = releaseRequest(`q-${name}`, {
    target: { repository, environment: "production" },
    revision: SHA3,
    source: {
      pullRequest: 9,
      reviewRequestId: charge.id,
      reviewReceiptId: null,
      head: SHA3,
      base: SHA2,
    },
  });
  return { work, charge, request };
}

function snapshot(
  families: ReturnType<typeof deferredFamily>[],
): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: NOW,
    incidents: [],
    evidence: [],
    work: families.map((row) => row.work),
    reservations: families.map((row) => row.charge),
    reviews: [],
    replays: [],
    releaseRequests: families.map((row) => row.request),
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
}

function policy(overrides: Partial<RepairTierPolicyV1> = {}) {
  return {
    now: NOW,
    listedRepositories: [REPO, PASSPORT],
    openIssueWorkIds: new Set<string>(),
    demotionBudget: 100,
    releaseDeferredDeliveryExcluded: isGatewayVpsRepository,
    ...overrides,
  };
}

Deno.test("release-deferred demotion: only while release is disabled, never a merge-accepted Gateway delivery", () => {
  const passportDelivery = deferredFamily("p-delivery", PASSPORT, "delivery");
  const gatewayDelivery = deferredFamily("g-delivery", REPO, "delivery");
  const gatewayDone = deferredFamily("g-done", REPO, "done");
  const bare = deferredFamily("p-bare", PASSPORT, "delivery");
  const hot = snapshot([passportDelivery, gatewayDelivery, gatewayDone, bare]);
  // A delivery record without an open request is not waiting on release.
  hot.releaseRequests = hot.releaseRequests.filter((row) =>
    row.id !== bare.request.id
  );

  const disabled = planRepairDemotions(
    hot,
    policy({ releasePath: "disabled" }),
  );
  assert.deepEqual(
    disabled.map((family) => family.map((move) => move.id)),
    [
      [gatewayDone.work.id, gatewayDone.charge.id, gatewayDone.request.id],
      [
        passportDelivery.work.id,
        passportDelivery.charge.id,
        passportDelivery.request.id,
      ],
    ].sort((left, right) => (left[0] < right[0] ? -1 : 1)),
  );
  for (const releasePath of ["enabled", undefined] as const) {
    assert.deepEqual(planRepairDemotions(hot, policy({ releasePath })), []);
  }
  // An open issue, a recent charge and an incomplete operation keep it hot.
  assert.deepEqual(
    planRepairDemotions(
      snapshot([passportDelivery]),
      policy({
        releasePath: "disabled",
        openIssueWorkIds: new Set([passportDelivery.work.id]),
      }),
    ),
    [],
  );
  const recent = deferredFamily("p-recent", PASSPORT, "delivery");
  const recentHot = snapshot([recent]);
  recentHot.reservations = [{ ...recent.charge, settledAt: NOW - DAY }];
  assert.deepEqual(
    planRepairDemotions(recentHot, policy({ releasePath: "disabled" })),
    [],
  );
});

Deno.test("release-deferred promotion: enabled, tip read, budgeted with a deferred remainder", () => {
  const families = ["a", "b", "c"].map((name) =>
    deferredFamily(name, PASSPORT, "delivery")
  );
  const cold = {
    ...emptyColdTierV1(),
    work: families.map((row) => row.work),
    reservations: families.map((row) => row.charge),
    releaseRequests: families.map((row) => row.request),
  };
  assert.equal(validateColdTier(cold), null);
  const tips = new Map([[repositoryTierKey(PASSPORT), SHA3 as GitSha]]);
  assert.deepEqual(
    planReleasePromotions(cold, {
      releasePath: "disabled",
      releaseTargetTips: tips,
      demotionBudget: 100,
    }),
    { seeds: [], deferred: 0 },
  );
  assert.deepEqual(
    planReleasePromotions(cold, {
      releasePath: "enabled",
      releaseTargetTips: new Map(),
      demotionBudget: 100,
    }),
    { seeds: [], deferred: 9 },
  );
  assert.deepEqual(
    planReleasePromotions(cold, {
      releasePath: "enabled",
      releaseTargetTips: tips,
      demotionBudget: 100,
      releasePromotionBudget: 6,
    }),
    { seeds: [families[0].work.id, families[1].work.id], deferred: 3 },
  );

  // The cold tier refuses an unbound open request or an unwaiting delivery.
  assert.match(
    validateColdTier({ ...cold, reservations: [] }) ?? "",
    /cold open release request must belong to a cold family/,
  );
  assert.match(
    validateColdTier({ ...cold, releaseRequests: [] }) ?? "",
    /cold delivery record must wait/,
  );
  assert.equal(validateColdTier({ ...cold, reservations: [] }, true), null);
});

Deno.test("supersession: a moved tip records the terminal cancelled shape; an unmoved tip keeps it open", () => {
  const { request } = deferredFamily("s", PASSPORT, "done");
  assert.equal(supersedeReleaseRequest(request, SHA3 as GitSha), null);
  const superseded = supersedeReleaseRequest(request, SHA2 as GitSha);
  assert.ok(superseded !== null);
  assert.deepEqual(
    { ...superseded, status: request.status, failureReason: null },
    request,
  );
  assert.equal(superseded.status, "cancelled");
  assert.match(superseded.failureReason ?? "", /^release request superseded/);
  assert.equal(supersedeReleaseRequest(superseded, SHA2 as GitSha), null);
});
