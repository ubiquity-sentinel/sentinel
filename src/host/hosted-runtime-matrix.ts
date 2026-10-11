/** Hosted hosted-runtime-matrix responsibility. */
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { ReplayCommandResultV1 } from "../replay/runtime.ts";
import {
  failIdentity,
  HOSTED_RUNTIME_FAILED_DETAIL,
  HOSTED_RUNTIME_HEALTHY_DETAIL,
  unavailableResult,
} from "./hosted-runtime-identity.ts";
import type {
  HostedRuntimeJobV1,
  HostedRuntimeLauncherResultV1,
  HostedRuntimeMatrixLauncherRejectionV1,
} from "./hosted-runtime-identity.ts";
import { hasExactKeys } from "./hosted-runtime-status.ts";

/** Native role selects a fixed entrypoint; no override may impersonate repair. */
export function runtimeJob(
  value: string | undefined,
): "repair" | "matrix_plan" | "matrix_cell" {
  if (
    value === "repair" || value === "matrix_plan" || value === "matrix_cell"
  ) return value;
  failIdentity();
}

export function nativeMatrixStdin(
  value: string | undefined,
  job: HostedRuntimeJobV1,
): string | undefined {
  if (job === "matrix_plan") {
    if (value !== undefined) failIdentity();
    return undefined;
  }
  if (value === undefined || value.trim() === "") {
    if (job === "matrix_cell") failIdentity();
    return undefined;
  }
  if (new TextEncoder().encode(value).byteLength > 512) failIdentity();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    failIdentity();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    failIdentity();
  }
  const obj = parsed as Record<string, unknown>;
  const keys = job === "matrix_cell"
    ? ["planDigest", "cellId"]
    : ["planDigest"];
  if (
    !hasExactKeys(obj, keys) || !isDigest(obj.planDigest) ||
    (job === "matrix_cell" && !isDigest(obj.cellId))
  ) failIdentity();
  return JSON.stringify(obj);
}

export async function readNativeMatrixStdin(): Promise<string | undefined> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const part of Deno.stdin.readable) {
    total += part.byteLength;
    if (total > 512) failIdentity();
    parts.push(part);
  }
  if (total === 0) return undefined;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Fail-closed matrix launcher rejection with a sanitized typed receipt.
 * Status stays "unavailable", the terminal stays null and no matrixCarrier is
 * returned; only the closed condition, the typed child outcome metadata, the
 * rejected field group and the parsed carrier count are surfaced. Never raw
 * child streams, prompts or secret values.
 */
function rejectedMatrixLauncherResult(
  run: ReplayCommandResultV1,
  partial: Pick<
    HostedRuntimeMatrixLauncherRejectionV1,
    "condition" | "field" | "carrierCount"
  >,
): HostedRuntimeLauncherResultV1 {
  const receipt: HostedRuntimeMatrixLauncherRejectionV1 = {
    version: "v1",
    kind: "hosted_runtime_matrix_launcher_rejection",
    condition: partial.condition,
    ...(partial.field === undefined ? {} : { field: partial.field }),
    outcome: run.outcome,
    exitCode: run.exitCode,
    settled: run.settled,
    truncated: run.truncated,
    ...(partial.carrierCount === undefined
      ? {}
      : { carrierCount: partial.carrierCount }),
  };
  return { ...unavailableResult(), launcherRejection: receipt };
}

export function resolveMatrixLauncherResult(
  run: ReplayCommandResultV1,
  execution: HostedExecutionIntentV1,
  job: "matrix_plan" | "matrix_cell",
  stdin: string | undefined,
): HostedRuntimeLauncherResultV1 {
  if (
    run.outcome !== "exited" || !run.settled || run.truncated ||
    run.exitCode === null
  ) return rejectedMatrixLauncherResult(run, { condition: "child_unsettled" });
  const kind = job === "matrix_plan"
    ? "sentinel_matrix_plan"
    : "sentinel_matrix_cell";
  const found: Record<string, unknown>[] = [];
  for (const line of new TextDecoder().decode(run.stdout).split("\n")) {
    if (line.length > 4096) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    const obj = value as Record<string, unknown>;
    if (obj.kind !== kind) continue;
    const keys = job === "matrix_plan"
      ? [
        "kind",
        "waveId",
        "run",
        "runtimeSha",
        "generation",
        "planDigest",
        "prepared",
      ]
      : [
        "kind",
        "run",
        "runtimeSha",
        "generation",
        "cellId",
        "reservationId",
        "resultDigest",
        "bundleDigest",
        "status",
      ];
    if (
      !hasExactKeys(obj, keys) || obj.runtimeSha !== execution.revision ||
      obj.generation !== execution.generation
    ) {
      return rejectedMatrixLauncherResult(run, {
        condition: "carrier_field",
        field: "runtime_sha",
        carrierCount: found.length,
      });
    }
    const native = obj.run;
    if (
      typeof native !== "object" || native === null || Array.isArray(native)
    ) {
      return rejectedMatrixLauncherResult(run, {
        condition: "carrier_field",
        field: "identity",
        carrierCount: found.length,
      });
    }
    const identity = native as Record<string, unknown>;
    if (
      !hasExactKeys(identity, ["runId", "runAttempt", "launcherSha"]) ||
      identity.runId !== execution.runId ||
      identity.runAttempt !== execution.runAttempt ||
      identity.launcherSha !== execution.launcherSha
    ) {
      return rejectedMatrixLauncherResult(run, {
        condition: "carrier_field",
        field: "identity",
        carrierCount: found.length,
      });
    }
    if (job === "matrix_plan") {
      if (
        obj.waveId !== execution.id || !isDigest(obj.planDigest) ||
        typeof obj.prepared !== "number" ||
        !Number.isSafeInteger(obj.prepared) ||
        obj.prepared < 0 || obj.prepared > 256
      ) {
        return rejectedMatrixLauncherResult(run, {
          condition: "carrier_field",
          field: "plan",
          carrierCount: found.length,
        });
      }
    } else {
      const selection = JSON.parse(stdin ?? "{}") as Record<string, unknown>;
      if (
        obj.cellId !== selection.cellId || !isDigest(obj.cellId) ||
        typeof obj.reservationId !== "string" ||
        obj.reservationId.length === 0 ||
        obj.reservationId.length > 256 ||
        Array.from(obj.reservationId).some((char) => char.charCodeAt(0) < 32) ||
        !isDigest(obj.resultDigest) ||
        (obj.bundleDigest !== null && !isDigest(obj.bundleDigest)) ||
        !["completed", "failed", "not_started"].includes(String(obj.status))
      ) {
        return rejectedMatrixLauncherResult(run, {
          condition: "carrier_field",
          field: "cell",
          carrierCount: found.length,
        });
      }
    }
    found.push(obj);
  }
  if (found.length !== 1) {
    return rejectedMatrixLauncherResult(run, {
      condition: "carrier_count",
      carrierCount: found.length,
    });
  }
  return {
    status: run.exitCode === 0 ? "healthy" : "failed",
    terminal: null,
    detail: run.exitCode === 0
      ? HOSTED_RUNTIME_HEALTHY_DETAIL
      : HOSTED_RUNTIME_FAILED_DETAIL,
    diagnostics: [],
    matrixCarrier: found[0],
  };
}
