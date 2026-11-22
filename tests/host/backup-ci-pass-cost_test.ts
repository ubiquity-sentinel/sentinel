/**
 * Review MUST 3 (probe P7): with 29 enrolled targets the pass read about
 * 200 times and wrote a timestamp-only store commit EVERY pass with no
 * work, on the App rate limit the supervisor shares. Now: no target read
 * without a live demand record; ids come from store pins; ingest never
 * waits on a target read; nothing timestamp-only is written; the default
 * branch tip is no candidate of its own; one throttled answer stops the
 * client for the pass; planning has a deadline. Fakes only.
 */
import assert from "node:assert/strict";
import {
  backupCiCommitPath,
  parseBackupCiTargets,
} from "../../src/contracts/backup-ci.ts";
import { backupCiEnrolmentPath } from "../../src/contracts/backup-ci-trust.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  BACKUP_CI_PASS_BUDGET_MS,
  runBackupCiPass,
} from "../../ops/backup-ci-pass.ts";
import {
  backupCiDemandOrder,
  backupCiDemandRecords,
} from "../../ops/backup-ci-demand.ts";
import { backupCiCandidates } from "../../ops/backup-ci-plan.ts";
import {
  BACKUP_CI_RATE_FLOOR,
  createBackupCiApi,
} from "../../ops/backup-ci-plan-reads.ts";
import { workRecord } from "../state/helpers.ts";
import {
  commitFile,
  dispatched,
  H,
  NAME,
  OWNER,
  REPO,
  REPO_ID,
  RUNNER,
  T0,
} from "../github/backup-ci-fixtures.ts";
import {
  passDeps,
  passWorld,
  sha,
  targetReadCount,
} from "./backup-ci-pass-fakes.ts";

const TARGETS = parseBackupCiTargets(
  JSON.parse(await Deno.readTextFile("sentinel.backup-ci-targets.json")),
);

function snapshot(work: unknown[]): RepairStateSnapshotV1 {
  return {
    work,
    reservations: [],
    reviews: [],
    releaseRequests: [],
  } as unknown as RepairStateSnapshotV1;
}

function waiting(id: string, name: string, n: number, since = T0) {
  return workRecord(id, {
    repository: { owner: "ubiquity", name, installationId: 7 },
    nextStep: "work",
    target: {
      base: sha(0x100 + n),
      branch: `sentinel/fix-${n}`,
      checkpoint: null,
      head: sha(0x200 + n),
      pr: n,
    },
    wait: { reason: "ci_pending", since, until: null },
  });
}

Deno.test("P7: idle enrolled targets cost no read and no store write", async () => {
  assert.equal(TARGETS.length, 28);
  const world = passWorld();
  for (const run of [0, 1, 2]) {
    world.calls.clear();
    const pass = await runBackupCiPass(
      passDeps(world, TARGETS, {
        runId: 4000 + run,
        now: () => T0 + run * 300_000,
        snapshot: snapshot([]),
      }),
    );
    assert.equal(targetReadCount(world), 0, `pass ${run} reads`);
    assert.equal(pass.files.length, 0, `pass ${run} rows`);
    assert.equal(pass.units.length + pass.comparisons.length, 0);
    assert.deepEqual(pass.enrolments, []);
  }
  assert(world.lines.includes("backup-ci:plan:no_demand"));
});

Deno.test("only a target with a live CI-pending record is read, and enrolled once", async () => {
  const world = passWorld();
  world.repos.set("ubiquity/prospector", { id: 991 });
  const deps = (run: number) =>
    passDeps(world, TARGETS, {
      runId: 4100 + run,
      snapshot: snapshot([waiting("issue-p-1", "prospector", 1)]),
    });
  const first = await runBackupCiPass(deps(0));
  const reads = [...world.calls.keys()].filter((k) => k.includes(":"));
  assert(reads.length > 0);
  assert(reads.every((k) => k.endsWith(":ubiquity/prospector")), reads.join());
  assert.deepEqual(first.enrolments, [{
    owner: "ubiquity",
    name: "prospector",
    id: 991,
  }]);
  // The commit step pins it; the next pass enrols nothing again.
  world.store.set(backupCiEnrolmentPath("ubiquity", "prospector"), {
    version: 1,
    kind: "sentinel_backup_ci_enrolment",
    repository: { owner: "ubiquity", name: "prospector", id: 991 },
    enrolledAt: T0,
  });
  const second = await runBackupCiPass(deps(1));
  assert.deepEqual(second.enrolments, []);
  // A record whose CI is not pending is no demand.
  const done = workRecord("issue-p-2", {
    repository: { owner: "ubiquity", name: "prospector", installationId: 7 },
    nextStep: "delivery",
    target: {
      base: sha(1),
      branch: "x",
      checkpoint: null,
      head: sha(2),
      pr: 9,
    },
  });
  assert.deepEqual(
    backupCiDemandRecords(snapshot([done]), "ubiquity/prospector"),
    [],
  );
});

Deno.test("a private or renamed repository is never enrolled", async () => {
  for (
    const repo of [{ id: 5, private: true }, {
      id: 6,
      fullName: "ubiquity/renamed",
    }]
  ) {
    const world = passWorld();
    world.repos.set("ubiquity/prospector", repo);
    const pass = await runBackupCiPass(
      passDeps(world, TARGETS, {
        snapshot: snapshot([waiting("issue-p-1", "prospector", 1)]),
      }),
    );
    assert.deepEqual(pass.enrolments, []);
    assert.equal(world.calls.get("branchTip:ubiquity/prospector"), undefined);
  }
});

Deno.test("ingest of a pinned id-less target never waits on a target read", async () => {
  const world = passWorld();
  // The pin and the dispatched entry were written in one store commit.
  world.store.set(backupCiEnrolmentPath(OWNER, NAME), {
    version: 1,
    kind: "sentinel_backup_ci_enrolment",
    repository: { owner: OWNER, name: NAME, id: REPO_ID },
    enrolledAt: T0,
  });
  world.store.set(
    backupCiCommitPath(OWNER, NAME, H),
    commitFile([dispatched()]),
  );
  const pass = await runBackupCiPass(
    passDeps(world, [{ repository: REPO, id: null }], {
      snapshot: snapshot([]),
      targetReads: () => {
        throw new Error("no target read may be needed");
      },
    }),
  );
  // The leg listing was read for the in-flight unit (still pending here).
  assert(
    (world.calls.get("legRuns") ?? 0) > 0,
    "ingest ran from the store pin alone",
  );
  assert.equal(pass.files.length, 0, "a pending leg writes nothing");
});

Deno.test("a planning visit that finds nothing writes nothing", async () => {
  const world = passWorld();
  world.repos.set("ubiquity/prospector", { id: 991 });
  const pass = await runBackupCiPass(
    passDeps(world, [{ repository: "ubiquity/prospector", id: 991 }], {
      snapshot: snapshot([waiting("issue-p-1", "prospector", 1)]),
    }),
  );
  assert((world.calls.get("checkRuns:ubiquity/prospector") ?? 0) > 0);
  assert.deepEqual(pass.files, []);
});

Deno.test("the default branch tip is no candidate unless a record needs it", () => {
  const record = waiting("issue-r-1", "prospector", 4);
  const candidates = backupCiCandidates({
    records: [record as never],
    baseTip: sha(0xabc),
    defaultBranch: "main",
    calibrationCommits: [],
    calibrated: true,
    files: new Map(),
    mode: "on",
    runnerId: RUNNER,
  });
  assert(candidates.every((c) => c.commit !== sha(0xabc)));
});

Deno.test("demand order: the longest-waiting target first", () => {
  const order = backupCiDemandOrder(
    new Map([
      ["ubiquity/a", [waiting("a", "a", 1, T0 + 500)] as never[]],
      ["ubiquity/b", [waiting("b", "b", 2, T0)] as never[]],
    ]),
  );
  assert.deepEqual(order, ["ubiquity/b", "ubiquity/a"]);
});

Deno.test("one throttled answer stops a client for the pass; the target floor too", async () => {
  let calls = 0;
  const answer = (status: number, remaining: string) => () => {
    calls++;
    return Promise.resolve(
      new Response("{}", {
        status,
        headers: { "x-ratelimit-remaining": remaining },
      }),
    );
  };
  const reasons: string[] = [];
  const throttled = createBackupCiApi(
    "t",
    answer(403, "0") as unknown as typeof fetch,
    { onCooldown: (r) => reasons.push(r) },
  );
  assert.equal(await throttled.get("/x"), null);
  assert.equal(await throttled.get("/y"), null);
  assert.equal(calls, 1, "the second call never left");
  calls = 0;
  const low = createBackupCiApi(
    "t",
    answer(200, String(BACKUP_CI_RATE_FLOOR - 1)) as unknown as typeof fetch,
    { floor: BACKUP_CI_RATE_FLOOR, onCooldown: (r) => reasons.push(r) },
  );
  assert.deepEqual(await low.get("/x"), {});
  assert.equal(await low.get("/y"), null);
  assert.equal(calls, 1);
  // The workflow-token client has no floor (its budget is 1000 an hour).
  calls = 0;
  const own = createBackupCiApi(
    "t",
    answer(200, "500") as unknown as typeof fetch,
  );
  await own.get("/x");
  assert.deepEqual(await own.get("/y"), {});
  assert.equal(calls, 2);
  assert.deepEqual(reasons, ["throttled", "floor"]);
});

Deno.test("planning stops at the pass deadline", async () => {
  const world = passWorld();
  world.repos.set("ubiquity/prospector", { id: 991 });
  world.repos.set("ubiquity/ai.ubq.fi", { id: 992 });
  let t = T0;
  await runBackupCiPass(
    passDeps(world, TARGETS, {
      now: () => {
        t += BACKUP_CI_PASS_BUDGET_MS;
        return t;
      },
      snapshot: snapshot([
        waiting("issue-p-1", "prospector", 1),
        waiting("issue-a-1", "ai.ubq.fi", 2, T0 + 1),
      ]),
    }),
  );
  assert(world.lines.includes("backup-ci:plan:deadline"));
});
