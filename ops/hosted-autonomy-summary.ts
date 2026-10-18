import type { StateReadView } from "../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";

/** Closed labels only: raw blocker text can contain restricted diagnostics. */
function reason(record: WorkRecordV1): string {
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
): string {
  const blocked = snapshot.work.filter((record) =>
    record.nextStep === "blocked"
  );
  const lines = [
    "## Sentinel parked work",
    "",
    `Blocked tasks: ${blocked.length}. All owner parks and recoverable blockers are listed.`,
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
      `| ${task} | ${record.target.pr ?? "unbound"} | ${reason(record)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** A summary read/write failure cannot affect repair admission or custody. */
export async function emitHostedParkSummary(
  state: Pick<StateReadView, "readRepair">,
  path: string | null,
): Promise<void> {
  if (path === null || path.length === 0) return;
  let summary =
    "## Sentinel parked work\n\nState unavailable; parked tasks could not be listed.\n";
  try {
    const read = await state.readRepair();
    if (read.ok && read.value.status === "found") {
      summary = renderHostedParkSummary(
        parseRepairStateSnapshotV1(read.value.snapshot),
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
