/** Real delivery guard: a transient preactivation rule read must not create queue custody. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { createNativeQueueGuard } from "../../src/github/native-queue-guard.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { mergeIntentKey } from "../../src/repair/keys.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";
import { handleMergeOutcome } from "../../src/repair/loop-merge.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import { pullWire } from "../github/helpers.ts";
import {
  PULL,
  response,
  SHA1,
  SHA2,
  T0,
} from "../github/merge-queue-fixtures.ts";
import { readerFixture } from "../github/queue-delivery-reader-fixtures.ts";
import { APP, POLICY, SHA4 } from "../host/merge-queue-proof-fixtures.ts";
import { reservation } from "../state/helpers.ts";
import {
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
} from "./helpers.ts";

class QueueGithub extends FakeGithub {
  override readonly reviewerIdentity = APP.login;
}

Deno.test("native delivery rule-read failure stays finite and recovers without queue APIs", async (t) => {
  for (const failAt of [1, 2]) {
    await t.step(
      failAt === 1 ? "initial rule observation" : "final rule observation",
      async () => {
        const f = await readerFixture({
          intercept: (request) =>
            request.url.endsWith("/pulls/7")
              ? response(pullWire({
                number: 7,
                state: "closed",
                head: { ref: PULL.headRef, sha: SHA2 },
                base: { ref: "development", sha: SHA1 },
                user: { login: APP.login },
                merged_at: new Date(T0 + 1000).toISOString(),
                merge_commit_sha: SHA4,
                merged_by: {
                  type: APP.type,
                  login: APP.login,
                  node_id: APP.nodeId,
                },
              }))
              : undefined,
        });
        const state = new MemoryState();
        const record = {
          ...f.facts.record,
          intent: {
            kind: "merge" as const,
            key: mergeIntentKey(7, SHA2),
            startedAt: T0,
            branch: PULL.headRef,
            expectedHead: SHA2,
            observedBase: SHA1,
            pr: 7,
            requestId: f.facts.receipt.requestId,
            resultId: f.facts.receipt.resultId,
          },
        };
        state.repair = {
          ...f.snapshot,
          work: [record],
          reservations: [reservation("original-charge", {
            repository: record.repository,
            taskId: record.id,
            outcome: "submitted",
            settledAt: T0 + 1000,
          })],
        };
        state.repairHead = SHA1;
        let rules = 0;
        let queueReads = 0;
        f.client.readBranchRules = () => {
          rules++;
          return Promise.resolve(
            rules === failAt
              ? portError("unavailable", "synthetic transient rule read")
              : portOk([]),
          );
        };
        f.client.readQueuePull = () => {
          queueReads++;
          return Promise.resolve({
            status: "unavailable",
            reason: "permission",
          });
        };
        const guard = createNativeQueueGuard({
          repository: record.repository,
          state,
          clock: f.clock,
          client: f.client,
          reader: f.reader,
          policy: POLICY,
          mode: "off",
          proofActivated: false,
        });
        const github = new QueueGithub({
          nativeQueue: guard,
          issues: [{
            number: 1,
            title: f.request.currentTask.title,
            body: f.request.currentTask.body,
          }],
        });
        const model = new FakeModel();
        const configs = [
          repositoryConfig(undefined, undefined, {
            repository: record.repository,
          }),
        ];
        const deps: RepairCycleDepsV1 = {
          clock: f.clock,
          state,
          configs,
          controllerSha: SHA1,
          github,
          model,
          replay: new FakeReplay(),
          incidents: new FakeIncidents({ summaries: [] }),
          githubCooldown: new DurableGitHubCooldownGate({
            state,
            clock: f.clock,
          }),
          budget: new RollingStartBudget({ state, clock: f.clock, configs }),
        };
        const context: LoopContextV1 = {
          snapshot: state.repair,
          head: SHA1,
          executionBaseline: record,
          bounds: {
            runDeadline: f.clock.now() + 3600_000,
            modelCutoff: f.clock.now() + 3600_000,
          },
        };
        const before = structuredClone(state.repair);
        const merged = {
          outcome: "merged" as const,
          head: SHA2,
          mergeSha: SHA4,
        };
        assert.deepEqual(
          await handleMergeOutcome(
            deps,
            context,
            record,
            merged,
            f.facts.receipt,
          ),
          { kind: "progress" },
        );
        const paused = state.repair!.work[0];
        assert.deepEqual(paused, {
          ...record,
          wait: {
            reason: "unavailable",
            since: f.clock.now(),
            until: f.clock.now() + CHECK_POLL_MS,
          },
          updatedAt: f.clock.now(),
        });
        assert.deepEqual(state.repair!.reservations, before.reservations);
        assert.equal(state.repair!.releaseRequests.length, 0);
        assert.equal(github.calls.length, 0);
        assert.equal(model.requests.length, 0);
        assert.equal(queueReads, 0);
        assert.ok(
          f.requests.every((request) =>
            /\/(?:pulls\/7|issues\/1)$/.test(new URL(request.url).pathname)
          ),
          "no queue-permission HTTP during transient proof",
        );

        f.clock.advance(CHECK_POLL_MS + 1);
        assert.deepEqual(
          await handleMergeOutcome(
            deps,
            context,
            paused,
            merged,
            f.facts.receipt,
          ),
          { kind: "progress" },
        );
        const recovered = state.repair!.work[0];
        assert.equal(recovered.intent, null);
        assert.notEqual(recovered.wait?.reason, "backoff");
        assert.ok(
          recovered.wait === null ||
            (recovered.wait.until !== null &&
              recovered.wait.until < f.clock.now()),
        );
        assert.deepEqual(recovered.target, record.target);
        assert.deepEqual(state.repair!.reservations, before.reservations);
        assert.equal(state.repair!.releaseRequests.length, 1);
        assert.equal(state.repair!.releaseRequests[0].revision, SHA4);
        assert.equal(
          state.repair!.releaseRequests[0].source.reviewReceiptId,
          f.facts.receipt.id,
        );
        assert.equal(queueReads, 0);
        assert.ok(
          f.requests.every((request) =>
            /\/(?:pulls\/7|issues\/1)$/.test(new URL(request.url).pathname)
          ),
          "successful dark proof uses only ordinary REST",
        );
        assert.equal(model.requests.length, 0);
        assert.deepEqual(github.pushes, []);
        assert.equal(github.calls.includes("merge"), false);
      },
    );
  }
});
