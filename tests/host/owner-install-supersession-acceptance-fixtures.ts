import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { produceOwnerSuccessorAcceptance } from "../../src/host/owner-successor-acceptance.ts";
import { ownerSuccessorAcceptanceBinds } from "../../src/host/owner-successor-acceptance-proof.ts";
import type { OwnerSuccessorReviewPorts } from "../../src/host/owner-successor-acceptance.ts";
import { readHostedReleaseReceipt } from "../../src/host/actions-release.ts";
import { observeHostedReleaseAcceptance } from "../../src/repair/loop-release.ts";
import { runRepairCycle } from "../../src/repair/loop-cycle.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import {
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
} from "../repair/helpers.ts";
import {
  clock,
  ownerInstall,
  runHostedSupervisorPrepare,
  settle,
  type SupersessionRig,
  supervisor,
  task,
} from "./owner-install-supersession-fixtures.ts";
import { nativeOwnerReviewPorts } from "./owner-install-supersession-native-fixtures.ts";
import { readHostedMaintenanceCompatibility } from "../../ops/hosted-autonomy-runtime-compatibility.ts";
import { nativeWriterFixture } from "./existing-pr-runtime-fixtures.ts";
import { runHostedSupervisorFinalize } from "../../src/host/actions-supervisor-controller.ts";

export async function driveOwnerTaskAcceptance(
  rig: SupersessionRig,
  options: { reviewFailure?: boolean; deferredAcceptance?: boolean } = {},
) {
  const configs = [createLocalRepositoryConfig()];
  const budget = new RollingStartBudget({ state: rig.repair, clock, configs });
  const github = new FakeGithub({
    issues: [{
      number: 170,
      title: task.title,
      body: task.body,
      state: "closed",
      author: null,
      labels: [],
      createdAt: 1,
      updatedAt: 1,
      closedAt: 1,
    }],
  });
  const state = Object.assign(rig.repair, {
    readHostedRelease: (
      request: Parameters<typeof readHostedReleaseReceipt>[1],
    ) => readHostedReleaseReceipt({ state: rig.state }, request),
  });
  const deps: RepairCycleDepsV1 = {
    state,
    clock,
    configs,
    budget,
    github,
    controllerSha: rig.successor,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: new FakeModel(),
  };
  const observe = async () => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const work = read.value.snapshot.work[0],
      request = read.value.snapshot.releaseRequests[0];
    const context: LoopContextV1 = {
      snapshot: read.value.snapshot,
      head: read.value.head,
      bounds: {
        runDeadline: Date.now() + 3_600_000,
        modelCutoff: Date.now() + 3_000_000,
      },
      executionBaseline: null,
    };
    return observeHostedReleaseAcceptance(
      deps,
      context,
      work,
      request,
      Date.now(),
    );
  };
  const bootstrap = (await rig.current()).snapshot.hostedRuntimes[0].execution;
  assert.ok(bootstrap?.purpose === "bootstrap");
  const disabledPorts = new Proxy({} as OwnerSuccessorReviewPorts, {
    get() {
      throw new Error("bootstrap cannot construct any review port");
    },
  });
  assert.equal(
    await produceOwnerSuccessorAcceptance({
      state,
      clock,
      budget,
      ports: disabledPorts,
      nativeOwner: bootstrap,
      latestStartAt: Date.now() + 60_000,
      settleBy: Date.now() + 120_000,
      modelStartsEnabled: false,
    }),
    "none",
  );
  await observe();
  let repair = await state.readRepair();
  assert.ok(repair.ok && repair.value.status === "found");
  assert.equal(repair.value.snapshot.work[0].nextStep, "delivery");
  assert.equal(
    repair.value.snapshot.ownerSuccessorReviews?.some((r) =>
      r.binding.successorRevision === bootstrap.revision &&
      r.binding.successorGeneration === bootstrap.generation
    ) ?? false,
    false,
  );
  const frozenData = JSON.parse(
    await rig.source.git(rig.source.runtime, [
      "show",
      `${bootstrap.revision}:src/host/hosted-runtime-rollout.json`,
    ]),
  );
  assert.deepEqual(
    frozenData.ownerSupersessions,
    [],
    "installed F was frozen before LF authority data",
  );
  await settle(rig, "healthy");
  assert.equal(
    (await rig.current()).snapshot.hostedReleases[0].ownerAcceptance,
    undefined,
  );
  rig.nextRun();
  const writers = nativeWriterFixture(rig.run, "maintenance");
  const maintenance = await readHostedMaintenanceCompatibility(
    {
      state: rig.state,
      clock,
      rollout: rig.rollout,
      readQueueReady: () => Promise.resolve(true),
      native: {
        token: "offline-native-token",
        run: rig.run,
        deadline: Date.now() + 120_000,
        read: writers.read,
      },
    },
    rig.queue,
    rig.custody,
  );
  assert.equal(
    maintenance.status,
    "ordinary",
    "actual maintenance admits ordinary owner review only after genuine own health",
  );
  const prepared = await runHostedSupervisorPrepare(supervisor(rig));
  assert.ok(
    prepared.status === "run" && prepared.execution.purpose === "ordinary",
    JSON.stringify(prepared),
  );
  const native = await nativeOwnerReviewPorts(
    rig,
    prepared.execution,
    options.reviewFailure,
  );
  const { ports, session } = native;
  try {
    const writes: unknown[] = [];
    const observedState = new Proxy(state, {
      get(target, key, receiver) {
        if (key === "writeRepair") {
          return async (...args: Parameters<typeof state.writeRepair>) => {
            const result = await target.writeRepair(...args);
            writes.push(result);
            return result;
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const input = {
      state: observedState,
      clock,
      budget,
      ports,
      nativeOwner: prepared.execution,
      latestStartAt: Date.now() + 60_000,
      settleBy: Date.now() + 120_000,
      modelStartsEnabled: true,
    };
    const beforeReview = await state.readRepair();
    const result = await produceOwnerSuccessorAcceptance(input);
    assert.equal(
      result,
      options.reviewFailure ? "failed" : "completed",
      JSON.stringify({
        events: native.events,
        writes,
        repair: await state.readRepair(),
      }),
    );
    assert.equal(session.turnStarts(), 1);
    assert.equal(session.closed, 1);
    assert.deepEqual(native.events, ["registered", "armed", "settled"]);
    native.assertSchema();
    const produced = await state.readRepair();
    assert.ok(produced.ok && produced.value.status === "found");
    const journal = produced.value.snapshot.ownerSuccessorReviews!.find((r) =>
      r.binding.nativeOwner.id === prepared.execution.id
    )!;
    assert.equal(journal.phase, options.reviewFailure ? "failed" : "completed");
    assert.equal(
      journal.readyExecution?.actual.observedTerminalStatus,
      "completed",
    );
    assert.equal(journal.reservation.outcome, "submitted");
    assert.equal(journal.binding.successorRevision, bootstrap.revision);
    assert.equal(journal.binding.snapshot.head, bootstrap.revision);
    assert.equal(journal.result?.taskAcceptance?.taskDigest, task.digest);
    assert.equal(
      await produceOwnerSuccessorAcceptance(input),
      options.reviewFailure ? "failed" : "completed",
    );
    assert.equal(session.turnStarts(), 1);
    assert.deepEqual(await state.readRepair(), produced);
    assert.equal(
      (await rig.current()).snapshot.hostedReleases[0].ownerAcceptance,
      undefined,
      "review runtime has no release writer",
    );
    await native.assertRefusals();
    await native.dispose();
    await settle(rig, "healthy");
    rig.nextRun();
    if (options.reviewFailure) {
      const before = await rig.current(), patches = rig.patches();
      await ownerInstall(rig);
      assert.equal(rig.patches(), patches);
      assert.deepEqual(await rig.current(), before);
      assert.equal(
        before.snapshot.hostedReleases[0].ownerAcceptance,
        undefined,
      );
      return {
        journal,
        receipt: before.snapshot.hostedReleases[0],
        session,
        state,
        deps,
      };
    }
    const patchCount = rig.patches();
    if (options.deferredAcceptance) {
      const settled = await rig.current(), charged = await state.readRepair();
      assert.deepEqual(
        settled.snapshot.hostedRuntimes[0].lastExecutionProof?.execution,
        journal.binding.nativeOwner,
      );
      const fetch = globalThis.fetch;
      let deferred = 0;
      globalThis.fetch = (request, init) => {
        const url = new URL(
          request instanceof Request ? request.url : String(request),
        );
        if (
          init?.method === "PATCH" &&
          url.pathname.endsWith("/git/refs/heads/sentinel-state/release")
        ) {
          deferred++;
          return Promise.resolve(new Response("{}", { status: 409 }));
        }
        return fetch(request, init);
      };
      try {
        assert.equal(await ownerInstall(rig), 0);
        assert.equal(
          deferred,
          1,
          "actual App acceptance CAS was attempted but not applied",
        );
        assert.equal(rig.patches(), patchCount);
        assert.deepEqual(await rig.current(), settled);
        const next = supervisor(rig);
        assert.equal(
          (await runHostedSupervisorPrepare(next)).status,
          "pending",
          "deferred acceptance must preserve the completed review's exact native owner proof",
        );
        assert.equal(
          (await runHostedSupervisorFinalize(next)).status,
          "pending",
          "finalize has no newly admitted execution to settle",
        );
        assert.deepEqual(await rig.current(), settled);
        assert.deepEqual(await state.readRepair(), charged);
        assert.equal(
          charged.ok && charged.value.status === "found" &&
            charged.value.snapshot.work[0].nextStep,
          "delivery",
        );
        assert.equal(session.turnStarts(), 1);
      } finally {
        globalThis.fetch = fetch;
      }
      rig.nextRun();
    }
    assert.equal(await ownerInstall(rig), 0);
    assert.equal(rig.patches(), patchCount + 1);
    const accepted = await rig.current();
    const receipt = accepted.snapshot.hostedReleases[0];
    assert.equal(receipt.phase, "owner_superseded");
    assert.ok(await ownerSuccessorAcceptanceBinds(receipt));
    assert.equal(
      receipt.ownerAcceptance?.review.binding.successorRevision,
      bootstrap.revision,
    );
    assert.deepEqual(receipt.ownerAcceptance?.review, journal);
    assert.deepEqual(
      accepted.snapshot.hostedRuntimes[0].lastExecutionProof?.execution,
      journal.binding.nativeOwner,
    );
    assert.equal(session.turnStarts(), 1);
    await ownerInstall(rig);
    assert.equal(rig.patches(), patchCount + 1);
    assert.deepEqual(await rig.current(), accepted);
    await observe();
    repair = await state.readRepair();
    assert.ok(repair.ok && repair.value.status === "found");
    assert.equal(repair.value.snapshot.work[0].nextStep, "done");
    assert.equal(
      repair.value.snapshot.reservations.length,
      (beforeReview.ok && beforeReview.value.status === "found"
        ? beforeReview.value.snapshot.reservations.length
        : 0) + 1,
    );
    assert.equal(
      repair.value.snapshot.reservations.find((r) =>
        r.id === journal.reservation.id
      )?.outcome,
      "submitted",
    );
    const terminal = canonicalStringify(repair.value.snapshot);
    await runRepairCycle(deps, {
      deadline: Date.now() + 60_000,
      modelStartsEnabled: false,
      stepLimit: 1,
    });
    const replay = await state.readRepair();
    assert.ok(replay.ok && replay.value.status === "found");
    assert.equal(canonicalStringify(replay.value.snapshot), terminal);
    return { journal, receipt, session, state, deps };
  } finally {
    await native.dispose();
  }
}
