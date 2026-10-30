import assert from "node:assert/strict";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { HOSTED_AUTHORITY_PROTECTED_PATHS } from "../../src/host/hosted-authority-protected-paths.ts";
import { touchesProtected } from "../../src/repair/loop-records.ts";
import { positiveLifecycle } from "../repair/loop-candidate-fixtures.ts";
import { makeRig as makeRepairRig } from "../repair/loop-rig.ts";
import {
  exited,
  launch,
  makeRig as makeHostedRig,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

/** The owner's 2026-10-30 reduced set: credential, dispatch, merge and promotion. */
const REDUCED_AUTHORITY_PATHS = [
  ...HOSTED_AUTHORITY_PROTECTED_PATHS,
  ".github/workflows/",
  "src/host/local-config.ts",
  // The trusted supervisor's exact-revision release/promotion pointer writer
  // (`compareAndSetLocalActiveRuntime`).
  "src/host/local-release.ts",
] as const;

const FORBIDDEN_CANDIDATES = [
  ...HOSTED_AUTHORITY_PROTECTED_PATHS,
  ".github/workflows/ci.yml",
  "src/host/local-config.ts",
  "src/host/local-release.ts",
] as const;

async function assertForbiddenCandidate(path: string) {
  const rig = await makeRepairRig("hosted-authority", {
    model: { changedPaths: [path] },
    github: { candidateLifecycle: positiveLifecycle() },
    configOverrides: {
      protectedPaths: createLocalRepositoryConfig().protectedPaths,
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "blocked");
    assert.equal(
      state.work[0].blocker?.message,
      "candidate touches a protected path",
    );
    assert.equal(rig.model.requests.length, 1);
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].outcome, "submitted");
    assert.equal(rig.github.pushes.length, 0);
    assert.equal(rig.github.preservationRequests.length, 0);
    assert.equal(rig.github.calls.includes("requestReview"), false);
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

Deno.test("hosted authority: reduced authority files stay forbidden and unpublished", async (t) => {
  for (const path of FORBIDDEN_CANDIDATES) {
    await t.step(path, () => assertForbiddenCandidate(path));
  }
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
  const rig = await makeRepairRig("hosted-authority-control", {
    model: {
      changedPaths: [
        "src/host/ordinary-feature.ts",
        ".github/actions/ordinary-action/main.js",
      ],
    },
    github: { candidateLifecycle: positiveLifecycle() },
    configOverrides: {
      protectedPaths: createLocalRepositoryConfig().protectedPaths,
    },
  });
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
