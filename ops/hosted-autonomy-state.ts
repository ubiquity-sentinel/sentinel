import type { PortResultV1, StateReadView } from "../src/contracts/ports.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type {
  HostedAutonomyReasonV1,
  HostedAutonomyResultV1,
  MaintenanceFailureCategoryV1,
} from "./hosted-autonomy-types.ts";

export function skipped(
  reason: HostedAutonomyReasonV1,
  beforeHead: string | null,
  actions: readonly string[] = [],
): HostedAutonomyResultV1 {
  return {
    kind: "hosted_autonomy",
    status: "skipped",
    reason,
    beforeHead,
    appliedHead: null,
    actions,
    revisions: [],
  };
}

export function failed(
  reason: HostedAutonomyReasonV1,
  beforeHead: string | null,
  actions: readonly string[] = [],
): HostedAutonomyResultV1 {
  return { ...skipped(reason, beforeHead, actions), status: "failed" };
}

export async function readRepairSafely(
  state: StateReadView,
): Promise<
  PortResultV1<
    { status: "found"; head: string; snapshot: RepairStateSnapshotV1 } | {
      status: "missing";
    }
  > | null
> {
  try {
    return await state.readRepair() as PortResultV1<
      { status: "found"; head: string; snapshot: RepairStateSnapshotV1 } | {
        status: "missing";
      }
    >;
  } catch {
    return null;
  }
}

export async function readReleaseSafely(
  state: StateReadView,
): Promise<
  PortResultV1<
    { status: "found"; head: string; snapshot: ReleaseStateSnapshotV1 } | {
      status: "missing";
    }
  > | null
> {
  try {
    return await state.readRelease() as PortResultV1<
      { status: "found"; head: string; snapshot: ReleaseStateSnapshotV1 } | {
        status: "missing";
      }
    >;
  } catch {
    return null;
  }
}

/**
 * The historical quarantine upkeep pass stopped before completing. `integrity`
 * is false only for a fixed pre-write availability refusal (an unavailable
 * producer or absent custody), which is a bounded deferral that writes nothing
 * and lets the run continue (DECISIONS: bounded self-upkeep defers). Every
 * other stop, including changed or conflicting custody, an ambiguous artifact
 * provenance refusal, an unknown error and any stop after a settlement or
 * block write began, fails closed.
 */
export class HistoricalQuarantineIncomplete extends Error {
  constructor(readonly integrity = true) {
    super("historical matrix quarantine incomplete");
  }
}

/**
 * Fixed quarantine refusals raised before any settlement or block write that
 * report only unavailable or unproven inputs. The closed list keeps the
 * classification independent of transport or payload text; the 2026-11-03
 * outage was `historical matrix saved execution unavailable`.
 */
const HISTORICAL_QUARANTINE_DEFERRABLE_MESSAGES: ReadonlySet<string> = new Set([
  "historical matrix not-started admission unproven",
  "historical matrix state unavailable",
  "historical matrix selected reservation binding unavailable",
  "historical matrix release unavailable",
  "historical matrix current native writers unsettled",
  "historical matrix current native settlement unavailable",
  "historical matrix saved custody unavailable",
  "historical matrix release witness unavailable",
  "historical matrix verification completion unavailable",
  "historical matrix verification proof unavailable",
  "historical matrix saved execution unavailable",
  "historical matrix native settlement unavailable",
  "historical matrix native custody unavailable",
  "historical matrix selected witness rejection unavailable",
  "historical matrix rejection identity unavailable",
  "historical matrix custody unavailable",
  "historical matrix pre-settlement custody unavailable",
]);

/** True only for a fixed pre-write availability quarantine refusal. */
export function isDeferrableHistoricalQuarantineMessage(
  message: string,
): boolean {
  return HISTORICAL_QUARANTINE_DEFERRABLE_MESSAGES.has(message);
}

const MAINTENANCE_PROGRESS_PHASES = [
  "preflight",
  "queue_custody",
  "matrix_baseline",
  "closed_matrix_prepare",
  "closed_matrix_ingest",
  "existing_candidate_refs",
  "current_matrix",
  "current_matrix_scan",
  "current_matrix_history_close",
  "historical_c63",
  "historical_quarantine",
  "matrix_uncertainty",
  "context_closure_delivery",
  "closure_delivery",
  "context_retry",
  "retry",
  "context_delivery",
  "delivery",
  "context_closure",
  "closure",
  "self_observation",
  "followup",
  "base_repair",
  "ci_resume",
  "ci_outage",
  "summary_memory",
  "summary_park",
  "artifact_cleanup",
  "target_capability",
] as const;
export type MaintenanceProgressPhase =
  typeof MAINTENANCE_PROGRESS_PHASES[number];
const progressPhases = new Set<string>(MAINTENANCE_PROGRESS_PHASES);

function progressNow(): number | null {
  try {
    const value = performance.now();
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** Payload-free observation only; never accepts work, state or authority. */
export function beginMaintenanceProgress(
  phase: MaintenanceProgressPhase,
): () => void {
  if (!progressPhases.has(phase)) return () => {};
  const started = progressNow();
  const emit = (event: "start" | "finish", elapsedMs: number | null) => {
    try {
      console.log(JSON.stringify({
        kind: "sentinel_maintenance_progress",
        version: 1,
        phase,
        event,
        elapsedMs,
      }));
    } catch {
      // A diagnostic sink cannot change maintenance behavior.
    }
  };
  emit("start", started === null ? null : 0);
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    const now = progressNow();
    const elapsed = started !== null && now !== null && now >= started
      ? Math.floor(now - started)
      : null;
    emit(
      "finish",
      elapsed !== null && Number.isSafeInteger(elapsed) ? elapsed : null,
    );
  };
}
/** Map any thrown maintenance error to one fixed, payload-free category. */
export function maintenanceFailureCategory(
  error: unknown,
): MaintenanceFailureCategoryV1 {
  if (error instanceof HistoricalQuarantineIncomplete) {
    return "historical_quarantine_incomplete";
  }
  if (error instanceof Error) {
    let message: unknown;
    try {
      message = error.message;
    } catch {
      return "unexpected_error";
    }
    if (typeof message !== "string") return "unexpected_error";
    if (message.startsWith("historical matrix")) {
      return "historical_matrix_recovery";
    }
    if (message.startsWith("current matrix")) {
      return "current_matrix_ingestion";
    }
    if (
      message.startsWith("C maintenance") || message.startsWith("C recovery") ||
      message.startsWith("closed-c matrix")
    ) {
      return "closed_c_maintenance";
    }
  }
  return "unexpected_error";
}

/**
 * The reasons that mean the helper itself could not run safely. The
 * historical quarantine reason is reported only for an integrity refusal;
 * an incomplete-but-intact pass reports `deferred_historical_quarantine`.
 */
export function isHardAutonomyFailure(reason: HostedAutonomyReasonV1): boolean {
  return reason === "identity_rejected" || reason === "unexpected_failure" ||
    reason === "historical_quarantine_incomplete";
}

/**
 * A view of `state` whose first `readRepair` result is reused by every later
 * call: the read-only passes after the chain (follow-ups, base repair) share
 * one state read, so the pass reads state once after its last write. Every
 * other member is the original, bound to it.
 */
export function shareRepairRead<T extends StateReadView>(state: T): T {
  let shared: ReturnType<StateReadView["readRepair"]> | null = null;
  return new Proxy(state, {
    get(target, property) {
      if (property === "readRepair") {
        return () => shared ??= target.readRepair();
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
