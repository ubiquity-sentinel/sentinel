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
