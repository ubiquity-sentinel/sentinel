// A record retired because its source issue closed stays hot (or returns hot)
// while its own pull request is unsettled, so the hosted maintenance pass,
// which reads hot records only, can close Sentinel's own open pull request.
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  retiredPullClosurePending,
  SOURCE_ISSUE_CLOSED_RETIREMENT,
} from "../../src/contracts/work-record-retired-pull.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { RETIRED_TARGET_MESSAGE } from "../../src/repair/selection.ts";
import { HOSTED_AUTONOMY_RETIRED } from "../../ops/hosted-autonomy-policy.ts";
import {
  planRepairDemotions,
  planRepairPromotions,
} from "../../src/state/state-repair-tier-plan.ts";
import { REPO, workRecord } from "./helpers.ts";
import { NOW } from "./repair-tier-fixtures.ts";

const retired = (id: string, overrides: Record<string, unknown> = {}) =>
  workRecord(id, {
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: SOURCE_ISSUE_CLOSED_RETIREMENT,
      since: NOW - 1,
    },
    target: {
      base: "aafb7ee0598699bb7fb8a72ea133693ed64462da",
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: "6dc35d06e757107b91eb58232bd15e5f671d79b4",
      pr: 9,
    },
    ...overrides,
  });

function snapshot(work: RepairStateSnapshotV1["work"]): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: NOW,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
}

const settledClosure = { pr: 9, outcome: "closed", at: NOW - 1 };

Deno.test("retired pull: the shared blocker text matches both retirement writers", () => {
  assert.equal(SOURCE_ISSUE_CLOSED_RETIREMENT, HOSTED_AUTONOMY_RETIRED);
  assert.equal(SOURCE_ISSUE_CLOSED_RETIREMENT, RETIRED_TARGET_MESSAGE);
});

Deno.test("retired pull: the settlement field round-trips and is absent by default", () => {
  const pending = retired("w-pending");
  assert.equal("retiredPullClosure" in pending, false);
  assert.equal(retiredPullClosurePending(pending), true);
  const settled = parseWorkRecordV1({
    ...pending,
    retiredPullClosure: settledClosure,
  });
  assert.deepEqual(settled.retiredPullClosure, settledClosure);
  assert.equal(retiredPullClosurePending(settled), false);
  assert.throws(() =>
    parseWorkRecordV1({
      ...pending,
      retiredPullClosure: { ...settledClosure, outcome: "deleted" },
    })
  );
  // Another blocker, no pull request or a non-repair branch is never pending.
  assert.equal(
    retiredPullClosurePending(
      retired("w-other", {
        blocker: { kind: "other", message: "other", since: NOW },
      }),
    ),
    false,
  );
  assert.equal(
    retiredPullClosurePending(
      retired("w-nopr", {
        target: { ...pending.target, pr: null },
      }),
    ),
    false,
  );
  assert.equal(
    retiredPullClosurePending(
      retired("w-branch", {
        target: { ...pending.target, branch: "feature/x" },
      }),
    ),
    false,
  );
});

Deno.test("retired pull: an unsettled retired record is never demoted; a settled one is", () => {
  const hot = snapshot([
    retired("w-pending"),
    parseWorkRecordV1({
      ...retired("w-settled"),
      retiredPullClosure: settledClosure,
    }),
  ]);
  const families = planRepairDemotions(hot, {
    now: NOW,
    listedRepositories: [REPO],
    openIssueWorkIds: new Set(),
    demotionBudget: 100,
  });
  assert.deepEqual(families, [[
    { id: "w-settled", from: "work", to: "work" },
  ]]);
});

Deno.test("retired pull: an unsettled retired record already cold is promoted", () => {
  const moves = planRepairPromotions(snapshot([]), {
    work: [
      retired("w-pending"),
      parseWorkRecordV1({
        ...retired("w-settled"),
        retiredPullClosure: settledClosure,
      }),
    ],
    reservations: [],
    reservationArchive: [],
    reviews: [],
    releaseRequests: [],
  }, { openIssueWorkIds: new Set() });
  assert.deepEqual(moves, [{ id: "w-pending", from: "work", to: "work" }]);
});
