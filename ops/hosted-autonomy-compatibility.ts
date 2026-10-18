/** Protected maintenance preflight. Only ordinary custody may set queue ready. */
import type { GitSha } from "../src/contracts/brands.ts";
import type { Clock, StateReadView } from "../src/contracts/ports.ts";
import type { HttpTransportV1 } from "../src/github/http.ts";
import type { HostedSupervisorRunIdentityV1 } from "../src/host/actions-supervisor-types.ts";
import type { ExistingPrRuntimeCapability } from "../src/host/existing-pr-runtime-capability.ts";
import type { HostedRuntimeRollout } from "../src/host/hosted-runtime-rollout.ts";
import type { HostedWriterQuiescenceInput } from "../src/host/hosted-writer-quiescence.ts";
import type { QueueRuntimeCapability } from "../src/host/queue-runtime-capability.ts";
import { readHostedMaintenanceQueueObservation } from "./hosted-autonomy-compatibility-queue.ts";
import { readHostedMaintenanceCompatibility } from "./hosted-autonomy-runtime-compatibility.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";

/** In-process fixtures only. Production derives policies from its clean source. */
export interface HostedMaintenanceCompatibilityFixture {
  queue?: QueueRuntimeCapability;
  custody?: ExistingPrRuntimeCapability;
  rollout?: HostedRuntimeRollout;
  nativeRead?: HostedWriterQuiescenceInput["read"];
  http?: HttpTransportV1;
}

export async function writeHostedMigrationOutput(
  path: string | null,
  target: { revision: GitSha; generation: number } | null,
): Promise<void> {
  if (path === null || path.length === 0) return;
  await Deno.writeTextFile(
    path,
    `runtimeMigrationOnly=${target !== null}\nruntimeMigrationRevision=${
      target?.revision ?? ""
    }\nruntimeMigrationGeneration=${target?.generation ?? ""}\n`,
    { append: true },
  );
}

/** A non-null result returns before construction or invocation of maintenance writers. */
export async function preflightHostedMaintenance(input: {
  state: StateReadView;
  clock: Clock;
  run: HostedSupervisorRunIdentityV1;
  nativeToken: string;
  queueToken: string;
  output: string | null;
  fixture?: HostedMaintenanceCompatibilityFixture;
}): Promise<HostedAutonomyResultV1 | null> {
  const deadline = input.clock.now() + 120_000;
  const decision = await readHostedMaintenanceCompatibility(
    {
      state: input.state,
      clock: input.clock,
      native: {
        token: input.nativeToken,
        run: input.run,
        deadline,
        read: input.fixture?.nativeRead,
      },
      rollout: input.fixture?.rollout,
      readQueueReady: () =>
        readHostedMaintenanceQueueObservation({
          state: input.state,
          clock: input.clock,
          token: input.queueToken,
          deadline,
          http: input.fixture?.http,
        }),
    },
    input.fixture?.queue,
    input.fixture?.custody,
  );
  if (decision.status === "ordinary") return null;
  if (decision.status === "migration_only") {
    await writeHostedMigrationOutput(input.output, decision);
  }
  return {
    kind: "hosted_autonomy",
    status: "skipped",
    reason: "no_change",
    beforeHead: null,
    appliedHead: null,
    actions: [`runtime-compatibility:${decision.status}`],
    revisions: [],
  };
}
