/**
 * Pure producer bindings shared by the current-matrix history walk and its
 * producer pass. Nothing here reads a remote or writes state: the walk uses
 * these to refuse an inconsistent producer snapshot and to skip producers no
 * pending record can bind to before any custody read, and the producer pass
 * uses the same rules before it builds any matrix port.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../src/contracts/budget-reservation.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { HostedExecutionIntentV1 } from "../src/contracts/hosted-supervisor.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import type { MatrixArtifactRequestV1 } from "../src/host/matrix-artifact-port.ts";
import {
  blockedImplementationBinding,
  blockedRecoveryBinding,
  blockedRecoveryMatchesProducer,
} from "../src/host/matrix-blocked-candidate.ts";
import { implementationIntentKey } from "../src/repair/keys.ts";
import type { HostedAutonomyResultV1 } from "./hosted-autonomy-types.ts";

/**
 * A producer's custody snapshot must hold the pointer that ran its own proof:
 * an unscoped execution of exactly the active revision and generation.
 */
export function producerPointerConsistent(
  runtime: { activeRevision: GitSha; generation: number },
  execution: HostedExecutionIntentV1,
): boolean {
  return execution.releaseId === null &&
    runtime.activeRevision === execution.revision &&
    runtime.generation === execution.generation;
}

/**
 * Which records one producer pass may request: `all` is every record the
 * producer binds, `blocked` only the runtime-mismatch candidates whose
 * blocker names exactly this producer.
 */
export type HostedProducerScopeV1 = "all" | "blocked";

/**
 * True when at least one pending record could be requested from this exact
 * producer: an in-flight record is requested from every producer, a blocked
 * preserved candidate only from the exact producer its blocker names.
 */
export function producerWanted(
  pending: readonly WorkRecordV1[],
  execution: HostedExecutionIntentV1,
  excluded: ReadonlySet<string>,
): boolean {
  return pending.some((record) =>
    !excluded.has(record.intent?.requestId ?? "") &&
    (record.nextStep === "work" ||
      blockedRecoveryMatchesProducer(record, execution))
  );
}

/**
 * The exact charged request of every record this producer may settle. A
 * record whose intent and charge do not bind exactly is an integrity fault,
 * whichever repository it belongs to. The `blocked` scope keeps only the
 * parked candidates bound to exactly this producer, after every record has
 * passed the same binding refusal.
 */
export function producerRequests(
  snapshot: {
    work: readonly WorkRecordV1[];
    reservations: readonly BudgetReservationV1[];
  },
  execution: HostedExecutionIntentV1,
  dedicated: ReadonlySet<string>,
  fault: (message: string) => Error,
  scope: HostedProducerScopeV1 = "all",
): MatrixArtifactRequestV1[] {
  return snapshot.work.flatMap((record) => {
    const intent = record.intent;
    if (
      (record.nextStep !== "work" &&
        !blockedRecoveryMatchesProducer(record, execution)) ||
      !intent ||
      !["implementation", "candidate_preservation"].includes(intent.kind) ||
      dedicated.has(intent.requestId ?? "")
    ) return [];
    const charge = snapshot.reservations.find((row) =>
      row.id === intent.requestId
    );
    if (
      !charge || record.source.kind !== "issue" ||
      canonicalStringify(charge.repository) !==
        canonicalStringify(record.repository) ||
      charge.taskId !== record.id || charge.head !== record.target.base ||
      charge.attempt !== record.counters.attempts ||
      !["implementation", "retry"].includes(charge.purpose) ||
      charge.outcome === "confirmed_not_submitted" ||
      (blockedImplementationBinding(record) !== null &&
        (charge.purpose !== "retry" || charge.outcome !== "reserved" ||
          charge.settledAt !== null)) ||
      intent.key !== implementationIntentKey(charge.id) ||
      intent.observedBase !== record.target.base || intent.resultId !== null
    ) {
      throw fault("current matrix request binding unavailable");
    }
    if (
      scope === "blocked" && !blockedRecoveryMatchesProducer(record, execution)
    ) return [];
    return [{
      taskId: record.id,
      repository: record.repository,
      reservationId: charge.id,
      intentKey: intent.key,
      expectedBase: record.target.base,
      attempt: record.counters.attempts,
    }];
  });
}

/**
 * One producer pass outcome. `unrecoverable` names a producer whose plan
 * evidence can no longer be read (expired or unlisted): the skip writes
 * nothing, and its requested reservations must not be settled by any older
 * producer.
 * `mayHaveWritten` is false only when the pass never invoked its repair
 * writer and never deferred inside its consumer, so a deferral or skip then
 * provably left every record as it was.
 */
export interface HostedProducerRecoveryV1 {
  result: HostedAutonomyResultV1 | null;
  deferred: boolean;
  mayHaveWritten: boolean;
  unrecoverable?: {
    kind: "expired" | "unlisted";
    reservations: readonly string[];
  };
}

/** One producer run's exact plan artifact as the native listing reports it. */
export interface HostedPlanArtifactV1 {
  id: number;
  digest: string | null;
  expired: boolean;
}

/**
 * Why a producer's blocker-bound plan evidence can no longer be read, or null
 * when the authenticated transport must decide. Only a producer that a parked
 * preserved candidate's blocker names is judged here; a producer requested
 * only by in-flight work keeps the transport's own refusal. An unlisted plan,
 * or an expired one that still carries every bound artifact id (and the bound
 * archive digest whenever the listing still reports one), cannot be recovered
 * by anyone; a listed plan whose identity conflicts with a bound blocker is
 * left to the transport, which refuses it.
 */
export async function unrecoverablePlan(
  readPlan: () => Promise<HostedPlanArtifactV1 | null>,
  requests: readonly MatrixArtifactRequestV1[],
  work: readonly WorkRecordV1[],
): Promise<"expired" | "unlisted" | null> {
  const bindings = requests.flatMap((request) => {
    const record = work.find((row) =>
      row.id === request.taskId &&
      canonicalStringify(row.repository) ===
        canonicalStringify(request.repository)
    );
    const binding = record ? blockedRecoveryBinding(record) : null;
    return binding === null ? [] : [binding];
  });
  if (bindings.length === 0) return null;
  const plan = await readPlan();
  if (plan === null) return "unlisted";
  if (plan.expired === false) return null;
  return bindings.every((binding) =>
      binding.artifactId === plan.id &&
      (plan.digest === null || binding.archiveDigest === plan.digest)
    )
    ? "expired"
    : null;
}
