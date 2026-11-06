/**
 * The launcher's acceptance of one repository repair cell child (issue #328).
 *
 * The child (`REPAIR_CELL_CHILD_ENTRYPOINT`) prints exactly one
 * `sentinel_repair_cell` marker binding the native run, the runtime revision
 * and generation, its plan cell and the seal of the delta it wrote. The
 * launcher re-emits that one validated marker into the job log, where the
 * trusted finalize reads it back from the authenticated job (the same proof
 * shape as a matrix cell's marker). Anything else is the existing sanitized
 * launcher rejection: no marker, a second one, a foreign run, revision or
 * cell, or an unsettled child.
 */
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { ReplayCommandResultV1 } from "../replay/runtime.ts";
import {
  HOSTED_RUNTIME_FAILED_DETAIL,
  HOSTED_RUNTIME_HEALTHY_DETAIL,
  type HostedRuntimeLauncherResultV1,
  type HostedRuntimeMatrixLauncherRejectionV1,
  unavailableResult,
} from "./hosted-runtime-identity.ts";
import { hasExactKeys } from "./hosted-runtime-status.ts";

/** Fixed child entrypoint of the `repair_cell` job inside the runtime. */
export const REPAIR_CELL_CHILD_ENTRYPOINT = "src/host/repair-cell-actions.ts";
export const REPAIR_CELL_MARKER_KIND = "sentinel_repair_cell";
export const REPAIR_CELL_MARKER_KEYS = [
  "kind",
  "run",
  "runtimeSha",
  "generation",
  "cellId",
  "deltaDigest",
  "transitions",
] as const;

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function rejected(
  run: ReplayCommandResultV1,
  partial: Pick<
    HostedRuntimeMatrixLauncherRejectionV1,
    "condition" | "field" | "carrierCount"
  >,
): HostedRuntimeLauncherResultV1 {
  return {
    ...unavailableResult(),
    launcherRejection: {
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
    },
  };
}

/** True when `value` is one valid marker for this execution and cell. */
export function isRepairCellMarker(
  value: Record<string, unknown>,
  execution: Pick<
    HostedExecutionIntentV1,
    "runId" | "runAttempt" | "launcherSha" | "revision" | "generation"
  >,
  cellId: unknown,
): boolean {
  const native = value.run as Record<string, unknown> | null;
  return hasExactKeys(value, [...REPAIR_CELL_MARKER_KEYS]) &&
    value.kind === REPAIR_CELL_MARKER_KIND &&
    value.runtimeSha === execution.revision &&
    value.generation === execution.generation &&
    typeof native === "object" && native !== null && !Array.isArray(native) &&
    hasExactKeys(native, ["runId", "runAttempt", "launcherSha"]) &&
    native.runId === execution.runId &&
    native.runAttempt === execution.runAttempt &&
    native.launcherSha === execution.launcherSha &&
    isDigest(value.cellId) && value.cellId === cellId &&
    isDigest(value.deltaDigest) &&
    Number.isSafeInteger(value.transitions) &&
    (value.transitions as number) >= 0 &&
    (value.transitions as number) <= 100_000;
}

export function resolveRepairCellLauncherResult(
  run: ReplayCommandResultV1,
  execution: HostedExecutionIntentV1,
  stdin: string | undefined,
): HostedRuntimeLauncherResultV1 {
  if (
    run.outcome !== "exited" || !run.settled || run.truncated ||
    run.exitCode === null
  ) return rejected(run, { condition: "child_unsettled" });
  const selection = JSON.parse(stdin ?? "{}") as Record<string, unknown>;
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
    if (obj.kind !== REPAIR_CELL_MARKER_KIND) continue;
    if (!isRepairCellMarker(obj, execution, selection.cellId)) {
      return rejected(run, {
        condition: "carrier_field",
        field: "cell",
        carrierCount: found.length,
      });
    }
    found.push(obj);
  }
  if (found.length !== 1) {
    return rejected(run, {
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
