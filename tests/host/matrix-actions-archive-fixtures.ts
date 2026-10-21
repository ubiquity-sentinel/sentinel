/** Exact native jobs, logs and digest-bound ZIP/HTTP fixtures; no test registrations. */
import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { createActionsMatrixArtifactHttpTransport } from "../../src/host/matrix-artifacts.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../../src/contracts/hosted-supervisor.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import { matrixCellIdV1, matrixDigestV1 } from "../../src/contracts/matrix.ts";
import type { rig } from "./matrix-actions-fixtures.ts";
import type { MatrixPlanReportV1 } from "../../src/host/matrix.ts";

export async function createFreshMatrixArchives(
  r: Awaited<ReturnType<typeof rig>>,
  planner: MatrixPlanReportV1 & { planDigest: string },
  results: MatrixCellResultV1[],
  archive: string,
  noStart17: boolean,
  historicalRuntimeIsolation: boolean,
  nativeScopedOnly: boolean,
) {
  const artifactCalls: string[] = [];
  const encode = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const byteDigest = async function (value: Uint8Array) {
    return [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", value.slice())),
    ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const zip = async function (
    entries: { name: string; content: Uint8Array }[],
  ) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
    });
    for (const entry of entries) {
      await writer.add(entry.name, new Uint8ArrayReader(entry.content), {
        unixMode: 0o100600,
      });
    }
    return await writer.close();
  };
  const archives = new Map<number, Uint8Array>();
  const artifactRows: Record<string, unknown>[] = [];
  const provenance = {
    id: 71,
    repository_id: 123,
    head_repository_id: 123,
    head_branch: "sentinel-supervisor",
    head_sha: r.sha,
  };
  const archiveRow = async function (
    id: number,
    name: string,
    bytes: Uint8Array,
  ) {
    archives.set(id, bytes);
    artifactRows.push({
      id,
      name,
      size_in_bytes: bytes.length,
      expired: false,
      digest: "sha256:" + await byteDigest(bytes),
      workflow_run: provenance,
    });
  };
  await archiveRow(
    501,
    "sentinel-matrix-plan-71-1",
    await zip([{ name: "plan.json", content: encode(planner.plan) }]),
  );
  for (const [index, result] of results.entries()) {
    await archiveRow(
      502 + index,
      "sentinel-matrix-cell-71-1-" + result.cellId,
      await zip([
        { name: "result.json", content: encode(result) },
        ...(result.bundle
          ? [{
            name: result.bundle!.file,
            content: await Deno.readFile(archive + "/" + result.bundle!.file),
          }]
          : []),
      ]),
    );
  }
  const iso = new Date(planner.plan.plannedAt).toISOString();
  const plannerMarker = {
    kind: "sentinel_matrix_plan",
    waveId: planner.plan.waveId,
    run: planner.plan.run,
    runtimeSha: r.sha,
    generation: 1,
    planDigest: planner.planDigest,
    prepared: planner.prepared,
  };
  const logs = new Map<number, string>([[
    401,
    iso + " " + JSON.stringify(plannerMarker) + "\n",
  ]]);
  const job = (id: number, name: string, step: string, at = iso) => ({
    id,
    name,
    run_id: 71,
    run_attempt: 1,
    head_sha: r.sha,
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
  const jobs = [job(401, "matrix_plan", "Plan isolated issue matrix")];
  for (const [index, result] of results.entries()) {
    const at = noStart17 ? new Date(result.completedAt).toISOString() : iso;
    jobs.push(
      job(
        402 + index,
        "matrix_cell (" + result.cellId + ")",
        "Run isolated issue cell",
        at,
      ),
    );
    logs.set(
      402 + index,
      at + " " +
        JSON.stringify({
          kind: "sentinel_matrix_cell",
          run: result.run,
          runtimeSha: result.runtimeSha,
          generation: result.generation,
          cellId: result.cellId,
          reservationId: result.reservationId,
          resultDigest: await matrixDigestV1(result),
          bundleDigest: result.bundle?.digest ?? null,
          status: result.status,
        }) + "\n",
    );
  }
  // Minimal sanitized replay of ai#908's captured boundary: its admission
  // predates the manifest, native planner/cell agree on an older runtime,
  // and a later consumer must isolate that wave without importing its result.
  if (historicalRuntimeIsolation) {
    const oldRuntime = "e".repeat(40) as GitSha;
    const oldRun = { ...planner.plan.run, runId: 69 };
    const oldWave = "69:1:repair";
    const oldCell = structuredClone(
      planner.plan.cells.find((cell) => cell.repository.name === "ai.ubq.fi")!,
    );
    const originalCellId = oldCell.cellId;
    oldCell.cellId = await matrixCellIdV1(
      oldWave,
      oldCell.taskId,
      oldCell.reservationId,
    );
    oldCell.runtimeSha = oldRuntime;
    const oldResult = structuredClone(
      results.find((cell) => cell.cellId === originalCellId)!,
    );
    const oldBundle = await Deno.readFile(
      archive + "/" + oldResult.bundle!.file,
    );
    Object.assign(oldResult, {
      run: oldRun,
      waveId: oldWave,
      cellId: oldCell.cellId,
      runtimeSha: oldRuntime,
    });
    oldResult.bundle!.file = oldCell.cellId + ".bundle";
    const oldPlan = {
      ...planner.plan,
      run: oldRun,
      waveId: oldWave,
      cells: [oldCell],
    };
    const currentPlan = {
      ...planner.plan,
      cells: planner.plan.cells.filter((cell) =>
        cell.repository.name === "sentinel"
      ),
    };
    artifactRows.length = 0;
    archives.clear();
    await archiveRow(
      501,
      "sentinel-matrix-plan-71-1",
      await zip([{ name: "plan.json", content: encode(currentPlan) }]),
    );
    const currentResult = results.find((cell) =>
      cell.repository.name === "sentinel"
    )!;
    await archiveRow(
      502,
      "sentinel-matrix-cell-71-1-" + currentResult.cellId,
      await zip([
        { name: "result.json", content: encode(currentResult) },
        {
          name: currentResult.bundle!.file,
          content: await Deno.readFile(
            archive + "/" + currentResult.bundle!.file,
          ),
        },
      ]),
    );
    await archiveRow(
      503,
      "sentinel-matrix-plan-69-1",
      await zip([{ name: "plan.json", content: encode(oldPlan) }]),
    );
    await archiveRow(
      504,
      "sentinel-matrix-cell-69-1-" + oldCell.cellId,
      await zip([
        { name: "result.json", content: encode(oldResult) },
        { name: oldResult.bundle!.file, content: oldBundle },
      ]),
    );
    for (const row of artifactRows.filter((row) => Number(row.id) >= 503)) {
      row.workflow_run = { ...provenance, id: 69 };
    }
    // Put the rejected wave first: later valid artifacts must still advance.
    artifactRows.unshift(...artifactRows.splice(2));
    logs.set(
      401,
      iso + " " +
        JSON.stringify({
          ...plannerMarker,
          prepared: 1,
          planDigest: await matrixDigestV1(currentPlan),
        }) + "\n",
    );
    const currentJob = jobs.find((row) =>
      row.name === "matrix_cell (" + currentResult.cellId + ")"
    )!;
    const currentLog = logs.get(currentJob.id)!;
    jobs.splice(1, jobs.length - 1, currentJob);
    logs.set(currentJob.id, currentLog);
    const oldPlannerJob = {
      ...job(405, "matrix_plan", "Plan isolated issue matrix"),
      run_id: 69,
    };
    const oldCellJob = {
      ...job(
        406,
        "matrix_cell (" + oldCell.cellId + ")",
        "Run isolated issue cell",
      ),
      run_id: 69,
    };
    jobs.push(oldPlannerJob, oldCellJob);
    logs.set(
      405,
      iso + " " +
        JSON.stringify({
          ...plannerMarker,
          run: oldRun,
          waveId: oldWave,
          runtimeSha: oldRuntime,
          prepared: 1,
          planDigest: await matrixDigestV1(oldPlan),
        }) + "\n",
    );
    logs.set(
      406,
      iso + " " + JSON.stringify({
        kind: "sentinel_matrix_cell",
        run: oldRun,
        runtimeSha: oldRuntime,
        generation: 1,
        cellId: oldCell.cellId,
        reservationId: oldCell.reservationId,
        resultDigest: await matrixDigestV1(oldResult),
        bundleDigest: oldResult.bundle!.digest,
        status: oldResult.status,
      }) + "\n",
    );
  }
  const artifactHttp = function (
    available: () => boolean,
    allow: (row: Record<string, unknown>) => boolean = () => true,
  ) {
    return createActionsMatrixArtifactHttpTransport((url, init) => {
      artifactCalls.push(url);
      const parsed = new URL(url);
      const reply = (body: unknown) =>
        Promise.resolve(new Response(JSON.stringify(body)));
      if (parsed.host.endsWith("blob.core.windows.net")) {
        assert.equal(init?.headers?.authorization, undefined);
        assert.equal(init?.redirect, "error");
        return Promise.resolve(
          new Response(
            parsed.pathname.startsWith("/archive/")
              ? archives.get(Number(parsed.pathname.split("/").at(-1)))!
                .slice()
              : logs.get(Number(parsed.pathname.split("/").at(-1)))!,
          ),
        );
      }
      assert.equal(init?.headers?.authorization, "Bearer fake-read-token");
      assert.equal(init?.redirect, "manual");
      const attempt = parsed.pathname.match(/\/runs\/(\d+)\/attempts\/1$/);
      if (attempt) {
        return reply({
          id: Number(attempt[1]),
          run_attempt: 1,
          workflow_id: HOSTED_SUPERVISOR_WORKFLOW_ID,
          path: HOSTED_SUPERVISOR_WORKFLOW_PATH,
          event: "workflow_dispatch",
          head_branch: "sentinel-supervisor",
          head_sha: r.sha,
          repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
          head_repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
          status: "in_progress",
          run_started_at: iso,
          updated_at: iso,
        });
      }
      if (parsed.pathname.endsWith("/artifacts")) {
        if (
          nativeScopedOnly &&
          parsed.pathname ===
            "/repos/ubiquity-sentinel/sentinel/actions/artifacts"
        ) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                total_count: artifactRows.length + 100,
                artifacts: artifactRows,
              }),
              {
                headers: {
                  link:
                    '<https://api.github.com/repositories/123/actions/artifacts?per_page=100&page=2>; rel="next"',
                },
              },
            ),
          );
        }
        const rows = available() && !parsed.pathname.includes("/runs/72/")
          ? artifactRows.filter(allow)
          : [];
        return reply({ total_count: rows.length, artifacts: rows });
      }
      if (parsed.pathname.endsWith("/jobs")) {
        const runId = Number(parsed.pathname.match(/\/runs\/(\d+)\//)![1]);
        const selectedJobs = jobs.filter((row) => row.run_id === runId);
        return reply({
          total_count: selectedJobs.length,
          jobs: selectedJobs,
        });
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
      throw Error("unexpected native artifact API route");
    });
  };

  return {
    artifactCalls,
    encode,
    byteDigest,
    zip,
    archives,
    artifactRows,
    logs,
    jobs,
    artifactHttp,
    iso,
    plannerMarker,
  };
}
