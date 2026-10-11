/** Changed incident intake preserves unrelated and foreign work. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  candidateBranch,
  workItemIdForIncident,
} from "../../src/repair/keys.ts";
import {
  incidentSummary,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  evidenceFixture,
  FINGERPRINT,
  issueRecord,
  makeRig,
  seededSnapshot,
  summaryFixture,
} from "./loop-rig.ts";
import {
  candidateStateFor,
  H0,
  positiveLifecycle,
} from "./loop-candidate-fixtures.ts";

Deno.test("changed incident intake refreshes matching work while unrelated parked work is isolated", async () => {
  const rig = await makeRig("candidate-intake", {
    github: {
      openIssues: [issueRecord(55), issueRecord(101)],
      issues: [issueRecord(101)],
      candidateLifecycle: positiveLifecycle(),
    },
  });
  try {
    const parkedIncident = workRecord("incident-parked", {
      source: { kind: "incident", id: "inc-a", revision: SHA2 },
      related: { incidentId: "inc-a", issueNumber: null },
      fingerprint: FINGERPRINT,
      failingRevision: SHA2,
      nextStep: "review",
      wait: { reason: "review_pending", since: T0, until: T0 + 10_000_000 },
      target: {
        base: SHA1,
        branch: candidateBranch(asWorkItemId("incident-parked")),
        checkpoint: null,
        head: H0,
        pr: 7,
        candidateState: candidateStateFor(SHA1, H0),
      },
    });
    // A parked ISSUE task must be found by the whole-snapshot issue lookup and
    // never recreated from the incoming issue list. Its explicit task-level
    // wait (no restored global parking) keeps it out of this run.
    const parkedIssue = workRecord("issue-55", {
      source: { kind: "issue", id: "55", revision: SHA1 },
      related: { incidentId: null, issueNumber: 55 },
      nextStep: "work",
      wait: { reason: "unavailable", since: T0, until: T0 + 10_000_000 },
      target: {
        base: SHA1,
        branch: candidateBranch(asWorkItemId("issue-55")),
        checkpoint: null,
        head: H0,
        pr: 8,
        candidateState: candidateStateFor(SHA1, H0),
      },
    });
    const storedSummary = summaryFixture();
    const written = await rig.store.writeRepair(
      seededSnapshot([parkedIncident, parkedIssue], {
        incidents: [storedSummary],
      }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");
    const beforeIncident = canonicalStringify(parkedIncident);
    const beforeIssue = canonicalStringify(parkedIssue);

    // The source now reports a changed summary for the stored incident. The
    // matching summary and its matching work identity are refreshed; the
    // unrelated parked issue remains byte-identical and is not recreated.
    const changed = incidentSummary("inc-a", {
      fingerprint: FINGERPRINT,
      severity: "P0",
      count: 9,
      firstSeenAt: storedSummary.firstSeenAt,
      lastSeenAt: T0 + 900_000,
      failingRevision: SHA2,
      context: {
        message: "changed upstream failure",
        location: null,
        sample: [],
      },
      evidenceRef: storedSummary.evidenceRef,
    });
    rig.incidents.setSummaries([changed]);

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();

    const afterIncident = state.work.find((work) =>
      work.id === parkedIncident.id
    );
    const afterIssue = state.work.find((work) => work.id === parkedIssue.id);
    assert.ok(afterIncident && afterIssue);
    assert.notEqual(
      canonicalStringify(afterIncident),
      beforeIncident,
      "the matching incident work is refreshed",
    );
    assert.equal(afterIncident?.fingerprint, FINGERPRINT);
    assert.equal(afterIncident?.source.id, "inc-a");
    assert.equal(afterIncident?.firstSeenAt, null, "identity is preserved");
    assert.equal(afterIncident?.classification.severity, "P0");
    assert.equal(afterIncident?.target.head, H0, "candidate target untouched");
    assert.deepEqual(afterIncident?.counters, {
      attempts: 0,
      retries: 0,
      reviewRounds: 0,
    });
    assert.ok(
      afterIncident?.evidence.some((ref) => ref.kind === "incident_evidence"),
      "the refreshed summary evidence is attached",
    );
    assert.equal(canonicalStringify(afterIssue), beforeIssue);
    assert.equal(
      canonicalStringify(state.incidents[0]),
      canonicalStringify(changed),
      "the matching incident summary is refreshed",
    );
    assert.equal(
      state.work.length,
      3,
      "the parked issue task was not recreated",
    );

    // The unrelated legacy issue advanced through the real loop.
    const legacy = state.work.find((work) =>
      work.source.kind === "issue" && work.source.id === "101"
    );
    assert.ok(legacy, "the legacy issue task exists");
    assert.equal(legacy?.nextStep, "review");
    assert.equal(legacy?.wait?.reason, "review_pending");
    assert.equal(legacy?.target.head, SHA3);
    assert.equal(legacy?.target.pr, 7);
    assert.equal(legacy?.counters.attempts, 1);
    assert.equal(
      rig.model.requests.length,
      1,
      "exactly one model start, for the legacy task",
    );
    assert.equal(rig.github.pushes.length, 1, "one legacy candidate push");
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      1,
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      0,
      "no merge for the waiting incident",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "observeReview").length,
      0,
      "the waiting task's review is never observed",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1 correction: intake lookups bind the exact incident scope (incident id,
// fingerprint and repository identity), so candidate state from another
// incident or repository can never suppress an incoming summary. Identity
// isolation — never global candidate parking — is what keeps A untouched.
// ---------------------------------------------------------------------------

/** The candidate's repository: same owner, different name from REPO. */
const FOREIGN_REPO = {
  owner: "ubiquity",
  name: "sentinel",
  installationId: 7,
} as const;

Deno.test(
  "changed incident intake keeps another repository's candidate isolated",
  async () => {
    // B is the configured repository (REPO) and uses its normal evidence.
    const incoming = summaryFixture();
    const rig = await makeRig("candidate-incident-foreign-repo", {
      incidents: { summaries: [incoming], evidence: evidenceFixture() },
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      // A lives in another repository (same owner, different name) and
      // carries the same fingerprint as incoming inc-a. A fingerprint-only
      // work lookup would have matched this record and skipped inc-a entirely.
      const parkedAId = workItemIdForIncident(FOREIGN_REPO, FINGERPRINT);
      const parkedA = workRecord(parkedAId, {
        repository: FOREIGN_REPO,
        source: { kind: "incident", id: "inc-parked", revision: SHA2 },
        related: { incidentId: "inc-parked", issueNumber: null },
        fingerprint: FINGERPRINT,
        failingRevision: SHA2,
        nextStep: "review",
        wait: { reason: "review_pending", since: T0 - 2, until: T0 - 1 },
        target: {
          base: SHA1,
          branch: candidateBranch(parkedAId),
          checkpoint: null,
          head: H0,
          pr: 7,
          candidateState: candidateStateFor(SHA1, H0),
        },
      });
      const storedSummaryA = incidentSummary("inc-parked", {
        repository: FOREIGN_REPO,
        fingerprint: FINGERPRINT,
        failingRevision: SHA2,
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([parkedA], { incidents: [storedSummaryA] }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const beforeWorkA = canonicalStringify(parkedA);
      const beforeSummaryA = canonicalStringify(storedSummaryA);

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();

      // Parked A is byte-identical: never refreshed, duplicated or recreated.
      const afterA = state.work.find((work) => work.id === parkedAId);
      assert.ok(afterA, "the parked foreign-repository work survives");
      assert.equal(canonicalStringify(afterA), beforeWorkA);
      const afterSummaryA = state.incidents.find((incident) =>
        incident.id === "inc-parked"
      );
      assert.ok(afterSummaryA, "the foreign-repository summary survives");
      assert.equal(canonicalStringify(afterSummaryA), beforeSummaryA);
      assert.equal(state.incidents.length, 2, "exactly the two summaries");

      // B's own summary and correctly scoped work exist.
      const bSummary = state.incidents.find((incident) =>
        incident.id === "inc-a"
      );
      assert.ok(bSummary, "the configured repository's summary is saved");
      assert.equal(canonicalStringify(bSummary), canonicalStringify(incoming));
      assert.deepEqual(bSummary.repository, REPO);

      const bWorkId = workItemIdForIncident(REPO, FINGERPRINT);
      const bWork = state.work.find((work) => work.id === bWorkId);
      assert.ok(bWork, "the configured repository's work exists");
      assert.deepEqual(bWork.repository, REPO);
      assert.equal(bWork.source.kind, "incident");
      assert.equal(bWork.source.id, "inc-a");
      assert.equal(bWork.related.incidentId, "inc-a");
      assert.equal(bWork.fingerprint, FINGERPRINT);
      assert.equal(bWork.nextStep, "review");
      assert.equal(bWork.wait?.reason, "review_pending");
      assert.equal(bWork.target.pr, 7);
      assert.equal(bWork.counters.attempts, 1);
      assert.equal(state.work.length, 2, "no duplicate or extra work record");

      // Exactly one implementation, and only B was published and reviewed.
      assert.equal(rig.model.requests.length, 1, "exactly one model start");
      assert.equal(rig.model.requests[0].taskId, bWorkId);
      assert.deepEqual(rig.model.requests[0].repository, REPO);
      assert.equal(rig.github.pushes.length, 1, "one candidate push");
      assert.equal(
        rig.github.pushes[0].ref,
        `refs/heads/${candidateBranch(bWorkId)}`,
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        1,
        "only B was published",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
        "only B requested review",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        0,
        "no merge for the parked task",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "observeReview").length,
        0,
        "the parked task's expired review wait is never observed",
      );
      assert.ok(rig.incidents.readCalls.length >= 1, "B evidence was read");
      assert.ok(
        rig.incidents.readCalls.every((incidentId) => incidentId === "inc-a"),
        "no evidence read for the foreign parked incident",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "changed incident intake saves a new incident summary without running the fingerprint-duplicate task",
  async () => {
    const incoming = incidentSummary("inc-new", {
      fingerprint: FINGERPRINT,
      severity: "P1",
      count: 2,
      lastSeenAt: T0 + 900_000,
      failingRevision: SHA2,
      context: {
        message: "fresh observation of the same fingerprint",
        location: null,
        sample: [],
      },
    });
    // Same configured repository and fingerprint as stored inc-old; the
    // incident id is the only remaining scope difference.
    const rig = await makeRig("candidate-incident-same-repo", {
      incidents: { summaries: [incoming], evidence: null },
    });
    try {
      const parkedId = workItemIdForIncident(REPO, FINGERPRINT);
      const parkedOld = workRecord(parkedId, {
        repository: REPO,
        source: { kind: "incident", id: "inc-old", revision: SHA2 },
        related: { incidentId: "inc-old", issueNumber: null },
        fingerprint: FINGERPRINT,
        failingRevision: SHA2,
        nextStep: "review",
        // The intended no-work guarantee comes from this explicit task-level
        // wait, never from restored global candidate parking.
        wait: { reason: "review_pending", since: T0, until: T0 + 10_000_000 },
        target: {
          base: SHA1,
          branch: candidateBranch(parkedId),
          checkpoint: null,
          head: H0,
          pr: 7,
          candidateState: candidateStateFor(SHA1, H0),
        },
      });
      const storedOld = incidentSummary("inc-old", {
        fingerprint: FINGERPRINT,
        failingRevision: SHA2,
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([parkedOld], { incidents: [storedOld] }),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      const beforeWork = canonicalStringify(parkedOld);
      const beforeOld = canonicalStringify(storedOld);

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();

      // The new incident summary is durable...
      const afterNew = state.incidents.find((incident) =>
        incident.id === "inc-new"
      );
      assert.ok(afterNew, "the new incident summary is saved");
      assert.equal(canonicalStringify(afterNew), canonicalStringify(incoming));
      // ...while the old summary and the parked work keep their exact bytes.
      const afterOld = state.incidents.find((incident) =>
        incident.id === "inc-old"
      );
      assert.ok(afterOld, "the old incident summary survives");
      assert.equal(canonicalStringify(afterOld), beforeOld);
      const afterWork = state.work.find((work) => work.id === parkedId);
      assert.ok(afterWork, "the parked work survives");
      assert.equal(canonicalStringify(afterWork), beforeWork);

      // The tentative work record for inc-new carries the canonical
      // workItemIdForIncident id, a pure function of repository and
      // fingerprint, so the existing final draft.work id dedupe skips it as a
      // duplicate of the parked inc-old record. This test does not claim a
      // second task is runnable.
      assert.equal(state.work.length, 1, "exactly one original work record");
      assert.equal(state.replays.length, 0);
      assert.equal(state.reservations.length, 0, "no reservation");
      assert.equal(rig.model.requests.length, 0, "no model start");
      assert.equal(rig.github.pushes.length, 0, "no push");
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        0,
        "no publication",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
        "no review request",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "observeReview").length,
        0,
        "the parked review wait is never observed",
      );
      assert.equal(rig.incidents.readCalls.length, 0, "no evidence read");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Legacy loss bridge (M14/V17): the bounded pre-ranking two-CAS recovery of a
// proven lost legacy base-refresh candidate. Real Git state stores prove the
// historical ancestry and the ordinary charged successor; cheap MemoryState
// fixtures cover the refusal and scheduling variations. The optional proof
// capability is attached through a GitHubPort-typed reference because the
// concrete FakeGithub class does not declare it.
// ---------------------------------------------------------------------------
