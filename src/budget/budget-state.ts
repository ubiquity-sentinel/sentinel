import { parseBudgetReservationV1 } from "../contracts/budget-reservation.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  BudgetReservationV1,
  ReservationOutcomeV1,
} from "../contracts/budget-reservation.ts";
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import type {
  Clock,
  PortResultV1,
  RepairStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../contracts/ports.ts";
import { parseRepositoryConfigV1 } from "../contracts/repository-config.ts";
import type {
  LiveStartLimitsV1,
  RepositoryConfigV1,
} from "../contracts/repository-config.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import {
  disabledPolicy,
  nextSequence,
  sameRepository,
  unavailable,
} from "./budget-rolling.ts";
import type {
  BudgetControllerOptionsV1,
  ReserveModelStartRequestV1,
  SettleModelStartResultV1,
} from "./budget-types.ts";

export class BudgetStateContext {
  protected readonly clock: Clock;
  protected readonly state: StateReadView & RepairStateWriter;
  protected readonly configs: readonly RepositoryConfigV1[];

  constructor(options: BudgetControllerOptionsV1) {
    this.clock = options.clock;
    this.state = options.state;
    this.configs = options.configs;
  }

  protected resolvePolicy(
    requested: RepositoryIdentityV1,
  ): { status: "valid"; limits: LiveStartLimitsV1 } | {
    status: "disabled";
    detail: string;
  } {
    if (this.configs.length === 0) {
      return disabledPolicy("no repository configurations were supplied");
    }
    let first: LiveStartLimitsV1 | null = null;
    let requestedConfigured = false;
    for (const config of this.configs) {
      let parsed: RepositoryConfigV1;
      try {
        parsed = parseRepositoryConfigV1(config);
      } catch {
        return disabledPolicy("a repository configuration failed validation");
      }
      if (parsed.liveStartLimits === null) {
        return disabledPolicy(
          "liveStartLimits is null: inference is not enabled",
        );
      }
      if (parsed.sessionBound === null) {
        return disabledPolicy(
          "sessionBound is null: session bounds are required",
        );
      }
      const limits = parsed.liveStartLimits;
      // Each cap is enforced only when numeric: explicit null means no cap
      // for that window, never a wildcard and never Infinity/zero. A present
      // numeric cap must stay a positive integer.
      if (
        (limits.perHour !== null && limits.perHour < 1) ||
        (limits.perSevenDays !== null && limits.perSevenDays < 1)
      ) {
        return disabledPolicy("live start caps must be positive integers");
      }
      if (first === null) {
        first = limits;
      } else if (
        limits.perHour !== first.perHour ||
        limits.perSevenDays !== first.perSevenDays
      ) {
        return disabledPolicy(
          "configured live start caps disagree across repositories",
        );
      }
      if (sameRepository(parsed.repository, requested)) {
        requestedConfigured = true;
      }
    }
    if (!requestedConfigured) {
      return disabledPolicy("the requested repository is not configured");
    }
    return { status: "valid", limits: first as LiveStartLimitsV1 };
  }

  // -------------------------------------------------------------------------
  // Timestamps, regression and rolling caps.
  // -------------------------------------------------------------------------

  protected readClock(): number | null {
    let now: number;
    try {
      now = this.clock.now();
    } catch {
      return null;
    }
    if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
      return null;
    }
    return now;
  }

  /**
   * The earliest time at which the clock is no longer behind durable state:
   * now must never be behind the snapshot updatedAt or any reservation
   * creation/settlement time (including refunded entries), or state written
   * by a newer clock could be lost. Returns null when now is not behind.
   */
  protected clockRegression(
    snapshot: RepairStateSnapshotV1,
    now: number,
  ): number | null {
    let latest = snapshot.updatedAt;
    for (const reservation of snapshot.reservations) {
      if (reservation.createdAt > latest) latest = reservation.createdAt;
      if (
        reservation.settledAt !== null && reservation.settledAt > latest
      ) {
        latest = reservation.settledAt;
      }
    }
    return now < latest ? latest : null;
  }

  protected extendSnapshot(
    prior: RepairStateSnapshotV1 | null,
    expectedHead: GitSha | null,
    now: number,
    reservation: BudgetReservationV1,
    sequence: number,
  ): RepairStateSnapshotV1 {
    const base = prior ?? {
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: now,
      incidents: [],
      evidence: [],
      work: [],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    };
    return {
      ...base,
      stateHead: expectedHead,
      sequence,
      updatedAt: now,
      reservations: [...base.reservations, reservation],
    };
  }

  protected updatedReservation(
    prior: BudgetReservationV1,
    outcome: ReservationOutcomeV1,
    now: number,
    proofRef: string | null,
  ): BudgetReservationV1 | null {
    const updated: BudgetReservationV1 = {
      ...prior,
      outcome,
      settledAt: now,
      proofRef,
      // createdAt is immutable trusted identity; never caller-supplied.
    };
    try {
      return parseBudgetReservationV1(updated);
    } catch {
      return null;
    }
  }

  /**
   * One settlement write, recomputed a bounded number of times after a CAS
   * lost to a cooldown-only movement (#205). The durable cooldown gate writes
   * `githubCooldowns` through the same store from concurrent reviewer
   * requests, so a settlement can lose its CAS between its read and its push.
   * Each retry rereads and continues only when every non-cooldown collection
   * still equals the loaded state (the reservation it settles included); any
   * other movement, an unchanged head or an unreadable state keeps the
   * original `conflict`, so the caller still fails closed.
   */
  protected async writeSettlement(
    snapshot: RepairStateSnapshotV1,
    expectedHead: GitSha,
    now: number,
    updated: BudgetReservationV1,
  ): Promise<SettleModelStartResultV1> {
    let base = snapshot;
    let head = expectedHead;
    for (let attempt = 1;; attempt++) {
      const result = await this.writeSettlementOnce(base, head, now, updated);
      if (
        result.status !== "conflict" ||
        attempt >= SETTLEMENT_CAS_ATTEMPTS ||
        result.currentHead === null || result.currentHead === head
      ) return result;
      let fresh;
      try {
        fresh = await this.state.readRepair();
      } catch {
        return result;
      }
      if (
        !fresh.ok || fresh.value.status !== "found" ||
        !sameNonCooldownState(snapshot, fresh.value.snapshot)
      ) return result;
      base = fresh.value.snapshot;
      head = fresh.value.head;
    }
  }

  private async writeSettlementOnce(
    snapshot: RepairStateSnapshotV1,
    expectedHead: GitSha,
    now: number,
    updated: BudgetReservationV1,
  ): Promise<SettleModelStartResultV1> {
    const sequence = nextSequence(snapshot);
    if (sequence === null) {
      return unavailable("state sequence is exhausted; no settlement applied");
    }
    const next: RepairStateSnapshotV1 = {
      ...snapshot,
      stateHead: expectedHead,
      sequence,
      // A cooldown write admitted on retry may carry a later instant.
      updatedAt: Math.max(now, snapshot.updatedAt),
      reservations: snapshot.reservations.map((r) =>
        r.id === updated.id ? updated : r
      ),
    };
    let write: PortResultV1<StateWriteResultV1>;
    try {
      write = await this.state.writeRepair(next, expectedHead);
    } catch {
      // A rejected write means the settlement may have been applied: no
      // outcome is claimed from this response; rereading reconciles.
      return { status: "ambiguous", currentHead: null };
    }
    if (!write.ok) {
      return unavailable(
        `state settlement write failed (${write.error.kind}); not applied`,
      );
    }
    if (write.value.status === "applied") {
      return {
        status: "settled",
        reservation: updated,
        stateHead: write.value.head,
      };
    }
    if (write.value.status === "conflict") {
      return { status: "conflict", currentHead: write.value.currentHead };
    }
    return { status: "ambiguous", currentHead: write.value.currentHead };
  }

  // -------------------------------------------------------------------------
  // Request validation via the frozen parsers (no duplicated validation).
  // -------------------------------------------------------------------------

  protected parseRepository(
    request: ReserveModelStartRequestV1,
  ): RepositoryIdentityV1 | null {
    try {
      return parseRepositoryIdentity(request.repository, "$.repository");
    } catch {
      return null;
    }
  }

  protected parseTaskId(taskId: WorkItemId): WorkItemId | null {
    if (
      typeof taskId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,256}$/.test(taskId)
    ) {
      return null;
    }
    return taskId as WorkItemId;
  }
}

/** Settlement writes attempted per call when only cooldowns moved (#205). */
const SETTLEMENT_CAS_ATTEMPTS = 3;

/**
 * Canonical equality of every non-cooldown collection, the same comparison
 * the repair loop's checkpoint uses (`sameNonCooldownContents`).
 */
function sameNonCooldownState(
  a: RepairStateSnapshotV1,
  b: RepairStateSnapshotV1,
): boolean {
  const pick = (value: RepairStateSnapshotV1) => ({
    version: value.version,
    kind: value.kind,
    incidents: value.incidents,
    evidence: value.evidence,
    work: value.work,
    reservations: value.reservations,
    reviews: value.reviews,
    replays: value.replays,
    releaseRequests: value.releaseRequests,
    attemptMemory: value.attemptMemory,
  });
  return canonicalStringify(pick(a)) === canonicalStringify(pick(b));
}
