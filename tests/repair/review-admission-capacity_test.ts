import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
/**
 * A ledger-capacity refusal is time-dependent: it must leave the review
 * record's publication binding intact so a later compaction can admit it.
 */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { requestReviewFor } from "../../src/repair/loop-review-request.ts";
import { REVIEW_POLL_MS } from "../../src/repair/loop-bounds.ts";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import {
  exactOpenPr,
  preservedIssueWork,
  PRODUCING_RESERVATION,
} from "./loop-candidate-fixtures.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { seededSnapshot } from "./loop-rig.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";

function baseRecord(): WorkRecordV1 {
  return workRecord("issue-1", {
    ...preservedIssueWork("issue-1", SHA2),
  });
}

function harness(record: WorkRecordV1) {
  const inactive = inactiveNativeQueueFixture();
  const state = new MemoryState();
  const clock = new FakeClock(T0 + 5000);
  const github = new FakeGithub({
    nativeQueue: {
      inspect: (input) => inactive.inspect(input),
      inspectEffect: (input) => inactive.inspectEffect(input),
      proveDelivery: (input) => inactive.proveDelivery(input),
    },
    baseSha: SHA3,
    branchRefSha: SHA2,
  });
  const configs = repairConfigs({
    sessionBound: {
      maxDurationMs: 240_000,
      maxOutputChars: Number.MAX_SAFE_INTEGER,
    },
  });
  state.repair = seededSnapshot([record], {
    reservations: [
      reservation(PRODUCING_RESERVATION, {
        taskId: record.id,
        outcome: "submitted",
        settledAt: T0 + 1000,
      }),
    ],
    reviews: [completedReceipt(7, SHA2, SHA1)],
  });
  state.repairHead = SHA1;
  const budget = new RollingStartBudget({ clock, state, configs });
  budget.reserveModelStart = () =>
    Promise.resolve({
      status: "rejected" as const,
      reason: "state_snapshot_refused" as const,
      detail: "reservation ledger capacity refused",
    });
  const deps: RepairCycleDepsV1 = {
    ciMinutes: INACTIVE_CI_MINUTES,
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    model: new FakeModel({ head: SHA2, changedPaths: ["src/fix.ts"] }),
    replay: new FakeReplay(),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    budget,
    incidents: new FakeIncidents({ summaries: [] }),
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
  return { deps, state, clock, github, context, record };
}

Deno.test("review admission capacity refusal waits bounded and keeps the PR binding", async () => {
  const record = baseRecord();
  const rig = harness(record);
  rig.github.prepareBaseRefresh = () => {
    throw new Error("unchanged base must not refresh");
  };
  rig.github.readPullRequest = (number) =>
    Promise.resolve(
      portOk(exactOpenPr(number, SHA2, record.target.branch!, SHA1)),
    );
  const readRef = rig.github.readRef.bind(rig.github);
  rig.github.readRef = async (ref) => {
    const read = await readRef(ref);
    return ref === "refs/heads/development" ? portOk({ ref, sha: SHA1 }) : read;
  };

  const result = await requestReviewFor(
    rig.deps,
    rig.context,
    record,
    7,
  );
  assert.equal(result.kind, "progress", JSON.stringify(result));
  const snapshot = rig.state.repair as RepairStateSnapshotV1;
  const waiting = snapshot.work.find((row) => row.id === record.id);
  assert.equal(waiting?.nextStep, "work", "never a terminal block");
  assert.equal(waiting?.blocker, null);
  assert.equal(
    waiting?.wait?.reason,
    "ledger_capacity",
    "the precise capacity reason stays visible",
  );
  assert.equal(waiting?.wait?.until, T0 + 5000 + REVIEW_POLL_MS);
  assert.equal(
    waiting?.target.pr,
    7,
    "a capacity refusal is not a dead publication identity",
  );
  assert.equal(waiting?.target.head, SHA2);
  assert.equal(rig.github.reviewRequestIdentities.length, 0);
});
