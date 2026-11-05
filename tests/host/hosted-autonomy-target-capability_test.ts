/**
 * Issue #332: the launcher's target capability pass. A CI-less generic target
 * gets exactly one `<!-- sentinel:skip -->` owner-action issue listing what is
 * missing, cached with its digest so an unchanged tip or missing set never
 * creates or edits again; a backup-listed target with its own workflow is
 * capable; capability appearing at a new tip re-admits the no-CI parks by a
 * status transition only.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { TargetTreeFactsV1 } from "../../src/host/target-policy-generic.ts";
import { NO_CI_AND_NO_LOCAL_VERIFY_DETAIL } from "../../src/host/target-policy-generic.ts";
import { markBlocked } from "../../src/repair/transitions.ts";
import { cachedTargetCapabilityV1 } from "../../src/repair/target-capability.ts";
import {
  runTargetCapabilityPass,
  type TargetCapabilityPassDepsV1,
} from "../../ops/hosted-autonomy-target-capability.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";

const PROSPECTOR = {
  owner: "ubiquity",
  name: "prospector-chrome-extension",
  installationId: 7,
};
const STAKE = { owner: "ubiquity", name: "stake.ubq.fi", installationId: 7 };

const NO_CI: TargetTreeFactsV1 = {
  files: ["package.json", "package-lock.json"],
  hasCiWorkflow: false,
  manifestScripts: { package: ["build"] },
};

function parked(id: string, repository = PROSPECTOR): WorkRecordV1 {
  const record = workRecord(id, {
    repository,
    counters: { attempts: 2, retries: 1, reviewRounds: 0 },
  });
  return markBlocked(
    record,
    "missing_evidence",
    NO_CI_AND_NO_LOCAL_VERIFY_DETAIL,
    T0 + 2000,
  );
}

async function seed(work: WorkRecordV1[]): Promise<MemoryState> {
  const state = new MemoryState();
  const written = await state.writeRepair(
    parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0 + 2000,
      incidents: [],
      evidence: [],
      work,
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    }),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  return state;
}

interface Rig {
  deps: TargetCapabilityPassDepsV1;
  created: { repo: string; number: number; title: string; body: string }[];
  lookups: number;
  updated: { repo: string; number: number; body: string }[];
  factsReads: number;
  tips: Map<string, GitSha>;
  facts: Map<string, TargetTreeFactsV1>;
}

function rig(
  state: MemoryState,
  targets = [PROSPECTOR],
  backupTargets: string[] = [],
): Rig {
  const out: Rig = {
    created: [],
    lookups: 0,
    updated: [],
    factsReads: 0,
    tips: new Map(targets.map((target) => [target.name, SHA2])),
    facts: new Map(targets.map((target) => [target.name, NO_CI])),
    deps: undefined as unknown as TargetCapabilityPassDepsV1,
  };
  let next = 41;
  out.deps = {
    state,
    clock: new FakeClock(T0 + 10_000),
    generation: 9,
    targets,
    backupTargets,
    readTip: (repository) =>
      Promise.resolve({
        defaultBranch: "main",
        tip: out.tips.get(repository.name)!,
      }),
    readFacts: (repository) => {
      out.factsReads++;
      return Promise.resolve(out.facts.get(repository.name) ?? null);
    },
    issuesFor: (repository) => ({
      findExisting: () => {
        out.lookups++;
        const open = out.created.filter((issue) =>
          issue.repo === repository.name
        ).map((issue) => issue.number);
        return Promise.resolve({
          number: open.length === 0 ? null : Math.min(...open),
        });
      },
      create: (input) => {
        out.created.push({ repo: repository.name, number: next, ...input });
        return Promise.resolve(next++);
      },
      update: (number, input) => {
        out.updated.push({ repo: repository.name, number, body: input.body });
        return Promise.resolve(true);
      },
    }),
  };
  return out;
}

const snap = (state: MemoryState): RepairStateSnapshotV1 => state.repair!;

Deno.test("capability pass: a CI-less target files one marked owner issue and writes no reservation", async () => {
  const state = await seed([workRecord("fresh", { repository: PROSPECTOR })]);
  const r = rig(state);
  const result = await runTargetCapabilityPass(r.deps);
  assert.equal(result.status, "applied");
  assert.equal(r.created.length, 1);
  const lines = r.created[0]!.body.split("\n");
  assert.equal(lines[0], "<!-- sentinel:skip -->");
  const listed = lines.filter((line) => line.startsWith("- "));
  assert.equal(listed.length, 2);
  assert.match(listed[0]!, /pull_request/);
  assert.match(listed[1]!, /verify command/);
  const row = cachedTargetCapabilityV1(snap(state), PROSPECTOR)!;
  assert.equal(row.capable, false);
  assert.deepEqual(row.missing, [
    "pull_request_ci_workflow",
    "runnable_local_verify_command",
  ]);
  assert.equal(row.ownerIssue, 41);
  assert.equal(row.ownerIssueDigest, row.missingDigest);
  assert.equal(row.tip, SHA2);
  assert.equal(snap(state).reservations.length, 0);
  assert.equal(snap(state).work[0]!.nextStep, "work", "no record rewritten");

  // Unchanged tip and generation: no facts read, no issue create or edit,
  // no state write.
  const writes = state.repairWrites;
  const again = await runTargetCapabilityPass(r.deps);
  assert.equal(again.status, "unchanged");
  assert.equal(r.created.length, 1);
  assert.equal(r.updated.length, 0);
  assert.equal(r.factsReads, 1);
  assert.equal(state.repairWrites, writes);

  // A moved tip with the same missing set re-reads facts but edits nothing.
  r.tips.set(PROSPECTOR.name, SHA3);
  const moved = await runTargetCapabilityPass(r.deps);
  assert.equal(moved.status, "applied");
  assert.equal(r.factsReads, 2);
  assert.equal(r.created.length, 1);
  assert.equal(r.updated.length, 0);

  // A changed missing set edits the same issue once.
  r.tips.set(PROSPECTOR.name, SHA1);
  r.facts.set(PROSPECTOR.name, {
    ...NO_CI,
    manifestScripts: { package: ["test"] },
  });
  await runTargetCapabilityPass(r.deps);
  assert.equal(r.created.length, 1);
  assert.equal(r.updated.length, 1);
  assert.equal(r.updated[0]!.number, 41);
  assert.equal(
    r.updated[0]!.body.split("\n").filter((line) => line.startsWith("- "))
      .length,
    1,
  );
  await runTargetCapabilityPass(r.deps);
  assert.equal(r.updated.length, 1, "no second edit for the same set");
});

Deno.test("capability pass: a new generation re-verifies without re-filing", async () => {
  const state = await seed([]);
  const r = rig(state);
  await runTargetCapabilityPass(r.deps);
  r.deps = { ...r.deps, generation: 10 };
  await runTargetCapabilityPass(r.deps);
  assert.equal(r.factsReads, 2);
  assert.equal(r.created.length, 1);
  assert.equal(
    cachedTargetCapabilityV1(snap(state), PROSPECTOR)!.generation,
    10,
  );
});

Deno.test("capability pass: a backup-listed target with its own workflow is capable; without one it is not", async () => {
  const state = await seed([parked("stake-1", STAKE)]);
  const r = rig(state, [PROSPECTOR, STAKE], [
    "ubiquity/prospector-chrome-extension",
    "ubiquity/stake.ubq.fi",
  ]);
  r.facts.set(PROSPECTOR.name, { ...NO_CI, hasCiWorkflow: true });
  const result = await runTargetCapabilityPass(r.deps);
  const prospector = cachedTargetCapabilityV1(snap(state), PROSPECTOR)!;
  assert.equal(prospector.capable, true);
  assert.equal(prospector.backupCovered, true);
  assert.equal(prospector.ownerIssue, null);
  const stake = cachedTargetCapabilityV1(snap(state), STAKE)!;
  assert.equal(stake.capable, false, "backup CI needs the target's workflow");
  assert.equal(stake.backupCovered, true);
  assert.deepEqual(r.created.map((issue) => issue.repo), [STAKE.name]);
  assert.match(r.created[0]!.body, /listed for Sentinel's backup CI/);
  assert.deepEqual(result.readmitted, []);
  assert.equal(snap(state).work[0]!.nextStep, "blocked");
});

Deno.test("capability pass: capability appearing re-admits the no-CI parks by status only", async () => {
  const other = workRecord("other-block", { repository: PROSPECTOR });
  const otherBlocked = markBlocked(other, "other", "unrelated", T0 + 2000);
  const state = await seed([
    parked("p-1"),
    parked("p-2"),
    otherBlocked,
    parked("s-1", STAKE),
  ]);
  const r = rig(state, [PROSPECTOR, STAKE]);
  await runTargetCapabilityPass(r.deps);
  assert.equal(r.created.length, 2);
  const before = snap(state).work.map((record) => ({ ...record }));

  r.tips.set(PROSPECTOR.name, SHA3);
  r.facts.set(PROSPECTOR.name, { ...NO_CI, hasCiWorkflow: true });
  const result = await runTargetCapabilityPass(r.deps);
  assert.equal(result.status, "applied");
  assert.deepEqual(
    result.readmitted.sort(),
    [
      before[0]!.id,
      before[1]!.id,
    ].sort(),
  );
  for (const [index, record] of snap(state).work.entries()) {
    const prior = before[index]!;
    if (result.readmitted.includes(record.id)) {
      assert.equal(record.nextStep, "work");
      assert.equal(record.blocker, null);
      assert.deepEqual(record.counters, prior.counters, "charges kept");
      assert.deepEqual(record.target, prior.target);
      assert.deepEqual(record.evidence, prior.evidence);
      assert.equal(record.intent, prior.intent);
    } else {
      assert.deepEqual(record, prior, "other records untouched");
    }
  }
  const row = cachedTargetCapabilityV1(snap(state), PROSPECTOR)!;
  assert.equal(row.capable, true);
  assert.equal(row.ownerIssue, null);
  assert.equal(row.tip, SHA3);
  assert.equal(r.created.length, 2, "no issue for a capable target");
  assert.equal(snap(state).reservations.length, 0, "nothing charged");
});

Deno.test("capability pass: an unreadable tip or facts writes nothing; named policies are never checked", async () => {
  const state = await seed([]);
  const gateway = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 };
  const r = rig(state, [PROSPECTOR, gateway]);
  r.facts.delete(PROSPECTOR.name);
  const result = await runTargetCapabilityPass(r.deps);
  assert.equal(result.status, "unchanged");
  assert.ok(result.actions.includes(
    "capability:ubiquity/prospector-chrome-extension:facts_unreadable",
  ));
  assert.equal(r.created.length, 0);
  assert.equal(snap(state).targetCapabilities, undefined);
  assert.equal(
    result.actions.some((action) => action.includes("ai.ubq.fi")),
    false,
  );
});

Deno.test("capability pass: an issue whose recording write failed is adopted, never duplicated", async () => {
  const state = await seed([]);
  const r = rig(state);
  state.conflictRepairNext = true;
  const result = await runTargetCapabilityPass(r.deps);
  assert.equal(result.status, "skipped");
  assert.ok(result.actions.includes("capability:write_conflict"));
  assert.equal(snap(state).targetCapabilities, undefined);
  assert.equal(r.created.length, 1);

  const again = await runTargetCapabilityPass(r.deps);
  assert.equal(again.status, "applied");
  assert.ok(again.actions.includes(
    "capability:ubiquity/prospector-chrome-extension:issue_adopted:41",
  ));
  assert.equal(r.created.length, 1, "no duplicate issue");
  assert.equal(r.updated.length, 1, "the adopted issue states the list");
  const row = cachedTargetCapabilityV1(snap(state), PROSPECTOR)!;
  assert.equal(row.ownerIssue, 41);
  assert.equal(row.ownerIssueDigest, row.missingDigest);
  await runTargetCapabilityPass(r.deps);
  assert.equal(r.lookups, 2, "a recorded issue needs no lookup");
  assert.equal(r.updated.length, 1);
});

Deno.test("capability pass: an unreadable issue listing creates nothing", async () => {
  const state = await seed([]);
  const r = rig(state);
  const issues = r.deps.issuesFor(PROSPECTOR)!;
  r.deps = {
    ...r.deps,
    issuesFor: () => ({ ...issues, findExisting: () => Promise.resolve(null) }),
  };
  const result = await runTargetCapabilityPass(r.deps);
  assert.ok(result.actions.includes(
    "capability:ubiquity/prospector-chrome-extension:issue_lookup_unreadable",
  ));
  assert.equal(r.created.length, 0);
  const row = cachedTargetCapabilityV1(snap(state), PROSPECTOR)!;
  assert.equal(row.ownerIssue, null, "the verdict is still cached");
});

Deno.test("capability pass: no target starts past the deadline", async () => {
  const state = await seed([]);
  const r = rig(state, [PROSPECTOR, STAKE]);
  r.deps = { ...r.deps, deadline: T0 + 10_000 };
  const result = await runTargetCapabilityPass(r.deps);
  assert.equal(result.status, "unchanged");
  assert.ok(result.actions.includes(
    "capability:ubiquity/prospector-chrome-extension:deadline",
  ));
  assert.equal(r.factsReads, 0);
});
