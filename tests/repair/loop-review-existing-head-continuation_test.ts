import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
/**
 * Owner throughput t10c: a green existing-published-head continuation is
 * reviewed through the normal request path under exact head custody.
 *
 * The record holds a custody_ready published PR head with no preserved
 * candidate descriptor. Its live PR head is re-proved by the review freshness
 * gate (exact open PR, branch, base and candidate ref), which is sufficient
 * custody for the durable review admission: the requested head is exactly the
 * recorded head and the request is charged as its own review operation.
 */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { ciFixMarker } from "../../src/repair/ci-first-policy.ts";
import { executeWorkStep } from "../../src/repair/loop-work.ts";
import { SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";
import { seededSnapshot } from "./loop-rig.ts";
import {
  check,
  ciFirstRig,
  modelCharges,
  reviewCharges,
  SHA4,
  taskRecord,
} from "./ci-first-rig.ts";

Deno.test(
  "review: a green existing-head continuation is requested on its exact published head",
  async () => {
    const head = SHA2;
    const id = "issue-1";
    const branch = candidateBranch(asWorkItemId(id));
    const record = workRecord(id, {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      target: {
        base: SHA1,
        branch,
        checkpoint: null,
        head,
        pr: 7,
        candidateState: { preserved: null, publishedHead: head },
      },
    });
    const github = new FakeGithub({
      baseSha: SHA1,
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { [`refs/heads/${branch}`]: head },
        pullRequests: [exactOpenPr(7, head, branch)],
      },
    });
    const state = new MemoryState();
    state.repair = seededSnapshot([record]);
    state.repairHead = SHA1;
    const clock = new FakeClock(T0);
    const configs = repairConfigs({
      sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    });
    const deps: RepairCycleDepsV1 = {
      ciMinutes: INACTIVE_CI_MINUTES,
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
      incidents: new FakeIncidents({ summaries: [] }),
      replay: new FakeReplay(),
      model: new FakeModel(),
      budget: new RollingStartBudget({ clock, state, configs }),
    };
    const context: LoopContextV1 = {
      snapshot: state.repair,
      head: SHA1,
      executionBaseline: record,
      bounds: {
        runDeadline: clock.now() + 60 * 60_000,
        modelCutoff: clock.now() + 60 * 60_000,
      },
    };

    const result = await executeWorkStep(deps, context, record);

    assert.equal(result.kind, "progress", JSON.stringify(result));
    assert.equal(
      github.reviewRequestIdentities.length,
      1,
      "the green continuation reaches the normal review request path",
    );
    assert.equal(
      github.reviewRequestIdentities[0]!.expectedHead,
      head,
      "the review is bound to the exact published PR head",
    );
    assert.equal(
      github.reviewRequestIdentities[0]!.operationKey,
      `review:7:${head}`,
    );
    const after = state.repair!;
    assert.equal(after.work[0]!.nextStep, "review");
    assert.equal(after.work[0]!.counters.reviewRounds, 1);
    const charge = after.reservations.find((row) =>
      row.purpose === "review_request"
    );
    assert.ok(charge !== undefined, "the review request is durably admitted");
    assert.equal(charge.outcome, "submitted");
    assert.equal(charge.head, head);
  },
);

Deno.test(
  "review: a continuation on a moved base defers without a base_refresh intent",
  async () => {
    const head = SHA2;
    const movedBase = SHA3;
    const id = "issue-1";
    const branch = candidateBranch(asWorkItemId(id));
    const record = workRecord(id, {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      target: {
        base: SHA1,
        branch,
        checkpoint: null,
        head,
        pr: 7,
        candidateState: { preserved: null, publishedHead: head },
      },
    });
    // The configured base has moved since custody while the published PR head
    // is unchanged. `prepareBaseRefresh` throws: the continuation shape must
    // never persist a refresh intent it cannot execute.
    const github = new FakeGithub({
      baseSha: movedBase,
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { [`refs/heads/${branch}`]: head },
        pullRequests: [exactOpenPr(7, head, branch)],
      },
    });
    const state = new MemoryState();
    state.repair = seededSnapshot([record]);
    state.repairHead = SHA1;
    const clock = new FakeClock(T0);
    const configs = repairConfigs({
      sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    });
    const deps: RepairCycleDepsV1 = {
      ciMinutes: INACTIVE_CI_MINUTES,
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
      incidents: new FakeIncidents({ summaries: [] }),
      replay: new FakeReplay(),
      model: new FakeModel(),
      budget: new RollingStartBudget({ clock, state, configs }),
    };
    const context: LoopContextV1 = {
      snapshot: state.repair,
      head: SHA1,
      executionBaseline: record,
      bounds: {
        runDeadline: clock.now() + 60 * 60_000,
        modelCutoff: clock.now() + 60 * 60_000,
      },
    };

    const first = await executeWorkStep(deps, context, record);
    assert.equal(first.kind, "deferred", JSON.stringify(first));
    assert.equal(
      first.detail,
      "existing published head cannot refresh a moved base",
    );
    const afterFirst = state.repair!;
    assert.equal(afterFirst.work[0]!.intent, null, "no intent is persisted");
    assert.equal(afterFirst.work[0]!.nextStep, "work");
    assert.equal(
      afterFirst.reservations.length,
      0,
      "the deferral reserves nothing",
    );

    // The next cycle re-verifies the same shape and defers again: no
    // base_refresh intent exists that executeBaseRefreshIntent could refuse
    // with a run-level state_error.
    const second = await executeWorkStep(deps, context, afterFirst.work[0]!);
    assert.equal(second.kind, "deferred", JSON.stringify(second));
    assert.equal(state.repair!.work[0]!.intent, null);
  },
);

async function markedContinuationRig(conclusion: "failure" | "success") {
  const scenario = await ciFirstRig("serial-continuation", {
    wait: ciFixMarker(T0),
    checks: {
      [SHA3]: [check("ci", SHA3, conclusion)],
      [SHA1]: [check("ci", SHA1, "success")],
    },
  });
  const read = await scenario.rig.store.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const snapshot = read.value.snapshot;
  taskRecord(snapshot).target.candidateState = {
    preserved: null,
    publishedHead: SHA3,
  };
  const written = await scenario.rig.store.writeRepair({
    ...snapshot,
    stateHead: read.value.head,
    sequence: snapshot.sequence + 1,
  }, read.value.head);
  assert.ok(
    written.ok && written.value.status === "applied",
    JSON.stringify(written),
  );
  return scenario;
}

Deno.test("serial: a marked existing-head continuation fixes, reviews and merges", async () => {
  const { rig, checkReads } = await markedContinuationRig("failure");
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(rig.model.requests.length, 1, "one charged CI correction");
    const request = rig.model.requests[0]!;
    assert.equal(
      request.checkoutBase,
      SHA3,
      "continue the exact published head",
    );
    assert.equal(request.base, SHA1);
    assert.match(request.reviewFindings?.[0]?.message ?? "", /ci \(failure\)/);
    assert.ok(checkReads.includes(SHA3), "the head's live CI is re-derived");
    assert.ok(
      checkReads.includes(SHA1),
      "the failure is attributed against its base",
    );
    const snapshot = await rig.snapshot();
    const work = taskRecord(snapshot);
    assert.equal(work.target.head, SHA4);
    assert.equal(work.nextStep, "review");
    assert.equal(work.wait?.reason, "review_pending");
    assert.equal(work.counters.attempts, 2);
    assert.equal(work.counters.retries, 1);
    assert.equal(work.counters.reviewRounds, 1);
    const fixes = modelCharges(snapshot).filter((row) =>
      row.purpose === "retry"
    );
    assert.equal(fixes.length, 1);
    assert.equal(fixes[0]!.outcome, "submitted");
    assert.deepEqual(
      rig.github.reviewRequestIdentities.map((row) => row.expectedHead),
      [SHA4],
      "only the corrected green head is reviewed",
    );

    rig.clock.advance(100_000_001);
    rig.github.completeReview([], rig.clock.now());
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 1);
    assert.equal(
      rig.model.requests.length,
      1,
      "the correction is not repeated",
    );
    assert.equal(taskRecord(await rig.snapshot()).nextStep, "delivery");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("serial: a marked existing-head continuation that turned green clears its marker uncharged", async () => {
  const { rig, checkReads, writes } = await markedContinuationRig("success");
  try {
    const result = await rig.run();
    assert.equal(result.status, "idle", JSON.stringify(result));
    assert.ok(checkReads.includes(SHA3), "the current head is checked again");
    assert.equal(
      rig.model.requests.length,
      0,
      "green CI never starts a correction",
    );
    assert.ok(
      writes.some((snapshot) => {
        const work = taskRecord(snapshot);
        return work.nextStep === "work" && work.wait === null &&
          work.target.head === SHA3;
      }),
      "the marker is durably cleared before the review request",
    );
    const snapshot = await rig.snapshot();
    const work = taskRecord(snapshot);
    assert.equal(work.wait?.reason, "review_pending");
    assert.equal(work.target.head, SHA3);
    assert.equal(work.nextStep, "review");
    assert.equal(work.counters.attempts, 1);
    assert.equal(work.counters.retries, 0);
    assert.equal(
      modelCharges(snapshot).length,
      1,
      "only the historical charge remains",
    );
    assert.equal(reviewCharges(snapshot).length, 1);
    assert.deepEqual(
      rig.github.reviewRequestIdentities.map((row) => row.expectedHead),
      [SHA3],
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
