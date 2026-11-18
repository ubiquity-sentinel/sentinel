/**
 * Issue #189: a `checks_pending` merge refusal kept the merge intent with a
 * backoff wait, and the pre-merge CI dispatcher selects only intent-free
 * `ci_pending` records, so an ai.ubq.fi head whose CI the target never starts
 * itself never got its CI dispatched. The port returns `checks_pending` only
 * for an open, unmerged pull request, so the intent binds no write: the
 * refusal now clears it into a bounded `ci_pending` wait.
 */
import assert from "node:assert/strict";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { handleMergeOutcome } from "../../src/repair/loop-merge.ts";
import { PRE_REVIEW_CI_BOUND_MS } from "../../src/repair/ci-first-policy.ts";
import {
  CHANGE_SET_UNREADABLE_PARK,
  CHANGE_SET_WAIT_CAUSE,
} from "../../src/repair/ci-success-rule.ts";
import { pendingPremergeRecords } from "../../src/host/actions-premerge-ci.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import { FakeClock, FakeGithub, MemoryState } from "./helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";

const NOW = T0 + 600_000;
const BRANCH = "sentinel/repair/issue-ubiquity-ai.ubq.fi-1212";

function merging(extra: Record<string, unknown> = {}): WorkRecordV1 {
  return workRecord("issue-ubiquity-ai.ubq.fi-1212", {
    source: { kind: "issue", id: "1212", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1212 },
    target: {
      base: SHA1,
      branch: BRANCH,
      checkpoint: null,
      head: SHA2,
      pr: 1254,
    },
    nextStep: "delivery",
    intent: {
      kind: "merge",
      key: `merge:1254:${SHA2}`,
      startedAt: T0,
      branch: BRANCH,
      expectedHead: SHA2,
      observedBase: SHA1,
      pr: 1254,
      requestId: `review-review:1254:${SHA2}`,
      resultId: "result-1254",
    },
    ...extra,
  });
}

async function refuse(
  record: WorkRecordV1,
  reason: "checks_pending" | "conflict",
  github = new FakeGithub(),
  now = NOW,
) {
  const clock = new FakeClock(now);
  const state = new MemoryState();
  state.repair = seededSnapshot([record]);
  state.repairHead = SHA1;
  const deps = {
    clock,
    state,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
  } as unknown as RepairCycleDepsV1;
  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const context: LoopContextV1 = {
    head: read.value.head,
    snapshot: read.value.snapshot,
    bounds: { runDeadline: now + 3_600_000, modelCutoff: now + 3_600_000 },
    executionBaseline: null,
  };
  const step = await handleMergeOutcome(deps, context, record, {
    outcome: "blocked",
    reason,
    head: SHA2,
  }, null);
  assert.deepEqual(step, { kind: "progress" });
  const after = await state.readRepair();
  assert.ok(after.ok && after.value.status === "found");
  return after.value.snapshot.work[0];
}

const config = { repository: REPO } as unknown as RepositoryConfigV1;

Deno.test("merge refusal: checks_pending clears the merge intent into a ci_pending wait", async () => {
  const row = await refuse(merging(), "checks_pending");
  assert.equal(row.intent, null);
  assert.equal(row.nextStep, "delivery");
  assert.deepEqual(row.wait, {
    reason: "ci_pending",
    since: NOW,
    until: NOW + CHECK_POLL_MS,
  });
  assert.deepEqual(
    pendingPremergeRecords([row], config).map((work) => work.target.pr),
    [1254],
    "the pre-merge CI dispatcher now selects the record",
  );
});

Deno.test("merge refusal: an existing ci_pending wait keeps its original since", async () => {
  const row = await refuse(
    merging({ wait: { reason: "ci_pending", since: T0, until: T0 + 1 } }),
    "checks_pending",
  );
  assert.equal(row.wait?.since, T0);
});

Deno.test("merge refusal: a conflict refusal keeps the merge intent and backoff", async () => {
  const row = await refuse(merging(), "conflict");
  assert.equal(row.intent?.kind, "merge");
  assert.equal(row.wait?.reason, "backoff");
});

Deno.test("merge refusal (third review D3): a held head whose change set stays unreadable parks 6 hours after the FIRST unreadable observation", async () => {
  // The head already waited 7 hours for its CI (an ordinary ci_pending wait).
  const late = T0 + 7 * 60 * 60 * 1000;
  const waitedForCi = merging({
    wait: { reason: "ci_pending", since: T0, until: T0 + 1 },
  });
  const unreadable = () => new FakeGithub({ changedPaths: "unavailable" });
  const first = await refuse(waitedForCi, "checks_pending", unreadable(), late);
  assert.equal(first.nextStep, "delivery", "the first observation waits");
  assert.equal(first.wait?.since, late, "its own clock starts now");
  assert.equal(first.wait?.cause?.code, CHANGE_SET_WAIT_CAUSE.code);
  // Still unreadable within the bound: keeps its own since and waits.
  const again = await refuse(
    merging({ wait: first.wait }),
    "checks_pending",
    unreadable(),
    late + PRE_REVIEW_CI_BOUND_MS - 1,
  );
  assert.equal(again.wait?.since, late);
  assert.equal(again.blocker, null);
  // Six hours after the first unreadable observation: parks, truthfully.
  const parked = await refuse(
    merging({ wait: again.wait }),
    "checks_pending",
    unreadable(),
    late + PRE_REVIEW_CI_BOUND_MS,
  );
  assert.equal(parked.nextStep, "blocked");
  assert.equal(parked.intent, null);
  assert.equal(parked.blocker?.message, CHANGE_SET_UNREADABLE_PARK);
  // A readable change set (the hold was for something else) keeps the
  // ordinary wait and its earlier since.
  const readable = await refuse(
    waitedForCi,
    "checks_pending",
    new FakeGithub({ changedPaths: ["src/app.ts"] }),
    late,
  );
  assert.equal(readable.wait?.reason, "ci_pending");
  assert.equal(readable.wait?.since, T0);
  assert.equal(readable.blocker, null);
});
