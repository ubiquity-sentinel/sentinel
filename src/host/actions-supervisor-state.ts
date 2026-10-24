/** Hosted actions-supervisor-state responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { parseHostedExecutionSettlementV1 } from "../contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
  HostedInstallationRecordV1,
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  PortErrorV1,
  PortResultV1,
  StateWriteResultV1,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { HOSTED_CONTROLLER_SELF } from "../contracts/hosted-controller-deployment.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { tryParse } from "../contracts/validation.ts";
import { emptyHostedVerification } from "../contracts/hosted-supervisor-verification.ts";
import { settleHostedInstallations } from "./actions-supervisor-installation-state.ts";
import type { QueueRuntimeCapability } from "./queue-runtime-capability.ts";
import type { ExistingPrRuntimeCapability } from "./existing-pr-runtime-capability.ts";
import type {
  HostedSupervisorInputV1,
  HostedSupervisorOutcomeV1,
  HostedSupervisorRunIdentityV1,
} from "./actions-supervisor-types.ts";
export type {
  HostedSupervisorEvidencePortV1,
  HostedSupervisorInputV1,
  HostedSupervisorOutcomeV1,
  HostedSupervisorRunIdentityV1,
} from "./actions-supervisor-types.ts";

// ---------------------------------------------------------------------------
// Deterministic hosted supervisor core: prepare and finalize.
//
// The protected workflow injects the exact current run identity and a bounded
// evidence port; this module owns only deterministic transitions over the
// existing release-role store. It never starts a model, never invokes the
// runtime (the protected job executes the returned intent) and never writes
// repair state. No credentials or environment are read here.
// ---------------------------------------------------------------------------

export const MAX_TRANSITIONS = 8;

export const SELF_REPOSITORY: RepositoryIdentityV1 = HOSTED_CONTROLLER_SELF;

export const STATIC_RUN = "hosted supervisor run identity is invalid";

export const STATIC_CONFLICT =
  "hosted supervisor state moved without the exact expected snapshot";

const STATIC_EVIDENCE = "hosted supervisor execution evidence is unavailable";

export const STATIC_EVIDENCE_BINDING =
  "hosted supervisor execution evidence does not bind the saved intent";

export const STATIC_SETTLEMENT_PENDING =
  "hosted supervisor execution settlement is not available";

export const STATIC_LAUNCHER =
  "hosted supervisor launcher revision is not verified";

export const STATIC_SOURCE = "hosted supervisor work source is unavailable";

export const STATIC_REQUEST =
  "hosted supervisor release request is not verified";

export const STATIC_REQUEST_ACTIVE =
  "hosted supervisor release request revision is already active";

export const STATIC_ACTIVE_RELEASE =
  "hosted supervisor has more than one active hosted release";

export const STATIC_BOOTSTRAP_RELEASE =
  "hosted release state exists without the initial runtime";

export const STATIC_BOUND = "hosted supervisor transition bound reached";

export const STATIC_REFUSED =
  "hosted supervisor refused an invalid state transition";

export const STATIC_IDLE_SETTLED = "the current run attempt is already settled";

export const STATIC_IDLE_WAITING =
  "the active hosted release is waiting for its exact execution";

export const STATIC_IDLE_NONE = "no eligible hosted supervisor work";

export interface SnapshotCursorV1 {
  snapshot: ReleaseStateSnapshotV1 | null;
  head: GitSha | null;
}

type SettlementReadV1 =
  | { ok: true; settlement: HostedExecutionSettlementV1 }
  | { ok: false; outcome: HostedSupervisorOutcomeV1 };

export function pending(detail: string): HostedSupervisorOutcomeV1 {
  return { status: "pending", detail };
}

export function idle(detail: string): HostedSupervisorOutcomeV1 {
  return { status: "idle", detail };
}

export function executionIdOfRun(run: HostedSupervisorRunIdentityV1): string {
  return `${run.runId}:${run.runAttempt}:repair`;
}

export function invalidRunIdentity(
  run: HostedSupervisorRunIdentityV1,
): boolean {
  return !Number.isSafeInteger(run.runId) || run.runId < 1 ||
    !Number.isSafeInteger(run.runAttempt) || run.runAttempt < 1 ||
    !isGitSha(run.launcherSha);
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function isTerminalPhase(
  phase: HostedReleaseRecordV1["phase"],
): boolean {
  return phase === "accepted" || phase === "rolled_back" ||
    phase === "owner_superseded" || phase === "abandoned";
}

export function isSettledCurrentRun(
  runtime: HostedRuntimeRecordV1,
  run: HostedSupervisorRunIdentityV1,
): boolean {
  const settled = runtime.lastExecutionProof;
  return settled !== null && settled.execution.runId === run.runId &&
    settled.execution.runAttempt === run.runAttempt;
}

export function sameRepository(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

export async function readCursor(
  input: HostedSupervisorInputV1,
): Promise<SnapshotCursorV1 | null> {
  try {
    const read = await input.state.readRelease();
    if (!read.ok) return null;
    if (read.value.status === "absent") return { snapshot: null, head: null };
    return { snapshot: read.value.snapshot, head: read.value.head };
  } catch {
    return null;
  }
}

/**
 * One CAS write of a normalized snapshot. A conflict/ambiguous response gets
 * exactly one authoritative reread; only the exact expected snapshot counts as
 * applied, so an unrelated newer state is never overwritten.
 */
export async function commitHosted(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1 | null,
  releases: readonly HostedReleaseRecordV1[],
  installations?: readonly HostedInstallationRecordV1[],
): Promise<"applied" | "pending"> {
  const now = input.clock.now();
  const base = cursor.snapshot;
  const candidate: ReleaseStateSnapshotV1 = base === null
    ? {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: now,
      releases: [],
      hostedRuntimes: runtime === null ? [] : [runtime],
      hostedReleases: [...releases].sort(byId),
      ...(installations === undefined
        ? {}
        : { hostedInstallations: [...installations].sort(byId) }),
      githubCooldowns: [],
    }
    : {
      ...base,
      releases: [...base.releases].sort(byId),
      sequence: base.sequence + 1,
      stateHead: cursor.head,
      updatedAt: now,
      hostedRuntimes: runtime === null ? [] : [runtime],
      hostedReleases: [...releases].sort(byId),
      ...(installations === undefined
        ? {}
        : { hostedInstallations: [...installations].sort(byId) }),
    };
  let parsed: ReleaseStateSnapshotV1;
  try {
    parsed = parseReleaseStateSnapshotV1(candidate);
  } catch {
    return "pending";
  }
  let written: PortResultV1<StateWriteResultV1> | null = null;
  try {
    written = await input.state.writeRelease(parsed, cursor.head);
  } catch {
    written = null;
  }
  if (written !== null && written.ok && written.value.status === "applied") {
    cursor.snapshot = parsed;
    cursor.head = written.value.head;
    return "applied";
  }
  try {
    const reread = await input.state.readRelease();
    if (
      reread.ok && reread.value.status === "found" &&
      canonicalStringify(reread.value.snapshot) === canonicalStringify(parsed)
    ) {
      cursor.snapshot = reread.value.snapshot;
      cursor.head = reread.value.head;
      return "applied";
    }
  } catch {
    // Fall through to pending; the caller never loops on retries.
  }
  return "pending";
}

/** Full parser + exact execution binding, even if the evidence port lies. */
export async function readSettlement(
  input: HostedSupervisorInputV1,
  savedIntent: HostedExecutionIntentV1,
): Promise<SettlementReadV1> {
  // The evidence read is idempotent and read-only, so a transport-shaped
  // failure is retried a bounded number of times inside this job: one flaky
  // HTTP window must never strand the pointer's saved execution (and with it
  // the whole lane) until a human intervenes. A refusal a retry cannot change
  // (auth, rate limit, invalid input) is reported immediately, and every
  // reported failure carries its CLOSED identity so the job output names the
  // cause instead of one static string.
  let failure = STATIC_EVIDENCE;
  for (let attempt = 1; attempt <= EVIDENCE_READ_ATTEMPTS; attempt++) {
    let result: PortResultV1<HostedExecutionSettlementV1 | null>;
    try {
      result = await input.evidence.readExecution(savedIntent);
    } catch {
      failure = `${STATIC_EVIDENCE} (thrown)`;
      if (attempt < EVIDENCE_READ_ATTEMPTS) {
        await pause(EVIDENCE_RETRY_PAUSE_MS);
        continue;
      }
      break;
    }
    if (!result.ok) {
      failure = evidenceFailureDetail(STATIC_EVIDENCE, result.error);
      if (
        attempt < EVIDENCE_READ_ATTEMPTS &&
        result.error.kind === "unavailable"
      ) {
        await pause(EVIDENCE_RETRY_PAUSE_MS);
        continue;
      }
      break;
    }
    if (result.value === null) {
      return { ok: false, outcome: pending(STATIC_SETTLEMENT_PENDING) };
    }
    const parsed = tryParse(parseHostedExecutionSettlementV1, result.value);
    if (!parsed.ok) {
      const issue = parsed.issues[0];
      return {
        ok: false,
        outcome: pending(
          `${STATIC_EVIDENCE_BINDING} (invalid settlement: ${
            issue?.code ?? "unknown"
          } at ${issue?.path ?? "?"})`,
        ),
      };
    }
    if (!sameCanonical(parsed.value.execution, savedIntent)) {
      return { ok: false, outcome: pending(STATIC_EVIDENCE_BINDING) };
    }
    return { ok: true, settlement: parsed.value };
  }
  return { ok: false, outcome: pending(failure) };
}

/** Bounded attempts of one read-only evidence read inside a single job. */
const EVIDENCE_READ_ATTEMPTS = 3;

const EVIDENCE_RETRY_PAUSE_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Closed, sanitized evidence-failure identity: the port's closed error kind
 * plus, only when the port itself supplied one of its own
 * `hosted execution ...` constants, that constant. Arbitrary upstream text (a
 * response body, a redirect URL or a credential) is never propagated into the
 * job output.
 */
function evidenceFailureDetail(base: string, error: PortErrorV1): string {
  const closed = /^hosted execution [a-z ]{1,64}$/.test(error.detail)
    ? `: ${error.detail}`
    : "";
  return `${base} (${error.kind}${closed})`;
}

export function sameCanonical(a: unknown, b: unknown): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

/**
 * Attach one settlement to its release slot in the SAME write that clears the
 * execution. Failed prior/rollback and not_started settlements leave the
 * healthy-only slots and the phase unchanged.
 */
function attachReleaseSettlement(
  releases: readonly HostedReleaseRecordV1[],
  settlement: HostedExecutionSettlementV1,
  now: number,
): HostedReleaseRecordV1[] {
  const releaseId = settlement.execution.releaseId;
  if (releaseId === null) return [...releases];
  let record = releases.find((item) => item.id === releaseId);
  if (record === undefined) return [...releases];
  let next = record;
  const purpose = settlement.execution.purpose;
  if (purpose === "prior" || purpose === "candidate") {
    const journal = record.verification?.[purpose];
    if (
      journal?.executionIds.includes(settlement.execution.id) &&
      !journal.settledExecutionIds.includes(settlement.execution.id)
    ) {
      const value = {
        ...journal,
        settledExecutionIds: [
          ...journal.settledExecutionIds,
          settlement.execution.id,
        ],
        failures: journal.failures + (settlement.outcome === "healthy" ? 0 : 1),
        lastFailure: settlement.outcome === "healthy" ? journal.lastFailure : {
          proof: settlement,
          reason: settlement.outcome === "failed"
            ? "execution_failed" as const
            : "not_started" as const,
        },
      };
      record = {
        ...record,
        verification: {
          prior: record.verification?.prior ?? emptyHostedVerification(),
          candidate: record.verification?.candidate ??
            emptyHostedVerification(),
          [purpose]: value,
        },
        updatedAt: now,
      };
      next = record;
    }
  }
  if (purpose === "prior") {
    if (
      record.phase === "requested" && record.priorProof === null &&
      settlement.outcome === "healthy"
    ) {
      next = {
        ...record,
        priorProof: settlement,
        updatedAt: now,
      };
    } else if (record.verification?.prior.failures === 2) {
      next = {
        ...record,
        phase: "abandoned",
        abandonment: {
          reason: "prior_verification_exhausted",
          fromPhase: "requested",
          executionIds: record.verification.prior.executionIds,
          recordedAt: now,
        },
        updatedAt: now,
      };
    }
  } else if (purpose === "candidate") {
    if (record.phase === "verifying" && record.candidateProof === null) {
      if (settlement.outcome === "healthy") {
        next = {
          ...record,
          phase: "accepted",
          candidateProof: settlement,
          updatedAt: now,
        };
      } else if (settlement.outcome === "failed") {
        next = {
          ...record,
          phase: "rollback_pending",
          candidateProof: settlement,
          updatedAt: now,
        };
      } else if (record.verification?.candidate.failures === 2) {
        next = { ...record, phase: "rollback_pending", updatedAt: now };
      }
    }
  } else if (purpose === "rollback") {
    if (
      record.phase === "rollback_verifying" && record.rollbackProof === null &&
      settlement.outcome === "healthy"
    ) {
      next = {
        ...record,
        phase: "abandoned",
        rollbackProof: settlement,
        abandonment: {
          reason: record.candidateProof?.outcome === "failed"
            ? "candidate_verification_failed"
            : "candidate_verification_exhausted",
          fromPhase: "rollback_verifying",
          executionIds: record.verification?.candidate.executionIds ??
            (record.candidateProof ? [record.candidateProof.execution.id] : []),
          recordedAt: now,
        },
        updatedAt: now,
      };
    }
  }
  if (next === releases.find((item) => item.id === releaseId)) {
    return [...releases];
  }
  return releases.map((item) => item.id === record.id ? next : item);
}

/** Clear the saved execution, save its exact settlement and update health. */
export function settleRuntime(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  settlement: HostedExecutionSettlementV1,
): Promise<"applied" | "pending"> {
  const now = input.clock.now();
  // An exact ordinary no-execution settlement restores due eligibility at the
  // observation time so a later workflow can retry; no budget is touched.
  const ordinaryNotStarted = settlement.outcome === "not_started" &&
    settlement.execution.purpose === "ordinary";
  const verification = settlement.execution.purpose !== "ordinary";
  const failureIds = [...(runtime.failedVerificationIds ?? [])];
  if (
    verification && settlement.outcome === "failed" && failureIds.length < 2 &&
    !failureIds.includes(settlement.execution.id)
  ) failureIds.push(settlement.execution.id);
  const installations = settleHostedInstallations(
    cursor.snapshot?.hostedInstallations ?? [],
    settlement,
    now,
  );
  const installationSettlement = installations.some((i) =>
    i.bootstrapProof?.execution.id === settlement.execution.id ||
    i.retriedBootstrapProof?.execution.id === settlement.execution.id ||
    i.rollbackProof?.execution.id === settlement.execution.id
  );
  const runtimeNext: HostedRuntimeRecordV1 = {
    ...runtime,
    execution: null,
    lastExecutionProof: settlement,
    lastHealthyProof: settlement.outcome === "healthy"
      ? settlement
      : runtime.lastHealthyProof,
    nextOrdinaryAt: ordinaryNotStarted
      ? settlement.observedAt
      : runtime.nextOrdinaryAt,
    updatedAt: now,
    ...(verification
      ? {
        verificationFailures: failureIds.length,
        failedVerificationIds: failureIds,
        lastVerificationId: settlement.execution.id,
      }
      : {}),
    ...(settlement.execution.purpose === "rollback" || installationSettlement
      ? { verificationBlocked: settlement.outcome !== "healthy" }
      : {}),
  };
  const releasesNext = attachReleaseSettlement(
    releases,
    settlement,
    now,
  );
  return commitHosted(
    input,
    cursor,
    runtimeNext,
    releasesNext,
    installations.length > 0 ? installations : undefined,
  );
}

/** Consume a persisted pointer intent atomically (no execution in this CAS). */
export function planPointerRecovery(
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  now: number,
  _capability?: QueueRuntimeCapability,
  _custodyCapability?: ExistingPrRuntimeCapability,
): {
  runtime: HostedRuntimeRecordV1;
  releases: HostedReleaseRecordV1[];
} | null {
  if (runtime.execution !== null) return null;
  const record = releases.find((item) =>
    (item.phase === "promoting" || item.phase === "rollback_pending") &&
    item.pointerIntent !== null
  );
  if (record === undefined || record.pointerIntent === null) return null;
  const intent = record.pointerIntent;
  if (
    runtime.activeRevision !== intent.expectedRevision ||
    runtime.generation !== intent.expectedGeneration
  ) {
    return null;
  }
  const phase = record.phase === "promoting"
    ? "verifying"
    : "rollback_verifying";
  return {
    runtime: {
      ...runtime,
      activeRevision: intent.nextRevision,
      generation: runtime.generation + 1,
      updatedAt: now,
      verificationFailures: 0,
      failedVerificationIds: [],
      lastVerificationId: null,
    },
    releases: releases.map((item) =>
      item.id === record.id
        ? { ...item, phase, pointerIntent: null, updatedAt: now }
        : item
    ),
  };
}
