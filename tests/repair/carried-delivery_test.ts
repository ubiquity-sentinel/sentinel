/**
 * Spent records on a moved base (owner decision 2026-10-16 (2), the
 * coordinator's option (b); generation 80 round-1 recheck P2 [0], round-2
 * recheck P1 and P2). A record whose three review rounds are spent and whose
 * latest completed review authorizes head H0 on base B0 gets ONE mechanical
 * refresh per base tip (the runtime merges the tip T into H0: no model, no
 * charge, no review); the refreshed head H1 carries H0's review only while the
 * merge-base patch is identical, and merges only once H1's own required CI is
 * green. The runtime never merges it: its merge port refuses every merge on
 * live ai.ubq.fi, whose `development` has no branch rules (`livePolicy`);
 * the REAL launcher delivery pass merges H1 at exactly T after its own proof.
 * Anything else parks with a precise blocker and spends nothing, and every
 * wait is bounded across refreshes (`CARRIED_REFRESH_LIMIT`).
 *
 * Driven through the REAL repair loop and the REAL launcher delivery pass
 * (`delivery-queue-rig.ts`); every snapshot either writes parses under the
 * generation-79 rollback runtime.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import {
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import {
  CARRIED_AWAITING_LAUNCHER_MERGE,
  CARRIED_REFRESH_LIMIT,
  CARRIED_WAIT_BOUND_MS,
} from "../../src/repair/loop-carried-delivery.ts";
import {
  CARRIED_MERGE_MARKER_MS,
  isCarriedMergeMarker,
} from "../../src/repair/carried-review.ts";
import { treeChangesDigest } from "../../ops/hosted-autonomy-github-trees.ts";
import {
  MAX_REVIEW_ROUNDS,
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_REFRESH_LIMIT_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX,
  REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX,
} from "../../src/repair/review-round-cap.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { assertGen79Parses, gen79Available } from "../state/gen77-contracts.ts";
import {
  APP,
  historicalDeliveryScenario,
  queueRig,
} from "./delivery-queue-rig.ts";
import type { HostedPolicyGraph } from "../host/hosted-supervisor-policy-fixture.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { sha } from "./review-round-cap-rig.ts";

const HOUR = 60 * 60_000;
const GEN79 = await gen79Available();

/** The first prepared refresh of the rig (`QueueGithub.prepareBaseRefresh`). */
const H1 = sha(0x5001);

/** The digest of the rig's one-path change set (`launcherSurface`). */
const CHANGES = await treeChangesDigest([{
  path: "src/app.ts",
  oldMode: "100644",
  oldSha: "1".repeat(40),
  newMode: "100644",
  newSha: "2".repeat(40),
}]);

/** Three submitted review charges of one task on its reviewed head. */
function spentCharges(record: WorkRecordV1): BudgetReservationV1[] {
  return Array.from(
    { length: MAX_REVIEW_ROUNDS },
    (_, index) =>
      reservation(`${record.id}-review-${index + 1}`, {
        repository: REPO,
        taskId: record.id,
        attempt: index + 1,
        head: record.target.head,
        purpose: "review_request",
        outcome: "submitted",
        createdAt: T0 - 30 * 60_000 + index,
        settledAt: T0 - 30 * 60_000 + index + 1,
      }),
  );
}

/** The clean, task-accepted latest review of H0 on B0 (SHA1). */
async function cleanReview(record: WorkRecordV1): Promise<ReviewReceiptV1> {
  const issueNumber = record.related.issueNumber!;
  return completedReceipt(record.target.pr!, record.target.head!, SHA1, {
    id: `review-receipt:${record.id}:latest`,
    repository: REPO,
    resultId: `result-${record.id}`,
    // The fixed sentinel App reviewer, the only one the launcher trusts.
    expectedReviewer: APP,
    observedReviewer: APP,
    taskAcceptance: {
      issueNumber,
      taskDigest: await reviewTaskStatementDigest({
        issueNumber,
        title: `issue ${issueNumber}`,
        body: "",
      }),
      verdict: "fulfilled",
      evidence: ["the exact reviewed change implements the source issue"],
    },
  });
}

/**
 * `count` spent, cleanly reviewed records on SHA1 with the tip at SHA2, under
 * the live ai.ubq.fi policy (the runtime's merge port refuses every merge).
 */
async function spentRig(count: number, historicalLauncher?: HostedPolicyGraph) {
  const base = await queueRig(count);
  const spent = base.records.map((record) =>
    workRecord(record.id, {
      ...record,
      nextStep: "delivery",
      counters: { attempts: 1, retries: 0, reviewRounds: MAX_REVIEW_ROUNDS },
    })
  );
  const reviews = await Promise.all(spent.map(cleanReview));
  return queueRig(count, {
    historicalLauncher,
    tip: SHA2,
    shape: () => spent,
    reservations: spent.flatMap(spentCharges),
    reviews,
    reviewer: APP,
    livePolicy: true,
  });
}

function failing(head: GitSha): GitHubCheckV1[] {
  return [{
    name: "validate",
    status: "completed",
    conclusion: "failure",
    head,
    startedAt: T0,
    completedAt: T0 + 1000,
  }];
}

function pending(head: GitSha): GitHubCheckV1[] {
  return [{
    name: "validate",
    status: "in_progress",
    conclusion: null,
    head,
    startedAt: T0,
    completedAt: null,
  }];
}

type Rig = Awaited<ReturnType<typeof queueRig>>;

async function runOnce(rig: Rig) {
  await runRepairCycle(rig.deps, {
    deadline: rig.clock.now() + 60 * 60_000,
    stepLimit: 16,
  });
}

async function assertNothingSpent(rig: Rig, before: number) {
  const snapshot = await rig.snapshot();
  assert.equal(snapshot.reservations.length, before, "nothing charged");
  for (const record of snapshot.work) {
    assert.equal(record.counters.reviewRounds, MAX_REVIEW_ROUNDS);
    assert.equal(record.counters.retries, 0);
  }
  assert.deepEqual(rig.github.reviewed, [], "no review requested");
  assert.equal(
    (rig.deps.model as unknown as { requests: unknown[] }).requests.length,
    0,
    "no model run",
  );
}

async function assertRollbackParses(rig: Rig) {
  if (!GEN79) return;
  assert.ok(rig.writes.length > 0);
  for (const written of rig.writes) await assertGen79Parses(written);
}

async function runLauncherThenRuntime(rig: Rig, runs: number) {
  for (let run = 0; run < runs; run++) {
    await rig.launcher();
    await runOnce(rig);
    rig.clock.advance(5 * 60_000);
  }
}

Deno.test(
  "carried delivery: under the live unprotected policy the launcher merges every spent record's refreshed head at its exact tip, one refresh per record and tip, nothing spent",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(3, graph);
    const charges = (await rig.snapshot()).reservations.length;
    await rig.drive(30, { launcher: true });
    const snapshot = await rig.snapshot();
    assert.deepEqual(
      [...rig.github.merged].sort(),
      rig.records.map((record) => record.target.pr).sort(),
      "every pull request merged",
    );
    // Only the launcher merged; the runtime never asked its port for a merge
    // it would refuse (protection_required on a branch with no rules).
    assert.equal(rig.github.launcherMerges.length, 3);
    assert.deepEqual(rig.github.refusedMerges, []);
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 0);
    await assertNothingSpent(rig, charges);
    // The line serialises the repository: each record refreshed exactly once,
    // on the tip of its turn, and the launcher merged that exact refreshed head
    // at exactly that tip.
    assert.equal(rig.github.refreshes, 3);
    assert.equal(new Set(rig.github.preparedKeys).size, 3);
    for (const merge of rig.github.launcherMerges) {
      const record = rig.records.find((row) => row.target.pr === merge.pr)!;
      assert.deepEqual(rig.github.refreshedFrom.get(merge.head), {
        from: record.target.head,
        onto: merge.onto,
      }, "merged the one refresh of the tip it merged on");
      const message = merge.message ?? "";
      assert.match(
        message,
        new RegExp(
          `reviewed head ${record.target.head} on base ${SHA1}, review receipt review-receipt:${record.id}:latest`,
        ),
      );
      assert.match(
        message,
        new RegExp(`refreshed head ${merge.head} on base ${merge.onto}`),
      );
      assert.match(
        message,
        new RegExp(
          `exact change set sha256 ${CHANGES} \\(1 paths by path, mode and full blob id\\): ${SHA1}\\.\\.${record.target.head} equals ${merge.onto}\\.\\.${merge.head}`,
        ),
      );
      assert.match(
        message,
        new RegExp(
          `merge-base diff sha256 ${SHA1}...${record.target.head} a{64} \\(evidence only\\)`,
        ),
      );
      assert.match(
        message,
        new RegExp(
          `merge-base diff sha256 ${merge.onto}...${merge.head} a{64} \\(evidence only\\)`,
        ),
      );
      assert.match(message, /workflow runs 7001/);
      assert.ok(
        rig.launcherActions.includes(
          `delivery:${record.id}:carried_merge:pr=${merge.pr}:reviewed=${record.target.head}@${SHA1}:receipt=review-receipt:${record.id}:latest:refreshed=${merge.head}@${merge.onto}:changes=${CHANGES}/1:patch=${
            "a".repeat(64)
          }/${"a".repeat(64)}:ci=7001`,
        ),
        JSON.stringify(rig.launcherActions),
      );
    }
    // Each merge is booked with a release request naming the carried receipt,
    // the refreshed head and tip as its source, and the record in `delivery`.
    for (const record of snapshot.work) {
      assert.equal(record.nextStep, "delivery", record.id);
      const requests = snapshot.releaseRequests.filter((request) =>
        request.source.reviewReceiptId === `review-receipt:${record.id}:latest`
      );
      assert.equal(requests.length, 1, record.id);
      assert.equal(requests[0].source.head, record.target.head);
      assert.equal(requests[0].source.base, record.target.base);
    }
    await assertRollbackParses(rig);
  }),
);

Deno.test(
  "carried delivery: the runtime proves and waits; the launcher merges only once the runtime's wait names its merge",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(1, graph);
    // Runtime first: it refreshes, reads H1's green CI and holds the exact
    // carried-merge marker (round-2 recheck P3: no other backoff is the
    // runtime's proof).
    await runOnce(rig);
    await runOnce(rig);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "work");
    assert.equal(record.target.head, H1);
    assert.equal(record.target.base, SHA2);
    assert.deepEqual(record.wait, {
      reason: "backoff",
      since: rig.clock.now(),
      until: rig.clock.now() + CARRIED_MERGE_MARKER_MS,
    });
    assert.ok(isCarriedMergeMarker(record.wait));
    assert.deepEqual(rig.github.calls.filter((call) => call === "merge"), []);
    // The launcher merges H1 at exactly SHA2 and books it.
    const actions = await rig.launcher();
    assert.equal(rig.github.launcherMerges.length, 1, JSON.stringify(actions));
    assert.equal(rig.github.launcherMerges[0].head, H1);
    assert.equal(rig.github.launcherMerges[0].onto, SHA2);
    [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "delivery");
    // The runtime then sees its release request like any delivered record.
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "delivery");
    assert.equal(rig.github.refreshes, 1);
    await assertRollbackParses(rig);
  }),
);

Deno.test(
  "carried delivery: a launcher merge whose state write was lost is adopted by the next launcher pass",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(1, graph);
    await runOnce(rig);
    await runOnce(rig);
    // The launcher merges, but its one state write conflicts.
    rig.state.conflictRepairNext = true;
    await rig.launcher();
    assert.equal(rig.github.launcherMerges.length, 1);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "work");
    // The runtime waits for the launcher's bookkeeping; it books nothing.
    rig.clock.advance(5 * 60_000);
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "work");
    assert.equal(record.wait?.reason, "unavailable");
    assert.equal((await rig.snapshot()).releaseRequests.length, 0);
    // The next launcher pass adopts its own merge from the same gates.
    rig.clock.advance(5 * 60_000);
    await rig.launcher();
    [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "delivery");
    assert.equal(rig.github.launcherMerges.length, 1, "merged once");
    assert.equal((await rig.snapshot()).releaseRequests.length, 1);
    await assertRollbackParses(rig);
  }),
);

Deno.test(
  "carried delivery: a refreshed head whose patch changed parks precisely and merges nothing",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(1, graph);
    const charges = (await rig.snapshot()).reservations.length;
    rig.github.changedPatch.add(H1);
    await runLauncherThenRuntime(rig, 4);
    const [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "blocked");
    assert.ok(
      record.blocker!.message.startsWith(
        REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
      ),
      record.blocker!.message,
    );
    assert.match(record.blocker!.message, /sha256:a{64}/);
    assert.match(record.blocker!.message, /sha256:b{64}/);
    assert.equal(rig.github.refreshes, 1);
    assert.deepEqual(rig.github.merged, []);
    assert.deepEqual(rig.github.launcherMerges, []);
    await assertNothingSpent(rig, charges);
    await assertRollbackParses(rig);
  }),
);

Deno.test(
  "carried delivery: a red refreshed head is never fixed or merged: it parks with its failed checks",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(1, graph);
    const charges = (await rig.snapshot()).reservations.length;
    rig.github.checksByHead.set(H1, failing(H1));
    await runLauncherThenRuntime(rig, 4);
    const [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "blocked");
    assert.equal(
      record.blocker!.message,
      `${REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX}validate(failure)`,
    );
    assert.deepEqual(rig.github.merged, []);
    await assertNothingSpent(rig, charges);
    await assertRollbackParses(rig);
  }),
);

Deno.test(
  "carried delivery: a refreshed head whose CI never finishes waits bounded, then parks",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(1, graph);
    const charges = (await rig.snapshot()).reservations.length;
    rig.github.checksByHead.set(H1, pending(H1));
    await runOnce(rig);
    await runOnce(rig);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.target.head, H1, "refreshed once");
    assert.equal(record.wait?.reason, "ci_pending");
    const since = record.wait!.since;
    for (let elapsed = 0; elapsed <= CARRIED_WAIT_BOUND_MS; elapsed += HOUR) {
      rig.clock.advance(HOUR);
      await rig.launcher();
      await runOnce(rig);
      [record] = (await rig.snapshot()).work;
      if (record.nextStep === "blocked") break;
      assert.equal(record.wait?.since, since, "the wait keeps its start");
    }
    assert.equal(record.nextStep, "blocked");
    assert.equal(
      record.blocker!.message,
      `${REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX}validate(in_progress)`,
    );
    assert.equal(rig.github.refreshes, 1);
    assert.deepEqual(rig.github.merged, []);
    await assertNothingSpent(rig, charges);
    await assertRollbackParses(rig);
  }),
);

Deno.test("carried delivery: a red reviewed head on a moved base keeps the merge gate's blocker and is never refreshed", async () => {
  const rig = await spentRig(1);
  const charges = (await rig.snapshot()).reservations.length;
  const h0 = rig.records[0].target.head!;
  rig.github.checksByHead.set(h0, failing(h0));
  await runOnce(rig);
  const [record] = (await rig.snapshot()).work;
  assert.equal(record.nextStep, "blocked");
  assert.equal(record.blocker!.message, "CI checks failed: validate(failure)");
  assert.equal(rig.github.refreshes, 0);
  assert.deepEqual(rig.github.merged, []);
  await assertNothingSpent(rig, charges);
  await assertRollbackParses(rig);
});

Deno.test("carried delivery: a reviewed head with no CI at the ceiling waits bounded, then parks (no unbounded ci_pending)", async () => {
  const rig = await spentRig(1);
  const charges = (await rig.snapshot()).reservations.length;
  const h0 = rig.records[0].target.head!;
  rig.github.checksByHead.set(h0, []);
  await runOnce(rig);
  let [record] = (await rig.snapshot()).work;
  assert.equal(record.nextStep, "delivery");
  assert.equal(record.wait?.reason, "ci_pending");
  for (let hour = 0; hour <= 7 && record.nextStep !== "blocked"; hour++) {
    rig.clock.advance(HOUR);
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
  }
  assert.equal(record.nextStep, "blocked");
  assert.equal(
    record.blocker!.message,
    `${REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX}no check runs`,
  );
  assert.equal(rig.github.refreshes, 0);
  await assertNothingSpent(rig, charges);
  await assertRollbackParses(rig);
});

Deno.test("carried delivery: a spent record whose latest review does not authorize its head still parks BASE_MOVED", async () => {
  const base = await queueRig(1);
  const [seed] = base.records;
  const spent = workRecord(seed.id, {
    ...seed,
    nextStep: "delivery",
    counters: { attempts: 1, retries: 0, reviewRounds: MAX_REVIEW_ROUNDS },
  });
  const review = await cleanReview(spent);
  const rig = await queueRig(1, {
    tip: SHA2,
    shape: () => [spent],
    reservations: spentCharges(spent),
    // The task acceptance binds another statement: not this live task.
    reviews: [{
      ...review,
      taskAcceptance: { ...review.taskAcceptance!, taskDigest: "d".repeat(64) },
    }],
  });
  await runOnce(rig);
  const [record] = (await rig.snapshot()).work;
  assert.equal(record.nextStep, "blocked");
  assert.equal(record.blocker!.message, REVIEW_ROUND_CEILING_BASE_MOVED);
  assert.equal(rig.github.refreshes, 0);
  assert.deepEqual(rig.github.merged, []);
  await assertRollbackParses(rig);
});

Deno.test("carried delivery: with no launcher merge the runtime waits for it bounded, then parks precisely; it never calls its own merge port", async () => {
  // Live ai.ubq.fi: the runtime port refuses every merge, and here no
  // launcher pass runs at all (or every one refuses), with the base fixed.
  const rig = await spentRig(1);
  const charges = (await rig.snapshot()).reservations.length;
  await runOnce(rig);
  await runOnce(rig);
  let [record] = (await rig.snapshot()).work;
  assert.equal(record.target.head, H1);
  assert.ok(isCarriedMergeMarker(record.wait));
  // The marker restarts on every poll (its shape is exact), so the bound
  // counts from H1's own CI completion: 1 s after the refresh in this rig.
  const green = rig.github.refreshedAt.get(H1)! + 1000;
  for (let polls = 0; polls < 200 && record.nextStep !== "blocked"; polls++) {
    rig.clock.advance(5 * 60_000);
    await runOnce(rig);
    [record] = (await rig.snapshot()).work;
    if (record.nextStep !== "blocked") {
      assert.ok(isCarriedMergeMarker(record.wait), JSON.stringify(record.wait));
      assert.equal(record.wait!.since, rig.clock.now());
      assert.ok(rig.clock.now() - green < CARRIED_WAIT_BOUND_MS);
    }
  }
  assert.ok(rig.clock.now() - green >= CARRIED_WAIT_BOUND_MS);
  assert.ok(rig.clock.now() - green < CARRIED_WAIT_BOUND_MS + 5 * 60_000);
  assert.equal(record.nextStep, "blocked");
  assert.equal(
    record.blocker!.message,
    `${REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX}${CARRIED_AWAITING_LAUNCHER_MERGE}`,
  );
  assert.equal(rig.github.calls.filter((call) => call === "merge").length, 0);
  assert.deepEqual(rig.github.refusedMerges, []);
  assert.equal(rig.github.refreshes, 1);
  await assertNothingSpent(rig, charges);
  await assertRollbackParses(rig);
});

Deno.test("carried delivery: with the base moving hourly and no merge, the refreshes are bounded across refreshes and the record parks", async () => {
  // Round-2 recheck P1 scenario: 16 hours, development moving every hour,
  // nothing merging. Each refresh clears the wait (and the line's stall
  // count), so only the git-derived refresh count bounds the record.
  const rig = await spentRig(1);
  const charges = (await rig.snapshot()).reservations.length;
  let tips = 0;
  for (let run = 0; run < 60; run++) {
    await runOnce(rig);
    rig.clock.advance(16 * 60_000);
    if (run % 4 === 3) rig.github.remoteBase = sha(0x7000 + ++tips);
  }
  const [record] = (await rig.snapshot()).work;
  assert.equal(record.nextStep, "blocked");
  assert.ok(
    record.blocker!.message.startsWith(
      `${REVIEW_ROUND_CEILING_CARRIED_REFRESH_LIMIT_PREFIX}${CARRIED_REFRESH_LIMIT} refreshes; reviewed ${
        rig.records[0].target.head
      } on ${SHA1}`,
    ),
    record.blocker!.message,
  );
  assert.equal(rig.github.refreshes, CARRIED_REFRESH_LIMIT);
  assert.ok(tips > CARRIED_REFRESH_LIMIT);
  assert.equal(rig.github.calls.filter((call) => call === "merge").length, 0);
  await assertNothingSpent(rig, charges);
  await assertRollbackParses(rig);
});

Deno.test(
  "carried delivery: a pull request still reporting the refreshed-from head after the push waits, then merges (no permanent park)",
  historicalDeliveryScenario(async (graph) => {
    const rig = await spentRig(1, graph);
    const github = rig.github;
    const h0 = rig.records[0].target.head!;
    // GitHub reports a pull request's new head asynchronously after a push:
    // the first two reads after each push still name the old head.
    let lagging = 0;
    const push = github.pushHead.bind(github);
    github.pushHead = async (ref, next, expected) => {
      const result = await push(ref, next, expected);
      lagging = 2;
      return result;
    };
    const read = github.readPullRequest.bind(github);
    github.readPullRequest = async (number) => {
      const result = await read(number);
      if (lagging > 0 && result.ok && result.value !== null) {
        lagging--;
        return portOk({ ...result.value, head: h0 });
      }
      return result;
    };
    await runOnce(rig);
    await runOnce(rig);
    let [record] = (await rig.snapshot()).work;
    assert.equal(record.nextStep, "work", "not parked");
    assert.equal(record.target.head, H1);
    assert.equal(record.wait?.reason, "unavailable");
    await rig.drive(10, { launcher: true });
    [record] = (await rig.snapshot()).work;
    assert.deepEqual(github.merged, [rig.records[0].target.pr]);
    assert.equal(record.nextStep, "delivery");
    assert.equal(github.refreshes, 1);
    await assertRollbackParses(rig);
  }),
);

Deno.test("carried delivery: a foreign head on the pull request still parks", async () => {
  const rig = await spentRig(1);
  const github = rig.github;
  const read = github.readPullRequest.bind(github);
  let pushed = false;
  const push = github.pushHead.bind(github);
  github.pushHead = async (ref, next, expected) => {
    pushed = true;
    return await push(ref, next, expected);
  };
  github.readPullRequest = async (number) => {
    const result = await read(number);
    if (!pushed || !result.ok || result.value === null) return result;
    return portOk({ ...result.value, head: sha(0x6666) });
  };
  await runOnce(rig);
  await runOnce(rig);
  const [record] = (await rig.snapshot()).work;
  assert.equal(record.nextStep, "blocked");
  assert.deepEqual(github.merged, []);
});

Deno.test(
  "carried delivery: a record behind a carried record the launcher cannot merge is held only boundedly, then reviewed and merged",
  historicalDeliveryScenario(async (graph) => {
    // issue-1 (PR 101): spent, carried, but the launcher cannot prove its
    // patch (no compare reads); issue-2 (PR 102): one round left, same base.
    const base = await queueRig(2);
    const shaped = base.records.map((record, index) =>
      workRecord(record.id, {
        ...record,
        nextStep: "delivery",
        counters: {
          attempts: 1,
          retries: 0,
          reviewRounds: index === 0 ? MAX_REVIEW_ROUNDS : 2,
        },
      })
    );
    const reviews = await Promise.all(shaped.map(cleanReview));
    const rig = await queueRig(2, {
      historicalLauncher: graph,
      tip: SHA2,
      shape: () => shaped,
      reservations: [
        ...spentCharges(shaped[0]),
        ...spentCharges(shaped[1]).slice(0, 2),
      ],
      reviews,
      reviewer: APP,
      livePolicy: true,
    });
    const surface = rig.github.launcherSurface.bind(rig.github);
    rig.github.launcherSurface = () => ({
      ...surface(),
      mergeBaseTreeChanges: () => Promise.resolve(null),
    });
    let runs = 0;
    while (runs < 40 && !rig.github.merged.includes(102)) {
      await rig.launcher();
      await runOnce(rig);
      rig.clock.advance(16 * 60_000);
      runs++;
    }
    assert.ok(rig.github.merged.includes(102), `merged in ${runs} runs`);
    assert.ok(runs < 40);
    assert.ok(
      rig.launcherActions.includes(
        "delivery:issue-1:carried_proof_unavailable",
      ),
      JSON.stringify(rig.launcherActions.slice(0, 20)),
    );
    // The carried record never merged and parks after its bound.
    assert.equal(rig.github.merged.includes(101), false);
    for (let hour = 0; hour < 8; hour++) {
      rig.clock.advance(HOUR);
      await runOnce(rig);
    }
    const carried = (await rig.snapshot()).work.find((row) =>
      row.id === "issue-1"
    )!;
    assert.equal(carried.nextStep, "blocked");
    assert.ok(
      carried.blocker!.message.startsWith(
        REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX,
      ),
      carried.blocker!.message,
    );
    await assertRollbackParses(rig);
  }),
);
