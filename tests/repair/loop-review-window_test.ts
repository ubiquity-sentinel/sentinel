/**
 * Review start window: a review round is started only when the remaining run
 * window holds the reviewer's own whole bound (start through owned close) plus
 * the loop's finalization margin. A start that cannot fit is deferred BEFORE
 * any reservation, intent or round, so it writes nothing and the next run
 * performs it.
 */
import assert from "node:assert/strict";
import { MAX_REVIEW_TOTAL_MS } from "../../src/github/reviewer-policy.ts";
import { REVIEW_SESSION_DEADLINE_MS } from "../../src/host/local-policy.ts";
import {
  OPERATION_MARGIN_MS,
  REVIEW_BOUND_MS,
} from "../../src/repair/loop-bounds.ts";
import type { RigV1 } from "./loop-rig.ts";
import {
  noVerdictObservation,
  rigAtReviewWait,
} from "./loop-review-fixtures.ts";

/**
 * The smallest loop window that still admits no review start: the latest
 * admissible start is `runDeadline - OPERATION_MARGIN_MS - REVIEW_BOUND_MS`,
 * and a start AT that instant is refused.
 */
const UNFIT_LOOP_WINDOW_MS = OPERATION_MARGIN_MS + REVIEW_BOUND_MS;

const NO_VERDICT =
  "structured review unavailable: the runtime terminal was not completed";

/** One task whose first round concluded without a verdict, due for round 2. */
async function rigDueForRetry(prefix: string) {
  const { rig, work } = await rigAtReviewWait(prefix);
  rig.clock.advance(15 * 60_000 + 1);
  rig.github.reviewStatus = "unavailable";
  rig.github.reviewObservations = noVerdictObservation(
    work.target.head!,
    NO_VERDICT,
    rig.clock.now() - 1000,
  );
  return { rig, work };
}

/** Capture the absolute bounds every review submission carries. */
function captureReviewBounds(
  rig: RigV1,
): { latestStartAt: number; settleBy: number }[] {
  const bounds: { latestStartAt: number; settleBy: number }[] = [];
  const original = rig.github.requestReview.bind(rig.github);
  rig.github.requestReview = (request) => {
    const { latestStartAt, settleBy } = request as {
      latestStartAt: number;
      settleBy: number;
    };
    bounds.push({ latestStartAt, settleBy });
    return original(request);
  };
  return bounds;
}

/** A refused start leaves the durable state byte-for-byte where it was. */
async function assertDeferredWithoutWrite(
  rig: RigV1,
  loopWindowMs: number,
): Promise<void> {
  const before = await rig.snapshot();
  const requests = rig.github.reviewRequestIdentities.length;
  const outcome = await rig.run(loopWindowMs);
  assert.equal(outcome.status, "margin", JSON.stringify(outcome));
  assert.equal(
    rig.github.reviewRequestIdentities.length,
    requests,
    "no review is started when its bound cannot fit the remaining window",
  );
  const after = await rig.snapshot();
  assert.equal(after.sequence, before.sequence, "the deferral writes nothing");
  assert.deepEqual(after, before);
  const record = after.work[0]!;
  assert.equal(record.counters.reviewRounds, 1, "no round is consumed");
  assert.equal(record.intent, null, "no review intent is persisted");
  assert.equal(
    after.reservations.filter((r) => r.purpose === "review_request").length,
    1,
    "no review charge is reserved",
  );
}

Deno.test(
  "review window: the admission bound is the reviewer's own whole bound, which also covers the launcher-held session",
  () => {
    assert.equal(REVIEW_BOUND_MS, MAX_REVIEW_TOTAL_MS);
    // Equal both ways: a shorter launcher session would cut a fitted review
    // short, and a longer one would outlive the admission bound.
    assert.equal(
      REVIEW_SESSION_DEADLINE_MS,
      REVIEW_BOUND_MS,
      "the launcher's review session matches the admission bound",
    );
  },
);

Deno.test(
  "review window: a round is not started when the window cannot hold the reviewer bound plus margin, and nothing is written",
  async () => {
    const { rig } = await rigDueForRetry("review-window-short");
    try {
      await assertDeferredWithoutWrite(rig, UNFIT_LOOP_WINDOW_MS - 60_000);
      // The deferred round is performed by the next run whose window fits,
      // under the round identity the refused start never consumed.
      const resumed = await rig.run();
      assert.equal(resumed.status, "idle", JSON.stringify(resumed));
      const record = (await rig.snapshot()).work[0]!;
      assert.equal(record.counters.reviewRounds, 2);
      assert.equal(
        rig.github.reviewRequestIdentities.at(-1)!.operationKey,
        `review:7:${record.target.head}:attempt-2`,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "review window: a start exactly at the latest admissible instant is refused without a write",
  async () => {
    const { rig } = await rigDueForRetry("review-window-boundary");
    try {
      await assertDeferredWithoutWrite(rig, UNFIT_LOOP_WINDOW_MS);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "review window: the entrypoint's child window also reserves its own finalization margin before the review bound",
  async () => {
    const { rig, work } = await rigDueForRetry("review-window-entry");
    try {
      // The entrypoint hands the loop `hardDeadline - OPERATION_MARGIN_MS`,
      // so the child window must hold both margins plus the reviewer bound.
      const unfitChildWindow = OPERATION_MARGIN_MS + UNFIT_LOOP_WINDOW_MS;
      const before = await rig.snapshot();
      const refused = await rig.entry(unfitChildWindow);
      assert.equal(refused.status, "margin", JSON.stringify(refused));
      assert.equal(rig.github.reviewRequestIdentities.length, 1);
      assert.deepEqual(await rig.snapshot(), before);
      assert.deepEqual(rig.github.drains.at(-1), {
        deadline: rig.clock.now() + unfitChildWindow,
        interrupt: true,
      });

      const started = await rig.entry(unfitChildWindow + 1);
      assert.notEqual(started.status, "state_error", JSON.stringify(started));
      assert.equal(rig.github.reviewRequestIdentities.length, 2);
      assert.equal(
        rig.github.reviewRequestIdentities[1]!.operationKey,
        `review:7:${work.target.head}:attempt-2`,
      );
      assert.equal((await rig.snapshot()).work[0]!.counters.reviewRounds, 2);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "review window: a round is started when the window holds the reviewer bound plus margin",
  async () => {
    const { rig, work } = await rigDueForRetry("review-window-fits");
    try {
      const bounds = captureReviewBounds(rig);
      const startedAt = rig.clock.now();
      const loopDeadline = startedAt + UNFIT_LOOP_WINDOW_MS + 1;
      const outcome = await rig.run(UNFIT_LOOP_WINDOW_MS + 1);
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      assert.equal(rig.github.reviewRequestIdentities.length, 2);
      assert.equal(
        rig.github.reviewRequestIdentities[1]!.operationKey,
        `review:7:${work.target.head}:attempt-2`,
      );
      const state = await rig.snapshot();
      const record = state.work[0]!;
      assert.equal(record.counters.reviewRounds, 2);
      assert.equal(record.wait?.reason, "review_pending");
      assert.equal(
        state.reservations.filter((r) => r.purpose === "review_request")
          .length,
        2,
      );
      // The submitted bounds give the reviewer its whole bound, settled
      // before the loop's finalization margin.
      assert.equal(bounds.length, 1);
      assert.equal(bounds[0]!.latestStartAt, startedAt + 1);
      assert.equal(
        bounds[0]!.settleBy - bounds[0]!.latestStartAt,
        MAX_REVIEW_TOTAL_MS,
      );
      assert.equal(bounds[0]!.settleBy, loopDeadline - OPERATION_MARGIN_MS);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
