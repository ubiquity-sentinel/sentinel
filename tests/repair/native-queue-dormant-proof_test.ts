import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { portError } from "../../src/contracts/ports.ts";
import { createNativeQueueGuard } from "../../src/github/native-queue-guard.ts";
import { QUEUE_PROOF_POLICY } from "../../src/github/queue-runtime-policy.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { guardQueueDelivery } from "../../src/repair/loop-queue-guard.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";
import { pullWire } from "../github/helpers.ts";
import { readerFixture } from "../github/queue-delivery-reader-fixtures.ts";
import { APP, SHA4 } from "../host/merge-queue-proof-fixtures.ts";
import {
  PULL,
  response,
  SHA1,
  SHA2,
  SHA3,
} from "../github/merge-queue-fixtures.ts";
import {
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";

async function proofRig() {
  const flags = { restFailure: false, lateActive: false, nativeFailure: false };
  const f = await readerFixture({
    intercept: (request, count) => {
      if (request.url.includes("/rules/branches/development")) {
        return response(
          flags.lateActive && count === 2
            ? [{
              id: 1,
              type: "merge_queue",
              ruleset_id: 2,
              ruleset_source_type: "Repository",
              ruleset_source: "ubiquity/ai.ubq.fi",
            }]
            : [],
        );
      }
      if (request.url.endsWith("/pulls/7")) {
        if (flags.restFailure) return response({ message: "temporary" }, 503);
        return response(pullWire({
          number: 7,
          state: "closed",
          head: { ref: PULL.headRef, sha: SHA2 },
          base: { ref: "development", sha: SHA1 },
          user: { login: APP.login },
          merged_at: "2026-09-07T02:00:00Z",
          merge_commit_sha: SHA4,
          merged_by: { type: APP.type, node_id: APP.nodeId, login: APP.login },
        }));
      }
      if (flags.nativeFailure && request.url.endsWith("/graphql")) {
        throw new Error("native observation failed");
      }
      return undefined;
    },
  });
  const state = new MemoryState();
  state.repair = f.snapshot;
  state.repairHead = SHA1;
  const options = {
    repository: f.facts.record.repository,
    state,
    clock: f.clock,
    client: f.client,
    reader: f.reader,
    policy: QUEUE_PROOF_POLICY,
    mode: "off" as const,
    proofActivated: false,
  };
  const guard = createNativeQueueGuard(options);
  const github = new FakeGithub({ nativeQueue: guard });
  const configs = repairConfigs();
  const deps = {
    state,
    clock: f.clock,
    github,
    configs,
    model: new FakeModel(),
    controllerSha: SHA1,
    budget: new RollingStartBudget({ state, clock: f.clock, configs }),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock: f.clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
  };
  const context = {
    snapshot: f.snapshot,
    head: SHA1,
    executionBaseline: f.facts.record,
    bounds: {
      runDeadline: f.clock.now() + 3_600_000,
      modelCutoff: f.clock.now() + 3_600_000,
    },
  };
  return { ...f, state, options, guard, deps, context, flags };
}

Deno.test("real legacy delivery observations retry finitely and recover without native queue permission", async (t) => {
  for (
    const failure of [
      "initial_state",
      "legacy_state",
      "final_state",
      "rest",
      "throw",
      "deadline",
    ] as const
  ) {
    await t.step(failure, async () => {
      const f = await proofRig();
      const read = f.state.readRepair.bind(f.state);
      const legacy = f.client.readQueueLegacyPull.bind(f.client);
      let reads = 0;
      f.state.readRepair = () => {
        reads++;
        if (
          reads ===
            (failure === "initial_state"
              ? 1
              : failure === "legacy_state"
              ? 2
              : failure === "final_state"
              ? 3
              : -1)
        ) {
          return Promise.resolve(
            portError("unavailable", "temporary state read"),
          );
        }
        return read();
      };
      f.flags.restFailure = failure === "rest";
      if (failure === "throw") {
        f.client.readQueueLegacyPull = () =>
          Promise.reject(new Error("temporary REST read"));
      }
      if (failure === "deadline") f.context.bounds.runDeadline = f.clock.now();
      const before = structuredClone(f.state.repair!);
      const result = await guardQueueDelivery(
        f.deps,
        f.context,
        f.facts.record,
        f.facts.receipt,
        SHA4,
      );
      assert.equal(result?.kind, "progress");
      const held = f.state.repair!.work[0];
      assert.deepEqual(held, {
        ...before.work[0],
        updatedAt: f.clock.now(),
        wait: {
          reason: "unavailable",
          since: f.clock.now(),
          until: f.clock.now() + CHECK_POLL_MS,
        },
      });
      assert.deepEqual(f.state.repair!.reservations, before.reservations);
      f.state.readRepair = read;
      f.client.readQueueLegacyPull = legacy;
      f.flags.restFailure = false;
      f.clock.advance(CHECK_POLL_MS + 1);
      f.context.bounds.runDeadline = f.clock.now() + 60_000;
      assert.equal(
        await guardQueueDelivery(
          f.deps,
          f.context,
          held,
          f.facts.receipt,
          SHA4,
        ),
        null,
      );
      assert.ok(
        f.requests.every((request) => !request.url.endsWith("/graphql")),
      );
      assert.ok(
        f.requests.some((request) =>
          request.url.includes("/rules/branches/development")
        ),
      );
      assert.equal(f.deps.model.requests.length, 0);
    });
  }
});

Deno.test("delivery observation failure after positive rules, state custody or activation stays permanent", async (t) => {
  for (
    const scenario of [
      "late_rule",
      "late_custody",
      "activated",
      "mode_on",
    ] as const
  ) {
    await t.step(scenario, async () => {
      const f = await proofRig();
      const read = f.state.readRepair.bind(f.state);
      if (scenario === "late_rule") {
        f.flags.lateActive = true;
        f.reader.readAuthorizationBasis = () =>
          Promise.reject(new Error("failure after positive final rule"));
      }
      if (scenario === "late_custody") {
        let reads = 0;
        f.state.readRepair = () => {
          if (++reads === 3) {
            f.state.repair = {
              ...f.state.repair!,
              work: [{
                ...f.facts.record,
                wait: { reason: "backoff", since: f.clock.now(), until: null },
              }],
            };
            f.state.repairHead = SHA3;
          }
          return read();
        };
      }
      if (scenario === "activated" || scenario === "mode_on") {
        f.state.readRepair = () =>
          Promise.reject(new Error("state unavailable"));
      }
      const guard = createNativeQueueGuard({
        ...f.options,
        proofActivated: scenario === "activated",
        mode: scenario === "mode_on" ? "on" : "off",
      });
      const proof = await guard.proveDelivery({
        record: f.facts.record,
        receipt: f.facts.receipt,
        revision: SHA4,
        deadline: f.clock.now() + 60_000,
      });
      assert.deepEqual(proof, {
        status: "unavailable",
        reason: "queue_evidence_unavailable",
      });
    });
  }
});
