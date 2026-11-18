/**
 * Review 2026-11-18 (iii): repository visibility is re-read on every pass,
 * not only at enrolment. A pinned target (committed or enrolment-pinned id)
 * that turned private gets no leg: its tree and logs would be published in
 * the public sentinel repository. Fakes only.
 */
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { runBackupCiPass } from "../../ops/backup-ci-pass.ts";
import { workRecord } from "../state/helpers.ts";
import { T0 } from "../github/backup-ci-fixtures.ts";
import { passDeps, passWorld, sha } from "./backup-ci-pass-fakes.ts";

function demand(): RepairStateSnapshotV1 {
  const record = workRecord("issue-p-1", {
    repository: { owner: "ubiquity", name: "prospector", installationId: 7 },
    nextStep: "work",
    target: {
      base: sha(0x101),
      branch: "sentinel/fix-1",
      checkpoint: null,
      head: sha(0x201),
      pr: 1,
    },
    wait: { reason: "ci_pending", since: T0, until: null },
  });
  return {
    work: [record],
    reservations: [],
    reviews: [],
    releaseRequests: [],
  } as unknown as RepairStateSnapshotV1;
}

Deno.test("a pinned target that turned private is planned nothing", async () => {
  const world = passWorld();
  world.repos.set("ubiquity/prospector", { id: 991, private: true });
  const pass = await runBackupCiPass(
    passDeps(world, [{ repository: "ubiquity/prospector", id: 991 }], {
      snapshot: demand(),
    }),
  );
  assert.equal(world.calls.get("repository:ubiquity/prospector"), 1);
  assert.equal(world.calls.get("branchTip:ubiquity/prospector"), undefined);
  assert.equal(world.calls.get("checkRuns:ubiquity/prospector"), undefined);
  assert.deepEqual(pass.units, []);
  assert.deepEqual(pass.files, []);
  assert(
    world.lines.includes("backup-ci:ubiquity/prospector:private_repository"),
    world.lines.join("\n"),
  );
});

Deno.test("the same pinned target while public is still read and planned", async () => {
  const world = passWorld();
  world.repos.set("ubiquity/prospector", { id: 991 });
  await runBackupCiPass(
    passDeps(world, [{ repository: "ubiquity/prospector", id: 991 }], {
      snapshot: demand(),
    }),
  );
  assert.equal(world.calls.get("branchTip:ubiquity/prospector"), 1);
  assert(
    !world.lines.includes("backup-ci:ubiquity/prospector:private_repository"),
  );
});
