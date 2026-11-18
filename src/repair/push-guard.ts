/**
 * The push guard every runtime push of model-written content carries
 * (2026-11-17, `src/github/push-content-guard.ts`): measured from the
 * record's base, refused outright on Sentinel's own repository, and
 * otherwise decided by the record's source (`recordCiTrust`), read only when
 * a CI-executable path is pushed.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { PushContentGuardV1 } from "../contracts/ports-github.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";
import { ownerMergesProtectedChanges } from "./owner-landing.ts";
import { recordCiTrust } from "./workflow-trust.ts";

export function recordPushGuard(
  deps: Pick<RepairCycleDepsV1, "github">,
  record: Pick<WorkRecordV1, "related" | "repository">,
  base: GitSha,
): PushContentGuardV1 {
  return {
    base,
    ownRepository: ownerMergesProtectedChanges(record.repository),
    trust: () => recordCiTrust(deps, record),
  };
}
