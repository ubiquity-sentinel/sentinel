/**
 * Merge-queue Gate B: a null-until backoff is a durable hold in both R81 and
 * rollback R80. No queue implementation or new persisted shape is needed.
 */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import * as Matrix from "../../src/host/matrix-planner.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import * as Loop from "../../src/repair/loop.ts";
import * as Selection from "../../src/repair/selection.ts";
import {
  gen80Available,
  loadGen80Modules,
} from "../host/gen77-runtime-source.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { seededSnapshot } from "./loop-rig.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";

const available = await gen80Available();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HOLD_AT = T0 + 2_000;
const IMPLEMENTATION = "1".repeat(64);
const REVIEW = "2".repeat(64);
const TASK_DIGEST = "3".repeat(64);

function heldRecord(
  id: string,
  issue: number,
  extra: Record<string, unknown>,
): WorkRecordV1 {
  return workRecord(id, {
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    target: {
      base: SHA1,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: null,
      pr: null,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    wait: { reason: "backoff", since: HOLD_AT, until: null },
    updatedAt: HOLD_AT,
    ...extra,
  });
}

function queueHoldRecords(): WorkRecordV1[] {
  const ready = heldRecord("issue-300", 300, {});
  const implementing = heldRecord("issue-301", 301, {
    intent: {
      kind: "implementation",
      key: `impl:${IMPLEMENTATION}`,
      startedAt: T0,
      branch: "sentinel/repair/issue-301",
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId: IMPLEMENTATION,
      resultId: null,
    },
  });
  const delivery = heldRecord("issue-1", 1, {
    nextStep: "delivery",
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-1",
      checkpoint: null,
      head: SHA2,
      pr: 7,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    intent: {
      kind: "merge",
      key: `merge:7:${SHA2}`,
      startedAt: T0,
      branch: "sentinel/repair/issue-1",
      expectedHead: SHA2,
      observedBase: SHA1,
      pr: 7,
      requestId: "review-req-1",
      resultId: null,
    },
  });
  return [ready, implementing, delivery];
}

/** Native PR-less task review marker: only R81's dedicated phase may act. */
function baseReviewHold(): WorkRecordV1 {
  return heldRecord("issue-302", 302, {
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    intent: {
      kind: "issue_closure",
      key: `base-review:${IMPLEMENTATION}:${TASK_DIGEST}`,
      startedAt: T0,
      branch: null,
      expectedHead: SHA1,
      observedBase: SHA1,
      pr: null,
      requestId: REVIEW,
      resultId: null,
    },
  });
}

interface Runtime {
  select: typeof Selection;
  matrix: typeof Matrix;
  loop: typeof Loop;
  parse: typeof parseRepairStateSnapshotV1;
}

async function remainsHeld(runtime: Runtime, records: WorkRecordV1[]) {
  const state = new MemoryState();
  const reservations = records.map((record, index) =>
    reservation(index === 1 ? IMPLEMENTATION : String(index + 4).repeat(64), {
      taskId: record.id,
      head: SHA1,
      outcome: "ambiguous",
      settledAt: T0 + 1_000,
    })
  );
  if (records.some((record) => record.id === "issue-302")) {
    reservations.push(reservation(REVIEW, {
      taskId: "issue-302",
      purpose: "review_request",
      attempt: 2,
      head: SHA1,
    }));
  }
  const seeded = runtime.parse(seededSnapshot(records, {
    reservations,
    reviews: [completedReceipt(7, SHA2, SHA1)],
    updatedAt: HOLD_AT,
  }));
  state.repair = seeded;
  state.repairHead = SHA1;
  const before = structuredClone(seeded);
  const clock = new FakeClock(HOLD_AT);
  const configs = repairConfigs({
    adapter: { kind: "github" },
    liveStartLimits: { perHour: null, perSevenDays: null },
  });
  // The base has moved, so accidentally selecting delivery would refresh it.
  const github = new FakeGithub({ baseSha: SHA3, openIssues: [] });
  github.prepareBaseRefresh = () => {
    assert.fail("a held record must never prepare a refresh");
  };
  const model = new FakeModel();
  const deps: Loop.RepairCycleDepsV1 = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ clock, state }),
    budget: new RollingStartBudget({ clock, state, configs }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model,
    externalImplementations: true,
  };
  // Past the old 17-minute marker, longest observed pass, CI timeout, budget
  // window, and one full year. Each pass has a fresh real runtime deadline.
  for (
    const elapsed of [0, 18 * MINUTE, 67 * MINUTE, 7 * HOUR, 8 * DAY, 365 * DAY]
  ) {
    const now = HOLD_AT + elapsed;
    clock.advance(now - clock.now());
    const ranked = runtime.select.rankEligibleWork(state.repair!, configs, now);
    assert.deepEqual(ranked.ordered, []);
    for (const record of records) {
      assert.equal(ranked.skipped[record.id], "waiting");
      assert.equal(runtime.select.isWaiting(record, now), true);
      assert.equal(
        runtime.select.isEligible(record, state.repair!, now),
        false,
      );
    }
    const plan = await runtime.matrix.planMatrixWave(deps, {
      waveId: `hold-${elapsed}`,
      run: { runId: 41, runAttempt: 1, launcherSha: SHA1 },
      runtimeSha: SHA1,
      generation: 80,
      plannedAt: now,
      runStartedAt: now,
      deadline: now + HOUR,
    });
    assert.deepEqual(plan.plan.cells, []);
    assert.equal(plan.attempted, 0);
    assert.equal(plan.prepared, 0);
    const outcome = await runtime.loop.runRepairCycle(deps, {
      deadline: now + HOUR,
      runStartedAt: now,
    });
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    // Whole-record identity proves no timeout park, intent clearing, charge,
    // release/merge bookkeeping, timestamp rewrite, or reservation refund.
    assert.deepEqual(state.repair, before);
    assert.equal(state.repairHead, SHA1);
    assert.equal(state.repairWrites, 0);
    assert.deepEqual(model.requests, []);
    assert.ok(
      github.calls.every((call) => call === "listOpenIssues"),
      JSON.stringify(github.calls),
    );
  }
  // Controls are ordinary eligible work when their explicit hold is removed.
  const released = {
    ...before,
    work: before.work.map((record) => ({ ...record, wait: null })),
  };
  const ranked = runtime.select.rankEligibleWork(
    released,
    configs,
    clock.now(),
  );
  for (const record of records) assert.ok(ranked.ordered.includes(record.id));
}

Deno.test("null-until backoff: current selection, planner and repair cycle never expire work/delivery holds", async () => {
  await remainsHeld({
    select: Selection,
    matrix: Matrix,
    loop: Loop,
    parse: parseRepairStateSnapshotV1,
  }, queueHoldRecords());
});

Deno.test({
  name:
    "null-until backoff: actual R80 preserves work/delivery and PR-less issue_closure holds",
  ignore: !available,
  async fn() {
    const loaded = await loadGen80Modules([
      "src/repair/selection.ts",
      "src/host/matrix-planner.ts",
      "src/repair/loop.ts",
      "src/contracts/state-snapshots.ts",
    ]);
    try {
      const [select, matrix, loop, contracts] = loaded.modules as unknown as [
        typeof Selection,
        typeof Matrix,
        typeof Loop,
        { parseRepairStateSnapshotV1: typeof parseRepairStateSnapshotV1 },
      ];
      await remainsHeld({
        select,
        matrix,
        loop,
        parse: contracts.parseRepairStateSnapshotV1,
      }, [...queueHoldRecords(), baseReviewHold()]);
    } finally {
      await loaded.dispose();
    }
  },
});
