import assert from "node:assert/strict";
import { neverMergedChange } from "../../src/github/merge-content-gate.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { HOSTED_AUTHORITY_PROTECTED_PATHS } from "../../src/host/hosted-authority-protected-paths.ts";
import { touchesProtected } from "../../src/repair/loop-records.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { SHA1, workRecord } from "../state/helpers.ts";
import { positiveLifecycle } from "../repair/loop-candidate-fixtures.ts";
import {
  makeRig as makeRepairRig,
  seededSnapshot,
} from "../repair/loop-rig.ts";
import {
  exited,
  launch,
  makeRig as makeHostedRig,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

/** The owner's 2026-10-30 reduced set: credential, dispatch, merge-gate and promotion. */
const LOCAL_AUTHORITY_PATHS = [
  ".github/workflows/",
  // The unchanged `touchesProtected` predicate itself: a candidate edit could
  // make the whole boundary return false after merge.
  "src/repair/loop-records.ts",
  // This file decides the protected set itself.
  "src/host/local-config.ts",
  // The trusted supervisor's exact-revision promotion boundary: the pointer
  // writer (`compareAndSetLocalActiveRuntime`), the callers that decide
  // promotion and the receipt parser they rely on.
  "src/host/local-release.ts",
  "src/host/local-supervisor-release.ts",
  "src/host/actions-supervisor-installation.ts",
  "src/host/local-supervisor.ts",
  "src/host/actions-supervisor-source.ts",
  "src/host/actions-supervisor-controller.ts",
  "src/host/actions-supervisor-install-api.ts",
  "src/contracts/local-release.ts",
] as const;

const REDUCED_AUTHORITY_PATHS = [
  ...HOSTED_AUTHORITY_PROTECTED_PATHS,
  ...LOCAL_AUTHORITY_PATHS,
] as const;

const FORBIDDEN_CANDIDATES = [
  ...REDUCED_AUTHORITY_PATHS.filter((path) => !path.endsWith("/")),
  ".github/workflows/ci.yml",
  // A concrete file inside each protected directory prefix.
  ".github/actions/sentinel-app-token/action.yml",
  ".github/actions/hosted-runtime-control/action.yml",
  "jobs/inbox/request.json",
  "jobs/cleanup/request.json",
] as const;

/** Sentinel's own repository (the self installation of the repair rig). */
const SELF = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 9,
} as const;

/**
 * Owner directive 2026-11-17 ("give sentinel full access"): a candidate that
 * changes one of Sentinel's own authority files is no longer parked
 * unpublished. It is pushed, CI-gated and reviewed like any candidate and
 * carries the owner-landing flag, so Sentinel never merges it: only the
 * repository owner does. Any `.github/` change of Sentinel's own stays
 * unpublished exactly as before the directive: a pushed workflow would run
 * with Sentinel's own secrets before the owner saw it.
 */
async function assertOwnerLandingCandidate(path: string) {
  const rig = await makeRepairRig("hosted-authority", {
    model: { changedPaths: [path] },
    github: { candidateLifecycle: positiveLifecycle() },
    configOverrides: {
      repository: SELF,
      protectedPaths: createLocalRepositoryConfig().protectedPaths,
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(rig.model.requests.length, 1);
    // One charged implementation run, and nothing more is reserved for it.
    assert.equal(
      state.reservations.filter((row) => row.purpose !== "review_request")
        .length,
      1,
      path,
    );
    assert.equal(state.reservations[0].outcome, "submitted");
    assert.equal(rig.github.calls.includes("merge"), false, path);
    if (path.startsWith(".github/")) {
      assert.equal(state.reservations.length, 1, path);
      assert.equal(state.work[0].nextStep, "blocked", path);
      assert.equal(
        state.work[0].blocker?.message,
        "candidate touches a protected path",
        path,
      );
      assert.equal(state.work[0].ownerLanding, undefined, path);
      assert.equal(rig.github.pushes.length, 0, path);
      assert.equal(rig.github.preservationRequests.length, 0, path);
      assert.equal(rig.github.calls.includes("requestReview"), false, path);
      return;
    }
    assert.equal(state.work[0].blocker, null, path);
    assert.equal(state.work[0].nextStep, "review", path);
    assert.ok(
      (state.work[0].ownerLanding?.paths.length ?? 0) > 0,
      `${path}: ${JSON.stringify(state.work[0].ownerLanding)}`,
    );
    assert.equal(rig.github.pushes.length, 1, path);
  } finally {
    await rig.ctx.cleanup();
  }
}

async function assertPublishedCandidate(path: string) {
  const rig = await makeRepairRig("hosted-authority-allowed", {
    model: { changedPaths: [path] },
    github: { candidateLifecycle: positiveLifecycle() },
    configOverrides: {
      protectedPaths: createLocalRepositoryConfig().protectedPaths,
    },
  });
  try {
    const outcome = await rig.run();
    assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0].blocker, null, path);
    assert.equal(rig.model.requests.length, 1, path);
    assert.ok(state.reservations.length >= 1, path);
    assert.ok(
      state.reservations.every((row) => row.outcome === "submitted"),
      path,
    );
    assert.equal(rig.github.pushes.length, 1, path);
    assert.equal(rig.github.preservationRequests.length, 1, path);
  } finally {
    await rig.ctx.cleanup();
  }
}

Deno.test("hosted authority: the template protects exactly the reduced authority set", () => {
  assert.deepEqual(
    createLocalRepositoryConfig().protectedPaths,
    [...REDUCED_AUTHORITY_PATHS],
  );
});

/** Round-3 native review: predicate, auto-follow, credential/admission and promotion. */
const ROUND3_AUTHORITY_PATHS = [
  "src/repair/loop-records.ts",
  "src/host/hosted-runtime-follow-api.ts",
  "src/host/hosted-runtime-follow-state.ts",
  "src/host/hosted-runtime-follow-main.ts",
  "src/host/actions-repair-host.ts",
  "src/host/actions-supervisor-host.ts",
  "src/host/hosted-app-principal.ts",
  "src/contracts/hosted-supervisor-verification.ts",
  "src/host/local-supervisor.ts",
  "src/host/actions-supervisor-source.ts",
  "src/host/actions-supervisor-controller.ts",
  "src/host/actions-supervisor-install-api.ts",
] as const;

Deno.test("hosted authority: predicate, auto-follow, credential and promotion files publish for the owner, never merged by Sentinel", async (t) => {
  for (const path of ROUND3_AUTHORITY_PATHS) {
    await t.step(path, () => assertOwnerLandingCandidate(path));
  }
});

Deno.test("hosted authority: reduced authority files publish for the owner, never merged by Sentinel", async (t) => {
  // Four independent rigs at a time (each its own temporary repository and
  // state): the whole file stays inside the local validation deadline.
  const CHUNK = 4;
  for (let at = 0; at < FORBIDDEN_CANDIDATES.length; at += CHUNK) {
    const chunk = FORBIDDEN_CANDIDATES.slice(at, at + CHUNK);
    await t.step(chunk.join(", "), async () => {
      await Promise.all(chunk.map((path) => assertOwnerLandingCandidate(path)));
    });
  }
});

Deno.test("hosted authority: the Passport deploy-check selector is protected", () => {
  assert.equal(
    touchesProtected(
      createLocalRepositoryConfig().protectedPaths,
      "src/repair/merge-gate-checks.ts",
    ),
    true,
  );
});

Deno.test("hosted authority: a protected merge-gate dependency edit lands only for the owner", async (t) => {
  // `port-merge.ts` imports `loop-checks.ts`, which imports the protected
  // Passport selector and `ci-rejection.ts`; `port-merge-policy.ts` also
  // imports `ci-rejection.ts`. Editing only a dependency must not weaken the
  // exact-head check verdict.
  for (
    const path of [
      "src/repair/loop-checks.ts",
      "src/repair/ci-rejection.ts",
    ]
  ) {
    await t.step(path, () => assertOwnerLandingCandidate(path));
  }
});

Deno.test("hosted agent-job authority: self code and request changes require the owner", async () => {
  const foreign = { owner: "ubiquity", name: "example", installationId: 9 };
  for (
    const path of [
      "ops/agent-jobs-git.ts",
      "ops/agent-jobs-review.ts",
      "ops/agent-jobs-publish-github.ts",
      "ops/agent-jobs-cleanup.ts",
      "ops/agent-jobs-native-review.ts",
      "src/repair/review-disposition.ts",
      "src/repair/review-feedback.ts",
      "jobs/inbox/request.json",
      "jobs/cleanup/request.json",
      ".github/workflows/agent-jobs-delivery.yml",
    ]
  ) {
    assert.equal(neverMergedChange(SELF, [path]), true, path);
    assert.equal(neverMergedChange(foreign, [path]), false, path);
  }
  for (const path of ["jobs/README.md", "ops/agent-jobs-unrelated.ts"]) {
    assert.equal(neverMergedChange(SELF, [path]), false, path);
  }
  await assertOwnerLandingCandidate("ops/agent-jobs-git.ts");
});

Deno.test("hosted authority: review, queue, retention, notification, base-review and repository policy files are ordinary work", () => {
  const protectedPaths = createLocalRepositoryConfig().protectedPaths;
  for (
    const path of [
      "src/github/codex-reviewer.ts",
      "src/github/review-snapshot.ts",
      "src/repair/loop-review-result.ts",
      "src/repair/review-round-cap.ts",
      "src/github/reviewer-retention.ts",
      "src/repair/model-port-notifications.ts",
      "src/github/base-review-service.ts",
      "src/github/base-review-evidence.ts",
      "ops/hosted-autonomy-queue-policy.ts",
      "ops/hosted-autonomy-delivery-pass.ts",
      "src/host/target-policy.ts",
      "AGENTS.md",
      "MASTER-PLAN.md",
      "docs/build-status.md",
      "sentinel.targets.json",
      "deno.json",
    ]
  ) assert.equal(touchesProtected(protectedPaths, path), false, path);
});

Deno.test("hosted authority: formerly protected files publish again", async (t) => {
  for (
    const path of [
      "src/github/codex-reviewer.ts",
      "src/repair/loop-review-result.ts",
      "src/github/base-review-service.ts",
      "ops/hosted-autonomy-queue-policy.ts",
      "src/host/target-policy.ts",
      "docs/build-status.md",
    ]
  ) {
    await t.step(path, () => assertPublishedCandidate(path));
  }
});

Deno.test("hosted authority: unrelated source and action candidates retain publication", async () => {
  // On a target, from the owner's issue: an ordinary action change is no
  // authority path (its push still needs a trusted source, 2026-11-17).
  const changedPaths = [
    "src/host/ordinary-feature.ts",
    ".github/actions/ordinary-action/main.js",
  ];
  const rig = await makeRepairRig("hosted-authority-control", {
    summaries: false,
    model: { changedPaths },
    github: {
      candidateLifecycle: positiveLifecycle(),
      pushedPaths: changedPaths,
    },
    configOverrides: {
      protectedPaths: createLocalRepositoryConfig().protectedPaths,
    },
  });
  const task = asWorkItemId("issue-41");
  const seeded = await rig.store.writeRepair(
    seededSnapshot([workRecord(task, {
      source: { kind: "issue", id: "41", revision: SHA1 },
      related: { incidentId: null, issueNumber: 41 },
      target: {
        base: SHA1,
        branch: candidateBranch(task),
        checkpoint: null,
        head: null,
        pr: null,
      },
      nextStep: "work",
    })]),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  try {
    await rig.run();
    const state = await rig.snapshot();
    assert.equal(state.work[0].blocker, null);
    assert.equal(rig.model.requests.length, 1);
    assert.equal(state.reservations[0].outcome, "submitted");
    assert.equal(rig.github.preservationRequests.length, 1);
    assert.equal(rig.github.pushes.length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("hosted authority: real launcher emits only closed authority frame basenames", async () => {
  const rig = await makeHostedRig();
  try {
    await seedRelease(rig);
    rig.process.child = exited("", 7, {
      stderr: new TextEncoder().encode([
        "error: Uncaught Error: fixture abort",
        "    at file:///private/runtime/src/host/hosted-unknown-authority.ts:12:6",
        "    at file:///private/runtime/src/host/synthetic-secret-value.ts:13:7",
        "    at file:///private/runtime/src/host/owner-install-future-recovery.ts:14:2",
        "    at file:///private/launcher/src/host/hosted-app-principal-source.ts:9:3",
        "    at file:///private/runtime/src/host/hosted-self-dependencies.ts:10:4",
        "    at file:///private/runtime/ops/hosted-autonomy-queue-proof.ts:11:5",
        "    at file:///private/runtime/src/host/hosted-app-takeover-routing.ts:9:3",
        "    at file:///private/runtime/src/host/actions-queue-custody.ts:10:4",
        "    at file:///private/runtime/src/host/maintenance-existing-pr-publication.ts:11:5",
      ].join("\n")),
    });
    const result = await launch(rig);
    assert.equal(result.status, "failed");
    assert.equal(result.terminal?.outcome, "failed");
    assert.deepEqual(result.earlyFailure?.frames, [
      "owner-install-future-recovery.ts:14:2",
      "hosted-app-principal-source.ts:9:3",
      "hosted-self-dependencies.ts:10:4",
      "hosted-autonomy-queue-proof.ts:11:5",
      "hosted-app-takeover-routing.ts:9:3",
      "actions-queue-custody.ts:10:4",
    ]);
    const serialized = JSON.stringify(result);
    for (
      const forbidden of [
        "/private/",
        "hosted-unknown-authority",
        "synthetic-secret-value",
      ]
    ) assert.equal(serialized.includes(forbidden), false);
  } finally {
    await rig.cleanup();
  }
});
