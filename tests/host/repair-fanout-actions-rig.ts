/**
 * The GitHub Actions run of one repository repair fan-out (issue #328), as
 * finalize and the serial job's hand-back reader read it: the run attempt,
 * its jobs and signed logs, and real ZIP artifacts served through the
 * production bounded transport (302 to blob storage, GitHub's archive
 * digest). No network.
 */
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../../src/contracts/hosted-supervisor.ts";
import type { RepairDeltaEnvelopeV1 } from "../../src/contracts/repair-delta.ts";
import { createActionsMatrixArtifactHttpTransport } from "../../src/host/matrix-artifacts.ts";
import { REPAIR_CELL_STEP } from "../../src/host/repair-fanout-finalize.ts";
import { REPAIR_CELL_MARKER_KIND } from "../../src/host/hosted-runtime-repair-cell.ts";
import type { RepairFanoutPlanV1 } from "../../src/repair/repair-fanout-plan.ts";
import { MINUTE } from "../repair/repository-pass-rig.ts";
import { SHA1, SHA2 } from "../state/helpers.ts";

export const RUN = { runId: 41, runAttempt: 1, launcherSha: SHA1 };
export const RUNTIME = { revision: SHA2, generation: 3 };
export const TOKEN = "fake-read-token-0123456789";

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

/**
 * The Actions run of one fan-out: jobs, logs and uploaded artifacts.
 * `envelopes` holds each cell's uploaded result by repository name.
 */
export async function actionsRun(
  rig: { clock: { now(): number } },
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
