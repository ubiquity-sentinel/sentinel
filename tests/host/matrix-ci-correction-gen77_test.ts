/**
 * Rollback safety of the open hosted CI correction route against generation
 * 77. A cell the generation-78 hosted planner grants is consumed by a later
 * run, and after a failed generation 78 that consumer is generation 77's own
 * code (R77 ab3613e02), which keeps the route closed. Every case below runs
 * R77's own modules and fixtures, extracted from the pinned commit: R77's
 * consumer authenticates the CI correction cell and isolates it as a runtime
 * mismatch (never a generic refusal that would fail every later run), its
 * isolation parks the record with the original charge retained, and its
 * hosted planner leaves an awaiting correction or a stale correction intent
 * exactly as it found them. The cases are ignored in a checkout without R77.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { type GitHubCheckV1, portOk } from "../../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { MatrixHistoricalRuntimeMismatch } from "../../src/host/matrix-artifact-port.ts";
import type { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import type { recoverWithHistoricalIsolation } from "../../src/host/matrix-historical-isolation.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import type { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import { isCiCorrectionFinding } from "../../src/repair/ci-rejection.ts";
import { implementationIntent } from "../../src/repair/loop-implementation.ts";
import { STALE_IMPLEMENTATION_INTENT_TTL_MS } from "../../src/repair/loop-eligibility.ts";
import { reservation, SHA2, T0, workRecord } from "../state/helpers.ts";
import type * as StateHelpers from "../state/helpers.ts";
import { completedReceipt } from "../repair/loop-review-fixtures.ts";
import type * as ArtifactFixtures from "./matrix-artifact-fixtures.ts";
import type * as RuntimeFixtures from "./matrix-runtime-fixtures.ts";
import { makeRig, seedSnapshot, snapshot } from "./matrix-runtime-fixtures.ts";
import { gen77Available, loadGen77Modules } from "./gen77-runtime-source.ts";

type Finding = { severity: string; path: string | null; message: string };
type Rig = Awaited<ReturnType<typeof ArtifactFixtures.fixture>>;
type RecoverInput = Parameters<
  ReturnType<typeof createActionsMatrixArtifactTransport>["recover"]
>[0];
type Transport = { recover(input: RecoverInput): Promise<unknown> };

const available = await gen77Available();

/** R77's own consumer, isolation, fixtures and parsers. */
interface Gen77V1 {
  factory: typeof createActionsMatrixArtifactTransport;
  Mismatch: typeof MatrixHistoricalRuntimeMismatch;
  isolate: typeof recoverWithHistoricalIsolation;
  digest: typeof matrixDigestV1;
  isCiCorrectionFinding: typeof isCiCorrectionFinding;
  hostedCiCorrections: boolean;
  parse: typeof parseRepairStateSnapshotV1;
  fixtures: typeof ArtifactFixtures;
  helpers: typeof StateHelpers;
  dispose(): Promise<void>;
}

async function loadGen77(): Promise<Gen77V1> {
  const loaded = await loadGen77Modules([
    "src/host/matrix-artifacts.ts",
    "src/host/matrix-artifact-port.ts",
    "src/host/matrix-historical-isolation.ts",
    "src/contracts/matrix.ts",
    "src/repair/ci-rejection.ts",
    "src/contracts/state-snapshots.ts",
    "tests/host/matrix-artifact-fixtures.ts",
    "tests/state/helpers.ts",
  ]);
  const [artifacts, port, isolation, matrix, ci, snapshots, fixtures, helpers] =
    loaded.modules;
  return {
    factory: artifacts
      .createActionsMatrixArtifactTransport as Gen77V1["factory"],
    Mismatch: port.MatrixHistoricalRuntimeMismatch as Gen77V1["Mismatch"],
    isolate: isolation.recoverWithHistoricalIsolation as Gen77V1["isolate"],
    digest: matrix.matrixDigestV1 as Gen77V1["digest"],
    isCiCorrectionFinding: ci
      .isCiCorrectionFinding as Gen77V1["isCiCorrectionFinding"],
    hostedCiCorrections: ci.HOSTED_CI_CORRECTIONS as boolean,
    parse: snapshots.parseRepairStateSnapshotV1 as Gen77V1["parse"],
    fixtures: fixtures as unknown as typeof ArtifactFixtures,
    helpers: helpers as unknown as typeof StateHelpers,
    dispose: loaded.dispose,
  };
}

function check(
  name: string,
  head: GitSha,
  conclusion: GitHubCheckV1["conclusion"],
): GitHubCheckV1 {
  return {
    name,
    status: "completed",
    conclusion,
    head,
    startedAt: T0,
    completedAt: T0 + 1,
  };
}

/**
 * This tree's hosted planner over a reviewed head awaiting its CI correction,
 * whose live `validate` failure the reviewed base shows as `baseConclusion`.
 */
async function hostedPlan(baseConclusion: GitHubCheckV1["conclusion"]) {
  const rig = await makeRig([401], 1);
  try {
    const record = workRecord("issue-401", {
      source: { kind: "issue", id: "401", revision: rig.base },
      related: { incidentId: null, issueNumber: 401 },
      target: {
        base: rig.base,
        branch: "sentinel/repair/issue-401",
        checkpoint: null,
        head: SHA2,
        pr: 7,
      },
      nextStep: "work",
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
      firstSeenAt: T0 - 60_000,
    });
    const seeded = parseRepairStateSnapshotV1({
      ...seedSnapshot([record]),
      reviews: [completedReceipt(7, SHA2, rig.base)],
    });
    const written = await rig.store.writeRepair(seeded, null);
    assert.ok(written.ok && written.value.status === "applied");
    const checks: Record<string, GitHubCheckV1[]> = {
      [SHA2]: [check("validate", SHA2, "failure")],
      [rig.base]: [check("validate", rig.base, baseConclusion)],
    };
    rig.github.readChecks = (head: GitSha) =>
      Promise.resolve(portOk({ head, checks: checks[head] ?? [] }));
    const report = await planMatrixWave(
      { ...rig.deps, externalImplementations: true },
      rig.planOptions(),
    );
    return {
      cells: report.plan.cells,
      base: rig.base,
      written: await snapshot(rig),
    };
  } finally {
    await rig.cleanup();
  }
}

/** The open hosted planner's CI correction grant (a live candidate failure). */
async function hostedPlannerRequest() {
  const planned = await hostedPlan("success");
  assert.equal(planned.cells.length, 1, JSON.stringify(planned.cells));
  return { ...planned, request: planned.cells[0].request };
}

/** Re-bind R77's fixture wave to one correction request and its digests. */
async function bindCorrection(gen77: Gen77V1, rig: Rig, findings: Finding[]) {
  const { bytes, ISO, zip } = gen77.fixtures;
  rig.repair.work[0].target.head = gen77.helpers.SHA2;
  rig.repair.work[0].target.pr = 12;
  rig.repair.work[0].createdAt = T0 - 10_000;
  rig.cell.request.checkoutBase = gen77.helpers.SHA2;
  rig.cell.request.reviewFindings = findings;
  rig.cell.requestDigest = await gen77.digest(rig.cell.request);
  rig.result.requestDigest = rig.cell.requestDigest;
  rig.result.bundle!.head = gen77.helpers.SHA3;
  rig.result.receipt!.candidate!.head = gen77.helpers.SHA3;
  rig.plannerMarker.planDigest = await gen77.digest(rig.plan);
  rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
  rig.cellMarker.resultDigest = await gen77.digest(rig.result);
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

/** A completed clean review of SHA2 on PR 12 against `base`. */
function cleanReview(gen77: Gen77V1, base: GitSha) {
  return gen77.helpers.reviewReceipt("accepted-review", {
    pullRequest: { number: 12, head: gen77.helpers.SHA2, base },
    outcome: "completed",
    observedReviewer: "chatgpt-codex-connector[bot]",
    resultId: "accepted-result",
    findings: [],
    unresolvedSeverities: [],
    submittedAt: T0 - 2_000,
    completedAt: T0 - 1_000,
    observedAt: T0 - 500,
  });
}

/** A later R77 consumer run over the generation-78 producer's wave. */
function historical(gen77: Gen77V1, rig: Rig): RecoverInput {
  return {
    ...rig.input,
    currentRun: undefined,
    runtimeSha: gen77.helpers.SHA3,
    consumerRun: { ...gen77.fixtures.RUN, runId: 99, runAttempt: 1 },
  };
}

function transport77(gen77: Gen77V1, rig: Rig): Transport {
  const transport = gen77.factory({
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

async function recover77(gen77: Gen77V1, rig: Rig): Promise<unknown> {
  try {
    return await transport77(gen77, rig).recover(historical(gen77, rig));
  } catch (error) {
    return error;
  }
}

Deno.test({
  name:
    "rollback to generation 77: R77 isolates the open hosted planner's CI correction cell and keeps its charge",
  ignore: !available,
  async fn(t) {
    const gen77 = await loadGen77();
    try {
      assert.equal(gen77.hostedCiCorrections, false, "R77 keeps it closed");
      const planned = await hostedPlannerRequest();
      const finding = planned.request.reviewFindings![0];
      await t.step("the open hosted planner grants a CI correction", () => {
        assert.equal(planned.request.checkoutBase, SHA2);
        assert.equal(planned.request.base, planned.base);
        assert.ok(isCiCorrectionFinding(finding));
        assert.ok(gen77.isCiCorrectionFinding(finding), "R77 reads it as CI");
        const work = planned.written.work[0];
        assert.equal(work.intent?.kind, "implementation");
        assert.equal(planned.written.reservations[0].purpose, "retry");
        assert.equal(planned.written.reservations[0].outcome, "reserved");
        const reread = gen77.parse(structuredClone(planned.written));
        assert.deepEqual(reread.work, planned.written.work);
        assert.deepEqual(reread.reservations, planned.written.reservations);
      });
      await t.step(
        "a base that turned red returns the head to delivery uncharged",
        async () => {
          const returned = await hostedPlan("failure");
          assert.equal(returned.cells.length, 0);
          assert.equal(returned.written.work[0].nextStep, "delivery");
          assert.deepEqual(returned.written.reservations, []);
          const reread = gen77.parse(structuredClone(returned.written));
          assert.deepEqual(reread.work, returned.written.work);
        },
      );
      await t.step(
        "R77's consumer raises its own runtime mismatch",
        async () => {
          const rig = await gen77.fixtures.fixture();
          try {
            rig.repair.reviews.push(cleanReview(gen77, gen77.helpers.SHA1));
            await bindCorrection(gen77, rig, [finding]);
            const outcome = await recover77(gen77, rig);
            assert.ok(outcome instanceof gen77.Mismatch, String(outcome));
            const affected = outcome.evidence.affected;
            assert.equal(affected.length, 1);
            assert.equal(affected[0].reservation.outcome, "reserved");
            assert.equal(affected[0].work.intent?.kind, "implementation");
            assert.equal(affected[0].work.target.head, gen77.helpers.SHA2);
          } finally {
            await Deno.remove(rig.tmp, { recursive: true });
          }
        },
      );
      await t.step(
        "R77's isolation parks the record with the admission retained",
        async () => {
          const rig = await gen77.fixtures.fixture();
          try {
            rig.repair.reviews.push(cleanReview(gen77, gen77.helpers.SHA1));
            await bindCorrection(gen77, rig, [finding]);
            const before = structuredClone(rig.repair);
            const writes: RepairStateSnapshotV1[] = [];
            const recovered = await gen77.isolate(
              {
                state: {
                  ...rig.state,
                  writeRepair: (next) => {
                    writes.push(structuredClone(next));
                    return Promise.resolve(
                      portOk({
                        status: "applied" as const,
                        head: gen77.helpers.SHA3,
                      }),
                    );
                  },
                },
                clock: { now: () => T0 + 10_000 },
              },
              transport77(gen77, rig) as never,
              historical(gen77, rig),
            );
            assert.deepEqual(recovered, [], "nothing is ingested");
            assert.equal(writes.length, 1);
            const work = writes[0].work[0];
            assert.equal(work.nextStep, "blocked");
            assert.match(
              work.blocker?.message ?? "",
              new RegExp(
                `^authenticated historical matrix runtime mismatch; producer=71:2; runtime=${
                  "2".repeat(40)
                }; .*; original admission retained$`,
              ),
            );
            assert.deepEqual(work.intent, before.work[0].intent);
            assert.deepEqual(work.target, before.work[0].target);
            assert.deepEqual(work.counters, before.work[0].counters);
            assert.deepEqual(
              writes[0].reservations,
              before.reservations,
              "the charge stays reserved: never refunded",
            );
            gen77.parse(structuredClone(writes[0]));
          } finally {
            await Deno.remove(rig.tmp, { recursive: true });
          }
        },
      );
    } finally {
      await gen77.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 77: CI cells the planner never grants are R77's generic refusal",
  ignore: !available,
  async fn(t) {
    // The planner grants a CI correction only for a head reviewed clean
    // against the record's exact base; these controls prove R77's per-cell
    // check is what isolates the planned shape.
    const gen77 = await loadGen77();
    try {
      const finding = (await hostedPlannerRequest()).request.reviewFindings![0];
      for (
        const [name, reviews] of [
          ["no review of the head", []],
          ["a clean review against another base", [
            cleanReview(gen77, gen77.helpers.SHA3),
          ]],
        ] as const
      ) {
        await t.step(name, async () => {
          const rig = await gen77.fixtures.fixture();
          try {
            rig.repair.reviews.push(...reviews);
            await bindCorrection(gen77, rig, [finding]);
            const refused = await recover77(gen77, rig);
            assert.ok(refused instanceof Error, String(refused));
            assert.ok(!(refused instanceof gen77.Mismatch));
            assert.match(
              String(refused),
              /provenance unavailable or conflicting/,
            );
          } finally {
            await Deno.remove(rig.tmp, { recursive: true });
          }
        });
      }
    } finally {
      await gen77.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 77: R77's hosted planner leaves an awaiting correction and a stale correction intent untouched",
  ignore: !available,
  async fn(t) {
    const loaded = await loadGen77Modules([
      "src/host/matrix.ts",
      "tests/host/matrix-runtime-fixtures.ts",
    ]);
    const plan77 = loaded.modules[0].planMatrixWave as typeof planMatrixWave;
    const fixtures77 = loaded.modules[1] as unknown as typeof RuntimeFixtures;
    try {
      for (const stale of [false, true]) {
        await t.step(stale ? "stale intent" : "awaiting", async () => {
          const rig = await fixtures77.makeRig([401], 1);
          try {
            let record = workRecord("issue-401", {
              source: { kind: "issue", id: "401", revision: rig.base },
              related: { incidentId: null, issueNumber: 401 },
              target: {
                base: rig.base,
                branch: "sentinel/repair/issue-401",
                checkpoint: null,
                head: SHA2,
                pr: 7,
              },
              nextStep: "work",
              counters: {
                attempts: stale ? 2 : 1,
                retries: 0,
                reviewRounds: 1,
              },
              firstSeenAt: T0 - 60_000,
            });
            const charges: ReturnType<typeof reservation>[] = [];
            if (stale) {
              // Generation 78's granted correction, past the stale timeout.
              const id = "e".repeat(64);
              const started = rig.clock.now() -
                STALE_IMPLEMENTATION_INTENT_TTL_MS - 60_000;
              record = {
                ...record,
                intent: implementationIntent(id, record, started),
              };
              charges.push(reservation(id, {
                taskId: record.id,
                head: rig.base,
                attempt: 2,
                purpose: "retry",
                outcome: "reserved",
                settledAt: null,
                createdAt: started,
              }));
            }
            const seeded = parseRepairStateSnapshotV1({
              ...fixtures77.seedSnapshot([record]),
              reviews: [completedReceipt(7, SHA2, rig.base)],
              reservations: charges,
            });
            const written = await rig.store.writeRepair(seeded, null);
            assert.ok(written.ok && written.value.status === "applied");
            const reads: string[] = [];
            const checks: Record<string, GitHubCheckV1[]> = {
              [SHA2]: [check("validate", SHA2, "failure")],
              [rig.base]: [check("validate", rig.base, "success")],
            };
            rig.github.readChecks = (head: GitSha) => {
              reads.push(head);
              return Promise.resolve(
                portOk({ head, checks: checks[head] ?? [] }),
              );
            };
            const before = await fixtures77.snapshot(rig);
            const report = await plan77(
              { ...rig.deps, externalImplementations: true },
              rig.planOptions(),
            );
            assert.equal(report.plan.cells.length, 0, JSON.stringify(report));
            assert.deepEqual(await fixtures77.snapshot(rig), before);
            assert.deepEqual(reads, [], "no check is read");
          } finally {
            await rig.cleanup();
          }
        });
      }
    } finally {
      await loaded.dispose();
    }
  },
});
