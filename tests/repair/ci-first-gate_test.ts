/**
 * The CI-first review gate (owner decision 2026-10-16, "CI first, then
 * review, then merge"): a review is requested only for a head whose required
 * CI is green. Every row of the gate runs the real repair loop over real Git
 * state with fake GitHub/model ports: pending CI waits (bounded), a red head
 * routes to a CI fix (in process and, from generation 81, in hosted runs; it
 * parks precisely where no fix may run), a red base
 * backs off uncharged, and no non-green path reserves a review or moves the
 * review-round counter.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { isCiFixMarker } from "../../src/repair/ci-first-policy.ts";
import { preReviewCiParked } from "../../ops/hosted-autonomy-ci-first.ts";
import { ciGreenHeadKey } from "../../ops/hosted-autonomy-ci-retries.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy-retries.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  check,
  ciFirstRig,
  HOUR,
  modelCharges,
  reviewCharges,
  SHA4,
  taskRecord,
} from "./ci-first-rig.ts";

/** The installed runtime the launcher plans for (any runtime will do). */
const RUNTIME = "8181818181818181818181818181818181818181" as GitSha;

const RED = {
  [SHA3]: [
    check("validate", SHA3, "failure"),
    check("verify-artifact", SHA3, "skipped"),
  ],
  [SHA1]: [
    check("validate", SHA1, "success"),
    check("verify-artifact", SHA1, "success"),
  ],
};

Deno.test("CI first: a green head is reviewed exactly as before", async () => {
  const { rig, writes } = await ciFirstRig("cf-green", { checks: {} });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.nextStep, "review");
    assert.equal(work.counters.reviewRounds, 1);
    assert.equal(reviewCharges(after).length, 1);
    assert.equal(
      rig.github.calls.filter((c) => c === "requestReview").length,
      1,
    );
    assert.ok(writes.length > 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: a hosted red head is never reviewed and is marked for its CI fix (generation 81)", async () => {
  const { rig, charges } = await ciFirstRig("cf-red-hosted", {
    hosted: true,
    checks: RED,
  });
  try {
    const outcome = await rig.run();
    // The marked fix is matrix work: this hosted run defers it.
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(reviewCharges(after).length, 0, "no review admission");
    assert.deepEqual(after.reservations, charges, "nothing charged");
    assert.equal(work.counters.reviewRounds, 0, "no round counted");
    assert.equal(work.counters.retries, 0, "charged only at its admission");
    // The hosted pre-review route is open (R80, the rollback target,
    // isolates the cell): back at `work` with the CI fix marker, which the
    // matrix planner admits as a charged CI fix cell.
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.ok(isCiFixMarker(work.wait), JSON.stringify(work.wait));
    assert.equal(work.target.pr, 7, "the publication identity is kept");
    assert.equal(work.target.head, SHA3);
    assert.equal(rig.model.requests.length, 0, "a hosted fix runs as a cell");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: an in-process red head is marked for its CI fix before any review", async () => {
  const { rig, writes } = await ciFirstRig("cf-red-local", { checks: RED });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    // The first write after the CI read is the fix marker: back at `work`,
    // a zero-length backoff, nothing charged and no round counted.
    const marked = writes.map((snapshot) => taskRecord(snapshot)).find((
      work,
    ) => work.wait?.reason === "backoff");
    assert.ok(marked !== undefined, "the fix marker was written");
    assert.equal(marked.nextStep, "work");
    assert.equal(marked.wait!.since, marked.wait!.until);
    assert.equal(marked.counters.reviewRounds, 0);
    assert.equal(marked.counters.retries, 0);
    assert.equal(marked.target.head, SHA3);
    const after = await rig.snapshot();
    assert.ok(
      reviewCharges(after).every((row) => row.head !== SHA3),
      "the red head is never reviewed",
    );
    assert.equal(
      rig.github.reviewRequestIdentities.some((request) =>
        request.expectedHead === SHA3
      ),
      false,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

for (
  const [label, headChecks, expected] of [
    [
      "running",
      [check("validate", SHA3, null, "in_progress")],
      "validate(in_progress)",
    ],
    ["absent", [], "no checks reported"],
  ] as const
) {
  Deno.test(`CI first: ${label} CI waits before review, bounded to six hours`, async () => {
    const { rig, charges } = await ciFirstRig(`cf-pending-${label}`, {
      checks: { [SHA3]: [...headChecks] },
    });
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      let work = taskRecord(await rig.snapshot());
      assert.equal(work.nextStep, "work");
      assert.equal(work.wait?.reason, "ci_pending");
      const since = work.wait!.since;
      assert.equal(work.wait!.until, since + 2 * 60_000);
      assert.equal(rig.github.calls.includes("requestReview"), false);
      // A later poll keeps the original start of the wait.
      rig.clock.advance(2 * 60_000 + 1);
      await rig.run();
      work = taskRecord(await rig.snapshot());
      assert.equal(work.wait?.reason, "ci_pending");
      assert.equal(work.wait!.since, since, "since is kept across polls");
      // Past the bound the record parks with a precise blocker.
      rig.clock.advance(6 * HOUR);
      await rig.run();
      const after = await rig.snapshot();
      work = taskRecord(after);
      assert.equal(work.nextStep, "blocked");
      assert.equal(
        work.blocker?.message,
        `CI did not finish before review within 6 hours: ${expected}`,
      );
      assert.equal(work.counters.reviewRounds, 0);
      assert.equal(rig.github.calls.includes("requestReview"), false);
      assert.deepEqual(after.reservations, charges, "nothing charged");
    } finally {
      await rig.ctx.cleanup();
    }
  });
}

Deno.test("CI first: a failure whose base check still runs waits like pending CI", async () => {
  const { rig, charges } = await ciFirstRig("cf-base-pending", {
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, null, "in_progress")],
    },
  });
  try {
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.nextStep, "work");
    assert.equal(work.wait?.reason, "ci_pending");
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(rig.model.requests.length, 0);
    assert.deepEqual(after.reservations, charges);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: a red base backs off for 30 minutes with nothing charged", async () => {
  const { rig, charges } = await ciFirstRig("cf-base-red", {
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "failure")],
    },
  });
  try {
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.equal(work.wait?.reason, "backoff");
    assert.equal(work.wait!.until! - work.wait!.since, 30 * 60_000);
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(work.counters.retries, 0);
    assert.equal(work.counters.reviewRounds, 0);
    assert.deepEqual(after.reservations, charges);
  } finally {
    await rig.ctx.cleanup();
  }
});

/**
 * Live 2026-10-16: development tip b89a997835 had every check run cancelled
 * from 23:04Z until 9fc845d4 replaced it at 23:27Z, and records based on it
 * failed `validate`. A failure no base evidence attributes proves nothing
 * about the candidate, so a never-reviewed head waits for it exactly like a
 * running base check: uncharged, re-polled (a moved base refreshes the head
 * at the next poll) and bounded, never a terminal block no rule re-admits.
 */
const NO_BASE_EVIDENCE = [
  [
    "a cancelled base check",
    {
      [SHA3]: [
        check("validate", SHA3, "failure"),
        check("verify-artifact", SHA3, "skipped"),
      ],
      [SHA1]: [
        check("validate", SHA1, "cancelled"),
        check("verify-artifact", SHA1, "cancelled"),
      ],
    },
    "validate(failure)",
  ],
  [
    "a check the base never ran",
    {
      [SHA3]: [check("preview", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
    "preview(failure)",
  ],
  [
    "a head check that was cancelled",
    {
      [SHA3]: [check("validate", SHA3, "cancelled")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
    "validate(cancelled)",
  ],
] as const;

for (const [label, checks, labels] of NO_BASE_EVIDENCE) {
  Deno.test(`CI first: ${label} waits uncharged before review, bounded to six hours, and the launcher can re-admit the park`, async () => {
    const { rig, charges, setChecks } = await ciFirstRig(
      `cf-unattributed-${label.replaceAll(" ", "-")}`,
      {
        hosted: true,
        checks: Object.fromEntries(
          Object.entries(checks).map(([head, runs]) => [head, [...runs]]),
        ),
      },
    );
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      let work = taskRecord(await rig.snapshot());
      assert.equal(work.nextStep, "work");
      assert.equal(work.blocker, null);
      assert.equal(work.wait?.reason, "ci_pending");
      const since = work.wait!.since;
      assert.equal(rig.github.calls.includes("requestReview"), false);
      // Re-polled with its original start until the bound.
      rig.clock.advance(5 * 60_000 + 1);
      await rig.run();
      work = taskRecord(await rig.snapshot());
      assert.equal(work.wait?.reason, "ci_pending");
      assert.equal(work.wait!.since, since);
      rig.clock.advance(6 * HOUR);
      await rig.run();
      const after = await rig.snapshot();
      work = taskRecord(after);
      assert.equal(work.nextStep, "blocked");
      assert.equal(
        work.blocker?.message,
        `CI did not finish before review within 6 hours: ${labels} without base evidence`,
      );
      assert.equal(work.counters.reviewRounds, 0);
      assert.equal(work.counters.retries, 0);
      assert.equal(rig.github.calls.includes("requestReview"), false);
      assert.equal(rig.model.requests.length, 0);
      assert.deepEqual(after.reservations, charges, "nothing charged");
      // The park is a pre-review park: the launcher re-runs it once (L2)
      // and returns it to `work` once its head is green on the unchanged
      // tip (L3), under any runtime.
      assert.equal(preReviewCiParked(after, work), true);
      const key = ciGreenHeadKey(work.repository, SHA3);
      const plans = planHostedRetries(
        after,
        rig.clock.now(),
        RUNTIME,
        new Map([[hostedRepositoryKey(work.repository), SHA1 as string]]),
        new Set(),
        undefined,
        { ciGreenHeads: new Set([key]), ciRerunSettled: new Set([key]) },
      );
      assert.deepEqual(plans.map((plan) => [plan.id, plan.nextStep]), [[
        work.id,
        "work",
      ]]);
      // Back at `work` with the head green, the review is requested.
      setChecks(SHA3, [check("validate", SHA3, "success")]);
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      const written = await rig.store.writeRepair(
        applyHostedRetries(
          read.value.snapshot,
          read.value.head,
          plans,
          rig.clock.now(),
        ),
        read.value.head,
      );
      assert.ok(written.ok && written.value.status === "applied");
      await rig.run();
      assert.equal(
        rig.github.reviewRequestIdentities.filter((request) =>
          request.expectedHead === SHA3
        ).length,
        1,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  });
}

Deno.test("CI first: a head waiting on missing base evidence is reviewed once its own re-run passes", async () => {
  const { rig, setChecks } = await ciFirstRig("cf-unattributed-rerun", {
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "cancelled")],
    },
  });
  try {
    await rig.run();
    assert.equal(taskRecord(await rig.snapshot()).wait?.reason, "ci_pending");
    // The head's own re-run passes: the next poll requests the review.
    setChecks(SHA3, [check("validate", SHA3, "success")]);
    rig.clock.advance(5 * 60_000 + 1);
    await rig.run();
    const work = taskRecord(await rig.snapshot());
    assert.equal(work.nextStep, "review");
    assert.equal(work.counters.reviewRounds, 1);
    assert.equal(rig.model.requests.length, 0, "no fix for an unproven red");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: a head waiting on a cancelled base is refreshed uncharged once development moves past it (hosted)", async () => {
  // Live 2026-10-16: the cancelled tip b89a997835 was replaced by 9fc845d4
  // 23 minutes later. The waiting head is still at `work`, so its next poll
  // reaches the freshness gate, which refreshes it onto the new tip before
  // any CI read; nothing is charged and no review is requested.
  const { rig, charges, moveBase, refreshes, checkReads } = await ciFirstRig(
    "cf-unattributed-moved",
    {
      hosted: true,
      checks: {
        [SHA3]: [check("validate", SHA3, "failure")],
        [SHA1]: [check("validate", SHA1, "cancelled")],
      },
    },
  );
  try {
    await rig.run();
    const waiting = taskRecord(await rig.snapshot());
    assert.equal(waiting.nextStep, "work");
    assert.equal(waiting.blocker, null);
    assert.equal(waiting.wait?.reason, "ci_pending");
    assert.equal(refreshes.length, 0);
    moveBase(SHA2);
    rig.clock.advance(23 * 60_000);
    const reads = checkReads.length;
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.blocker, null, JSON.stringify(work.blocker));
    assert.ok(
      refreshes.some((request) => request.expectedHead === SHA3),
      "the waiting head is refreshed onto the moved tip",
    );
    assert.equal(
      checkReads.slice(reads).includes(SHA3),
      false,
      "no CI read of the stale head after the move",
    );
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(rig.model.requests.length, 0);
    assert.deepEqual(after.reservations, charges, "nothing charged");
  } finally {
    await rig.ctx.cleanup();
  }
});

for (const hosted of [false, true]) {
  Deno.test(`CI first: three spent CI fixes park the red head for good (${hosted ? "hosted" : "in process"})`, async () => {
    const { rig, charges } = await ciFirstRig(`cf-exhausted-${hosted}`, {
      hosted,
      retries: 3,
      attempts: 4,
      checks: RED,
    });
    try {
      await rig.run();
      const after = await rig.snapshot();
      const work = taskRecord(after);
      assert.equal(work.nextStep, "blocked");
      assert.equal(
        work.blocker?.message,
        "CI fix attempts exhausted (3 of 3): validate(failure)",
      );
      assert.equal(rig.model.requests.length, 0, "no fourth fix");
      assert.equal(rig.github.calls.includes("requestReview"), false);
      assert.deepEqual(after.reservations, charges, "nothing charged");
      assert.equal(modelCharges(after).length, 4);
    } finally {
      await rig.ctx.cleanup();
    }
  });
}

Deno.test("CI first: an expired review attempt is re-requested only through the gate", async () => {
  // The review step's own recovery (an attempt that outlived its bound) is
  // one of the gate's callers: the red head is marked for its CI fix instead
  // of a new round.
  const { rig, charges } = await ciFirstRig("cf-review-recovery", {
    hosted: true,
    reviewRounds: 1,
    nextStep: "review",
    wait: { reason: "review_pending", since: T0 - HOUR, until: T0 },
    checks: RED,
  });
  try {
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.ok(isCiFixMarker(work.wait), JSON.stringify(work.wait));
    assert.equal(work.counters.reviewRounds, 1, "no round counted");
    assert.deepEqual(
      reviewCharges(after),
      reviewCharges({
        ...after,
        reservations: charges,
      }),
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: a moved base is refreshed before any CI read of the stale head", async () => {
  const { rig, checkReads, refreshes } = await ciFirstRig("cf-moved", {
    baseTip: SHA2,
    checks: RED,
  });
  try {
    await rig.run();
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.ok(refreshes.length > 0, "the freshness gate refreshes first");
    assert.equal(
      checkReads.includes(SHA3),
      false,
      "no CI read of the old head",
    );
    assert.equal(rig.model.requests.length, 0);
    assert.equal(SHA4.length, 40);
  } finally {
    await rig.ctx.cleanup();
  }
});
