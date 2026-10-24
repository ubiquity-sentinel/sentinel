/**
 * Issue #188: ai.ubq.fi queue custody that cannot be proven this pass (here
 * an unavailable effective-rule read and native queue observation) no longer
 * stops maintenance for every target. A deliverable self record still merges
 * while every ai.ubq.fi record is protected: none is written or delivered,
 * and the custody output stays not ready.
 */
import assert from "node:assert/strict";
import { runHostedAutonomy } from "../../ops/hosted-autonomy.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  finding,
  FOREIGN_TARGET,
  HEAD,
  pullFacts,
} from "./hosted-autonomy-fixtures.ts";
import {
  darkQueueCoordinatorFixture,
  darkQueueFixture,
} from "./hosted-autonomy-dark-queue-fixture.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";
import { T0 } from "../state/helpers.ts";

const GATEWAY_REPO = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;

Deno.test("custody degraded: an unprovable ai.ubq.fi queue still lets the self record merge", async () => {
  const self = blockedRecord({
    blocker: {
      kind: "review_quota",
      message: "review rounds exhausted without an accepted verdict (P2)",
      since: T0 + 3000,
    },
    counters: { attempts: 4, retries: 1, reviewRounds: 3 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      checkpoint: null,
      head: HEAD,
      pr: 51,
    },
  });
  // An ai.ubq.fi record the degraded pass must leave exactly as it is.
  const gateway = blockedRecord({
    id: FOREIGN_TARGET,
    repository: GATEWAY_REPO,
    source: { kind: "issue", id: "120", revision: BASE },
    related: { incidentId: null, issueNumber: 120 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-ai.ubq.fi-120",
      checkpoint: null,
      head: HEAD,
      pr: 375,
    },
  });
  const receipt = authorizingReceipt({
    findings: [finding("P2")],
    unresolvedSeverities: ["P2"],
  });
  const { rig, github } = await makeRig("autonomy-custody-degraded", {
    repair: repairSnapshot([self, gateway], [receipt]),
    pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    afterMerge: pullFacts(),
  });
  try {
    const before = await rig.state.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const gatewayBefore = before.value.snapshot.work.find((row) =>
      row.id === FOREIGN_TARGET
    );
    const scoped = { ...rig, githubFor: () => github };
    const coordinator = await darkQueueCoordinatorFixture(scoped);
    const ready: boolean[] = [];
    const result = await runHostedAutonomy({
      state: rig.state,
      githubFor: () => github,
      queueCustody: darkQueueFixture(scoped),
      queue: {
        ...coordinator,
        readEffectiveQueueRule: () =>
          Promise.resolve({ status: "unavailable" }),
        surface: {
          ...coordinator.surface,
          readQueue: () => Promise.resolve({ status: "unavailable" }),
        },
      } as unknown as typeof coordinator,
      clock: { now: () => T0 + 5_000_000 },
      onQueueCustodyReady: (value) => {
        ready.push(value);
      },
    });
    assert.equal(rig.merges, 1, JSON.stringify(result));
    assert.equal(result.status, "applied");
    assert.ok(result.actions.includes("queue:observation_unavailable"));
    assert.ok(result.actions.includes("queue:gateway_protected"));
    assert.equal(ready.at(-1), false, "custody output stays not ready");
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.deepEqual(
      after.value.snapshot.work.find((row) => row.id === FOREIGN_TARGET),
      gatewayBefore,
      "no ai.ubq.fi row is written",
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
