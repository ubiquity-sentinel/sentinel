/**
 * Repository visibility is re-read on every pass, not only at enrolment
 * (review 2026-11-18 (iii)), and no row is exempt (owner decision
 * 2026-11-18, "no private repos"): a private target gets no leg of any
 * kind, whether it is an automatically enrolled row (an `id: null` row
 * pinned in `enrolment.json`, admitted only as public) that turned private
 * or a row with a committed id (Passport's former 2026-10-23 acceptance is
 * superseded). Its tree and logs would be published in the public sentinel
 * repository. Fakes only.
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

/** Nothing past the one repository read: no tip, listing, tree or unit. */
function assertPlannedNothing(
  world: ReturnType<typeof passWorld>,
  pass: Awaited<ReturnType<typeof runBackupCiPass>>,
  code: string,
) {
  assert.equal(world.calls.get("repository:ubiquity/prospector"), 1);
  assert.equal(world.calls.get("branchTip:ubiquity/prospector"), undefined);
  assert.equal(world.calls.get("checkRuns:ubiquity/prospector"), undefined);
  assert.equal(world.calls.get("suites:ubiquity/prospector"), undefined);
  assert.deepEqual(pass.units, []);
  assert.deepEqual(pass.files, []);
  assert(
    world.lines.includes(`backup-ci:ubiquity/prospector:${code}`),
    world.lines.join("\n"),
  );
}

Deno.test("an enrolment-pinned target that turned private is planned nothing", async () => {
  const world = passWorld();
  world.repos.set("ubiquity/prospector", { id: 991, private: true });
  const pass = await runBackupCiPass(
    passDeps(world, enrolled(world), { snapshot: demand() }),
  );
  assertPlannedNothing(world, pass, "private_repository");
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

Deno.test("a committed id is no visibility decision: a private target gets no stand-in or calibration leg", async () => {
  const world = passWorld();
  world.repos.set("ubiquity/prospector", { id: 991, private: true });
  const pass = await runBackupCiPass(
    passDeps(world, [{ repository: "ubiquity/prospector", id: 991 }], {
      snapshot: demand(),
      // Configured calibration commits stay unplanned too.
      calibrationCommits: () => [sha(0x301), sha(0x302)],
    }),
  );
  assertPlannedNothing(world, pass, "private_repository");
});

Deno.test("a committed public target is still read and planned", async () => {
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

Deno.test("an unreadable visibility plans nothing for that target (fail closed)", async () => {
  const world = passWorld();
  world.reads.set("ubiquity/prospector", {
    repository: () => {
      world.calls.set("repository:ubiquity/prospector", 1);
      return Promise.resolve(null);
    },
  });
  const pass = await runBackupCiPass(
    passDeps(world, [{ repository: "ubiquity/prospector", id: 991 }], {
      snapshot: demand(),
      calibrationCommits: () => [sha(0x301)],
    }),
  );
  assertPlannedNothing(world, pass, "repository_unavailable");
});
