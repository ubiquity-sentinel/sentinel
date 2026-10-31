/**
 * The maintenance pass reports `retried` only for a retry WRITE (a grant, a
 * re-admission or a repeat-failure park). Live passes on 2026-10-24 reported
 * `skipped`/`retried` with no write because a parked record's read-only
 * denial (`retry:<id>:denied:repeat_failure_parked:...`) is repeated on every
 * pass; such a pass now reports its own class.
 */
import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import { buildHostedReleaseRequest } from "../../ops/hosted-autonomy.ts";
import {
  isWrittenRetryAction,
  retryGrantAction,
  retryParkAction,
  retryReadmitAction,
  retryWritten,
} from "../../ops/hosted-autonomy-retry-actions.ts";
import {
  REPEAT_FAILURE_DEFAULT_ROUTE,
  repeatFailureParkMessage,
} from "../../ops/hosted-autonomy-repeat-failure.ts";
import { SHA1, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  deliveryRecord,
  HEAD,
  MERGE,
  pullFacts,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  readRequests,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

const PARKED = "issue-ubiquity-sentinel-90" as WorkItemId;
const LABEL = "other|ba872ff9154d4db3:x3";

/** A record the repeat-failure bound parked: every pass only names it. */
function parkedRecord() {
  return blockedRecord({
    id: PARKED,
    source: { kind: "issue", id: "90", revision: SHA1 },
    related: { incidentId: null, issueNumber: 90 },
    blocker: {
      kind: "other",
      message: repeatFailureParkMessage(
        {
          count: 3,
          signature: "other|ba872ff9154d4db3",
          issue: "none",
          route: REPEAT_FAILURE_DEFAULT_ROUTE,
        },
        "model run failed (unavailable)",
      ),
      since: T0 + 3000,
    },
    target: {
      base: BASE,
      branch: `sentinel/repair/${PARKED}`,
      checkpoint: null,
      head: null,
      pr: null,
    },
  });
}

const DENIAL = `retry:${PARKED}:denied:repeat_failure_parked:${LABEL}`;

Deno.test("retried reason: only the three written retry lines count", () => {
  // Work item ids may hold `.`, `:` and `-`.
  for (const id of [PARKED, "issue-ubiquity-ai.ubq.fi-1213", "a:b.c-d"]) {
    assert.ok(isWrittenRetryAction(retryGrantAction(id, 0, "other:x:")), id);
    assert.ok(isWrittenRetryAction(retryGrantAction(id, 12, "y")), id);
    assert.ok(
      isWrittenRetryAction(retryReadmitAction(id, "base_refresh_conflict")),
      id,
    );
    assert.ok(isWrittenRetryAction(retryParkAction(id, LABEL)), id);
    for (
      const readOnly of [
        `retry:${id}:denied:repeat_failure_parked:${LABEL}`,
        `retry:${id}:denied:repeat_failure_unverified_issue`,
        `retry:${id}:denied:legacy_class_spent:pin=none:spent=3`,
        `retry:${id}:denied:legacy_base_red`,
        `retry:${id}:denied:green_spent_left_to_delivery`,
        `retry:${id}:skipped:pr_not_open`,
        `retry:${id}:skipped:ci_correction_cap`,
        `retry:${id}:skipped:conflict_resolution_cap`,
      ]
    ) assert.equal(isWrittenRetryAction(readOnly), false, readOnly);
  }
  assert.equal(retryWritten(["retry:legacy_class:denied:drift_more=4"]), false);
  assert.equal(retryWritten(["retry:legacy_held:denied:held_more=2"]), false);
  assert.equal(retryWritten([`delivery:${PARKED}:grant=0:x`]), false);
  assert.equal(retryWritten([DENIAL, retryGrantAction(PARKED, 0, "x")]), true);
});

Deno.test("retried reason: a no-write pass with only a repeated denial reports its own class", async () => {
  // The live shape: an already recorded delivery waiting for its release,
  // beside a repeat-failure park that is named on every pass.
  const existing = await buildHostedReleaseRequest(
    deliveryRecord().repository,
    MERGE,
    HEAD,
    BASE,
    51,
    authorizingReceipt(),
    T0 + 2000,
  );
  if (existing === null) throw new Error("fixture request invalid");
  const { rig, github } = await makeRig("retried-reason-denial", {
    repair: repairSnapshot(
      [deliveryRecord(), parkedRecord()],
      [authorizingReceipt()],
      [existing],
    ),
  });
  try {
    const result = await run(rig, github);
    assert.ok(result.actions.includes(DENIAL), JSON.stringify(result.actions));
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.equal(result.reason, "already_recorded");
    assert.equal(rig.writes, 0);
    assert.equal(rig.merges, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("retried reason: a delivery write after a repeated denial is applied, not retried", async () => {
  const { rig, github } = await makeRig("retried-reason-delivery", {
    repair: repairSnapshot([deliveryRecord(), parkedRecord()]),
    pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    afterMerge: pullFacts(),
  });
  try {
    const result = await run(rig, github);
    assert.ok(result.actions.includes(DENIAL), JSON.stringify(result.actions));
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.equal(result.reason, "applied");
    assert.equal(rig.merges, 1);
    assert.equal(rig.writes, 1);
    assert.equal((await readRequests(rig)).length, 1);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("retried reason: an unreadable self tip after a repeated denial is base_moved", async () => {
  const { rig, github } = await makeRig("retried-reason-tip", {
    repair: repairSnapshot([deliveryRecord(), parkedRecord()]),
    pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    baseTip: null,
  });
  try {
    const result = await run(rig, github);
    assert.ok(result.actions.includes(DENIAL), JSON.stringify(result.actions));
    assert.equal(result.status, "skipped", JSON.stringify(result));
    assert.equal(result.reason, "base_moved");
    assert.equal(rig.writes, 0);
    assert.equal(rig.merges, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
