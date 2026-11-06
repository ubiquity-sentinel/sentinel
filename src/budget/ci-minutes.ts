/** Calendar CI admission. Hosts deliberately construct only the inactive capability. */
import type { Clock } from "../contracts/ports.ts";
import {
  ciJobMinutes,
  ciMinuteDigest,
  ciMonth,
  ciPolicyDigest,
  INACTIVE_CI_MINUTE_POLICY,
  parseCiMinuteLedger,
} from "../contracts/ci-minute-budget.ts";
import type {
  CiEffectFactsV1,
  CiEffectV1,
  CiMinuteControllerV1,
  CiMinuteDecisionV1,
  CiMinuteLedgerV1,
  CiMinuteObservationV1,
  CiMinutePolicyV1,
  CiMinuteStoreV1,
} from "../contracts/ci-minute-budget.ts";

export const INACTIVE_CI_MINUTES: CiMinuteControllerV1 = Object.freeze({
  active: false,
  reserve: () => Promise.resolve({ kind: "inactive" as const }),
});

/** Missing/read-only host capabilities deny effects, never silently select off. */
export const REFUSING_CI_MINUTES: CiMinuteControllerV1 = Object.freeze({
  active: true,
  reserve: () =>
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
  /** Complete all-attempt repository evidence; incomplete windows grant nothing. */
  observe(
    month: string,
    deadline: number,
    ledger: CiMinuteLedgerV1,
  ): Promise<CiMinuteObservationV1 | null>;
}

/** No store constructor, read, write, clock or network callback is touched when off. */
export function createCiMinuteController(
  options?: CiMinuteControllerOptionsV1,
): CiMinuteControllerV1 {
  if (options === undefined || options.policy.activated === false) {
    return INACTIVE_CI_MINUTES;
  }
  return new CalendarCiMinutes(options);
}

export function proposedCiMinutePolicy(): CiMinutePolicyV1 {
  return structuredClone(INACTIVE_CI_MINUTE_POLICY);
}

function held(retryAt: number, reason: string): CiMinuteDecisionV1 {
  return { kind: "held", retryAt, reason };
}

function unavailable(reason: string): CiMinuteDecisionV1 {
  return { kind: "unavailable", reason };
}

export class CalendarCiMinutes implements CiMinuteControllerV1 {
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
    try {
      const target = this.policy.targets.find((t) =>
        t.owner === effect.repository.owner && t.name === effect.repository.name
      );
      if (target === undefined) return { kind: "inactive" };
      const now = this.options.clock.now();
      const period = ciMonth(now);
      if (!Number.isSafeInteger(deadline) || deadline <= now) {
        return unavailable("deadline");
      }
      if (!await this.options.authorizePolicy(this.policy, deadline)) {
        return unavailable("policy_basis_unavailable");
      }
      if (!this.validEffect(effect)) return unavailable("effect_identity");
      const facts = await this.options.resolve(effect, deadline);
      if (
        facts !== null &&
        !await this.options.authorizePolicy(this.policy, deadline, facts)
      ) return unavailable("workflow_billing_basis_unavailable");
      if (
        facts === null || facts.repositoryId !== target.repositoryId ||
        facts.qualificationDigest !== this.policy.ceilingQualification ||
        !/^[0-9a-f]{40}$/.test(facts.workflowBlob) ||
        !/^[A-Za-z0-9._-]{1,100}$/.test(facts.job)
      ) return unavailable("workflow_binding");
      if (!facts.triggered) {
        return facts.jobs === 0 && facts.effectState !== "unknown"
          ? { kind: "inactive" }
          : unavailable("trigger_binding");
      }
      if (
        facts.jobs !== 1 ||
        !["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"].includes(
          facts.runner,
        ) ||
        !Number.isSafeInteger(facts.timeoutMinutes) ||
        facts.timeoutMinutes < 1 ||
        facts.timeoutMinutes > target.ceilingMinutes ||
        facts.ceilingMinutes !== target.ceilingMinutes
      ) {
        return unavailable("unqualified_cost_bound");
      }
      const id = ciMinuteDigest({
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
          const previous = await this.options.store.read(period.previous);
          if (!previous.ok || previous.value.ledger === null) {
            return unavailable("bootstrap_required");
          }
          if (previous.value.head !== read.value.head) continue;
          const old = parseCiMinuteLedger(previous.value.ledger);
          if (old.policyDigest !== this.policyDigest) {
            return unavailable("policy_changed");
          }
          ledger = {
            version: 1,
            month: period.month,
            policyDigest: this.policyDigest,
            updatedAt: now,
            sequence: 0,
            baselineMinutes: 0,
            watermark: null,
            reservations: old.reservations.filter((r) =>
              !["settled", "confirmed_not_submitted"].includes(r.state)
            ),
            observed: [],
            progress: null,
            completedAttempts: [],
            proofs: [],
          };
        }
        ledger = parseCiMinuteLedger(ledger);
        if (
          ledger.policyDigest !== this.policyDigest ||
          ledger.month !== period.month
        ) return unavailable("policy_changed");
        if (now < ledger.updatedAt) {
          return held(ledger.updatedAt, "clock_regression");
        }
        const observation = await this.options.observe(
          period.month,
          deadline,
          ledger,
        );
        if (
          observation === null || observation.month !== period.month ||
          !Number.isSafeInteger(observation.watermark) ||
          observation.watermark < period.start ||
          observation.watermark > this.options.clock.now() ||
          (observation.observedAt !== undefined &&
            (!Number.isSafeInteger(observation.observedAt) ||
              observation.observedAt < observation.watermark ||
              observation.observedAt > this.options.clock.now()))
        ) {
          return unavailable("incomplete_reconciliation");
        }
        if (!observation.complete && !observation.progress) {
          return unavailable("incomplete_reconciliation");
        }
        const next = this.observe(ledger, observation, now);
        if (!observation.complete) {
          const saved = await this.save(read.value.head, next);
          if (saved === "conflict") continue;
          return saved === "applied"
            ? held(this.options.clock.now() + 300_000, "reconciliation")
            : unavailable("state_write");
        }
        if (
          next.reservations.some((r) => r.chargedMinutes > r.ceilingMinutes) ||
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
        const prior = next.reservations.find((r) => r.effectDigest === id);
        if (prior !== undefined) {
          if (
            prior.policyDigest !== this.policyDigest ||
            prior.ceilingMinutes !== facts.ceilingMinutes
          ) {
            return unavailable("reservation_identity");
          }
          if (facts.effectState === "applied") {
            const saved = await this.save(read.value.head, next);
            if (saved === "conflict") continue;
            return saved === "applied"
              ? this.grant("reconciled", id, deadline, period.month)
              : unavailable("state_write");
          }
          if (
            facts.effectState !== "not_applied" || prior.state === "settled" ||
            prior.state === "confirmed_not_submitted"
          ) return unavailable("effect_reconciliation");
          // Only authenticated proof of nonapplication permits the same effect again.
          const saved = await this.save(read.value.head, next);
          if (saved === "conflict") continue;
          return saved === "applied"
            ? this.grant("admitted", id, deadline, period.month)
            : unavailable("state_write");
        }
        if (facts.effectState !== "not_applied") {
          return unavailable("effect_reconciliation");
        }
        const managed = next.baselineMinutes +
          next.reservations.reduce((sum, r) => sum + r.chargedMinutes, 0);
        const accounted = new Set(next.reservations.map((r) => r.effectDigest));
        const unmanaged = next.observed.filter((j) =>
          j.effectDigest === null || !accounted.has(j.effectDigest)
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
        const needed = managed + facts.ceilingMinutes;
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
          effectDigest: id,
          policyDigest: this.policyDigest,
          ceilingMinutes: facts.ceilingMinutes,
          state: "reserved",
          createdAt: now,
          settledAt: null,
          chargedMinutes: facts.ceilingMinutes,
          proofDigest: null,
          binding: {
            effect: structuredClone(effect),
            repositoryId: facts.repositoryId,
            workflowBlob: facts.workflowBlob,
            job: facts.job,
          },
        });
        const saved = await this.save(read.value.head, next);
        if (saved === "conflict") continue;
        return saved === "applied"
          ? this.grant("admitted", id, deadline, period.month)
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
    for (const job of proof.jobs) {
      if (
        job.completedAt !== null &&
        job.completedAt > (proof.observedAt ?? proof.watermark)
      ) {
        throw new Error("CI job beyond watermark");
      }
      const minutes = ciJobMinutes(job);
      const oldProof = proofs.find((p) => p.digest === job.digest);
      if (oldProof !== undefined) {
        if (
          ciMinuteDigest(oldProof.identity ?? null) !==
            ciMinuteDigest(job.identity ?? null)
        ) throw new Error("CI billed proof identity changed");
        oldProof.billedDurationMs = job.billedDurationMs;
        if (oldProof.effectDigest === null && job.effectDigest !== null) {
          oldProof.effectDigest = job.effectDigest;
        }
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
          jobProof.startedAt !== null && jobProof.completedAt !== null &&
            ciMonth(jobProof.startedAt).month === ledger.month &&
            ciMonth(jobProof.completedAt).month === ledger.month);
      if (
        jobs.length === 1 && !periodKnown && reservation.state !== "settled"
      ) {
        reservation.chargedMinutes = Math.max(
          reservation.chargedMinutes,
          jobs[0].minutes,
        );
        continue;
      }
      if (jobs.length === 1 && reservation.state !== "settled") {
        reservation.state = "settled";
        reservation.chargedMinutes = jobs[0].minutes;
        reservation.settledAt = now;
        reservation.proofDigest = jobs[0].digest;
      }
      if (jobs.length === 1 && reservation.state === "settled") {
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
