/** Install verification reads metadata only; ordinary passes own all work. */
import { canonicalStringify } from "../contracts/canonical.ts";
import { parseRepositoryConfigV1 } from "../contracts/repository-config.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { RepairCycleOutcomeV1 } from "../repair/loop.ts";
import type {
  ActionsTargetCyclesInputV1,
  ActionsTargetCyclesResultV1,
} from "./actions-target-cycles.ts";
import {
  HOSTED_CUSTODY_CAPABILITY,
  parseHostedCustodyCapability,
} from "./hosted-custody-capability.ts";

export function isActionsBootstrap(input: ActionsTargetCyclesInputV1): boolean {
  return input.bootstrap === true ||
    input.host?.execution.purpose === "bootstrap";
}

/** The trusted host has already checked source identity and live custody. */
export async function runActionsBootstrapHealth(
  input: ActionsTargetCyclesInputV1,
): Promise<ActionsTargetCyclesResultV1> {
  let outcome: RepairCycleOutcomeV1;
  try {
    for (const config of input.configs) parseRepositoryConfigV1(config);
    parseHostedCustodyCapability(HOSTED_CUSTODY_CAPABILITY);
    if (input.clock.now() >= input.deadline) {
      outcome = {
        status: "margin",
        detail: "bootstrap health deadline reached",
      };
    } else {
      const read = await input.state.readRelease();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("bootstrap metadata unavailable");
      }
      const snapshot = parseReleaseStateSnapshotV1(read.value.snapshot);
      const runtime = snapshot.hostedRuntimes.length === 1
        ? snapshot.hostedRuntimes[0]
        : null;
      const execution = runtime?.execution;
      if (
        runtime === null || execution == null ||
        execution.purpose !== "bootstrap" ||
        runtime.activeRevision !== input.controllerSha ||
        execution.revision !== runtime.activeRevision ||
        execution.generation !== runtime.generation ||
        (input.host !== undefined &&
          canonicalStringify(execution) !==
            canonicalStringify(input.host.execution))
      ) throw new Error("bootstrap runtime pins disagree");
      outcome = input.clock.now() >= input.deadline
        ? { status: "margin", detail: "bootstrap health deadline reached" }
        : {
          status: "idle",
          detail: "bootstrap pass: metadata health verified",
        };
    }
  } catch {
    outcome = {
      status: "state_error",
      detail:
        "bootstrap manifest, runtime pins or contract metadata unavailable",
    };
  }
  const result = { outcome, addressed: [], skipped: [], failed: [] };
  input.report?.(result);
  return result;
}
