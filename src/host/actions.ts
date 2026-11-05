/** Public hosted entrypoint; implementation is split by responsibility. */
import { runActionsMatrixAggregateCycles } from "./matrix-actions.ts";
import { runActionsRepairHost } from "./actions-repair-host.ts";
import type { ActionsTargetCyclesInputV1 } from "./actions-target-cycles.ts";
export {
  ACTIONS_UOS_BASE_URL,
  childRunDeadlineV1,
  parseAppInstallationId,
  runActionsTargetCycles,
  scopeTargetConfigV1,
  targetsDiagnosticV1,
} from "./actions-target-cycles.ts";
export type {
  ActionsRepairHostDepsV1,
  ActionsRepairHostResultV1,
  ActionsTargetCyclesInputV1,
  ActionsTargetCyclesResultV1,
} from "./actions-target-cycles.ts";
export { runActionsRepairHost } from "./actions-repair-host.ts";

/** The installed child opts into health-only bootstrap, not legacy recovery. */
export function runActionsHostedCycles(input: ActionsTargetCyclesInputV1) {
  return runActionsMatrixAggregateCycles(
    {
      ...input,
      bootstrap: input.bootstrap === true ||
        input.host?.execution.purpose === "bootstrap",
    },
    undefined,
    input.host?.matrixCarrier,
  );
}

if (import.meta.main) {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of Deno.stdin.readable) {
    size += part.byteLength;
    if (size > 4096) throw new Error("trusted publisher input exceeds bound");
    parts.push(part);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const trustedStdin = size === 0
    ? undefined
    : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  await runActionsRepairHost({
    trustedStdin,
    issueOnly: true,
    runTargetCycles: runActionsHostedCycles,
  });
}
