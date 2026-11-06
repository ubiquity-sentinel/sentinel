/** Calendar CI scheduling with retained estimates and private incremental accounting. */
import type { Clock } from "../contracts/ports.ts";
import {
  acceptedCiMinutePolicy,
  ciJobMinutes,
  ciMinuteDigest,
  ciMonth,
  ciPolicyDigest,
  ciTerminalEstimateDigest,
  INACTIVE_CI_MINUTE_POLICY,
  parseCiMinuteLedger,
} from "../contracts/ci-minute-budget.ts";
import type {
  CiEffectFactsV1,
  CiEffectV1,
  CiMinuteCoordinatorV1,
  CiMinuteDecisionV1,
  CiMinuteLedgerV1,
  CiMinuteObservationV1,
  CiMinuteObserverV1,
  CiMinutePolicyV1,
  CiMinuteReconcileDecisionV1,
  CiMinuteReservationV1,
  CiMinuteStoreV1,
} from "../contracts/ci-minute-budget.ts";

export const INACTIVE_CI_MINUTES: CiMinuteCoordinatorV1 = Object.freeze({
  active: false,
  reserve: () => Promise.resolve({ kind: "inactive" as const }),
  reconcile: () => Promise.resolve({ kind: "inactive" as const }),
});

/** Missing/read-only host capabilities deny effects, never silently select off. */
export const REFUSING_CI_MINUTES: CiMinuteCoordinatorV1 = Object.freeze({
  active: true,
  reserve: () =>
    Promise.resolve({
      kind: "unavailable" as const,
      reason: "CI capability unavailable",
    }),
  reconcile: () =>
    Promise.resolve({
      kind: "unavailable" as const,
      reason: "CI capability unavailable",
    }),
});

export interface CiMinuteControllerOptionsV1 {
  policy: CiMinutePolicyV1;
  clock: Clock;
  store: CiMinuteStoreV1;
  /** Existing trusted owner-policy verifier; reference syntax alone is not authority. */
  authorizePolicy(
    policy: CiMinutePolicyV1,
    deadline: number,
    facts?: CiEffectFactsV1,
  ): Promise<boolean>;
  /** Trusted authenticated exact-effect/workflow resolver, never model supplied. */
  resolve(
    effect: CiEffectV1,
    deadline: number,
  ): Promise<CiEffectFactsV1 | null>;
  /** Incremental authenticated evidence; incomplete coverage grants nothing. */
  observe: CiMinuteObserverV1;
}

/** No store constructor, read, write, clock or network callback is touched when off. */
export function createCiMinuteController(
  options?: CiMinuteControllerOptionsV1,
): CiMinuteCoordinatorV1 {
  if (options === undefined || options.policy.activated === false) {
    return INACTIVE_CI_MINUTES;
  }
  return new CalendarCiMinutes(options);
}

export function proposedCiMinutePolicy(): CiMinutePolicyV1 {
  return structuredClone(INACTIVE_CI_MINUTE_POLICY);
}

/** Protected-source acceptance first, then authenticated exact workflow facts. */
export function verifyCiMinuteSchedulingBasis(
  policy: CiMinutePolicyV1,
  deadline: number,
  facts?: CiEffectFactsV1,
): Promise<boolean> {
  try {
    const accepted = acceptedCiMinutePolicy();
    if (
      !Number.isSafeInteger(deadline) ||
      ciPolicyDigest(policy) !== ciPolicyDigest(accepted)
    ) {
      return Promise.resolve(false);
    }
    if (facts === undefined) return Promise.resolve(true);
    const target = accepted.targets.find((row) =>
      row.repositoryId === facts.repositoryId
    );
    return Promise.resolve(
      target !== undefined &&
        facts.workflowBlob === target.workflowBlob &&
        facts.job === target.job &&
        facts.runner === target.runner &&
        facts.timeoutMinutes === target.timeoutMinutes &&
        facts.ceilingMinutes === target.ceilingMinutes &&
        facts.qualificationDigest === accepted.ceilingQualification &&
        typeof facts.triggered === "boolean" &&
        facts.jobs === (facts.triggered ? 1 : 0) &&
        ["not_applied", "applied", "unknown"].includes(facts.effectState),
    );
  } catch {
    return Promise.resolve(false);
  }
}

function held(retryAt: number, reason: string): CiMinuteDecisionV1 {
  return { kind: "held", retryAt, reason };
}

function unavailable(reason: string): CiMinuteDecisionV1 {
  return { kind: "unavailable", reason };
}

export class CalendarCiMinutes implements CiMinuteCoordinatorV1 {
  readonly active = true;
  private readonly policy: CiMinutePolicyV1;
  private readonly policyDigest: string;

  constructor(private readonly options: CiMinuteControllerOptionsV1) {
    this.policy = structuredClone(options.policy);
    if (!this.policy.activated) {
      throw new Error("active CI controller needs accepted policy");
    }
    this.policyDigest = ciPolicyDigest(this.policy);
  }

  async reserve(
    effect: CiEffectV1,
    deadline: number,
  ): Promise<CiMinuteDecisionV1> {
    return await this.run(effect, deadline) as CiMinuteDecisionV1;
  }

  async reconcile(deadline: number): Promise<CiMinuteReconcileDecisionV1> {
    return await this.run(null, deadline) as CiMinuteReconcileDecisionV1;
  }

  private async run(
    effect: CiEffectV1 | null,
    deadline: number,
  ): Promise<CiMinuteDecisionV1 | CiMinuteReconcileDecisionV1> {
    try {
      const target = effect === null
        ? undefined
        : this.policy.targets.find((t) =>
          t.owner === effect.repository.owner &&
          t.name === effect.repository.name
        );
      if (effect !== null && target === undefined) return { kind: "inactive" };
      const now = this.options.clock.now();
      const period = ciMonth(now);
      if (!Number.isSafeInteger(deadline) || deadline <= now) {
        return unavailable("deadline");
      }
      if (!await this.options.authorizePolicy(this.policy, deadline)) {
        return unavailable("policy_basis_unavailable");
      }
      if (effect !== null && !this.validEffect(effect)) {
        return unavailable("effect_identity");
      }
      const facts = effect === null
        ? null
        : await this.options.resolve(effect, deadline);
      if (
        facts !== null &&
        !await this.options.authorizePolicy(this.policy, deadline, facts)
      ) return unavailable("workflow_billing_basis_unavailable");
      if (
        effect !== null &&
        (facts === null || facts.repositoryId !== target!.repositoryId ||
          facts.qualificationDigest !== this.policy.ceilingQualification ||
          !/^[0-9a-f]{40}$/.test(facts.workflowBlob) ||
          !/^[A-Za-z0-9._-]{1,100}$/.test(facts.job))
      ) return unavailable("workflow_binding");
      if (facts !== null && !facts.triggered) {
        return facts.jobs === 0 && facts.effectState !== "unknown"
          ? { kind: "inactive" }
          : unavailable("trigger_binding");
      }
      if (
        facts !== null && (facts.jobs !== 1 ||
          !["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"].includes(
            facts.runner,
          ) ||
          !Number.isSafeInteger(facts.timeoutMinutes) ||
          facts.timeoutMinutes < 1 ||
          facts.timeoutMinutes > target!.ceilingMinutes ||
          facts.ceilingMinutes !== target!.ceilingMinutes)
      ) {
        return unavailable("unqualified_cost_bound");
      }
      const id = facts === null ? null : ciMinuteDigest({
        domain: "sentinel-ci-effect-v1",
        effect,
        workflowBlob: facts.workflowBlob,
        job: facts.job,
        repositoryId: facts.repositoryId,
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = this.options.clock.now();
        if (current >= deadline) return unavailable("deadline");
        if (ciMonth(current).month !== period.month) {
          return unavailable("month_changed");
        }
        const read = await this.options.store.read(period.month);
        if (!read.ok) return unavailable("state_read");
        let ledger = read.value.ledger;
        if (ledger === null) {
          const previous = await this.options.store.readPrior(period.month);
          if (!previous.ok) return unavailable("state_read");
          if (previous.value.head !== read.value.head) continue;
          const old = previous.value.ledger === null
            ? null
            : parseCiMinuteLedger(previous.value.ledger);
          if (old !== null && old.policyDigest !== this.policyDigest) {
            return unavailable("policy_changed");
          }
          ledger = {
            version: 1,
            month: period.month,
            policyDigest: this.policyDigest,
            updatedAt: now,
            sequence: 1,
            baselineMinutes: old === null ? this.policy.managedLimit : 0,
            watermark: null,
            reservations: old?.reservations.filter((r) => {
              if (r.state === "confirmed_not_submitted") return false;
              if (r.state === "settled" || r.state === "terminal_estimated") {
                return r.accounting !== undefined &&
                  r.accounting.kind !== "never_started" &&
                  (r.accounting.executionMonth === null ||
                    r.accounting.executionMonth >= period.month);
              }
              return true;
            }) ?? [],
            observed: [],
            progress: old?.progress
              ? { ...structuredClone(old.progress), month: period.month }
              : null,
            completedAttempts: [],
            proofs: old?.proofs?.filter((job) =>
              job.estimate?.executionMonth === null
            ) ?? [],
            ...(old === null
              ? {
                bootstrap: {
                  kind: "conservative_unknown_history" as const,
                  month: period.month,
                  floorMinutes: this.policy.managedLimit,
                  createdAt: now,
                  policyDigest: this.policyDigest,
                },
              }
              : {}),
            ...(old?.catalog === undefined ? {} : {
              catalog: {
                ...structuredClone(old.catalog),
                cursor: old.progress ? old.catalog.cursor : 0,
                complete: false,
                runs: old.catalog.runs.map((run) => ({
                  ...run,
                  refreshRequired: true,
                })),
              },
            }),
          };
          ledger.observed = old?.observed.filter((row) =>
            ledger!.proofs?.some((job) =>
              job.digest === row.digest
            )
          ) ?? [];
          const initialized = await this.save(read.value.head, ledger);
          if (initialized === "conflict" || initialized === "applied") continue;
          return unavailable("state_write");
        }
        ledger = parseCiMinuteLedger(ledger);
        if (
          ledger.policyDigest !== this.policyDigest ||
          ledger.month !== period.month
        ) return unavailable("policy_changed");
        if (now < ledger.updatedAt) {
          return effect === null
            ? {
              kind: "pending",
              retryAt: ledger.updatedAt,
              reason: "clock_regression",
            }
            : held(ledger.updatedAt, "clock_regression");
        }
        const observation = await this.options.observe(
          period.month,
          deadline,
          ledger,
        );
        if (
          observation === null || observation.month !== period.month ||
          !Number.isSafeInteger(observation.watermark) ||
          observation.watermark < 0 ||
          observation.watermark > this.options.clock.now() ||
          (observation.observedAt !== undefined &&
            (!Number.isSafeInteger(observation.observedAt) ||
              observation.observedAt < observation.watermark ||
              observation.observedAt > this.options.clock.now()))
        ) {
          return unavailable("incomplete_reconciliation");
        }
        if (
          !observation.complete && !observation.progress && !observation.catalog
        ) {
          return unavailable("incomplete_reconciliation");
        }
        const next = this.observe(ledger, observation, now);
        if (!observation.complete) {
          const saved = await this.save(read.value.head, next);
          if (saved === "conflict") continue;
          return saved === "applied"
            ? effect === null
              ? {
                kind: "pending",
                retryAt: this.options.clock.now() + 300_000,
                reason: "reconciliation",
              }
              : held(this.options.clock.now() + 300_000, "reconciliation")
            : unavailable("state_write");
        }
        if (
          next.reservations.some((r) =>
            this.exposed(r, next.month) && r.chargedMinutes > r.ceilingMinutes
          ) ||
          next.proofs?.some((p) =>
            p.neverStarted && Number(p.billedDurationMs) > 0
          )
        ) {
          const saved = await this.save(read.value.head, next);
          if (saved === "conflict") continue;
          return unavailable(
            saved === "applied" ? "qualified_ceiling_exceeded" : "state_write",
          );
        }
        if (effect === null) {
          const saved = await this.save(read.value.head, next);
          if (saved === "conflict") continue;
          return saved === "applied"
            ? { kind: "ready", month: period.month, watermark: next.watermark! }
            : unavailable("state_write");
        }
        const prior = next.reservations.find((r) => r.effectDigest === id);
        if (prior !== undefined) {
          if (
            prior.policyDigest !== this.policyDigest ||
            prior.ceilingMinutes !== facts!.ceilingMinutes
          ) {
            return unavailable("reservation_identity");
          }
          if (facts!.effectState === "applied") {
            const saved = await this.save(read.value.head, next);
            if (saved === "conflict") continue;
            return saved === "applied"
              ? this.grant("reconciled", id!, deadline, period.month)
              : unavailable("state_write");
          }
          if (
            facts!.effectState !== "not_applied" || prior.state === "settled" ||
            prior.state === "terminal_estimated" ||
            prior.state === "confirmed_not_submitted"
          ) return unavailable("effect_reconciliation");
          // Only authenticated proof of nonapplication permits the same effect again.
          const saved = await this.save(read.value.head, next);
          if (saved === "conflict") continue;
          return saved === "applied"
            ? this.grant("admitted", id!, deadline, period.month)
            : unavailable("state_write");
        }
        if (facts!.effectState !== "not_applied") {
          return unavailable("effect_reconciliation");
        }
        const reserved = next.reservations.reduce(
          (sum, r) =>
            sum + (this.exposed(r, next.month) ? r.chargedMinutes : 0),
          0,
        );
        const managed = next.bootstrap === undefined
          ? next.baselineMinutes + reserved
          : Math.max(next.baselineMinutes, reserved);
        const accounted = new Set(next.reservations.map((r) => r.effectDigest));
        const unmanaged = next.observed.filter((j) =>
          (j.effectDigest === null || !accounted.has(j.effectDigest)) &&
          !next.proofs?.some((p) =>
            p.digest === j.digest && p.estimate?.executionMonth !== null &&
            p.estimate?.executionMonth !== undefined &&
            p.estimate.executionMonth < next.month
          )
        )
          .reduce((sum, j) => sum + j.minutes, 0);
        const limit = Math.min(
          this.policy.managedLimit,
          this.policy.monthlyLimit - this.policy.securityReserve -
            Math.max(this.policy.unmanagedReserve, unmanaged),
        );
        const earned = Math.floor(
          this.policy.managedLimit * (now - period.start) /
            (period.end - period.start),
        );
        if (![managed, unmanaged, earned, limit].every(Number.isSafeInteger)) {
          return unavailable("accounting_overflow");
        }
        const needed = managed + facts!.ceilingMinutes;
        if (needed > limit) {
          const saved = await this.save(read.value.head, next);
          if (saved === "conflict") continue;
          return saved === "applied"
            ? held(period.end, "monthly_allowance")
            : unavailable("state_write");
        }
        if (needed > earned) {
          const saved = await this.save(read.value.head, next);
          if (saved === "conflict") continue;
          const retryAt = period.start +
            Math.ceil(
              needed * (period.end - period.start) / this.policy.managedLimit,
            );
          return saved === "applied"
            ? held(retryAt, "calendar_allowance")
            : unavailable("state_write");
        }
        next.reservations.push({
          effectDigest: id!,
          policyDigest: this.policyDigest,
          ceilingMinutes: facts!.ceilingMinutes,
          state: "reserved",
          createdAt: now,
          settledAt: null,
          chargedMinutes: facts!.ceilingMinutes,
          proofDigest: null,
          binding: {
            effect: structuredClone(effect),
            repositoryId: facts!.repositoryId,
            workflowBlob: facts!.workflowBlob,
            job: facts!.job,
          },
        });
        const saved = await this.save(read.value.head, next);
        if (saved === "conflict") continue;
        return saved === "applied"
          ? this.grant("admitted", id!, deadline, period.month)
          : unavailable("state_write");
      }
      return unavailable("state_conflict");
    } catch {
      return unavailable("invalid_evidence");
    }
  }

  private validEffect(effect: CiEffectV1): boolean {
    return [effect.head, effect.base].every((v) =>
      v === null || /^[0-9a-f]{40}$/.test(v)
    ) &&
      typeof effect.ref === "string" && effect.ref.length <= 240 &&
      (effect.pr === null ||
        (Number.isSafeInteger(effect.pr) && effect.pr > 0)) &&
      (effect.kind !== "rerun" ||
        (Number.isSafeInteger(effect.runId) && Number(effect.runId) > 0 &&
          Number.isSafeInteger(effect.attempt) && Number(effect.attempt) > 1));
  }

  private exposed(reservation: CiMinuteReservationV1, month: string): boolean {
    return reservation.accounting === undefined ||
      (reservation.accounting.kind !== "never_started" &&
        (reservation.accounting.executionMonth === null ||
          reservation.accounting.executionMonth >= month));
  }

  private grant(
    kind: "admitted" | "reconciled",
    reservationDigest: string,
    deadline: number,
    month: string,
  ): CiMinuteDecisionV1 {
    const now = this.options.clock.now();
    if (now >= deadline) return unavailable("deadline_after_reservation");
    if (ciMonth(now).month !== month) {
      return unavailable("month_changed_after_reservation");
    }
    return { kind, reservationDigest };
  }

  private observe(
    ledger: CiMinuteLedgerV1,
    proof: CiMinuteObservationV1,
    now: number,
  ): CiMinuteLedgerV1 {
    if (ledger.watermark !== null && proof.watermark < ledger.watermark) {
      throw new Error("CI watermark regression");
    }
    const next = structuredClone(ledger);
    const proofs = next.proofs ?? [];
    for (const incoming of proof.jobs) {
      const job = structuredClone(incoming);
      if (
        job.billedDurationMs !== null &&
        (!Number.isSafeInteger(job.billedDurationMs) ||
          job.billedDurationMs < 0)
      ) {
        throw new Error("CI invalid provider quantity");
      }
      if (
        job.estimate !== undefined && job.estimate.kind !== "retained_estimate"
      ) {
        throw new Error("CI invalid estimate kind");
      }
      if (
        job.completedAt !== null &&
        job.completedAt > (proof.observedAt ?? proof.watermark)
      ) {
        throw new Error("CI job beyond watermark");
      }
      const reservation = next.reservations.find((row) =>
        row.effectDigest === job.effectDigest
      );
      const target = this.policy.targets.find((row) =>
        row.repositoryId === job.identity?.repositoryId
      );
      const ceiling = reservation?.ceilingMinutes ?? target?.ceilingMinutes ??
        0;
      let minutes: number;
      if (job.neverStarted) {
        minutes = ciJobMinutes(job);
      } else {
        // Raw started-zero is still invalid. Only the authenticated reader's
        // explicit estimate can qualify missing/zero provider timing.
        const metered =
          job.estimate === undefined || Number(job.billedDurationMs) > 0
            ? ciJobMinutes(job)
            : 0;
        if (job.estimate !== undefined && job.estimate.minutes < ceiling) {
          throw new Error("CI estimate below retained profile");
        }
        minutes = Math.max(ceiling, metered, job.estimate?.minutes ?? 0);
        const executionMonth =
          job.startedAt !== null && job.completedAt !== null &&
            ciMonth(job.startedAt).month === ciMonth(job.completedAt).month
            ? ciMonth(job.startedAt).month
            : null;
        if (
          job.estimate !== undefined &&
          (job.estimate.terminalProofDigest !== ciTerminalEstimateDigest(job) ||
            job.estimate.executionMonth !== executionMonth)
        ) {
          throw new Error("CI estimate provenance changed");
        }
        job.estimate = {
          kind: "retained_estimate",
          minutes,
          executionMonth,
          terminalProofDigest: ciTerminalEstimateDigest(job),
        };
      }
      const oldProof = proofs.find((p) => p.digest === job.digest);
      if (oldProof !== undefined) {
        if (
          ciMinuteDigest(oldProof.identity ?? null) !==
            ciMinuteDigest(job.identity ?? null)
        ) throw new Error("CI billed proof identity changed");
        if (
          oldProof.startedAt !== job.startedAt ||
          oldProof.completedAt !== job.completedAt ||
          oldProof.neverStarted !== job.neverStarted ||
          oldProof.terminal !== job.terminal ||
          (oldProof.conclusion ?? null) !== (job.conclusion ?? null)
        ) {
          throw new Error("CI terminal proof changed");
        }
        if (
          oldProof.billedDurationMs !== null &&
          (job.billedDurationMs === null ||
            oldProof.billedDurationMs > job.billedDurationMs)
        ) {
          job.billedDurationMs = oldProof.billedDurationMs;
        }
        minutes = Math.max(minutes, oldProof.estimate?.minutes ?? 0);
        if (job.estimate !== undefined) job.estimate.minutes = minutes;
        job.effectDigest ??= oldProof.effectDigest;
        Object.assign(oldProof, job);
      } else proofs.push(structuredClone(job));
      const prior = next.observed.find((row) => row.digest === job.digest);
      if (prior !== undefined) {
        if (
          (prior.effectDigest !== job.effectDigest &&
            (prior.effectDigest !== null || job.effectDigest === null))
        ) throw new Error("CI job identity changed");
        prior.minutes = Math.max(prior.minutes, minutes);
        if (prior.effectDigest === null && job.effectDigest !== null) {
          prior.effectDigest = job.effectDigest;
        }
      } else {next.observed.push({
          digest: job.digest,
          effectDigest: job.effectDigest,
          minutes,
        });}
    }
    for (const reservation of next.reservations) {
      const jobs = next.observed.filter((j) =>
        j.effectDigest === reservation.effectDigest
      );
      if (jobs.length > 1) throw new Error("CI one-job profile changed");
      const jobProof = jobs.length === 1
        ? proofs.find((p) => p.digest === jobs[0].digest)
        : undefined;
      const periodKnown = jobProof !== undefined &&
        (jobProof.neverStarted && jobProof.billedDurationMs === 0 ||
          jobProof.estimate?.executionMonth !== null &&
            jobProof.estimate?.executionMonth !== undefined);
      const terminal = [
        "settled",
        "terminal_estimated",
        "confirmed_not_submitted",
      ].includes(reservation.state);
      if (
        jobs.length === 1 && !periodKnown && !terminal
      ) {
        reservation.chargedMinutes = Math.max(
          reservation.chargedMinutes,
          jobs[0].minutes,
        );
        continue;
      }
      if (jobs.length === 1 && !terminal && jobProof !== undefined) {
        reservation.state = jobProof.neverStarted
          ? "settled"
          : "terminal_estimated";
        reservation.chargedMinutes = jobProof.neverStarted
          ? jobs[0].minutes
          : Math.max(reservation.chargedMinutes, jobs[0].minutes);
        reservation.settledAt = now;
        reservation.proofDigest = jobProof.neverStarted
          ? jobProof.digest
          : jobProof.estimate!.terminalProofDigest;
        reservation.accounting = {
          kind: jobProof.neverStarted ? "never_started" : "retained_estimate",
          executionMonth: jobProof.neverStarted
            ? null
            : jobProof.estimate!.executionMonth,
          terminalProofDigest: reservation.proofDigest,
          startedAt: jobProof.startedAt,
          completedAt: jobProof.completedAt,
        };
      }
      if (
        jobs.length === 1 &&
        ["settled", "terminal_estimated"].includes(reservation.state)
      ) {
        reservation.chargedMinutes = Math.max(
          reservation.chargedMinutes,
          jobs[0].minutes,
        );
      }
    }
    next.sequence++;
    next.proofs = proofs;
    next.updatedAt = now;
    if (proof.complete) next.watermark = proof.watermark;
    if (proof.progress !== undefined) {
      next.progress = structuredClone(proof.progress);
    }
    if (proof.catalog !== undefined) {
      next.catalog = structuredClone(proof.catalog);
    }
    if (proof.completedAttempts !== undefined) {
      next.completedAttempts = [
        ...new Set([
          ...(next.completedAttempts ?? []),
          ...proof.completedAttempts,
        ]),
      ];
    }
    return parseCiMinuteLedger(next);
  }

  private async save(
    head: import("../contracts/brands.ts").GitSha | null,
    ledger: CiMinuteLedgerV1,
  ) {
    const written = await this.options.store.write({
      expectedHead: head,
      ledger: parseCiMinuteLedger(ledger),
    });
    return written.ok ? written.value.status : "unavailable";
  }
}
