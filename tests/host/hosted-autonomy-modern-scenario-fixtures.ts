/**
 * Fixtures of the modern current-matrix recovery scenario
 * (`hosted-autonomy-modern-scenario.ts`); this module registers no tests.
 * The producer's published cell results, the parked or in-flight candidate
 * each control case starts from, and the ref API the hosted candidate port
 * reads from the real target repository.
 */
import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  type MatrixCellResultV1,
  matrixDigestV1,
} from "../../src/contracts/matrix.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { createGitBundleExporter } from "../../src/host/matrix-git.ts";
import { MATRIX_PRESERVATION_UNCERTAINTY_DETAIL } from "../../src/host/matrix-uncertainty-maintenance.ts";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy.ts";
import type { repositoryConfig } from "../budget/helpers.ts";
import { gitRun, type makeRemoteCtx, T0 } from "../state/helpers.ts";
import { ENV } from "./hosted-autonomy-fixtures.ts";
import type { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";

type ModernRigV1 = Awaited<ReturnType<typeof historicalMalformedRig>>;
type TargetV1 = Awaited<ReturnType<typeof makeRemoteCtx>>;

export type BlockedCandidateCase =
  | "valid"
  | "wrong-run"
  | "wrong-runtime"
  | "wrong-artifact"
  | "wrong-archive"
  | "wrong-candidate"
  | "wrong-task"
  | "cas-conflict"
  | "changed-record"
  | "post-write-readback-drift"
  | "wrong-preservation-readback"
  | "unsupported-reason"
  | "missing-artifact"
  | "expired-plan"
  | "unlisted-plan"
  | "existing-ref"
  | "existing-ref-conflict"
  | "existing-ref-parked"
  | "protected-refusal";

/** The restored record's state, its exact predecessor and the cycle deps. */
export interface InflightStateV1 {
  state: HostedAutonomyDepsV1["state"];
  clock: { now(): number };
  config: ReturnType<typeof repositoryConfig>;
  taskId: string;
  candidate: GitSha;
  base: GitSha;
}

/**
 * The same candidate parked in flight (`work`, no blocker) instead of blocked.
 * `consumed` leaves the producer's cell unconsumed instead: this maintenance
 * pass's own consumer settles it into the pending preservation, as live
 * maintenance does with the cells that finish after their repair job, and the
 * same pass must finish that preservation. `beforeRestore` runs once over the
 * exact pre-restore state; `afterRestore` replaces the built-in publication
 * run over the restored state.
 */
export interface InflightCaseV1 {
  wait: "unavailable" | "review_pending" | null;
  published?: "ancestor" | "unrelated";
  consumed?: boolean;
  beforeRestore?: (input: InflightStateV1) => Promise<void>;
  afterRestore?: (input: InflightStateV1) => Promise<void>;
}

async function checked(dir: string, args: string[]) {
  const result = await gitRun(dir, args, ENV);
  assert(result.ok, result.stderr);
  return result.stdout.trim();
}

/**
 * Publish the producer's two cell results as its native run's artifacts:
 * cell 0 failed, cell 1 completed with the candidate and its bundle, each
 * archived and logged under its exact cell marker.
 */
export async function publishModernCellResults(input: {
  f: ModernRigV1;
  base: GitSha;
  candidate: GitSha;
  target: TargetV1;
  targetRoot: string;
}): Promise<MatrixCellResultV1[]> {
  const { f, base, candidate, target, targetRoot } = input;
  const bundleFile = f.cells[1].cellId + ".bundle";
  const bundles = targetRoot + "/bundles";
  const exported = await createGitBundleExporter({
    repositoryDir: target.work,
    outputDir: bundles,
  }).create({ base, head: candidate, checkpointSha: null, file: bundleFile });
  assert(exported);
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
        observedModel: cell.request.model,
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
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", bytes.slice()),
      ),
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
  return results;
}

/**
 * Park the producer's completed candidate as the blocked (or in-flight)
 * record the control case names, and stage the artifact, plan listing and
 * preservation-ref surgery that case needs.
 */
export async function parkModernCandidate(input: {
  f: ModernRigV1;
  results: readonly MatrixCellResultV1[];
  blockedCandidate: BlockedCandidateCase;
  inflight: InflightCaseV1 | undefined;
  base: GitSha;
  candidate: GitSha;
  publishedHead: GitSha | null;
  target: TargetV1;
}): Promise<void> {
  const {
    f,
    results,
    blockedCandidate,
    inflight,
    base,
    candidate,
    publishedHead,
    target,
  } = input;
  const read = await f.rig.state.readRepair();
  assert(read.ok && read.value.status === "found");
  const planArtifact = f.artifacts.find((row) => row.id === 501)!;
  const planner = f.jobs.find((row) => row.name === "matrix_plan")!;
  let message =
    `authenticated historical matrix runtime mismatch; producer=${f.nativeRun.runId}:${f.nativeRun.runAttempt}; runtime=${f.execution.revision}; plan=${await matrixDigestV1(
      f.plan,
    )}; artifact=${planArtifact.id}; archive=${planArtifact.digest}; planner=${planner.id}; result=${await matrixDigestV1(
      results[1],
    )}; original admission retained`;
  if (blockedCandidate === "wrong-run") {
    message = message.replace(
      `producer=${f.nativeRun.runId}:`,
      "producer=999:",
    );
  }
  if (blockedCandidate === "wrong-runtime") {
    message = message.replace(
      `runtime=${f.execution.revision}`,
      `runtime=${"f".repeat(40)}`,
    );
  }
  if (blockedCandidate === "wrong-artifact") {
    message = message.replace(
      `artifact=${planArtifact.id};`,
      "artifact=999;",
    );
  }
  if (blockedCandidate === "wrong-archive") {
    message = message.replace(
      `archive=${planArtifact.digest};`,
      `archive=sha256:${"f".repeat(64)};`,
    );
  }
  if (blockedCandidate === "unsupported-reason") {
    message = "candidate touches a protected path";
  }
  if (blockedCandidate === "existing-ref-parked") {
    message = MATRIX_PRESERVATION_UNCERTAINTY_DETAIL;
  }
  const head = blockedCandidate === "wrong-candidate"
    ? "f".repeat(40) as GitSha
    : candidate;
  const at = T0 + 30_000;
  const work = await Promise.all(
    read.value.snapshot.work.map(async (row) =>
      row.id === f.cells[1].taskId && inflight?.consumed
        ? row
        : row.id === f.cells[1].taskId
        ? {
          ...row,
          ...(inflight
            ? {
              nextStep: "work" as const,
              blocker: null,
              wait: inflight.wait === null
                ? null
                : { reason: inflight.wait, since: at, until: at + 300_000 },
            }
            : {
              nextStep: "blocked" as const,
              blocker: { kind: "other" as const, message, since: at },
              wait: null,
            }),
          intent: {
            ...row.intent!,
            kind: "candidate_preservation" as const,
            startedAt: at,
            branch: await candidatePreservationRef(
              row.repository,
              row.id,
              row.intent!.key,
            ),
            expectedHead: head,
          },
          target: {
            ...row.target,
            head,
            pr: publishedHead === null ? row.target.pr : 1106,
            candidateState: { preserved: null, publishedHead },
          },
          updatedAt: at,
        }
        : {
          ...row,
          nextStep: "blocked" as const,
          blocker: {
            kind: "other" as const,
            message: "unsupported blocked fixture",
            since: at,
          },
          wait: null,
          updatedAt: at,
        }
    ),
  );
  const written = await f.rig.state.writeRepair({
    ...read.value.snapshot,
    stateHead: read.value.head,
    sequence: read.value.snapshot.sequence + 1,
    updatedAt: f.clock.now(),
    work,
    reservations: read.value.snapshot.reservations.map((row) =>
      row.id === f.cells[1].reservationId && !inflight?.consumed
        ? { ...row, outcome: "submitted" as const, settledAt: at }
        : row
    ),
  }, read.value.head);
  assert(written.ok && written.value.status === "applied");
  if (blockedCandidate === "missing-artifact") {
    f.artifacts.splice(f.artifacts.findIndex((row) => row.id === 503), 1);
  }
  if (blockedCandidate === "expired-plan") {
    f.artifacts.find((row) => row.id === 501)!.expired = true;
  }
  if (
    blockedCandidate === "unlisted-plan" ||
    blockedCandidate === "existing-ref" ||
    blockedCandidate === "existing-ref-conflict" ||
    blockedCandidate === "existing-ref-parked"
  ) {
    // Native-ref recovery needs no matrix artifact at all.
    f.artifacts.splice(0, f.artifacts.length);
  }
  // The hosted surface reads candidate preservation refs from the real
  // target repository; every other branch stays on the stable base.
  f.github.readBaseTip = async (branch: string) => {
    if (!branch.startsWith("sentinel-candidates/")) return base;
    const observed = await gitRun(target.work, [
      "rev-parse",
      "--verify",
      "refs/heads/" + branch,
    ], ENV);
    return observed.ok ? observed.stdout.trim() : null;
  };
  if (
    blockedCandidate === "existing-ref" ||
    blockedCandidate === "existing-ref-conflict" ||
    blockedCandidate === "existing-ref-parked"
  ) {
    const blockedRow = work.find((row) => row.id === f.cells[1].taskId)!;
    await checked(target.work, [
      "update-ref",
      blockedRow.intent!.branch!,
      blockedCandidate === "existing-ref-conflict" ? base : candidate,
    ]);
  }
}

/**
 * The hosted candidate port's ref API over the real target repository: a ref
 * read answers from the target's own refs, anything else reaches `http`.
 */
export function serveTargetRefs(
  http: HttpTransportV1,
  targetWork: string,
): HttpTransportV1 {
  return async (request) => {
    const path = new URL(request.url).pathname;
    const prefix = "/repos/Ubiquity-Sentinel/sentinel/git/ref/";
    if (path.startsWith(prefix)) {
      const ref = "refs/" + decodeURIComponent(path.slice(prefix.length));
      const observed = await gitRun(targetWork, [
        "rev-parse",
        "--verify",
        ref,
      ], ENV);
      return {
        status: observed.ok ? 200 : 404,
        headers: new Headers(),
        bodyText: observed.ok
          ? JSON.stringify({
            ref,
            object: { sha: observed.stdout.trim(), type: "commit" },
          })
          : "{}",
      };
    }
    return http(request);
  };
}
