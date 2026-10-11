/**
 * m04-repair acceptance: focused actual loop tests with injected ports and
 * real temporary Git state/budget. Incident -> evidence -> intended before
 * failure -> fake bounded model candidate -> after pass -> deterministic PR ->
 * pending review -> other task progress -> next poll review -> exact merge ->
 * release request -> observed acceptance -> closure, with ambiguous/crash
 * injections proving reconciliation and zero duplicate starts. No model call,
 * no network, no credentials; workloads are seconds, never real waits.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { candidateBranch, pushIntentKey } from "../../src/repair/keys.ts";
import {
  incidentEvidence,
  incidentSummary,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  evidenceFixture,
  FINGERPRINT,
  FINGERPRINT_B,
  makeRig,
  seededSnapshot,
  summaryFixture,
} from "./loop-rig.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

Deno.test(
  "acceptance: incident through exact merge, release request, acceptance and closure",
  async () => {
    const rig = await makeRig("lifecycle", {
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      // Run 1: intake -> evidence -> before fail -> model -> after pass ->
      // PR -> review request -> review_pending wait.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      assert.equal(rig.model.requests.length, 1, "exactly one model start");
      let state = await rig.snapshot();
      assert.equal(state.work.length, 1);
      const work = state.work[0];
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(work.target.pr, 7);
      assert.equal(work.target.head, SHA3);
      assert.equal(work.counters.attempts, 1);
      assert.equal(state.replays.length, 1);
      const replayResult = state.replays[0];
      assert.equal(replayResult.original.revision, SHA2);
      assert.equal(replayResult.candidate.revision, SHA3);
      assert.equal(replayResult.original.outcome, "failed");
      assert.equal(replayResult.original.failure?.intended, true);
      assert.equal(replayResult.candidate.outcome, "passed");
      assert.equal(replayResult.limitations.length, 0);
      // One durable reservation per independently admitted start: the
      // implementation and the review request each charge the shared budget.
      assert.equal(state.reservations.length, 2);
      assert.deepEqual(
        state.reservations.map((reservation) => reservation.purpose),
        ["implementation", "review_request"],
      );
      assert.ok(
        state.reservations.every((reservation) =>
          reservation.outcome === "submitted"
        ),
        "implementation and review are both confirmed submitted",
      );
      assert.deepEqual(
        state.reservations.map((reservation) => reservation.taskId),
        [work.id, work.id],
      );
      assert.equal(rig.github.pushes.length, 1);
      assert.ok(rig.github.calls.includes("createPr"));
      const published = [...rig.github.candidatePullRequests.values()];
      assert.equal(published.length, 1, "one published pull request");
      assert.equal(
        published[0].body,
        `Sentinel repair for incident ${work.source.id}`,
        "an incident task keeps a non-closing descriptive body",
      );
      assert.ok(rig.github.calls.includes("requestReview"));

      // Unchanged wait exit: no new model call, no state write.
      const sequenceBefore = await rig.sequence();
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      assert.equal(
        rig.model.requests.length,
        1,
        "observation is not an attempt",
      );
      assert.equal(
        await rig.sequence(),
        sequenceBefore,
        "unchanged wait exits without writes",
      );

      // Run 2 (after the review poll): completed review -> delivery -> merge
      // -> release request -> waiting for acceptance.
      // A durable replay result lets the task resume after retained artifact
      // expiry; the saved fixture and before-failure proof are reused.
      rig.clock.advance(100_000_000 + 1);
      rig.github.completeReview([], rig.clock.now());
      const third = await rig.run();
      assert.equal(third.status, "idle", JSON.stringify(third));
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        1,
      );
      state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      // The same run observes release state and, with no release snapshot yet,
      // waits for the release controller (exact request identity is held).
      assert.equal(state.work[0].wait?.reason, "unavailable");
      assert.equal(state.releaseRequests.length, 1);
      assert.equal(state.releaseRequests[0].revision, SHA3);
      assert.equal(state.releaseRequests[0].source.pullRequest, 7);

      // Run 3: release snapshot reports accepted completion; an incident task
      // has no issue to close, so the record becomes terminal.
      const requestId = state.releaseRequests[0].id;
      await rig.acceptRelease(requestId);
      rig.clock.advance(5 * 60_000 + 1);
      const fourth = await rig.run();
      assert.equal(fourth.status, "idle", JSON.stringify(fourth));
      state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "done");
      assert.equal(
        rig.github.calls.some((call) => call.startsWith("closeIssue:")),
        false,
        "incident tasks have no issue to close",
      );
      assert.equal(rig.model.requests.length, 1, "unchanged model starts");

      // Terminal records stay terminal with immutable identities.
      const done = state.work[0];
      const fifth = await rig.run();
      assert.equal(fifth.status, "idle", JSON.stringify(fifth));
      state = await rig.snapshot();
      assert.deepEqual(
        {
          id: done.id,
          fingerprint: done.fingerprint,
          failingRevision: done.failingRevision,
          controller: done.controller,
        },
        {
          id: state.work[0].id,
          fingerprint: state.work[0].fingerprint,
          failingRevision: state.work[0].failingRevision,
          controller: state.work[0].controller,
        },
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "delivery: a cancelled release request parks the record with its reason",
  async () => {
    const rig = await makeRig("cancelledrelease", {
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      // Run 1 -> review wait; run 2 (after the review poll) -> merge and the
      // durable release request -> delivery wait for acceptance.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      rig.clock.advance(100_000_000 + 1);
      rig.github.completeReview([], rig.clock.now());
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));

      const held = await rig.store.readRepair();
      assert.ok(held.ok && held.value.status === "found");
      if (!held.ok || held.value.status !== "found") {
        throw new Error("no repair state");
      }
      const state = held.value.snapshot;
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(state.work[0].wait?.reason, "unavailable");
      assert.equal(state.releaseRequests.length, 1);

      // The trusted maintenance pass cancels an invalid historical
      // authorization: the request carries a terminal status and reason, so no
      // release entry can ever appear for it.
      const reason =
        "historical PR110 merged against an unreviewed base; release authorization cancelled";
      const written = await rig.store.writeRepair({
        ...state,
        stateHead: held.value.head,
        sequence: state.sequence + 1,
        updatedAt: rig.clock.now(),
        releaseRequests: [{
          ...state.releaseRequests[0],
          status: "cancelled",
          failureReason: reason,
        }],
      }, held.value.head);
      assert.ok(
        written.ok && written.value.status === "applied",
        JSON.stringify(written),
      );

      rig.clock.advance(5 * 60_000 + 1);
      const third = await rig.run();
      assert.equal(third.status, "idle", JSON.stringify(third));
      const after = await rig.snapshot();
      assert.equal(after.work[0].nextStep, "blocked");
      assert.equal(after.work[0].blocker?.message, reason);
      assert.equal(after.work[0].wait, null);
      assert.equal(
        after.work[0].target.pr,
        null,
        "terminal block clears the dead publication identity",
      );
      assert.equal(
        after.releaseRequests[0].status,
        "cancelled",
        "the cancelled authorization is preserved for audit",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        1,
        "no merge is repeated for a cancelled authorization",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test("a second eligible task advances while the first review waits", async () => {
  const rig = await makeRig("secondtask", {
    github: { candidateLifecycle: positiveLifecycle() },
  });
  try {
    // Run 1: the first incident reaches the review wait with one model start.
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(rig.model.requests.length, 1);
    let state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].wait?.reason, "review_pending");
    assert.equal(state.work[0].target.head, SHA3);

    // A second incident arrives while the first review is pending: the same
    // single writer advances it through its own implementation, publication
    // and review request — never a second parallel model call.
    rig.incidents.setSummaries([
      summaryFixture(),
      incidentSummary("inc-b", {
        fingerprint: FINGERPRINT_B,
        severity: "P2",
        failingRevision: SHA2,
        evidenceRef: {
          ref: "artifact://inbox/inc-b.pgp",
          digest: "2".repeat(64),
        },
      }),
    ]);
    rig.incidents.setEvidence([
      evidenceFixture(),
      incidentEvidence("inc-b", {
        incidentId: "inc-b",
        fingerprint: FINGERPRINT_B,
        failingRevision: SHA2,
        replay: {
          fixtureRef: "fixture://sentinel/b.json",
          fixtureDigest: "3".repeat(64) as never,
          upstreamCaptured: true,
          commandId: "replay_capture",
          reproducedAt: T0,
        },
      }),
    ]);
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.model.requests.length,
      2,
      "sequential starts, never parallel",
    );
    state = await rig.snapshot();
    const secondRecord = state.work.find((record) =>
      record.fingerprint === FINGERPRINT_B
    );
    assert.ok(secondRecord, "second work record exists");
    assert.equal(secondRecord?.nextStep, "review");
    assert.equal(secondRecord?.wait?.reason, "review_pending");
    assert.equal(
      state.reservations.filter((reservation) =>
        reservation.outcome === "submitted"
      ).length,
      4,
      "implementation + review for both tasks are charged",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      2,
    );
    // The first task is untouched: exact candidate identity preserved.
    const firstRecord = state.work.find((record) =>
      record.fingerprint === FINGERPRINT
    );
    assert.equal(firstRecord?.nextStep, "review");
    assert.equal(firstRecord?.target.head, SHA3);
    assert.equal(firstRecord?.counters.reviewRounds, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("ambiguous push and review request reconcile without duplicate starts", async () => {
  const rig = await makeRig("ambiguous", {
    github: {
      pushOutcome: "ambiguous",
      reviewRequestOutcome: "ambiguous",
      candidateLifecycle: positiveLifecycle(),
    },
  });
  try {
    // The lost push response reconcile in-run: exact ref present -> branch
    // updated once -> PR published -> ambiguous review request reconciled by
    // observation, ending in the single review_pending wait.
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(rig.model.requests.length, 1, "model ran exactly once");
    let state = await rig.snapshot();
    assert.equal(state.work[0].target.pr, 7);
    assert.equal(state.work[0].target.head, SHA3);
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].wait?.reason, "review_pending");
    assert.equal(state.work[0].intent?.kind, "review_request");
    assert.ok(
      state.reservations.some((reservation) =>
        reservation.purpose === "review_request" &&
        reservation.outcome === "ambiguous"
      ),
      "ambiguous review charge is preserved",
    );

    // Next run: no re-push, no duplicate model start, no resubmission; the
    // pending review intent is observed, not re-requested.
    const pushesBefore = rig.github.pushes.length;
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(rig.github.pushes.length, pushesBefore, "no re-push");
    assert.equal(rig.model.requests.length, 1, "no duplicate model start");
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "single review request",
    );

    // Review request ambiguity already reconciled by observation (one pending
    // request per head); the review wait advances exactly once.
    rig.clock.advance(15 * 60_000 + 1);
    const third = await rig.run();
    assert.equal(third.status, "idle", JSON.stringify(third));
    state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].wait?.reason, "review_pending");
    assert.equal(rig.model.requests.length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("successful push reconciliation continues publication", async () => {
  const id = asWorkItemId("issue-1");
  const branch = candidateBranch(id);
  const rig = await makeRig("pushcontinue", {
    summaries: false,
    github: {
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { [`refs/heads/${branch}`]: SHA3 },
        pullRequests: [exactOpenPr(7, SHA3, branch)],
      },
    },
  });
  try {
    const work = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      target: { base: SHA1, branch, checkpoint: null, head: SHA3, pr: 7 },
      nextStep: "work",
      intent: {
        kind: "push",
        key: pushIntentKey(SHA3),
        startedAt: T0,
        branch,
        expectedHead: SHA3,
        observedBase: SHA1,
        pr: null,
        requestId: null,
        resultId: null,
      },
      updatedAt: T0,
    });
    const seeded = await rig.store.writeRepair(seededSnapshot([work]), null);
    assert.ok(seeded.ok && seeded.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].wait?.reason, "review_pending");
    assert.equal(state.work[0].intent, null);
    assert.equal(
      rig.github.pushes.length,
      0,
      "an already successful push is never repeated",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      0,
      "an existing PR is not published again",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "publication continues with exactly one review request",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test(
  "protected directory prefixes are normalized before candidate path checks",
  async () => {
    const rig = await makeRig("protectedprefix", {
      configOverrides: { protectedPaths: ["./src/handler/"] },
      model: { changedPaths: ["src/handler/file.ts"] },
    });
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "blocked");
      assert.equal(state.work[0].blocker?.kind, "other");
      assert.equal(rig.github.pushes.length, 0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test("review receipt preserves the actual submission timestamp", async () => {
  const submittedAt = T0 - 60_000;
  const rig = await makeRig("reviewtimestamp", {
    github: {
      reviewRequestedAt: submittedAt,
      candidateLifecycle: positiveLifecycle(),
    },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    let state = await rig.snapshot();
    assert.equal(state.work[0].wait?.since, submittedAt);

    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([], rig.clock.now());
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    state = await rig.snapshot();
    assert.equal(state.reviews.length, 1);
    assert.equal(state.reviews[0].submittedAt, submittedAt);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("closure failure retries closure only", async () => {
  // Closure applies to issue tasks; seed an issue work record (no incidents).
  const rig = await makeRig("closure", {
    summaries: false,
    github: {
      closeFailNext: true,
      candidateLifecycle: positiveLifecycle(),
      issues: [{ number: 1, title: "reproducible failure", body: "body" }],
    },
  });
  try {
    const seed: RepairStateSnapshotV1 = {
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0,
      incidents: [],
      evidence: [],
      work: [workRecord("issue-1")],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    };
    const seeded = await rig.store.writeRepair(seed, null);
    assert.ok(seeded.ok && seeded.value.status === "applied");

    await rig.run();
    const published = [...rig.github.candidatePullRequests.values()];
    assert.equal(published.length, 1, "one published pull request");
    assert.equal(
      published[0].body,
      "Resolves #1",
      "an issue task publishes exactly the GitHub closing keyword",
    );
    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([], rig.clock.now());
    await rig.run();
    const state = await rig.snapshot();
    await rig.acceptRelease(state.releaseRequests[0].id);
    rig.clock.advance(5 * 60_000 + 1);
    await rig.run();

    let current = await rig.snapshot();
    assert.equal(current.work[0].nextStep, "delivery");
    assert.equal(current.work[0].intent?.kind, "issue_closure");
    const closeCallsBefore = rig.github.calls.filter((call) =>
      call.startsWith("closeIssue:")
    ).length;
    assert.equal(closeCallsBefore, 1);

    // Retry is closure-only: no merge/release/model repeats.
    rig.clock.advance(5 * 60_000 + 1);
    const retried = await rig.run();
    assert.equal(retried.status, "idle", JSON.stringify(retried));
    current = await rig.snapshot();
    assert.equal(current.work[0].nextStep, "done");
    const closeCallsAfter = rig.github.calls.filter((call) =>
      call.startsWith("closeIssue:")
    ).length;
    assert.equal(closeCallsAfter, 2);
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 1);
    assert.equal(rig.model.requests.length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("retained expired incident evidence blocks before replay", async () => {
  const rig = await makeRig("expired-retained", { summaries: false });
  try {
    const retained = evidenceFixture();
    const expiredEvidence = {
      ...retained,
      artifacts: retained.artifacts.map((artifact) => ({
        ...artifact,
        expiresAt: T0,
      })),
    };
    const taskId = asWorkItemId("expired-retained");
    const seed = seededSnapshot([
      workRecord("expired-retained", {
        source: { kind: "incident", id: "inc-a", revision: SHA2 },
        related: { incidentId: "inc-a", issueNumber: null },
        fingerprint: FINGERPRINT,
        failingRevision: SHA2,
        target: {
          base: SHA1,
          branch: candidateBranch(taskId),
          checkpoint: null,
          head: null,
          pr: null,
        },
      }),
    ], {
      incidents: [summaryFixture()],
      evidence: [expiredEvidence],
    });
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "blocked");
    assert.equal(state.work[0].blocker?.kind, "evidence_expired");
    assert.equal(state.work[0].blocker?.message, "incident artifact expired");
    assert.equal(rig.replay.requests.length, 0);
    assert.equal(rig.model.requests.length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});
