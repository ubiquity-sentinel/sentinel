import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import { buildHostedReleaseRequest } from "../../ops/hosted-autonomy.ts";
import { T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  deliveryRecord,
  FOREIGN_BRANCH,
  FOREIGN_PR,
  FOREIGN_TARGET,
  FOREIGN_TASK,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
  isSelfRepository,
  MERGE,
  pullFacts,
  SELF_REPO,
  SELF_TASK,
  SELF_TASK_BODY,
  SELF_TASK_TITLE,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  readRequests,
  repairSnapshot,
  type RigV1,
  run,
} from "./hosted-autonomy-rig.ts";

async function readWork(rig: RigV1): Promise<WorkRecordV1[]> {
  const read = await rig.state.readRepair();
  if (!read.ok || read.value.status !== "found") {
    throw new Error("unreadable repair state");
  }
  return read.value.snapshot.work;
}

/** A self-consistent trusted statement with edited text. */
async function driftedSelfTask(body: string): Promise<ReviewTaskStatementV1> {
  return {
    issueNumber: SELF_TASK.issueNumber,
    title: SELF_TASK_TITLE,
    body,
    digest: await reviewTaskStatementDigest({
      issueNumber: SELF_TASK.issueNumber,
      title: SELF_TASK_TITLE,
      body,
    }),
  };
}

Deno.test(
  "hosted autonomy: a legacy quality-only receipt never merges or records a release",
  async () => {
    const { rig, github } = await makeRig("autonomy-legacy", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({ taskAcceptance: null }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    assert.deepEqual(rig.closed, []);
    assert.equal((await readWork(rig))[0].nextStep, "delivery");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a receipt bound to a different task digest never merges",
  async () => {
    const { rig, github } = await makeRig("autonomy-digest", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          taskAcceptance: {
            issueNumber: SELF_TASK.issueNumber,
            taskDigest: "e".repeat(64),
            verdict: "fulfilled",
            evidence: ["stale task digest"],
          },
        }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a fulfilled verdict for a different issue never merges",
  async () => {
    const { rig, github } = await makeRig("autonomy-issue", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          taskAcceptance: {
            issueNumber: SELF_TASK.issueNumber + 1,
            taskDigest: SELF_TASK.digest,
            verdict: "fulfilled",
            evidence: ["another issue"],
          },
        }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an already-satisfied base is an honest non-delivery",
  async () => {
    const { rig, github } = await makeRig("autonomy-satisfied", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          taskAcceptance: {
            issueNumber: SELF_TASK.issueNumber,
            taskDigest: SELF_TASK.digest,
            verdict: "already_satisfied_at_base",
            evidence: ["the recorded base already satisfies the issue"],
          },
        }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    assert.deepEqual(rig.closed, []);
    assert.equal((await readWork(rig))[0].nextStep, "delivery");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: issue text that drifted before the merge blocks the final action",
  async () => {
    // The first trusted read binds the reviewed text and passes; the live issue
    // moves while the remaining gates are read. The fresh read taken
    // immediately before the merge sees a different task, so the candidate
    // that already passed every other gate is still never merged.
    const drifted = await driftedSelfTask(`${SELF_TASK_BODY} (edited)`);
    let reads = 0;
    const { rig, github } = await makeRig("autonomy-merge-drift", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      afterMerge: pullFacts(),
      issueTask: () => {
        reads++;
        return Promise.resolve(reads === 1 ? SELF_TASK : drifted);
      },
    });
    const result = await run(rig, github);
    assert.ok(reads >= 2, `expected a pre-merge read, got ${reads}`);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: issue text that drifted before the closure leaves the issue open",
  async () => {
    const request = await buildHostedReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      51,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (request === null) throw new Error("fixture request invalid");
    const drifted = await driftedSelfTask(`${SELF_TASK_BODY} (edited)`);
    const { rig, github } = await makeRig("autonomy-close-drift", {
      repair: repairSnapshot(
        [deliveryRecord()],
        [authorizingReceipt()],
        [request],
      ),
      // The accepted release is produced by the REAL supervisor core over the
      // rig's own release store: the store only ever sees a legal lifecycle.
      hostedReceipt: { request, priorRevision: BASE },
      issueTask: () => Promise.resolve(drifted),
    });
    const result = await run(rig, github);
    assert.deepEqual(rig.closed, []);
    assert.equal(result.status, "skipped");
    assert.equal((await readWork(rig))[0].nextStep, "delivery");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a legacy quality-only receipt closes nothing even after an accepted release",
  async () => {
    const request = await buildHostedReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      51,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (request === null) throw new Error("fixture request invalid");
    const { rig, github } = await makeRig("autonomy-close-legacy", {
      repair: repairSnapshot(
        [deliveryRecord()],
        [authorizingReceipt({ taskAcceptance: null })],
        [request],
      ),
      // The accepted release is produced by the REAL supervisor core over the
      // rig's own release store: the store only ever sees a legal lifecycle.
      hostedReceipt: { request, priorRevision: BASE },
      issueTask: () => Promise.resolve(null),
    });
    const result = await run(rig, github);
    assert.deepEqual(rig.closed, []);
    assert.equal(result.status, "skipped");
    assert.equal((await readWork(rig))[0].nextStep, "delivery");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a self-consistent alternate reviewer identity never merges",
  async () => {
    const { rig, github } = await makeRig("autonomy-reviewer", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          expectedReviewer: "alternate-reviewer[bot]",
          observedReviewer: "alternate-reviewer[bot]",
        }),
      ]),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(result.status, "skipped");
    assert.ok(
      result.actions.includes(`delivery:${TARGET}:task_acceptance_refused`),
      JSON.stringify(result.actions),
    );
    assert.equal((await readRequests(rig)).length, 0);
    assert.deepEqual(rig.closed, []);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a later closure re-reads the issue text changed by the earlier close",
  async () => {
    const request = await buildHostedReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      51,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (request === null) throw new Error("fixture request invalid");
    const { rig, github } = await makeRig("autonomy-close-refresh", {
      repair: repairSnapshot(
        [deliveryRecord(), foreignRecord()],
        [authorizingReceipt(), foreignReceipt()],
        [request],
      ),
      // The accepted release is produced by the REAL supervisor core over the
      // rig's own release store: the store only ever sees a legal lifecycle.
      hostedReceipt: { request, priorRevision: BASE },
      pull: foreignPullFacts(),
    });
    // The server-side issue text the surfaces serve. The state layer orders
    // work records by id, so the foreign issue (120) is closed before the
    // self issue (48): the first closure mutates the LATER self issue's text,
    // which the bulk read taken for the plan still holds.
    const drifted = await driftedSelfTask(
      `${SELF_TASK_BODY} (edited by the earlier closure)`,
    );
    const states = new Map<number, ReviewTaskStatementV1 | null>([
      [SELF_TASK.issueNumber, SELF_TASK],
      [FOREIGN_TASK.issueNumber, FOREIGN_TASK],
    ]);
    const selfClosed: number[] = [];
    const foreignClosed: number[] = [];
    rig.githubFor = (repository) =>
      isSelfRepository(repository)
        ? {
          ...github,
          readIssueTask: (number: number) =>
            Promise.resolve(states.get(number) ?? null),
          closeIssue: (number: number) => {
            selfClosed.push(number);
            return Promise.resolve(true);
          },
        }
        : {
          ...github,
          readDefaultBranch: () => Promise.resolve(FOREIGN_BRANCH),
          readIssueTask: (number: number) =>
            Promise.resolve(states.get(number) ?? null),
          readPull: (number: number) =>
            Promise.resolve(number === FOREIGN_PR ? foreignPullFacts() : null),
          closeIssue: (number: number) => {
            foreignClosed.push(number);
            // Closing the first (foreign) issue changes the LATER (self)
            // issue's text: the bulk read taken for the plan is now stale for
            // that issue, whose fresh pre-closure read must therefore refuse.
            states.set(SELF_TASK.issueNumber, drifted);
            return Promise.resolve(true);
          },
        };
    const result = await run(rig);
    assert.equal(result.status, "applied", JSON.stringify(result));
    // The first (foreign) closure happened; the later self closure re-read the
    // changed text and refused, so the self issue stays open and the foreign
    // issue is legitimately done.
    assert.deepEqual(foreignClosed, [FOREIGN_TASK.issueNumber]);
    assert.deepEqual(selfClosed, []);
    assert.deepEqual(
      result.actions.filter((action) => action.startsWith("close:")),
      [
        `close:${FOREIGN_TARGET}:issue=${FOREIGN_TASK.issueNumber}`,
        `close:${TARGET}:issue=${SELF_TASK.issueNumber}:refused`,
      ],
    );
    const work = await readWork(rig);
    assert.equal(
      work.find((record) => record.id === FOREIGN_TARGET)?.nextStep,
      "done",
    );
    assert.equal(
      work.find((record) => record.id === TARGET)?.nextStep,
      "delivery",
    );
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

/** Sanitized advancing admissions, immutable native archives and actual protected maintenance. */
