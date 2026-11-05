// Hot/cold repair tiers on a real Git remote: the hot read touches only live
// records, tier moves are byte-identical, accounting over hot+cold is
// unchanged, and a bounded demotion pass defers the remainder.
import assert from "node:assert/strict";
import {
  allReservationsV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  allReservationsAcrossTiersV1,
  allWorkAcrossTiersV1,
  GitStateStore,
  readRepairLedgerV1,
} from "../../src/state/mod.ts";
import type { RepairTierPolicyV1 } from "../../src/state/mod.ts";
import { planRepairDemotions } from "../../src/state/state-repair-tier-plan.ts";
import {
  appliedHead,
  type Ctx,
  gitRunAt,
  makeCtx,
  remoteHead,
} from "./git-state-fixtures.ts";
import { REPO, reservation, sha256Hex, workRecord } from "./helpers.ts";
import {
  accountingTotals,
  CountingRunner,
  COUNTS,
  DAY,
  expectedDemotedWork,
  type GitSha,
  KEPT_HOT,
  NOW,
  openIssueWorkIds,
  tierFixtureSnapshot,
  TOTAL_WORK,
  workId,
} from "./repair-tier-fixtures.ts";

const REF = "refs/heads/sentinel-state/repair";

function policy(overrides: Partial<RepairTierPolicyV1> = {}) {
  return {
    now: NOW,
    listedRepositories: [REPO],
    openIssueWorkIds: openIssueWorkIds(),
    demotionBudget: 10_000,
    ...overrides,
  };
}

async function treeEntries(
  ctx: Ctx,
  commit: string,
): Promise<Map<string, string>> {
  const listed = await gitRunAt(ctx, [
    "--git-dir",
    ctx.bare,
    "ls-tree",
    "-r",
    commit,
  ]);
  assert.ok(listed.ok, listed.stderr);
  const map = new Map<string, string>();
  for (const line of listed.stdout.split("\n").filter(Boolean)) {
    const [meta, path] = line.split("\t");
    map.set(path, meta.split(" ")[2]);
  }
  return map;
}

async function readHot(store: GitStateStore) {
  const read = await store.readRepair();
  assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
  if (!read.ok || read.value.status !== "found") throw new Error("absent");
  return read.value;
}

async function readTiered(store: GitStateStore) {
  const read = await store.readRepairTiered();
  assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
  if (!read.ok || read.value.status !== "found") throw new Error("absent");
  return read.value;
}

/** Runs bounded passes until nothing remains; returns per-pass results. */
async function drain(
  store: GitStateStore,
  head: GitSha,
  overrides: Partial<RepairTierPolicyV1>,
) {
  const passes: { demoted: number; deferred: number }[] = [];
  for (let pass = 0; pass < 10; pass++) {
    const result = await store.tierRepair({
      ...policy(overrides),
      expectedHead: head,
    });
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) throw new Error("tier pass failed");
    if (result.value.status === "unchanged") {
      assert.equal(result.value.deferred, 0);
      return { head, passes };
    }
    assert.equal(result.value.status, "applied", JSON.stringify(result));
    if (result.value.status !== "applied") throw new Error("not applied");
    passes.push({
      demoted: result.value.demoted,
      deferred: result.value.deferred,
    });
    head = result.value.head;
  }
  throw new Error("demotion did not drain");
}

Deno.test("repair tiers: 731-record snapshot demotes, reads hot only, and promotes a reopened family byte-for-byte", async () => {
  const ctx = await makeCtx("tier");
  try {
    const runner = new CountingRunner(`${ctx.tmp}/runner-home`);
    await Deno.mkdir(`${ctx.tmp}/runner-home`, { recursive: true });
    const store = new GitStateStore({
      scratchDir: `${ctx.tmp}/scratch`,
      remoteUrl: ctx.remoteUrl,
      role: "repair",
      runner,
    });
    const fixture = tierFixtureSnapshot();
    assert.equal(fixture.work.length, 731);
    assert.equal(fixture.reservations.length, COUNTS.reservations);
    assert.equal(fixture.reservationArchive?.length, COUNTS.reservationArchive);
    const head1 = appliedHead(await store.writeRepair(fixture, null));
    const original = await treeEntries(ctx, head1);
    const before = accountingTotals(allReservationsV1(fixture));

    // (d) A bounded pass demotes whole families within the budget and defers
    // the rest; following passes drain it without ever failing.
    const drained = await drain(store, head1, { demotionBudget: 1200 });
    assert.ok(drained.passes.length >= 2, JSON.stringify(drained.passes));
    assert.ok(drained.passes[0].deferred > 0);
    for (const pass of drained.passes.slice(0, -1)) {
      assert.ok(pass.demoted <= 1200, JSON.stringify(pass));
    }
    assert.equal(drained.passes.at(-1)!.deferred, 0);
    const head2 = drained.head;
    assert.equal(await remoteHead(ctx, REF), head2);

    // (a) The hot read touches only live records: no cold path is listed and
    // no cold blob is read.
    const split = await treeEntries(ctx, head2);
    const coldShas = new Set(
      [...split].filter(([path]) => path.startsWith("repair-archive/")).map((
        [, sha],
      ) => sha),
    );
    runner.reset();
    const hot = await readHot(store);
    const demoted = expectedDemotedWork();
    assert.equal(hot.snapshot.work.length, TOTAL_WORK - demoted.size);
    assert.ok(
      hot.snapshot.work.every((row) => !demoted.has(row.id)),
      "no demoted work record is hot",
    );
    for (const id of Object.values(KEPT_HOT)) {
      assert.ok(hot.snapshot.work.some((row) => row.id === workId(id)));
    }
    assert.equal(
      runner.listedPaths.filter((path) => path.startsWith("repair-archive/"))
        .length,
      0,
      "the hot read never lists the cold tier",
    );
    assert.equal(
      runner.catFileShas.filter((sha) => coldShas.has(sha)).length,
      0,
      "the hot read never reads a cold blob",
    );
    const hotRecords = [
      hot.snapshot.work,
      hot.snapshot.reservations,
      hot.snapshot.reservationArchive ?? [],
      hot.snapshot.reviews,
      hot.snapshot.releaseRequests,
      hot.snapshot.attemptMemory,
    ].reduce((sum, rows) => sum + rows.length, 0);
    assert.equal(runner.catFileShas.length, hotRecords + 1);
    assert.ok(hotRecords < split.size - coldShas.size + 1);
    assert.equal(hot.snapshot.attemptMemory.length, COUNTS.attemptMemory);

    // (c) Accounting over hot+cold equals the pre-split ledger, and every
    // record keeps its exact blob (moved, never rewritten).
    const tiered = await readTiered(store);
    assert.deepEqual(
      accountingTotals(allReservationsAcrossTiersV1(tiered.view)),
      before,
    );
    const sortById = <T extends { id: string }>(rows: T[]) =>
      [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    assert.deepEqual(
      sortById(allWorkAcrossTiersV1(tiered.view)),
      sortById(fixture.work),
    );
    assert.equal(
      tiered.view.hot.reviews.length + tiered.view.cold.reviews.length,
      COUNTS.reviews,
    );
    assert.equal(
      tiered.view.hot.releaseRequests.length +
        tiered.view.cold.releaseRequests.length,
      COUNTS.releaseRequests,
    );
    const logical = (tree: Map<string, string>) =>
      [...tree].filter(([path]) =>
        path !== "manifest.json" && path !== "repair-archive/LAYOUT"
      ).map((
        [path, sha],
      ) => `${path.replace(/^repair-archive\//, "")}=${sha}`).sort();
    assert.deepEqual(logical(split), logical(original));

    // Full-ledger readers (status, report, park and run summaries) see one
    // valid read-only snapshot holding both tiers.
    const ledger = await readRepairLedgerV1(store);
    assert.ok(ledger.ok && ledger.value.status === "found");
    if (!ledger.ok || ledger.value.status !== "found") return;
    const merged = parseRepairStateSnapshotV1(ledger.value.snapshot);
    assert.deepEqual(accountingTotals(allReservationsV1(merged)), before);
    assert.deepEqual(merged.work, fixture.work);
    assert.deepEqual(merged.reviews, fixture.reviews);
    assert.deepEqual(merged.releaseRequests, fixture.releaseRequests);

    // An ordinary hot write carries the cold tier forward unchanged and
    // refuses to recreate a cold record.
    const coldTree = async (commit: string) =>
      (await gitRunAt(ctx, [
        "--git-dir",
        ctx.bare,
        "rev-parse",
        `${commit}:repair-archive`,
      ])).stdout.trim();
    const hotWrite = appliedHead(
      await store.writeRepair(
        {
          ...hot.snapshot,
          stateHead: head2,
          sequence: hot.snapshot.sequence + 1,
        },
        head2,
      ),
    );
    assert.equal(await coldTree(hotWrite), await coldTree(head2));
    const recycled = [...demoted][0];
    const duplicate = await store.writeRepair({
      ...hot.snapshot,
      stateHead: hotWrite,
      sequence: hot.snapshot.sequence + 2,
      work: sortById([
        ...hot.snapshot.work,
        fixture.work.find((row) => row.id === recycled)!,
      ]),
    }, hotWrite);
    assert.ok(!duplicate.ok);
    assert.match(duplicate.error.detail, /promoted before it is written/);

    // (b) The reopened issue of a demoted blocked family is promoted on the
    // next pass with every row's exact bytes back at its original path.
    const reopenedIndex = 9;
    const reopened = workId(reopenedIndex);
    assert.ok(demoted.has(reopened));
    const digest = await sha256Hex(reopened);
    const familyPaths = [
      `work/${digest}.json`,
      ...await Promise.all(
        fixture.reservations.concat(fixture.reservationArchive ?? [])
          .filter((row) => row.taskId === reopened)
          .map(async (row) =>
            original.has(`reservations/${await sha256Hex(row.id)}.json`)
              ? `reservations/${await sha256Hex(row.id)}.json`
              : `reservationArchive/${await sha256Hex(row.id)}.json`
          ),
      ),
      ...await Promise.all(
        fixture.reviews.filter((row) => row.requestId.startsWith("res-0009-"))
          .map(async (row) => `reviews/${await sha256Hex(row.id)}.json`),
      ),
    ];
    assert.ok(familyPaths.length >= 3);
    for (const path of familyPaths) {
      assert.ok(split.has(`repair-archive/${path}`), `${path} is cold`);
    }
    const open = openIssueWorkIds();
    open.add(reopened);
    const promoted = await store.tierRepair({
      ...policy({ openIssueWorkIds: open }),
      expectedHead: hotWrite,
    });
    assert.ok(promoted.ok && promoted.value.status === "applied");
    if (!promoted.ok || promoted.value.status !== "applied") return;
    assert.equal(promoted.value.promoted, familyPaths.length);
    assert.equal(promoted.value.demoted, 0);
    const after = await treeEntries(ctx, promoted.value.head);
    for (const path of familyPaths) {
      assert.equal(after.get(path), original.get(path), `${path} byte-equal`);
      assert.ok(!after.has(`repair-archive/${path}`));
    }
    const back = await readHot(store);
    assert.deepEqual(
      back.snapshot.work.find((row) => row.id === reopened),
      fixture.work.find((row) => row.id === reopened),
    );
    // While the issue stays open the family is not demoted again.
    const steady = await store.tierRepair({
      ...policy({ openIssueWorkIds: open }),
      expectedHead: promoted.value.head,
    });
    assert.ok(steady.ok && steady.value.status === "unchanged");
    const afterTiered = await readTiered(store);
    assert.deepEqual(
      accountingTotals(allReservationsAcrossTiersV1(afterTiered.view)),
      before,
    );

    // The cold tier carries its layout marker; rollback preparation
    // (promote-all) empties the tier and removes the marker and subtree, and
    // every row is back at its original path with its original blob.
    const marker = await gitRunAt(ctx, [
      "--git-dir",
      ctx.bare,
      "cat-file",
      "-p",
      `${promoted.value.head}:repair-archive/LAYOUT`,
    ]);
    assert.equal(marker.stdout, "sentinel-repair-tiers v1\n");
    const all = await store.tierRepair({
      ...policy({ promoteAll: true }),
      expectedHead: promoted.value.head,
    });
    assert.ok(all.ok && all.value.status === "applied", JSON.stringify(all));
    if (!all.ok || all.value.status !== "applied") return;
    assert.equal(all.value.demoted, 0);
    const restored = await treeEntries(ctx, all.value.head);
    assert.ok(
      [...restored.keys()].every((path) => !path.startsWith("repair-archive")),
    );
    assert.deepEqual(logical(restored), logical(original));
    const full = await readHot(store);
    assert.deepEqual(full.snapshot.work, fixture.work);
    assert.deepEqual(full.snapshot.reviews, fixture.reviews);
    assert.deepEqual(
      accountingTotals(allReservationsV1(full.snapshot)),
      before,
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("repair tiers: demotion keeps a family hot for any live, open, protected or depended-on reason", () => {
  const closed = (id: string, overrides: Record<string, unknown> = {}) =>
    workRecord(id, {
      nextStep: "done",
      target: {
        base: "aafb7ee0598699bb7fb8a72ea133693ed64462da",
        branch: null,
        checkpoint: null,
        head: "6dc35d06e757107b91eb58232bd15e5f671d79b4",
        pr: 9,
      },
      ...overrides,
    });
  const settled = (id: string, taskId: string, settledAt = NOW - 10 * DAY) =>
    reservation(id, {
      taskId,
      createdAt: settledAt - 1,
      outcome: "submitted",
      settledAt,
    });
  const snapshot: RepairStateSnapshotV1 = {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: NOW,
    incidents: [],
    evidence: [],
    work: [
      closed("w-ok"),
      closed("w-open"),
      closed("w-protected"),
      closed("w-recent"),
      closed("w-ambiguous"),
      closed("w-dep"),
      workRecord("w-live", { dependencies: ["w-dep"] }),
    ],
    reservations: [
      settled("r-ok", "w-ok"),
      settled("r-protected", "w-protected"),
      settled("r-recent", "w-recent", NOW - DAY),
      reservation("r-ambiguous", {
        taskId: "w-ambiguous",
        createdAt: NOW - 10 * DAY,
        outcome: "ambiguous",
        settledAt: NOW - 10 * DAY,
      }),
    ],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
  const families = planRepairDemotions(snapshot, {
    now: NOW,
    listedRepositories: [REPO],
    openIssueWorkIds: new Set(["w-open"]),
    protectedReservationIds: new Set(["r-protected"]),
    demotionBudget: 100,
  });
  assert.deepEqual(families, [[
    { id: "w-ok", from: "work", to: "work" },
    { id: "r-ok", from: "reservations", to: "reservations" },
  ]]);
  // An unlisted repository is never assumed closed.
  assert.deepEqual(
    planRepairDemotions(snapshot, {
      now: NOW,
      listedRepositories: [],
      openIssueWorkIds: new Set(),
      demotionBudget: 100,
    }),
    [],
  );
});
