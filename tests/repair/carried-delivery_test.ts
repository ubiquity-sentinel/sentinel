/**
 * Spent records on a moved base (owner decision 2026-10-16 (2), the
 * coordinator's option (b); generation 80 round-1 recheck P2 [0]). A record
 * whose three review rounds are spent and whose latest completed review
 * authorizes head H0 on base B0 gets ONE mechanical refresh per base tip (the
 * runtime merges the tip T into H0: no model, no charge, no review); the
 * refreshed head H1 carries H0's review only while the merge-base patch is
 * identical, and merges only once H1's own required CI is green. Anything
 * else parks with a precise blocker and spends nothing.
 *
 * Driven through the REAL repair loop (`delivery-queue-rig.ts`); every
 * snapshot written parses under the generation-79 rollback runtime.
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
import { runRepairCycle } from "../../src/repair/loop.ts";
import { CARRIED_WAIT_BOUND_MS } from "../../src/repair/loop-carried-delivery.ts";
import {
  MAX_REVIEW_ROUNDS,
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
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
import { queueRig } from "./delivery-queue-rig.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { sha } from "./review-round-cap-rig.ts";

const HOUR = 60 * 60_000;
const GEN79 = await gen79Available();

/** The first prepared refresh of the rig (`QueueGithub.prepareBaseRefresh`). */
const H1 = sha(0x5001);

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

/** `count` spent, cleanly reviewed records on SHA1 with the tip at SHA2. */
async function spentRig(count: number) {
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
    tip: SHA2,
    shape: () => spent,
    reservations: spent.flatMap(spentCharges),
    reviews,
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

Deno.test("carried delivery: spent records on a moved base merge under their carried reviews, one refresh per record and tip, nothing spent", async () => {
  const rig = await spentRig(3);
  const charges = (await rig.snapshot()).reservations.length;
  await rig.drive(30);
  const snapshot = await rig.snapshot();
  assert.deepEqual(
    [...rig.github.merged].sort(),
    rig.records.map((record) => record.target.pr).sort(),
    "every pull request merged",
  );
  await assertNothingSpent(rig, charges);
  // The line serialises the repository: each record refreshed exactly once,
  // on the tip of its turn, and merged that exact refreshed head.
  assert.equal(rig.github.refreshes, 3);
  assert.equal(new Set(rig.github.preparedKeys).size, 3);
  assert.equal(rig.github.carried.length, 3);
  for (const merge of rig.github.carried) {
    const record = rig.records.find((row) => row.target.pr === merge.pr)!;
    assert.ok(
      rig.github.preparedKeys.includes(
        `${merge.pr}:${record.target.head}:${merge.base}`,
      ),
      "merged the one refresh of the tip it merged on",
    );
    assert.match(merge.evidence, /merge-base patch sha256 reviewed a{64}/);
    assert.match(merge.evidence, /merge-base patch sha256 refreshed a{64}/);
    assert.match(
      merge.evidence,
      new RegExp(`reviewed head ${record.target.head} on base ${SHA1}`),
    );
    assert.match(
      merge.evidence,
      /required CI on [0-9a-f]{40}: validate=success@/,
    );
  }
  // Each merge is booked with a release request naming the carried receipt.
  for (const record of snapshot.work) {
    assert.equal(record.nextStep, "delivery", record.id);
    const requests = snapshot.releaseRequests.filter((request) =>
      JSON.stringify(request).includes(`review-receipt:${record.id}:latest`)
    );
    assert.equal(requests.length, 1, record.id);
  }
  await assertRollbackParses(rig);
});

Deno.test("carried delivery: a refreshed head whose patch changed parks precisely and merges nothing", async () => {
  const rig = await spentRig(1);
  const charges = (await rig.snapshot()).reservations.length;
  rig.github.changedPatch.add(H1);
  for (let run = 0; run < 4; run++) {
    await runOnce(rig);
    rig.clock.advance(5 * 60_000);
  }
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
  assert.deepEqual(rig.github.carried, []);
  await assertNothingSpent(rig, charges);
  await assertRollbackParses(rig);
});

Deno.test("carried delivery: a red refreshed head is never fixed or merged: it parks with its failed checks", async () => {
  const rig = await spentRig(1);
  const charges = (await rig.snapshot()).reservations.length;
  rig.github.checksByHead.set(H1, failing(H1));
  for (let run = 0; run < 4; run++) {
    await runOnce(rig);
    rig.clock.advance(5 * 60_000);
  }
  const [record] = (await rig.snapshot()).work;
  assert.equal(record.nextStep, "blocked");
  assert.equal(
    record.blocker!.message,
    `${REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX}validate(failure)`,
  );
  assert.deepEqual(rig.github.merged, []);
  await assertNothingSpent(rig, charges);
  await assertRollbackParses(rig);
});

Deno.test("carried delivery: a refreshed head whose CI never finishes waits bounded, then parks", async () => {
  const rig = await spentRig(1);
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
});

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
