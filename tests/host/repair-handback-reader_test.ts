/**
 * The serial job's read of its own run's repository-cell hand-backs (issue
 * #328): it waits while a cell job runs, authenticates every delta exactly as
 * finalize does, and returns only the delegated records each cell handed
 * back.
 *
 * The ACTUAL repository passes seal the deltas; a fake Actions reader serves
 * the run attempt, its jobs, their logs and the artifacts. No network.
 */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  encodeRepairDeltaArtifactV1,
  REPAIR_CELL_REFUSAL_KIND,
  type RepairDeltaEnvelopeV1,
  sealRepairDeltaV1,
} from "../../src/contracts/repair-delta.ts";
import { REPAIR_CELL_MARKER_KIND } from "../../src/host/hosted-runtime-repair-cell.ts";
import { REPAIR_CELL_STEP } from "../../src/host/repair-fanout-finalize.ts";
import {
  readRepairHandbacks,
  REPAIR_HANDBACK_AUTH_READS,
  REPAIR_HANDBACK_POLL_MS,
} from "../../src/host/repair-handback-reader.ts";
import {
  repairFanoutPlanDigestV1,
  type RepairFanoutPlanV1,
} from "../../src/repair/repair-fanout-plan.ts";
import { runRepositoryRepairPass } from "../../src/repair/repository-pass.ts";
import { SHA1, SHA2 } from "../state/helpers.ts";
import {
  captured,
  makeRig,
  MINUTE,
  plan,
  REPOS,
  reviewing,
  type Rig,
} from "../repair/repository-pass-rig.ts";

const RUN = { runId: 41, runAttempt: 1, launcherSha: SHA1 };
const RUNTIME = { revision: SHA2, generation: 3 };
const [ALPHA, BETA] = REPOS;
type Json = Record<string, unknown>;

/** A produced candidate with no PR: its step publishes, a trusted effect. */
function publishing(index: number) {
  return reviewing(ALPHA, index, {
    nextStep: "work",
    target: {
      base: SHA1,
      branch: `sentinel/repair/issue-alpha-${index}`,
      checkpoint: null,
      head: SHA2,
      pr: null,
    },
  });
}

/** The fan-out of alpha (one review, one publication) and beta. */
async function sealed() {
  const rig = makeRig([
    reviewing(ALPHA, 0),
    publishing(60),
    reviewing(BETA, 100),
  ]);
  const { plan: fanout, binding } = await plan(rig);
  const { value: results } = await captured(() =>
    Promise.all(fanout.cells.map((cell) =>
      runRepositoryRepairPass(rig.deps, {
        repository: cell.repository,
        binding,
        records: cell.records,
        deadline: rig.clock.now() + 90 * MINUTE,
        stepLimit: 1_000,
        modelStartsEnabled: true,
      })
    ))
  );
  const envelopes = new Map<string, unknown>();
  for (const [index, result] of results.entries()) {
    assert.equal(result.status, "sealed");
    if (result.status === "sealed") {
      envelopes.set(fanout.cells[index].cellId, result.envelope);
    }
  }
  return { rig, fanout, envelopes };
}

/** One run's Actions surface; its cell jobs run until `complete()`. */
function actions(
  rig: Rig,
  fanout: RepairFanoutPlanV1,
  envelopes: Map<string, unknown>,
) {
  let running = true;
  const at = new Date(rig.clock.now() - MINUTE).toISOString();
  const repository = { id: 123, full_name: "ubiquity-sentinel/sentinel" };
  const attempt = {
    id: RUN.runId,
    run_attempt: RUN.runAttempt,
    workflow_id: HOSTED_SUPERVISOR_WORKFLOW_ID,
    path: HOSTED_SUPERVISOR_WORKFLOW_PATH,
    event: "workflow_dispatch",
    head_branch: "sentinel-supervisor",
    head_sha: RUN.launcherSha,
    repository,
    head_repository: repository,
  };
  const provenance = {
    id: RUN.runId,
    repository_id: 123,
    head_repository_id: 123,
    head_branch: "sentinel-supervisor",
    head_sha: RUN.launcherSha,
  };
  const job = (id: number, name: string, step: string): Json => ({
    id,
    name,
    run_id: RUN.runId,
    run_attempt: RUN.runAttempt,
    head_sha: RUN.launcherSha,
    status: running && name !== "matrix_plan" ? "in_progress" : "completed",
    conclusion: "success",
    started_at: at,
    completed_at: at,
    steps: [{
      name: step,
      status: "completed",
      conclusion: "success",
      started_at: at,
      completed_at: at,
    }],
  });
  const bytes = new Map<string, Uint8Array>();
  const logs = new Map<number, string>();
  const artifacts: Json[] = [];
  const upload = (name: string, body: Uint8Array) => {
    bytes.set(name, body);
    artifacts.push({ name, workflow_run: provenance });
  };
  upload(
    `sentinel-repair-plan-${RUN.runId}-${RUN.runAttempt}`,
    new TextEncoder().encode(canonicalStringify(fanout)),
  );
  for (const [index, cell] of fanout.cells.entries()) {
    const body = envelopes.get(cell.cellId) as Json;
    const envelope = body as unknown as RepairDeltaEnvelopeV1;
    logs.set(
      501 + index,
      at + " " + JSON.stringify({
        kind: REPAIR_CELL_MARKER_KIND,
        run: RUN,
        runtimeSha: RUNTIME.revision,
        generation: RUNTIME.generation,
        cellId: cell.cellId,
        deltaDigest: envelope.digest ?? "0".repeat(64),
        transitions: envelope.delta?.transitions.length ?? 0,
      }) + "\n",
    );
    upload(
      `sentinel-repair-cell-${RUN.runId}-${RUN.runAttempt}-${cell.cellId}`,
      body.kind === REPAIR_CELL_REFUSAL_KIND
        ? new TextEncoder().encode(canonicalStringify(body))
        : encodeRepairDeltaArtifactV1(envelope),
    );
  }
  const reads: string[] = [];
  const reader = {
    json: () => Promise.resolve(attempt as Json),
    pages: (_path: string, key: string) => {
      reads.push(key);
      return Promise.resolve(
        key === "artifacts" ? artifacts : [
          job(500, "matrix_plan", "Plan isolated issue matrix"),
          ...fanout.cells.map((cell, index) =>
            job(501 + index, `repair_cell (${cell.cellId})`, REPAIR_CELL_STEP)
          ),
        ],
      );
    },
    download: (path: string) => {
      const id = Number(path.match(/\/jobs\/(\d+)\/logs$/)![1]);
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: logs.get(id) ?? "",
      });
    },
  };
  const archive = (row: Json) => {
    reads.push("archive");
    return Promise.resolve(
      new Map([[
        String(row.name).startsWith("sentinel-repair-plan-")
          ? "plan.json"
          : "result.json",
        bytes.get(String(row.name))!,
      ]]),
    );
  };
  return {
    reader,
    archive,
    reads,
    complete: () => {
      running = false;
    },
  };
}

async function read(
  rig: Rig,
  surface: ReturnType<typeof actions>,
  planDigest: string,
  until = rig.clock.now() + 10 * MINUTE,
) {
  let waits = 0;
  const result = await readRepairHandbacks(
    {
      state: rig.state,
      token: "t",
      http: () => Promise.reject(),
      clock: rig.clock,
    },
    { planDigest, run: RUN, runtime: RUNTIME, until },
    {
      reader: surface.reader,
      archive: surface.archive,
      wait: (ms) => {
        waits++;
        rig.clock.advance(ms);
        surface.complete();
        return Promise.resolve();
      },
    },
  );
  return { result, waits };
}

Deno.test("hand-back reader: waits for the running cells, then returns exactly what each handed back", async () => {
  const { rig, fanout, envelopes } = await sealed();
  const surface = actions(rig, fanout, envelopes);
  const { result, waits } = await read(
    rig,
    surface,
    await repairFanoutPlanDigestV1(fanout),
  );
  assert.equal(waits, 1, "one pause while the cells ran");
  assert.equal(
    surface.reads.indexOf("archive") > surface.reads.indexOf("jobs"),
    true,
    "no artifact is read before every cell completed",
  );
  assert.deepEqual(result, [{
    repository: ALPHA,
    records: ["issue-alpha-60"],
  }]);
});

Deno.test("hand-back reader: a refused cell, a record outside its cell and a foreign plan hand nothing back", async () => {
  const { rig, fanout, envelopes } = await sealed();
  const alpha = fanout.cells.find((cell) => cell.repository.name === "alpha")!;
  const beta = fanout.cells.find((cell) => cell.repository.name === "beta")!;
  // Alpha's delta names beta's record too; beta's cell refused.
  const original = envelopes.get(alpha.cellId) as RepairDeltaEnvelopeV1;
  envelopes.set(
    alpha.cellId,
    await sealRepairDeltaV1({
      ...original.delta,
      deferredToTrusted: ["issue-alpha-60", "issue-beta-100"],
    }),
  );
  envelopes.set(beta.cellId, {
    version: "v1",
    kind: REPAIR_CELL_REFUSAL_KIND,
    cellId: beta.cellId,
    reason: "pass_failed",
  });
  const surface = actions(rig, fanout, envelopes);
  const { result } = await read(
    rig,
    surface,
    await repairFanoutPlanDigestV1(fanout),
  );
  assert.deepEqual(result, [{
    repository: ALPHA,
    records: ["issue-alpha-60"],
  }]);
  const foreign = await read(
    rig,
    actions(rig, fanout, envelopes),
    "f".repeat(64),
  );
  assert.equal(foreign.result, null);
});

Deno.test("hand-back reader: a completed cell that never authenticates is read a bounded number of times", async () => {
  const { rig, fanout, envelopes } = await sealed();
  const beta = fanout.cells.find((cell) => cell.repository.name === "beta")!;
  const surface = actions(rig, fanout, envelopes);
  surface.complete();
  // Beta's job log never carries its marker: its delta never authenticates.
  const download = surface.reader.download;
  surface.reader.download = async (path: string) => {
    const log = await download(path);
    return log.bodyText.includes(beta.cellId) ? { ...log, bodyText: "" } : log;
  };
  const { result, waits } = await read(
    rig,
    surface,
    await repairFanoutPlanDigestV1(fanout),
  );
  assert.equal(waits, REPAIR_HANDBACK_AUTH_READS - 1);
  assert.deepEqual(result, [{
    repository: ALPHA,
    records: ["issue-alpha-60"],
  }]);
});

Deno.test("hand-back reader: gives up at its bound while a cell still runs", async () => {
  const { rig, fanout, envelopes } = await sealed();
  const surface = actions(rig, fanout, envelopes);
  let waits = 0;
  const result = await readRepairHandbacks(
    {
      state: rig.state,
      token: "t",
      http: () => Promise.reject(),
      clock: rig.clock,
    },
    {
      planDigest: await repairFanoutPlanDigestV1(fanout),
      run: RUN,
      runtime: RUNTIME,
      until: rig.clock.now() + 3 * REPAIR_HANDBACK_POLL_MS,
    },
    {
      reader: surface.reader,
      archive: surface.archive,
      wait: (ms) => {
        waits++;
        rig.clock.advance(ms);
        return Promise.resolve();
      },
    },
  );
  assert.deepEqual(result, []);
  assert.equal(waits, 2);
  assert.equal(surface.reads.includes("archive"), false);
});
