// client hosted log wire.

import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import type { HostedRuntimeTerminalV1 } from "../contracts/hosted-execution.ts";
import { HOSTED_ACTIONS_CLOCK_TOLERANCE_MS } from "../contracts/hosted-supervisor.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { tryParse } from "../contracts/validation.ts";
import { parseHostedRuntimeTerminalV1 } from "../contracts/hosted-execution.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  HostedRepairJobV1,
  HostedRuntimeStepV1,
} from "./client-hosted-revision-wire.ts";

export const ACTIONS_RELEASE_LOG_HOST =
  /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/;

export const HOSTED_EXECUTION_TERMINAL =
  "hosted runtime terminal evidence is invalid";

/** Full timestamp-prefixed line; the whole remainder is captured. */
export const HOSTED_EXECUTION_TERMINAL_LINE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (.*)$/;

/** Truncated terminal text still names the trusted record kind anywhere. */
export const HOSTED_EXECUTION_TERMINAL_LOOKING =
  /"kind"\s*:\s*"hosted_runtime_terminal"/;

/**
 * Exactly one outer runtime terminal in the bounded raw log. Full
 * timestamp-prefixed lines only; a malformed terminal-looking line is
 * ambiguous evidence even beside a valid one. The terminal must bind the full
 * saved intent and the exact controller, and its window must fit the runtime
 * step and job boundaries.
 */
export function parseHostedRuntimeTerminalLog(
  text: string,
  intent: HostedExecutionIntentV1,
  job: HostedRepairJobV1,
  step: HostedRuntimeStepV1,
  observedAt: number,
): PortResultV1<{ terminal: HostedRuntimeTerminalV1; terminalAt: number }> {
  const tolerance = HOSTED_ACTIONS_CLOCK_TOLERANCE_MS;
  let found: { terminal: HostedRuntimeTerminalV1; terminalAt: number } | null =
    null;
  for (const line of text.split(/\r?\n/)) {
    const match = HOSTED_EXECUTION_TERMINAL_LINE.exec(line);
    if (match === null) continue;
    let value: unknown;
    try {
      value = JSON.parse(match[2]);
    } catch {
      if (HOSTED_EXECUTION_TERMINAL_LOOKING.test(match[2])) {
        return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
      }
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      continue;
    }
    if ((value as Record<string, unknown>).kind !== "hosted_runtime_terminal") {
      continue;
    }
    if (found !== null) {
      return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
    }
    const parsed = tryParse(parseHostedRuntimeTerminalV1, value);
    if (!parsed.ok) {
      return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
    }
    if (
      canonicalStringify(parsed.value.execution) !== canonicalStringify(intent)
    ) {
      return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
    }
    if (parsed.value.controllerSha !== intent.revision) {
      return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
    }
    const terminalAt = Date.parse(match[1]);
    if (!Number.isSafeInteger(terminalAt) || terminalAt < 0) {
      return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
    }
    found = { terminal: parsed.value, terminalAt };
  }
  if (found === null) {
    return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
  }
  if (
    job.startedAt === null || job.completedAt === null ||
    step.startedAt === null || step.completedAt === null
  ) {
    return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
  }
  const terminal = found.terminal;
  if (
    terminal.startedAt + tolerance < step.startedAt ||
    terminal.finishedAt > step.completedAt + tolerance ||
    terminal.startedAt + tolerance < job.startedAt ||
    terminal.finishedAt > job.completedAt + tolerance ||
    // The authenticated log instant must follow the terminal's own finish.
    found.terminalAt + tolerance < terminal.finishedAt ||
    // Emission can lag runtime settlement; it must still belong to this
    // authenticated step/job and cannot be after the observation instant.
    found.terminalAt > step.completedAt + tolerance ||
    found.terminalAt > job.completedAt + tolerance ||
    found.terminalAt > observedAt + tolerance ||
    observedAt + tolerance < terminal.finishedAt
  ) {
    return portError("unavailable", HOSTED_EXECUTION_TERMINAL);
  }
  return portOk(found);
}

/** Only the fixed HTTPS results host, no userinfo, no fragment, port 443. */
export function trustedActionsLogUrl(location: string): string | null {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "") return null;
  if (url.port !== "") return null;
  if (!ACTIONS_RELEASE_LOG_HOST.test(url.hostname)) return null;
  return url.toString();
}
