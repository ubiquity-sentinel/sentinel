import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { composeLocalGitHub } from "../../src/host/local-github.ts";
import { LocalSessionTracker } from "../../src/host/local-client.ts";
import { runOwnerSuccessorReviewPhase } from "../../src/host/owner-successor-acceptance.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import {
  clock,
  installedSupersession,
  runHostedSupervisorPrepare,
  settle,
  supervisor,
} from "./owner-install-supersession-fixtures.ts";
import { nativeOwnerReviewPorts } from "./owner-install-supersession-native-fixtures.ts";
import type { OwnerSuccessorReviewPorts } from "../../src/host/owner-successor-acceptance.ts";
import { driveOwnerTaskAcceptance } from "./owner-install-supersession-acceptance-fixtures.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedRuntimeRollout } from "../../src/host/hosted-runtime-rollout.ts";
import { ownerInstall } from "./owner-install-supersession-fixtures.ts";

Deno.test("owner successor genuine structured review produces charged durable acceptance and delivers original task once", async () => {
  const rig = await installedSupersession();
  try {
    await driveOwnerTaskAcceptance(rig);
  } finally {
    await rig.close();
  }
});

// The deferred owner-acceptance hold was retired on 2026-10-20: prepare no longer
// parks on owner successor acceptance (bounded verification and launcher
// self-install replaced the supersession ceremony), so the "deferred acceptance
// preserves native proof" case asserted a scheduling hold that no longer exists.

Deno.test("owner healthy correction retains failed task review and completes through its exact new capable binding", async () => {
  const rig = await installedSupersession();
  try {
    const failed = await driveOwnerTaskAcceptance(rig, { reviewFailure: true });
    assert.equal(failed.journal.phase, "failed");
    const oldJournal = canonicalStringify(failed.journal),
      before = await rig.current();
    const i = failed.receipt.ownerDisposition!.intent;
    await rig.source.write(
      rig.source.runtime,
      "runtime.ts",
      "// Corrected healthy successor after genuine task review refusal\n",
    );
    await rig.source.git(rig.source.runtime, ["add", "."]);
    await rig.source.git(rig.source.runtime, [
      "commit",
      "-qm",
      "freeze corrected task successor",
    ]);
    const f2 = await rig.source.git(rig.source.runtime, [
      "rev-parse",
      "HEAD",
    ]) as GitSha;
    const rung = {
      fromRevision: i.toRevision,
      fromGeneration: i.toGeneration,
      toRevision: f2,
      toGeneration: i.toGeneration + 1,
      rollbackToPrior: true,
    };
    const floors = {
      queue: { ...rig.queue, revisions: [...rig.queue.revisions, f2] },
      custody: { ...rig.custody, revisions: [...rig.custody.revisions, f2] },
    };
    await rig.publishRollout(
      parseHostedRuntimeRollout({
        ...rig.rollout,
        installs: [...rig.rollout.installs, rung],
      }),
      floors.queue,
      floors.custody,
    );
    rig.nextRun();
    const patches = rig.patches();
    await ownerInstall(rig);
    assert.equal(
      rig.patches(),
      patches,
      "healthy pointer movement cannot lose its pending task binding",
    );
    const binding = {
      releaseId: failed.receipt.id,
      requestSha256: i.requestSha256,
      intentSha256: failed.receipt.ownerDisposition!.intentSha256,
      successorRevision: f2,
      successorGeneration: i.toGeneration + 1,
      taskSha256: i.taskSha256,
      issueNumber: i.issueNumber,
      workId: i.workId,
      acceptanceBaseRevision: i.toRevision,
      controllerSourceRevision: i.controllerSourceRevision,
      controllerCodeSha256: i.controllerCodeSha256,
      ciRevision: f2,
    };
    await rig.publishRollout(
      parseHostedRuntimeRollout({
        ...rig.rollout,
        ownerSuccessorTaskBindings: [binding],
      }),
    );
    rig.nextRun();
    await ownerInstall(rig);
    assert.equal(rig.patches(), patches + 1);
    const moved = await rig.current();
    assert.equal(moved.snapshot.hostedRuntimes[0].activeRevision, f2);
    assert.equal(
      moved.snapshot.hostedReleases[0].ownerSuccessorBindings?.[0].movement,
      "install",
    );
    assert.equal(
      moved.snapshot.hostedReleases[0].ownerSuccessorBindings?.[0].movementProof
        .outcome,
      "healthy",
    );
    assert.deepEqual(
      moved.snapshot.hostedReleases[0].ownerDisposition,
      before.snapshot.hostedReleases[0].ownerDisposition,
    );
    await driveOwnerTaskAcceptance(rig);
    const repair = await rig.repair.readRepair();
    assert.ok(repair.ok && repair.value.status === "found");
    assert.equal(repair.value.snapshot.ownerSuccessorReviews?.length, 2);
    assert.equal(
      canonicalStringify(
        repair.value.snapshot.ownerSuccessorReviews!.find((r) =>
          r.id === failed.journal.id
        ),
      ),
      oldJournal,
    );
    assert.equal(repair.value.snapshot.work[0].nextStep, "done");
    assert.equal(
      repair.value.snapshot.reservations.filter((r) =>
        r.purpose === "review_request" && r.outcome === "submitted"
      ).length,
      2,
    );
  } finally {
    await rig.close();
  }
});

Deno.test("owner successor phase leaves native reviewer uncomposed without an exact pending binding", async () => {
  const clock = new FakeClock(1000), state = new MemoryState();
  state.repair = seededSnapshot([]);
  state.setRelease(parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: clock.now(),
    releases: [],
    hostedReleases: [],
    hostedRuntimes: [],
    githubCooldowns: [],
  }));
  const configs = [createLocalRepositoryConfig()];
  const nativeOwner = {
    id: "7:2:repair",
    runId: 7,
    runAttempt: 2,
    launcherSha: "a".repeat(40) as GitSha,
    revision: "b".repeat(40) as GitSha,
    generation: 74,
    purpose: "ordinary" as const,
    releaseId: null,
    createdAt: clock.now(),
  };
  let prepared = 0, composed = 0;
  assert.equal(
    await runOwnerSuccessorReviewPhase(
      {
        clock,
        state,
        budget: new RollingStartBudget({ state, clock, configs }),
        nativeOwner,
        latestStartAt: clock.now() + 60_000,
        settleBy: clock.now() + 120_000,
      },
      configs,
      () => {
        prepared++;
        return Promise.resolve();
      },
      () => {
        composed++;
        return composeLocalGitHub({
          clock,
          state,
          gate: {
            beforeRequest: () => Promise.resolve(portOk(undefined)),
            recordRateLimit: () => Promise.resolve(portOk(undefined)),
          },
          http: () => Promise.reject(new Error("no external API expected")),
          token: "offline-test-token",
          login: "ubiquity-sentinel[bot]",
          invocationId: nativeOwner.id,
          ownerExecution: nativeOwner,
          stateRoot: "/unopened/state",
          sourcePath: "/unopened/source",
          scratch: "/unopened/scratch",
          reviewCheckout: "/unopened/review",
          reviewClientHome: "/unopened/client",
          reviewTmpDir: "/unopened/tmp",
          reviewDenoDir: "/unopened/deno",
          trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          codexExecutable: "/usr/bin/false",
          tracker: new LocalSessionTracker(),
        });
      },
      () => {
        throw new Error("no owner successor review ports expected");
      },
      true,
    ),
    false,
  );
  assert.equal(prepared, 0);
  assert.equal(composed, 0);
  assert.equal(state.repairWrites, 0);
});

Deno.test("owner successor phase keeps required custody fail closed and lazily completes the exact native review once", async () => {
  const rig = await installedSupersession();
  let native: Awaited<ReturnType<typeof nativeOwnerReviewPorts>> | undefined;
  try {
    await settle(rig, "healthy");
    rig.nextRun();
    const prepared = await runHostedSupervisorPrepare(supervisor(rig));
    assert.ok(
      prepared.status === "run" && prepared.execution.purpose === "ordinary",
    );
    const configs = [createLocalRepositoryConfig()];
    const input = {
      clock,
      state: rig.repair,
      budget: new RollingStartBudget({ state: rig.repair, clock, configs }),
      nativeOwner: prepared.execution,
      latestStartAt: clock.now() + 60_000,
      settleBy: clock.now() + 120_000,
    };
    let preparations = 0, compositions = 0;
    let ports: OwnerSuccessorReviewPorts | undefined;
    const phase = () =>
      runOwnerSuccessorReviewPhase(
        input,
        configs,
        () => {
          preparations++;
          return Promise.resolve();
        },
        () => {
          compositions++;
        },
        () => ports,
        true,
      );
    const before = await rig.repair.readRepair();
    assert.equal(
      await phase(),
      true,
      "an exact pending review holds unrelated work without custody",
    );
    assert.equal(preparations, 1);
    assert.equal(compositions, 1);
    assert.deepEqual(
      await rig.repair.readRepair(),
      before,
      "missing custody cannot reserve or start a review",
    );
    assert.equal(
      await runOwnerSuccessorReviewPhase(
        input,
        configs,
        async () => {
          preparations++;
          native = await nativeOwnerReviewPorts(rig, prepared.execution);
        },
        () => {
          compositions++;
          ports = native!.ports;
        },
        () => ports,
        true,
      ),
      true,
    );
    assert.equal(preparations, 2);
    assert.equal(compositions, 2);
    assert.ok(native);
    assert.deepEqual(native.events, ["registered", "armed", "settled"]);
    assert.equal(native.session.turnStarts(), 1);
    assert.equal(native.session.closed, 1);
    const completed = await rig.repair.readRepair();
    assert.ok(completed.ok && completed.value.status === "found");
    const journal = completed.value.snapshot.ownerSuccessorReviews!.find((r) =>
      r.binding.nativeOwner.id === prepared.execution.id
    )!;
    assert.equal(journal.phase, "completed");
    assert.equal(journal.nativeCustody, "settled");
    assert.equal(journal.reservation.outcome, "submitted");
    assert.equal(await phase(), true, "the completed review remains handled");
    assert.equal(preparations, 2, "completed review never prepares again");
    assert.equal(compositions, 2, "completed review never composes again");
    assert.equal(native.session.turnStarts(), 1);
    assert.deepEqual(await rig.repair.readRepair(), completed);
  } finally {
    await native?.dispose();
    await rig.close();
  }
});
