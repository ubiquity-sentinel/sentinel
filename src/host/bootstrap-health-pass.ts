/**
 * Model-disabled bootstrap as a health and compatibility pass (issue #336).
 *
 * A bootstrap after a controller install used to run the full target cycles
 * with model starts disabled: every target was prepared, sources were polled
 * and pre-ranking maintenance stepped work records across the whole state.
 * That walk is the ordinary bounded pass's job. Bootstrap now only re-reads
 * the release state (runtime pins and the saved execution), the repair state
 * and both contract versions, and verifies they are compatible with this
 * runtime. It never composes a target port, polls a source, steps or writes a
 * record, or starts a model. Its outcome feeds the unchanged child result, so
 * the trusted finalize still writes the same health/settled proof, and a failed
 * check is a `state_error` child failure that still fails bootstrap and
 * triggers the existing journaled restoration.
 */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { StateReadView } from "../contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";

export const BOOTSTRAP_HEALTH_DETAIL =
  "bootstrap pass: runtime pins, custody and contract versions verified; no record stepped";

const failed = (detail: string): RepairCycleOutcomeV1 => ({
  status: "state_error",
  detail: `bootstrap health: ${detail}`,
});

/** Read-only compatibility check of the installed runtime; never a state write. */
export async function runBootstrapHealthPass(input: {
  state: StateReadView;
  execution: HostedExecutionIntentV1;
}): Promise<RepairCycleOutcomeV1> {
  const { execution } = input;
  if (execution.purpose !== "bootstrap") {
    return failed("execution is not a bootstrap");
  }
  try {
    const release = await input.state.readRelease();
    if (!release.ok || release.value.status !== "found") {
      return failed("release state unavailable");
    }
    const snapshot = parseReleaseStateSnapshotV1(release.value.snapshot);
    const runtime = snapshot.hostedRuntimes.length === 1
      ? snapshot.hostedRuntimes[0]
      : undefined;
    if (
      runtime === undefined ||
      runtime.activeRevision !== execution.revision ||
      runtime.generation !== execution.generation ||
      runtime.execution === null ||
      canonicalStringify(runtime.execution) !== canonicalStringify(execution)
    ) return failed("runtime pins do not bind this execution");
  } catch {
    return failed("release state contract incompatible");
  }
  try {
    const repair = await input.state.readRepair();
    if (!repair.ok) return failed("repair state unavailable");
    // An absent repair state is seeded by the host before this pass; a
    // positively absent read here is still compatible (nothing to walk).
    if (repair.value.status === "found") {
      parseRepairStateSnapshotV1(repair.value.snapshot);
    }
  } catch {
    return failed("repair state contract incompatible");
  }
  return { status: "idle", detail: BOOTSTRAP_HEALTH_DETAIL };
}
