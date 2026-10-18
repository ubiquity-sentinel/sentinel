/** Native queue observation with no repair-state or queue mutation authority. */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  type Clock,
  portError,
  portOk,
  type StateReadView,
} from "../src/contracts/ports.ts";
import { GitHubMergeQueueClient } from "../src/github/client-merge-queue.ts";
import {
  fetchHttpTransport,
  type HttpTransportV1,
} from "../src/github/http.ts";
import { DEFAULT_APP_INSTALLATION_ID } from "../src/host/actions-target-cycles.ts";
import { DurableGitHubCooldownGate } from "../src/repair/github-cooldown.ts";

export async function readHostedMaintenanceQueueObservation(input: {
  state: StateReadView;
  clock: Clock;
  token: string;
  deadline: number;
  http?: HttpTransportV1;
}): Promise<boolean> {
  const live = () =>
    Number.isSafeInteger(input.deadline) &&
    Number.isSafeInteger(input.clock.now()) &&
    input.clock.now() < input.deadline;
  if (!live()) return false;
  // Keep persisted cooldown enforcement; observing 429 may never write here.
  const readOnlyState = {
    readRepair: () => input.state.readRepair(),
    readRelease: () => input.state.readRelease(),
    writeRepair: () =>
      Promise.resolve(
        portError("unavailable", "maintenance compatibility is read only"),
      ),
  };
  const client = new GitHubMergeQueueClient({
    repository: {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: DEFAULT_APP_INSTALLATION_ID,
    },
    apiBaseUrl: "https://api.github.com",
    http: input.http ?? fetchHttpTransport(),
    clock: input.clock,
    requestDeadlineMs: Math.min(30_000, input.deadline - input.clock.now()),
    cooldownGate: new DurableGitHubCooldownGate({
      state: readOnlyState,
      clock: input.clock,
    }),
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
  });
  try {
    const rules = await client.readBranchRules("development");
    if (!rules.ok || !live()) return false;
    const queue = await client.readQueue("development");
    if (queue.status !== "complete" || !live()) return false;
    const freshRules = await client.readBranchRules("development");
    return freshRules.ok && live() &&
      canonicalStringify(freshRules.value) ===
        canonicalStringify(rules.value) &&
      rules.value.some((rule) => rule.type === "merge_queue") ===
        (queue.value.queueId !== null);
  } catch {
    return false;
  }
}
