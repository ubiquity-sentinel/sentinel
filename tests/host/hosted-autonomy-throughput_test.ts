import assert from "node:assert/strict";
import {
  HOSTED_AUTONOMY_RETIRED,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { SHA1, workRecord } from "../state/helpers.ts";
import {
  passDeps,
  RecordingState,
  snapshotWith,
  surfaces,
} from "./hosted-autonomy-continuation-fixtures.ts";
import {
  BASE,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";

Deno.test("maintenance retires every closed-source record without a five-record throttle", async () => {
  const records = Array.from(
    { length: 12 },
    (_, i) =>
      workRecord(`closed-${i}`, {
        source: { kind: "issue", id: String(1000 + i), revision: SHA1 },
        related: { incidentId: null, issueNumber: 1000 + i },
        nextStep: "work",
      }),
  );
  const state = new RecordingState(snapshotWith(records));
  const github = surfaces(state);
  const original = github.githubFor;
  github.githubFor = (repository) => ({
    ...original(repository)!,
    readIssueOpen: () => Promise.resolve(false),
  });
  const result = await runHostedAutonomy(await passDeps(state, github));
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.equal(
    result.actions.filter((action) => action.startsWith("retire:")).length,
    12,
  );
  assert.equal(state.log.length, 1, "all retirements share one guarded write");
  assert.ok(
    state.snapshot.work.every((row) =>
      row.blocker?.message === HOSTED_AUTONOMY_RETIRED
    ),
  );
  assert.deepEqual(state.snapshot.reservations, []);
});

Deno.test("maintenance closes every proven foreign delivery without a five-record throttle", async () => {
  const tasks = await Promise.all(Array.from({ length: 7 }, async (_, i) => {
    const task = {
      issueNumber: 120 + i,
      title: `Repair issue ${i}`,
      body: `Expected behavior ${i}`,
    };
    return { ...task, digest: await reviewTaskStatementDigest(task) };
  }));
  const records = tasks.map((task, i) => {
    const original = foreignRecord();
    return foreignRecord({
      id: `foreign-${i}`,
      source: { ...original.source, id: String(task.issueNumber) },
      related: { incidentId: null, issueNumber: task.issueNumber },
      target: {
        ...original.target,
        branch: `sentinel/foreign-${i}`,
        pr: 375 + i,
      },
    });
  });
  const reviews = tasks.map((task, i) =>
    foreignReceipt({
      id: `review-receipt:${String(i).repeat(64)}`,
      pullRequest: { number: 375 + i, head: HEAD, base: BASE },
      taskAcceptance: {
        issueNumber: task.issueNumber,
        taskDigest: task.digest,
        verdict: "fulfilled",
        evidence: ["task satisfied"],
      },
    })
  );
  const state = new RecordingState(repairSnapshot(records, reviews));
  const github = surfaces(state);
  const original = github.githubFor;
  const closed: number[] = [];
  github.githubFor = (repository) => ({
    ...original(repository)!,
    readDefaultBranch: () => Promise.resolve("main"),
    hasAllChecksGreen: () => Promise.resolve(true),
    readIssueOpen: (number) => Promise.resolve(!closed.includes(number)),
    readIssueTask: (number) =>
      Promise.resolve(
        tasks.find((task) => task.issueNumber === number) ?? null,
      ),
    readPull: (number) => Promise.resolve(foreignPullFacts({ number })),
    closeIssue: (number) => {
      closed.push(number);
      return Promise.resolve(true);
    },
  });
  const result = await runHostedAutonomy(await passDeps(state, github));
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.deepEqual([...closed].sort(), tasks.map((task) => task.issueNumber));
  assert.ok(state.snapshot.work.every((row) => row.nextStep === "done"));
  assert.deepEqual(state.snapshot.reservations, []);
  assert.deepEqual(github.merges, [], "closure performs no merge");
});
