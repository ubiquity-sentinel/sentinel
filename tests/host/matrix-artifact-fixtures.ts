/** Authenticated Actions HTTP/archive/state fixtures; no test registrations. */
import assert from "node:assert/strict";
import { CONTROLLER } from "./controller-identity-fixture.ts";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  matrixCellIdV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  type MatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import {
  type ModelRunRequestV1,
  portOk,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  createActionsMatrixArtifactHttpTransport,
  createActionsMatrixArtifactTransport,
} from "../../src/host/matrix-artifacts.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

export const LAUNCHER = "1".repeat(40) as GitSha;
export const RUNTIME = "2".repeat(40) as GitSha;
export const RUN = { runId: 71, runAttempt: 2, launcherSha: LAUNCHER };
export const WAVE = "71:2:repair";
export const RESERVATION = "a".repeat(64);
export const ISO = new Date(T0).toISOString();
export const ROOT = decodeURIComponent(
  new URL("../../", import.meta.url).pathname,
);
export const bytes = (value: unknown) =>
  new TextEncoder().encode(canonicalStringify(value));
export async function digest(value: Uint8Array) {
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", value.slice())),
  ].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function zip(
  entries: { name: string; content: Uint8Array; unixMode?: number }[],
) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  for (const entry of entries) {
    await writer.add(entry.name, new Uint8ArrayReader(entry.content), {
      unixMode: entry.unixMode ?? 0o100600,
    });
  }
  return await writer.close();
}
export async function fixture(paginated = false, partialMismatch = false) {
  const tmp = await Deno.makeTempDir({
    dir: ROOT,
    prefix: "matrix-transport-test-",
  });
  const checkout = `${tmp}/checkout`;
  await Deno.mkdir(checkout);
  const cellId = await matrixCellIdV1(WAVE, "artifact-task", RESERVATION);
  const request: ModelRunRequestV1 = {
    taskId: "artifact-task" as never,
    repository: REPO,
    base: SHA1,
    issue: { number: 1, title: "test", body: "test" },
    evidence: [],
    model: "gpt-reserve",
    reasoning: "max" as const,
    maxDurationMs: 10_000,
    maxOutputChars: 10_000,
  };
  const cell = {
    cellId,
    taskId: request.taskId,
    repository: REPO,
    reservationId: RESERVATION,
    intentKey: implementationIntentKey(RESERVATION),
    expectedBase: SHA1,
    runtimeSha: RUNTIME,
    generation: 3,
    requestDigest: await matrixDigestV1(request),
    request,
  };
  const plan: MatrixPlanV1 = {
    version: "v1",
    kind: "matrix_plan",
    waveId: WAVE,
    run: RUN,
    plannedAt: T0,
    cells: [cell],
  };
  const reservationB = "b".repeat(64);
  const cellIdB = await matrixCellIdV1(WAVE, "artifact-task-b", reservationB);
  const requestB: ModelRunRequestV1 = {
    ...request,
    taskId: "artifact-task-b" as never,
  };
  const cellB = {
    cellId: cellIdB,
    taskId: requestB.taskId,
    repository: REPO,
    reservationId: reservationB,
    intentKey: implementationIntentKey(reservationB),
    expectedBase: SHA1,
    runtimeSha: RUNTIME,
    generation: 3,
    requestDigest: await matrixDigestV1(requestB),
    request: requestB,
  };
  if (partialMismatch) plan.cells.push(cellB);
  const bundle = new Uint8Array([0x50, 0x4b, 0x00, 0xff, 0x80]);
  const result: MatrixCellResultV1 = {
    version: "v1",
    kind: "matrix_cell_result",
    waveId: WAVE,
    cellId,
    taskId: cell.taskId,
    repository: REPO,
    run: RUN,
    runtimeSha: RUNTIME,
    generation: 3,
    reservationId: RESERVATION,
    intentKey: cell.intentKey,
    requestDigest: cell.requestDigest,
    status: "completed",
    receipt: {
      invocationId: RESERVATION,
      outcome: "completed",
      actual: {
        evidenceKind: "request-runtime",
        provider: "test",
        threadId: "thread",
        turnId: "turn",
        terminalOrigin: "runtime",
        observedTerminalStatus: "completed",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
        durationMs: 1,
        outputChars: 1,
      },
      candidate: { head: SHA2, checkpointSha: null, changedPaths: ["fix.ts"] },
      error: null,
    },
    bundle: {
      file: `${cellId}.bundle`,
      digest: await digest(bundle),
      head: SHA2,
      checkpointSha: null,
    },
    detail: null,
    completedAt: T0,
  };
  const work = workRecord("artifact-task", {
    repository: REPO,
    target: {
      base: SHA1,
      branch: "sentinel/test",
      checkpoint: null,
      head: null,
      pr: null,
    },
    intent: {
      kind: "implementation",
      key: cell.intentKey,
      startedAt: T0,
      branch: "sentinel/test",
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId: RESERVATION,
      resultId: null,
    },
  });
  const workB = workRecord("artifact-task-b", {
    repository: REPO,
    target: {
      base: SHA1,
      branch: "sentinel/test",
      checkpoint: null,
      head: null,
      pr: null,
    },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(reservationB),
      startedAt: T0,
      branch: "sentinel/test",
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId: reservationB,
      resultId: null,
    },
  });
  const repair = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: partialMismatch ? [work, workB] : [work],
    reservations: partialMismatch
      ? [
        {
          version: "v1",
          kind: "budget_reservation",
          repository: REPO,
          id: RESERVATION,
          taskId: work.id,
          attempt: 1,
          head: SHA1,
          purpose: "implementation",
          createdAt: T0,
          outcome: "reserved",
          settledAt: null,
          proofRef: null,
        },
        {
          version: "v1",
          kind: "budget_reservation",
          repository: REPO,
          id: reservationB,
          taskId: workB.id,
          attempt: 1,
          head: SHA1,
          purpose: "implementation",
          createdAt: T0,
          outcome: "reserved",
          settledAt: null,
          proofRef: null,
        },
      ]
      : [{
        version: "v1",
        kind: "budget_reservation",
        repository: REPO,
        id: RESERVATION,
        taskId: work.id,
        attempt: 1,
        head: SHA1,
        purpose: "implementation",
        createdAt: T0,
        outcome: "reserved",
        settledAt: null,
        proofRef: null,
      }],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  // A later execution has replaced the old execution/proofs; old intent survives.
  const release = parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: [{
      version: "v1",
      kind: "hosted_runtime",
      id: CONTROLLER.runtimeId,
      activeRevision: RUNTIME,
      generation: 3,
      lastHealthyProof: null,
      lastExecutionProof: null,
      nextOrdinaryAt: T0,
      execution: {
        id: "99:1:repair",
        runId: 99,
        runAttempt: 1,
        launcherSha: LAUNCHER,
        purpose: "ordinary",
        revision: RUNTIME,
        generation: 3,
        releaseId: null,
        createdAt: T0,
      },
      createdAt: T0,
      updatedAt: T0,
    }],
    hostedReleases: [],
    githubCooldowns: [],
  });
  const state: StateReadView = {
    readRepair: () =>
      Promise.resolve(
        portOk({ status: "found", snapshot: repair, head: SHA1, ref: null }),
      ),
    readRelease: () =>
      Promise.resolve(
        portOk({ status: "found", snapshot: release, head: SHA1, ref: null }),
      ),
  };
  const provenance = {
    id: 71,
    repository_id: 123,
    head_repository_id: 123,
    head_branch: "sentinel-supervisor",
    head_sha: LAUNCHER,
  };
  const planName = "sentinel-matrix-plan-71-2",
    cellName = `sentinel-matrix-cell-71-2-${cellId}`;
  const archives = new Map<number, Uint8Array>();
  const artifacts: Record<string, unknown>[] = [];
  async function setArchive(id: number, name: string, content: Uint8Array) {
    archives.set(id, content);
    const artifact = {
      id,
      name,
      size_in_bytes: content.length,
      expired: false,
      digest: `sha256:${await digest(content)}`,
      workflow_run: provenance,
    };
    const index = artifacts.findIndex((row) => row.id === id);
    if (index < 0) artifacts.push(artifact);
    else artifacts[index] = artifact;
  }
  await setArchive(
    501,
    planName,
    await zip([{ name: "plan.json", content: bytes(plan) }]),
  );
  await setArchive(
    502,
    cellName,
    await zip([{ name: "result.json", content: bytes(result) }, {
      name: `${cellId}.bundle`,
      content: bundle,
    }]),
  );
  const plannerMarker = {
    kind: "sentinel_matrix_plan",
    waveId: WAVE,
    run: RUN,
    runtimeSha: RUNTIME,
    generation: 3,
    planDigest: await matrixDigestV1(plan),
    prepared: plan.cells.length,
  };
  const cellMarker = {
    kind: "sentinel_matrix_cell",
    run: RUN,
    runtimeSha: RUNTIME,
    generation: 3,
    cellId,
    reservationId: RESERVATION,
    resultDigest: await matrixDigestV1(result),
    bundleDigest: result.bundle!.digest,
    status: "completed",
  };
  const logs = new Map([[401, `${ISO} ${JSON.stringify(plannerMarker)}\n`], [
    402,
    `${ISO} ${JSON.stringify(cellMarker)}\n`,
  ]]);
  const job = (id: number, name: string, step: string) => ({
    id,
    name,
    run_id: RUN.runId,
    run_attempt: RUN.runAttempt,
    head_sha: LAUNCHER,
    status: "completed",
    conclusion: "success",
    started_at: ISO,
    completed_at: ISO,
    steps: [{
      name: step,
      number: 1,
      status: "completed",
      conclusion: "success",
      started_at: ISO,
      completed_at: ISO,
    }],
  });
  const jobs = [
    job(401, "matrix_plan", "Plan isolated issue matrix"),
    job(402, `matrix_cell (${cellId})`, "Run isolated issue cell"),
  ];
  if (paginated) {
    artifacts.unshift(
      ...Array.from(
        { length: 100 },
        (_, i) => ({ id: i + 1000, name: `other-${i}` }),
      ),
    );
    jobs.unshift(
      ...Array.from(
        { length: 100 },
        (_, i) => job(i + 2000, `other-${i}`, "other"),
      ),
    );
  }
  const attempt: Record<string, unknown> = {
    id: 71,
    run_attempt: 2,
    workflow_id: HOSTED_SUPERVISOR_WORKFLOW_ID,
    path: HOSTED_SUPERVISOR_WORKFLOW_PATH,
    event: "workflow_dispatch",
    head_branch: "sentinel-supervisor",
    head_sha: LAUNCHER,
    repository: { id: 123, full_name: CONTROLLER.fullName },
    head_repository: { id: 123, full_name: CONTROLLER.fullName },
    status: "in_progress",
    run_started_at: ISO,
    updated_at: ISO,
  };
  const calls: { url: string; auth: boolean }[] = [];
  const paginationRepository: { id: number; full_name: string } = {
    id: 123,
    full_name: CONTROLLER.fullName,
  };
  const pagination = {
    numeric: false,
    next: null as string | null,
    repository: paginationRepository,
    truncate: false,
    duplicate: false,
    /** Called before each listing page is answered (the listing race). */
    onPage: undefined as
      | ((key: "jobs" | "artifacts", page: number) => void)
      | undefined,
  };
  const http = createActionsMatrixArtifactHttpTransport((url, init) => {
    const parsed = new URL(url);
    calls.push({ url, auth: Boolean(init?.headers?.authorization) });
    const reply = (body: unknown, headers: Record<string, string> = {}) =>
      Promise.resolve(new Response(JSON.stringify(body), { headers }));
    if (parsed.host.endsWith("blob.core.windows.net")) {
      assert.equal(init?.headers?.authorization, undefined);
      assert.equal(init?.redirect, "error");
      if (parsed.pathname.startsWith("/archive/")) {
        return Promise.resolve(
          new Response(
            archives.get(Number(parsed.pathname.split("/").at(-1)))!.slice(),
          ),
        );
      }
      return Promise.resolve(
        new Response(logs.get(Number(parsed.pathname.split("/").at(-1)))!),
      );
    }
    assert.equal(init?.headers?.authorization, "Bearer fake-local-token");
    assert.equal(init?.redirect, "manual");
    if (parsed.pathname === CONTROLLER.apiPath) {
      return reply(pagination.repository);
    }
    if (parsed.pathname.endsWith("/attempts/2")) return reply(attempt);
    if (
      parsed.pathname.endsWith("/artifacts") ||
      parsed.pathname.endsWith("/jobs")
    ) {
      const key = parsed.pathname.endsWith("/jobs") ? "jobs" : "artifacts";
      const rows = key === "jobs" ? jobs : artifacts;
      const page = Number(parsed.searchParams.get("page"));
      pagination.onPage?.(key, page);
      const nextPath = pagination.numeric
        ? parsed.pathname.replace(
          CONTROLLER.apiPath,
          "/repositories/123",
        )
        : parsed.pathname;
      const next = rows.length > page * 100
        ? `<${
          pagination.next ??
            `${parsed.origin}${nextPath}?per_page=100&page=${page + 1}`
        }>; rel="next"`
        : "";
      const entries: Record<string, unknown>[] = rows.slice(
        (page - 1) * 100,
        page * 100,
      );
      if (page === 2 && pagination.truncate) entries.pop();
      if (page === 2 && pagination.duplicate) {
        entries[entries.length - 1] = { ...rows[0] };
      }
      return reply({
        total_count: rows.length,
        [key]: entries,
      }, next ? { link: next } : {});
    }
    const archive = parsed.pathname.match(/\/artifacts\/(\d+)\/zip$/),
      log = parsed.pathname.match(/\/jobs\/(\d+)\/logs$/);
    if (archive || log) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: `https://productionresultssa1.blob.core.windows.net/${
              archive ? "archive" : "log"
            }/${(archive ?? log)![1]}`,
          },
        }),
      );
    }
    throw new Error("unexpected fake route");
  });
  const artifactTransport = createActionsMatrixArtifactTransport({
    state,
    token: "fake-local-token",
    http,
    clock: { now: () => T0 + 10_000 },
    artifactRoot: `${tmp}/recovered`,
  });
  const transport: typeof artifactTransport = {
    async recover(input) {
      const originalCwd = Deno.cwd();
      Deno.chdir(checkout);
      try {
        return await artifactTransport.recover(input);
      } finally {
        Deno.chdir(originalCwd);
      }
    },
  };
  const input = {
    requests: [
      {
        taskId: work.id,
        repository: REPO,
        reservationId: RESERVATION,
        intentKey: cell.intentKey,
        expectedBase: SHA1,
        attempt: 1,
      },
      ...(partialMismatch
        ? [{
          taskId: workB.id,
          repository: REPO,
          reservationId: reservationB,
          intentKey: cellB.intentKey,
          expectedBase: SHA1,
          attempt: 1,
        }]
        : []),
    ],
    runtimeSha: RUNTIME,
    launcherSha: LAUNCHER,
    currentRun: RUN,
  };
  return {
    tmp,
    plan,
    result,
    bundle,
    cell,
    cellB,
    reservationB,
    workB,
    repair,
    release,
    artifacts,
    jobs,
    attempt,
    logs,
    plannerMarker,
    cellMarker,
    archives,
    calls,
    pagination,
    http,
    state,
    transport,
    input,
    setArchive,
    planName,
    cellName,
  };
}
