import type { StateReadView } from "../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import { parseQueueIntent } from "./hosted-autonomy-queue-intent.ts";

/** Closed labels only: raw blocker text can contain restricted diagnostics. */
const QUEUE_OWNER_LABELS: Readonly<Record<string, string>> = {
  "owner_park:admission_unresolved":
    "Owner: queue admission remained unresolved for six hours",
  "owner_park:foreign_entry_drift":
    "Owner: foreign queue entry authorization changed",
  "owner_park:refusals_exhausted": "Owner: queue admission refusals spent",
  "owner_park:repeated_queue_failure": "Owner: repeated queue CI failure",
  "invalid_intent_owner_action": "Owner: queue intent binding is invalid",
  "binding_changed_owner_action": "Owner: queue authorization binding changed",
  "foreign_hold_absent_owner_action":
    "Owner: foreign queue custody needs reconciliation",
  "removal_unproven_owner_action":
    "Owner: queue removal lacks accepted native proof",
  "dequeue_pending_owner_action": "Owner: queue dequeue remains uncertain",
  "dequeue_complete_entry_owner_action":
    "Owner: queue entry changed after dequeue proof",
};
function reason(record: WorkRecordV1, actions: readonly string[]): string {
  if (queueRecordProtected(record)) {
    const prefix = `queue:${record.id}:`;
    for (const action of actions) {
      if (!action.startsWith(prefix)) continue;
      const label = QUEUE_OWNER_LABELS[action.slice(prefix.length)];
      if (label !== undefined) return label;
    }
    const queue = parseQueueIntent(record);
    if (queue === null) {
      return "Queue custody retained; owner reconciliation may be required";
    }
    if (queue.refusals >= 3) return "Owner: queue admission refusals spent";
    if (queue.queueFailures >= 2) return "Owner: repeated queue CI failure";
    if (queue.stage === "dequeue_pending") {
      return "Owner: queue dequeue remains uncertain";
    }
    if (queue.stage === "dequeue_complete") {
      return "Queue dequeue completion proven; awaiting re-entry";
    }
    if (queue.stage === "owner_park") {
      return "Owner: queue operation needs a decision";
    }
    return "Queue custody retained; exact native reconciliation required";
  }
  const message = record.blocker?.message ?? "";
  if (message.startsWith("task acceptance not fulfilled")) {
    return "Owner: task acceptance needs a decision";
  }
  if (message.startsWith("repeated identical failure; owner action required")) {
    return "Owner: repeated identical implementation failures";
  }
  if (message.startsWith("base refresh refused by trusted validation")) {
    return "Owner: trusted validation refused the base refresh";
  }
  if (message.includes("candidate touches a protected path")) {
    return "Owner: candidate touches a protected path";
  }
  if (message.startsWith("review round ceiling reached:")) {
    return "Review rounds spent; delivery or owner decision required";
  }
  if (message.startsWith("CI fix attempts exhausted")) {
    return "Owner: CI fix attempts spent";
  }
  if (message.startsWith("candidate preservation unrecoverable")) {
    return "Owner: candidate preservation is unrecoverable";
  }
  if (
    message.includes("owner action required") ||
    message.includes("owner decision required")
  ) {
    return "Owner action required";
  }
  if (message.startsWith("source issue is closed")) {
    return "Source issue closed";
  }
  if (message.startsWith("CI ")) return "CI blocked; awaiting recovery";
  return "Blocked; inspect the task's recorded reason";
}

function cell(value: string, limit: number): string {
  return value.slice(0, limit).replace(/[^A-Za-z0-9_.:/#-]/g, "_");
}

/**
 * List ALL blocked tasks, so newly introduced owner parks cannot disappear
 * behind a classifier or a detail-count limit. The snapshot contract permits
 * at most 2,048 rows; bounded identity cells keep this below GitHub's 1 MiB
 * summary limit. This is advisory output only, never state or stdout wire data.
 */
export function renderHostedParkSummary(
  snapshot: RepairStateSnapshotV1,
  actions: readonly string[] = [],
): string {
  const blocked = snapshot.work.filter((record) =>
    record.nextStep === "blocked" ||
    (record.nextStep !== "done" && queueRecordProtected(record))
  );
  const lines = [
    "## Sentinel parked work",
    "",
    `Blocked tasks: ${
      snapshot.work.filter((record) => record.nextStep === "blocked").length
    }. All owner parks and recoverable blockers are listed.`,
    `Queue custody tasks: ${
      snapshot.work.filter((record) =>
        record.nextStep !== "done" && queueRecordProtected(record)
      ).length
    }. Holds remain until verified reconciliation.`,
    "",
    "| Task | Pull request | Reason |",
    "| --- | --- | --- |",
  ];
  for (const record of blocked) {
    const repository = `${cell(record.repository.owner, 100)}/${
      cell(record.repository.name, 100)
    }`;
    const task = record.related.issueNumber === null
      ? cell(String(record.id), 256)
      : `${repository}#${record.related.issueNumber}`;
    lines.push(
      `| ${task} | ${record.target.pr ?? "unbound"} | ${
        reason(record, actions)
      } |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** A summary read/write failure cannot affect repair admission or custody. */
export async function emitHostedParkSummary(
  state: Pick<StateReadView, "readRepair">,
  path: string | null,
  actions: readonly string[] = [],
): Promise<void> {
  if (path === null || path.length === 0) return;
  let summary =
    "## Sentinel parked work\n\nState unavailable; parked tasks could not be listed.\n";
  try {
    const read = await state.readRepair();
    if (read.ok && read.value.status === "found") {
      summary = renderHostedParkSummary(
        parseRepairStateSnapshotV1(read.value.snapshot),
        actions,
      );
    }
  } catch {
    // Do not copy raw diagnostics to the summary.
  }
  try {
    await Deno.writeTextFile(path, summary, { append: true });
  } catch {
    // Summary availability is not an admission or state-write gate.
  }
}
