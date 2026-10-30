import assert from "node:assert/strict";
import { selectTrustedTargetPolicyV1 } from "../../src/host/target-policy.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { touchesProtected } from "../../src/repair/loop-records.ts";
import {
  CI_FIX_EXHAUSTED_PREFIX,
  ciFixesLeft,
} from "../../src/repair/ci-first-policy.ts";
import {
  REVIEW_ROUND_CEILING_UNREVIEWED,
  reviewRoundsLeft,
} from "../../src/repair/review-round-cap.ts";
import { TASK_ACCEPTANCE_OWNER_GATE_DETAIL } from "../../src/repair/acceptance-correction.ts";
import { preReviewFixEligible } from "../../ops/hosted-autonomy-ci-first.ts";
import { planRaisedCeilingReadmission } from "../../ops/hosted-autonomy-raised-ceiling.ts";
import { planAcceptanceReadmissions } from "../../ops/hosted-autonomy-acceptance.ts";
import { BASE, deliveryRecord, HEAD } from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";

import { reservation } from "../state/helpers.ts";

const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 155687488,
};

function parked(message: string): WorkRecordV1 {
  return deliveryRecord({
    repository: PASSPORT,
    id: "issue-ubiquity-passport.ubq.fi-120",
    source: { kind: "issue", id: "120", revision: BASE },
    related: { incidentId: null, issueNumber: 120 },
    target: {
      base: BASE,
      head: HEAD,
      branch: "sentinel/repair/issue-ubiquity-passport.ubq.fi-120",
      checkpoint: null,
      pr: 172,
    },
    counters: { attempts: 20, retries: 10, reviewRounds: 10 },
    nextStep: "blocked",
    blocker: { kind: "other", message, since: 1793330000000 },
    intent: null,
    wait: null,
  });
}

function trialSnapshot(record: WorkRecordV1) {
  return repairSnapshot([record], [], [], [
    reservation("passport-trial-current-admission", {
      repository: record.repository,
      taskId: record.id,
      head: record.target.base,
      attempt: record.counters.attempts,
      purpose: "retry",
      outcome: "submitted",
      createdAt: 1793329990000,
      settledAt: 1793330000000,
    }),
  ]);
}

Deno.test("Passport trial: trusted policy permits product repairs and keeps credential and workflow authority", () => {
  const template = createLocalRepositoryConfig();
  const policy = selectTrustedTargetPolicyV1(template, PASSPORT);
  for (
    const path of [
      "kv-service/src/worker.ts",
      "scripts/check_deno.ts",
      "package.json",
      "bun.lock",
      "wrangler.jsonc",
      "AGENTS.md",
      "src/state/product.ts",
      "src/repair/passport-work-trial.ts",
    ]
  ) {
    assert.equal(touchesProtected(policy.protectedPaths, path), false, path);
  }
  for (
    const path of [
      ".env",
      ".actrc",
      ".secrets",
      ".vars",
      ".input",
      ".npmrc",
      ".git/config",
      ".github/workflows/ci.yml",
    ]
  ) {
    assert.equal(touchesProtected(policy.protectedPaths, path), true, path);
  }
  assert.deepEqual(
    selectTrustedTargetPolicyV1(template, template.repository).protectedPaths,
    template.protectedPaths,
  );
  assert.equal(
    touchesProtected(
      template.protectedPaths,
      "src/repair/passport-work-trial.ts",
    ),
    true,
    "controller trial authority stays protected",
  );
  assert.equal(
    touchesProtected(
      selectTrustedTargetPolicyV1(template, {
        owner: "ubiquity",
        name: "ai.ubq.fi",
      }).protectedPaths,
      "src/auth/session.ts",
    ),
    true,
  );
});

Deno.test("Passport trial: counted CI and review attempts remain available without changing history", () => {
  const record = parked(REVIEW_ROUND_CEILING_UNREVIEWED);
  const snapshot = trialSnapshot(record);
  const before = structuredClone(snapshot);
  assert.equal(ciFixesLeft(record), true);
  assert.ok(reviewRoundsLeft(snapshot, record) > 0);
  const other = { ...record, repository: { ...PASSPORT, name: "ai.ubq.fi" } };
  assert.equal(ciFixesLeft(other), false);
  assert.equal(reviewRoundsLeft(snapshot, other), 0);
  assert.deepEqual(snapshot, before);
});

Deno.test("Passport trial: exact spent review CI and acceptance parks reenter their ordinary consumers", async (t) => {
  await t.step("review", () => {
    const record = parked(REVIEW_ROUND_CEILING_UNREVIEWED);
    const snapshot = trialSnapshot(record);
    assert.equal(
      planRaisedCeilingReadmission(snapshot, record, null)?.nextStep,
      "work",
    );
  });
  await t.step("CI correction", () => {
    const record = parked(CI_FIX_EXHAUSTED_PREFIX + "validate (failure)");
    const snapshot = trialSnapshot(record);
    assert.equal(preReviewFixEligible(snapshot, record), true);
  });
  await t.step("task acceptance", () => {
    const record = parked(TASK_ACCEPTANCE_OWNER_GATE_DETAIL);
    const snapshot = trialSnapshot(record);
    assert.equal(
      planAcceptanceReadmissions(snapshot, new Set(), true)[0]?.nextStep,
      "review",
    );
    assert.deepEqual(
      planAcceptanceReadmissions(snapshot, new Set(), false),
      [],
    );
  });
});

import {
  makeRig as maintenanceRig,
  run as runMaintenance,
} from "./hosted-autonomy-rig.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  repairConfigs,
} from "../repair/helpers.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { decideCiGate } from "../../src/repair/loop-checks.ts";
import { reviewAuthorizesMerge } from "../../src/repair/review-gate.ts";
import { check } from "../repair/ci-correction-rig.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { SHA1, SHA3, T0 } from "../state/helpers.ts";
import { protectedReadmissionShape } from "../../ops/hosted-autonomy-protected-readmission.ts";

Deno.test("Passport trial: unfinished ambiguous and stale publication custody never grants a replacement", () => {
  for (const outcome of ["reserved", "ambiguous"] as const) {
    const record = parked(REVIEW_ROUND_CEILING_UNREVIEWED);
    const snapshot = trialSnapshot(record);
    snapshot.reservations[0].outcome = outcome;
    snapshot.reservations[0].settledAt = outcome === "reserved"
      ? null
      : 1793330000000;
    const before = structuredClone(snapshot);
    assert.equal(planRaisedCeilingReadmission(snapshot, record, null), null);
    record.blocker!.message = CI_FIX_EXHAUSTED_PREFIX + "ci(failure)";
    assert.equal(preReviewFixEligible(snapshot, record), false);
    record.blocker!.message = TASK_ACCEPTANCE_OWNER_GATE_DETAIL;
    assert.deepEqual(planAcceptanceReadmissions(snapshot, new Set(), true), []);
    record.blocker!.message = REVIEW_ROUND_CEILING_UNREVIEWED;
    assert.deepEqual(snapshot, before);
  }
  const published = parked("candidate touches a protected path");
  published.target.candidateState = { preserved: null, publishedHead: BASE };
  assert.equal(
    protectedReadmissionShape(published),
    false,
    "published custody is never dropped",
  );
});

Deno.test("Passport trial: real Git maintenance readmits once and repair publishes only through CI and review", async () => {
  const record = parked("candidate touches a protected path");
  Object.assign(record, {
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    evidence: [],
    createdAt: T0,
    updatedAt: T0,
  });
  record.blocker!.since = T0;
  record.target = {
    ...record.target,
    pr: null,
    candidateState: { preserved: null, publishedHead: null },
  };
  const charge = reservation("passport-original-charge", {
    repository: PASSPORT,
    taskId: record.id,
    head: BASE,
    attempt: 1,
    purpose: "implementation",
    outcome: "submitted",
    createdAt: T0,
    settledAt: T0,
  });
  const { rig, github: maintenance } = await maintenanceRig(
    "passport-connected-trial",
    {
      repair: repairSnapshot([record], [], [], [charge]),
      issueOpen: true,
      baseTip: BASE,
    },
  );
  try {
    const reopened = await runMaintenance(rig, maintenance);
    assert.equal(reopened.status, "applied", JSON.stringify(reopened));
    let read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(read.value.snapshot.work[0].nextStep, "work");
    assert.equal(read.value.snapshot.work[0].target.head, null);
    assert.deepEqual(read.value.snapshot.work[0].counters, record.counters);
    assert.deepEqual(read.value.snapshot.reservations, [charge]);
    const writes = rig.writes;
    await runMaintenance(rig, maintenance);
    assert.equal(
      rig.writes,
      writes,
      "ordinary replay cannot rereadmit the same park",
    );
    let green = false;
    const clock = new FakeClock(T0 + 6_000_000);
    const github = new FakeGithub({
      baseSha: BASE,
      issues: [{
        number: 120,
        relations: { subIssueCount: 0, openBlockers: [] },
      }],
      candidateLifecycle: {
        refs: {},
        pullRequests: [],
        prepareBaseRefresh: () => Promise.resolve(portOk(SHA3)),
        preserveCandidate: () => Promise.resolve(portOk(undefined)),
      },
    });
    const readIssue = github.readIssue.bind(github);
    github.readIssue = async (number) => {
      const result = await readIssue(number);
      return result.ok && result.value !== null
        ? portOk({
          ...result.value,
          relations: { subIssueCount: 0, openBlockers: [] },
        })
        : result;
    };
    github.readChecks = (head) =>
      Promise.resolve(portOk({
        head,
        checks: [
          check(
            "ci",
            head,
            head === SHA3 && !green ? null : "success",
            head === SHA3 && !green ? "in_progress" : "completed",
          ),
        ],
      }));
    const model = new FakeModel({
      head: SHA3,
      changedPaths: ["kv-service/src/worker.ts", "scripts/product.ts"],
    });
    const configs = repairConfigs({
      repository: PASSPORT,
      ...selectTrustedTargetPolicyV1(createLocalRepositoryConfig(), PASSPORT),
      sessionBound: { maxDurationMs: 240000, maxOutputChars: 200000 },
    });
    const deps = {
      state: rig.state,
      clock,
      github,
      model,
      configs,
      controllerSha: SHA1,
      budget: new RollingStartBudget({ state: rig.state, clock, configs }),
      githubCooldown: new DurableGitHubCooldownGate({
        state: rig.state,
        clock,
      }),
      incidents: new FakeIncidents({ summaries: [] }),
      replay: new FakeReplay(),
    };
    const run = () =>
      runRepairCycle(deps, { deadline: clock.now() + 3600000, stepLimit: 16 });
    await run();
    assert.equal(model.requests.length, 1);
    assert.equal(
      github.reviewRequestIdentities.length,
      0,
      "pending CI cannot start review",
    );
    assert.equal(github.calls.includes("merge"), false);
    assert.deepEqual(decideCiGate([check("ci", SHA3, "failure")]), {
      blocked: "CI checks failed: ci(failure)",
    });
    read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(
      read.value.snapshot.reservations.find((row) => row.id === charge.id)?.id,
      charge.id,
      "original charge remains",
    );
    assert.equal(
      reviewAuthorizesMerge(null, read.value.snapshot.work[0]),
      false,
      "missing native receipt cannot authorize merge",
    );
    green = true;
    clock.advance(600001);
    await run();
    assert.equal(github.reviewRequestIdentities.length, 1);
    assert.equal(
      github.calls.includes("merge"),
      false,
      "green CI alone never merges",
    );
    github.completeReview([], clock.now());
    clock.advance(100_000_001);
    await run();
    assert.equal(
      model.requests.length,
      1,
      "no duplicate implementation after review",
    );
    assert.equal(
      github.calls.filter((call) => call === "merge").length,
      1,
      "only current reviewed green product candidate merges",
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

import {
  baseRefreshIntentKey,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import { pullFacts } from "./hosted-autonomy-fixtures.ts";
import { SHA2 } from "../state/helpers.ts";

Deno.test("Passport trial: mechanical refresh reentry authenticates ref and current publication before Git CAS", async (t) => {
  for (const control of ["exact", "forged_ref", "stale_head"] as const) {
    await t.step(control, async () => {
      const record = parked(REVIEW_ROUND_CEILING_UNREVIEWED);
      Object.assign(record, {
        counters: { attempts: 1, retries: 0, reviewRounds: 10 },
        createdAt: T0,
        updatedAt: T0,
      });
      record.blocker!.since = T0;
      const operationKey = baseRefreshIntentKey(172, SHA1, SHA2);
      const ref = await candidatePreservationRef(
        PASSPORT,
        record.id,
        operationKey,
      );
      record.target.base = SHA2;
      record.target.candidateState = {
        preserved: {
          operationKey,
          base: SHA2,
          head: HEAD,
          ref: control === "forged_ref"
            ? "refs/heads/sentinel-candidates/" + "f".repeat(64)
            : ref,
        },
        publishedHead: HEAD,
      };
      const charge = reservation("passport-refresh-original", {
        repository: PASSPORT,
        taskId: record.id,
        attempt: 1,
        purpose: "implementation",
        head: BASE,
        outcome: "submitted",
        createdAt: T0,
        settledAt: T0,
      });
      const { rig, github } = await maintenanceRig("passport-ref-proof", {
        repair: repairSnapshot([record], [], [], [charge]),
        issueOpen: true,
        baseTip: SHA2,
        pull: pullFacts({
          number: 172,
          state: "open",
          merged: false,
          headSha: control === "stale_head" ? SHA1 : HEAD,
          baseRef: "main",
          baseSha: SHA2,
          author: "ubiquity-sentinel[bot]",
        }),
      });
      try {
        const before = await rig.state.readRepair();
        assert.ok(before.ok && before.value.status === "found");
        const result = await runMaintenance(rig, github);
        const after = await rig.state.readRepair();
        assert.ok(after.ok && after.value.status === "found");
        if (control === "exact") {
          assert.equal(
            after.value.snapshot.work[0].nextStep,
            "work",
            JSON.stringify(result),
          );
          assert.deepEqual(
            after.value.snapshot.work[0].counters,
            record.counters,
          );
          assert.deepEqual(after.value.snapshot.reservations, [charge]);
        } else {
          assert.equal(rig.writes, 0, JSON.stringify(result));
          assert.deepEqual(after.value.snapshot, before.value.snapshot);
          assert.equal(rig.merges, 0);
        }
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

import { resolvedConflictCandidate } from "../../src/host/matrix-conflict-candidate.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";

Deno.test("Passport trial: high-count conflict recovery keeps exact charge and preservation refusals", async () => {
  const record = parked("unused");
  record.nextStep = "work";
  record.blocker = null;
  const originalKey = implementationIntentKey("a".repeat(64));
  record.target.candidateState = {
    preserved: {
      operationKey: originalKey,
      base: BASE,
      head: HEAD,
      ref: await candidatePreservationRef(PASSPORT, record.id, originalKey),
    },
    publishedHead: HEAD,
  };
  record.intent = {
    kind: "base_refresh",
    key: baseRefreshIntentKey(172, HEAD, SHA2),
    startedAt: T0 + 1000,
    branch: record.target.branch,
    expectedHead: HEAD,
    observedBase: SHA2,
    pr: 172,
    requestId: null,
    resultId: SHA3,
    failure: { ...conflictMarker(SHA2, T0 + 1000), attempts: 20 },
  };
  const charge = reservation("c".repeat(64), {
    repository: PASSPORT,
    taskId: record.id,
    head: BASE,
    attempt: record.counters.attempts,
    purpose: "retry",
    outcome: "submitted",
    createdAt: T0,
    settledAt: T0 + 1,
  });
  assert.ok(await resolvedConflictCandidate(record, [charge]));
  assert.equal(await resolvedConflictCandidate(record, []), null);
  const forged = structuredClone(record);
  forged.target.candidateState!.preserved!.ref =
    "refs/heads/sentinel-candidates/" + "f".repeat(64);
  assert.equal(await resolvedConflictCandidate(forged, [charge]), null);
  const reserved = { ...charge, outcome: "reserved" as const, settledAt: null };
  assert.equal(await resolvedConflictCandidate(record, [reserved]), null);
  const other = structuredClone(record);
  other.repository.name = "ai.ubq.fi";
  other.target.candidateState!.preserved!.ref = await candidatePreservationRef(
    other.repository,
    other.id,
    originalKey,
  );
  assert.equal(
    await resolvedConflictCandidate(other, [{
      ...charge,
      repository: other.repository,
    }]),
    null,
  );
});

Deno.test("Passport trial: settled base-refresh count park requires exact original ref branch and PR", async () => {
  const record = parked(
    "base refresh failed 3 consecutive times: not_found candidate could not be preserved",
  );
  Object.assign(record, {
    counters: { attempts: 8, retries: 3, reviewRounds: 1 },
    createdAt: T0,
    updatedAt: T0,
  });
  record.blocker!.since = T0;
  const key = implementationIntentKey("b".repeat(64));
  record.target.candidateState = {
    preserved: {
      operationKey: key,
      base: BASE,
      head: HEAD,
      ref: await candidatePreservationRef(PASSPORT, record.id, key),
    },
    publishedHead: HEAD,
  };
  const charge = reservation("b".repeat(64), {
    repository: PASSPORT,
    taskId: record.id,
    head: BASE,
    attempt: 8,
    purpose: "retry",
    outcome: "submitted",
    createdAt: T0,
    settledAt: T0,
  });
  const { rig, github } = await maintenanceRig("passport-old-refresh-count", {
    repair: repairSnapshot([record], [], [], [charge]),
    issueOpen: true,
    branchTip: (branch) => branch === record.target.branch ? HEAD : SHA2,
  });
  github.listPullsByHeadRef = () =>
    Promise.resolve([{
      number: 172,
      headRef: record.target.branch!,
      headSha: HEAD,
      baseRef: "main",
      author: "ubiquity-sentinel[bot]",
      state: "open",
      merged: false,
    }]);
  try {
    const result = await runMaintenance(rig, github);
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(
      read.value.snapshot.work[0].nextStep,
      "work",
      JSON.stringify(result),
    );
    assert.deepEqual(read.value.snapshot.work[0].target, record.target);
    assert.deepEqual(read.value.snapshot.work[0].counters, record.counters);
    assert.deepEqual(read.value.snapshot.reservations, [charge]);
    assert.equal(rig.merges, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
