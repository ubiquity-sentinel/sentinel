/** Retired capacity limits preserve current admission and merge gates. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { createRunBounds, loadRepairContext } from "../../src/repair/loop.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import {
  reservation,
  reviewReceipt,
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
import {
  evidenceFixture,
  makeRig,
  seededSnapshot,
  SHA4,
  summaryFixture,
} from "./loop-rig.ts";
import {
  exactOpenPr,
  H1,
  positiveLifecycle,
  preservedIssueWork,
} from "./loop-candidate-fixtures.ts";
import { legacyLossIntent } from "./loop-legacy-fixtures.ts";

Deno.test(
  "uncapped migration: trusted context rearms only authentic retired cap blocks with one CAS",
  async () => {
    const clock = new FakeClock(T0 + 2000);
    const state = new MemoryState();
    const configs = repairConfigs({
      liveStartLimits: { perHour: null, perSevenDays: null },
    });
    const github = new FakeGithub();
    const model = new FakeModel();
    const deps = {
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
      incidents: new FakeIncidents({ summaries: [], evidence: null }),
      replay: new FakeReplay(),
      model,
      budget: new RollingStartBudget({ clock, state, configs }),
    };
    const capRecord = (
      id: string,
      message: string,
      overrides: Record<string, unknown> = {},
    ) =>
      workRecord(id, {
        target: {
          base: SHA1,
          branch: candidateBranch(asWorkItemId(id)),
          checkpoint: null,
          head: SHA3,
          pr: 7,
        },
        nextStep: "blocked",
        wait: null,
        intent: null,
        counters: { attempts: 4, retries: 2, reviewRounds: 3 },
        blocker: { kind: "review_quota", message, since: T0 },
        ...overrides,
      });
    const implementation = "implementation attempt budget exhausted";
    const review =
      "review rounds exhausted without an accepted verdict (review transport unavailable)";
    const work = [
      capRecord("impl-cap", implementation),
      capRecord("review-cap", review),
      capRecord("other-kind", implementation, {
        blocker: {
          kind: "missing_evidence",
          message: implementation,
          since: T0,
        },
      }),
      capRecord(
        "other-message",
        "implementation attempt budget exhausted by provider",
      ),
      capRecord("review-prefix", "review rounds exhausted"),
      capRecord("review-suffix", review.slice(0, -1)),
      capRecord("low-attempt", implementation, {
        counters: { attempts: 3, retries: 2, reviewRounds: 3 },
      }),
      capRecord("low-round", review, {
        counters: { attempts: 4, retries: 2, reviewRounds: 2 },
      }),
      capRecord("pending-intent", implementation, {
        intent: legacyLossIntent("pending-intent", 7),
      }),
      capRecord("missing-pr", review, {
        target: {
          base: SHA1,
          branch: null,
          checkpoint: null,
          head: null,
          pr: null,
        },
      }),
      capRecord(
        "empty-reason",
        "review rounds exhausted without an accepted verdict ()",
      ),
      capRecord("foreign-scope", implementation, {
        repository: {
          owner: "ubiquity",
          name: "unconfigured",
          installationId: 42,
        },
      }),
      capRecord("terminal", implementation, {
        nextStep: "done",
        blocker: null,
      }),
    ];
    const charges = [reservation("historical-cap-charge", {
      taskId: asWorkItemId("impl-cap"),
      attempt: 4,
      outcome: "submitted",
      settledAt: T0 + 500,
    })];
    const reviews = [reviewReceipt("historical-cap-review")];
    const seeded = seededSnapshot(work, { reservations: charges, reviews });
    const written = await state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const beforeWrites = state.repairWrites;
    const bounds = createRunBounds(deps, {
      deadline: clock.now() + 60 * 60_000,
    });
    const context = await loadRepairContext(deps, bounds);
    assert.ok(context !== null);
    assert.notEqual(context.head, written.value.head);
    assert.equal(
      state.repairWrites,
      beforeWrites + 1,
      "one trusted migration CAS",
    );
    for (const [index, record] of work.entries()) {
      const expected = index < 2
        ? {
          ...record,
          nextStep: index === 0 ? "work" : "review",
          blocker: null,
          updatedAt: clock.now(),
        }
        : record;
      assert.equal(
        canonicalStringify(context.snapshot.work[index]),
        canonicalStringify(expected),
        record.id,
      );
    }
    assert.deepEqual(context.snapshot.reservations, charges);
    assert.deepEqual(context.snapshot.reviews, reviews);
    assert.equal(
      model.requests.length,
      0,
      "migration is deterministic bookkeeping only",
    );
    assert.equal(
      github.calls.length,
      0,
      "migration submits no external operation",
    );
    assert.ok(await loadRepairContext(deps, bounds));
    assert.equal(
      state.repairWrites,
      beforeWrites + 1,
      "reloading is idempotent",
    );

    const conflictState = new MemoryState();
    const conflictSeed = await conflictState.writeRepair(seeded, null);
    assert.ok(conflictSeed.ok && conflictSeed.value.status === "applied");
    conflictState.conflictRepairNext = true;
    const conflicted = await loadRepairContext({
      ...deps,
      state: conflictState,
    }, bounds);
    assert.equal(
      conflicted,
      null,
      "a lost authoritative CAS cannot plan migrated work",
    );
    assert.equal(
      canonicalStringify(conflictState.repair),
      canonicalStringify(seeded),
    );
    assert.equal(model.requests.length, 0);
  },
);

Deno.test(
  "uncapped progress: fifth implementation and fifth exact-head review retain every merge gate",
  async () => {
    const heads = [
      SHA3,
      SHA4,
      "4".repeat(40),
      "5".repeat(40),
      "6".repeat(40),
    ] as GitSha[];
    const clock = new FakeClock(T0);
    const state = new MemoryState();
    const configs = repairConfigs({
      liveStartLimits: { perHour: null, perSevenDays: null },
      sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    });
    const reviewOptions = {
      baseSha: SHA1,
      candidateLifecycle: positiveLifecycle(),
      reviewRequestedAt: clock.now(),
    };
    const github = new FakeGithub(reviewOptions);
    const model = new FakeModel({ heads });
    const budget = new RollingStartBudget({ clock, state, configs });
    const githubCooldown = new DurableGitHubCooldownGate({ state, clock });
    const deps = {
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown,
      incidents: new FakeIncidents({
        summaries: [summaryFixture()],
        evidence: evidenceFixture(),
      }),
      replay: new FakeReplay(),
      model,
      budget,
    };
    const rig = {
      clock,
      github,
      model,
      entry: () => {
        reviewOptions.reviewRequestedAt = clock.now();
        return runRepairEntrypoint(deps, {
          deadline: clock.now() + 60 * 60_000,
          stepLimit: 16,
        });
      },
      snapshot: async () => {
        const read = await state.readRepair();
        assert.ok(read.ok && read.value.status === "found");
        return read.value.snapshot;
      },
    };
    {
      assert.equal((await rig.entry()).status, "idle");
      for (let index = 0; index < 4; index++) {
        rig.clock.advance(15 * 60_000 + 1);
        const message = `required correction ${index + 1}`;
        rig.github.completeReview([{
          id: `finding-uncapped-${index}`,
          severity: "P1",
          path: "src/app.ts",
          message,
          fingerprint: (index + 1).toString(16).repeat(64),
          resolved: false,
          resolutionEvidence: null,
        }], rig.clock.now());
        const outcome = await rig.entry();
        assert.equal(outcome.status, "idle", JSON.stringify(outcome));
        const state = await rig.snapshot();
        const work = state.work[0]!;
        assert.equal(work.nextStep, "review");
        assert.equal(work.wait?.reason, "review_pending");
        assert.equal(work.target.head, heads[index + 1]);
        assert.equal(work.target.pr, 7, "one durable PR across corrections");
        assert.equal(work.counters.attempts, index + 2);
        assert.equal(work.counters.reviewRounds, index + 2);
        assert.equal(rig.model.requests.length, index + 2);
        assert.equal(rig.model.requests[index + 1]!.checkoutBase, heads[index]);
        assert.ok(
          rig.model.requests[index + 1]!.reviewFindings?.some((finding) =>
            finding.message === message
          ),
        );
        const replay = state.replays.find((entry) =>
          entry.candidate.revision === heads[index + 1]
        );
        assert.equal(replay?.candidate.outcome, "passed");
        assert.equal(replay?.original.outcome, "failed");
        assert.equal(replay?.original.failure?.intended, true);
        assert.equal(
          rig.github.calls.includes("merge"),
          false,
          "unresolved P1 never merges at any round",
        );
        assert.equal(state.releaseRequests.length, 0);
      }
      const waiting = await rig.snapshot();
      assert.deepEqual(waiting.work[0]!.counters, {
        attempts: 5,
        retries: 0,
        reviewRounds: 5,
      });
      assert.deepEqual(rig.github.pushes.map((push) => push.sha), heads);
      assert.equal(rig.github.preservationRequests.length, 5);
      assert.deepEqual(
        rig.github.reviewRequestIdentities.map((request) =>
          request.expectedHead
        ),
        heads,
      );
      assert.equal(
        new Set(
          rig.github.reviewRequestIdentities.map((request) =>
            request.operationKey
          ),
        ).size,
        5,
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        1,
      );
      const submitted = waiting.reservations.filter((charge) =>
        charge.outcome === "submitted"
      );
      assert.equal(submitted.length, 10);
      assert.equal(
        submitted.filter((charge) => charge.purpose === "review_request")
          .length,
        5,
      );
      assert.equal(
        submitted.filter((charge) => charge.purpose !== "review_request")
          .length,
        5,
      );
      assert.deepEqual(
        waiting.reviews.filter((review) =>
          review.outcome === "completed" &&
          review.unresolvedSeverities.includes("P1")
        ).map((review) => review.pullRequest.head),
        heads.slice(0, 4),
      );

      // A fifth pending verdict remains unavailable merge authority; observing
      // it neither starts a sixth implementation nor charges another review.
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.reviewStatus = "pending";
      assert.equal((await rig.entry()).status, "idle");
      assert.equal(rig.github.calls.includes("merge"), false);
      assert.equal((await rig.snapshot()).reservations.length, 10);
      assert.equal(rig.model.requests.length, 5);

      rig.clock.advance(15 * 60_000 + 1);
      // Observation may be delayed beyond the poll, but the producer's actual
      // completion still occurred within the bounded fifth session.
      rig.github.completeReview(
        [],
        waiting.work[0]!.wait!.since + 19 * 60_000,
      );
      const accepted = await rig.entry();
      assert.equal(accepted.status, "idle", JSON.stringify(accepted));
      const delivered = await rig.snapshot();
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        1,
      );
      assert.equal(delivered.releaseRequests.length, 1);
      assert.equal(delivered.releaseRequests[0]!.revision, heads[4]);
      assert.ok(
        delivered.reviews.some((review) =>
          review.outcome === "completed" &&
          review.pullRequest.head === heads[4] &&
          review.unresolvedSeverities.length === 0
        ),
      );
      assert.equal(rig.model.requests.length, 5);
      assert.equal(delivered.reservations.length, 10);
    }
  },
);

Deno.test("existing-PR corrections are not blocked by the unfinished-PR cap", async () => {
  const rig = await makeRig("expricap", {
    summaries: false,
    github: {
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { "refs/heads/sentinel/repair/issue-1": SHA3 },
        pullRequests: [exactOpenPr(7, SHA3, "sentinel/repair/issue-1")],
      },
    },
  });
  try {
    const openPrRecords: WorkRecordV1[] = Array.from(
      { length: 3 },
      (_, index) =>
        workRecord(`issue-${index + 100}`, {
          source: { kind: "issue", id: `${index + 100}`, revision: SHA1 },
          related: {
            incidentId: null,
            issueNumber: index + 100,
          },
          nextStep: "review",
          wait: {
            reason: "review_pending",
            since: T0,
            until: T0 + 3600_000,
          },
          target: {
            base: SHA1,
            branch: `sentinel/repair/issue-${index + 100}`,
            checkpoint: null,
            head: SHA2,
            pr: 20 + index,
          },
        }),
    );
    const correction = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      classification: { severity: "P2", priority: 9 },
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-1",
        checkpoint: null,
        head: SHA3,
        pr: 7,
      },
      nextStep: "work",
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    });
    const seed = seededSnapshot([...openPrRecords, correction]);
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const corrected = state.work.find((record) => record.id === correction.id);
    assert.ok(corrected, "correction record exists");
    assert.equal(
      corrected?.nextStep,
      "review",
      "the correction published and requested its own review",
    );
    assert.equal(corrected?.target.head, SHA3);
    assert.equal(
      rig.github.pushes.length,
      1,
      "the corrected head was pushed to its existing branch",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "one review request for the corrected head",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      0,
      "no new PR is published",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test(
  "fresh publication: trusted retired PRs do not consume the unfinished-PR cap",
  async () => {
    const id = asWorkItemId("issue-1");
    const rig = await makeRig("retired-publish-cap", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: {},
          pullRequests: [exactOpenPr(7, SHA2, "sentinel/repair/issue-100")],
        },
      },
    });
    try {
      const retired = [61, 120].map((number) =>
        workRecord(`issue-${number}`, {
          source: { kind: "issue", id: `${number}`, revision: SHA1 },
          related: { incidentId: null, issueNumber: number },
          nextStep: "blocked",
          blocker: {
            kind: "other",
            message: "source issue is closed; the repair no longer exists",
            since: T0,
          },
          target: {
            base: SHA1,
            branch: `sentinel/repair/issue-${number}`,
            checkpoint: null,
            head: SHA2,
            pr: 500 + number,
          },
        })
      );
      const live = workRecord("issue-100", {
        source: { kind: "issue", id: "100", revision: SHA1 },
        related: { incidentId: null, issueNumber: 100 },
        nextStep: "review",
        wait: { reason: "review_pending", since: T0, until: T0 + 3600_000 },
        target: {
          base: SHA1,
          branch: "sentinel/repair/issue-100",
          checkpoint: null,
          head: SHA2,
          pr: 7,
        },
      });
      const fresh = preservedIssueWork("issue-1", H1, {
        pr: null,
        publishedHead: null,
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([...retired, live, fresh]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const published = state.work.find((record) => record.id === id);
      assert.ok(published, "the fresh record exists");
      assert.equal(
        published?.nextStep,
        "review",
        "the fresh candidate publishes past two trusted retirements",
      );
      assert.equal(published?.wait?.reason, "review_pending");
      assert.equal(
        rig.github.pushes.length,
        1,
        "exactly one fresh candidate push",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        1,
        "exactly one fresh PR",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Local activation branch: the explicit local Sentinel scope (installationId
// 0) reads only the private local receipt capability. The hosted Deno release
// path is never a fallback for local work, and the nonlocal gateway path is
// unchanged.
// ---------------------------------------------------------------------------
