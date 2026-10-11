/** Public hosted entrypoint; implementation is split by responsibility. */
import {
  emitHostedRuntimeCliResult,
  runHostedRuntimeMain,
} from "./hosted-runtime-main.ts";
export {
  HOSTED_RUNTIME_CHILD_ENTRYPOINT,
  HOSTED_RUNTIME_CHILD_ENV_KEYS,
  HOSTED_RUNTIME_DEADLINE_MS,
  HOSTED_RUNTIME_FAILED_DETAIL,
  HOSTED_RUNTIME_HEALTHY_DETAIL,
  HOSTED_RUNTIME_MAX_OUTPUT_BYTES,
  HOSTED_RUNTIME_STATIC_ENV,
  HOSTED_RUNTIME_STATIC_EXECUTION,
  HOSTED_RUNTIME_STATIC_IDENTITY,
  HOSTED_RUNTIME_STATIC_SOURCE,
  HOSTED_RUNTIME_UNAVAILABLE_DETAIL,
  HOSTED_RUNTIME_WORKFLOW_REF,
  hostedRuntimeSentinelDir,
  parseHostedEnvironment,
  readHostedIdentityEnv,
  readHostedRuntimeExecution,
} from "./hosted-runtime-identity.ts";
export type {
  HostedModelDiagnosticV1,
  HostedRuntimeEarlyFailureCategoryV1,
  HostedRuntimeEarlyFailureReasonV1,
  HostedRuntimeEarlyFailureV1,
  HostedRuntimeIdentityV1,
  HostedRuntimeJobV1,
  HostedRuntimeLauncherInputV1,
  HostedRuntimeLauncherResultV1,
  HostedRuntimeLauncherStatusV1,
  HostedRuntimeMatrixLauncherRejectionV1,
} from "./hosted-runtime-identity.ts";
export { runHostedRuntimeLauncher } from "./hosted-runtime-launcher.ts";
export { readCleanGitHead } from "./hosted-runtime-child.ts";
export {
  emitHostedRuntimeCliResult,
  runHostedRuntimeMain,
} from "./hosted-runtime-main.ts";

if (import.meta.main) {
  const result = await runHostedRuntimeMain();
  Deno.exit(emitHostedRuntimeCliResult(result));
}
