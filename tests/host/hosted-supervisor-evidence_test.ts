/** Hosted hosted-supervisor-evidence_test responsibility. */
import assert from "node:assert/strict";
import { GitHubApiClient } from "../../src/github/client.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  ReleaseStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  createMatrixUncertaintyMaintenance,
  runMatrixUncertaintyMaintenance,
} from "../../src/host/matrix-uncertainty-maintenance.ts";
import type { MatrixUncertaintyMaintenanceDepsV1 } from "../../src/host/matrix-uncertainty-maintenance.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { runHostedSupervisorPrepare } from "../../src/host/actions-supervisor.ts";
import { T0 } from "../state/helpers.ts";
import {
  DORMANT_HOSTED_POLICIES,
  execution,
  LAUNCHER,
  makeRig,
  releaseRequest,
  requireRun,
  reviewReceipt,
  ROOT,
  run,
  runProof,
  SELF,
  skippedProof,
} from "./actions-supervisor-fixture.ts";
import { bootstrapHealthy } from "./actions-supervisor-lifecycle-fixture.ts";

Deno.test("hosted supervisor core: missing, foreign or contradictory evidence never clears the intent", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    const boot = requireRun(await rig.prepare(run(1)));
    const before = await rig.snapshot();
    const identity = run(2);
    // Missing settlement.
    assert.equal((await rig.prepare(identity)).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
    // Foreign settlement bound to a different execution.
    const foreign = runProof(
      execution({
        runId: 9,
        id: "9:1:repair",
        purpose: "ordinary",
        releaseId: null,
      }),
      "healthy",
    );
    rig.evidence.settlements.set(boot.id, foreign);
    assert.equal((await rig.prepare(identity)).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
    // Contradictory/malformed settlement for the saved execution.
    rig.evidence.settlements.set(boot.id, {
      ...runProof(boot, "healthy"),
      workflowId: 1,
    });
    assert.equal((await rig.prepare(identity)).status, "pending");
    assert.deepEqual(await rig.snapshot(), before);
    // Port failure is pending, never a clean empty success.
    rig.evidence.readFail = true;
    assert.equal((await rig.prepare(identity)).status, "pending");
    rig.evidence.readFail = false;
    assert.deepEqual(await rig.snapshot(), before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: skipped execution settles as not_started and retries on a later run", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    const identity = run(1);
    const boot = requireRun(await rig.prepare(identity));
    rig.evidence.settlements.set(boot.id, skippedProof(boot));
    assert.equal((await rig.finalize(identity)).status, "idle");
    let state = await rig.snapshot();
    assert.equal(
      state.hostedRuntimes[0].lastExecutionProof?.outcome,
      "not_started",
    );
    assert.equal(state.hostedRuntimes[0].lastHealthyProof, null);
    assert.equal(state.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(state.hostedRuntimes[0].generation, 1);
    // No same-run resubmission; a later run/attempt retries the bootstrap.
    assert.equal((await rig.prepare(identity)).status, "idle");
    const retry = requireRun(await rig.prepare(run(2)));
    assert.equal(retry.id, "2:1:repair");
    assert.equal(retry.purpose, "bootstrap");
    state = await rig.snapshot();
    assert.equal(state.hostedRuntimes[0].execution?.id, retry.id);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: unreviewed or unverified requests never move the pointer", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    const before = await rig.snapshot();
    // No completed review receipt -> not selectable; the now-immediately-due
    // ordinary work is what the dispatch starts instead.
    await rig.seedRepair([request], []);
    const dueOrdinary = requireRun(await rig.prepare(run(2)));
    assert.equal(dueOrdinary.purpose, "ordinary");
    rig.evidence.settlements.set(
      dueOrdinary.id,
      runProof(dueOrdinary, "healthy"),
    );
    assert.equal((await rig.finalize(run(2))).status, "idle");
    let state = await rig.snapshot();
    assert.equal(state.hostedReleases.length, 0);
    assert.equal(
      state.hostedRuntimes[0].activeRevision,
      before.hostedRuntimes[0].activeRevision,
    );
    assert.equal(
      state.hostedRuntimes[0].generation,
      before.hostedRuntimes[0].generation,
    );
    // A completed review exists but the source verifier refuses.
    await rig.seedRepair([request], [reviewReceipt(request)]);
    assert.equal((await rig.prepare(run(3))).status, "pending");
    state = await rig.snapshot();
    assert.equal(state.hostedReleases.length, 0);
    // Verifier transport failure is pending too.
    rig.evidence.requestFail = true;
    assert.equal((await rig.prepare(run(4))).status, "pending");
    state = await rig.snapshot();
    assert.equal(state.hostedReleases.length, 0);
    assert.equal(state.hostedRuntimes[0].activeRevision, LAUNCHER);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor PR110: trusted stale-base maintenance permits ordinary work without promotion", async () => {
  const rig = await makeRig();
  try {
    const active = "e4cef46332cf124a8c283d798a963cf5f66e45c2" as GitSha;
    const request = releaseRequest({
      id:
        "release:5e6390da3991207f7fb7cdd8f0fa5268c0e9daf0fe12c04d3e8e44245f09a5da",
      revision: "accc96c8e8eeb5cca71e9641f674a96bf75c77d1",
      source: {
        pullRequest: 110,
        reviewRequestId:
          "review-review:110:28e2aac95f0dbcc79b3c41333f5a2eb92194ccea:attempt-3",
        reviewReceiptId:
          "review-receipt:a62d1e2150592b28b358978f7c5781aff45dce6899dc668b67b72b97094b908e",
        head: "28e2aac95f0dbcc79b3c41333f5a2eb92194ccea",
        base: "2bca04186b3e462c63ba3d9ce996f4a5d3fd03b6",
      },
      createdAt: 1791208786131,
    });
    rig.clock.advance(1791208886131 - rig.clock.now());
    const boot = execution({ revision: active, generation: 63 });
    const proof = runProof(boot, "healthy");
    const seed = parseReleaseStateSnapshotV1({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: rig.clock.now(),
      releases: [],
      hostedReleases: [],
      githubCooldowns: [],
      hostedRuntimes: [{
        version: "v1",
        kind: "hosted_runtime",
        id: "ubiquity/sentinel:0:production",
        activeRevision: active,
        generation: 63,
        lastHealthyProof: proof,
        lastExecutionProof: proof,
        execution: null,
        nextOrdinaryAt: T0,
        createdAt: T0,
        updatedAt: rig.clock.now(),
      }],
    });
    await rig.seedCapturedRelease(seed);
    await rig.seedRepair([request], [reviewReceipt(request)]);
    const beforeRepair = await rig.repair.readRepair();
    assert.ok(beforeRepair.ok && beforeRepair.value.status === "found");
    const repairCapture = beforeRepair.value;
    const beforeRelease = await rig.release.readRelease();
    assert.ok(
      beforeRelease.ok && beforeRelease.value.status === "found",
      JSON.stringify(beforeRelease),
    );
    const releaseCapture = beforeRelease.value;
    let commitMode = "exact";
    const http = (wire: { url: string }) =>
      Promise.resolve({
        status: commitMode === "unavailable" ? 403 : 200,
        headers: new Headers(),
        bodyText: JSON.stringify(
          wire.url.endsWith("/pulls/110")
            ? {
              number: 110,
              state: "closed",
              merged: true,
              merge_commit_sha: request.revision,
              head: {
                sha: request.source.head,
                ref: "sentinel/repair/issue-98",
                repo: { full_name: "ubiquity/sentinel" },
              },
              base: {
                ref: "development",
                repo: { full_name: "ubiquity/sentinel" },
              },
            }
            : {
              sha: commitMode === "foreign" ? LAUNCHER : request.revision,
              parents: [{ sha: active }, { sha: request.source.head }],
            },
        ),
      });
    const client = new GitHubApiClient({
      repository: SELF,
      apiBaseUrl: "https://api.github.com",
      http,
      auth: {
        authorizationHeader: () => Promise.resolve(portOk("Bearer fixture")),
      },
      clock: rig.clock,
      cooldownGate: {
        beforeRequest: () => Promise.resolve(portOk(undefined)),
        recordRateLimit: () => Promise.resolve(portOk(undefined)),
      },
    });
    rig.evidence.verifyRequest = (value) =>
      client.verifyHostedReleaseRequest(value);
    assert.deepEqual(await rig.prepare(run(2)), {
      status: "pending",
      detail: "hosted supervisor release request is not verified",
    });
    const state = {
      readRepair: () => rig.repair.readRepair(),
      readRelease: () => rig.release.readRelease(),
      writeRepair: rig.repair.writeRepair.bind(rig.repair),
      readRepairAt: async (input: { commit: GitSha; expectedHead: GitSha }) => {
        assert.equal(input.commit, "50bb001920827e31816c0d7ed37b8143965c0cf7");
        const original = await rig.repair.readRepairAt!({
          commit: repairCapture.head,
          expectedHead: input.expectedHead,
        });
        assert.ok(original.ok && original.value.status === "found");
        return portOk({ ...original.value, head: input.commit });
      },
    };
    const maintenance = createMatrixUncertaintyMaintenance({
      state,
      clock: rig.clock,
      token: "fixture",
      http,
      artifactRoot: ROOT,
    });
    const deps: MatrixUncertaintyMaintenanceDepsV1 = {
      ...maintenance,
      state,
      confirmCompletedExecution: () => Promise.resolve(true),
      readExecution: () => Promise.resolve(portOk(proof)),
    };
    for (const mode of ["unavailable", "foreign"]) {
      commitMode = mode;
      await assert.rejects(
        () => runMatrixUncertaintyMaintenance(deps),
        /custody unavailable or changed/,
      );
      assert.deepEqual(await rig.repair.readRepair(), beforeRepair);
      assert.deepEqual(await rig.release.readRelease(), beforeRelease);
    }
    commitMode = "exact";
    const controls: Partial<MatrixUncertaintyMaintenanceDepsV1>[] = [
      { confirmCompletedExecution: () => Promise.resolve(false) },
      {
        readExecution: () =>
          Promise.resolve(
            portError("unavailable", "native evidence unavailable"),
          ),
      },
      {
        state: {
          ...state,
          readRepairAt: () =>
            Promise.resolve(
              portError("unavailable", "original custody unavailable"),
            ),
        },
      },
      {
        state: {
          ...state,
          readRelease: () =>
            Promise.resolve(portOk({
              ...releaseCapture,
              snapshot: {
                ...releaseCapture.snapshot,
                hostedRuntimes: releaseCapture.snapshot.hostedRuntimes.map((
                  row,
                ) => ({ ...row, execution: boot })),
              },
            })),
        },
      },
      {
        state: {
          ...state,
          writeRepair: () =>
            Promise.resolve(
              portOk({ status: "conflict", currentHead: repairCapture.head }),
            ),
        },
      },
      {
        state: {
          ...state,
          writeRepair: () =>
            Promise.resolve(
              portOk({ status: "ambiguous", currentHead: repairCapture.head }),
            ),
        },
      },
      {
        state: {
          ...state,
          writeRepair: () =>
            Promise.resolve(portOk({ status: "applied", head: LAUNCHER })),
        },
      },
    ];
    // A recorded execution means the main hosted flow owns settlement: the
    // optional historical quarantine yields gracefully (no claim, no state
    // change) instead of refusing. Every other degraded control still fails
    // closed.
    const executionControl = controls[3];
    for (const [index, control] of controls.entries()) {
      if (index === 3) {
        const yielded = await runMatrixUncertaintyMaintenance({
          ...deps,
          ...executionControl,
        });
        assert.equal(yielded.quarantined, 0);
        assert.equal(yielded.beforeHead, yielded.appliedHead);
      } else {
        await assert.rejects(
          () => runMatrixUncertaintyMaintenance({ ...deps, ...control }),
          /custody unavailable or changed/,
        );
      }
      assert.deepEqual(await rig.repair.readRepair(), beforeRepair);
      assert.deepEqual(await rig.release.readRelease(), beforeRelease);
    }
    await runMatrixUncertaintyMaintenance(deps);
    const after = await rig.repair.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(after.value.snapshot.releaseRequests[0].status, "cancelled");
    assert.deepEqual(
      after.value.snapshot.reviews,
      beforeRepair.value.snapshot.reviews,
    );
    assert.deepEqual(
      after.value.snapshot.work,
      beforeRepair.value.snapshot.work,
    );
    assert.deepEqual(
      after.value.snapshot.reservations,
      beforeRepair.value.snapshot.reservations,
    );
    assert.deepEqual(await rig.release.readRelease(), beforeRelease);
    await runMatrixUncertaintyMaintenance({ ...maintenance, state });
    assert.deepEqual(await rig.repair.readRepair(), after);
    const ordinary = requireRun(await rig.prepare(run(2)));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, active);
    assert.equal(ordinary.generation, 63);
    assert.equal((await rig.snapshot()).hostedReleases.length, 0);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: a competing CAS write is never overwritten", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    let writes = 0;
    const state: StateReadView & ReleaseStateWriter = {
      readRelease: rig.release.readRelease.bind(rig.release),
      readRepair: rig.release.readRepair.bind(rig.release),
      writeRelease: async (next, expectedHead) => {
        writes++;
        if (writes === 2) {
          const read = await rig.release.readRelease();
          if (read.ok && read.value.status === "found") {
            const current = read.value.snapshot;
            await rig.release.writeRelease({
              ...current,
              sequence: current.sequence + 1,
              updatedAt: current.updatedAt + 1,
              stateHead: read.value.head,
            }, read.value.head);
          }
        }
        return rig.release.writeRelease(next, expectedHead);
      },
    };
    const result = await runHostedSupervisorPrepare({
      ...DORMANT_HOSTED_POLICIES,
      clock: rig.clock,
      state,
      run: run(1),
      evidence: rig.evidence,
    });
    assert.equal(result.status, "pending");
    const snapshot = await rig.snapshot();
    // The unrelated competing snapshot survives; no execution was written.
    assert.equal(snapshot.sequence, 2);
    assert.equal(snapshot.hostedRuntimes[0].execution, null);
    assert.equal(snapshot.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(snapshot.hostedRuntimes[0].generation, 1);
    // The competing snapshot is one millisecond newer; the monotonic clock
    // must have advanced before the next write.
    rig.clock.advance(1);
    // A later clean prepare creates the bootstrap execution normally.
    assert.equal(requireRun(await rig.prepare(run(2))).purpose, "bootstrap");
  } finally {
    await rig.cleanup();
  }
});
