import assert from "node:assert/strict";
import { runHostedAutonomy } from "../../ops/hosted-autonomy.ts";
import { runHostedClosurePass } from "../../ops/hosted-autonomy-closure-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { progressStage } from "../../src/host/progress-comments.ts";
import { T0 } from "../state/helpers.ts";
import {
  FOREIGN_TASK,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";

const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 1,
};

async function deliveryRig(
  conclusion: string | null,
  repository = PASSPORT,
  checkName = "deploy-standby",
) {
  let now = T0 + 5_000_000;
  const record = foreignRecord({ repository });
  const { rig, github } = await makeRig("required-delivery", {
    repair: repairSnapshot([record], [
      foreignReceipt({ repository }),
    ]),
  });
  const comments: string[] = [];
  const reads: string[] = [];
  Object.assign(github, {
    readDeliveryChecks: (head: string) => {
      reads.push(head);
      return Promise.resolve([{
        name: checkName,
        runId: 33701000001,
        head: HEAD,
        status: conclusion === null ? "in_progress" : "completed",
        conclusion,
      }]);
    },
    commentDeliveryProgress: (_issue: number, message: string) => {
      comments.push(message);
      return Promise.resolve(true);
    },
  });
  github.readIssueTask = () => Promise.resolve(FOREIGN_TASK);
  github.readPull = () =>
    Promise.resolve(foreignPullFacts({
      author: "ubiquity-sentinel[bot]",
      mergedBy: "ubiquity-sentinel[bot]",
    }));
  const deps: HostedAutonomyDepsV1 = {
    state: rig.state,
    githubFor: () => github,
    clock: { now: () => now },
  };
  async function context(): Promise<HostedAutonomyPassContextV1> {
    const repair = await rig.state.readRepair();
    const release = await rig.state.readRelease();
    assert.ok(repair.ok && repair.value.status === "found");
    assert.ok(release.ok && release.value.status === "found");
    return {
      deps,
      snapshot: repair.value.snapshot,
      observedHead: repair.value.head,
      initialHead: repair.value.head,
      releaseSnapshot: release.value.snapshot,
      actions: [],
      revisions: [],
      closedIssues: new Set(),
      foreignMerged: new Map(),
      dedicatedReservations: new Set(),
      ...createHostedAutonomyScopes(deps),
    };
  }
  return {
    deps,
    rig,
    github,
    record,
    reads,
    comments,
    context,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

Deno.test("Passport delivery: a merged PR's failed deploy parks instead of closing", async () => {
  const { rig, reads, comments, context } = await deliveryRig("failure");
  try {
    const result = await runHostedClosurePass(await context());
    assert.equal(result?.status, "applied");
    assert.deepEqual(rig.closed, []);
    assert.deepEqual(reads, [HEAD]);
    const state = await context();
    const parked = state.snapshot.work[0];
    assert.equal(parked.nextStep, "blocked");
    assert.match(
      parked.blocker!.message,
      /deploy-standby.*33701000001.*failure/,
    );
    assert.match(progressStage(parked)!.words, /deploy-standby.*33701000001/);
    assert.match(comments.join("\n"), /deploy-standby.*33701000001/);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("Passport delivery: success is receipted durably before the issue closes", async () => {
  const { rig, github, reads, context } = await deliveryRig("success");
  try {
    github.closeIssue = async (issue) => {
      const persisted = (await context()).snapshot.work[0];
      assert.deepEqual(persisted.deliveryReceipt?.checks, [{
        name: "deploy-standby",
        runId: 33701000001,
        conclusion: "success",
      }]);
      assert.equal(persisted.deliveryReceipt?.head, HEAD);
      assert.notEqual(persisted.nextStep, "done");
      rig.closed.push(issue);
      return true;
    };
    const result = await runHostedClosurePass(await context());
    assert.equal(result?.status, "applied");
    assert.deepEqual(rig.closed, [120]);
    assert.deepEqual(reads, [HEAD]);
    const done = (await context()).snapshot.work[0];
    assert.equal(done.nextStep, "done");
    assert.equal(done.deliveryReceipt?.checks[0].runId, 33701000001);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("Passport delivery: pending checks wait with a preserved bounded deadline", async () => {
  const { rig, advance, context } = await deliveryRig(null);
  try {
    await runHostedClosurePass(await context());
    const first = (await context()).snapshot.work[0];
    assert.equal(first.wait?.reason, "deployment");
    assert.match(
      progressStage(first)!.words,
      /waiting for required deployment checks/,
    );
    advance(6 * 60 * 60_000);
    await runHostedClosurePass(await context());
    const parked = (await context()).snapshot.work[0];
    assert.equal(parked.nextStep, "blocked");
    assert.match(
      parked.blocker!.message,
      /timed out.*deploy-standby.*33701000001/,
    );
    assert.deepEqual(rig.closed, []);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("native delivery read retains the deploy run excluded from the merge gate", async () => {
  const { createHostedAutonomyGitHub } = await import(
    "../../ops/hosted-autonomy-github.ts"
  );
  const { parseCheckRunWire } = await import("../../src/github/wire.ts");
  const { checkRun, checkRunPage, jsonResponse } = await import(
    "./hosted-autonomy-fixtures.ts"
  );
  const deployment = checkRun("deploy-standby", {
    id: 33701000001,
    conclusion: "failure",
    started_at: null,
    completed_at: null,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(jsonResponse(checkRunPage([
      checkRun("ci"),
      deployment,
    ], 2)))) as typeof fetch;
  try {
    const github = createHostedAutonomyGitHub("fixture-token", PASSPORT);
    assert.equal(await github.hasAllChecksGreen(HEAD), true);
    assert.deepEqual(
      await github.readDeliveryChecks!(HEAD, ["deploy-standby"]),
      [{
        name: "deploy-standby",
        runId: 33701000001,
        head: HEAD,
        status: "completed",
        conclusion: "failure",
      }],
    );
    assert.equal(parseCheckRunWire(deployment, "$").runId, 33701000001);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("router delivery: a red deploy parks even when the ordinary CI aggregate is red", async () => {
  const repository = { ...PASSPORT, name: "ubq.fi-router" };
  const { rig, github, context } = await deliveryRig(
    "failure",
    repository,
    "deploy",
  );
  github.hasAllChecksGreen = () => Promise.resolve(false);
  try {
    await runHostedClosurePass(await context());
    const parked = (await context()).snapshot.work[0];
    assert.equal(parked.nextStep, "blocked");
    assert.match(parked.blocker!.message, /deploy run 33701000001: failure/);
    assert.deepEqual(rig.closed, []);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("Passport delivery: a later successful deployment ends the wait and closes", async () => {
  const { deps, rig, github, advance, context } = await deliveryRig(null);
  try {
    await runHostedAutonomy(deps);
    assert.deepEqual(rig.closed, []);
    advance(2 * 60_000);
    github.readDeliveryChecks = () =>
      Promise.resolve([{
        name: "deploy-standby",
        runId: 33701000002,
        head: HEAD,
        status: "completed",
        conclusion: "success",
      }]);
    await runHostedAutonomy(deps);
    const done = (await context()).snapshot.work[0];
    assert.equal(done.nextStep, "done");
    assert.equal(done.wait, null);
    assert.equal(done.deliveryReceipt?.checks[0].runId, 33701000002);
    assert.deepEqual(rig.closed, [120]);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
