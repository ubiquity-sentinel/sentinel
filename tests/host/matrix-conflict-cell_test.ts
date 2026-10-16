/**
 * The hosted shape of a conflict resolution: a matrix cell. The trusted
 * planner grants it only on an open route (a runtime whose rollback target
 * consumes the cell); a hosted run of this tree keeps it closed
 * (`HOSTED_CONFLICT_RESOLUTIONS`) because generation 77 refuses the cell. This
 * tree's consumer accepts exactly the bound cell, so the runtime installed
 * after generation 78 may open the route with generation 78 as its rollback
 * target.
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

Deno.test("matrix planner: a hosted run grants no conflict-resolution cell while its rollback target refuses it", async () => {
  assert.equal(HOSTED_CONFLICT_RESOLUTIONS, false);
  const rig = await pendingRig();
  try {
    const before = await snapshot(rig);
    const report = await planMatrixWave(
      { ...rig.deps, externalImplementations: true },
      rig.planOptions(),
    );
    assert.equal(report.plan.cells.length, 0, JSON.stringify(report));
    assert.deepEqual(await snapshot(rig), before, "nothing charged or written");
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
    "rollback: generation 77's consumer refuses a conflict cell outright (why the hosted route stays closed)",
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
