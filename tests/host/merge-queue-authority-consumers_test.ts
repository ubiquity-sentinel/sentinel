import assert from "node:assert/strict";
import { createHostedQueueAuthority } from "../../ops/hosted-autonomy-queue-authority.ts";
import { protectQueueState } from "../../ops/hosted-autonomy-queue-state.ts";
import { runHostedDeliveryPass } from "../../ops/hosted-autonomy-delivery-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type { HostedQueueCustodyContext } from "../../ops/hosted-autonomy-queue-context.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { portOk, type RepairStateWriter } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { authorityRig } from "./merge-queue-authority-fixtures.ts";
import {
  BASE,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  repositoryTask,
} from "./hosted-autonomy-fixtures.ts";
import { releaseSnapshot } from "./hosted-autonomy-rig.ts";
import { SHA3 } from "./merge-queue-proof-fixtures.ts";
import { createPublishedRefreshValidator } from "../../src/host/published-refresh-validator.ts";
import { runHostedQueueCustody } from "../../ops/hosted-autonomy-queue-pass.ts";
import { makeRig, seededSnapshot } from "../repair/loop-rig.ts";
import { commitIn, gitRun } from "./actions-candidates-fixture.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import { REPO, reservation, T0, workRecord } from "../state/helpers.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { APP_LOGIN } from "../../src/host/actions-target-cycles.ts";
import { FakeCooldownGate } from "../github/helpers.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import {
  FakeGithub,
  type FakeGithubOptionsV1,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  repairConfigs,
} from "../repair/helpers.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { requestReviewFor } from "../../src/repair/loop-review-request.ts";
import { createNativeQueueGuard } from "../../src/github/native-queue-guard.ts";
import { createQueueDeliveryReader } from "../../src/github/queue-delivery-reader.ts";
import { exactOpenPr } from "../repair/loop-candidate-fixtures.ts";

Deno.test("real queue authority permits queued booking after a direct merge in the same protected pass", async () => {
  const rig = await authorityRig(true);
  const queued = rig.record;
  const task = rig.facts.task;
  assert.ok(task !== "unavailable");
  const other = foreignRecord();
  rig.replace(
    parseRepairStateSnapshotV1({
      ...rig.snapshot,
      work: [other, queued],
      reviews: [foreignReceipt(), ...rig.snapshot.reviews],
    }),
    rig.head,
  );
  const before = structuredClone(rig.snapshot);
  let merged = false;
  let merges = 0;
  let writes = 0;
  let authorizations = 0;
  const githubFor: HostedAutonomyDepsV1["githubFor"] = (repository) =>
    repository.name === queued.repository.name
      ? {
        ...rig.github,
        readIssueTask: () => Promise.resolve(task),
      }
      : {
        ...rig.github,
        readDefaultBranch: () => Promise.resolve("main"),
        readBaseTip: () => Promise.resolve(BASE),
        readIssueTask: (issue) =>
          Promise.resolve(repositoryTask(repository, issue)),
        readPull: () =>
          Promise.resolve(
            merged ? foreignPullFacts() : foreignPullFacts({
              state: "open",
              merged: false,
              mergeCommitSha: null,
            }),
          ),
        merge: () => {
          merges++;
          merged = true;
          return Promise.resolve({
            merged: true,
            sha: foreignPullFacts().mergeCommitSha,
          });
        },
      };
  const authority = createHostedQueueAuthority({
    ...rig.options,
    githubFor,
    configuration: rig.configuration,
  });
  const custody: HostedQueueCustodyContext = {
    ready: true,
    proofActivated: true,
    protectedRecordIds: new Set([queued.id]),
    resolveDelivery: authority.resolveDelivery,
    verifyProtectedWrite: (previous, next, head) => {
      authorizations++;
      return authority.verifyProtectedWrite(previous, next, head);
    },
  };
  const underlying = {
    ...rig.state,
    writeRepair: ((next, expectedHead) => {
      assert.equal(expectedHead, rig.head);
      assert.equal(next.stateHead, expectedHead);
      assert.equal(next.sequence, rig.snapshot.sequence + 1);
      writes++;
      rig.replace(parseRepairStateSnapshotV1(next), SHA3);
      return Promise.resolve(portOk({ status: "applied", head: rig.head }));
    }) satisfies RepairStateWriter["writeRepair"],
  };
  const deps: HostedAutonomyDepsV1 = {
    state: protectQueueState(underlying, custody),
    githubFor,
    clock: rig.clock,
    queueCustody: custody,
  };
  const context: HostedAutonomyPassContextV1 = {
    deps,
    snapshot: structuredClone(rig.snapshot),
    observedHead: rig.head,
    initialHead: rig.head,
    releaseSnapshot: releaseSnapshot(),
    actions: [],
    revisions: [],
    closedIssues: new Set(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set(),
    ...createHostedAutonomyScopes(deps),
  };
  const result = await runHostedDeliveryPass(context);
  assert.equal(result?.status, "applied", context.actions.join(" "));
  assert.equal(merges, 1, context.actions.join(" "));
  assert.equal(
    writes,
    1,
    "the direct merge must not batch an unrelated row edit",
  );
  assert.equal(
    authorizations,
    1,
    "the real protected writer must authorize booking",
  );
  assert.equal(context.foreignMerged.size, 1);
  assert.deepEqual(rig.snapshot.work[0], before.work[0]);
  const delivered = rig.snapshot.work.find((record) =>
    record.id === queued.id
  )!;
  assert.deepEqual(delivered.intent, queued.intent);
  assert.deepEqual(delivered.wait, queued.wait);
  assert.deepEqual(delivered.counters, queued.counters);
  assert.equal(rig.snapshot.releaseRequests.length, 1);
  assert.equal(rig.snapshot.releaseRequests[0].source.pullRequest, 7);
  assert.equal(delivered.evidence.length, queued.evidence.length + 1);
});

Deno.test("queue prelude acknowledges an exact published refresh once, preserves charges and gates its review on CI", async (t) => {
  const rig = await makeRig("published-refresh-queue", { summaries: false });
  try {
    const base = await commitIn(rig.ctx.work, rig.ctx.env, "base");
    const head = await commitIn(rig.ctx.work, rig.ctx.env, "candidate");
    assert.ok(
      (await gitRun(
        rig.ctx.work,
        ["checkout", "-q", "-B", "development", base],
        rig.ctx.env,
      )).ok,
    );
    const nextBase = await commitIn(rig.ctx.work, rig.ctx.env, "new-base");
    const executor = new DenoGitExecutor({
      localDir: rig.ctx.work,
      remoteUrl: `file://${rig.ctx.bare}`,
      gitHome: rig.ctx.tmp,
    });
    const integrated = await executor.integrateBase(head, nextBase);
    assert.ok(integrated.ok);
    const prepared = integrated.value;
    const id = asWorkItemId("issue-ubiquity-ai.ubq.fi-1"),
      branch = candidateBranch(id);
    const key = baseRefreshIntentKey(7, head, nextBase);
    const produced = "cd".repeat(32), originalKey = `impl:${produced}`;
    const originalRef = await candidatePreservationRef(REPO, id, originalKey);
    const preservedRef = await candidatePreservationRef(REPO, id, key);
    const pushed = await gitRun(rig.ctx.work, [
      "push",
      "-q",
      "origin",
      `${nextBase}:refs/heads/development`,
      `${prepared}:refs/heads/${branch}`,
      `${prepared}:${preservedRef}`,
      `${head}:${originalRef}`,
    ], rig.ctx.env);
    assert.ok(pushed.ok, pushed.stderr);
    const original = workRecord(id, {
      source: { kind: "issue", id: "1", revision: base },
      failingRevision: null,
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      target: {
        base,
        head,
        branch,
        pr: 7,
        checkpoint: null,
        candidateState: {
          preserved: {
            operationKey: originalKey,
            base,
            head,
            ref: originalRef,
          },
          publishedHead: head,
        },
      },
      intent: {
        kind: "base_refresh",
        key,
        startedAt: T0 + 2000,
        branch,
        expectedHead: head,
        observedBase: nextBase,
        pr: 7,
        requestId: null,
        resultId: prepared,
      },
      updatedAt: T0 + 2000,
    });
    const charge = reservation(produced, {
      taskId: id,
      head: base,
      outcome: "submitted",
      settledAt: T0 + 1000,
    });
    const first = await rig.store.writeRepair(
      seededSnapshot([original], {
        reservations: [charge],
        updatedAt: T0 + 2000,
      }),
      null,
    );
    assert.ok(first.ok && first.value.status === "applied");
    const held = {
      ...original,
      wait: { reason: "backoff" as const, since: T0 + 3000, until: null },
      updatedAt: T0 + 3000,
    };
    const beforeHold = await rig.snapshot();
    const saved = await rig.store.writeRepair({
      ...beforeHold,
      stateHead: first.value.head,
      sequence: beforeHold.sequence + 1,
      updatedAt: T0 + 3000,
      work: [held],
    }, first.value.head);
    assert.ok(saved.ok && saved.value.status === "applied");
    rig.clock.advance(10_000);
    const before = await rig.snapshot(),
      charges = canonicalStringify(before.reservations);
    const controls = {
      incomplete: false,
      queued: false,
      human: false,
      noHistory: false,
      stateDrift: false,
      ambiguous: false,
    };
    const shape = { name: "ai.ubq.fi", owner: { login: "ubiquity" } };
    const http: HttpTransportV1 = () =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify({
          data: {
            repository: {
              issue: {
                number: 1,
                state: "OPEN",
                title: "Repair",
                body: "Repair the candidate",
                updatedAt: "2026-01-01T00:00:00Z",
                assignees: { nodes: [], pageInfo: { hasNextPage: false } },
                labels: { nodes: [], pageInfo: { hasNextPage: false } },
              },
              pullRequest: {
                id: "PR7",
                number: 7,
                state: "OPEN",
                body: "Resolves #1",
                headRefOid: prepared,
                baseRefOid: nextBase,
                headRefName: branch,
                baseRefName: "development",
                author: {
                  __typename: controls.human ? "User" : "Bot",
                  login: "ubiquity-sentinel",
                },
                repository: shape,
                headRepository: shape,
                baseRepository: shape,
                timelineItems: {
                  totalCount: 2,
                  pageInfo: {
                    hasNextPage: controls.incomplete,
                    endCursor: controls.incomplete ? "same" : null,
                  },
                  nodes: [{ __typename: "PullRequestRevisionMarker" }, {
                    __typename: controls.queued
                      ? "AddedToMergeQueueEvent"
                      : "PullRequestCommit",
                    id: "C1",
                  }, { __typename: "PullRequestCommit", id: "C2" }],
                },
              },
            },
          },
        }),
      });
    const native = await authorityRig();
    const pull = {
      repository: REPO,
      number: 7,
      nodeId: "PR7",
      head: prepared,
      headRef: branch,
      baseRef: "development",
    };
    const queue = {
      repository: REPO,
      baseRef: "development",
      baseTip: nextBase,
      queueId: null,
      entries: [],
      observedAt: rig.clock.now(),
    };
    native.client.readBranchRules = () => Promise.resolve(portOk([]));
    native.client.readQueue = () =>
      Promise.resolve({ status: "complete", value: queue });
    native.client.readQueuePull = () =>
      Promise.resolve({
        status: "complete",
        value: {
          membership: { pull, entry: null, mergedRevision: null },
          base: nextBase,
          author: APP_LOGIN,
          mergedBy: null,
        },
      });
    const validator = createPublishedRefreshValidator({
      repository: REPO,
      token: "fixture-only",
      clock: rig.clock,
      gate: new FakeCooldownGate(),
      http,
      remoteUrl: `file://${rig.ctx.bare}`,
      scratch: rig.ctx.tmp,
    });
    let writes = 0;
    const state = new Proxy(rig.store, {
      get(target, property) {
        if (
          property === "openRepairHistory" && controls.noHistory
        ) return undefined;
        if (property === "writeRepair") {
          return async (
            ...args: Parameters<RepairStateWriter["writeRepair"]>
          ) => {
            writes++;
            const result = await target.writeRepair(...args);
            return controls.ambiguous && result.ok &&
                result.value.status === "applied"
              ? portOk({
                status: "ambiguous" as const,
                currentHead: result.value.head,
              })
              : result;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const authority = createHostedQueueAuthority({
      state,
      clock: rig.clock,
      clientFor: () => native.client,
      githubFor: () => native.github,
      configuration: { ...native.configuration, mode: "off" },
      validatePublishedRefresh: async (request) => {
        const valid = await validator(request);
        if (valid && controls.stateDrift) {
          const read = await rig.store.readRepair();
          assert.ok(read.ok && read.value.status === "found");
          const drift = await rig.store.writeRepair({
            ...read.value.snapshot,
            stateHead: read.value.head,
            sequence: read.value.snapshot.sequence + 1,
            updatedAt: rig.clock.now(),
          }, read.value.head);
          assert.ok(drift.ok && drift.value.status === "applied");
        }
        return valid;
      },
    });
    const deps: HostedAutonomyDepsV1 = {
      state,
      clock: rig.clock,
      githubFor: () => native.github,
      queue: {
        repository: REPO,
        config: {
          mode: "off",
          proofActivated: true,
          appActor: null,
          probation: false,
        },
        surface: native.client,
        authorization: authority.authorization,
        readEffectiveQueueRule: () =>
          Promise.resolve({ status: "complete", value: false }),
      },
    };
    const run = () => runHostedQueueCustody(deps, rig.clock.now() + 120_000);
    await t.step(
      "incomplete timeline/history, queue events, foreign ownership and moved state retain the exact hold",
      async () => {
        for (
          const key of [
            "incomplete",
            "queued",
            "human",
            "noHistory",
            "stateDrift",
          ] as const
        ) {
          controls[key] = true;
          await run();
          controls[key] = false;
          assert.deepEqual((await rig.snapshot()).work[0], held);
          assert.equal(writes, 0);
        }
      },
    );
    controls.ambiguous = true;
    const firstRecovery = await run();
    const acknowledged = await rig.snapshot();
    assert.equal(
      acknowledged.work[0].target.head,
      prepared,
      JSON.stringify(firstRecovery),
    );
    assert.equal(
      firstRecovery.ready,
      false,
      "an ambiguous CAS response is never reported as success",
    );
    assert.equal(acknowledged.work[0].target.base, nextBase);
    assert.equal(
      acknowledged.work[0].target.candidateState?.preserved?.ref,
      preservedRef,
    );
    assert.equal(acknowledged.work[0].intent, null);
    assert.equal(acknowledged.work[0].wait, null);
    assert.deepEqual(acknowledged.work[0].counters, held.counters);
    assert.deepEqual(acknowledged.work[0].source, held.source);
    assert.equal(canonicalStringify(acknowledged.reservations), charges);
    assert.equal(writes, 1);
    controls.ambiguous = false;
    await run();
    assert.equal(writes, 1, "restart never repeats the acknowledgment");
    const githubOptions: FakeGithubOptionsV1 = {
      baseSha: nextBase,
      issues: [{ number: 1, title: "Repair", body: "Repair the candidate" }],
      candidateLifecycle: {
        refs: { [`refs/heads/${branch}`]: prepared },
        prepareBaseRefresh: () => {
          throw new Error("unchanged acknowledged base must not regenerate");
        },
        pullRequests: [exactOpenPr(7, prepared, branch, nextBase)],
      },
      checks: [{
        name: "test",
        head: prepared,
        status: "completed" as const,
        conclusion: "failure" as const,
        startedAt: T0,
        completedAt: T0 + 1000,
      }],
    };
    const github = new FakeGithub(githubOptions), model = new FakeModel();
    github.nativeQueue = createNativeQueueGuard({
      repository: REPO,
      state: rig.store,
      clock: rig.clock,
      client: native.client,
      reader: createQueueDeliveryReader({
        repository: REPO,
        clock: rig.clock,
        client: native.client,
        policy: native.policy,
      }),
      mode: "off",
      proofActivated: true,
      policy: native.policy,
    });
    const configs = repairConfigs();
    const loopDeps = {
      state: rig.store,
      clock: rig.clock,
      github,
      model,
      configs,
      controllerSha: base,
      budget: new RollingStartBudget({
        state: rig.store,
        clock: rig.clock,
        configs,
      }),
      githubCooldown: new DurableGitHubCooldownGate({
        state: rig.store,
        clock: rig.clock,
      }),
      incidents: new FakeIncidents({ summaries: [] }),
      replay: new FakeReplay(),
    };
    const review = async () => {
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      return requestReviewFor(
        loopDeps,
        {
          snapshot: read.value.snapshot,
          head: read.value.head,
          executionBaseline: read.value.snapshot.work[0],
          bounds: {
            runDeadline: rig.clock.now() + 3_600_000,
            modelCutoff: rig.clock.now() + 3_600_000,
          },
        },
        read.value.snapshot.work[0],
        7,
      );
    };
    const red = await review();
    assert.equal(github.reviewRequestIdentities.length, 0, JSON.stringify(red));
    assert.notEqual(
      red.kind,
      "deferred",
      "the fixture must actually reach the CI gate",
    );
    assert.equal(
      canonicalStringify((await rig.snapshot()).reservations),
      charges,
    );
    // A fresh observation with current green CI uses the existing normal admission path.
    githubOptions.checks![0].conclusion = "success";
    const green = await review();
    assert.equal(
      github.reviewRequestIdentities.length,
      1,
      JSON.stringify(green),
    );
    assert.equal(github.reviewRequestIdentities[0].expectedHead, prepared);
    const final = await rig.snapshot();
    assert.equal(final.reservations.length, before.reservations.length + 1);
    assert.equal(
      canonicalStringify(
        final.reservations.find((entry) => entry.id === charge.id),
      ),
      canonicalStringify(charge),
    );
    assert.equal(model.requests.length, 0);
    assert.equal(github.pushes.length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});
