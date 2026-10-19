import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
/** Production serial/matrix routing with explicit unavailable native custody. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { ExistingPrTakeoverPort } from "../../src/contracts/existing-pr-takeover.ts";
import { portError } from "../../src/contracts/ports.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import type { RepairCycleDepsV1 } from "../../src/repair/loop-types.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import { FakeIncidents, FakeReplay, repairConfigs } from "./helpers.ts";
import { REPO, reservation, SHA1, SHA2 } from "../state/helpers.ts";

export function existingPrLifecycleRig(
  author = "human-owner",
  hasExisting = true,
) {
  const existing = {
    ...exactOpenPr(999, SHA2, "existing/issue-1"),
    author,
    body: "Resolves #1",
  };
  const issue = issueRecord(1, {
    body: hasExisting
      ? "Continue https://github.com/ubiquity/ai.ubq.fi/pull/999"
      : "Repair source",
    relations: { openBlockers: [], subIssueCount: 0 },
  });
  const github = new RelationsFakeGithub({
    baseSha: SHA1,
    candidateLifecycle: {
      ...positiveLifecycle(),
      pullRequests: hasExisting ? [existing] : [],
      refs: hasExisting ? { "refs/heads/existing/issue-1": SHA2 } : {},
    },
  });
  github.listed = [issue];
  github.latest.set(1, issue);
  const rig = makeMemoryRig(github);
  const calls: string[] = [];
  const queueControls = { unavailable: false };
  const takeoverControls = { activated: true };
  const queueClient = new GitHubQueueDeliveryClient({
    repository: REPO,
    clock: rig.clock,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    http: (request) => {
      assert.ok(
        new URL(request.url).pathname.endsWith("/rules/branches/development"),
      );
      calls.push("rules");
      return Promise.resolve({
        status: queueControls.unavailable ? 503 : 200,
        headers: new Headers(),
        bodyText: queueControls.unavailable ? "{}" : "[]",
      });
    },
  }, null);
  const queueReader = createQueueDeliveryReader({
    repository: REPO,
    clock: rig.clock,
    client: queueClient,
    policy: POLICY,
  });
  const nativeQueue = createNativeQueueGuard({
    repository: REPO,
    clock: rig.clock,
    state: rig.state,
    client: queueClient,
    reader: queueReader,
    policy: POLICY,
    mode: "off",
    proofActivated: false,
  });
  github.nativeQueue = {
    ...nativeQueue,
    inspect: (request) => {
      calls.push("queue");
      return nativeQueue.inspect(request);
    },
  };
  const writeRepair = rig.state.writeRepair.bind(rig.state);
  rig.state.writeRepair = (next, head) => {
    if (
      next.work.some((row) =>
        row.blocker?.message.startsWith("existing PR hold:")
      )
    ) calls.push("takeover_write");
    return writeRepair(next, head);
  };
  const unavailable = () =>
    Promise.resolve(
      portError("unavailable", "fixture has no effect authority"),
    );
  const takeover: ExistingPrTakeoverPort = {
    get coordinationActivated() {
      return takeoverControls.activated;
    },
    discover: () => {
      calls.push("discover");
      if (!hasExisting) {
        return Promise.resolve({ status: "none", issueDigest: "f".repeat(64) });
      }
      return Promise.resolve({
        status: "owner_park",
        reason: "association_unproven",
        prNumbers: [999],
      });
    },
    authorizeAdoption: unavailable,
    authorizeBoundary: unavailable,
    preserveNativeHead: unavailable,
    resolve: unavailable,
    resolvePublication: unavailable,
    authorizeEffect: unavailable,
  };
  Object.defineProperty(github, "existingPrTakeover", { value: takeover });
  const deps: RepairCycleDepsV1 = {
    clock: rig.clock,
    state: rig.state,
    configs: rig.configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate(rig),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: rig.model,
    budget: new RollingStartBudget(rig),
  };
  const options = { deadline: rig.clock.now() + 60 * 60_000, stepLimit: 16 };
  return {
    ...rig,
    deps,
    options,
    takeover,
    calls,
    queueControls,
    takeoverControls,
    run: () => runRepairCycle(deps, options),
  };
}

import { createRepairStateStore } from "../../src/state/mod.ts";
import { createExistingPrTakeover } from "../../src/host/existing-pr-takeover.ts";
import type { LoopContextV1 } from "../../src/repair/loop-types.ts";
import { nativeFixture } from "../host/existing-pr-native-fixtures.ts";
import {
  gitRun,
  SELF_REPO,
  snapshot,
} from "../host/actions-candidates-fixture.ts";

/** Real immutable Git object and state history; only native API/principal responses are offline ports. */
export async function nativeLifecycleRig(
  repository: RepositoryIdentityV1 = SELF_REPO,
  createTakeover: typeof createExistingPrTakeover = createExistingPrTakeover,
) {
  const native = await nativeFixture(undefined, undefined, repository);
  const { ctx, clock } = native;
  const state = createRepairStateStore({
    remoteUrl: `file://${ctx.bare}`,
    scratchDir: `${ctx.tmp}/custody-state`,
  });
  const fresh = structuredClone(native.state.repair!.work[0]);
  fresh.nextStep = "work";
  fresh.blocker = null;
  fresh.intent = null;
  fresh.evidence = [];
  fresh.target = {
    base: ctx.base,
    head: null,
    branch: null,
    pr: null,
    checkpoint: null,
  };
  const initial = snapshot([fresh], [reservation("a".repeat(64), {
    repository,
    outcome: "ambiguous",
    settledAt: clock.now(),
  })]);
  const seeded = await state.writeRepair(initial, null);
  assert.ok(seeded.ok && seeded.value.status === "applied");
  const configs = repairConfigs({
    repository,
    adapter: { kind: "github" },
  });
  const controls = {
    principal: true,
    principalCalls: 0,
    afterPrincipal: async () => {},
  };
  const composeTakeover = () =>
    createTakeover({
      ...native.factoryInput,
      state,
      async ensureLocalCandidate(_taskId, head) {
        const fetched = await gitRun(native.sourcePath, [
          "fetch",
          "--no-tags",
          `file://${ctx.tmp}/work`,
          head,
        ], ctx.env);
        return fetched.ok
          ? { ok: true as const, value: undefined }
          : portError("unavailable", "fixture candidate import failed");
      },
      principal: {
        async revalidate() {
          controls.principalCalls++;
          await controls.afterPrincipal();
          return controls.principal
            ? { ok: true as const, value: undefined }
            : portError("unavailable", "fixture principal revoked");
        },
      },
    });
  if (repository.owner === "ubiquity" && repository.name === "ai.ubq.fi") {
    const queueReader = createQueueDeliveryReader({
      repository,
      clock,
      client: native.client,
      policy: POLICY,
    });
    Object.defineProperty(native.host.port, "nativeQueue", {
      value: createNativeQueueGuard({
        repository,
        clock,
        state,
        client: native.client,
        reader: queueReader,
        policy: POLICY,
        mode: "off",
        proofActivated: false,
      }),
    });
  }
  const takeover = composeTakeover();
  Object.defineProperty(native.host.port, "existingPrTakeover", {
    value: takeover,
  });
  const ordinary = existingPrLifecycleRig();
  const deps: RepairCycleDepsV1 = {
    ...ordinary.deps,
    state,
    clock,
    configs,
    github: native.host.port,
    githubCooldown: native.gate,
    budget: new RollingStartBudget({ state, clock, configs }),
  };
  const reload = async (): Promise<LoopContextV1> => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    return {
      snapshot: read.value.snapshot,
      head: read.value.head,
      bounds: {
        runDeadline: clock.now() + 240_000,
        modelCutoff: clock.now() + 120_000,
      },
      executionBaseline: null,
    };
  };
  return {
    ...native,
    nativeControls: native.controls,
    state,
    deps,
    controls,
    takeover,
    initial,
    reload,
    restartTakeover() {
      const next = composeTakeover();
      Object.defineProperty(native.host.port, "existingPrTakeover", {
        value: next,
      });
      return next;
    },
  };
}

import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import { createNativeQueueGuard } from "../../src/github/native-queue-guard.ts";
import { createQueueDeliveryReader } from "../../src/github/queue-delivery-reader.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { POLICY } from "../host/merge-queue-proof-fixtures.ts";

import { pollIntake } from "../../src/repair/loop-intake.ts";

/** Create a fresh authoritative issue through real intake, before coordination/branch assignment. */
export async function seedFreshTakeoverIssue(
  r: ReturnType<typeof existingPrLifecycleRig>,
) {
  r.state.repair = seededSnapshot([]);
  r.state.repairHead = SHA1;
  const context: LoopContextV1 = {
    snapshot: r.state.repair,
    head: r.state.repairHead,
    bounds: {
      runDeadline: r.options.deadline,
      modelCutoff: r.options.deadline - 300_000,
    },
    executionBaseline: null,
  };
  const intake = await pollIntake(r.deps, context);
  assert.equal(intake.result.kind, "progress");
  assert.equal(context.snapshot.work.length, 1);
  assert.equal(context.snapshot.work[0].target.branch, null);
  assert.equal(context.snapshot.work[0].blocker, null);
  r.calls.length = 0;
  return context;
}
