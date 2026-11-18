/**
 * Review 2026-11-18 (iii): repository visibility is re-read on every pass,
 * not only at enrolment. An automatically enrolled target (an `id: null` row
 * pinned in `enrolment.json`, admitted only as public) that turned private
 * gets no leg: its tree and logs would be published in the public sentinel
 * repository. A committed id is the owner's recorded visibility decision
 * (Passport is private by the 2026-10-23 acceptance) and stays planned.
 * Fakes only.
 */
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { backupCiEnrolmentPath } from "../../src/contracts/backup-ci-trust.ts";
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

/** An automatically enrolled row: `id: null`, pinned to 991 in the store. */
function enrolled(world: ReturnType<typeof passWorld>) {
  world.store.set(backupCiEnrolmentPath("ubiquity", "prospector"), {
    version: 1,
    kind: "sentinel_backup_ci_enrolment",
    repository: { owner: "ubiquity", name: "prospector", id: 991 },
    enrolledAt: T0,
  });
  return [{ repository: "ubiquity/prospector" as const, id: null }];
}

Deno.test("an enrolment-pinned target that turned private is planned nothing", async () => {
  const world = passWorld();
  world.repos.set("ubiquity/prospector", { id: 991, private: true });
  const pass = await runBackupCiPass(
    passDeps(world, enrolled(world), { snapshot: demand() }),
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
    passDeps(world, enrolled(world), { snapshot: demand() }),
  );
  assert.equal(world.calls.get("branchTip:ubiquity/prospector"), 1);
  assert(
    !world.lines.includes("backup-ci:ubiquity/prospector:private_repository"),
  );
});

Deno.test("a committed id is the owner's visibility decision: private and still planned", async () => {
  const world = passWorld();
  world.repos.set("ubiquity/prospector", { id: 991, private: true });
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
