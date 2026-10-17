/**
 * A spent record whose base moved before it merged (the hard ceiling leaves
 * no round for a refreshed head) reads its own head's required CI before it
 * parks: a red head keeps the merge gate's precise `CI checks failed: ...`
 * blocker (never BASE_MOVED, which no CI rule matches and which would take a
 * red head out of the owner's legacy class for good, live 649 and 1128),
 * pending CI waits at `delivery`, and only a green head parks BASE_MOVED for
 * the owner-gated moved-base merge. Nothing is refreshed, pushed, requested
 * or charged on any of these paths.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { legacyReviewRoundClassPin } from "../../src/repair/review-round-cap.ts";
import { assertGen79Parses, gen79Available } from "../state/gen77-contracts.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  assertParked,
  CAP_BASE_MOVED,
  capRig,
  type CapRigV1,
  completedReceipt,
  MINUTE,
  PR,
  reviewCharges,
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

const GEN79 = await gen79Available();

/** Every shape written here is one R79 (the rollback target) parses. */
async function assertR79Parses(rig: CapRigV1) {
  if (GEN79) await assertGen79Parses(await rig.snapshot());
}

function assertNothingSpent(rig: CapRigV1) {
  assert.equal(rig.github.refreshes, 0, "nothing refreshed");
  assert.equal(rig.github.pushes.length, 0, "nothing pushed");
  assert.equal(rig.github.requests, 0, "no review requested");
  assert.equal(rig.github.merges, 0, "nothing merged");
  assert.equal(rig.model.requests.length, 0, "no model work");
}

Deno.test("round cap moved CI: a red spent head on a moved base keeps the merge gate's CI blocker", async () => {
  const rig = await spentDelivery();
  headChecks(rig, {
    [SHA3]: [check("validate", SHA3, "failure")],
    [SHA1]: [check("validate", SHA1, "success")],
  });
  await rig.run();
  await assertR79Parses(rig);
  const work = await rig.work();
  assert.equal(work.nextStep, "blocked", JSON.stringify(work));
  assert.equal(work.blocker?.kind, "other");
  assert.equal(work.blocker?.message, "CI checks failed: validate(failure)");
  assert.equal(work.target.head, SHA3, "the reviewed head is kept");
  assert.equal(work.target.pr, PR);
  assert.equal(work.intent, null);
  // The owner's one-time legacy class sees it (the predicate the table is
  // regenerated with), which a BASE_MOVED park never was.
  assert.equal(legacyReviewRoundClassPin(await rig.snapshot(), work), 3);
  assert.equal((await rig.charges()).length, 3, "no charge added");
  assertNothingSpent(rig);
});

Deno.test("round cap moved CI: pending CI waits in delivery, then green parks BASE_MOVED", async () => {
  const rig = await spentDelivery();
  headChecks(rig, { [SHA3]: [check("validate", SHA3, null)] });
  await rig.run();
  await assertR79Parses(rig);
  let work = await rig.work();
  assert.equal(work.nextStep, "delivery");
  assert.equal(work.wait?.reason, "ci_pending");
  assert.equal(work.intent, null);
  headChecks(rig, { [SHA3]: [check("validate", SHA3, "success")] });
  rig.clock.advance(6 * MINUTE);
  await rig.run();
  await assertR79Parses(rig);
  work = await assertParked(rig, CAP_BASE_MOVED);
  assert.equal(work.target.base, SHA1, "the reviewed base is kept");
  assertNothingSpent(rig);
});

Deno.test("round cap moved CI: a stale merge intent at the ceiling with a red head is cleared onto the CI blocker", async () => {
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
  });
  await rig.run();
  await assertR79Parses(rig);
  const work = await rig.work();
  assert.equal(work.nextStep, "blocked");
  assert.equal(work.blocker?.message, "CI checks failed: validate(failure)");
  assert.equal(work.intent, null, "the stale merge intent is cleared");
  assertNothingSpent(rig);
});
