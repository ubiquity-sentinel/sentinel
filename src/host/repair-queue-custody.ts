/** Trusted repair/planner queue prelude. This never invokes maintenance phases. */
import { runHostedQueueCustody } from "../../ops/hosted-autonomy-queue-pass.ts";
import { createHostedQueueCoordinator } from "../../ops/hosted-autonomy-queue-host.ts";
import type { QueueCustodyResult } from "../../ops/hosted-autonomy-queue-context.ts";
import type { QueueRuntimeConfiguration } from "../github/queue-runtime-policy.ts";

type CoordinatorInput = Parameters<typeof createHostedQueueCoordinator>[0];
export type RepairQueueCustodyInput = CoordinatorInput & {
  /** Exact cached runtime port, with its private same-App principal; no replacement composition. */
  existingPrFor: NonNullable<CoordinatorInput["existingPrFor"]>;
  deadline: number;
};
export async function runRepairQueueCustody(
  input: RepairQueueCustodyInput,
  source?: QueueRuntimeConfiguration,
): Promise<QueueCustodyResult> {
  if (
    !Number.isSafeInteger(input.deadline) || input.clock.now() >= input.deadline
  ) {
    return {
      ready: false,
      observed: null,
      protectedRecordIds: new Set(),
      actions: ["queue:deadline"],
      write: null,
    };
  }
  return await runHostedQueueCustody({
    state: input.state,
    clock: input.clock,
    githubFor: input.githubFor,
    queue: createHostedQueueCoordinator(input, source),
  }, input.deadline);
}
