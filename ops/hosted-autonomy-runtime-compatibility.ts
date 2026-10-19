/** Read-only maintenance routing; migration is never ordinary queue readiness. */
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { Clock, StateReadView } from "../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  type ExistingPrRuntimeCapability,
} from "../src/host/existing-pr-runtime-capability.ts";
import {
  allowsHostedExecution,
  allowsHostedRuntime,
} from "../src/host/hosted-runtime-compatibility.ts";
import { planOwnerDevelopmentInstall } from "../src/host/owner-install-plan.ts";
import { readOwnerLegacyFirstRecoveryTarget } from "../src/host/owner-install-future-recovery.ts";
import {
  readOwnerSupersededRecoveryTarget,
  readOwnerSupersessionTarget,
} from "../src/host/owner-install-supersession.ts";
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
    if (custody?.custodyActivated !== true || !await input.readQueueReady()) {
      return hold();
    }
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
    const compatible =
      allowsHostedRuntime(runtime.activeRevision, queue, custody) &&
      (runtime.execution === null ||
        allowsHostedExecution(
          runtime.execution,
          snapshot.hostedReleases,
          queue,
          custody,
        ));
    const plan = compatible ? null : planOwnerDevelopmentInstall(
      snapshot,
      input.clock.now(),
      undefined,
      undefined,
      queue,
      custody,
      input.rollout,
    );
    // The predecessor must finish its genuine normal finalize before migration.
    if (!compatible && runtime.execution !== null) return hold();
    const ownerTargetInput = {
      snapshot,
      repair: repair.value.snapshot,
      launcherSha: input.native.run.launcherSha,
      releaseHead: release.value.head,
      repairHead: repair.value.head,
      now: input.clock.now(),
      queue,
      custody,
      rollout: input.rollout,
    };
    const owner = runtime.execution === null
      ? await readOwnerSupersessionTarget(ownerTargetInput) ??
        await readOwnerSupersededRecoveryTarget(ownerTargetInput)
      : undefined;
    const legacy = !compatible && plan?.status !== "install"
      ? await readOwnerLegacyFirstRecoveryTarget({
        snapshot,
        repair: repair.value.snapshot,
        launcherSha: input.native.run.launcherSha,
        now: input.clock.now(),
        queue,
        custody,
        rollout: input.rollout,
      })
      : undefined;
    if (
      !compatible && plan?.status !== "install" && legacy === undefined &&
      owner === undefined
    ) {
      return hold();
    }
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
    if (owner !== undefined) {
      return {
        status: "migration_only",
        releaseHead: release.value.head,
        repairHead: repair.value.head,
        ...owner,
        move: null,
      };
    }
    if (compatible) {
      const bootstrap = hostedRuntimeBootstrapDisposition(
        runtime,
        queue,
        custody,
        input.rollout,
      );
      if (bootstrap === "hold") return hold();
      if (bootstrap === "bootstrap") {
        // An interrupted bootstrap must retain its model-disabled workflow route.
        if (
          runtime.execution !== null &&
          runtime.execution.purpose !== "bootstrap"
        ) return hold();
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
    }
    if (plan?.status !== "install") {
      return legacy === undefined ? hold() : {
        status: "migration_only",
        releaseHead: release.value.head,
        repairHead: repair.value.head,
        ...legacy,
        move: null,
      };
    }
    return {
      status: "migration_only",
      releaseHead: release.value.head,
      repairHead: repair.value.head,
      revision: plan.move.nextRevision,
      generation: plan.move.nextGeneration,
      move: plan.move,
    };
  } catch {
    return hold();
  }
}
