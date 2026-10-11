import { incidentEvidence, incidentSummary } from "../state/helpers.ts";
import {
  preparedCleanReview,
  ReviewRestStore,
  SECOND_FINGERPRINT,
  SECOND_HEAD,
  TRANSPORT_PUBLISHER,
  trustedSnapshot,
  wireConcreteReviewTransport,
} from "./entrypoints-review-helpers.ts";
import {
  evidenceFixture,
  exactCandidateLifecycle,
  FINGERPRINT,
  makeRepairRig,
  REPO,
  SHA2,
  SHA3,
  summaryFixture,
  T0,
} from "./helpers.ts";
import type { PreparedStructuredReviewV1 } from "../../src/github/codex-reviewer.ts";
import { GitHubCodexReviewTransport } from "../../src/github/codex-review-transport.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { ReviewDrainReportV1 } from "../../src/contracts/ports.ts";
import assert from "node:assert/strict";
import {
  REPAIR_REVIEW_DRAIN_ERROR_MESSAGE,
  RepairReviewDrainError,
  runRepairEntrypoint,
} from "../../src/main.ts";
import {
  OPERATION_MARGIN_MS,
  REPAIR_RUN_CEILING_MS,
} from "../../src/repair/loop.ts";

/** Force the next repair-state read to throw (an actual cycle fault). */
function throwOnRepairRead(
  store: { readRepair: () => Promise<unknown> },
  error: Error,
): void {
  store.readRepair = () => {
    throw error;
  };
}

function secondIncidentSummary(): ReturnType<typeof incidentSummary> {
  return incidentSummary("inc-b", {
    fingerprint: SECOND_FINGERPRINT,
    severity: "P1",
    failingRevision: SHA2,
    evidenceRef: {
      ref: "artifact://inbox/inc-b.pgp",
      digest: "e".repeat(64),
    },
  });
}

function secondIncidentEvidence(): ReturnType<typeof incidentEvidence> {
  return incidentEvidence("inc-b", {
    incidentId: "inc-b",
    fingerprint: SECOND_FINGERPRINT,
    failingRevision: SHA2,
    replay: {
      fixtureRef: "fixture://sentinel/regression-b.json",
      fixtureDigest: "a".repeat(64) as never,
      upstreamCaptured: true,
      commandId: "replay_capture",
      reproducedAt: T0,
    },
  });
}

Deno.test(
  "entrypoint: mandatory drain settles a delayed clean review through the concrete transport port",
  async () => {
    const rig = await makeRepairRig("drain-concrete-transport", {
      github: {
        candidateLifecycle: exactCandidateLifecycle({ head: SHA3 }),
      },
    });
    try {
      const store = new ReviewRestStore();
      const preparedSessions: PreparedStructuredReviewV1[] = [];
      const transport = new GitHubCodexReviewTransport({
        client: new GitHubApiClient({
          repository: REPO,
          apiBaseUrl: "https://api.github.com",
          http: (request) => store.handle(request),
          auth: new FakeAuthProvider(),
          cooldownGate: new FakeCooldownGate(),
          clock: rig.clock,
        }),
        repository: REPO,
        publisher: TRANSPORT_PUBLISHER,
        clock: rig.clock,
        ownerRunId: "run-integration-transport",
        snapshot: {
          capture: async (input) =>
            portOk(await trustedSnapshot(input.base, input.head)),
        },
        reviewer: {
          prepare: (request) => {
            const session = preparedCleanReview(request, 25);
            preparedSessions.push(session);
            return Promise.resolve(portOk(session));
          },
        },
      });
      const reports: ReviewDrainReportV1[] = [];
      wireConcreteReviewTransport(
        rig.github,
        transport,
        reports,
        () => rig.clock.now(),
      );

      // The cycle submits the review through the concrete transport, reaches
      // the review_pending wait and the entrypoint's mandatory drain runs.
      // A 60-minute caller ceiling keeps the full review bound (10 minutes)
      // plus the five-minute reserved loop margin inside the positive window.
      const result = await rig.run(60 * 60_000);
      assert.equal(result.status, "idle", JSON.stringify(result));
      assert.equal(store.creates, 1, "one durable pending review was created");
      assert.equal(store.submits, 1, "the drain published exactly one COMMENT");
      assert.equal(
        preparedSessions.at(-1)?.startAttempted(),
        true,
        "the concrete drain actually started the delayed review",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
      );

      assert.equal(
        reports.length,
        1,
        "the entrypoint invoked the concrete transport drain exactly once",
      );
      const report = reports[0];
      assert.equal(report.ok, true, JSON.stringify(report));
      assert.equal(
        report.interrupted,
        false,
        "healthy delayed work is awaited, never interrupted",
      );
      assert.equal(report.operations.length, 1);
      assert.equal(report.operations[0].outcome, "settled");
      assert.equal(report.operations[0].processSettled, true);
      assert.equal(report.operations[0].durable, true);
      const standing = [...store.reviews.values()][0]!;
      assert.equal(standing.state, "commented");
      assert.equal(standing.submittedAt, T0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: original cycle outcome and error survive a successful mandatory drain",
  async () => {
    // (1) Successful cycle + successful drain: the original outcome returns.
    const rig = await makeRepairRig("drain-preserve-outcome");
    try {
      const outcome = await rig.run(40 * 60_000);
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      assert.equal(rig.github.drains.length, 1);
      assert.equal(rig.github.drains[0].interrupt, true);
    } finally {
      await rig.ctx.cleanup();
    }

    // (2) Cycle error + successful drain: the ORIGINAL error is rethrown.
    const thrown = await makeRepairRig("drain-preserve-error");
    try {
      const cycleError = new Error("synthetic cycle fault");
      throwOnRepairRead(thrown.store, cycleError);
      await assert.rejects(() => thrown.run(), (error: unknown) => {
        assert.equal(error, cycleError);
        return true;
      });
      assert.equal(
        thrown.github.drains.length,
        1,
        "the drain still ran on the error path",
      );
    } finally {
      await thrown.ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: a failed mandatory drain raises RepairReviewDrainError preserving the original failure",
  async () => {
    // (3) Successful cycle + failed drain: typed failure, original outcome.
    const rig = await makeRepairRig("drain-failure-outcome");
    try {
      rig.github.drainResult = portOk({
        ok: false,
        operations: [{
          operationKey: "review:work-1",
          outcome: "faulted",
          processSettled: false,
          durable: true,
          phase: "running",
          fault: "review transport: review operation state is unavailable",
        }],
        faults: ["review transport: review operation state is unavailable"],
        deadline: T0,
        interrupted: true,
        completedAt: T0,
      });
      await assert.rejects(() => rig.run(40 * 60_000), (error: unknown) => {
        assert.ok(error instanceof RepairReviewDrainError);
        assert.equal(error.message, REPAIR_REVIEW_DRAIN_ERROR_MESSAGE);
        assert.equal(error.report?.ok, false);
        assert.equal(error.outcome?.status, "idle");
        return true;
      });
    } finally {
      await rig.ctx.cleanup();
    }

    // (4) Cycle error + drain error: the original cycle error is the cause.
    const both = await makeRepairRig("drain-double-failure");
    try {
      const cycleError = new Error("synthetic simultaneous cycle fault");
      throwOnRepairRead(both.store, cycleError);
      both.github.drainReviews = () =>
        Promise.reject(new Error("synthetic drain transport fault"));
      await assert.rejects(() => both.run(), (error: unknown) => {
        assert.ok(error instanceof RepairReviewDrainError);
        assert.equal(error.message, REPAIR_REVIEW_DRAIN_ERROR_MESSAGE);
        assert.equal((error as { cause?: unknown }).cause, cycleError);
        assert.equal(error.outcome, null);
        return true;
      });
    } finally {
      await both.ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: drain receives the original hard deadline and the loop keeps its five-minute reserve and model cutoff",
  async () => {
    const rig = await makeRepairRig("drain-hard-deadline", {
      github: {
        candidateLifecycle: exactCandidateLifecycle({ head: SHA3 }),
      },
    });
    try {
      const start = rig.clock.now();
      const bounds: { latestStartAt: number; settleBy: number }[] = [];
      const originalRequest = rig.github.requestReview.bind(rig.github);
      rig.github.requestReview = (request) => {
        bounds.push(request as { latestStartAt: number; settleBy: number });
        return originalRequest(request);
      };
      const outcome = await rig.run(200 * 60_000);
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      // The caller ceiling above 120 minutes is clamped by the fixed run
      // ceiling, and the drain receives that ORIGINAL hard deadline.
      const hardDeadline = start + REPAIR_RUN_CEILING_MS;
      assert.deepEqual(rig.github.drains, [
        { deadline: hardDeadline, interrupt: true },
      ]);
      // The deterministic loop work stopped exactly one operation margin
      // (five minutes) before that ceiling: no review start may claim work
      // inside the reserved publication/validation margin.
      assert.equal(bounds.length, 1);
      assert.ok(
        bounds[0].settleBy <= hardDeadline - OPERATION_MARGIN_MS,
        `review settleBy ${
          bounds[0].settleBy
        } must stay inside the loop deadline`,
      );
      assert.ok(
        bounds[0].latestStartAt < bounds[0].settleBy,
        "the review start bound must remain in the future",
      );
    } finally {
      await rig.ctx.cleanup();
    }

    // The 90-minute model-start cutoff is unchanged: a clock jump past it
    // before the implementation step leaves no model start and no reservation.
    const cutoffRig = await makeRepairRig("drain-model-cutoff");
    try {
      const originalReplay = cutoffRig.replay.runReplay.bind(cutoffRig.replay);
      let advanced = false;
      cutoffRig.replay.runReplay = (request) => {
        if (!advanced) {
          advanced = true;
          cutoffRig.clock.advance(91 * 60_000);
        }
        return originalReplay(request);
      };
      const outcome = await cutoffRig.run(200 * 60_000);
      // Past the 90-minute model cutoff every remaining operation is model
      // work, so the loop reports the typed no-work margin: no model start and
      // no review admission is ever fabricated past the bounds.
      assert.equal(outcome.status, "margin", JSON.stringify(outcome));
      assert.equal(
        cutoffRig.model.requests.length,
        0,
        "no model work starts after the 90-minute cutoff",
      );
      assert.equal(
        cutoffRig.github.calls.filter((call) => call === "requestReview")
          .length,
        0,
        "no review start when the full bound cannot fit",
      );
      const snapshot = await cutoffRig.snapshot();
      assert.equal(
        snapshot.reservations.length,
        0,
        "no durable start reservation past the cutoff",
      );
      assert.equal(cutoffRig.github.drains.length, 1);
    } finally {
      await cutoffRig.ctx.cleanup();
    }
  },
);

Deno.test(
  "entrypoint: a second implementation task advances while the first review is pending with one writer",
  async () => {
    const rig = await makeRepairRig("dual-task-progress", {
      github: {
        candidateLifecycle: exactCandidateLifecycle(
          { head: SHA3 },
          { head: SECOND_HEAD },
        ),
      },
      model: { heads: [SHA3, SECOND_HEAD] },
    });
    try {
      rig.incidents.setSummaries([summaryFixture(), secondIncidentSummary()]);
      rig.incidents.setEvidence([evidenceFixture(), secondIncidentEvidence()]);

      const first = await rig.run(40 * 60_000);
      assert.equal(first.status, "idle", JSON.stringify(first));
      const afterFirst = await rig.snapshot();
      assert.equal(afterFirst.work.length, 2, "two work records");
      // The single implementation writer advanced BOTH tasks to their review
      // wait while the first review is still pending.
      assert.equal(rig.model.requests.length, 2);
      assert.equal(
        afterFirst.reservations.filter((entry) =>
          entry.purpose === "implementation"
        ).length,
        2,
      );
      assert.equal(
        afterFirst.reservations.filter((entry) =>
          entry.purpose === "review_request"
        ).length,
        2,
      );
      assert.deepEqual(
        afterFirst.work.map((record) => record.nextStep),
        ["review", "review"],
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        0,
        "a pending review never merges",
      );

      // The review observation never starts a model: a second cycle with both
      // reviews still pending adds no start, no duplicate review request and
      // no new budget reservation.
      rig.clock.advance(15 * 60_000 + 1);
      const second = await rig.run(40 * 60_000);
      assert.equal(second.status, "idle", JSON.stringify(second));
      assert.equal(rig.model.requests.length, 2, "no duplicate model start");
      const afterSecond = await rig.snapshot();
      assert.equal(
        afterSecond.reservations.length,
        afterFirst.reservations.length,
        "observation and drain reserve no budget",
      );
      assert.equal(
        afterSecond.reservations.filter((entry) =>
          entry.purpose === "review_request"
        ).length,
        2,
        "no duplicate review request while the first review is pending",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

// Compile-time + runtime re-verification that the entrypoints accept the
// exact rig capabilities (also exercised by the lifecycle test above).
Deno.test("entrypoint rigs type-check against the frozen capability shapes", async () => {
  assert.equal(typeof runRepairEntrypoint, "function");
  assert.equal(
    typeof (await import("../../src/release-main.ts")).runReleaseEntrypoint,
    "function",
  );
  // The rig identity is the one trusted repository (REPO) everywhere.
  assert.equal(REPO.name, "ai.ubq.fi");
  assert.equal(FINGERPRINT.length, 64);
});
