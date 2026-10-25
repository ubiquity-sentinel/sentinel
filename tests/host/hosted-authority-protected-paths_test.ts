import assert from "node:assert/strict";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { touchesProtected } from "../../src/repair/loop-records.ts";
import { positiveLifecycle } from "../repair/loop-candidate-fixtures.ts";
import { makeRig as makeRepairRig } from "../repair/loop-rig.ts";
import {
  exited,
  launch,
  makeRig as makeHostedRig,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

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

Deno.test("hosted authority: actual repair keeps forbidden candidates charged and unpublished", async (t) => {
  for (
    const path of [
      ".github/actions/sentinel-app-token/lib/mint-grant.js",
      "src/host/hosted-app-source-profiles.json",
      "src/host/hosted-app-takeover-routing.ts",
      "src/host/actions-queue-custody.ts",
      "src/host/maintenance-existing-pr-publication.ts",
      "src/host/hosted-runtime-bootstrap.ts",
      "src/host/owner-install-plan-proof.ts",
      "src/host/owner-install-future-recovery.ts",
      "src/host/self-dependency-preparation.ts",
      "src/github/existing-pr-publication-proof.ts",
      "src/host/hosted-authority-protected-paths.ts",
      "src/contracts/hosted-supervisor-installation.ts",
      "src/contracts/hosted-supervisor-verification.ts",
      "src/host/actions-supervisor-install-api.ts",
      "src/host/actions-supervisor-installation-state.ts",
      "src/host/actions-supervisor-installation.ts",
      "src/host/actions-supervisor-ordinary.ts",
      "src/host/hosted-runtime-follow-api.ts",
      "src/host/hosted-runtime-follow-ci.ts",
      "src/host/hosted-runtime-follow-dispatch.ts",
      "src/host/hosted-runtime-follow-main.ts",
      "src/host/hosted-runtime-follow-state.ts",
      "src/host/hosted-runtime-follow.ts",
      "src/host/hosted-runtime-rollback-state.ts",
      "src/host/hosted-runtime-rollback.ts",
      ".github/actions/hosted-runtime-control/action.yml",
      "ops/hosted-autonomy-original-candidate.ts",
      "ops/hosted-autonomy-original-candidate-pass.ts",
    ]
  ) {
    await t.step(path, () => assertForbiddenCandidate(path));
  }
});

for (
  const path of [
    "ops/hosted-autonomy-runner.ts",
    "ops/hosted-autonomy-maintenance.ts",
    "ops/hosted-autonomy-state.ts",
    "ops/hosted-autonomy-queue-booking.ts",
    // The base-repair lane: the runtime half turns a base-repair task's red
    // base into its own charged CI fix (the CI-first gate), and the launcher
    // pass files its issue over the App token.
    "src/repair/base-repair.ts",
    "ops/hosted-autonomy-base-repair.ts",
  ]
) {
  Deno.test(`hosted authority: maintenance refuses ${path}`, () =>
    assertForbiddenCandidate(path));
}

Deno.test("hosted authority: native review authority inventory is protected", () => {
  const protectedPaths = createLocalRepositoryConfig().protectedPaths;
  for (
    const path of [
      "src/github/codex-reviewer.ts",
      "src/github/reviewer-prepared.ts",
      "src/github/reviewer-events.ts",
      "src/github/reviewer-outcome.ts",
      "src/github/reviewer-session-state.ts",
      "src/github/journal-metadata.ts",
      "src/github/review-transport-journal.ts",
      "src/github/codex-review-transport.ts",
      "src/github/review-normalize.ts",
    ]
  ) assert.equal(touchesProtected(protectedPaths, path), true, path);
});

Deno.test("hosted authority: token-bearing entrypoints and merge-authority modules are protected", () => {
  const protectedPaths = createLocalRepositoryConfig().protectedPaths;
  for (
    const path of [
      "src/host/supervisor-dispatch.ts",
      "src/host/actions-premerge-ci.ts",
      "src/github/port-merge.ts",
      "src/github/port-evidence.ts",
      "src/github/port-merge-policy.ts",
      "ops/hosted-autonomy-queue-policy.ts",
      "ops/hosted-autonomy-queue-reconcile.ts",
      "ops/hosted-autonomy-queue-pass.ts",
      "ops/hosted-autonomy-queue-writer.ts",
      "ops/hosted-autonomy-queue-intent.ts",
      "src/github/client-queue-delivery.ts",
      "src/github/native-queue-guard.ts",
      "src/github/review-snapshot.ts",
      "src/github/git-executor.ts",
      "src/repair/keys.ts",
      "src/host/hosted-app-credentials.ts",
      "src/host/actions-target-bindings.ts",
      "src/host/target-policy.ts",
      "src/github/codex-review-rubric.ts",
      "ops/hosted-autonomy-scopes.ts",
      "src/repair/review-gate.ts",
      "src/repair/transitions.ts",
      "src/repair/vps-delivery.ts",
      "src/repair/carried-release.ts",
      "ops/hosted-autonomy-carried-release.ts",
    ]
  ) assert.equal(touchesProtected(protectedPaths, path), true, path);
});

Deno.test("hosted authority: native review refuses src/github/codex-reviewer.ts", () =>
  assertForbiddenCandidate("src/github/codex-reviewer.ts"));

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
