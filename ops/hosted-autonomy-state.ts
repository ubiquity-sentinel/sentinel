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

export class HistoricalQuarantineIncomplete extends Error {
  constructor() {
    super("historical matrix quarantine incomplete");
  }
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
      message.startsWith("C maintenance") ||
      message.startsWith("closed-c matrix")
    ) {
      return "closed_c_maintenance";
    }
  }
  return "unexpected_error";
}

/** The two reasons that mean the helper itself could not run safely. */
export function isHardAutonomyFailure(reason: HostedAutonomyReasonV1): boolean {
  return reason === "identity_rejected" || reason === "unexpected_failure" ||
    reason === "historical_quarantine_incomplete";
}
