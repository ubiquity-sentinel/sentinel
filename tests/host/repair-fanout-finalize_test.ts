/**
 * Finalize authenticates repository repair deltas exactly like matrix-cell
 * artifacts and applies them in one trusted write (issue #328).
 *
 * The ACTUAL repository passes produce three sealed deltas from one shared
 * in-memory state; a fake Actions API serves the run attempt, its jobs and
 * signed logs, and real ZIP artifacts through the production bounded
 * transport (302 to blob storage, GitHub's archive digest). No network.
 */
import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  encodeRepairDeltaArtifactV1,
  type RepairDeltaEnvelopeV1,
} from "../../src/contracts/repair-delta.ts";
import { createActionsMatrixArtifactHttpTransport } from "../../src/host/matrix-artifacts.ts";
import {
  REPAIR_CELL_STEP,
  runRepairFanoutFinalize,
} from "../../src/host/repair-fanout-finalize.ts";
import { REPAIR_CELL_MARKER_KIND } from "../../src/host/hosted-runtime-repair-cell.ts";
import { repairFanoutPlanDigestV1 } from "../../src/repair/repair-fanout-plan.ts";
import type { RepairFanoutPlanV1 } from "../../src/repair/repair-fanout-plan.ts";
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
const TOKEN = "fake-read-token-0123456789";

async function sha256(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function zip(name: string, content: Uint8Array): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  await writer.add(name, new Uint8ArrayReader(content), {
    unixMode: 0o100600,
  });
  return await writer.close();
}

/** The Actions run of one fan-out: jobs, logs and uploaded artifacts. */
async function actionsRun(
  rig: Rig,
  fanout: RepairFanoutPlanV1,
  envelopes: Map<string, unknown>,
) {
  const at = new Date(rig.clock.now() - MINUTE).toISOString();
  const job = (id: number, name: string, step: string) => ({
    id,
    name,
    run_id: RUN.runId,
    run_attempt: RUN.runAttempt,
    head_sha: RUN.launcherSha,
    status: "completed",
    conclusion: "success",
    started_at: at,
    completed_at: at,
    steps: [{
      name: step,
      number: 1,
      status: "completed",
      conclusion: "success",
      started_at: at,
      completed_at: at,
    }],
  });
  const jobs = [job(500, "matrix_plan", "Plan isolated issue matrix")];
  const logs = new Map<number, string>();
  const archives = new Map<number, Uint8Array>();
  const artifacts: Record<string, unknown>[] = [];
  const provenance = {
    id: RUN.runId,
    repository_id: 123,
    head_repository_id: 123,
    head_branch: "sentinel-supervisor",
    head_sha: RUN.launcherSha,
  };
  const upload = async (id: number, name: string, bytes: Uint8Array) => {
    archives.set(id, bytes);
    artifacts.push({
      id,
      name,
      size_in_bytes: bytes.length,
      expired: false,
      digest: "sha256:" + await sha256(bytes),
      workflow_run: provenance,
    });
  };
  await upload(
    600,
    `sentinel-repair-plan-${RUN.runId}-${RUN.runAttempt}`,
    await zip(
      "plan.json",
      new TextEncoder().encode(canonicalStringify(fanout)),
    ),
  );
  for (const [index, cell] of fanout.cells.entries()) {
    const envelope = envelopes.get(cell.repository.name);
    if (envelope === undefined) continue;
    const id = 501 + index;
    jobs.push(job(id, `repair_cell (${cell.cellId})`, REPAIR_CELL_STEP));
    logs.set(
      id,
      at + " " + JSON.stringify({
        kind: REPAIR_CELL_MARKER_KIND,
        run: RUN,
        runtimeSha: RUNTIME.revision,
        generation: RUNTIME.generation,
        cellId: cell.cellId,
        deltaDigest: (envelope as RepairDeltaEnvelopeV1).digest,
        transitions: (envelope as RepairDeltaEnvelopeV1).delta?.transitions
          .length ?? 0,
      }) + "\n",
    );
    await upload(
      601 + index,
      `sentinel-repair-cell-${RUN.runId}-${RUN.runAttempt}-${cell.cellId}`,
      await zip(
        "result.json",
        new TextEncoder().encode(JSON.stringify(envelope)),
      ),
    );
  }
  const http = createActionsMatrixArtifactHttpTransport((url) => {
    const parsed = new URL(url);
    const reply = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body)));
    if (parsed.host.endsWith("blob.core.windows.net")) {
      const id = Number(parsed.pathname.split("/").at(-1));
      return Promise.resolve(
        new Response(
          parsed.pathname.startsWith("/archive/")
            ? archives.get(id)!.slice()
            : logs.get(id)!,
        ),
      );
    }
    if (/\/runs\/41\/attempts\/1$/.test(parsed.pathname)) {
      return reply({
        id: RUN.runId,
        run_attempt: RUN.runAttempt,
        workflow_id: HOSTED_SUPERVISOR_WORKFLOW_ID,
        path: HOSTED_SUPERVISOR_WORKFLOW_PATH,
        event: "workflow_dispatch",
        head_branch: "sentinel-supervisor",
        head_sha: RUN.launcherSha,
        repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
        head_repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
        status: "in_progress",
      });
    }
    if (parsed.pathname.endsWith("/runs/41/artifacts")) {
      return reply({ total_count: artifacts.length, artifacts });
    }
    if (parsed.pathname.endsWith("/runs/41/attempts/1/jobs")) {
      return reply({ total_count: jobs.length, jobs });
    }
    const selected = parsed.pathname.match(/\/artifacts\/(\d+)\/zip$/) ??
      parsed.pathname.match(/\/jobs\/(\d+)\/logs$/);
    if (selected) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://productionresultssa1.blob.core.windows.net/" +
              (parsed.pathname.endsWith("/zip") ? "archive/" : "log/") +
              selected[1],
          },
        }),
      );
    }
    throw new Error("unexpected Actions route " + parsed.pathname);
  });
  return { http, archives, artifacts };
}

async function fanOut(rig: Rig) {
  const { plan: fanout, binding } = await plan(rig);
  const { value: results } = await captured(() =>
    Promise.all(
      fanout.cells.map((cell) =>
        runRepositoryRepairPass(rig.deps, {
          repository: cell.repository,
          binding,
          records: cell.records,
          deadline: rig.clock.now() + 90 * MINUTE,
          stepLimit: 1_000,
          modelStartsEnabled: true,
        })
      ),
    )
  );
  const envelopes = new Map<string, unknown>();
  for (const result of results) {
    assert.equal(result.status, "sealed");
    if (result.status === "sealed") {
      envelopes.set(
        result.envelope.delta.repository.name,
        JSON.parse(
          new TextDecoder().decode(
            encodeRepairDeltaArtifactV1(result.envelope),
          ),
        ),
      );
    }
  }
  return { fanout, envelopes };
}

Deno.test("finalize applies two authenticated repair deltas in one write and rejects a tampered one", async () => {
  const [ALPHA, BETA, GAMMA] = REPOS;
  const rig = makeRig([
    reviewing(ALPHA, 0),
    reviewing(ALPHA, 1),
    reviewing(BETA, 100),
    reviewing(GAMMA, 200),
  ]);
  const { fanout, envelopes } = await fanOut(rig);
  assert.equal(fanout.cells.length, 3);
  assert.equal(rig.state.repairWrites, 0, "the cells wrote nothing");
  // The gamma artifact's body was edited after sealing (its archive digest is
  // GitHub's own for the edited bytes; its marker names the original seal).
  const gamma = structuredClone(
    envelopes.get("gamma"),
  ) as RepairDeltaEnvelopeV1;
  gamma.delta.transitions[0].after.nextStep = "delivery";
  envelopes.set("gamma", gamma);
  const run = await actionsRun(rig, fanout, envelopes);
  const before = structuredClone(rig.state.repair!);
  const planDigest = await repairFanoutPlanDigestV1(fanout);
  const applied = await captured(() =>
    runRepairFanoutFinalize({
      token: TOKEN,
      http: run.http,
      clock: rig.clock,
      state: rig.state,
      run: RUN,
      runtime: RUNTIME,
      planDigest,
      deadline: rig.clock.now() + 60 * MINUTE,
    })
  );
  const outcome = applied.value;
  assert.ok(outcome !== null);
  assert.equal(outcome.status, "applied");
  assert.deepEqual(
    outcome.applied.map((entry) => entry.repository.name).sort(),
    ["alpha", "beta"],
  );
  assert.deepEqual(outcome.rejected, [
    { repository: GAMMA, reason: "unauthenticated" },
  ]);
  assert.equal(rig.state.repairWrites, 1, "one expected-head write");
  // The tampered delta contributed nothing: its record is only handed back
  // to the trusted serial pass (its advisory stamp removed).
  const { stepInputs: _stamp, ...gammaBefore } = before.work.find((row) =>
    row.id === "issue-gamma-200"
  )!;
  assert.deepEqual(
    rig.state.repair!.work.find((row) => row.id === "issue-gamma-200"),
    gammaBefore,
    "the tampered delta contributed nothing",
  );
  assert.equal(outcome.handedBack, 1);
  for (const id of ["issue-alpha-0", "issue-alpha-1", "issue-beta-100"]) {
    assert.equal(
      rig.state.repair!.work.find((row) => row.id === id)?.wait?.reason,
      "review_pending",
    );
  }
  assert.ok(
    applied.lines.some((line) =>
      line.kind === "sentinel_repair_fanout" && line.deltasApplied === 2
    ),
  );
});

Deno.test("finalize authenticates nothing for a foreign plan digest or a foreign producer", async () => {
  const [ALPHA] = REPOS;
  const rig = makeRig([reviewing(ALPHA, 0)]);
  const { fanout, envelopes } = await fanOut(rig);
  const run = await actionsRun(rig, fanout, envelopes);
  const input = {
    token: TOKEN,
    http: run.http,
    clock: rig.clock,
    state: rig.state,
    run: RUN,
    runtime: RUNTIME,
    planDigest: "f".repeat(64),
    deadline: rig.clock.now() + 60 * MINUTE,
  };
  const foreignPlan = await captured(() => runRepairFanoutFinalize(input));
  assert.equal(foreignPlan.value, null);
  // A marker bound to another runtime revision is not this run's producer.
  const producer = await captured(async () =>
    runRepairFanoutFinalize({
      ...input,
      planDigest: await repairFanoutPlanDigestV1(fanout),
      runtime: { revision: SHA1, generation: RUNTIME.generation },
    })
  );
  assert.deepEqual(producer.value?.applied, []);
  assert.deepEqual(producer.value?.rejected.map((entry) => entry.reason), [
    "unauthenticated",
  ]);
  assert.equal(producer.value?.handedBack, 1, "only the stamp hand-back");
});

Deno.test("finalize counts a refused and a missing repository cell, hands their records back and never fails", async () => {
  const [ALPHA, BETA, GAMMA] = REPOS;
  const rig = makeRig([
    reviewing(ALPHA, 0),
    reviewing(BETA, 100),
    reviewing(GAMMA, 200),
  ]);
  const { fanout, envelopes } = await fanOut(rig);
  const cellOf = (name: string) =>
    fanout.cells.find((cell) => cell.repository.name === name)!.cellId;
  // beta's setup failed: the workflow uploaded its bounded refusal record;
  // gamma's producer never uploaded anything.
  envelopes.set("beta", {
    cellId: cellOf("beta"),
    kind: "repair_cell_refusal",
    reason: "cell_unavailable",
    version: "v1",
  });
  envelopes.delete("gamma");
  const run = await actionsRun(rig, fanout, envelopes);
  const { value: outcome } = await captured(async () =>
    runRepairFanoutFinalize({
      token: TOKEN,
      http: run.http,
      clock: rig.clock,
      state: rig.state,
      run: RUN,
      runtime: RUNTIME,
      planDigest: await repairFanoutPlanDigestV1(fanout),
      deadline: rig.clock.now() + 60 * MINUTE,
    })
  );
  assert.ok(outcome !== null);
  assert.equal(outcome.status, "applied");
  assert.deepEqual(outcome.applied.map((entry) => entry.repository.name), [
    "alpha",
  ]);
  assert.deepEqual(
    outcome.rejected.map((entry) => [entry.repository.name, entry.reason])
      .sort(),
    [["beta", "refused"], ["gamma", "missing"]],
  );
  assert.equal(outcome.handedBack, 2);
  for (const id of ["issue-beta-100", "issue-gamma-200"]) {
    const row = rig.state.repair!.work.find((record) => record.id === id)!;
    assert.equal(row.stepInputs, undefined, id);
    assert.equal(row.nextStep, "review", id);
  }
  assert.equal(rig.state.repairWrites, 1);
});
