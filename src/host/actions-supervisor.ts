/** Public hosted entrypoint; implementation is split by responsibility. */
import {
  main,
  STATIC_JOB,
  STATIC_OUTPUT,
  STATIC_RESULT,
  STATIC_SOURCE_CHECKOUT,
} from "./actions-supervisor-host.ts";
import {
  STATIC_SEED,
  STATIC_STATE,
  STATIC_TOKEN,
} from "./actions-supervisor-bootstrap.ts";
export {
  ensureHostedReleaseState,
  ensureHostedReleaseStateSeed,
} from "./actions-supervisor-bootstrap.ts";
export type { HostedSupervisorBootstrapResultV1 } from "./actions-supervisor-bootstrap.ts";
export type {
  HostedSupervisorEvidencePortV1,
  HostedSupervisorInputV1,
  HostedSupervisorOutcomeV1,
  HostedSupervisorRunIdentityV1,
} from "./actions-supervisor-state.ts";
export {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "./actions-supervisor-controller.ts";
export { runHostedSupervisorHost } from "./actions-supervisor-host.ts";
export type {
  HostedSupervisorHostInputV1,
  HostedSupervisorHostResultV1,
} from "./actions-supervisor-host.ts";

const SAFE_STATIC_ERRORS = [
  STATIC_JOB,
  STATIC_SOURCE_CHECKOUT,
  STATIC_OUTPUT,
  STATIC_TOKEN,
  STATIC_STATE,
  STATIC_SEED,
] as const;

/** Keep bounded static diagnostics visible without exposing raw exceptions. */
export function supervisorErrorDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return message.length <= 240 &&
      SAFE_STATIC_ERRORS.some((known) => message.startsWith(known))
    ? message
    : STATIC_RESULT;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(supervisorErrorDiagnostic(error));
    Deno.exit(1);
  }
}
