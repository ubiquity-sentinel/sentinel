/** Trusted read-only queue custody for maintenance ports with no ordinary effects. */
import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { GitHubQueueDeliveryClient } from "../github/client-queue-delivery.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import {
  createNativeQueueGuard,
  type NativeQueueGuardV1,
} from "../github/native-queue-guard.ts";
import { createQueueProvenanceReader } from "../github/queue-delivery-provenance.ts";
import { createQueueDeliveryReader } from "../github/queue-delivery-reader.ts";
import { resolveQueueRuntimeConfiguration } from "../github/queue-runtime-policy.ts";

export type MaintenanceNativeQueueFactory = (
  repository: RepositoryIdentityV1,
  state: StateReadView & RepairStateWriter,
) => NativeQueueGuardV1;

export class MaintenanceQueueCustodyUnavailable extends Error {
  constructor() {
    super("maintenance native queue custody unavailable");
  }
}

/** Maintenance may settle an observed absence; it cannot acquire queue custody. */
export function maintenanceQueueOnlyPort(
  nativeQueue: NativeQueueGuardV1,
): GitHubPort {
  const guard: NativeQueueGuardV1 = {
    ...nativeQueue,
    inspect: async (input) => {
      const observed = await nativeQueue.inspect(input);
      if (observed.status !== "allow") {
        throw new MaintenanceQueueCustodyUnavailable();
      }
      return observed;
    },
  };
  return new Proxy({ nativeQueue: guard } as GitHubPort, {
    get: (target, key) => {
      if (key === "nativeQueue") return target.nativeQueue;
      return () => Promise.reject(new Error("maintenance capability refused"));
    },
  });
}

export function createMaintenanceNativeQueue(input: {
  repository: RepositoryIdentityV1;
  state: StateReadView;
  clock: Clock;
  gate: GitHubCooldownGateV1;
  token: string;
  http: HttpTransportV1;
}) {
  const queue = resolveQueueRuntimeConfiguration(undefined);
  const client = new GitHubQueueDeliveryClient({
    repository: input.repository,
    apiBaseUrl: "https://api.github.com",
    clock: input.clock,
    http: input.http,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
    cooldownGate: input.gate,
  }, queue.policy.workflowId);
  const reader = createQueueDeliveryReader({
    repository: input.repository,
    clock: input.clock,
    client,
    policy: queue.policy,
    provenance: createQueueProvenanceReader({
      state: input.state,
      clock: input.clock,
      policy: queue.policy,
    }),
  });
  return createNativeQueueGuard({
    repository: input.repository,
    state: input.state,
    clock: input.clock,
    client,
    reader,
    mode: queue.mode,
    proofActivated: queue.proofActivated,
    policy: queue.policy,
  });
}
