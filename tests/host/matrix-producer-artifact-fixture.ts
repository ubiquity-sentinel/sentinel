/** Native Actions/archive responses for one real scripted conflict cell. */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  type MatrixCellResultV1,
  matrixDigestV1,
  type MatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { bytes, digest, zip } from "./matrix-artifact-fixtures.ts";
import { execution, proof } from "./hosted-autonomy-history-reach-fixtures.ts";

type Json = Record<string, unknown>;
const iso = (at: number) => new Date(at).toISOString();

export async function producerArtifactFixture(input: {
  plan: MatrixPlanV1;
  result: MatrixCellResultV1;
  bundle: Uint8Array;
}) {
  const { plan, result, bundle } = input;
  const runId = plan.run.runId;
  const cell = plan.cells[0];
  const saved = proof(runId);
  const artifacts: Json[] = [];
  const archives = new Map<number, Uint8Array>();
  const logs = new Map<number, string>();
  const calls: string[] = [];
  const job = (id: number, name: string, step: string): Json => ({
    id,
    name,
    run_id: runId,
    run_attempt: 1,
    head_sha: plan.run.launcherSha,
    status: "completed",
    conclusion: "success",
    started_at: iso(saved.startedAt),
    completed_at: iso(saved.finishedAt),
    steps: [{
      name: step,
      number: 1,
      status: "completed",
      conclusion: "success",
      started_at: iso(saved.startedAt),
      completed_at: iso(saved.finishedAt),
    }],
  });
  const jobs = [
    job(runId * 10 + 2, "matrix_plan", "Plan isolated issue matrix"),
    job(
      runId * 10 + 3,
      `matrix_cell (${cell.cellId})`,
      "Run isolated issue cell",
    ),
    job(runId, "repair", "Run Sentinel repair cycle"),
  ];
  const add = async (id: number, name: string, data: Uint8Array) => {
    archives.set(id, data);
    artifacts.push({
      id,
      name,
      size_in_bytes: data.length,
      expired: false,
      digest: `sha256:${await digest(data)}`,
      workflow_run: {
        id: runId,
        repository_id: 123,
        head_repository_id: 123,
        head_branch: "sentinel-supervisor",
        head_sha: plan.run.launcherSha,
      },
    });
  };
  await add(
    runId * 10 + 1,
    `sentinel-matrix-plan-${runId}-1`,
    await zip([{ name: "plan.json", content: bytes(plan) }]),
  );
  await add(
    runId * 10 + 4,
    `sentinel-matrix-cell-${runId}-1-${cell.cellId}`,
    await zip([
      { name: "result.json", content: bytes(result) },
      { name: `${cell.cellId}.bundle`, content: bundle },
    ]),
  );
  logs.set(
    runId * 10 + 2,
    `${iso(saved.startedAt)} ${
      canonicalStringify({
        kind: "sentinel_matrix_plan",
        waveId: plan.waveId,
        run: plan.run,
        runtimeSha: cell.runtimeSha,
        generation: cell.generation,
        planDigest: await matrixDigestV1(plan),
        prepared: 1,
      })
    }\n`,
  );
  logs.set(
    runId * 10 + 3,
    `${iso(saved.startedAt)} ${
      canonicalStringify({
        kind: "sentinel_matrix_cell",
        run: plan.run,
        runtimeSha: cell.runtimeSha,
        generation: cell.generation,
        cellId: cell.cellId,
        reservationId: cell.reservationId,
        resultDigest: await matrixDigestV1(result),
        bundleDigest: result.bundle?.digest ?? null,
        status: result.status,
      })
    }\n`,
  );
  const reply = (body: unknown) =>
    Promise.resolve({
      status: 200,
      headers: new Headers(),
      bodyText: canonicalStringify(body),
    });
  const http: HttpTransportV1 = (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    calls.push(path);
    assert.equal(request.method, "GET");
    if (url.hostname === "productionresultssa1.blob.core.windows.net") {
      assert.equal(request.headers.has("authorization"), false);
      const id = Number(path.split("/").at(-1));
      if (path.startsWith("/archive/")) {
        const data = archives.get(id);
        assert(data, path);
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: "",
          bodyBytes: data,
        });
      }
      assert(logs.has(id), path);
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: logs.get(id)!,
      });
    }
    assert.equal(url.hostname, "api.github.com");
    assert.equal(request.headers.get("authorization"), "Bearer offline-token");
    const run = path.match(/\/runs\/(\d+)/);
    if (run) {
      assert.equal(Number(run[1]), runId);
      if (path.endsWith("/jobs")) {
        return reply({ total_count: jobs.length, jobs });
      }
      if (path.endsWith("/artifacts")) {
        return reply({ total_count: artifacts.length, artifacts });
      }
      assert(path.endsWith("/attempts/1"), path);
      return reply({
        id: runId,
        run_attempt: 1,
        workflow_id: HOSTED_SUPERVISOR_WORKFLOW_ID,
        path: HOSTED_SUPERVISOR_WORKFLOW_PATH,
        event: "workflow_dispatch",
        head_branch: "sentinel-supervisor",
        head_sha: plan.run.launcherSha,
        repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
        head_repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
        status: "completed",
        run_started_at: iso(execution(runId).createdAt),
        updated_at: iso(saved.finishedAt),
      });
    }
    const archive = path.match(/\/artifacts\/(\d+)\/zip$/);
    const log = path.match(/\/jobs\/(\d+)\/logs$/);
    assert(archive || log, path);
    return Promise.resolve({
      status: 302,
      headers: new Headers([[
        "location",
        `https://productionresultssa1.blob.core.windows.net/${
          archive ? "archive" : "log"
        }/${(archive ?? log)![1]}`,
      ]]),
      bodyText: "",
    });
  };
  return { http, calls, artifacts, archives, logs };
}
