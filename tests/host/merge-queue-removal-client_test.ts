import assert from "node:assert/strict";
import { createHostedQueueAuthority } from "../../ops/hosted-autonomy-queue-authority.ts";
import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import { parseQueueIntent } from "../../ops/hosted-autonomy-queue-intent.ts";
import { runHostedQueueCustody } from "../../ops/hosted-autonomy-queue-pass.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import {
  entryWire,
  eventsWire,
  eventWire,
  membershipWire,
  response,
} from "../github/merge-queue-fixtures.ts";
import { authorityRig } from "./merge-queue-authority-fixtures.ts";
import { APP, SHA3, SHA4, T0 } from "./merge-queue-proof-fixtures.ts";
import {
  nativeEntry,
  orchestrationRig,
} from "./merge-queue-orchestration-fixtures.ts";

async function removalRig(reason: "CHECKS_FAILED" | "CHECKS_TIMEOUT") {
  const rig = await authorityRig(true);
  rig.toggles.merged = false;
  const calls: string[] = [];
  const wire = {
    events: [
      eventWire("AddedToMergeQueueEvent", "ADD_7", {
        createdAt: new Date(T0 + 2000).toISOString(),
      }),
      eventWire("RemovedFromMergeQueueEvent", "REM_7", {
        createdAt: new Date(T0 + 3000).toISOString(),
        reason,
      }),
    ] as Record<string, unknown>[],
    entry: null as unknown,
    membership: {
      baseRefOid: rig.facts.binding.base,
      author: { login: APP.login },
      mergedBy: null,
    } as Record<string, unknown>,
    total: undefined as number | undefined,
    beforeResponse: (_kind: string, _count: number) => {},
  };
  const client = new GitHubQueueDeliveryClient({
    repository: rig.record.repository,
    clock: rig.clock,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    http: (request) => {
      assert.equal(request.method, "POST");
      assert.equal(new URL(request.url).pathname, "/graphql");
      const query = JSON.parse(request.body ?? "{}").query as string;
      const isEvents = query.includes("timelineItems");
      calls.push(isEvents ? "events" : "membership");
      wire.beforeResponse(calls.at(-1)!, calls.length);
      return Promise.resolve(response(
        isEvents
          ? eventsWire(wire.events, wire.total)
          : membershipWire(wire.entry, wire.membership),
      ));
    },
  }, 84);
  const authority = createHostedQueueAuthority({
    ...rig.options,
    clientFor: () => client,
    configuration: rig.configuration,
  });
  return { rig, calls, client, authority, wire };
}

Deno.test("native removal authority classifies unmerged CI and timeout ejections through actual HTTP events", async (t) => {
  for (const reason of ["CHECKS_FAILED", "CHECKS_TIMEOUT"] as const) {
    await t.step(reason, async () => {
      const { rig, calls, client, authority } = await removalRig(reason);
      const events = await client.readPullQueueEvents(rig.facts.pull);
      assert.equal(events.status, "complete");
      calls.length = 0;
      const result = await authority.authorization.readRemoval({
        ...rig.request(),
        binding: rig.facts.binding,
        entryId: "MQE_7",
      });
      assert.deepEqual(result, {
        status: "complete",
        value: {
          classification: reason === "CHECKS_FAILED" ? "ci_failed" : "timeout",
          eventId: "REM_7",
        },
      });
      assert.deepEqual(calls, [
        "membership",
        "events",
        "events",
        "events",
        "events",
        "membership",
      ]);
    });
  }
});

Deno.test("native removal authority rejects missing, foreign, stale and ambiguous ejection evidence", async (t) => {
  for (
    const change of [
      "missing",
      "foreign_actor",
      "foreign_admission",
      "wrong_head",
      "unbound",
      "stale_head",
      "stale_state",
      "entry_id",
      "duplicate_admission",
      "duplicate_removal",
      "unknown_reason",
      "future",
      "before_admission",
      "before_added",
      "missing_pin",
      "incomplete_page",
      "event_drift",
      "membership_drift",
      "merged",
      "task_binding",
      "receipt_binding",
    ] as const
  ) {
    await t.step(change, async () => {
      const { rig, wire, authority } = await removalRig("CHECKS_FAILED");
      const request = {
        ...rig.request(),
        binding: { ...rig.facts.binding },
        entryId: "MQE_7",
      };
      if (change === "missing") wire.events = [wire.events[0]];
      if (change === "foreign_actor" || change === "foreign_admission") {
        wire.events[change === "foreign_actor" ? 1 : 0].actor = {
          __typename: "Bot",
          id: "FOREIGN",
          login: APP.login,
        };
      }
      if (change === "wrong_head") wire.events[1].beforeCommit = { oid: SHA3 };
      if (change === "unbound") wire.events[1].beforeCommit = null;
      if (change === "stale_head") wire.membership.headRefOid = SHA3;
      if (change === "stale_state") {
        wire.beforeResponse = () => {
          rig.toggles.stateMoved = true;
        };
      }
      if (change === "entry_id") request.entryId = "FOREIGN";
      if (change === "duplicate_admission") {
        wire.events.push({ ...wire.events[0], id: "ADD_8" });
      }
      if (change === "duplicate_removal") {
        wire.events.push({ ...wire.events[1], id: "REM_8" });
      }
      if (change === "unknown_reason") {
        wire.events[1].reason = "looks like CI failure";
      }
      if (change === "future") {
        wire.events[1].createdAt = new Date(T0 + 6000).toISOString();
      }
      if (change === "before_admission") {
        wire.events[1].createdAt = new Date(T0 + 1000).toISOString();
      }
      if (change === "before_added") {
        wire.events[0].createdAt = new Date(T0 + 4000).toISOString();
      }
      if (change === "missing_pin") rig.pins.removalBeforeCommit = null;
      if (change === "incomplete_page") wire.total = 3;
      if (change === "event_drift") {
        wire.beforeResponse = (_kind, count) => {
          if (count === 3) wire.events[1].reason = "CHECKS_TIMEOUT";
        };
      }
      if (change === "membership_drift") {
        wire.beforeResponse = (kind, count) => {
          if (kind === "membership" && count > 1) {
            wire.entry = entryWire({ id: "MQE_8" });
          }
        };
      }
      if (change === "merged") {
        wire.membership.merged = true;
        wire.membership.mergeCommit = { oid: SHA4 };
      }
      if (change === "task_binding") {
        request.binding.taskDigest = "f".repeat(64);
      }
      if (change === "receipt_binding") {
        request.binding.reviewReceiptId = "different";
      }
      const result = await authority.authorization.readRemoval(request);
      assert.notEqual(result.status, "complete", JSON.stringify(result));
    });
  }
});

Deno.test("native removal authority reports no removal only for the exact live owned entry", async (t) => {
  for (const change of ["owned", "foreign_entry", "foreign_actor"] as const) {
    await t.step(change, async () => {
      const { rig, wire, authority } = await removalRig("CHECKS_FAILED");
      wire.events = [wire.events[0]];
      wire.entry = entryWire({
        id: change === "foreign_entry" ? "MQE_8" : "MQE_7",
        enqueuedAt: new Date(T0 + 2000).toISOString(),
        ...(change === "foreign_actor"
          ? { enqueuer: { __typename: "Bot", id: "FOREIGN", login: APP.login } }
          : {}),
      });
      const result = await authority.authorization.readRemoval({
        ...rig.request(),
        binding: rig.facts.binding,
        entryId: "MQE_7",
      });
      if (change === "owned") {
        assert.deepEqual(result, {
          status: "complete",
          value: { classification: "none", eventId: null },
        });
      } else assert.notEqual(result.status, "complete");
    });
  }
});

Deno.test("actual removal authority permits one distinct reentry and never resubmits ambiguous or exhausted admissions", async (t) => {
  for (const reason of ["CHECKS_FAILED", "CHECKS_TIMEOUT"] as const) {
    await t.step(reason, async () => {
      const f = await orchestrationRig();
      const native = await removalRig(reason);
      f.queue.config.mode = "on";
      f.rules({ status: "complete", value: true });
      f.onEnqueue(() => f.join());
      await runHostedQueueCustody(f.deps, f.now() + 60000);
      const first = f.state.repair!.work[0].intent!;
      f.advance(3000);
      f.leave();
      const authority = createHostedQueueAuthority({
        ...native.rig.options,
        state: f.state,
        clock: f.deps.clock,
        clientFor: () => native.client,
        configuration: native.rig.configuration,
      });
      f.queue.authorization.readRemoval = authority.authorization.readRemoval;
      f.onEnqueue(() => {});
      native.wire.events[1].reason = "unaccepted removal";
      const refused = await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.ok(
        refused.actions.some((action) => action.includes("removal_unproven")),
      );
      assert.equal(f.calls.filter((call) => call === "enqueue").length, 1);
      native.wire.events[1].reason = reason;
      await runHostedQueueCustody(f.deps, f.now() + 60000);
      const second = parseQueueIntent(f.state.repair!.work[0])!;
      assert.equal(second.admission, 1);
      assert.equal(second.queueFailures, 1);
      assert.equal(second.intent.key, `${first.key}:a1`);
      await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.equal(f.calls.filter((call) => call === "enqueue").length, 2);
      f.join({ ...nativeEntry(), id: "MQE_8", enqueuedAt: f.now() });
      await runHostedQueueCustody(f.deps, f.now() + 60000);
      f.leave();
      native.wire.events.push(
        eventWire("AddedToMergeQueueEvent", "ADD_8", {
          createdAt: new Date(f.now()).toISOString(),
        }),
        eventWire("RemovedFromMergeQueueEvent", "REM_8", {
          createdAt: new Date(f.now() + 1000).toISOString(),
          reason,
        }),
      );
      f.advance(2000);
      const exhausted = await runHostedQueueCustody(f.deps, f.now() + 60000);
      assert.ok(
        exhausted.actions.some((action) =>
          action.includes("repeated_queue_failure")
        ),
      );
      assert.equal(f.calls.filter((call) => call === "enqueue").length, 2);
      assert.equal(f.state.repair!.work[0].wait?.until, null);
    });
  }
});
