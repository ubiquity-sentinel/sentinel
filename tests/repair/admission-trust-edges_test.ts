/**
 * Edges of issue admission and provenance trust (2026-11-18 review fixes):
 * - a `.github/` path in any letter case is CI-executable (fail closed);
 * - the missing-acceptance review recovery parks an issue Sentinel does not
 *   work, uncharged, instead of deferring a read every cycle;
 * - a source number GitHub answers with another issue (a transfer) is
 *   untrusted, so a workflow change parks instead of deferring for ever.
 */
import assert from "node:assert/strict";
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-task-acceptance.ts";
import { pushGuardRefusal } from "../../src/github/push-content-guard.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { AUTHOR_NOT_ADMITTED_PARK } from "../../src/repair/issue-admission.ts";
import { reviewOperationKey, reviewReceiptId } from "../../src/repair/keys.ts";
import { recoverMissingTaskReview } from "../../src/repair/loop-review-result.ts";
import { TASK_ACCEPTANCE_UNCERTAIN_DETAIL } from "../../src/repair/review-gate.ts";
import {
  ciExecutablePath,
  recordCiTrust,
} from "../../src/repair/workflow-trust.ts";
import { reservation, SHA1, SHA3, T0 } from "../state/helpers.ts";
import {
  BASE,
  deliveryRecord,
  HEAD,
} from "../host/hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "../host/hosted-autonomy-rig.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";

const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 155687488,
};

Deno.test("CI-executable path: any letter case of .github is CI-executable, and the push guard refuses it untrusted", async () => {
  for (
    const path of [
      ".GitHub/workflows/x.yml",
      ".GITHUB/actions/a/action.yml",
      "./.Github/workflows/ci.yml",
      ".github",
    ]
  ) {
    assert.equal(ciExecutablePath(path), true, path);
    const refused = await pushGuardRefusal(
      () => Promise.resolve(portOk([path])),
      {
        base: SHA1,
        ownRepository: false,
        trust: () => Promise.resolve("untrusted"),
      },
      SHA3,
    );
    assert.notEqual(refused, null, path);
  }
  assert.equal(ciExecutablePath("src/github/x.ts"), false);
  assert.equal(ciExecutablePath("docs/.github.md"), false);
});

Deno.test("provenance trust: a source number GitHub answers with another issue (a transfer) is untrusted", async () => {
  const github = {
    readIssue: (number: number) =>
      Promise.resolve(portOk({
        number: number + 1000,
        title: "moved",
        body: "",
        state: "open",
        author: "0x4007",
        authorId: 4975670,
      })),
  };
  assert.equal(
    await recordCiTrust(
      { github: github as never },
      {
        repository: PASSPORT,
        related: { incidentId: null, issueNumber: 5 },
      },
    ),
    "untrusted",
  );
});

Deno.test("issue admission: missing-acceptance review recovery parks a not-admitted issue uncharged", async () => {
  const record = deliveryRecord({
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
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    nextStep: "review",
    blocker: null,
    intent: null,
    wait: null,
  });
  const key = reviewOperationKey(172, HEAD, 1);
  const receipt = completedReceipt(172, HEAD, BASE, {
    repository: PASSPORT,
    id: await reviewReceiptId(key, HEAD),
    taskAcceptance: {
      issueNumber: 120,
      taskDigest: await reviewTaskStatementDigest({
        issueNumber: 120,
        title: "issue 120",
        body: "",
      }),
      verdict: "uncertain" as const,
      evidence: ["Original uncertain review"],
    },
  });
  const snapshot = repairSnapshot([record], [structuredClone(receipt)], [], [
    reservation("c".repeat(64), {
      repository: PASSPORT,
      taskId: record.id,
      head: BASE,
      attempt: 1,
      purpose: "implementation",
      outcome: "submitted",
      createdAt: T0,
      settledAt: T0,
    }),
  ]);
  const state = new MemoryState();
  state.repair = snapshot;
  state.repairHead = SHA1;
  const clock = new FakeClock(T0 + 10000);
  const github = new FakeGithub({ baseSha: BASE });
  const readIssue = github.readIssue.bind(github);
  github.readIssue = async (number) => {
    const result = await readIssue(number);
    return result.ok && result.value
      ? portOk({
        ...result.value,
        author: "someone-else",
        authorId: 99,
        relations: { subIssueCount: 0, openBlockers: [] },
      })
      : result;
  };
  github.unboundReviewKeys.add(reviewOperationKey(172, HEAD, 2));
  const configs = repairConfigs({
    repository: PASSPORT,
    adapter: { kind: "github" },
    sessionBound: { maxDurationMs: 240000, maxOutputChars: 200000 },
  });
  const model = new FakeModel();
  const deps = {
    ciMinutes: INACTIVE_CI_MINUTES,
    state,
    clock,
    github,
    configs,
    model,
    controllerSha: SHA1,
    budget: new RollingStartBudget({ state, clock, configs }),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
  };
  const context = {
    snapshot,
    head: SHA1,
    executionBaseline: null,
    legacyReviewCutoff: null,
    bounds: {
      runDeadline: clock.now() + 3600000,
      modelCutoff: clock.now() + 3600000,
    },
  };
  assert.equal(record.blocker, null);
  assert.ok(TASK_ACCEPTANCE_UNCERTAIN_DETAIL.length > 0);
  const result = await recoverMissingTaskReview(
    deps,
    context,
    record,
    receipt,
    key,
  );
  assert.notEqual(result?.kind, "deferred", JSON.stringify(result));
  const parked = state.repair.work.find((row) => row.id === record.id)!;
  assert.equal(parked.nextStep, "blocked");
  assert.equal(parked.blocker?.message, AUTHOR_NOT_ADMITTED_PARK);
  assert.equal(
    state.repair.reservations.length,
    snapshot.reservations.length,
    "uncharged",
  );
  assert.equal(github.reviewRequestIdentities.length, 0);
  assert.equal(model.requests.length, 0);
});

Deno.test("authority: the modules that define admission, trust and the CI rule are owner-merged; their large callers stay ordinary", async () => {
  const { createLocalRepositoryConfig } = await import(
    "../../src/host/local-config.ts"
  );
  const { touchesProtected } = await import("../../src/repair/loop-records.ts");
  const protectedPaths = createLocalRepositoryConfig().protectedPaths;
  for (
    const path of [
      "src/repair/trust-markers.ts",
      "src/repair/issue-admission.ts",
      "src/repair/workflow-trust.ts",
      "src/github/wire-issue-author.ts",
      "src/repair/ci-success-rule.ts",
      "src/github/merged-pull-heads.ts",
      "src/github/changed-paths-read.ts",
      "src/github/merge-content-gate.ts",
      "src/github/port-merge.ts",
    ]
  ) assert.equal(touchesProtected(protectedPaths, path), true, path);
  for (
    const path of [
      "src/repair/target-capability.ts",
      "src/github/client-reads.ts",
      "src/github/client-checks.ts",
      "src/github/client-issues.ts",
      "src/github/port-base.ts",
      "src/repair/loop-intake.ts",
      "src/repair/loop-merge.ts",
      "ops/hosted-autonomy-github.ts",
    ]
  ) assert.equal(touchesProtected(protectedPaths, path), false, path);
});
