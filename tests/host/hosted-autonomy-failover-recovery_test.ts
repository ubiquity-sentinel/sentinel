/**
 * Launcher (sentinel-supervisor maintenance) producer recovery of a live-like
 * stuck admission: the implementation intent and its reserved charge stay
 * pending because the producer's authenticated cell exported a receipt that
 * names the route's HTTP 429 failover model. Maintenance must settle it
 * through the ordinary consumer with the launcher's own trusted failover id,
 * charge nothing new, refund nothing and write only generation-76 shapes.
 */
import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  type MatrixCellResultV1,
  matrixDigestV1,
} from "../../src/contracts/matrix.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import {
  createGitBundleExporter,
  createGitBundleImporter,
} from "../../src/host/matrix-git.ts";
import { runHostedSupervisorFinalize } from "../../src/host/actions-supervisor.ts";
import { resolveModelRoute } from "../../src/host/model-route.ts";
import { createLocalRepositoryConfig } from "../../src/host/local.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import {
  type HostedAutonomyDepsV1,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import { RECOVERY_ROUTE_FAILOVER_MODEL } from "../../ops/hosted-autonomy-matrix-bindings.ts";
import { ATTEMPT_DETAIL_INCOMPLETE } from "../../src/repair/attempt-policy.ts";
import {
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
} from "../repair/helpers.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import { gitRun, makeRemoteCtx, T0 } from "../state/helpers.ts";
import { ENV, SELF_REPO } from "./hosted-autonomy-fixtures.ts";
import { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";
import {
  assertGeneration76Accepts,
  generation76Present,
  withGeneration76Parsers,
} from "./generation-76-contracts.ts";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);

Deno.test("failover recovery: the launcher failover id is the runtime route's own resolution", () => {
  // The hosted runtime resolves its route from a fixed named mapping that
  // never forwards SENTINEL_MODEL_FAILOVER_ID, so every production route
  // carries the resolver's default; the launcher reproduces it from source.
  assert.equal(
    RECOVERY_ROUTE_FAILOVER_MODEL,
    resolveModelRoute({}).failoverModel,
  );
  assert.equal(RECOVERY_ROUTE_FAILOVER_MODEL, "gpt-6-luna");
  // The resolver that decides the accepted failover id is protected from
  // model-produced candidates.
  assert.ok(
    createLocalRepositoryConfig().protectedPaths.includes(
      "src/host/model-route.ts",
    ),
  );
});

Deno.test("failover recovery: no hosted job or runtime route forwards a failover override", async () => {
  for (
    const file of [
      ".github/workflows/supervisor.yml",
      "src/host/actions-repair-host.ts",
      "src/host/hosted-runtime-child.ts",
      "src/host/hosted-runtime-main.ts",
      "src/host/hosted-runtime-identity.ts",
      "deno.json",
    ]
  ) {
    const text = await Deno.readTextFile(ROOT + file);
    assert.equal(
      text.includes("SENTINEL_MODEL_FAILOVER_ID"),
      false,
      `${file} would let a producer route diverge from the launcher's failover id`,
    );
  }
});

async function failoverRecoveryScenario(
  check: (written: unknown, exported: MatrixCellResultV1[]) => Promise<void>,
) {
  const targetRoot = await Deno.makeTempDir({
    prefix: "sentinel-failover-target-",
    dir: ROOT,
  });
  const target = await makeRemoteCtx(targetRoot, ENV);
  const checked = async (dir: string, args: string[]) => {
    const result = await gitRun(dir, args, ENV);
    assert(result.ok, result.stderr);
    return result.stdout.trim();
  };
  await Deno.writeTextFile(target.work + "/repair.txt", "original\n");
  await checked(target.work, ["add", "repair.txt"]);
  await checked(target.work, ["commit", "-q", "-m", "base"]);
  const base = await checked(target.work, ["rev-parse", "HEAD"]) as GitSha;
  const mirror = targetRoot + "/target-mirror";
  await checked(targetRoot, ["clone", "-q", target.work, mirror]);
  await Deno.writeTextFile(target.work + "/repair.txt", "candidate\n");
  await checked(target.work, ["add", "repair.txt"]);
  await checked(target.work, ["commit", "-q", "-m", "candidate"]);
  const candidate = await checked(target.work, ["rev-parse", "HEAD"]) as GitSha;
  const f = await historicalMalformedRig(
    true,
    2,
    true,
    true,
    false,
    true,
    base,
  );
  try {
    f.plan.plannedAt = T0 + 1000;
    await f.refreshPlan();
    const bundleFile = f.cells[1].cellId + ".bundle";
    const bundles = targetRoot + "/bundles";
    const exported = await createGitBundleExporter({
      repositoryDir: target.work,
      outputDir: bundles,
    }).create({ base, head: candidate, checkpointSha: null, file: bundleFile });
    assert(exported);
    // The installed generation-76 cell exports: the primary and the failover
    // were both throttled (a failed failover receipt), and a failover that
    // produced real work (a completed failover candidate).
    const results: MatrixCellResultV1[] = f.cells.map((cell, i) => ({
      version: "v1",
      kind: "matrix_cell_result",
      waveId: f.execution.id,
      run: f.nativeRun,
      runtimeSha: f.execution.revision,
      generation: f.execution.generation,
      cellId: cell.cellId,
      taskId: cell.taskId,
      repository: cell.repository,
      reservationId: cell.reservationId,
      intentKey: cell.intentKey,
      requestDigest: cell.requestDigest,
      status: "completed",
      receipt: {
        invocationId: "sanitized-" + cell.cellId,
        outcome: i === 0 ? "failed" : "completed",
        actual: {
          evidenceKind: "request-runtime",
          provider: "uos",
          threadId: "sanitized-thread-" + cell.cellId,
          turnId: "sanitized-turn-" + cell.cellId,
          terminalOrigin: "runtime",
          observedTerminalStatus: i === 0 ? "failed" : "completed",
          observedModel: RECOVERY_ROUTE_FAILOVER_MODEL,
          observedReasoning: "max",
          durationMs: 1000,
          outputChars: 1000,
        },
        candidate: i === 0 ? null : {
          head: candidate,
          checkpointSha: null,
          changedPaths: ["repair.txt"],
        },
        error: i === 0 ? "runtime_error" : null,
      },
      bundle: i === 0 ? null : {
        file: bundleFile,
        digest: exported.digest,
        head: candidate,
        checkpointSha: null,
      },
      detail: null,
      completedAt: T0 + 29_000,
    }));
    for (const [i, result] of results.entries()) {
      assert.equal(f.cells[i].request.model, "gpt-reserve");
      const writer = new ZipWriter(new Uint8ArrayWriter(), {
        useWebWorkers: false,
      });
      await writer.add(
        "result.json",
        new Uint8ArrayReader(
          new TextEncoder().encode(canonicalStringify(result)),
        ),
        { unixMode: 0o100600 },
      );
      if (result.bundle) {
        await writer.add(
          result.bundle.file,
          new Uint8ArrayReader(
            await Deno.readFile(bundles + "/" + result.bundle.file),
          ),
          { unixMode: 0o100600 },
        );
      }
      const bytes = await writer.close();
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
      ).map((b) => b.toString(16).padStart(2, "0")).join("");
      f.archives.set(502 + i, bytes);
      const artifact = f.artifacts.find((row) => row.id === 502 + i)!;
      artifact.size_in_bytes = bytes.length;
      artifact.digest = "sha256:" + digest;
      f.logs.set(
        402 + i,
        new Date(T0 + 29_000).toISOString() + " " + JSON.stringify({
          kind: "sentinel_matrix_cell",
          run: f.nativeRun,
          runtimeSha: f.execution.revision,
          generation: f.execution.generation,
          cellId: result.cellId,
          reservationId: result.reservationId,
          resultDigest: await matrixDigestV1(result),
          bundleDigest: result.bundle?.digest ?? null,
          status: "completed",
        }) + "\n",
      );
    }
    const release = createReleaseStateStore({
      scratchDir: f.rig.tmp + "/failover-finalize",
      remoteUrl: f.rig.tmp + "/remote.git",
    });
    assert.equal(
      (await runHostedSupervisorFinalize({
        state: release,
        clock: f.clock,
        run: f.nativeRun,
        evidence: {
          readExecution: f.historicalMatrix.readExecution,
          verifyRevision: () => Promise.resolve(portOk(true)),
          verifyRequest: () => Promise.resolve(portOk(false)),
        },
      })).status,
      "idle",
    );
    const config = repositoryConfig(undefined, undefined, {
      repository: SELF_REPO,
      protectedPaths: [],
      adapter: { kind: "github" },
      liveStartLimits: { perHour: null, perSevenDays: null },
    });
    f.github.readBaseTip = () => Promise.resolve(base);
    const model = new FakeModel();
    const github = new FakeGithub({ baseSha: base, openIssues: [] });
    const deps: HostedAutonomyDepsV1 = {
      state: f.rig.state,
      clock: f.clock,
      githubFor: f.rig.githubFor,
      historicalMatrix: f.historicalMatrix,
      closedMatrix: (state = f.rig.state) => {
        const gate = new HostedRepairCooldownGate({ state, clock: f.clock });
        const budget = new RollingStartBudget({
          state,
          clock: f.clock,
          configs: [config],
        });
        const client = new GitHubApiClient({
          repository: SELF_REPO,
          apiBaseUrl: "https://api.github.com",
          clock: f.clock,
          http: f.http,
          auth: {
            authorizationHeader: () =>
              Promise.resolve(portOk("Bearer offline-native-token")),
          },
          cooldownGate: gate,
        });
        return Promise.resolve({
          state,
          clock: f.clock,
          configs: [config],
          cycleFor: () => ({
            state,
            clock: f.clock,
            configs: [config],
            controllerSha: f.execution.revision,
            githubCooldown: gate,
            github,
            incidents: new FakeIncidents(),
            replay: new FakeReplay(),
            model,
            budget,
            externalImplementations: true,
          }),
          prepareTarget: () => Promise.resolve(),
          importerFor: (_, bundlesDir) =>
            createGitBundleImporter({ repositoryDir: mirror, bundlesDir }),
          transportFor: (readState) =>
            createActionsMatrixArtifactTransport({
              state: readState,
              clock: f.clock,
              token: "offline-native-token",
              artifactRoot: f.rig.tmp + "/failover-artifacts",
              http: f.http,
            }),
          readExecution: (execution) => client.readHostedExecution(execution),
        });
      },
    };
    const before = await f.rig.state.readRepair();
    const releaseBefore = await f.rig.state.readRelease();
    assert(before.ok && before.value.status === "found");
    // Live-like stuck admissions: pending work, implementation intent and a
    // still-reserved charge for every planned cell.
    const stuck: RepairStateSnapshotV1 = before.value.snapshot;
    for (const cell of f.cells) {
      const row = stuck.work.find((w) => w.id === cell.taskId)!;
      assert.equal(row.nextStep, "work");
      assert.equal(row.intent?.kind, "implementation");
      assert.equal(row.intent?.requestId, cell.reservationId);
      const charge = stuck.reservations.find((r) =>
        r.id === cell.reservationId
      )!;
      assert.equal(charge.outcome, "reserved");
    }
    const previous = Deno.cwd();
    Deno.chdir(f.checkout);
    let result;
    try {
      result = await runHostedAutonomy(deps);
    } finally {
      Deno.chdir(previous);
    }
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.ok(
      result.actions.includes("current-matrix:ingested:2"),
      JSON.stringify(result),
    );
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    const failed = after.value.snapshot.work.find((row) =>
      row.id === f.cells[0].taskId
    )!;
    assert.equal(failed.nextStep, "blocked");
    assert.equal(failed.blocker?.message, ATTEMPT_DETAIL_INCOMPLETE);
    const succeeded = after.value.snapshot.work.find((row) =>
      row.id === f.cells[1].taskId
    )!;
    assert.equal(succeeded.target.head, candidate);
    assert.equal(succeeded.intent?.kind, "candidate_preservation");
    assert.equal(
      await checked(mirror, ["rev-parse", candidate + "^{commit}"]),
      candidate,
    );
    // Nothing charged and nothing refunded: the same reservations, the two
    // settled admissions charged (ambiguous / submitted), the sibling intact.
    const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
    assert.deepEqual(
      ids(after.value.snapshot.reservations),
      ids(before.value.snapshot.reservations),
    );
    const outcome = (id: string) =>
      after.value.status === "found"
        ? after.value.snapshot.reservations.find((row) => row.id === id)!
        : null;
    assert.equal(outcome(f.cells[0].reservationId)?.outcome, "ambiguous");
    assert.equal(outcome(f.cells[1].reservationId)?.outcome, "submitted");
    for (const row of after.value.snapshot.reservations) {
      assert.notEqual(row.outcome, "confirmed_not_submitted");
      assert.equal(row.proofRef, null);
    }
    const sibling = f.records[2];
    assert.deepEqual(
      after.value.snapshot.work.find((row) => row.id === sibling.id),
      sibling,
    );
    assert.deepEqual(
      after.value.snapshot.reservations.find((row) =>
        row.id === sibling.intent!.requestId
      ),
      before.value.snapshot.reservations.find((row) =>
        row.id === sibling.intent!.requestId
      ),
    );
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    assert.deepEqual(model.requests, [], "maintenance never starts a model");
    assert.equal(github.pushes.length, 0);
    await check(after.value.snapshot, results);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
    await Deno.remove(targetRoot, { recursive: true });
  }
}

Deno.test("failover recovery: maintenance settles a stuck failover-named producer through the normal consumer", () =>
  failoverRecoveryScenario(() => Promise.resolve()));

Deno.test({
  name:
    "failover recovery: the maintenance settlement parses with generation-76 parsers",
  ignore: !generation76Present(),
  fn: () =>
    failoverRecoveryScenario((written, exported) =>
      withGeneration76Parsers((gen76) => {
        assertGeneration76Accepts(
          gen76.parseRepairState,
          written,
          "generation-76 parses the launcher settlement",
        );
        for (const result of exported) {
          assertGeneration76Accepts(
            gen76.parseCellResult,
            result,
            "generation-76 cell export",
          );
        }
        return Promise.resolve();
      })
    ),
});
