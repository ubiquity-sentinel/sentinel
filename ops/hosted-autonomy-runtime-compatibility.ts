/** Read-only maintenance routing; migration is never ordinary queue readiness. */
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { Clock, StateReadView } from "../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  type ExistingPrRuntimeCapability,
} from "../src/host/existing-pr-runtime-capability.ts";
import { allowsHostedExecution } from "../src/host/hosted-runtime-compatibility.ts";
import type { OwnerDevelopmentInstallMoveV1 } from "../src/host/owner-install-types.ts";
import {
  QUEUE_RUNTIME_CAPABILITY,
  type QueueRuntimeCapability,
} from "../src/host/queue-runtime-capability.ts";
import { hostedRuntimeBootstrapDisposition } from "../src/host/hosted-runtime-bootstrap.ts";
import type { HostedRuntimeRollout } from "../src/host/hosted-runtime-rollout.ts";
import {
  type HostedWriterQuiescenceInput,
  readHostedWriterQuiescence,
} from "../src/host/hosted-writer-quiescence.ts";

export type HostedMaintenanceCompatibilityDecision =
  | { status: "ordinary" }
  | {
    status: "migration_only";
    releaseHead: GitSha;
    repairHead: GitSha;
    revision: GitSha;
    generation: number;
    move: OwnerDevelopmentInstallMoveV1 | null;
  }
  | { status: "hold"; reason: string };

/** Root composes this before constructing maintenance writers, after clean-source verification. */
export async function readHostedMaintenanceCompatibility(
  input: {
    state: Pick<StateReadView, "readRelease" | "readRepair">;
    clock: Clock;
    native: Omit<HostedWriterQuiescenceInput, "phase" | "clock">;
    /** Native read-only queue observation; never the mutating custody pass. */
    readQueueReady: () => Promise<boolean>;
    /** Trusted source-data fixture; production defaults to immutable source. */
    rollout?: HostedRuntimeRollout;
  },
  queue?: QueueRuntimeCapability,
  custody: ExistingPrRuntimeCapability = EXISTING_PR_RUNTIME_CAPABILITY,
): Promise<HostedMaintenanceCompatibilityDecision> {
  const hold = (): HostedMaintenanceCompatibilityDecision => ({
    status: "hold",
    reason: "hosted maintenance runtime compatibility unavailable",
  });
  if (
    custody?.custodyActivated === false &&
    (queue ?? QUEUE_RUNTIME_CAPABILITY).proofActivated === false
  ) return { status: "ordinary" };
  try {
    // Queue observation precedes every active maintenance compatibility path.
    // It holds only while queue proof is active. With queue proof off (owner
    // directive 2026-10-24, #180), an unprovable ai.ubq.fi observation no
    // longer stops every target's maintenance: the runner's queue custody
    // prelude protects the native-queue records instead (#188). Live, it held
    // every maintenance pass from 16:43 UTC on.
    if (custody?.custodyActivated !== true) return hold();
    const queueReady = await input.readQueueReady();
    if (
      !queueReady &&
      (queue ?? QUEUE_RUNTIME_CAPABILITY).proofActivated !== false
    ) return hold();
    const [release, repair] = await Promise.all([
      input.state.readRelease(),
      input.state.readRepair(),
    ]);
    if (
      !release.ok || release.value.status !== "found" || !repair.ok ||
      repair.value.status !== "found"
    ) return hold();
    const snapshot = parseReleaseStateSnapshotV1(release.value.snapshot);
    const runtime = snapshot.hostedRuntimes.length === 1
      ? snapshot.hostedRuntimes[0]
      : null;
    if (runtime === null) return hold();
    // Revision floors and owner-install planning are retired. A saved execution
    // still owns its work until genuine finalize; only bootstrap may resume here.
    if (
      runtime.execution !== null &&
      (runtime.execution.purpose !== "bootstrap" ||
        runtime.execution.revision !== runtime.activeRevision ||
        runtime.execution.generation !== runtime.generation ||
        !allowsHostedExecution(runtime.execution, snapshot.hostedReleases))
    ) return hold();
    const native = await readHostedWriterQuiescence({
      ...input.native,
      phase: "maintenance",
      clock: input.clock,
    }, custody);
    if (native.status !== "ready") return hold();
    const [freshRelease, freshRepair] = await Promise.all([
      input.state.readRelease(),
      input.state.readRepair(),
    ]);
    if (
      !freshRelease.ok || freshRelease.value.status !== "found" ||
      freshRelease.value.head !== release.value.head ||
      canonicalStringify(freshRelease.value.snapshot) !==
        canonicalStringify(snapshot) ||
      !freshRepair.ok || freshRepair.value.status !== "found" ||
      freshRepair.value.head !== repair.value.head ||
      canonicalStringify(freshRepair.value.snapshot) !==
        canonicalStringify(repair.value.snapshot)
    ) return hold();
    const bootstrap = hostedRuntimeBootstrapDisposition(runtime);
    if (bootstrap === "hold") return hold();
    if (bootstrap === "bootstrap" || runtime.execution !== null) {
      return {
        status: "migration_only",
        releaseHead: release.value.head,
        repairHead: repair.value.head,
        revision: runtime.activeRevision,
        generation: runtime.generation,
        move: null,
      };
    }
    return { status: "ordinary" };
  } catch {
    return hold();
  }
}
