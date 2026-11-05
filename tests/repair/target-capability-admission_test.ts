/** Target capability at the real intake/start boundary, without external IO. */
import assert from "node:assert/strict";
import { runTargetCapabilityPass } from "../../ops/hosted-autonomy-target-capability.ts";
import { createTargetConfigV1 } from "../../src/host/targets.ts";
import type { TargetTreeFactsV1 } from "../../src/host/target-policy-generic.ts";
import {
  cachedTargetCapabilityV1,
  capabilityRowV1,
  evaluateTargetCapabilityV1,
} from "../../src/repair/target-capability.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import { SHA1, SHA2, SHA3, workRecord } from "../state/helpers.ts";

const NO_CI: TargetTreeFactsV1 = {
  files: ["package.json", "package-lock.json"],
  hasCiWorkflow: false,
  manifestScripts: { package: ["build"] },
};

function scenario(initial = NO_CI) {
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  const issue = issueRecord(42, {
    title: "Repair a regression",
    relations: { openBlockers: [], subIssueCount: 0 },
  });
  github.listed = [issue];
  github.latest.set(42, issue);
  const rig = makeMemoryRig(github);
  rig.configs[0] = createTargetConfigV1(
    rig.configs[0]!,
    {
      owner: "ubiquity",
      name: "capability-fixture",
      slug: "ubiquity/capability-fixture",
    },
    "development",
    initial,
  );
  const repository = rig.configs[0]!.repository;
  rig.state.repair = seededSnapshot([]);
  rig.state.repairHead = SHA1;
  let facts = initial;
  let tip = SHA2;
  let factsReads = 0;
  const created: { title: string; body: string }[] = [];
  const edited: number[] = [];
  const deps = {
    state: rig.state,
    clock: rig.clock,
    generation: 1,
    targets: [repository],
    backupTargets: [] as string[],
    readTip: () => Promise.resolve({ defaultBranch: "development", tip }),
    readFacts: () => {
      factsReads++;
      return Promise.resolve(facts);
    },
    issuesFor: () => ({
      findExisting: () =>
        Promise.resolve({ number: created.length === 0 ? null : 41 }),
      create: (issue: { title: string; body: string }) => {
        created.push(issue);
        return Promise.resolve(41);
      },
      update: (number: number) => {
        edited.push(number);
        return Promise.resolve(true);
      },
    }),
  };
  return {
    ...rig,
    deps,
    repository,
    created,
    edited,
    factsReads: () => factsReads,
    move(next: TargetTreeFactsV1, sha = SHA3) {
      facts = next;
      tip = sha;
    },
  };
}

Deno.test("capability lifecycle: CI-less intake creates no work, source read or reservation and one owner issue", async () => {
  const r = scenario();
  await runTargetCapabilityPass(r.deps);
  for (let pass = 0; pass < 2; pass++) {
    await r.run();
    await runTargetCapabilityPass(r.deps);
  }
  assert.equal(r.state.repair!.work.length, 0);
  assert.equal(r.state.repair!.reservations.length, 0);
  assert.equal(r.model.requests.length, 0);
  assert.equal(r.github.calls.includes("listOpenIssues"), false);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0]!.body.split("\n")[0], "<!-- sentinel:skip -->");
  assert.equal(r.edited.length, 0);
  assert.equal(r.factsReads(), 1);
});

Deno.test("capability lifecycle: a cached refusal defers existing serial work before source reads or model starts", async () => {
  const r = scenario({ ...NO_CI, hasCiWorkflow: true });
  const record = workRecord("legacy-capability", {
    repository: r.repository,
    updatedAt: r.clock.now(),
    source: { kind: "issue", id: "42", revision: SHA1 },
    related: { incidentId: null, issueNumber: 42 },
    target: {
      base: SHA1,
      branch: "sentinel/repair/legacy-capability",
      checkpoint: null,
      head: null,
      pr: null,
    },
  });
  const row = capabilityRowV1({
    repository: r.repository,
    defaultBranch: "development",
    tip: SHA2,
    generation: 1,
    verdict: await evaluateTargetCapabilityV1(NO_CI, false),
    ownerIssue: null,
    ownerIssueDigest: null,
    checkedAt: r.clock.now(),
  });
  r.state.repair = seededSnapshot([record], { targetCapabilities: [row] });
  const outcome = await r.run();
  assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
  assert.equal(r.model.requests.length, 0);
  assert.equal(r.state.repair!.reservations.length, 0);
  assert.equal(
    r.github.calls.some((call) => call.startsWith("readIssue:")),
    false,
  );
  assert.deepEqual(r.state.repair!.work[0], record);
});

Deno.test("capability cache: backup configuration is refreshed at an unchanged tip and generation", async () => {
  const r = scenario();
  await runTargetCapabilityPass(r.deps);
  r.deps.backupTargets.push("UBIQUITY/CAPABILITY-FIXTURE");
  await runTargetCapabilityPass(r.deps);
  assert.equal(
    cachedTargetCapabilityV1(r.state.repair!, r.repository)!.backupCovered,
    true,
  );
  assert.equal(r.created.length, 1);
});

Deno.test("capability owner issue: retain its binding across recovery and later loss of CI", async () => {
  const r = scenario();
  await runTargetCapabilityPass(r.deps);
  r.move({ ...NO_CI, hasCiWorkflow: true });
  await runTargetCapabilityPass(r.deps);
  r.move(NO_CI, SHA1);
  await runTargetCapabilityPass(r.deps);
  assert.equal(
    r.created.length,
    1,
    "never create a second issue after capability recovery",
  );
  assert.equal(
    cachedTargetCapabilityV1(r.state.repair!, r.repository)!.ownerIssue,
    41,
  );
});

Deno.test("capability lifecycle: backup-covered target workflow permits real intake and an implementation reservation", async () => {
  const r = scenario({ ...NO_CI, hasCiWorkflow: true });
  r.deps.backupTargets.push("ubiquity/capability-fixture");
  await runTargetCapabilityPass(r.deps);
  await r.run();
  assert.equal(r.created.length, 0);
  assert.equal(r.model.requests.length, 1);
  assert.ok(
    r.state.repair!.reservations.some((row) =>
      row.purpose === "implementation"
    ),
  );
});

Deno.test("capability lifecycle: an uncached CI-less target is refused at intake too", async () => {
  const r = scenario();
  const outcome = await r.run();
  assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
  assert.equal(r.state.repair!.work.length, 0);
  assert.equal(r.state.repair!.reservations.length, 0);
  assert.equal(r.github.calls.includes("listOpenIssues"), false);
  await runTargetCapabilityPass(r.deps);
  assert.equal(r.created.length, 1);
});
