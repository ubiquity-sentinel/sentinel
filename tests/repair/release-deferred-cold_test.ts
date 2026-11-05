/**
 * Sentinel #325: while the release path is disabled, a merged delivery whose
 * only remaining wait is its open release request moves cold with that
 * request, unchanged, through the trusted tier writer, and the runtime loop
 * never steps it again. Re-enabling promotes the family unchanged (same blob
 * ids); a moved target tip then records the request as a terminal
 * supersession and an unmoved tip leaves it open. Accounting over both tiers
 * never changes. Real Git state, real loop entrypoint, fake GitHub.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { runRepairTierMaintenanceSummary } from "../../src/host/repair-tier-maintenance.ts";
import { releasePathDisabled } from "../../src/repair/vps-delivery.ts";
import {
  allReservationsAcrossTiersV1,
  RELEASE_SUPERSEDED_REASON,
} from "../../src/state/mod.ts";
import { makeRig, type RigV1, seededSnapshot, SHA4 } from "./loop-rig.ts";
import {
  gatewayDeliveryRecord,
  LOCAL_DELIVERY_TASK_DIGEST,
  referencedDeliveryReceipt,
} from "./loop-delivery-fixtures.ts";
import { releaseWithoutVps } from "./release-deferred-fixtures.ts";
import {
  releaseRequest,
  reservation,
  SHA1,
  SHA2,
  sha256Hex,
  SHA3,
  T0,
} from "../state/helpers.ts";

const PR = 12;
const DAY = 24 * 60 * 60 * 1000;
const REF = "refs/heads/sentinel-state/repair";
/** An issue-repair target whose delivery step waits on release acceptance. */
const PASSPORT: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 7,
};

function family() {
  const record = parseWorkRecordV1({
    ...gatewayDeliveryRecord(),
    repository: PASSPORT,
  });
  const request = releaseRequest("release-passport-12", {
    target: { repository: PASSPORT, environment: "production" },
    revision: SHA3,
    source: {
      pullRequest: PR,
      reviewRequestId: "review-req-passport-12",
      reviewReceiptId: "review-receipt-passport-12",
      head: SHA1,
      base: SHA2,
    },
  });
  const review = referencedDeliveryReceipt(
    request,
    record,
    LOCAL_DELIVERY_TASK_DIGEST,
  );
  // Charged and settled outside the seven-day accounting window.
  const charge = reservation(request.source.reviewRequestId, {
    repository: PASSPORT,
    taskId: record.id,
    purpose: "review_request",
    head: SHA1,
    createdAt: T0 - 11 * DAY,
    outcome: "submitted",
    settledAt: T0 - 10 * DAY,
  });
  return { record, request, review, charge };
}

async function seededRig(prefix: string) {
  const rig = await makeRig(prefix, {
    summaries: false,
    github: {
      pullRequest: {
        number: PR,
        state: "merged" as const,
        head: SHA1,
        base: SHA2,
        mergeSha: SHA3,
        mergedAt: T0,
      },
    },
    configOverrides: { repository: PASSPORT },
  });
  rig.github.prNumber = PR;
  const release = await rig.releaseStore.writeRelease(
    releaseWithoutVps(T0),
    null,
  );
  assert.ok(release.ok && release.value.status === "applied");
  const rows = family();
  const seed = await rig.store.writeRepair(
    seededSnapshot([rows.record], {
      reservations: [rows.charge],
      reviews: [rows.review],
      releaseRequests: [rows.request],
    }),
    null,
  );
  assert.ok(seed.ok && seed.value.status === "applied");
  return { rig, ...rows };
}

/** The maintenance step exactly as the trusted pass runs it. */
function maintain(
  rig: RigV1,
  releasePath: () => Promise<"disabled" | "enabled">,
  tip: GitSha | null = null,
) {
  return runRepairTierMaintenanceSummary({
    store: rig.store,
    repositories: [{
      repository: PASSPORT,
      listOpenIssues: () => rig.github.listOpenIssues(),
      readTargetTip: () => Promise.resolve(portOk(tip)),
    }],
    releasePath: async () => portOk(await releasePath()),
    clock: rig.clock,
    demotionBudget: 64,
  });
}

/** Release path derived from the positively read release ref. */
function observedReleasePath(rig: RigV1) {
  return async () => {
    const read = await rig.releaseStore.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") throw new Error("absent");
    return releasePathDisabled(read.value.snapshot) ? "disabled" : "enabled";
  };
}

async function tree(rig: RigV1, rev: string): Promise<Map<string, string>> {
  const out = await new Deno.Command("git", {
    args: ["--git-dir", rig.ctx.bare, "ls-tree", "-r", rev],
    env: rig.ctx.env,
    clearEnv: true,
  }).output();
  assert.ok(out.success, new TextDecoder().decode(out.stderr));
  const map = new Map<string, string>();
  for (const line of new TextDecoder().decode(out.stdout).split("\n")) {
    if (line.length === 0) continue;
    const [meta, path] = line.split("\t");
    map.set(path, meta.split(" ")[2]);
  }
  return map;
}

async function familyPaths(rows: ReturnType<typeof family>) {
  return {
    work: `work/${await sha256Hex(rows.record.id)}.json`,
    reservation: `reservations/${await sha256Hex(rows.charge.id)}.json`,
    review: `reviews/${await sha256Hex(rows.review.id)}.json`,
    request: `releaseRequests/${await sha256Hex(rows.request.id)}.json`,
  };
}

async function tieredReservations(rig: RigV1) {
  const read = await rig.store.readRepairTiered();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") throw new Error("absent");
  return {
    view: read.value.view,
    reservations: allReservationsAcrossTiersV1(read.value.view),
  };
}

/** Disabled pass: the family moves cold in one pass and is never stepped. */
async function demoteWhileDisabled(prefix: string) {
  const seeded = await seededRig(prefix);
  const { rig, request } = seeded;
  const paths = await familyPaths(seeded);
  const original = await tree(rig, REF);
  for (const path of Object.values(paths)) assert.ok(original.has(path));
  const accountingBefore = (await tieredReservations(rig)).reservations;

  const pass = await maintain(rig, observedReleasePath(rig));
  assert.equal(pass.releaseRequestsMovedToCold, 1);
  assert.match(pass.action, /:release-disabled:moved-cold:1:/);
  assert.match(pass.action, /^repair-tier:promoted:0:demoted:4:deferred:0/);

  const hot = await rig.snapshot();
  assert.equal(
    hot.releaseRequests.filter((row) => row.status === "open").length,
    0,
    "the hot pass reads zero open release requests",
  );
  assert.deepEqual(hot.work, []);
  const split = await tree(rig, REF);
  for (const path of Object.values(paths)) {
    assert.ok(!split.has(path), `${path} left the hot tier`);
    assert.equal(split.get(`repair-archive/${path}`), original.get(path));
  }
  const tiered = await tieredReservations(rig);
  assert.deepEqual(tiered.reservations, accountingBefore);
  assert.deepEqual(tiered.view.cold.releaseRequests, [request]);

  // The runtime loop never steps the cold delivery: no PR read, no write.
  const calls = rig.github.calls.length;
  const sequence = await rig.sequence();
  await rig.entry();
  assert.equal(
    rig.github.calls.slice(calls).filter((call) => call === `readPr:${PR}`)
      .length,
    0,
  );
  assert.equal(await rig.sequence(), sequence);
  // A second disabled pass is a steady no-op.
  const steady = await maintain(rig, observedReleasePath(rig));
  assert.match(steady.action, /^repair-tier:unchanged:deferred:0/);
  assert.equal(steady.releaseRequestsMovedToCold, 0);
  return { ...seeded, paths, original, accountingBefore };
}

Deno.test("release disabled: a merged delivery waiting on its open release request goes cold in one pass and is never re-stepped", async () => {
  const { rig } = await demoteWhileDisabled("release-cold-disabled");
  await rig.ctx.cleanup();
});

Deno.test("release re-enabled: the family returns unchanged and a moved target tip supersedes the request", async () => {
  const seeded = await demoteWhileDisabled("release-cold-moved");
  const { rig, request, paths, original, accountingBefore } = seeded;
  try {
    rig.clock.advance(60_000);
    const pass = await maintain(rig, () => Promise.resolve("enabled"), SHA4);
    assert.equal(pass.releaseRequestsSuperseded, 1);
    assert.match(pass.action, /^repair-tier:promoted:4:demoted:0:deferred:0/);
    assert.match(pass.action, /:release-enabled:moved-cold:0:superseded:1$/);

    // The tier commit (parent of the supersession write) restored every row
    // with its exact original blob id at its original hot path.
    const promoted = await tree(rig, `${REF}~1`);
    for (const path of Object.values(paths)) {
      assert.equal(promoted.get(path), original.get(path), `${path} same blob`);
      assert.ok(!promoted.has(`repair-archive/${path}`));
    }
    const head = await tree(rig, REF);
    for (const path of [paths.work, paths.reservation, paths.review]) {
      assert.equal(head.get(path), original.get(path));
    }

    const hot = await rig.snapshot();
    assert.deepEqual(hot.releaseRequests, [{
      ...request,
      status: "cancelled",
      failureReason: RELEASE_SUPERSEDED_REASON,
    }]);
    assert.equal(hot.work.length, 1);
    assert.deepEqual(hot.work[0], seeded.record);
    assert.deepEqual(
      (await tieredReservations(rig)).reservations,
      accountingBefore,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("release re-enabled: an unmoved target tip leaves the promoted request open and steppable", async () => {
  const seeded = await demoteWhileDisabled("release-cold-unmoved");
  const { rig, request, paths, original, accountingBefore } = seeded;
  try {
    const pass = await maintain(rig, () => Promise.resolve("enabled"), SHA3);
    assert.equal(pass.releaseRequestsSuperseded, 0);
    const head = await tree(rig, REF);
    for (const path of Object.values(paths)) {
      assert.equal(head.get(path), original.get(path), `${path} same blob`);
    }
    const hot = await rig.snapshot();
    assert.deepEqual(hot.releaseRequests, [request]);
    assert.deepEqual(
      (await tieredReservations(rig)).reservations,
      accountingBefore,
    );
    // While release is enabled the family stays hot, and the ordinary
    // delivery step owns it again.
    const steady = await maintain(rig, () => Promise.resolve("enabled"), SHA3);
    assert.match(steady.action, /^repair-tier:unchanged:deferred:0/);
    const sequence = await rig.sequence();
    await rig.entry();
    assert.ok(await rig.sequence() > sequence, "the delivery is stepped");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("release path unknown: nothing release-deferred moves", async () => {
  const { rig } = await seededRig("release-cold-unknown");
  try {
    const pass = await runRepairTierMaintenanceSummary({
      store: rig.store,
      repositories: [{
        repository: PASSPORT,
        listOpenIssues: () => rig.github.listOpenIssues(),
      }],
      clock: rig.clock,
      demotionBudget: 64,
    });
    assert.equal(pass.action, "repair-tier:unchanged:deferred:0");
    assert.equal(pass.releaseRequestsMovedToCold, null);
    assert.equal((await rig.snapshot()).releaseRequests.length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});
