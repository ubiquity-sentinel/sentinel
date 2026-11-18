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
