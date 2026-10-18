/** Persistent source-owned custody floor, independent of new takeover admission. */
import type { GitSha } from "../contracts/brands.ts";
import { HOSTED_CUSTODY_CAPABILITY } from "./hosted-custody-capability.ts";
import type {
  QueueRuntimeCapability,
  QueueRuntimeMigration,
} from "./queue-runtime-capability.ts";

export interface ExistingPrRuntimeCapability {
  readonly custodyActivated: boolean;
  readonly revisions: readonly GitSha[];
  readonly ownerInstallMigrations?: readonly QueueRuntimeMigration[];
}

/** Only accepted frozen runtimes and exact owner migrations may populate this. */
export const EXISTING_PR_RUNTIME_CAPABILITY: ExistingPrRuntimeCapability =
  HOSTED_CUSTODY_CAPABILITY.existingPr;

export const EXISTING_PR_RUNTIME_CAPABILITY_REFUSED =
  "existing pull request custody requires an accepted exact runtime capability";

/** Reuse the existing exact-runtime algorithms; this never changes queue policy. */
export function existingPrRuntimePolicy(
  policy: ExistingPrRuntimeCapability = EXISTING_PR_RUNTIME_CAPABILITY,
): QueueRuntimeCapability {
  return {
    proofActivated: policy?.custodyActivated,
    revisions: policy?.revisions,
    ownerInstallMigrations: policy?.ownerInstallMigrations,
  };
}
