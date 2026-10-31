import { parseBudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import { isGitSha } from "../contracts/brands.ts";
import type {
  PortResultV1,
  StateReadResultV1,
  StateWriteResultV1,
} from "../contracts/ports.ts";
import { expectRestrictedRef } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  deriveReservationId,
  earliestRetryAt,
  invalid,
  nextSequence,
  PURPOSES,
  sameLogicalIdentity,
  SETTLEMENT_OUTCOMES,
  unavailable,
} from "./budget-rolling.ts";
import type {
  BudgetControllerV1,
  ReserveModelStartRequestV1,
  ReserveModelStartResultV1,
  SettleModelStartRequestV1,
  SettleModelStartResultV1,
} from "./budget-types.ts";
import { BudgetStateContext } from "./budget-state.ts";

/**
 * Rolling model-start budget controller.
 *
 * One global budget across all configured repositories: a model start is
 * admitted only after one new durable BudgetReservationV1 (outcome
 * "reserved") has been applied to the repair state branch. The caller holds
 * no cached snapshot between operations — every operation reads the
 * authoritative repair state, and a read/CAS failure, malformed state,
 * ambiguous write or persistence failure never grants permission.
 *
 * Everything in this module is trusted code: reservation ids are derived
 * deterministically from the canonical JSON of
 * repository/taskId/head/attempt/purpose (SHA-256), never accepted from the
 * caller, and neither createdAt nor settled state is caller-supplied. A
 * duplicate logical identity can never obtain a second start by choosing
 * another id or another retry: the same id plus identical logical identity
 * yields reconciliation-needed, and a mismatched identity under a colliding
 * id — or the same identity under a different id — is an invalid collision.
 * A genuinely new retry uses its own incremented attempt.
 *
 * Charging: millisecond rolling intervals (now - duration, now]; every
 * "reserved", "submitted" and "ambiguous" reservation charges globally. Only
 * "confirmed_not_submitted" with a validated restricted proof ref is
 * refunded. Windows never reset on process restart or midnight, and the
 * earliest retryAt across the enforced caps is computed by sorting charged
 * reservation timestamps rather than assuming one excess entry; timestamps
 * and sequence arithmetic must stay inside the safe-integer range, and an
 * overflow is a typed failure that writes nothing.
 *
 * Transports never throw across this boundary: a rejected read is a
 * sanitized unavailable (no permission), and a rejected write is ambiguous
 * with a null currentHead because the effect may have happened — no start is
 * ever granted from an unconfirmed response, and rereading reconciles.
 *
 * Admission policy is one trusted complete repository configuration set: the
 * configured repository must belong to the set, and every supplied config
 * must carry a non-null `liveStartLimits` record whose caps are each either an
 * explicit positive integer or explicit null (no cap), plus session bounds;
 * all shared policy fields must agree exactly. A null `liveStartLimits` record
 * still means inference is not enabled, never "unlimited"; a null field inside
 * a present record is the owner's explicit uncapped policy. Missing,
 * non-positive or mismatched policies disable admission; no default/fallback
 * caps are guessed. Workflow single-writer serialization and one deployed
 * config are required by the caller — this controller never invents
 * distributed policy negotiation.
 *
 * The controller contains no inference transport and no retry loop; after an
 * ambiguous or conflicting write the caller reconciles by rereading.
 */

export class RollingStartBudget extends BudgetStateContext
  implements BudgetControllerV1 {
  // -------------------------------------------------------------------------
  // Reserve: one durable reservation must be applied before a start is granted.
  // -------------------------------------------------------------------------

  async reserveModelStart(
    request: ReserveModelStartRequestV1,
  ): Promise<ReserveModelStartResultV1> {
    const identity = this.parseRepository(request);
    if (identity === null) {
      return invalid("repository identity is invalid");
    }
    const taskId = this.parseTaskId(request.taskId);
    if (taskId === null) {
      return invalid("taskId is invalid");
    }
    if (!isGitSha(request.head)) {
      return invalid("head must be a full 40-hex commit SHA");
    }
    if (
      typeof request.attempt !== "number" ||
      !Number.isSafeInteger(request.attempt) ||
      request.attempt < 1
    ) {
      return invalid("attempt must be a positive safe integer");
    }
    if (!PURPOSES.includes(request.purpose)) {
      return invalid("purpose is not a supported reservation purpose");
    }

    const policy = this.resolvePolicy(identity);
    if (policy.status === "disabled") {
      return { status: "disabled", detail: policy.detail };
    }

    const now = this.readClock();
    if (now === null) return unavailable("clock returned an invalid timestamp");

    let loaded: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>;
    try {
      loaded = await this.state.readRepair();
    } catch {
      // A rejected read is never a successful empty state: no information was
      // obtained, so no permission is granted (fixed sanitized detail; no
      // exception text can leak).
      return unavailable(
        "authoritative repair state could not be read; no permission granted",
      );
    }
    if (!loaded.ok) {
      return unavailable(
        "authoritative repair state could not be read; no permission granted",
      );
    }
    const expectedHead = loaded.value.status === "found"
      ? loaded.value.head
      : null;
    const prior = loaded.value.status === "found"
      ? loaded.value.snapshot
      : null;

    const regression = prior === null ? null : this.clockRegression(prior, now);
    if (regression !== null) {
      return {
        status: "deferred",
        reason: "clock_regression",
        retryAt: regression,
      };
    }

    const id = await deriveReservationId({
      repository: identity,
      taskId,
      head: request.head,
      attempt: request.attempt,
      purpose: request.purpose,
    });

    // Exact logical identity is decided before any duplicate classification: a
    // matching derived id is only `duplicate` when repository/taskId/head/
    // attempt/purpose all match. An id that belongs to a different logical
    // identity (a derivation/hash collision) is an invalid collision, never a
    // reconciliation-needed duplicate; the same identity under a different id
    // is likewise invalid.
    const sameId = prior?.reservations.find((r) => r.id === id) ?? null;
    if (
      sameId !== null &&
      sameLogicalIdentity(
        sameId,
        identity,
        taskId,
        request.head,
        request.attempt,
        request.purpose,
      )
    ) {
      // A prior matching reservation (including a refunded one) is never a
      // second start permission: same identity, reconciliation needed.
      return { status: "duplicate", reservation: sameId };
    }
    if (sameId !== null) {
      return invalid(
        "a reservation with this id belongs to a different logical identity",
      );
    }
    if (
      prior?.reservations.some((r) =>
        sameLogicalIdentity(
          r,
          identity,
          taskId,
          request.head,
          request.attempt,
          request.purpose,
        )
      ) === true
    ) {
      // Same task/head/attempt/purpose under a different id: a collision or
      // mismatched immutable identity — never a second admission.
      return invalid(
        "a reservation with this logical identity already exists under a different id",
      );
    }

    const transition = request.implementationTransition;
    if (
      transition !== undefined &&
      (!transition || typeof transition !== "object")
    ) {
      return invalid("implementation transition is invalid");
    }
    if (
      transition !== undefined && transition.expectedStateHead !== expectedHead
    ) {
      return { status: "conflict", currentHead: expectedHead };
    }
    const implementation = transition === undefined
      ? null
      : this.implementationWork(request, id, prior, now);
    if (transition !== undefined && implementation === null) {
      return invalid(
        "implementation transition does not match the exact work admission",
      );
    }

    const reservation: BudgetReservationV1 = {
      version: "v1",
      kind: "budget_reservation",
      repository: identity,
      id,
      taskId,
      attempt: request.attempt,
      head: request.head,
      purpose: request.purpose,
      createdAt: now,
      outcome: "reserved",
      settledAt: null,
      proofRef: null,
    };
    // The frozen parser is the final gate for the record we persist.
    try {
      parseBudgetReservationV1(reservation);
    } catch {
      return invalid("constructed reservation failed contract validation");
    }

    let retryAt: number;
    try {
      retryAt = earliestRetryAt(
        prior?.reservations ?? [],
        now,
        policy.limits,
      );
    } catch (error) {
      // The arithmetic helper throws a fixed sanitized RangeError on invalid
      // or overflowing inputs; that is malformed state, never a permission.
      if (error instanceof RangeError) {
        return unavailable(
          "state reservation timestamps are out of range; no permission granted",
        );
      }
      throw error;
    }
    if (retryAt > now) {
      return { status: "deferred", reason: "cap_limit", retryAt };
    }

    const sequence = nextSequence(prior);
    if (sequence === null) {
      return unavailable(
        "state sequence is exhausted; no permission granted",
      );
    }

    const next = this.extendSnapshot(
      prior,
      expectedHead,
      now,
      reservation,
      sequence,
      implementation,
    );
    let write: PortResultV1<StateWriteResultV1>;
    try {
      write = await this.state.writeRepair(next, expectedHead);
    } catch {
      // A rejected write means the effect may have happened: never grant a
      // start from this response; the caller rereads and reconciles.
      return { status: "ambiguous", currentHead: null };
    }
    if (!write.ok) {
      return unavailable(
        `state write failed (${write.error.kind}); no permission granted`,
      );
    }
    if (write.value.status === "applied") {
      return {
        status: "admitted",
        reservation,
        stateHead: write.value.head,
      };
    }
    if (write.value.status === "conflict") {
      return { status: "conflict", currentHead: write.value.currentHead };
    }
    return { status: "ambiguous", currentHead: write.value.currentHead };
  }

  // -------------------------------------------------------------------------
  // Settle: reconciliation of one durable reservation; never a new admission.
  // -------------------------------------------------------------------------

  async settleModelStart(
    request: SettleModelStartRequestV1,
  ): Promise<SettleModelStartResultV1> {
    if (
      typeof request.id !== "string" ||
      request.id.length === 0 ||
      request.id.length > 256
    ) {
      return invalid("reservation id is invalid");
    }
    if (!SETTLEMENT_OUTCOMES.includes(request.outcome)) {
      return invalid("outcome is not a settlement outcome");
    }
    let proofRef: string | null;
    try {
      proofRef = request.proofRef === null
        ? null
        : expectRestrictedRef(request.proofRef, "$.proofRef");
    } catch {
      return invalid("proofRef must be a restricted storage reference");
    }
    if (request.outcome === "confirmed_not_submitted" && proofRef === null) {
      return invalid("confirmed_not_submitted requires a proof ref");
    }
    if (request.outcome !== "confirmed_not_submitted" && proofRef !== null) {
      return invalid("proof ref is only valid for confirmed_not_submitted");
    }

    const now = this.readClock();
    if (now === null) return unavailable("clock returned an invalid timestamp");

    let loaded: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>;
    try {
      loaded = await this.state.readRepair();
    } catch {
      // A rejected read is never a successful empty state: no settlement is
      // applied from an unreadable authoritative state.
      return unavailable(
        "authoritative repair state could not be read; no settlement applied",
      );
    }
    if (!loaded.ok) {
      return unavailable(
        "authoritative repair state could not be read; no settlement applied",
      );
    }
    if (loaded.value.status !== "found") {
      return invalid("no reservation with that id exists");
    }
    const snapshot = loaded.value.snapshot;
    const expectedHead = loaded.value.head;

    const regression = this.clockRegression(snapshot, now);
    if (regression !== null) {
      return {
        status: "deferred",
        reason: "clock_regression",
        retryAt: regression,
      };
    }

    const prior = snapshot.reservations.find((r) => r.id === request.id);
    if (prior === undefined) {
      return invalid("no reservation with that id exists");
    }

    // Equal already-settled outcome: idempotent, never rewrites its timestamp.
    if (prior.outcome === request.outcome) {
      if (
        prior.proofRef === proofRef ||
        (request.outcome !== "confirmed_not_submitted" && proofRef === null)
      ) {
        return {
          status: "idempotent",
          reservation: prior,
          stateHead: expectedHead,
        };
      }
      return invalid("settled proof ref cannot change");
    }

    if (prior.outcome === "reserved") {
      const updated = this.updatedReservation(
        prior,
        request.outcome,
        now,
        proofRef,
      );
      if (updated === null) {
        return invalid("settlement failed contract validation");
      }
      return this.writeSettlement(snapshot, expectedHead, now, updated);
    }

    // A settled reservation never reverts to reserved and never changes to a
    // contradictory terminal outcome (submitted/confirmed stay immutable).
    if (prior.outcome !== "ambiguous") {
      return invalid(
        "settled reservation cannot change to a contradictory terminal outcome",
      );
    }
    // Ambiguous may resolve to submitted (charged) or to a proved
    // confirmed_not_submitted; time only moves forward (regression-blocked).
    const updated = this.updatedReservation(
      prior,
      request.outcome,
      now,
      proofRef,
    );
    if (updated === null) {
      return invalid("settlement failed contract validation");
    }
    return this.writeSettlement(snapshot, expectedHead, now, updated);
  }

  // -------------------------------------------------------------------------
  // Policy: one global budget, one trusted complete config set.
  // -------------------------------------------------------------------------
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for deterministic use and boundary tests).
// ---------------------------------------------------------------------------

export {
  deriveReservationId,
  earliestRetryAt,
  HOUR_WINDOW_MS,
  isCharged,
  SEVEN_DAY_WINDOW_MS,
} from "./budget-rolling.ts";

export type {
  BudgetControllerOptionsV1,
  BudgetControllerV1,
  DeferredReasonV1,
  ReserveModelStartRequestV1,
  ReserveModelStartResultV1,
  SettleModelStartRequestV1,
  SettleModelStartResultV1,
} from "./budget-types.ts";
