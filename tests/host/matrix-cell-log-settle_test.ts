/**
 * A just-completed own cell whose native job log is not served yet.
 *
 * Generation 77 run 38881893136 failed its repair job when a later
 * progressive scan, requesting only that run's own producers, met cell
 * bb4ebb5e: its artifact was uploaded at 09:58:14 and its job completed at
 * 09:58:17, the scan started after the 09:58:20 state write and refused by
 * 09:58:43. The next run's maintenance authenticated the same artifacts.
 */
import assert from "node:assert/strict";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import {
  MATRIX_CELL_LOG_SETTLE_MS,
  type MatrixArtifactTransportV1,
} from "../../src/host/matrix-artifact-port.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { T0 } from "../state/helpers.ts";
import { createFreshMatrixArchives } from "./matrix-actions-archive-fixtures.ts";
import { issue, rig } from "./matrix-actions-fixtures.ts";
import { fixture, ISO } from "./matrix-artifact-fixtures.ts";

/** Exactly the transport's plain fail-closed refusal. */
const REFUSAL = (error: unknown) =>
  error instanceof Error &&
  Object.getPrototypeOf(error) === Error.prototype &&
  error.message === "matrix artifact provenance unavailable or conflicting";
const API = "/repos/ubiquity-sentinel/sentinel/actions";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Unserved = "api" | "storage" | "empty" | "partial";

function unserved(
  f: Fixture,
  mode: Unserved | null,
  jobId = 402,
): HttpTransportV1 {
  if (mode === "empty") f.logs.set(jobId, "");
  if (mode === "partial") f.logs.set(jobId, `${ISO} setting up the cell\n`);
  return (request) => {
    const url = new URL(request.url);
    if (mode === "api" && url.pathname === `${API}/jobs/${jobId}/logs`) {
      return Promise.resolve({
        status: 404,
        headers: new Headers(),
        bodyText: '{"message":"Not Found"}',
      });
    }
    if (
      mode === "storage" && url.host.endsWith(".blob.core.windows.net") &&
      url.pathname === `/log/${jobId}`
    ) {
      return Promise.resolve({
        status: 404,
        headers: new Headers(),
        bodyText: "BlobNotFound",
      });
    }
    return f.http(request);
  };
}

function transportAt(
  f: Fixture,
  http: HttpTransportV1,
  now: number,
): MatrixArtifactTransportV1["recover"] {
  const inner = createActionsMatrixArtifactTransport({
    state: f.state,
    token: "fake-local-token",
    http,
    clock: { now: () => now },
    artifactRoot: `${f.tmp}/recovered`,
  });
  return async (input) => {
    const cwd = Deno.cwd();
    Deno.chdir(`${f.tmp}/checkout`);
    try {
      return await inner.recover(input);
    } finally {
      Deno.chdir(cwd);
    }
  };
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  try {
    return await run();
  } finally {
    console.error = original;
  }
}

// The fixture's own cell job 402 completed at T0; the default clock is 10s on.
for (const mode of ["api", "storage", "empty", "partial"] as const) {
  Deno.test(`cell log settle: own cell completed 10s ago with ${mode} log unserved defers its wave`, async () => {
    const f = await fixture();
    try {
      const recover = transportAt(f, unserved(f, mode), T0 + 10_000);
      assert.deepEqual(await recover(f.input), []);
    } finally {
      await Deno.remove(f.tmp, { recursive: true });
    }
  });
}

Deno.test("cell log settle: the deferred wave authenticates once its log is served", async () => {
  const f = await fixture();
  try {
    let pending = true;
    const later = unserved(f, "api");
    const http: HttpTransportV1 = (request) =>
      pending ? later(request) : f.http(request);
    const recover = transportAt(f, http, T0 + 10_000);
    assert.deepEqual(await recover(f.input), []);
    pending = false;
    const waves = await recover(f.input);
    assert.equal(waves.length, 1);
    assert.deepEqual(waves[0].results, [f.result]);
    assert.equal(waves[0].provenance.cellJobIds[0], 402);
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

Deno.test("cell log settle: the settle bound starts at the native job completion", async () => {
  const f = await fixture();
  try {
    f.jobs[1].completed_at = new Date(T0 + 60_000).toISOString();
    const at = T0 + 60_000 + MATRIX_CELL_LOG_SETTLE_MS;
    assert.deepEqual(await transportAt(f, unserved(f, "api"), at)(f.input), []);
    await quietly(() =>
      assert.rejects(
        transportAt(f, unserved(f, "api"), at + 1)(f.input),
        REFUSAL,
      )
    );
  } finally {
    await Deno.remove(f.tmp, { recursive: true });
  }
});

for (const mode of ["api", "storage", "empty", "partial"] as const) {
  Deno.test(`cell log settle: ${mode} log still unserved past the bound refuses as before`, async () => {
    const f = await fixture();
    try {
      const recover = transportAt(
        f,
        unserved(f, mode),
        T0 + MATRIX_CELL_LOG_SETTLE_MS + 1,
      );
      await quietly(() => assert.rejects(recover(f.input), REFUSAL));
    } finally {
      await Deno.remove(f.tmp, { recursive: true });
    }
  });
}

Deno.test("cell log settle: a served log that conflicts still refuses inside the bound", async (t) => {
  for (
    const fault of [
      "duplicate",
      "keys",
      "runtime",
      "outside",
      "reservation",
    ] as const
  ) {
    await t.step(fault, async () => {
      const f = await fixture();
      try {
        const line = `${ISO} ${JSON.stringify(f.cellMarker)}\n`;
        if (fault === "duplicate") f.logs.set(402, line + line);
        if (fault === "keys") {
          f.logs.set(
            402,
            `${ISO} ${JSON.stringify({ ...f.cellMarker, extra: 1 })}\n`,
          );
        }
        if (fault === "runtime") {
          f.logs.set(
            402,
            `${ISO} ${
              JSON.stringify({ ...f.cellMarker, runtimeSha: "3".repeat(40) })
            }\n`,
          );
        }
        if (fault === "outside") {
          f.logs.set(
            402,
            `${new Date(T0 + 5_000).toISOString()} ${
              JSON.stringify(f.cellMarker)
            }\n`,
          );
        }
        if (fault === "reservation") {
          f.logs.set(
            402,
            `${ISO} ${
              JSON.stringify({ ...f.cellMarker, reservationId: "c".repeat(64) })
            }\n`,
          );
        }
        const recover = transportAt(f, f.http, T0 + 10_000);
        await quietly(() => assert.rejects(recover(f.input), REFUSAL));
      } finally {
        await Deno.remove(f.tmp, { recursive: true });
      }
    });
  }
});

Deno.test("cell log settle: only the consumer's own in-progress cell may wait", async (t) => {
  for (
    const fault of [
      "planner",
      "historical",
      "attempt",
      "job",
      "step",
      "completed",
    ] as const
  ) {
    await t.step(fault, async () => {
      const f = await fixture();
      try {
        let http = unserved(f, "api");
        let input: typeof f.input = f.input;
        if (fault === "planner") http = unserved(f, "api", 401);
        if (fault === "historical") {
          const { currentRun: _current, ...rest } = f.input;
          input = rest as typeof f.input;
        }
        if (fault === "attempt") f.attempt.status = "completed";
        if (fault === "job") Object.assign(f.jobs[1], { conclusion: null });
        if (fault === "step") {
          (f.jobs[1].steps as { status: string }[])[0].status = "in_progress";
        }
        if (fault === "completed") {
          Object.assign(f.jobs[1], { completed_at: null });
        }
        const recover = transportAt(f, http, T0 + 10_000);
        await quietly(() => assert.rejects(recover(input), REFUSAL));
      } finally {
        await Deno.remove(f.tmp, { recursive: true });
      }
    });
  }
});

/**
 * The live shape through the real repair host, consumer and transport: the
 * run's own producer is the only charge, its artifact is visible while its
 * job still runs, the job completes, and the next scan's first read of its
 * job log is not served yet.
 */
async function replay(options: {
  pendingAtStart: boolean;
  unservedReads: number;
}) {
  const r = await rig();
  try {
    const self = r.github.get("ubiquity-sentinel/sentinel")!;
    self.listOpenIssues = () => Promise.resolve(portOk([issue(93)]));
    self.readIssue = (number) => Promise.resolve(portOk(issue(number)));
    const foreign = r.github.get("ubiquity/ai.ubq.fi")!;
    foreign.listOpenIssues = () => Promise.resolve(portOk([]));
    foreign.readIssue = (number) => Promise.resolve(portOk(issue(number)));
    const noModel = {
      modelId: "gpt-reserve",
      runModel: () => {
        throw new Error("no inference is permitted");
      },
    };
    const planner = await runActionsMatrixHost({
      ...await r.job("settle-plan", "matrix_plan"),
      model: noModel,
    });
    assert.ok("plan" in planner);
    assert.equal(planner.plan.cells.length, 1);
    const cell = planner.plan.cells[0];
    const cellDeps = await r.job("settle-cell", "matrix_cell");
    const artifactRoot = cellDeps.workDir + "/../.sentinel-matrix";
    await Deno.mkdir(artifactRoot);
    await Deno.writeTextFile(
      artifactRoot + "/plan.json",
      JSON.stringify(planner.plan),
    );
    const produced = await runActionsMatrixHost({
      ...cellDeps,
      carrier: { planDigest: planner.planDigest, cellId: cell.cellId },
      model: {
        modelId: "gpt-reserve",
        runModel: () =>
          Promise.resolve(portError("unavailable", "inert failed port")),
      },
    });
    assert.ok("cellId" in produced);
    const failed: MatrixCellResultV1 = produced;
    const archives = await createFreshMatrixArchives(
      r,
      planner,
      [failed],
      r.root,
      false,
      false,
      true,
    );
    const cellJob = archives.jobs.find((job) =>
      job.name.startsWith("matrix_cell")
    )!;
    const complete = () =>
      Object.assign(cellJob, {
        status: "completed",
        conclusion: "success",
        completed_at: new Date(r.clock.now()).toISOString(),
      });
    if (options.pendingAtStart) {
      Object.assign(cellJob, {
        status: "in_progress",
        conclusion: null,
        completed_at: null,
      });
    } else complete();
    const base = archives.artifactHttp(() => true);
    let logReads = 0;
    const http: HttpTransportV1 = (request) => {
      if (new URL(request.url).pathname === `${API}/jobs/${cellJob.id}/logs`) {
        logReads++;
        if (logReads <= options.unservedReads) {
          return Promise.resolve({
            status: 404,
            headers: new Headers(),
            bodyText: '{"message":"Not Found"}',
          });
        }
      }
      return base(request);
    };
    const charges: string[] = [];
    const steps: string[] = [];
    const recordCharge = async () => {
      const read = await r.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      charges.push(
        read.value.snapshot.reservations.find((row) =>
          row.id === cell.reservationId
        )!.outcome + "/" +
          read.value.snapshot.work.find((row) => row.id === cell.taskId)!
            .nextStep,
      );
    };
    const deps = await r.job("settle-aggregate", "repair");
    const cwd = Deno.cwd();
    const lines: string[] = [];
    const log = console.log, error = console.error;
    let failure: unknown = null;
    try {
      Deno.chdir(deps.workDir);
      console.log = (...args: unknown[]) => lines.push(String(args[0]));
      console.error = () => {};
      await runActionsRepairHost({
        ...deps,
        artifactHttp: http,
        model: noModel,
        runTargetCycles: (input) =>
          runActionsMatrixAggregateCycles(
            { ...input, modelStartsEnabled: false },
            undefined,
            { planDigest: planner.planDigest },
            {
              pollWait: async (ms) => {
                await recordCharge();
                steps.push(`poll:${logReads}`);
                r.clock.advance(ms);
                if (cellJob.status === "in_progress") complete();
              },
            },
          ),
      });
    } catch (caught) {
      failure = caught;
    } finally {
      console.log = log;
      console.error = error;
      Deno.chdir(cwd);
    }
    await recordCharge();
    return {
      failure,
      charges,
      steps,
      logReads,
      ingests: lines.filter((line) => line.includes('"sentinel_matrix_ingest"'))
        .map((line) => JSON.parse(line)),
    };
  } finally {
    await r.cleanup();
  }
}

Deno.test("cell log settle replay: a later scan meeting a just-completed own cell's unserved log keeps polling and ingests it", async () => {
  const run = await replay({ pendingAtStart: true, unservedReads: 1 });
  assert.equal(run.failure, null, String(run.failure));
  // Scan 1: job still running (wave deferred, no log read). Scan 2: job just
  // completed, its log not served (wave deferred, nothing written). Scan 3:
  // the served log authenticates the failed cell, which settles ambiguous.
  assert.deepEqual(run.steps, ["poll:0", "poll:1"]);
  assert.deepEqual(run.charges, [
    "reserved/work",
    "reserved/work",
    "ambiguous/blocked",
  ]);
  assert.equal(run.logReads, 2);
  assert.equal(
    run.ingests.reduce((sum, report) => sum + report.ingested, 0),
    1,
  );
});

Deno.test("cell log settle replay: an initial scan meeting a just-completed own cell's unserved log keeps polling and ingests it", async () => {
  const run = await replay({ pendingAtStart: false, unservedReads: 1 });
  assert.equal(run.failure, null, String(run.failure));
  assert.deepEqual(run.steps, ["poll:1"]);
  assert.deepEqual(run.charges, ["reserved/work", "ambiguous/blocked"]);
});

Deno.test("cell log settle replay: a log never served inside the bound still fails the run closed with the charge kept", async () => {
  const run = await replay({ pendingAtStart: false, unservedReads: 1_000 });
  assert.ok(REFUSAL(run.failure), String(run.failure));
  // One deferred scan per poll until the bound (5 minutes) is passed: the
  // scan 6 minutes after completion refuses, exactly as generation 77 did.
  assert.equal(MATRIX_CELL_LOG_SETTLE_MS, 5 * 60_000);
  assert.deepEqual(run.steps, [1, 2, 3, 4, 5, 6].map((n) => `poll:${n}`));
  assert.equal(run.logReads, 7);
  assert.equal(run.ingests.length, 0);
  assert.ok(run.charges.every((charge) => charge === "reserved/work"));
});
