/**
 * Rollback safety of the OPEN hosted conflict-resolution cell against
 * generation 78. A conflict cell the generation-79 hosted planner grants is
 * consumed by a later run, and after a failed generation 79 that consumer is
 * R78's own code (474f87eb6), which keeps the hosted route closed. Every case
 * runs R78's own modules and fixtures, extracted from the pinned commit:
 *
 * - R78's strict plan parser accepts the planner's exact conflict request;
 * - R78's consumer authenticates the bound conflict cell (its wave gate
 *   checks the marker against the merged base) and raises its own runtime
 *   mismatch, never a generic refusal that would fail every later run;
 * - R78's isolation parks the record with the original admission retained:
 *   the marked intent and the `reserved` charge, never refunded;
 * - this tree's launcher passes then leave the isolated record alone: the
 *   mismatch disposition retains it (a candidate head is present), the retry
 *   table's marker guard falls through to a class that refuses an unsettled
 *   charge, and neither re-admission rule matches it.
 *
 * The cases are ignored in a checkout without R78.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type {
  parseRepairStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type {
  matrixDigestV1,
  parseMatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import type { MatrixHistoricalRuntimeMismatch } from "../../src/host/matrix-artifact-port.ts";
import type { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import type { recoverWithHistoricalIsolation } from "../../src/host/matrix-historical-isolation.ts";
import type { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import { conflictMarkerBase } from "../../src/repair/conflict-resolution.ts";
import { planHostedRetries } from "../../ops/hosted-autonomy.ts";
import { collectMismatchDispositionCandidatesV1 } from "../../ops/runtime-mismatch-recovery-disposition.ts";
import { planConflictReadmissions } from "../../ops/hosted-autonomy-conflict-retries.ts";
import { planBaseRefreshReadmissions } from "../../ops/hosted-autonomy-base-refresh-retries.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import { T0 } from "../state/helpers.ts";
import type * as StateHelpers from "../state/helpers.ts";
import type * as ArtifactFixtures from "./matrix-artifact-fixtures.ts";
import { gen78Available, loadGen78Modules } from "./gen77-runtime-source.ts";
import { releaseAt } from "./hosted-autonomy-preservation-fixtures.ts";
import { hostedConflictRig } from "./matrix-conflict-hosted-rig.ts";

type Rig = Awaited<ReturnType<typeof ArtifactFixtures.fixture>>;
type RecoverInput = Parameters<
  ReturnType<typeof createActionsMatrixArtifactTransport>["recover"]
>[0];
type Transport = { recover(input: RecoverInput): Promise<unknown> };

const available = await gen78Available();
const MERGE = "4".repeat(40) as GitSha;

/** R78's own consumer, isolation, fixtures and parsers. */
interface Gen78V1 {
  factory: typeof createActionsMatrixArtifactTransport;
  Mismatch: typeof MatrixHistoricalRuntimeMismatch;
  isolate: typeof recoverWithHistoricalIsolation;
  digest: typeof matrixDigestV1;
  parsePlan: typeof parseMatrixPlanV1;
  marker: typeof conflictMarker;
  hostedRouteOpen: boolean;
  parse: typeof parseRepairStateSnapshotV1;
  fixtures: typeof ArtifactFixtures;
  helpers: typeof StateHelpers;
  dispose(): Promise<void>;
}

async function loadGen78(): Promise<Gen78V1> {
  const loaded = await loadGen78Modules([
    "src/host/matrix-artifacts.ts",
    "src/host/matrix-artifact-port.ts",
    "src/host/matrix-historical-isolation.ts",
    "src/contracts/matrix.ts",
    "src/repair/conflict-resolution.ts",
    "src/contracts/state-snapshots.ts",
    "tests/host/matrix-artifact-fixtures.ts",
    "tests/state/helpers.ts",
  ]);
  const [
    artifacts,
    port,
    isolation,
    matrix,
    conflict,
    snapshots,
    fixtures,
    helpers,
  ] = loaded.modules;
  return {
    factory: artifacts
      .createActionsMatrixArtifactTransport as Gen78V1["factory"],
    Mismatch: port.MatrixHistoricalRuntimeMismatch as Gen78V1["Mismatch"],
    isolate: isolation.recoverWithHistoricalIsolation as Gen78V1["isolate"],
    digest: matrix.matrixDigestV1 as Gen78V1["digest"],
    parsePlan: matrix.parseMatrixPlanV1 as Gen78V1["parsePlan"],
    marker: conflict.conflictMarker as Gen78V1["marker"],
    hostedRouteOpen: conflict.HOSTED_CONFLICT_RESOLUTIONS as boolean,
    parse: snapshots.parseRepairStateSnapshotV1 as Gen78V1["parse"],
    fixtures: fixtures as unknown as typeof ArtifactFixtures,
    helpers: helpers as unknown as typeof StateHelpers,
    dispose: loaded.dispose,
  };
}

/**
 * Re-bind R78's fixture wave to one conflict-resolution cell exactly as the
 * open hosted planner grants it (published candidate H=SHA2 on PR 12, the
 * marker naming the merged base) and every digest over it.
 */
async function bindConflict(gen78: Gen78V1, rig: Rig) {
  const { bytes, ISO, zip } = gen78.fixtures;
  const work = rig.repair.work[0];
  work.target.head = gen78.helpers.SHA2;
  work.target.pr = 12;
  work.createdAt = T0 - 10_000;
  work.intent!.failure = gen78.marker(MERGE, T0);
  rig.cell.request.checkoutBase = gen78.helpers.SHA2;
  rig.cell.request.mergeBase = MERGE;
  rig.cell.requestDigest = await gen78.digest(rig.cell.request);
  rig.result.requestDigest = rig.cell.requestDigest;
  rig.result.bundle!.head = gen78.helpers.SHA3;
  rig.result.receipt!.candidate!.head = gen78.helpers.SHA3;
  rig.plannerMarker.planDigest = await gen78.digest(rig.plan);
  rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
  rig.cellMarker.resultDigest = await gen78.digest(rig.result);
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

/** A later R78 consumer run over the generation-79 producer's wave. */
function historical(gen78: Gen78V1, rig: Rig): RecoverInput {
  return {
    ...rig.input,
    currentRun: undefined,
    runtimeSha: gen78.helpers.SHA3,
    consumerRun: { ...gen78.fixtures.RUN, runId: 99, runAttempt: 1 },
  };
}

function transport78(gen78: Gen78V1, rig: Rig): Transport {
  const transport = gen78.factory({
    state: rig.state,
    token: "fake-local-token",
    http: rig.http,
    clock: { now: () => T0 + 10_000 },
    artifactRoot: `${rig.tmp}/recovered`,
  });
  return {
    async recover(input: RecoverInput) {
      const cwd = Deno.cwd();
      Deno.chdir(`${rig.tmp}/checkout`);
      try {
        return await transport.recover(input);
      } finally {
        Deno.chdir(cwd);
      }
    },
  };
}

Deno.test({
  name:
    "rollback to generation 78: R78 parses the open hosted planner's conflict plan",
  ignore: !available,
  async fn() {
    const gen78 = await loadGen78();
    const rig = await hostedConflictRig();
    try {
      assert.equal(gen78.hostedRouteOpen, false, "R78 keeps it closed");
      await rig.runLoop();
      const planned = await rig.plan();
      assert.equal(planned.plan.cells.length, 1);
      const reread = gen78.parsePlan(structuredClone(planned.plan));
      assert.deepEqual(reread, planned.plan);
      assert.equal(reread.cells[0].request.mergeBase, rig.ctx.base);
      assert.equal(reread.cells[0].request.checkoutBase, rig.ctx.head);
      const state = await rig.hosted.snapshot();
      assert.deepEqual(gen78.parse(structuredClone(state)), state);
    } finally {
      await rig.cleanup();
      await gen78.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 78: R78 isolates a generation-79 conflict cell with its charge retained, and the launcher leaves it alone",
  ignore: !available,
  async fn(t) {
    const gen78 = await loadGen78();
    try {
      await t.step(
        "R78's consumer raises its own runtime mismatch",
        async () => {
          const rig = await gen78.fixtures.fixture();
          try {
            await bindConflict(gen78, rig);
            let outcome: unknown;
            try {
              outcome = await transport78(gen78, rig).recover(
                historical(gen78, rig),
              );
            } catch (error) {
              outcome = error;
            }
            assert.ok(outcome instanceof gen78.Mismatch, String(outcome));
            const affected = outcome.evidence.affected;
            assert.equal(affected.length, 1);
            assert.equal(affected[0].reservation.outcome, "reserved");
            assert.equal(affected[0].work.intent?.kind, "implementation");
            assert.equal(conflictMarkerBase(affected[0].work.intent), MERGE);
          } finally {
            await Deno.remove(rig.tmp, { recursive: true });
          }
        },
      );

      let isolated: RepairStateSnapshotV1 | null = null;
      await t.step("R78's isolation retains the admission", async () => {
        const rig = await gen78.fixtures.fixture();
        try {
          await bindConflict(gen78, rig);
          const before = structuredClone(rig.repair);
          const writes: RepairStateSnapshotV1[] = [];
          const recovered = await gen78.isolate(
            {
              state: {
                ...rig.state,
                writeRepair: (next) => {
                  writes.push(structuredClone(next));
                  return Promise.resolve(
                    portOk({
                      status: "applied" as const,
                      head: gen78.helpers.SHA3,
                    }),
                  );
                },
              },
              clock: { now: () => T0 + 10_000 },
            },
            transport78(gen78, rig) as never,
            historical(gen78, rig),
          );
          assert.deepEqual(recovered, [], "nothing is ingested");
          assert.equal(writes.length, 1);
          const work = writes[0].work[0];
          assert.equal(work.nextStep, "blocked");
          assert.match(
            work.blocker?.message ?? "",
            /^authenticated historical matrix runtime mismatch; .*; original admission retained$/,
          );
          assert.deepEqual(work.intent, before.work[0].intent);
          assert.equal(conflictMarkerBase(work.intent), MERGE);
          assert.deepEqual(work.target, before.work[0].target);
          assert.deepEqual(work.counters, before.work[0].counters);
          assert.deepEqual(
            writes[0].reservations,
            before.reservations,
            "the charge stays reserved: never refunded",
          );
          gen78.parse(structuredClone(writes[0]));
          isolated = writes[0];
        } finally {
          await Deno.remove(rig.tmp, { recursive: true });
        }
      });

      await t.step("this tree's launcher passes leave it alone", async () => {
        assert.ok(isolated !== null);
        const snapshot: RepairStateSnapshotV1 = isolated;
        const record = snapshot.work[0];
        const disposition = await collectMismatchDispositionCandidatesV1({
          snapshot,
          observationsFor: () => ({
            readRefAbsent: () => Promise.resolve(true),
            listPullsByHead: () => Promise.resolve([]),
            readRunTerminal: () => Promise.resolve(true),
          }),
          producerTerminal: () => Promise.resolve(true),
        });
        assert.deepEqual(disposition.bindings, []);
        assert.deepEqual(disposition.retained, [{
          id: record.id,
          reason: "candidate head present",
        }]);
        for (const tip of [MERGE, gen78.helpers.SHA3, null]) {
          const denials: string[] = [];
          const plans = planHostedRetries(
            snapshot,
            T0 + 60 * 60_000,
            gen78.helpers.SHA3,
            new Map([[hostedRepositoryKey(record.repository), tip]]),
            new Set(),
            (denial) => denials.push(denial.reason),
          );
          assert.deepEqual(plans, [], `tip ${tip}`);
          assert.deepEqual(denials, [], "an unsettled charge is not spent");
        }
        const opener = "9".repeat(40);
        const release = releaseAt({
          revision: opener,
          generation: 79,
          healthy: {
            revision: opener,
            generation: 79,
            createdAt: T0,
            observedAt: T0 + 1000,
          },
        });
        assert.deepEqual(
          planConflictReadmissions(snapshot, release, new Set(), undefined, [
            { revision: opener, activatedNotBefore: T0 + 60 * 60_000 },
          ]),
          [],
        );
        assert.deepEqual(
          planBaseRefreshReadmissions(snapshot, opener as GitSha, new Set()),
          [],
        );
      });
    } finally {
      await gen78.dispose();
    }
  },
});
