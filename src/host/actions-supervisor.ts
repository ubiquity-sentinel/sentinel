/** Public hosted entrypoint; implementation is split by responsibility. */
import {
  main,
  STATIC_JOB,
  STATIC_OUTPUT,
  STATIC_RESULT,
  STATIC_SOURCE_CHECKOUT,
} from "./actions-supervisor-host.ts";
import { STATIC_TOKEN } from "./actions-supervisor-bootstrap.ts";
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

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    console.error(
      message === STATIC_JOB || message === STATIC_SOURCE_CHECKOUT ||
        message === STATIC_OUTPUT || message === STATIC_TOKEN
        ? message
        : STATIC_RESULT,
    );
    Deno.exit(1);
  }
}
