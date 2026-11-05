/**
 * Bootstrap as a health pass (issue #336). The actual hosted repair entrypoint
 * runs a model-disabled bootstrap over a 700-record state: it verifies runtime
 * pins, custody and contract versions, never composes a target port, never
 * calls the target-cycle (step) port, writes nothing, and still returns the
 * child result the trusted finalize turns into the healthy settled proof. A
 * failed compatibility check stays a failed child result, so the existing
 * journaled restoration still runs. No network, model or credential.
 */
import assert from "node:assert/strict";
import { runActionsRepairHost } from "../../src/host/actions-repair-host.ts";
import {
  BOOTSTRAP_HEALTH_DETAIL,
  runBootstrapHealthPass,
} from "../../src/host/bootstrap-health-pass.ts";
import { parseChildStatus } from "../../src/host/hosted-runtime-status.ts";
import { ACCEPTED_CHILD_LOGINS } from "../../src/host/hosted-runtime-identity.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor-types.ts";
import { ensureRepairStateSeed } from "../../src/host/actions-host-io.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { StateReadView } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { response, snapshotWire } from "../github/merge-queue-fixtures.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import { rig } from "./matrix-actions-fixtures.ts";

const RECORDS = 700;

function generatedRecords(base: string): WorkRecordV1[] {
  return Array.from(
    { length: RECORDS },
    (_, index) =>
      workRecord(`bootstrap-health-${index}`, {
        source: { kind: "issue", id: String(5_000 + index), revision: base },
        related: { incidentId: null, issueNumber: 5_000 + index },
        target: {
          base,
          branch: null,
          checkpoint: null,
          head: null,
          pr: null,
        },
      }),
  );
}

Deno.test("bootstrap health pass: 700 records, no step port call, healthy child result", async () => {
  const r = await rig(false, "bootstrap");
  try {
    await ensureRepairStateSeed(r.store, r.clock);
    const seed = await r.store.readRepair();
    assert.ok(seed.ok && seed.value.status === "found");
    const seeded = await r.store.writeRepair(
      parseRepairStateSnapshotV1({
        ...seed.value.snapshot,
        stateHead: seed.value.head,
        sequence: seed.value.snapshot.sequence + 1,
        work: generatedRecords(r.sha),
      }),
      seed.value.head,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const before = await r.store.readRepair();
    const deps = await r.job("bootstrap-health-700", "repair");
    let steps = 0, writes = 0, composed = 0, modelCalls = 0, mutations = 0;
    const result = await runActionsRepairHost({
      ...deps,
      state: {
        readRepair: () => r.store.readRepair(),
        readRelease: () => r.store.readRelease(),
        writeRepair: () => {
          writes++;
          return Promise.resolve(portError("invalid", "bootstrap writes none"));
        },
      },
      http: (request) => {
        const path = new URL(request.url).pathname;
        if (request.method !== "GET" && path !== "/graphql") mutations++;
        return Promise.resolve(
          response(path === "/graphql" ? snapshotWire(null) : []),
        );
      },
      preflight: () => Promise.resolve(),
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          modelCalls++;
          throw new Error("bootstrap must not start a model");
        },
      },
      composeGithub: (_config, production) => {
        composed++;
        return production;
      },
      runTargetCycles: () => {
        steps++;
        throw new Error("bootstrap must not step a record");
      },
    });
    assert.equal(steps, 0, "the target-cycle step port is never called");
    assert.equal(composed, 0, "no target port is composed");
    assert.equal(modelCalls, 0);
    assert.equal(writes, 0);
    assert.equal(mutations, 0);
    assert.ok(
      [...r.github.values()].every((port) => port.calls.length === 0),
      "no target source or record read",
    );
    assert.deepEqual(result.outcome, {
      status: "idle",
      detail: BOOTSTRAP_HEALTH_DETAIL,
    });
    assert.deepEqual(result.ciApproval, {
      approved: 0,
      pending: 0,
      unavailable: 0,
    });
    assert.deepEqual(await r.store.readRepair(), before);
    // The exact consumer the launcher uses to mint the healthy terminal proof.
    const status = parseChildStatus(
      JSON.parse(JSON.stringify(result)),
      result.execution,
    );
    assert.ok(status !== null);
    assert.equal(status.healthy, true);
    assert.equal(status.failure, null);
  } finally {
    await r.cleanup();
  }
});

const execution = parseHostedExecutionIntentV1({
  id: "9:1:repair",
  runId: 9,
  runAttempt: 1,
  launcherSha: SHA1,
  purpose: "bootstrap",
  revision: SHA1,
  generation: 4,
  releaseId: null,
  createdAt: T0,
});

/** Raw release state: a pin mismatch may be refused by the contract itself. */
function releaseWith(overrides: Record<string, unknown>): unknown {
  return ({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedReleases: [],
    githubCooldowns: [],
    hostedRuntimes: [{
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: SHA1,
      generation: 4,
      lastHealthyProof: null,
      lastExecutionProof: null,
      nextOrdinaryAt: T0,
      execution,
      createdAt: T0,
      updatedAt: T0,
      ...overrides,
    }],
  });
}

function stateOf(
  release: unknown,
  repair: unknown = { status: "absent", currentHead: null },
): StateReadView {
  return {
    readRelease: () =>
      Promise.resolve(
        portOk({ status: "found", snapshot: release, head: SHA2 as GitSha }),
      ) as ReturnType<StateReadView["readRelease"]>,
    readRepair: () =>
      Promise.resolve(portOk(repair)) as ReturnType<
        StateReadView["readRepair"]
      >,
  } as StateReadView;
}

Deno.test("bootstrap health pass: compatible pins and an absent repair state are healthy", async () => {
  // The healthy fixture is a valid release contract.
  parseReleaseStateSnapshotV1(releaseWith({}));
  const outcome = await runBootstrapHealthPass({
    state: stateOf(releaseWith({})),
    execution,
  });
  assert.deepEqual(outcome, {
    status: "idle",
    detail: BOOTSTRAP_HEALTH_DETAIL,
  });
});

for (
  const [name, state] of [
    ["pinned generation differs", stateOf(releaseWith({ generation: 5 }))],
    ["pinned revision differs", stateOf(releaseWith({ activeRevision: SHA2 }))],
    ["no saved execution", stateOf(releaseWith({ execution: null }))],
    ["release contract incompatible", stateOf({ version: "v9" })],
    [
      "repair contract incompatible",
      stateOf(releaseWith({}), {
        status: "found",
        head: SHA2,
        snapshot: { version: "v9", kind: "repair_state_snapshot" },
      }),
    ],
    [
      "repair state unavailable",
      {
        readRelease: stateOf(releaseWith({})).readRelease,
        readRepair: () => Promise.resolve(portError("unavailable", "down")),
      } as StateReadView,
    ],
  ] as const
) {
  Deno.test(`bootstrap health pass: ${name} fails bootstrap`, async () => {
    const outcome = await runBootstrapHealthPass({ state, execution });
    assert.equal(outcome.status, "state_error", JSON.stringify(outcome));
    // The same child result consumer maps it to a failed (never healthy) run,
    // which keeps the existing failed-bootstrap journaled restoration.
    const status = parseChildStatus({
      status: "ran",
      outcome,
      controllerSha: SHA1,
      baseSha: SHA1,
      login: ACCEPTED_CHILD_LOGINS[0],
      startupReady: true,
      ciApproval: { approved: 0, pending: 0, unavailable: 0 },
      execution,
    }, execution);
    assert.ok(status !== null);
    assert.equal(status.healthy, false);
    assert.equal(status.failure?.status, "state_error");
  });
}
