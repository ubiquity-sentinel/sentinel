import assert from "node:assert/strict";
import { type Clock, portOk, SystemClock } from "../../src/contracts/ports.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import type { GitHubApiClientOptionsV1 } from "../../src/github/client-contracts.ts";
import type { HostedExecutionWaitOptionsV1 } from "../../src/github/client-hosted-execution.ts";
import { CONTROLLER } from "../host/controller-identity-fixture.ts";
import {
  API_BASE,
  ATTEMPT_PATH,
  attemptBody,
  intent,
  jobBody,
  JOBS_PATH,
  jobsBody,
  LocalClock,
  logText,
  makeRig,
  OBSERVED,
  response,
  runtimeStep,
  scriptLog,
  settlementProof,
  terminalRecord,
} from "./hosted-execution-helpers.ts";

const WAIT_MS = 10_000;

class WaitClient extends GitHubApiClient {
  wait(ms: number): Promise<void> {
    return this.hostedExecutionWait(ms);
  }
}

class SleepingClock extends LocalClock {
  readonly waits: number[] = [];
  sleep(ms: number): Promise<void> {
    this.waits.push(ms);
    this.advance(ms);
    return Promise.resolve();
  }
}

function makeWaitRig<T extends Clock>(
  clock: T,
  wait: HostedExecutionWaitOptionsV1 = {},
) {
  const rig = makeRig();
  const options: GitHubApiClientOptionsV1 & HostedExecutionWaitOptionsV1 = {
    repository: CONTROLLER.repository,
    apiBaseUrl: API_BASE,
    http: rig.http.transport,
    auth: {
      authorizationHeader: () => Promise.resolve(portOk("Bearer test-token")),
    },
    cooldownGate: rig.gate,
    clock,
    ...wait,
  };
  return { ...rig, clock, client: new WaitClient(options) };
}

/** Shorten only the metadata timer so a regression never waits on wall time. */
async function withWaitTimerSpy(
  run: (timers: number[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.setTimeout;
  const timers: number[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    if (args[1] === WAIT_MS) {
      timers.push(args[1]);
      args[1] = 0;
    }
    return original(...args);
  }) as typeof setTimeout;
  try {
    await run(timers);
  } finally {
    globalThis.setTimeout = original;
  }
}

Deno.test("hosted execution wait: uses the injected clock sleep with its receiver", async () => {
  const clock = new SleepingClock(OBSERVED);
  const rig = makeWaitRig(clock);
  await withWaitTimerSpy(async (timers) => {
    await rig.client.wait(WAIT_MS);
    assert.deepEqual(clock.waits, [WAIT_MS]);
    assert.equal(clock.now(), OBSERVED + WAIT_MS);
    assert.deepEqual(timers, []);
  });
});

Deno.test("hosted execution wait: rejects a custom clock without either sleep seam", async () => {
  const rig = makeWaitRig(new LocalClock(OBSERVED));
  await withWaitTimerSpy(async (timers) => {
    await assert.rejects(rig.client.wait(WAIT_MS), /requires.*sleep/);
    assert.deepEqual(timers, []);
  });
});

Deno.test("hosted execution wait: the explicit sleep seam takes precedence", async () => {
  const clock = new SleepingClock(OBSERVED);
  const waits: number[] = [];
  const rig = makeWaitRig(clock, {
    sleep: (ms) => {
      waits.push(ms);
      clock.advance(ms);
      return Promise.resolve();
    },
  });
  await withWaitTimerSpy(async (timers) => {
    await rig.client.wait(WAIT_MS);
    assert.deepEqual(waits, [WAIT_MS]);
    assert.deepEqual(clock.waits, []);
    assert.equal(clock.now(), OBSERVED + WAIT_MS);
    assert.deepEqual(timers, []);
  });
});

Deno.test("hosted execution wait: retains the real timer for SystemClock", async () => {
  const rig = makeWaitRig(new SystemClock());
  await withWaitTimerSpy(async (timers) => {
    await rig.client.wait(WAIT_MS);
    assert.deepEqual(timers, [WAIT_MS]);
  });
});

Deno.test("hosted execution: metadata reread uses clock sleep without an options seam", async () => {
  const clock = new SleepingClock(OBSERVED);
  const rig = makeWaitRig(clock);
  let jobsReads = 0;
  rig.http.on("GET", ATTEMPT_PATH, () => response(200, attemptBody()));
  rig.http.on("GET", JOBS_PATH, () => {
    jobsReads++;
    return response(
      200,
      jobsBody([jobBody({ steps: jobsReads === 1 ? [] : [runtimeStep()] })]),
    );
  });
  scriptLog(rig, logText([terminalRecord()]));
  await withWaitTimerSpy(async (timers) => {
    const proof = settlementProof(
      await rig.client.readHostedExecution(intent()),
    );
    assert.equal(proof.outcome, "healthy");
    assert.equal(jobsReads, 2);
    assert.equal(proof.observedAt, OBSERVED + WAIT_MS);
    assert.deepEqual(clock.waits, [WAIT_MS]);
    assert.deepEqual(timers, []);
  });
});
