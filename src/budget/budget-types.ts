import type {
  BudgetReservationV1,
  ReservationOutcomeV1,
  ReservationPurposeV1,
} from "../contracts/budget-reservation.ts";
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import type {
  Clock,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

export interface ReserveModelStartRequestV1 {
  repository: RepositoryIdentityV1;
  taskId: WorkItemId;
  /** Repository head the session would start against. */
  head: GitSha;
  /** One-based attempt; a genuinely new retry uses its own incremented attempt. */
  attempt: number;
  purpose: ReservationPurposeV1;
  /** Count and bind one exact implementation in the reservation's snapshot CAS. */
  implementationTransition?: {
    expectedStateHead: GitSha;
    expectedWork: WorkRecordV1;
    nextWork: WorkRecordV1;
  };
}

export type DeferredReasonV1 = "cap_limit" | "clock_regression";

export type ReserveModelStartResultV1 =
  | { status: "admitted"; reservation: BudgetReservationV1; stateHead: GitSha }
  | { status: "duplicate"; reservation: BudgetReservationV1 }
  | { status: "deferred"; reason: DeferredReasonV1; retryAt: number }
  | { status: "disabled"; detail: string }
  | { status: "conflict"; currentHead: GitSha | null }
  | { status: "ambiguous"; currentHead: GitSha | null }
  | { status: "unavailable"; detail: string }
  | { status: "invalid"; detail: string };

export interface SettleModelStartRequestV1 {
  /** The trusted derived reservation id. */
  id: string;
  /** submitted | ambiguous remain charged; confirmed_not_submitted refunds. */
  outcome: ReservationOutcomeV1;
  /** Required restricted proof ref iff outcome is confirmed_not_submitted. */
  proofRef: string | null;
}

export type SettleModelStartResultV1 =
  | { status: "settled"; reservation: BudgetReservationV1; stateHead: GitSha }
  | {
    status: "idempotent";
    reservation: BudgetReservationV1;
    stateHead: GitSha;
  }
  | { status: "deferred"; reason: "clock_regression"; retryAt: number }
  | { status: "conflict"; currentHead: GitSha | null }
  | { status: "ambiguous"; currentHead: GitSha | null }
  | { status: "unavailable"; detail: string }
  | { status: "invalid"; detail: string };

export interface BudgetControllerOptionsV1 {
  clock: Clock;
  /** The repair state capability: authoritative reads + one trusted writer. */
  state: StateReadView & RepairStateWriter;
  /**
   * Trusted complete repository configuration set. Every operation re-parses
   * and re-validates the whole set with the frozen parser; admission is
   * disabled on any missing/mismatched policy or unchosen repository.
   */
  configs: readonly RepositoryConfigV1[];
}

export interface BudgetControllerV1 {
  reserveModelStart(
    request: ReserveModelStartRequestV1,
  ): Promise<ReserveModelStartResultV1>;
  settleModelStart(
    request: SettleModelStartRequestV1,
  ): Promise<SettleModelStartResultV1>;
}
