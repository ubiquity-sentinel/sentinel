/** Hosted actions-supervisor-source responsibility. */
import type { GitSha } from "../contracts/brands.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedReleaseRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
  HostedPointerIntentV1,
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type { PortResultV1, StateReadResultV1 } from "../contracts/ports.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type { ReviewTaskStatementV1 } from "../contracts/review-receipt.ts";
import { reviewAuthorizesMerge } from "../repair/review-gate.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { tryParse } from "../contracts/validation.ts";
import {
  commitHosted,
  executionIdOfRun,
  idle,
  isSettledCurrentRun,
  pending,
  readSettlement,
  sameCanonical,
  sameRepository,
  SELF_REPOSITORY,
  settleRuntime,
  STATIC_CONFLICT,
  STATIC_IDLE_SETTLED,
  STATIC_REFUSED,
  STATIC_REQUEST,
  STATIC_REQUEST_ACTIVE,
  STATIC_SOURCE,
} from "./actions-supervisor-state.ts";
import {
  emptyHostedVerification,
  hostedOrdinaryAdmissionMode,
} from "../contracts/hosted-supervisor-verification.ts";
import type {
  HostedSupervisorInputV1,
  HostedSupervisorOutcomeV1,
  SnapshotCursorV1,
} from "./actions-supervisor-state.ts";
import { HOSTED_SUPERVISOR_REVIEWER } from "./actions-supervisor-bootstrap.ts";

export async function startExecution(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  purpose: HostedExecutionIntentV1["purpose"],
  revision: GitSha,
  releaseId: string | null,
  nextOrdinaryAt?: number,
): Promise<HostedSupervisorOutcomeV1> {
  if (isSettledCurrentRun(runtime, input.run)) {
    return idle(STATIC_IDLE_SETTLED);
  }
  const now = input.clock.now();
  const parsed = tryParse(parseHostedExecutionIntentV1, {
    id: executionIdOfRun(input.run),
    runId: input.run.runId,
    runAttempt: input.run.runAttempt,
    launcherSha: input.run.launcherSha,
    purpose,
    revision,
    generation: runtime.generation,
    releaseId,
    createdAt: now,
  });
  if (!parsed.ok) return pending(STATIC_REFUSED);
  const mode = purpose === "ordinary"
    ? hostedOrdinaryAdmissionMode(runtime)
    : null;
  if (purpose === "ordinary" && mode === null) {
    return pending("ordinary runtime admission is unavailable");
  }
  const releasesNext = releases.map((record) => {
    if (
      record.id !== releaseId ||
      (purpose !== "prior" && purpose !== "candidate")
    ) return record;
    const journal = record.verification?.[purpose] ?? emptyHostedVerification();
    if (journal.attempts >= 2) return record;
    return {
      ...record,
      verification: {
        prior: record.verification?.prior ?? emptyHostedVerification(),
        candidate: record.verification?.candidate ?? emptyHostedVerification(),
        [purpose]: {
          ...journal,
          attempts: journal.attempts + 1,
          lastExecutionId: parsed.value.id,
          executionIds: [...journal.executionIds, parsed.value.id],
        },
      },
      updatedAt: now,
    };
  });
  if (
    (purpose === "prior" || purpose === "candidate") &&
    releasesNext.find((r) => r.id === releaseId)?.verification?.[purpose]
        .lastExecutionId !== parsed.value.id
  ) return pending("release verification budget exhausted");
  const runtimeNext: HostedRuntimeRecordV1 = {
    ...runtime,
    execution: parsed.value,
    nextOrdinaryAt: nextOrdinaryAt ?? runtime.nextOrdinaryAt,
    updatedAt: now,
    lastTurn: purpose === "ordinary" ? "ordinary" : "verification",
    ...(mode === null ? {} : {
      ordinaryAdmission: {
        mode,
        executionId: parsed.value.id,
        revision,
        generation: runtime.generation,
        failedVerificationIds: runtime.failedVerificationIds ?? [],
      },
    }),
  };
  const applied = await commitHosted(input, cursor, runtimeNext, releasesNext);
  if (applied !== "applied") return pending(STATIC_CONFLICT);
  return { status: "run", execution: parsed.value };
}

export async function planReleaseWork(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  release: HostedReleaseRecordV1,
): Promise<HostedSupervisorOutcomeV1 | "written" | null> {
  const now = input.clock.now();
  if (release.phase === "requested" && release.priorProof !== null) {
    const authorized = await authorizePromotionSource(input, release);
    if (!authorized.ok) return pending(authorized.detail);
    const next: HostedReleaseRecordV1 = {
      ...release,
      phase: "promoting",
      pointerIntent: {
        action: "promote",
        expectedRevision: release.priorRevision,
        nextRevision: release.request.revision,
        expectedGeneration: runtime.generation,
        createdAt: now,
      },
      updatedAt: now,
    };
    return await commitHosted(
        input,
        cursor,
        runtime,
        releases.map((r) => r.id === release.id ? next : r),
      ) === "applied"
      ? "written"
      : pending(STATIC_CONFLICT);
  }
  if (release.phase === "requested" && release.priorProof === null) {
    return await startExecution(
      input,
      cursor,
      runtime,
      releases,
      "prior",
      release.priorRevision,
      release.id,
    );
  }
  if (release.phase === "verifying" && release.candidateProof === null) {
    return await startExecution(
      input,
      cursor,
      runtime,
      releases,
      "candidate",
      release.request.revision,
      release.id,
    );
  }
  if (release.phase === "rollback_pending" && release.pointerIntent === null) {
    const intent: HostedPointerIntentV1 = {
      action: "rollback",
      expectedRevision: release.request.revision,
      nextRevision: release.priorRevision,
      expectedGeneration: runtime.generation,
      createdAt: now,
    };
    const next = { ...release, pointerIntent: intent, updatedAt: now };
    const applied = await commitHosted(
      input,
      cursor,
      runtime,
      releases.map((item) => item.id === release.id ? next : item),
    );
    return applied === "applied" ? "written" : pending(STATIC_CONFLICT);
  }
  if (
    release.phase === "rollback_verifying" && release.rollbackProof === null
  ) {
    return await startExecution(
      input,
      cursor,
      runtime,
      releases,
      "rollback",
      release.priorRevision,
      release.id,
    );
  }
  return null;
}

function isSelfOpenRequest(request: ReleaseRequestV1): boolean {
  return request.status === "open" &&
    request.target.environment === "production" &&
    sameRepository(request.target.repository, SELF_REPOSITORY);
}

/**
 * The exact receipt the request references, bound to the request's own
 * repository/PR/head/base identity. This is an identity lookup only: the shared
 * semantic predicate in `reviewAuthorizes` decides whether it authorizes.
 */
function boundReceipt(
  snapshot: RepairStateSnapshotV1,
  request: ReleaseRequestV1,
): RepairStateSnapshotV1["reviews"][number] | null {
  const receiptId = request.source.reviewReceiptId;
  if (receiptId === null) return null;
  const found = snapshot.reviews.find((review) =>
    review.id === receiptId &&
    review.requestId === request.source.reviewRequestId &&
    sameRepository(review.repository, request.target.repository) &&
    review.pullRequest.number === request.source.pullRequest &&
    review.pullRequest.head === request.source.head &&
    review.pullRequest.base === request.source.base
  );
  return found ?? null;
}

/**
 * The exact existing WorkRecord that published the request: same repository and
 * the same PR/head/base. Its own `related.issueNumber` is the only task identity
 * the trusted live read may be bound to; a request without that record has no
 * provable task context and never authorizes a release.
 */
function boundWorkRecord(
  snapshot: RepairStateSnapshotV1,
  request: ReleaseRequestV1,
): RepairStateSnapshotV1["work"][number] | null {
  const found = snapshot.work.find((record) =>
    sameRepository(record.repository, request.target.repository) &&
    record.target.pr === request.source.pullRequest &&
    record.target.head === request.source.head &&
    record.target.base === request.source.base
  );
  return found ?? null;
}

/**
 * The trusted live task statement for one record, read through the evidence
 * port immediately before the authorization it feeds. A record without a
 * source issue keeps the existing change-only contract (null); an unavailable
 * port, transport failure or unreadable/over-bound statement is
 * `"unavailable"`, which never authorizes issue-backed work.
 */
async function trustedTask(
  input: HostedSupervisorInputV1,
  record: RepairStateSnapshotV1["work"][number],
): Promise<ReviewTaskStatementV1 | null | "unavailable"> {
  const issueNumber = record.related.issueNumber;
  if (issueNumber === null) return null;
  const evidence = input.evidence;
  if (evidence.readIssueTask === undefined) return "unavailable";
  try {
    // Called on the port itself: a detached reference loses the receiver and
    // turns every legal port into an unavailable read.
    const result = await evidence.readIssueTask(issueNumber);
    if (!result.ok || result.value === null) return "unavailable";
    return result.value;
  } catch {
    return "unavailable";
  }
}

/**
 * The one release authorization, shared with the maintenance consumer through
 * `src/repair/review-gate.ts`: the exact referenced receipt must bind this
 * request's identity and the record's exact publication AND carry a positive
 * task acceptance bound to the trusted live source-issue statement read
 * immediately before this check. A legacy quality-only receipt, a
 * wrong-task/wrong-issue acceptance, a not-fulfilled, uncertain or
 * already-satisfied base verdict and an unreadable task context all refuse.
 */
async function reviewAuthorizes(
  input: HostedSupervisorInputV1,
  snapshot: RepairStateSnapshotV1,
  request: ReleaseRequestV1,
): Promise<boolean> {
  const receipt = boundReceipt(snapshot, request);
  const record = boundWorkRecord(snapshot, request);
  if (receipt === null || record === null) return false;
  return reviewAuthorizesMerge(
    receipt,
    record,
    HOSTED_SUPERVISOR_REVIEWER,
    await trustedTask(input, record),
  );
}

export async function selectSourceRequest(
  input: HostedSupervisorInputV1,
  releases: readonly HostedReleaseRecordV1[],
  runtime: HostedRuntimeRecordV1,
): Promise<
  | { kind: "none" }
  | { kind: "found"; request: ReleaseRequestV1 }
  | { kind: "pending"; detail: string }
> {
  let read: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>;
  try {
    read = await input.state.readRepair();
  } catch {
    return { kind: "pending", detail: STATIC_SOURCE };
  }
  if (!read.ok) return { kind: "pending", detail: STATIC_SOURCE };
  if (read.value.status !== "found") return { kind: "none" };
  const snapshot = read.value.snapshot;
  const recorded = new Set(releases.map((item) => item.id));
  const eligible = snapshot.releaseRequests
    .filter((request) =>
      !recorded.has(request.id) && isSelfOpenRequest(request)
    )
    .sort((a, b) =>
      a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  for (const request of eligible) {
    if (!(await reviewAuthorizes(input, snapshot, request))) continue;
    if (request.revision === runtime.activeRevision) {
      return { kind: "pending", detail: STATIC_REQUEST_ACTIVE };
    }
    let verified: PortResultV1<boolean>;
    try {
      verified = await input.evidence.verifyRequest(request);
    } catch {
      return { kind: "pending", detail: STATIC_REQUEST };
    }
    if (!verified.ok || !verified.value) {
      return { kind: "pending", detail: STATIC_REQUEST };
    }
    // The source verifier has settled, so the trusted live task statement is
    // read again now: this FINAL semantic authorization is the last read
    // before the requested receipt is created, and text that drifted while the
    // verifier ran changes the task and never selects the release.
    if (!(await reviewAuthorizes(input, snapshot, request))) continue;
    return { kind: "found", request };
  }
  return { kind: "none" };
}

export function buildRequestedReceipt(
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  now: number,
): HostedReleaseRecordV1 | null {
  const parsed = tryParse(parseHostedReleaseRecordV1, {
    version: "v1",
    kind: "hosted_release",
    id: request.id,
    request,
    priorRevision,
    phase: "requested",
    priorProof: null,
    candidateProof: null,
    rollbackProof: null,
    pointerIntent: null,
    createdAt: now,
    updatedAt: now,
  });
  return parsed.ok ? parsed.value : null;
}

/**
 * Ordinary work uses current health or durable degraded admission, regardless of
 * unrelated pending releases. A persisted
 * `nextOrdinaryAt` is retained as schema/identity bookkeeping only and never
 * throttles admission: provider and platform limits govern scheduling, while
 * the active-execution and same-run guards still prevent a second execution.
 */
export function ordinaryDue(
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
): boolean {
  if (
    releases.some((r) =>
      r.phase === "rollback_pending" || r.phase === "rollback_verifying"
    )
  ) return false;
  return hostedOrdinaryAdmissionMode(runtime) !== null;
}

/** One model-disabled recovery of the fixed old-controller ordinary failure. */
export function samePointerRecovery(
  runtime: HostedRuntimeRecordV1,
): "ordinary" | "verify" | "refused" {
  const revision = "c79b2b87a6a2dd0adc201895af10806ef7a9c600";
  const latest = runtime.lastExecutionProof;
  if (runtime.activeRevision !== revision || runtime.generation !== 59) {
    return latest?.execution.revision === revision &&
        latest.execution.generation === 59 && latest.outcome !== "healthy"
      ? "refused"
      : "ordinary";
  }
  const healthy = runtime.lastHealthyProof;
  if (latest?.outcome === "healthy") {
    return healthy !== null && latest.execution.revision === revision &&
        latest.execution.generation === 59 && sameCanonical(latest, healthy)
      ? "ordinary"
      : "refused";
  }
  if (
    healthy === null || healthy.execution.revision !== revision ||
    healthy.execution.generation !== 59 ||
    healthy.execution.id !== "37134515396:1:repair" ||
    healthy.execution.launcherSha !==
      "bf1d0300f9634feb6541f2d7e96cbfe4bba7dfe0" ||
    healthy.logDigest !==
      "c031f4a39f3eac1ff64c8f6bce28eb733ff4dfe1ea5d813dcfb31d08ffce1cf3" ||
    latest === null ||
    (latest.outcome !== "not_started" &&
      (latest.outcome !== "failed" || latest.startupReady ||
        latest.baseSha !== null)) ||
    latest.execution.launcherSha !==
      "6468457a7b293ec489b6e00fa9fef062f7914abe" ||
    latest.execution.revision !== revision ||
    latest.execution.generation !== 59 ||
    latest.execution.purpose !== "ordinary" ||
    latest.execution.releaseId !== null ||
    latest.execution.createdAt < healthy.finishedAt ||
    latest.observedAt < healthy.observedAt
  ) return "refused";
  return "verify";
}

export async function authenticateSamePointerRecovery(
  input: HostedSupervisorInputV1,
  runtime: HostedRuntimeRecordV1,
): Promise<boolean> {
  const latest = runtime.lastExecutionProof;
  const completed = input.evidence.confirmCompletedExecution;
  if (latest === null || completed === undefined) return false;
  try {
    if (await completed.call(input.evidence, latest.execution) !== true) {
      return false;
    }
    const fresh = await readSettlement(input, latest.execution);
    return fresh.ok && fresh.settlement.observedAt >= latest.observedAt &&
      fresh.settlement.observedAt <= input.clock.now() &&
      sameCanonical(
        { ...fresh.settlement, observedAt: latest.observedAt },
        latest,
      );
  } catch {
    return false;
  }
}

/**
 * Promotion-source preflight before a healthy prior settlement may persist the
 * promote intent: the reread repair request must canonical-equal the frozen
 * hosted release request and be accepted by the source verifier, and only then
 * is the review binding re-applied to the freshly read live task statement, so
 * the final semantic authorization is the last read before the pointer
 * mutation. Failure/unavailability changes nothing.
 */
export async function authorizePromotionSource(
  input: HostedSupervisorInputV1,
  record: HostedReleaseRecordV1,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  let read: PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>;
  try {
    read = await input.state.readRepair();
  } catch {
    return { ok: false, detail: STATIC_SOURCE };
  }
  if (!read.ok) return { ok: false, detail: STATIC_SOURCE };
  if (read.value.status !== "found") {
    return { ok: false, detail: STATIC_SOURCE };
  }
  const snapshot = read.value.snapshot;
  const frozen = record.request;
  const request = snapshot.releaseRequests.find((item) =>
    item.id === frozen.id
  );
  if (
    request === undefined || !sameCanonical(request, frozen) ||
    !isSelfOpenRequest(request)
  ) {
    return { ok: false, detail: STATIC_REQUEST };
  }
  // The source verifier settles FIRST: the trusted live task statement is read
  // only after it, so the FINAL semantic authorization below is the last read
  // before the caller's pointer mutation. Text that drifted while the verifier
  // ran changes the task and never promotes.
  let verified: PortResultV1<boolean>;
  try {
    verified = await input.evidence.verifyRequest(request);
  } catch {
    return { ok: false, detail: STATIC_REQUEST };
  }
  if (!verified.ok || !verified.value) {
    return { ok: false, detail: STATIC_REQUEST };
  }
  if (!(await reviewAuthorizes(input, snapshot, request))) {
    return { ok: false, detail: STATIC_REQUEST };
  }
  return { ok: true };
}

export async function settleWithPreflight(
  input: HostedSupervisorInputV1,
  cursor: SnapshotCursorV1,
  runtime: HostedRuntimeRecordV1,
  releases: readonly HostedReleaseRecordV1[],
  settlement: HostedExecutionSettlementV1,
): Promise<"applied" | "pending" | { refused: string }> {
  // Settlement must never depend on release-local source availability. Source
  // authorization happens separately before persisting and consuming promotion.
  const applied = await settleRuntime(
    input,
    cursor,
    runtime,
    releases,
    settlement,
  );
  return applied;
}
