/** Native supervisor identity, bounded evidence and controller input contracts. */
import type { GitSha } from "../contracts/brands.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  Clock,
  PortResultV1,
  ReleaseStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { ReviewTaskStatementV1 } from "../contracts/review-receipt.ts";
import type { ExistingPrRuntimeCapability } from "./existing-pr-runtime-capability.ts";
import type { QueueRuntimeCapability } from "./queue-runtime-capability.ts";

import type { HostedRuntimeRollout } from "./hosted-runtime-rollout.ts";

export interface HostedSupervisorRunIdentityV1 {
  runId: number;
  runAttempt: number;
  launcherSha: GitSha;
}

/** Bounded external evidence; production adapters follow in a later change. */
export interface HostedSupervisorEvidencePortV1 {
  readExecution(
    savedIntent: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>>;
  /** Recovery-only proof that the exact native attempt and every job completed. */
  confirmCompletedExecution?(
    execution: HostedExecutionIntentV1,
  ): Promise<boolean>;
  verifyRevision(revision: GitSha): Promise<PortResultV1<boolean>>;
  verifyAncestor?(
    ancestor: GitSha,
    descendant: GitSha,
  ): Promise<PortResultV1<boolean>>;
  verifyLauncherCi?(
    revision: GitSha,
  ): Promise<PortResultV1<{ revision: GitSha; checkRunId: number } | null>>;
  /** Ordinary-only proof of the exact admitted revision's native matrix entrypoint. */
  verifyMatrixOrdinaryRevision?(
    revision: GitSha,
  ): Promise<PortResultV1<boolean>>;
  verifyRequest(request: ReleaseRequestV1): Promise<PortResultV1<boolean>>;
  /**
   * Trusted, independent read of the source issue's exact task statement,
   * performed immediately before any release selection or promotion: the
   * issue's own bounded title/body with the canonical digest of that text.
   * Absent, unreadable or over-bound context means the statement is
   * unavailable, which never authorizes an issue-backed release. A record
   * without a source issue (incident work) is not read at all.
   */
  readIssueTask?(
    issueNumber: number,
  ): Promise<PortResultV1<ReviewTaskStatementV1 | null>>;
}

export interface HostedSupervisorInputV1 {
  clock: Clock;
  state: StateReadView & ReleaseStateWriter;
  run: HostedSupervisorRunIdentityV1;
  evidence: HostedSupervisorEvidencePortV1;
  /** Temporary explicit owner recovery: resume only its genuine saved bootstrap. */
  ownerStartupRecoveryOnly?: boolean;
  /** Trusted in-process fixture only; production uses immutable source pins. */
  queueRuntimeCapability?: QueueRuntimeCapability;
  existingPrRuntimeCapability?: ExistingPrRuntimeCapability;
  runtimeRollout?: HostedRuntimeRollout;
}

export type HostedSupervisorOutcomeV1 =
  | { status: "run"; execution: HostedExecutionIntentV1 }
  | { status: "idle" | "pending"; detail: string };
