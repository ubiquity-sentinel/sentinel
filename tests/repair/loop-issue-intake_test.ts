/** Native issue intake relations and queued-base freshness. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import { portError } from "../../src/contracts/ports.ts";
import {
  REPO,
  reviewReceipt,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import { isIssueOnlyIntake } from "../../src/repair/loop-intake.ts";
import { repairConfigs } from "./helpers.ts";

Deno.test("issue-only intake covers every configured GitHub target", () => {
  const [gateway] = repairConfigs();
  assert.ok(gateway);
  const github = { ...gateway, adapter: { kind: "github" as const } };
  assert.equal(isIssueOnlyIntake([gateway]), false);
  assert.equal(isIssueOnlyIntake([github]), true);
  assert.equal(
    isIssueOnlyIntake([
      github,
      { ...github, repository: { ...github.repository, name: "other" } },
    ]),
    true,
    "two GitHub targets are still issue-only",
  );
  assert.equal(isIssueOnlyIntake([github, gateway]), false);
  assert.equal(isIssueOnlyIntake([]), false);
});

Deno.test(
  "open GitHub issue intake creates one deterministic record and deduplicates repeated rows",
  async () => {
    const rig = await makeRig("issueintake", {
      summaries: false,
      github: {
        openIssues: [
          {
            number: 42,
            title: "repair the failing request",
            labels: ["P1", "priority:9"],
            createdAt: T0 - 300,
          },
          {
            number: 42,
            title: "duplicate listing with different metadata",
            labels: ["P2"],
            createdAt: T0 - 200,
          },
          {
            number: 43,
            title: "closed issue is not intake work",
            state: "closed",
            createdAt: T0 - 100,
          },
        ],
      },
    });
    try {
      // Keep the first run at intake so the assertion covers the durable
      // record creation without spending a model start on the new issue.
      const first = await rig.run(1);
      assert.equal(first.status, "margin", JSON.stringify(first));
      let state = await rig.snapshot();
      assert.equal(state.incidents.length, 0);
      assert.equal(state.work.length, 1);
      const issue = state.work[0];
      assert.equal(issue.source.kind, "issue");
      assert.equal(issue.source.id, "42");
      assert.equal(issue.related.issueNumber, 42);
      assert.equal(issue.source.revision, SHA1);
      assert.equal(issue.target.base, SHA1);
      assert.deepEqual(issue.classification, {
        severity: "P1",
        priority: 9,
      });
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "listOpenIssues").length,
        1,
      );
      assert.equal(
        rig.github.calls.filter((call) =>
          call === "readRef:refs/heads/development"
        ).length,
        1,
        "base is read once for the repository",
      );

      // The same open issue is observed again, including the duplicate row,
      // but its deterministic repository/number identity prevents a second
      // record or a second checkpoint.
      const sequence = state.sequence;
      const second = await rig.run(1);
      assert.equal(second.status, "margin", JSON.stringify(second));
      state = await rig.snapshot();
      assert.equal(state.sequence, sequence);
      assert.equal(state.work.length, 1);
      assert.equal(state.work[0].id, issue.id);
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "listOpenIssues").length,
        2,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "github adapter intake skips incident scans and admits a real seeded issue",
  async () => {
    // The fake incident source throws if touched at all: a github-only host
    // must advance the real seeded issue without any incident read.
    // The fake port serves the known-empty native relations that issue-only
    // github-adapter intake requires before any admission.
    const seededIssue = issueRecord(7, {
      title: "repair the failing request",
      labels: ["P1", "priority:9"],
      createdAt: T0 - 300,
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    const githubPort = new RelationsFakeGithub({ baseSha: SHA1 });
    githubPort.listed = [seededIssue];
    githubPort.latest.set(7, seededIssue);
    const rig = await makeRig("githubintake", {
      summaries: false,
      configOverrides: { adapter: { kind: "github" } },
      incidents: { throwOnList: true },
      githubPort,
    });
    try {
      const first = await rig.run(1);
      assert.equal(first.status, "margin", JSON.stringify(first));
      const state = await rig.snapshot();
      assert.equal(state.incidents.length, 0);
      assert.equal(state.work.length, 1);
      const issue = state.work[0];
      assert.equal(issue.source.kind, "issue");
      assert.equal(issue.source.id, "7");
      assert.equal(issue.related.issueNumber, 7);
      assert.equal(issue.source.revision, SHA1);
      assert.equal(issue.target.base, SHA1);
      assert.deepEqual(issue.classification, { severity: "P1", priority: 9 });
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "listOpenIssues").length,
        1,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "github adapter issue intake gates on native relations before any model start",
  async () => {
    // A parent (has sub-issues) and an open-blocked issue are skipped at
    // intake: no work record, no reservation and no model start.
    const blocked = new RelationsFakeGithub({ baseSha: SHA1 });
    blocked.listed = [
      issueRecord(11, {
        relations: {
          openBlockers: [{ owner: "ubiquity", name: "ai.ubq.fi", number: 3 }],
          subIssueCount: 0,
        },
      }),
      issueRecord(12, {
        relations: { openBlockers: [], subIssueCount: 2 },
      }),
    ];
    const blockedRig = makeMemoryRig(blocked);
    const blockedRun = await blockedRig.run(1);
    assert.equal(blockedRun.status, "idle", JSON.stringify(blockedRun));
    let state = await blockedRig.snapshot();
    assert.equal(state.work.length, 0);
    assert.equal(state.reservations.length, 0);
    assert.equal(blockedRig.model.requests.length, 0);

    // Unknown listing relations may stage a durable row for later inspection,
    // but the fresh admission read must never treat UNKNOWN as known-empty.
    const missing = new RelationsFakeGithub({ baseSha: SHA1 });
    const unknownIssue = issueRecord(13, { title: "unknown dependencies" });
    missing.listed = [unknownIssue];
    missing.latest.set(13, unknownIssue);
    const missingRig = makeMemoryRig(missing);
    const missingRun = await missingRig.run(1);
    assert.equal(missingRun.status, "step_limit", JSON.stringify(missingRun));
    state = await missingRig.snapshot();
    assert.equal(state.work.length, 1);
    const stagedId = state.work[0].id;
    assert.equal(state.reservations.length, 0);
    assert.equal(missingRig.model.requests.length, 0);

    await missingRig.run(6);
    state = await missingRig.snapshot();
    assert.equal(state.work.length, 1);
    assert.equal(state.work[0].id, stagedId);
    assert.equal(state.work[0].intent, null);
    assert.equal(state.work[0].counters.attempts, 0);
    assert.equal(state.reservations.length, 0);
    assert.equal(missingRig.model.requests.length, 0);
    assert.equal(state.work[0].wait?.reason, "unavailable");
    assert.equal(state.work[0].wait?.until, T0 + 60 * 60_000);
    assert.ok(missing.calls.includes("readIssue:13"));

    // The same queued row can recover after a later authoritative read shows
    // known-empty relations; the retry neither duplicates it nor pre-charges.
    const recoveredIssue = {
      ...unknownIssue,
      relations: { openBlockers: [], subIssueCount: 0 },
    };
    missing.listed = [recoveredIssue];
    missing.latest.set(13, recoveredIssue);
    missingRig.clock.advance(60 * 60_000);
    await missingRig.run(6);
    state = await missingRig.snapshot();
    assert.equal(state.work.length, 1);
    assert.equal(state.work[0].id, stagedId);
    assert.equal(state.work[0].counters.attempts, 1);
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].outcome, "submitted");
    assert.equal(missingRig.model.requests.length, 1);

    // A known-unblocked leaf is admitted and the implementation start is
    // charged exactly once against the same latest read.
    const leaf = new RelationsFakeGithub({ baseSha: SHA1 });
    const leafIssue = issueRecord(14, {
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    leaf.listed = [leafIssue];
    leaf.latest.set(14, leafIssue);
    const leafRig = makeMemoryRig(leaf);
    await leafRig.run(6);
    state = await leafRig.snapshot();
    assert.equal(state.work.length, 1);
    assert.equal(leafRig.model.requests.length, 1);
    assert.equal(state.reservations[0]?.outcome, "submitted");

    // The source changes between the intake listing and the model-admission
    // re-read (an open blocker appears): admission defers with zero
    // reservation and zero model start, waiting exactly one hour so the next
    // poll re-reads the native dependency.
    const moved = new RelationsFakeGithub({ baseSha: SHA1 });
    moved.listed = [
      issueRecord(15, { relations: { openBlockers: [], subIssueCount: 0 } }),
    ];
    moved.latest.set(
      15,
      issueRecord(15, {
        relations: {
          openBlockers: [{
            owner: "ubiquity-sentinel",
            name: "sentinel",
            number: 99,
          }],
          subIssueCount: 0,
        },
      }),
    );
    const movedRig = makeMemoryRig(moved);
    await movedRig.run(6);
    state = await movedRig.snapshot();
    assert.equal(state.work.length, 1);
    assert.equal(state.work[0].wait?.reason, "unavailable");
    assert.equal(state.work[0].wait?.until, T0 + 60 * 60_000);
    assert.equal(state.reservations.length, 0);
    assert.equal(movedRig.model.requests.length, 0);
  },
);

Deno.test(
  "gateway intake keeps an incident source failure as a failure",
  async () => {
    // A single gateway configuration (and any ambiguous host) keeps the
    // existing incident read and its source-error outcome.
    const rig = await makeRig("gatewaysourcefail", {
      summaries: false,
      incidents: { failListNext: true },
    });
    try {
      const result = await rig.run(1);
      assert.equal(result.status, "source_error", JSON.stringify(result));
      const state = await rig.snapshot();
      assert.equal(state.work.length, 0);
      assert.equal(rig.model.requests.length, 0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

/**
 * Known-eligible issue source whose configured development ref read fails (no
 * fresh base): the native relations resolve, so the run reaches the base read
 * instead of stopping at the prerequisite read.
 */
class BaseRefUnavailableGithub extends RelationsFakeGithub {
  override readRef(
    ref: string,
  ): Promise<PortResultV1<{ ref: string; sha: GitSha } | null>> {
    if (ref.endsWith("refs/heads/development")) {
      this.calls.push(`readRef:${ref}`);
      return Promise.resolve(
        portError("unavailable", "development ref read failed"),
      );
    }
    return super.readRef(ref);
  }
}

Deno.test(
  "queued issue base: stale target base is refreshed before admission and history survives",
  async () => {
    const sourceIssue = issueRecord(1, {
      title: "queued repair",
      body: "body",
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    const github = new RelationsFakeGithub({ baseSha: SHA2 });
    github.listed = [sourceIssue];
    github.latest.set(1, sourceIssue);
    const rig = makeMemoryRig(github);
    // Below the hard review-round ceiling: with no round left the work step
    // parks the record instead of starting an implementation.
    const queued = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA3 },
      counters: { attempts: 2, retries: 2, reviewRounds: 2 },
      firstSeenAt: T0 - 10_000,
      createdAt: T0 - 9_000,
      // The deterministic branch identity is already recorded: the first work
      // step of the loop assigns a candidate branch when it is null, so seeding
      // it is what lets the first single step reach the intended queued-base
      // refresh instead of stopping at branch assignment.
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-1",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const written = await rig.state.writeRepair(
      seededSnapshot([queued]),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    // One step: only the base refresh is persisted; nothing is reserved yet.
    const first = await rig.run(1);
    assert.equal(first.status, "step_limit", JSON.stringify(first));
    let state = await rig.snapshot();
    assert.equal(state.work[0].target.base, SHA2);
    assert.equal(state.work[0].source.revision, SHA3, "source revision kept");
    assert.deepEqual(state.work[0].counters, {
      attempts: 2,
      retries: 2,
      reviewRounds: 2,
    });
    assert.equal(state.work[0].id, queued.id);
    assert.equal(state.work[0].createdAt, T0 - 9_000);
    assert.equal(state.work[0].firstSeenAt, T0 - 10_000);
    assert.equal(rig.model.requests.length, 0, "refresh never starts a model");
    assert.equal(state.reservations.length, 0, "refresh reserves nothing");

    // The next admission charges and runs against the refreshed base.
    await rig.run(1);
    assert.equal(rig.model.requests.length, 1);
    assert.equal(rig.model.requests[0].base, SHA2);
    state = await rig.snapshot();
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].head, SHA2);
    // The third implementation start is admitted (the cap is three attempts).
    assert.equal(state.work[0].counters.attempts, 3);
    assert.equal(state.work[0].source.revision, SHA3);
  },
);

Deno.test(
  "queued issue base: an unavailable development ref reserves nothing",
  async () => {
    const sourceIssue = issueRecord(1, {
      title: "queued repair",
      body: "body",
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    const github = new BaseRefUnavailableGithub();
    github.listed = [sourceIssue];
    github.latest.set(1, sourceIssue);
    const rig = makeMemoryRig(github);
    const written = await rig.state.writeRepair(
      seededSnapshot([
        workRecord("issue-1", {
          source: { kind: "issue", id: "1", revision: SHA1 },
        }),
      ]),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.ok(
      github.calls.includes("readRef:refs/heads/development"),
      "the eligible issue reaches the unavailable base read",
    );
    assert.equal(rig.model.requests.length, 0);
    assert.equal(state.reservations.length, 0);
    assert.equal(state.work[0].target.base, SHA1, "base stays as recorded");
    assert.equal(state.work[0].wait?.reason, "unavailable");
    assert.equal(state.work[0].wait?.until, T0 + 60 * 60_000);
    // No reservation, model start or charged counter: the record only re-armed
    // its bounded wait, which the additive no-progress counter records.
    assert.deepEqual(
      {
        attempts: state.work[0].counters.attempts,
        retries: state.work[0].counters.retries,
        reviewRounds: state.work[0].counters.reviewRounds,
      },
      { attempts: 0, retries: 0, reviewRounds: 0 },
    );
    assert.equal(state.work[0].counters.stalled, 2);
  },
);

Deno.test(
  "queued issue base: a saved candidate keeps its recorded base on the correction path",
  async () => {
    const sourceIssue = issueRecord(1, {
      title: "queued repair",
      body: "body",
      relations: { openBlockers: [], subIssueCount: 0 },
    });
    const github = new RelationsFakeGithub({ baseSha: SHA2 });
    github.listed = [sourceIssue];
    github.latest.set(1, sourceIssue);
    const rig = makeMemoryRig(github);
    const correction = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
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
    // Without a completed, finding-bearing receipt for the CURRENT head the
    // work step would wait on the existing review. The receipt binds the exact
    // repository/PR/head/base and one unresolved P1 finding, so the run must
    // actually correct the rejected candidate.
    const rejected = reviewReceipt("review-receipt-1", {
      repository: REPO,
      pullRequest: { number: 7, head: SHA3, base: SHA1 },
      outcome: "completed",
      resultId: "result-1",
      observedReviewer: "chatgpt-codex-connector[bot]",
      submittedAt: T0,
      completedAt: T0 + 1000,
      observedAt: T0 + 1001,
      findings: [{
        id: "finding-1",
        severity: "P1",
        path: "src/app.ts",
        message: "required fix",
        fingerprint: "a".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P1"],
    });
    const written = await rig.state.writeRepair(
      seededSnapshot([correction], { reviews: [rejected] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    // Exactly ONE step: this test asserts the one correction operation for the
    // seeded rejected head. The fake always returns SHA3, the same head the
    // review rejected, so any further step would "correct" that unchanged
    // rejected fake head again and inflate the model/reservation counts; the
    // single step exercises the correction path being asserted here.
    await rig.run(1);
    const state = await rig.snapshot();
    assert.equal(rig.model.requests.length, 1);
    assert.equal(
      rig.model.requests[0].base,
      SHA1,
      "candidate correction is never rebased",
    );
    assert.equal(state.reservations[0].head, SHA1);
    assert.equal(state.work[0].target.base, SHA1);
    assert.ok(
      !github.calls.includes("readRef:refs/heads/development"),
      "saved-candidate work never reads the development ref",
    );
  },
);

// ---------------------------------------------------------------------------
// Hosted supervisor release receipt consumption (self scope 0). These cases run
// through the actual runRepairEntrypoint with a real temporary Git state and the
// REAL persisted-receipt reader wired exactly as the hosted host wires it.
// ---------------------------------------------------------------------------
