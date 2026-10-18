/** Protected host composition reuses its token, exact repository and durable cooldown. */
import {
  type Clock,
  portOk,
  type RepairStateWriter,
  type StateReadView,
} from "../src/contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { GitHubQueueDeliveryClient } from "../src/github/client-queue-delivery.ts";
import { fetchHttpTransport } from "../src/github/http.ts";
import { DurableGitHubCooldownGate } from "../src/repair/github-cooldown.ts";
import { DEFAULT_APP_INSTALLATION_ID } from "../src/host/actions-target-cycles.ts";
import {
  QUEUE_MODE_CEILING,
  QUEUE_PROOF_ACTIVATED,
  QUEUE_PROOF_POLICY,
} from "../src/github/queue-runtime-policy.ts";
import { createHostedQueueAuthority } from "./hosted-autonomy-queue-authority.ts";
import type { HostedAutonomyDepsV1 } from "./hosted-autonomy-types.ts";
import type { HostedQueueCoordinatorDeps } from "./hosted-autonomy-queue-contracts.ts";

export function createHostedQueueCoordinator(input: {
  state: StateReadView & RepairStateWriter;
  clock: Clock;
  token: string;
  githubFor: HostedAutonomyDepsV1["githubFor"];
}): HostedQueueCoordinatorDeps {
  const repository: RepositoryIdentityV1 = {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    installationId: DEFAULT_APP_INSTALLATION_ID,
  };
  const gate = new DurableGitHubCooldownGate({
    state: input.state,
    clock: input.clock,
  });
  const client = new GitHubQueueDeliveryClient({
    repository,
    apiBaseUrl: "https://api.github.com",
    http: fetchHttpTransport(),
    clock: input.clock,
    cooldownGate: gate,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
  }, QUEUE_PROOF_POLICY.workflowId);
  const clientFor = (scope: RepositoryIdentityV1) =>
    scope.owner === repository.owner &&
      scope.name === repository.name &&
      scope.installationId === repository.installationId
      ? client
      : null;
  const authority = createHostedQueueAuthority({ ...input, clientFor });
  return {
    repository,
    config: {
      mode: QUEUE_MODE_CEILING,
      proofActivated: QUEUE_PROOF_ACTIVATED,
      appActor: QUEUE_PROOF_POLICY.appActor,
      probation: true,
    },
    surface: client,
    authorization: authority.authorization,
    resolveDelivery: authority.resolveDelivery,
    verifyProtectedWrite: authority.verifyProtectedWrite,
    readEffectiveQueueRule: async () => {
      const rules = await client.readBranchRules("development");
      return rules.ok
        ? {
          status: "complete",
          value: rules.value.some((rule) => rule.type === "merge_queue"),
        }
        : { status: "unavailable", reason: "http" };
    },
  };
}
