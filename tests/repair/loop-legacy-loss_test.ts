/** Proof-bound legacy lost-candidate restoration and refusal controls. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { GitHubPort } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { gitRun, sha256Hex, T0, workRecord } from "../state/helpers.ts";
import {
  issueRecord,
  LOCAL_SENTINEL_REPO,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import { candidateStateFor } from "./loop-candidate-fixtures.ts";
import {
  LEGACY_B0,
  LEGACY_B1,
  LEGACY_BRANCH,
  LEGACY_DETAIL,
  LEGACY_H0,
  LEGACY_H1,
  LEGACY_INTENT_KEY,
  LEGACY_ISSUE,
  LEGACY_PR,
  LEGACY_REVIEW_ID,
  legacyLossBlockedExtras,
  legacyLossCharge,
  legacyLossCycles,
  legacyLossIntent,
  legacyLossMemory,
  legacyLossOverrides,
  legacyLossProof,
  legacyLossReview,
  legacyLossWork,
  repairStateHead,
} from "./loop-legacy-fixtures.ts";

/**
 * The authentic completed H0/B0 correction review the lost retry followed.
 * Owner directive 2026-10-24 ("the only internal policy is resolve all P0"):
 * only an unresolved P0 rejects a head, so the historical rejection the bridge
 * requires carries a P0 finding (the fixture default); a P1-only review is a
 * clean review under that rule (see the control below).
 */
function legacyRejection(
  id: string = LEGACY_REVIEW_ID,
  overrides: Record<string, unknown> = {},
) {
  return legacyLossReview(id, LEGACY_H0, LEGACY_B0, {
    findings: [{
      id: "finding-h0",
      severity: "P0",
      path: "src/app.ts",
      message: "legacy correction finding",
      fingerprint: "a".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }],
    unresolvedSeverities: ["P0"],
    ...overrides,
  });
}

Deno.test(
  "legacy loss bridge: two guarded CAS commits recover a lost legacy candidate into one charged retry",
  async () => {
    const port = new RelationsFakeGithub({ baseSha: LEGACY_B0 });
    const rig = await makeRig("legacy-loss", {
      summaries: false,
      localScope: true,
      githubPort: port,
    });
    try {
      const github: GitHubPort = port;
      let proofCalls = 0;
      github.proveLegacyBaseRefreshLoss = async (taskId) => {
        proofCalls++;
        return portOk(
          legacyLossProof(taskId, await repairStateHead(rig.store)),
        );
      };
      const charge = legacyLossCharge();
      const review = legacyRejection();
      const seeded = seededSnapshot(
        [legacyLossWork("issue-48", LEGACY_ISSUE)],
        { reservations: [charge], reviews: [review] },
      );
      const written = await rig.store.writeRepair(seeded, null);
      assert.ok(written.ok && written.value.status === "applied");
      const seedHead = written.value.head;
      const { run } = legacyLossCycles({
        clock: rig.clock,
        state: rig.store,
        github,
        incidents: rig.incidents,
        replay: rig.replay,
        model: rig.model,
      });

      // Cycle 1: ONLY the truthful loss discovery is committed. The blocked
      // state head D retains the original H1/B0 tuple and every historical
      // record; no model start and no reservation are created.
      const first = await run(1);
      assert.equal(first.status, "step_limit", JSON.stringify(first));
      const afterFirst = await rig.snapshot();
      const blocked = afterFirst.work[0]!;
      assert.equal(blocked.nextStep, "blocked");
      assert.equal(blocked.blocker?.kind, "missing_evidence");
      assert.equal(blocked.blocker?.message, LEGACY_DETAIL);
      assert.equal(blocked.target.head, LEGACY_H1);
      assert.equal(blocked.target.base, LEGACY_B0);
      assert.equal(blocked.target.branch, LEGACY_BRANCH);
      assert.equal(blocked.target.pr, LEGACY_PR);
      assert.deepEqual(blocked.target.checkpoint, {
        branch: LEGACY_BRANCH,
        sha: LEGACY_H1,
      });
      assert.equal(blocked.intent?.key, LEGACY_INTENT_KEY);
      assert.deepEqual(blocked.counters, {
        attempts: 3,
        retries: 0,
        reviewRounds: 1,
      });
      assert.equal(proofCalls, 1);
      assert.equal(rig.model.requests.length, 0, "no model start in discovery");
      assert.equal(afterFirst.reservations.length, 1);
      assert.equal(afterFirst.reservations[0]!.outcome, "submitted");
      assert.deepEqual(afterFirst.reviews.map((entry) => entry.id), [
        LEGACY_REVIEW_ID,
      ]);
      assert.equal(afterFirst.stateHead, seedHead);
      const D = await repairStateHead(rig.store);
      assert.notEqual(D, seedHead);

      // Cycle 2: the blocked tuple is independently proved at the NEW
      // authoritative head and restored to the ordinary work tuple at H0/B0.
      const second = await run(1);
      assert.equal(second.status, "step_limit", JSON.stringify(second));
      const afterSecond = await rig.snapshot();
      const restored = afterSecond.work[0]!;
      assert.equal(restored.nextStep, "work");
      assert.equal(restored.target.head, LEGACY_H0);
      assert.equal(restored.target.base, LEGACY_B0);
      assert.equal(restored.target.branch, LEGACY_BRANCH);
      assert.equal(restored.target.pr, LEGACY_PR);
      assert.equal(restored.target.checkpoint, null);
      assert.equal(restored.target.candidateState, undefined);
      assert.equal(restored.intent, null);
      assert.equal(restored.wait, null);
      assert.equal(restored.blocker, null);
      assert.deepEqual(restored.counters, {
        attempts: 3,
        retries: 0,
        reviewRounds: 1,
      });
      assert.deepEqual(restored.evidence, blocked.evidence);
      assert.equal(proofCalls, 2);
      assert.equal(
        rig.model.requests.length,
        0,
        "no model start in restoration",
      );
      const R = await repairStateHead(rig.store);
      assert.notEqual(R, D);

      // Both committed snapshots live in the ACTUAL state Git history: D is an
      // ancestor of R, and D still carries the original intent/H1 record.
      const ancestor = await gitRun(
        rig.ctx.bare,
        ["merge-base", "--is-ancestor", D, R],
        rig.ctx.env,
      );
      assert.ok(ancestor.ok, `D must be an ancestor of R: ${ancestor.stderr}`);
      const digest = await sha256Hex("issue-48");
      const atDRaw = await gitRun(
        rig.ctx.bare,
        ["show", `${D}:work/${digest}.json`],
        rig.ctx.env,
      );
      assert.ok(atDRaw.ok, atDRaw.stderr);
      const atD = JSON.parse(atDRaw.stdout);
      assert.equal(atD.nextStep, "blocked");
      assert.equal(atD.target.head, LEGACY_H1);
      assert.equal(atD.intent.key, LEGACY_INTENT_KEY);
      assert.deepEqual(atD.counters, {
        attempts: 3,
        retries: 0,
        reviewRounds: 1,
      });
      assert.equal(atD.evidence.length, 1);
      const atRRaw = await gitRun(
        rig.ctx.bare,
        ["show", `${R}:work/${digest}.json`],
        rig.ctx.env,
      );
      assert.ok(atRRaw.ok, atRRaw.stderr);
      const atR = JSON.parse(atRRaw.stdout);
      assert.equal(atR.target.head, LEGACY_H0);
      assert.equal(atR.intent, null);
      assert.equal(atR.blocker, null);
      assert.deepEqual(afterSecond.reservations.map((entry) => entry.id), [
        charge.id,
      ]);
      assert.deepEqual(afterSecond.reviews.map((entry) => entry.id), [
        LEGACY_REVIEW_ID,
      ]);

      // Cycle 3: ordinary admission alone starts exactly one attempt-4 retry
      // at head B0 with the H0 correction checkout; the run stops at the next
      // bounded checkpoint and needs no publication/review infrastructure.
      port.latest.set(
        LEGACY_ISSUE,
        issueRecord(LEGACY_ISSUE, {
          relations: { subIssueCount: 0, openBlockers: [] },
        }),
      );
      // The seeded original charge settled at T0+500; the retry cycle runs in
      // real post-settlement time so admission is not clock-regression deferred.
      rig.clock.advance(2000);
      const third = await run(1);
      assert.equal(third.status, "step_limit", JSON.stringify(third));
      assert.equal(rig.model.requests.length, 1, "exactly one attempt-4 start");
      const request = rig.model.requests[0]!;
      assert.equal(request.taskId, "issue-48");
      assert.equal(request.base, LEGACY_B0);
      assert.equal(request.checkoutBase, LEGACY_H0);
      const afterThird = await rig.snapshot();
      const attempt4 = afterThird.reservations.find((entry) =>
        entry.attempt === 4
      );
      assert.ok(attempt4, "attempt-4 reservation exists");
      assert.equal(attempt4.purpose, "retry");
      assert.equal(attempt4.head, LEGACY_B0);
      assert.equal(attempt4.repository.installationId, 0);
      assert.equal(afterThird.reservations.length, 2);
      const original = afterThird.reservations.find((entry) =>
        entry.id === charge.id
      );
      assert.ok(original, "the original submitted charge is preserved");
      assert.equal(original.outcome, "submitted");
      assert.equal(original.head, LEGACY_B0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss bridge: a remotely present parked candidate reaches base refresh",
  async () => {
    const rig = legacyLossMemory();
    let proofCalls = 0;
    let prepareCalls = 0;
    rig.github.proveLegacyBaseRefreshLoss = () => {
      proofCalls++;
      return Promise.resolve(portOk(null));
    };
    rig.github.prepareBaseRefresh = () => {
      prepareCalls++;
      return Promise.resolve(
        portError("unavailable", "test base refresh stop"),
      );
    };
    rig.github.readRef = (ref) =>
      Promise.resolve(portOk({ ref, sha: LEGACY_B1 }));
    const seeded = seededSnapshot([
      legacyLossWork("issue-48", LEGACY_ISSUE, legacyLossBlockedExtras()),
    ], { reservations: [legacyLossCharge()] });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run(2);
    assert.equal(outcome.status, "step_limit", JSON.stringify(outcome));
    assert.equal(proofCalls, 1, "the non-loss proof is not repeated");
    assert.equal(prepareCalls, 1, "base refresh receives the parked record");
    const state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "work");
    assert.equal(state.work[0]!.blocker, null);
    assert.equal(state.work[0]!.wait?.reason, "unavailable");
    assert.equal(state.work[0]!.intent?.kind, "base_refresh");
    assert.equal(rig.model.requests.length, 0);
  },
);

Deno.test(
  "legacy loss bridge: a cooldown-only state move between proof and CAS refuses the stale commit",
  async () => {
    const port = new RelationsFakeGithub({ baseSha: LEGACY_B0 });
    const rig = await makeRig("legacy-loss-drift", {
      summaries: false,
      localScope: true,
      githubPort: port,
    });
    try {
      const github: GitHubPort = port;
      const { run } = legacyLossCycles({
        clock: rig.clock,
        state: rig.store,
        github,
        incidents: rig.incidents,
        replay: rig.replay,
        model: rig.model,
      });
      const gate = new DurableGitHubCooldownGate({
        state: rig.store,
        clock: rig.clock,
      });
      let proofCalls = 0;
      github.proveLegacyBaseRefreshLoss = async (taskId) => {
        proofCalls++;
        const head = await repairStateHead(rig.store);
        // A valid cooldown-only update AFTER the proof bound its head: the
        // authoritative head moves without any work-contents change.
        const recorded = await gate.recordRateLimit(0, {
          kind: "primary",
          observedAt: rig.clock.now(),
          retryNotBefore: rig.clock.now() + 60_000,
          observationId: "c".repeat(64),
          fallback: false,
        });
        assert.ok(recorded.ok);
        return portOk(legacyLossProof(taskId, head));
      };
      const unrelated = workRecord("issue-9", {
        repository: LOCAL_SENTINEL_REPO,
        source: { kind: "issue", id: "9", revision: LEGACY_B0 },
        related: { incidentId: null, issueNumber: 9 },
        target: {
          base: LEGACY_B0,
          branch: null,
          checkpoint: null,
          head: null,
          pr: null,
        },
        nextStep: "work",
        counters: { attempts: 0, retries: 0, reviewRounds: 0 },
      });
      const seeded = seededSnapshot([
        legacyLossWork("issue-48", LEGACY_ISSUE),
        unrelated,
      ], {
        reviews: [legacyRejection()],
      });
      const written = await rig.store.writeRepair(seeded, null);
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await run(1);
      assert.equal(outcome.status, "step_limit", JSON.stringify(outcome));
      const state = await rig.snapshot();
      assert.equal(proofCalls, 1, "one bounded proof attempt");
      const legacy = state.work.find((work) => work.id === "issue-48")!;
      assert.equal(legacy.nextStep, "work", "zero stale CAS or blocker");
      assert.equal(legacy.blocker, null);
      assert.equal(legacy.target.head, LEGACY_H1);
      assert.equal(legacy.intent?.key, LEGACY_INTENT_KEY);
      assert.deepEqual(legacy.counters, {
        attempts: 3,
        retries: 0,
        reviewRounds: 1,
      });
      // The admitted cooldown-only write moved the authoritative head while
      // the proof's bound head stayed stale: the committed state's own
      // `stateHead` field is never the current head.
      const head = await repairStateHead(rig.store);
      assert.notEqual(state.stateHead, head);
      // The unrelated eligible issue still advances normally in this run.
      const advanced = state.work.find((work) => work.id === "issue-9")!;
      assert.equal(
        advanced.target.branch,
        candidateBranch(asWorkItemId("issue-9")),
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(state.reservations.length, 0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss bridge: a null higher candidate never starves the later recoverable one",
  async () => {
    const rig = legacyLossMemory();
    const calls: string[] = [];
    rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
      calls.push(taskId);
      if (taskId === "issue-2") return portOk(null);
      return portOk(legacyLossProof(taskId, await repairStateHead(rig.state)));
    };
    const unrelated = workRecord("issue-9", {
      repository: LOCAL_SENTINEL_REPO,
      source: { kind: "issue", id: "9", revision: LEGACY_B0 },
      related: { incidentId: null, issueNumber: 9 },
      classification: { severity: "P1", priority: null },
      target: {
        base: LEGACY_B0,
        branch: null,
        checkpoint: null,
        head: null,
        pr: null,
      },
      nextStep: "work",
      counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    });
    const seeded = seededSnapshot([
      legacyLossWork("issue-2", 2),
      legacyLossWork("issue-4", 4),
      unrelated,
    ], {
      reviews: [legacyRejection()],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");

    // Cycle 1: the null proof leaves the scan running, so the later
    // recoverable candidate receives its discovery CAS.
    const first = await rig.run(1);
    assert.equal(first.status, "step_limit", JSON.stringify(first));
    assert.deepEqual(calls, ["issue-2", "issue-4"], "one per phase");
    let state = await rig.snapshot();
    const higher = state.work.find((work) => work.id === "issue-2")!;
    assert.equal(higher.nextStep, "work", "null proof is no-op");
    assert.equal(higher.target.head, LEGACY_H1);
    assert.equal(higher.intent?.key, LEGACY_INTENT_KEY);
    const recovered = state.work.find((work) => work.id === "issue-4")!;
    assert.equal(recovered.nextStep, "blocked");
    assert.equal(recovered.blocker?.kind, "missing_evidence");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);

    // Cycle 2: restoration, then the unrelated P1 issue advances normally in
    // the same run. No model work is attributable to either bridge phase.
    const second = await rig.run(2);
    assert.equal(second.status, "step_limit", JSON.stringify(second));
    assert.deepEqual(calls, [
      "issue-2",
      "issue-4",
      "issue-2",
      "issue-4",
    ]);
    state = await rig.snapshot();
    const restored = state.work.find((work) => work.id === "issue-4")!;
    assert.equal(restored.nextStep, "work");
    assert.equal(restored.target.head, LEGACY_H0);
    assert.equal(restored.intent, null);
    const advanced = state.work.find((work) => work.id === "issue-9")!;
    assert.equal(
      advanced.target.branch,
      candidateBranch(asWorkItemId("issue-9")),
    );
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
    assert.equal(
      state.work.find((work) => work.id === "issue-2")!.nextStep,
      "work",
      "the null candidate is still untouched",
    );
  },
);

Deno.test(
  "legacy loss bridge: an unavailable higher candidate never starves the later recoverable one",
  async () => {
    const rig = legacyLossMemory();
    const calls: string[] = [];
    rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
      calls.push(taskId);
      if (taskId === "issue-2") {
        return portError("unavailable", "legacy loss proof unavailable");
      }
      return portOk(legacyLossProof(taskId, await repairStateHead(rig.state)));
    };
    const unrelated = workRecord("issue-9", {
      repository: LOCAL_SENTINEL_REPO,
      source: { kind: "issue", id: "9", revision: LEGACY_B0 },
      related: { incidentId: null, issueNumber: 9 },
      classification: { severity: "P1", priority: null },
      target: {
        base: LEGACY_B0,
        branch: null,
        checkpoint: null,
        head: null,
        pr: null,
      },
      nextStep: "work",
      counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    });
    const seeded = seededSnapshot([
      legacyLossWork("issue-2", 2),
      legacyLossWork("issue-4", 4),
      unrelated,
    ], {
      reviews: [legacyRejection()],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");

    // Cycle 1: the unavailable proof leaves the scan running, so the later
    // recoverable candidate receives its discovery CAS.
    const first = await rig.run(1);
    assert.equal(first.status, "step_limit", JSON.stringify(first));
    assert.deepEqual(calls, ["issue-2", "issue-4"], "one per phase");
    let state = await rig.snapshot();
    const higher = state.work.find((work) => work.id === "issue-2")!;
    assert.equal(higher.nextStep, "work", "unavailable proof is no-op");
    assert.equal(higher.target.head, LEGACY_H1);
    assert.equal(higher.intent?.key, LEGACY_INTENT_KEY);
    const recovered = state.work.find((work) => work.id === "issue-4")!;
    assert.equal(recovered.nextStep, "blocked");
    assert.equal(recovered.blocker?.kind, "missing_evidence");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);

    // Cycle 2: restoration, then the unrelated P1 issue advances normally in
    // the same run. No model work is attributable to either bridge phase.
    const second = await rig.run(2);
    assert.equal(second.status, "step_limit", JSON.stringify(second));
    assert.deepEqual(calls, [
      "issue-2",
      "issue-4",
      "issue-2",
      "issue-4",
    ]);
    state = await rig.snapshot();
    const restored = state.work.find((work) => work.id === "issue-4")!;
    assert.equal(restored.nextStep, "work");
    assert.equal(restored.target.head, LEGACY_H0);
    assert.equal(restored.intent, null);
    const advanced = state.work.find((work) => work.id === "issue-9")!;
    assert.equal(
      advanced.target.branch,
      candidateBranch(asWorkItemId("issue-9")),
    );
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
    assert.equal(
      state.work.find((work) => work.id === "issue-2")!.nextStep,
      "work",
      "the unavailable candidate is still untouched",
    );
  },
);

Deno.test(
  "legacy loss bridge: an earlier clean H0 receipt keeps the tuple blocked",
  async () => {
    const rig = legacyLossMemory();
    let proofCalls = 0;
    rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
      proofCalls++;
      return portOk(legacyLossProof(taskId, await repairStateHead(rig.state)));
    };
    // The clean receipt sorts FIRST for this PR/head, exactly the order the
    // existing headRejectedByReview helper reads (the real store's
    // deterministic id order preserves it too).
    const clean = legacyLossReview(
      "review-receipt:00-clean-first",
      LEGACY_H0,
      LEGACY_B0,
      {
        resultId: "result-clean",
        findings: [],
        unresolvedSeverities: [],
      },
    );
    const p0 = legacyRejection();
    const seeded = seededSnapshot([
      legacyLossWork("issue-48", LEGACY_ISSUE, legacyLossBlockedExtras()),
    ], {
      reviews: [clean, p0],
      reservations: [legacyLossCharge()],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const writesBefore = rig.state.repairWrites;
    const before = canonicalStringify((await rig.snapshot()).work[0]);

    const outcome = await rig.run(1);
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const record = state.work[0]!;
    assert.equal(record.nextStep, "blocked");
    assert.equal(record.blocker?.kind, "missing_evidence");
    assert.equal(record.target.head, LEGACY_H1);
    assert.equal(record.intent?.key, LEGACY_INTENT_KEY);
    assert.deepEqual(record.counters, {
      attempts: 3,
      retries: 0,
      reviewRounds: 1,
    });
    assert.equal(canonicalStringify(record), before);
    assert.equal(proofCalls, 1);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0]!.outcome, "submitted");
    assert.equal(
      rig.state.repairWrites,
      writesBefore,
      "refusal writes no state",
    );
  },
);

Deno.test(
  "legacy loss bridge: authentic restoration survives the retired attempt ceiling",
  async () => {
    const rig = legacyLossMemory();
    let proofCalls = 0;
    rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
      proofCalls++;
      return portOk(legacyLossProof(taskId, await repairStateHead(rig.state)));
    };
    const seeded = seededSnapshot([
      legacyLossWork("issue-48", LEGACY_ISSUE, {
        counters: { attempts: 4, retries: 0, reviewRounds: 1 },
      }),
    ], {
      reviews: [legacyRejection()],
      reservations: [legacyLossCharge("res-4", { attempt: 4 })],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");

    const first = await rig.run(1);
    assert.equal(first.status, "step_limit", JSON.stringify(first));
    assert.equal(proofCalls, 1);
    let state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "blocked");
    assert.equal(state.work[0]!.blocker?.kind, "missing_evidence");
    assert.equal(state.work[0]!.counters.attempts, 4);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 1);

    // A fresh authentic proof at the new state head authorizes restoration;
    // the retired attempt count alone cannot veto it or erase its charge.
    const second = await rig.run(1);
    assert.equal(second.status, "step_limit", JSON.stringify(second));
    assert.equal(
      proofCalls,
      2,
      "restoration obtains its own current-state proof",
    );
    state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "work");
    assert.equal(state.work[0]!.target.head, LEGACY_H0);
    assert.equal(state.work[0]!.target.base, LEGACY_B0);
    assert.equal(state.work[0]!.target.checkpoint, null);
    assert.equal(state.work[0]!.intent, null);
    assert.equal(state.work[0]!.blocker, null);
    assert.deepEqual(state.work[0]!.counters, {
      attempts: 4,
      retries: 0,
      reviewRounds: 1,
    });
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0]!.attempt, 4);
    assert.equal(state.reservations[0]!.outcome, "submitted");
    assert.equal(rig.model.requests.length, 0);
  },
);

Deno.test(
  "legacy loss bridge: new-format and unprepared/prepared foreign intents are never probed",
  async () => {
    const rig = legacyLossMemory();
    let proofCalls = 0;
    rig.github.proveLegacyBaseRefreshLoss = () => {
      proofCalls++;
      return Promise.resolve(portOk(null));
    };
    const blocked = legacyLossBlockedExtras();
    const newFormatBranch = candidateBranch(asWorkItemId("issue-30"));
    const newFormat = workRecord(
      "issue-30",
      legacyLossOverrides("issue-30", 30, {
        ...blocked,
        target: {
          base: LEGACY_B0,
          branch: newFormatBranch,
          checkpoint: { branch: newFormatBranch, sha: LEGACY_H1 },
          head: LEGACY_H1,
          pr: LEGACY_PR,
          candidateState: candidateStateFor(LEGACY_B0, LEGACY_H1),
        },
      }),
    );
    const preReceipt = workRecord(
      "issue-31",
      legacyLossOverrides("issue-31", 31, {
        ...blocked,
        intent: {
          kind: "implementation",
          key: implementationIntentKey("res-pre"),
          startedAt: T0,
          branch: candidateBranch(asWorkItemId("issue-31")),
          expectedHead: null,
          observedBase: LEGACY_B0,
          pr: null,
          requestId: "res-pre",
          resultId: null,
        },
      }),
    );
    const prepared = workRecord(
      "issue-32",
      legacyLossOverrides("issue-32", 32, {
        ...blocked,
        intent: { ...legacyLossIntent("issue-32"), resultId: LEGACY_H1 },
      }),
    );
    const seeded = seededSnapshot([newFormat, preReceipt, prepared]);
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const writesBefore = rig.state.repairWrites;

    const outcome = await rig.run(1);
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(proofCalls, 0, "no unsupported record is proved");
    const state = await rig.snapshot();
    for (const id of ["issue-30", "issue-31", "issue-32"]) {
      const before = canonicalStringify(seeded.work.find((w) => w.id === id));
      const after = canonicalStringify(state.work.find((w) => w.id === id));
      assert.equal(after, before, `${id} is untouched`);
    }
    assert.equal(rig.state.repairWrites, writesBefore, "no state write");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
  },
);

Deno.test(
  "legacy loss bridge: a mismatched proof tuple stays untouched and uncharged",
  async () => {
    const rig = legacyLossMemory();
    let proofCalls = 0;
    rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
      proofCalls++;
      return portOk(legacyLossProof(taskId, await repairStateHead(rig.state), {
        lostHead: LEGACY_B1,
      }));
    };
    const seeded = seededSnapshot([
      legacyLossWork("issue-48", LEGACY_ISSUE),
    ], {
      reviews: [legacyRejection()],
      reservations: [legacyLossCharge()],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const writesBefore = rig.state.repairWrites;
    const before = canonicalStringify((await rig.snapshot()).work[0]);

    const outcome = await rig.run(1);
    // The refused record is deferred for this run, so no eligible work remains.
    assert.equal(outcome.status, "margin", JSON.stringify(outcome));
    assert.equal(proofCalls, 1, "the phase is attempted once per run");
    const state = await rig.snapshot();
    assert.equal(canonicalStringify(state.work[0]), before);
    assert.equal(rig.state.repairWrites, writesBefore, "no state write");
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0]!.outcome, "submitted");
  },
);

Deno.test(
  "legacy loss bridge: a P1-only historical review is no rejection: the tuple stays untouched and uncharged",
  async (t) => {
    // Owner directive 2026-10-24: only an unresolved P0 rejects a head. A
    // historical H0/B0 review whose only finding is a P1 is a clean review, so
    // the proof it names is no authentic correction rejection: neither bridge
    // phase writes, charges or starts anything, exactly as for a mismatched
    // proof tuple. The ordinary gate would treat such an H0 as publish-ready,
    // so restoring it is refused.
    const p1Only = legacyLossReview(LEGACY_REVIEW_ID, LEGACY_H0, LEGACY_B0, {
      findings: [{
        id: "finding-h0",
        severity: "P1",
        path: "src/app.ts",
        message: "legacy correction finding",
        fingerprint: "a".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P1"],
    });
    assert.deepEqual(p1Only.unresolvedSeverities, ["P1"]);
    // The refused work tuple is deferred for the run (margin); the refused
    // blocked tuple simply stays blocked (idle), as for an earlier clean H0.
    const phases = [
      { name: "discovery (the work tuple)", extra: {}, status: "margin" },
      {
        name: "restoration (the blocked tuple)",
        extra: legacyLossBlockedExtras(),
        status: "idle",
      },
    ] as const;
    for (const phase of phases) {
      await t.step(phase.name, async () => {
        const rig = legacyLossMemory();
        let proofCalls = 0;
        rig.github.proveLegacyBaseRefreshLoss = async (taskId) => {
          proofCalls++;
          return portOk(
            legacyLossProof(taskId, await repairStateHead(rig.state)),
          );
        };
        const seeded = seededSnapshot([
          legacyLossWork("issue-48", LEGACY_ISSUE, { ...phase.extra }),
        ], {
          reviews: [p1Only],
          reservations: [legacyLossCharge()],
        });
        const written = await rig.state.writeRepair(seeded, null);
        assert.ok(written.ok && written.value.status === "applied");
        const writesBefore = rig.state.repairWrites;
        const before = canonicalStringify((await rig.snapshot()).work[0]);

        const outcome = await rig.run(1);
        assert.equal(outcome.status, phase.status, JSON.stringify(outcome));
        assert.equal(proofCalls, 1, "the phase is attempted once per run");
        const state = await rig.snapshot();
        assert.equal(canonicalStringify(state.work[0]), before);
        assert.equal(rig.state.repairWrites, writesBefore, "no state write");
        assert.equal(rig.model.requests.length, 0);
        assert.equal(state.reservations.length, 1);
        assert.equal(state.reservations[0]!.outcome, "submitted");
      });
    }
  },
);

Deno.test(
  "legacy loss bridge: an absent proof capability leaves generic behavior unchanged",
  async () => {
    const rig = legacyLossMemory();
    const seeded = seededSnapshot([
      legacyLossWork("issue-48", LEGACY_ISSUE),
    ], {
      reviews: [legacyRejection()],
      reservations: [legacyLossCharge()],
    });
    const written = await rig.state.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const writesBefore = rig.state.repairWrites;

    const outcome = await rig.run(1);
    assert.equal(outcome.status, "step_limit", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const record = state.work[0]!;
    // The generic unprepared base-refresh path waits bounded; the bridge never
    // writes its blocker and never touches the loss tuple.
    assert.equal(record.nextStep, "work");
    assert.equal(record.blocker, null);
    assert.equal(record.target.head, LEGACY_H1);
    assert.equal(record.intent?.key, LEGACY_INTENT_KEY);
    assert.equal(record.wait?.reason, "unavailable");
    assert.equal(rig.state.repairWrites, writesBefore + 1);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 1);
  },
);

// ---------------------------------------------------------------------------
// Review attempt recovery: a review that concluded without an accepted verdict
// is a bounded, observable disposition — never an eternal pending poll.
// ---------------------------------------------------------------------------
