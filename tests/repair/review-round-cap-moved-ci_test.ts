/**
 * A spent record whose base moved before it merged is no longer parked: the
 * review-round ceiling is retired (owner directive 2026-10-30), so a red or
 * pending head takes the ordinary correction or bounded CI wait and a green
 * head is refreshed onto the moved base and reviewed again. Nothing here
 * writes a `review round ceiling reached:` blocker, and the counters, the
 * durable charges and the reviewed receipts are preserved.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { REVIEW_ROUND_CEILING_PREFIX } from "../../src/repair/review-round-cap.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  capRig,
  type CapRigV1,
  completedReceipt,
  MINUTE,
  PR,
  reviewCharges,
  sha,
} from "./review-round-cap-rig.ts";

const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
const ISSUE = 9649;
const ID = `issue-ubiquity-ai.ubq.fi-${ISSUE}`;

function check(
  name: string,
  head: GitSha,
  conclusion: "success" | "failure" | null,
): GitHubCheckV1 {
  return {
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    head,
    startedAt: T0 - 2 * MINUTE,
    completedAt: conclusion === null ? null : T0 - MINUTE,
  } as GitHubCheckV1;
}

/** The live 649 shape: three rounds spent, reviewed clean, in delivery. */
async function spentDelivery(intent: unknown = null): Promise<CapRigV1> {
  const rig = await capRig({
    repository: AI,
    issueNumber: ISSUE,
    id: ID,
    reviewRounds: 3,
    nextStep: "delivery",
    reservations: reviewCharges(ID, 3, { repository: AI }),
    reviews: [completedReceipt(3, SHA3, "clean", { issueNumber: ISSUE })],
    record: { intent },
  });
  rig.github.remoteBase = SHA2;
  return rig;
}

function headChecks(rig: CapRigV1, checks: Record<string, GitHubCheckV1[]>) {
  rig.github.readChecks = (head: GitSha) =>
    Promise.resolve(portOk({ head, checks: checks[head] ?? [] }));
}

function assertNotCeilingParked(work: { blocker: { message: string } | null }) {
  assert.equal(
    (work.blocker?.message ?? "").startsWith(REVIEW_ROUND_CEILING_PREFIX),
    false,
    `a spent count never parks: ${work.blocker?.message}`,
  );
}

Deno.test("round cap moved CI: a red spent head on a moved base is corrected and re-reviewed", async () => {
  const rig = await spentDelivery();
  headChecks(rig, {
    [SHA3]: [check("validate", SHA3, "failure")],
    [SHA1]: [check("validate", SHA1, "success")],
    [sha(0x1001)]: [check("validate", sha(0x1001), "success")],
  });
  await rig.run();
  const work = await rig.work();
  assertNotCeilingParked(work);
  assert.equal(work.nextStep, "review");
  assert.equal(work.blocker, null);
  assert.equal(rig.github.refreshes, 1, "the reviewed head is refreshed");
  assert.equal(rig.github.pushes.length, 1);
  assert.equal(rig.github.requests, 1, "the refreshed head is reviewed");
  assert.equal((await rig.charges()).length, 4, "one new review charge");
  assert.equal(work.target.pr, PR, "the pull request is kept");
});

Deno.test("round cap moved CI: pending CI of a spent head stays a bounded wait", async () => {
  const rig = await spentDelivery();
  let green = false;
  rig.github.readChecks = (head: GitSha) =>
    Promise.resolve(portOk({
      head,
      checks: [check("validate", head, green ? "success" : null)],
    }));
  await rig.run();
  let work = await rig.work();
  assertNotCeilingParked(work);
  assert.equal(work.nextStep, "work");
  assert.equal(work.wait?.reason, "ci_pending");
  green = true;
  for (let run = 0; run < 3; run++) {
    rig.clock.advance(40 * MINUTE);
    await rig.run();
    work = await rig.work();
    assertNotCeilingParked(work);
    assert.notEqual(work.nextStep, "blocked");
  }
});

Deno.test("round cap moved CI: a stale merge intent at a spent count is cleared and the head re-reviewed", async () => {
  const rig = await spentDelivery({
    kind: "merge",
    key: `merge:${PR}:${SHA3}`,
    startedAt: T0 - 30 * MINUTE,
    branch: `sentinel/repair/${ID}`,
    expectedHead: SHA3,
    observedBase: SHA1,
    pr: PR,
    requestId: null,
    resultId: null,
  });
  headChecks(rig, {
    [SHA3]: [check("validate", SHA3, "failure")],
    [SHA1]: [check("validate", SHA1, "success")],
    [sha(0x1001)]: [check("validate", sha(0x1001), "success")],
  });
  await rig.run();
  const work = await rig.work();
  assertNotCeilingParked(work);
  assert.equal(work.intent, null, "the stale merge intent is cleared");
  assert.equal(work.nextStep, "review");
  assert.equal(rig.github.refreshes, 1);
  assert.equal(rig.github.requests, 1);
});
