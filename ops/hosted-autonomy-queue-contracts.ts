/** Shared queue coordinator capabilities. Only trusted host composition supplies these. */
import type { GitSha } from "../src/contracts/brands.ts";
import type { PortResultV1 } from "../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import type { CandidatePreservationV1 } from "../src/contracts/work-record.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type {
  MergeQueueSurface,
  QueueActor,
  QueueBinding,
  QueuePullIdentity,
  QueueRead,
  QueueSnapshot,
} from "../src/github/merge-queue-types.ts";
import type {
  QueueAuthorizationFacts,
  QueueMode,
} from "./hosted-autonomy-queue-policy.ts";
import type { HostedQueueCustodyContext } from "./hosted-autonomy-queue-context.ts";

export interface QueueAuthorizationRequest {
  snapshot: RepairStateSnapshotV1;
  observedHead: GitSha;
  record: WorkRecordV1;
  binding: QueueBinding | null;
  queue: QueueSnapshot;
}
export interface HostedQueueAuthorizationPort {
  /** Root-only acknowledgment of an authenticated, already-published refresh hold. */
  readPublishedRefreshRecovery?(
    request: QueueAuthorizationRequest & { deadline: number },
  ): Promise<QueueRead<{ candidate: CandidatePreservationV1; at: number }>>;
  /** Final adopted-PR App/custody gate; never a substitute for queue policy or intent provenance. */
  authorizeEnqueue?(
    request: QueueAuthorizationRequest & { deadline: number },
  ): Promise<PortResultV1<void>>;
  readAuthorization(request: QueueAuthorizationRequest): Promise<
    QueueRead<{
      binding: QueueBinding;
      pull: QueuePullIdentity;
      facts: QueueAuthorizationFacts;
    }>
  >;
  /** Exact entry/intent/head/event association and pinned removal semantics, never raw-text inference. */
  readRemoval(
    request: Omit<QueueAuthorizationRequest, "queue"> & {
      binding: QueueBinding;
      entryId: string;
    },
  ): Promise<
    QueueRead<{
      classification: "ci_failed" | "timeout" | "other" | "none";
      eventId: string | null;
    }>
  >;
}

export interface HostedQueueCoordinatorDeps {
  /** Reviewed source configuration. No variable can raise this ceiling. */
  config: {
    mode: QueueMode;
    proofActivated: boolean;
    appActor: QueueActor | null;
    /** Initial reviewed probation only; later reviewed source may disable it. */
    probation: boolean;
  };
  /** Trusted configured scope, including when the repair snapshot has no gateway work. */
  repository: RepositoryIdentityV1;
  readEffectiveQueueRule(): Promise<QueueRead<boolean>>;
  surface: MergeQueueSurface;
  authorization: HostedQueueAuthorizationPort;
  resolveDelivery?: HostedQueueCustodyContext["resolveDelivery"];
  verifyProtectedWrite?: HostedQueueCustodyContext["verifyProtectedWrite"];
}
