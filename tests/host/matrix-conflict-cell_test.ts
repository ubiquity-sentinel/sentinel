/**
 * The hosted shape of a conflict resolution: a matrix cell. The trusted
 * planner grants it only on an open route (a runtime whose rollback target
 * consumes the cell). Generation 78 kept the hosted route closed because
 * generation 77 refuses the cell; generation 78's consumer accepts exactly the
 * bound cell (`matrix-conflict-gen78_test.ts` runs its own code), so this tree
 * opens the hosted route (`HOSTED_CONFLICT_RESOLUTIONS`) with generation 78 as
 * its rollback target. One wave grants at most
 * `HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE` conflict cells, the most a rollback
 * can isolate from it.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { MatrixHistoricalRuntimeMismatch } from "../../src/host/matrix-artifact-port.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import {
  conflictMarker,
  conflictMarkerBase,
  HOSTED_CONFLICT_RESOLUTIONS,
  HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE,
  pendingConflictResolution,
} from "../../src/repair/conflict-resolution.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { REPO, SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import { gen77Available, loadGen77Modules } from "../state/gen77-contracts.ts";
import { bytes, fixture, ISO, RUN, zip } from "./matrix-artifact-fixtures.ts";
import { makeRig, seedSnapshot, snapshot } from "./matrix-runtime-fixtures.ts";

const MERGE = "4".repeat(40) as GitSha;
const BRANCH = "sentinel/repair/issue-401";

/** A pending resolution of the published H=SHA2 on B0=SHA1 at the rig base. */
async function pendingRig() {
  const rig = await makeRig([401], 1);
  const operationKey = implementationIntentKey("cd".repeat(32));
  const record = workRecord("issue-401", {
    source: { kind: "issue", id: "401", revision: rig.base },
    related: { incidentId: null, issueNumber: 401 },
    target: {
      base: SHA1,
      branch: BRANCH,
      checkpoint: null,
      head: SHA2,
      pr: 7,
      candidateState: {
        preserved: {
          operationKey,
          base: SHA1,
          head: SHA2,
          ref: await candidatePreservationRef(
            REPO,
            "issue-401" as never,
            operationKey,
          ),
        },
        publishedHead: SHA2,
      },
    },
    nextStep: "work",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    intent: {
      kind: "base_refresh",
      key: baseRefreshIntentKey(7, SHA2, rig.base),
      startedAt: T0,
      branch: BRANCH,
      expectedHead: SHA2,
      observedBase: rig.base,
      pr: 7,
      requestId: null,
      resultId: null,
      failure: conflictMarker(rig.base, T0),
    },
    firstSeenAt: T0 - 60_000,
  });
  const written = await rig.store.writeRepair(
    parseRepairStateSnapshotV1(seedSnapshot([record])),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  rig.github.candidateRefs.set(`refs/heads/${BRANCH}`, SHA2);
  return rig;
}

Deno.test("matrix planner: an open route grants one conflict-resolution cell continuing H with B to merge", async () => {
  const rig = await pendingRig();
  try {
    const report = await planMatrixWave(rig.deps, rig.planOptions());
    assert.equal(report.plan.cells.length, 1, JSON.stringify(report));
    const request = report.plan.cells[0].request;
    assert.equal(request.base, SHA1, "the durable reviewed base");
    assert.equal(request.checkoutBase, SHA2, "the published candidate");
    assert.equal(request.mergeBase, rig.base, "the conflicting base tip");
    assert.equal(request.reviewFindings, undefined);
    const after = await snapshot(rig);
    assert.equal(after.work[0].intent?.kind, "implementation");
    assert.equal(conflictMarkerBase(after.work[0].intent), rig.base);
    assert.equal(after.reservations.length, 1, "one charged resolution");
    assert.equal(after.reservations[0].purpose, "retry");
    assert.equal(after.reservations[0].head, SHA1);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix planner: a hosted run grants the same single conflict-resolution cell", async () => {
  assert.equal(HOSTED_CONFLICT_RESOLUTIONS, true);
  const rig = await pendingRig();
  try {
    const report = await planMatrixWave(
      { ...rig.deps, externalImplementations: true },
      rig.planOptions(),
    );
    assert.equal(report.plan.cells.length, 1, JSON.stringify(report));
    const request = report.plan.cells[0].request;
    assert.equal(request.base, SHA1, "the durable reviewed base");
    assert.equal(request.checkoutBase, SHA2, "the published candidate");
    assert.equal(request.mergeBase, rig.base, "the conflicting base tip");
    const after = await snapshot(rig);
    assert.equal(conflictMarkerBase(after.work[0].intent), rig.base);
    assert.equal(after.reservations.length, 1, "one charged resolution");
    const again = await planMatrixWave(
      { ...rig.deps, externalImplementations: true },
      rig.planOptions(),
    );
    assert.equal(again.plan.cells.length, 0, "never a second cell");
    assert.deepEqual(await snapshot(rig), after);
  } finally {
    await rig.cleanup();
  }
});

/** `count` pending resolutions, each on its own published candidate. */
async function pendingWaveRig(count: number) {
  const numbers = Array.from({ length: count }, (_, i) => 411 + i);
  const rig = await makeRig(numbers, 1);
  const operationKey = implementationIntentKey("cd".repeat(32));
  const records = await Promise.all(numbers.map(async (number, i) => {
    const id = `issue-${number}`;
    const branch = `sentinel/repair/${id}`;
    rig.github.candidateRefs.set(`refs/heads/${branch}`, SHA2);
    return workRecord(id, {
      source: { kind: "issue", id: String(number), revision: rig.base },
      related: { incidentId: null, issueNumber: number },
      target: {
        base: SHA1,
        branch,
        checkpoint: null,
        head: SHA2,
        pr: 20 + i,
        candidateState: {
          preserved: {
            operationKey,
            base: SHA1,
            head: SHA2,
            ref: await candidatePreservationRef(
              REPO,
              id as never,
              operationKey,
            ),
          },
          publishedHead: SHA2,
        },
      },
      nextStep: "work",
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
      intent: {
        kind: "base_refresh",
        key: baseRefreshIntentKey(20 + i, SHA2, rig.base),
        startedAt: T0,
        branch,
        expectedHead: SHA2,
        observedBase: rig.base,
        pr: 20 + i,
        requestId: null,
        resultId: null,
        failure: conflictMarker(rig.base, T0),
      },
      firstSeenAt: T0 - 60_000,
    });
  }));
  const written = await rig.store.writeRepair(
    parseRepairStateSnapshotV1(seedSnapshot(records)),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  return rig;
}

Deno.test("matrix planner: one wave grants at most the per-wave cap of conflict-resolution cells; the rest stay pending, uncharged", async () => {
  assert.equal(HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE, 4);
  const rig = await pendingWaveRig(6);
  try {
    const deps = { ...rig.deps, externalImplementations: true };
    const first = await planMatrixWave(deps, rig.planOptions());
    assert.equal(first.plan.cells.length, 4, JSON.stringify(first));
    assert.ok(
      first.plan.cells.every((cell) => cell.request.mergeBase === rig.base),
    );
    const after = await snapshot(rig);
    assert.equal(after.reservations.length, 4, "four charged resolutions");
    const waiting = after.work.filter((work) =>
      pendingConflictResolution(work.intent) !== null
    );
    assert.equal(waiting.length, 2, "the rest stay pending, uncharged");
    const second = await planMatrixWave(deps, {
      ...rig.planOptions(),
      waveId: "wave-conflict-cap-2",
    });
    assert.equal(second.plan.cells.length, 2, JSON.stringify(second));
    assert.equal((await snapshot(rig)).reservations.length, 6);
  } finally {
    await rig.cleanup();
  }
});

type Rig = Awaited<ReturnType<typeof fixture>>;
type RecoverInput = Parameters<
  ReturnType<typeof createActionsMatrixArtifactTransport>["recover"]
>[0];
type Transport = { recover(input: RecoverInput): Promise<unknown> };

/** Re-bind the planner's conflict request and every digest over it. */
async function bindConflict(
  rig: Rig,
  options: { marker?: GitSha; findings?: boolean } = {},
) {
  const work = rig.repair.work[0];
  work.target.head = SHA2;
  work.target.pr = 12;
  work.createdAt = T0 - 10_000;
  work.intent!.failure = conflictMarker(options.marker ?? MERGE, T0);
  rig.cell.request.checkoutBase = SHA2;
  rig.cell.request.mergeBase = MERGE;
  if (options.findings === true) {
    rig.cell.request.reviewFindings = [{
      severity: "P1",
      path: null,
      message: "resolve",
    }];
  }
  rig.cell.requestDigest = await matrixDigestV1(rig.cell.request);
  rig.result.requestDigest = rig.cell.requestDigest;
  rig.result.bundle!.head = SHA3;
  rig.result.receipt!.candidate!.head = SHA3;
  rig.plannerMarker.planDigest = await matrixDigestV1(rig.plan);
  rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
  rig.cellMarker.resultDigest = await matrixDigestV1(rig.result);
  rig.logs.set(402, ISO + " " + JSON.stringify(rig.cellMarker) + "\n");
  await rig.setArchive(
    501,
    rig.planName,
    await zip([{ name: "plan.json", content: bytes(rig.plan) }]),
  );
  await rig.setArchive(
    502,
    rig.cellName,
    await zip([
      { name: "result.json", content: bytes(rig.result) },
      { name: rig.result.bundle!.file, content: rig.bundle },
    ]),
  );
}

/** A later consumer run of another runtime over the producer's wave. */
async function recoverWith(
  rig: Rig,
  factory: typeof createActionsMatrixArtifactTransport,
) {
  const transport = factory({
    state: rig.state,
    token: "fake-local-token",
    http: rig.http,
    clock: { now: () => T0 + 10_000 },
    artifactRoot: `${rig.tmp}/recovered`,
  }) as Transport;
  const cwd = Deno.cwd();
  Deno.chdir(`${rig.tmp}/checkout`);
  try {
    return await transport.recover({
      ...rig.input,
      currentRun: undefined,
      runtimeSha: SHA3,
      consumerRun: { ...RUN, runId: 99, runAttempt: 1 },
    });
  } catch (error) {
    return error;
  } finally {
    Deno.chdir(cwd);
  }
}

Deno.test("matrix consumer: a bound conflict cell passes the wave gate; a foreign marker or findings never do", async (t) => {
  for (
    const [name, options, accepted] of [
      ["bound cell", {}, true],
      ["marker names another base", { marker: SHA3 }, false],
      ["cell carries findings", { findings: true }, false],
    ] as const
  ) {
    await t.step(name, async () => {
      const rig = await fixture();
      try {
        await bindConflict(rig, options);
        const outcome = await recoverWith(
          rig,
          createActionsMatrixArtifactTransport,
        );
        if (accepted) {
          // Past the gate: only the authenticated runtime mismatch remains.
          assert.ok(
            outcome instanceof MatrixHistoricalRuntimeMismatch,
            String(outcome),
          );
        } else {
          assert.ok(outcome instanceof Error, String(outcome));
          assert.ok(!(outcome instanceof MatrixHistoricalRuntimeMismatch));
          assert.match(
            String(outcome),
            /provenance unavailable or conflicting/,
          );
        }
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test({
  name:
    "rollback: generation 77's consumer refuses a conflict cell outright (why generation 78 kept the hosted route closed)",
  ignore: !(await gen77Available()),
  async fn() {
    const gen77 = await loadGen77Modules([
      "src/host/matrix-artifacts.ts",
      "src/host/matrix-artifact-port.ts",
    ]);
    try {
      const factory77 = gen77.modules[0]
        .createActionsMatrixArtifactTransport as typeof createActionsMatrixArtifactTransport;
      const Mismatch77 = gen77.modules[1]
        .MatrixHistoricalRuntimeMismatch as typeof MatrixHistoricalRuntimeMismatch;
      const rig = await fixture();
      try {
        await bindConflict(rig);
        const refused = await recoverWith(rig, factory77);
        assert.ok(refused instanceof Error, String(refused));
        assert.ok(!(refused instanceof Mismatch77), "never isolatable");
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    } finally {
      await gen77.dispose();
    }
  },
});
