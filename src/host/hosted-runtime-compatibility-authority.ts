/** Fresh read-only execution binding; no principal or mutation authority is minted. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { GitSha } from "../contracts/brands.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { Clock, PortResultV1, StateReadView } from "../contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { HostedRuntimeIdentityV1 } from "./hosted-runtime-identity.ts";
import type { QueueRuntimeCapability } from "./queue-runtime-capability.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  EXISTING_PR_RUNTIME_CAPABILITY_REFUSED,
  type ExistingPrRuntimeCapability,
} from "./existing-pr-runtime-capability.ts";
import { hostedOrdinaryAdmitted } from "../contracts/hosted-supervisor-verification.ts";

export interface HostedRuntimeCompatibilityBinding {
  state: Pick<StateReadView, "readRelease">;
  identity: HostedRuntimeIdentityV1;
  execution: HostedExecutionIntentV1;
  controllerSha: GitSha;
  clock: Clock;
  deadline: number;
}

/**
 * Production defaults are immutable source. Fixture policies do not create
 * production authority: the trusted principal host must authenticate the actual
 * launcher policy/source and its existing child handoff before composition.
 */
export async function revalidateHostedRuntimeCompatibility(
  input: HostedRuntimeCompatibilityBinding,
  _queue?: QueueRuntimeCapability,
  _custody: ExistingPrRuntimeCapability = EXISTING_PR_RUNTIME_CAPABILITY,
): Promise<PortResultV1<void>> {
  const refused = () =>
    portError("unavailable", EXISTING_PR_RUNTIME_CAPABILITY_REFUSED);
  const live = () =>
    Number.isSafeInteger(input.deadline) &&
    Number.isSafeInteger(input.clock.now()) &&
    input.clock.now() < input.deadline;
  try {
    if (!live()) return refused();
    const { execution, identity } = input;
    if (
      execution.runId !== identity.runId ||
      execution.runAttempt !== identity.runAttempt ||
      execution.launcherSha !== identity.launcherSha ||
      execution.revision !== input.controllerSha ||
      execution.id !== `${identity.runId}:${identity.runAttempt}:repair` ||
      execution.purpose !== "ordinary" ||
      (identity.job !== "repair" && identity.job !== "matrix_plan")
    ) return refused();
    const before = await input.state.readRelease();
    if (!before.ok || before.value.status !== "found") return refused();
    const snapshot = parseReleaseStateSnapshotV1(before.value.snapshot);
    const runtime = snapshot.hostedRuntimes.length === 1
      ? snapshot.hostedRuntimes[0]
      : null;
    if (
      runtime === null || runtime.generation !== execution.generation ||
      canonicalStringify(runtime.execution) !== canonicalStringify(execution) ||
      runtime.activeRevision !== input.controllerSha ||
      !hostedOrdinaryAdmitted(runtime)
    ) return refused();
    const after = await input.state.readRelease();
    return live() && after.ok && after.value.status === "found" &&
        after.value.head === before.value.head &&
        canonicalStringify(after.value.snapshot) ===
          canonicalStringify(snapshot)
      ? portOk(undefined)
      : refused();
  } catch {
    return refused();
  }
}
