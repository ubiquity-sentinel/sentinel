/** Trusted host queue prelude; no implementation, review, or maintenance phases. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitHubPort } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import type { BackupCiConsumerV1 } from "../github/backup-ci-observations.ts";
import { readHostedMaintenanceQueueObservation } from "../../ops/hosted-autonomy-compatibility-queue.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import {
  type RepairQueueCustodyInput,
  runRepairQueueCustody,
} from "./repair-queue-custody.ts";

export const QUEUE_CUSTODY_IDLE_DETAIL = "queue custody unavailable";

export async function prepareActionsQueueCustody(
  input:
    & Pick<
      RepairQueueCustodyInput,
      "state" | "clock" | "token" | "http" | "queueMode" | "deadline"
    >
    & {
      /** The already verified saved execution purpose. */
      purpose: HostedExecutionIntentV1["purpose"];
      configs: readonly RepositoryConfigV1[];
      prepareTarget(config: RepositoryConfigV1): Promise<void>;
      /** The runtime's cached port with its actual same-token private principal. */
      composeGithub(config: RepositoryConfigV1): GitHubPort;
      /** The runtime's backup CI consumer, for the native fact reads (§11.4). */
      backupCi?: BackupCiConsumerV1;
    },
): Promise<boolean> {
  const report = (actions: readonly string[]) => {
    // Advisory only, with existing static queue action codes. Never a child V1 record.
    console.log(JSON.stringify({ kind: "sentinel_queue_custody", actions }));
  };
  try {
    if (input.clock.now() >= input.deadline) {
      report(["queue:deadline"]);
      return false;
    }
    if (input.purpose !== "ordinary") {
      const ready = await readHostedMaintenanceQueueObservation({
        ...input,
        requireNoCustody: true,
      });
      report([
        ready
          ? "queue:nonordinary_no_custody"
          : "queue:nonordinary_custody_hold",
      ]);
      return ready;
    }
    // Only queue-target mirrors can be read by native/produced publication proof.
    // Preparation neither discovers tasks nor creates mutation authority.
    for (const config of input.configs) {
      if (
        config.repository.owner === "ubiquity" &&
        config.repository.name === "ai.ubq.fi"
      ) {
        await input.prepareTarget(config);
      }
    }
    const configFor = (repository: RepositoryIdentityV1) =>
      input.configs.find((candidate) =>
        canonicalStringify(candidate.repository) ===
          canonicalStringify(repository)
      );
    const existingPrFor = (repository: RepositoryIdentityV1) => {
      const config = configFor(repository);
      return config === undefined
        ? undefined
        : input.composeGithub(config).existingPrTakeover;
    };
    const nativeReads = new Map<
      string,
      ReturnType<typeof createHostedAutonomyGitHub>
    >();
    const result = await runRepairQueueCustody({
      ...input,
      existingPrFor,
      publicationFor: (repository) => {
        const port = existingPrFor(repository);
        return port === undefined ? undefined : Object.freeze({
          resolvePublication: port.resolvePublication.bind(port),
        });
      },
      githubFor: (repository) => {
        // Retained custody is still observed for removed targets; new admission
        // cannot borrow a native fact surface outside the committed target list.
        if (configFor(repository) === undefined) return null;
        const key = canonicalStringify(repository);
        let native = nativeReads.get(key);
        if (native === undefined) {
          // Native fact reads use the same App token; this is not a principal issuer.
          native = createHostedAutonomyGitHub(
            input.token,
            repository,
            input.backupCi,
          );
          nativeReads.set(key, native);
        }
        return native;
      },
    });
    report(result.actions);
    if (!result.ready) return false;
    // Custody can CAS a hold or enqueue intent. No caller may reuse its earlier
    // snapshot, and a failed read after a successful custody pass still refuses.
    const fresh = await input.state.readRepair();
    if (!fresh.ok || fresh.value.status !== "found") {
      report(["queue:post_custody_state_unavailable"]);
      return false;
    }
    parseRepairStateSnapshotV1(fresh.value.snapshot);
    return true;
  } catch {
    report(["queue:host_preparation_unavailable"]);
    return false;
  }
}
