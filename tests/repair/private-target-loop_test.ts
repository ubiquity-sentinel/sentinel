/**
 * Owner decision 2026-11-18 ("no private repos"), the runtime half over the
 * real repair loop (`runRepairCycle`): the host configures no private target
 * (`loadTargetConfigsV1`), so records a private target already has in state
 * (one at delivery with a clean review, one waiting on its head's CI, one
 * blocked) are never stepped. Several cycles leave them byte-identical, in
 * place, uncharged, with no GitHub call, model run or comment, while the
 * configured target's own issue is worked as usual.
 */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  BASE,
  blockedRecord,
  foreignReceipt,
  foreignRecord,
  HEAD,
} from "../host/hosted-autonomy-fixtures.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import { rankEligibleWork } from "../../src/repair/selection.ts";

const PRIVATE_REPO: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "prospector",
  installationId: 7,
};

function privateRecord(
  issue: number,
  pr: number,
  extra: Record<string, unknown> = {},
): WorkRecordV1 {
  const id = `issue-ubiquity-prospector-${issue}` as WorkItemId;
  const record = foreignRecord();
  return foreignRecord({
    repository: PRIVATE_REPO,
    id,
    source: {
      kind: "issue",
      id: String(issue),
      revision: record.source.revision,
    },
    related: { incidentId: null, issueNumber: issue },
    target: { ...record.target, branch: `sentinel/repair/${id}`, pr },
    ...extra,
  });
}

const RECORDS = [
  privateRecord(120, 401),
  privateRecord(121, 402),
  privateRecord(122, 403, {
    nextStep: "blocked",
    blocker: blockedRecord().blocker,
  }),
];
const RECEIPTS = [401, 402].map((number, index) =>
  foreignReceipt({
    id: `review-receipt:${String(index + 5).repeat(64)}`,
    repository: PRIVATE_REPO,
    pullRequest: { number, head: HEAD, base: BASE },
  })
);

function privateRows(snapshot: RepairStateSnapshotV1) {
  return {
    work: snapshot.work.filter((row) =>
      row.repository.name === PRIVATE_REPO.name
    ).map((row) => canonicalStringify(row)),
    reviews: snapshot.reviews.filter((row) =>
      row.repository.name === PRIVATE_REPO.name
    ).map((row) => canonicalStringify(row)),
    reservations:
      snapshot.reservations.filter((row) =>
        row.repository.name === PRIVATE_REPO.name
      ).length,
    releaseRequests:
      snapshot.releaseRequests.filter((row) =>
        row.target.repository.name === PRIVATE_REPO.name
      ).length,
    attemptMemory:
      snapshot.attemptMemory.filter((row) =>
        row.repository.name === PRIVATE_REPO.name
      ).length,
  };
}

Deno.test("private target (runtime loop): records of an unconfigured private target are never stepped", async () => {
  const github = new RelationsFakeGithub();
  // The configured target's own open issue is worked as usual.
  github.listed = [issueRecord(7)];
  github.latest.set(7, issueRecord(7));
  const rig = makeMemoryRig(github);
  assert.equal(
    rig.configs.some((config) => config.repository.name === "prospector"),
    false,
    "the host configures no private target",
  );
  const seeded = await rig.state.writeRepair(
    seededSnapshot(
      RECORDS,
      { reviews: RECEIPTS } as unknown as Partial<RepairStateSnapshotV1>,
    ),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  const before = await rig.snapshot();
  for (let cycle = 0; cycle < 3; cycle++) {
    const outcome = await rig.run();
    assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
    rig.clock.advance(15 * 60_000);
  }
  const after = await rig.snapshot();
  assert.deepEqual(privateRows(after), privateRows(before));
  assert.deepEqual(
    after.work.filter((row) => row.repository.name === "prospector")
      .map((row) => row.id),
    RECORDS.map((row) => row.id),
  );
  // Nothing addressed the private records on GitHub: no read of their pulls
  // or issues, no merge, no comment.
  for (const call of github.calls) {
    for (const number of ["401", "402", "403", "120", "121", "122"]) {
      assert.equal(
        new RegExp(`[:#/]${number}\\b`).test(call),
        false,
        `${call} names a private record`,
      );
    }
  }
  // The configured target's issue was taken in (the loop did run).
  assert.ok(
    after.work.some((row) => row.repository.name !== "prospector"),
    JSON.stringify(github.calls),
  );
});

Deno.test("private target (runtime loop): the planner's ready set, which the throughput watchdog counts, never holds a private record", () => {
  // The watchdog's "ready but not planned" count is the matrix planner's
  // `ranked.ordered.filter(isReady)` over `rankEligibleWork(snapshot,
  // deps.configs, now)` (`matrix-planner.ts`, `matrix-plan-refusal.ts`): it is
  // ranked over the configured targets only, so a private record in the raw
  // state is skipped as unconfigured and never counted as ready work.
  const rig = makeMemoryRig(new RelationsFakeGithub());
  const snapshot = seededSnapshot(
    RECORDS,
    { reviews: RECEIPTS } as unknown as Partial<RepairStateSnapshotV1>,
  );
  const ranked = rankEligibleWork(snapshot, rig.configs, rig.clock.now());
  for (const record of RECORDS) {
    assert.equal(ranked.ordered.includes(record.id), false, record.id);
  }
  assert.equal(ranked.skipped[RECORDS[0].id], "unconfigured");
  assert.equal(ranked.skipped[RECORDS[1].id], "unconfigured");
  assert.equal(ranked.skipped[RECORDS[2].id], "blocked");
  // The same records under a configuration that names the target ARE ready:
  // the exclusion is the configuration, not the records.
  const configured = rankEligibleWork(snapshot, [
    ...rig.configs,
    { ...rig.configs[0], repository: PRIVATE_REPO },
  ], rig.clock.now());
  assert.ok(configured.ordered.includes(RECORDS[0].id));
});
