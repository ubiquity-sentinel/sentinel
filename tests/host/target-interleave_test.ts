import assert from "node:assert/strict";
import { runActionsTargetCycles } from "../../src/host/actions.ts";
import { createActionsTargetFlow } from "../../src/host/actions-target-flow.ts";
import {
  makeTargetHostRig,
  targetCycleInput,
} from "./actions-target-fixture.ts";
import {
  makeHarness,
  onlyReview,
  OP_KEY,
  settle,
  submission,
} from "../github/codex-review-transport-helpers.ts";

Deno.test("target interleave: later target reaches its lifecycle before the first review drain", async () => {
  const rig = makeTargetHostRig(["sentinel", "ai.ubq.fi"]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let secondPrepared = false;
  const input = targetCycleInput(rig, {
    prepareTarget: (config) => {
      if (config.repository.name === "ai.ubq.fi") secondPrepared = true;
      return Promise.resolve();
    },
    composeGithub: (config) => {
      const port = rig.compose(config);
      const drain = port.drainReviews.bind(port);
      port.drainReviews = async (request) => {
        if (config.repository.name === "sentinel") {
          entered.resolve();
          await release.promise;
        }
        return await drain(request);
      };
      return port;
    },
  });
  const running = runActionsTargetCycles(input);
  try {
    await entered.promise;
    assert.equal(
      secondPrepared,
      true,
      "an owned review drain must not hold another target",
    );
  } finally {
    release.resolve();
    await running;
  }
});

Deno.test("target interleave: completion before wait is queued without restarting intake or extending the deadline", async () => {
  const rig = makeTargetHostRig(["sentinel"]);
  let emit: (key: string) => void = () => {};
  let listeners = 0;
  const ports: ReturnType<typeof rig.compose>[] = [];
  const input = targetCycleInput(rig, {
    composeGithub: (config) => {
      const port = rig.compose(config);
      port.onReviewCompletion = (listener) => {
        emit = listener;
        listeners++;
        return () => {
          listeners--;
        };
      };
      ports.push(port);
      return port;
    },
  });
  const flow = createActionsTargetFlow(input);
  try {
    while (await flow.advance()) { /* initial observation */ }
    const writes = rig.state.repairWrites;
    rig.clock.advance(10 * 60_000);
    emit("review:99:foreign-head:attempt-1");
    const signal = new AbortController();
    await flow.waitForReady(signal.signal);
    while (
      await flow.advance()
    ) { /* stale completion only requests fresh reads */ }
    assert.equal(rig.state.repairWrites, writes);
    assert.equal(
      rig.http.calls.filter((row) =>
        new URL(row.url).pathname.endsWith("/issues")
      ).length,
      1,
    );
  } finally {
    await flow.finish();
  }
  assert.equal(listeners, 0);
  assert.equal(ports.length, 1);
});

Deno.test("target interleave: a later target failure still drains and unsubscribes every owned earlier port", async () => {
  const rig = makeTargetHostRig(["sentinel", "ai.ubq.fi"]);
  let listeners = 0;
  let drains = 0;
  await assert.rejects(() =>
    runActionsTargetCycles(targetCycleInput(rig, {
      composeGithub: (config) => {
        if (config.repository.name === "ai.ubq.fi") {
          throw new Error("fixture target failure");
        }
        const port = rig.compose(config);
        const drain = port.drainReviews.bind(port);
        port.onReviewCompletion = () => {
          listeners++;
          return () => {
            listeners--;
          };
        };
        port.drainReviews = async (request) => {
          drains++;
          return await drain(request);
        };
        return port;
      },
    })), /fixture target failure/);
  assert.equal(drains, 1);
  assert.equal(listeners, 0);
});

Deno.test("target interleave: native completion is durable and settled, replays readiness, and unsubscribes", async () => {
  const h = makeHarness();
  const keys: string[] = [];
  const unsubscribe = h.transport.onReviewCompletion((key) => {
    assert.ok(h.sessions.every((session) => session.settled));
    assert.equal(onlyReview(h.store).state, "commented");
    keys.push(key);
  });
  try {
    const submitted = await h.transport.submitReview(submission());
    assert.ok(submitted.ok);
    await settle(h.transport);
    assert.deepEqual(keys, [OP_KEY]);
    unsubscribe();
    const replayed: string[] = [];
    const stopReplay = h.transport.onReviewCompletion((key) =>
      replayed.push(key)
    );
    stopReplay();
    assert.deepEqual(
      replayed,
      [OP_KEY],
      "a completion before subscription cannot be lost",
    );
    assert.deepEqual(
      keys,
      [OP_KEY],
      "the detached observer receives nothing further",
    );
  } finally {
    unsubscribe();
    await settle(h.transport);
  }
});
