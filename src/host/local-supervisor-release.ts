import type { GitSha } from "../contracts/brands.ts";
import type { Clock } from "../contracts/ports.ts";
import type {
  LocalReleaseReceiptV1,
  LocalRunProofV1,
} from "../contracts/local-release.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import {
  compareAndSetLocalActiveRuntime,
  writeLocalReleaseReceipt,
} from "./local-release.ts";
import {
  DETAIL_ALREADY_ACTIVE,
  DETAIL_POINTER_CHANGED,
  DETAIL_PROOF_INVALID,
  DETAIL_RECEIPT_WRITE,
  DETAIL_STATUS_STALE,
  isHealthyOutcome,
  type KnownInvocationsV1,
  type LocalSupervisorInputV1,
  type LocalSupervisorResultV1,
} from "./local-supervisor-shared.ts";
import { runAndVerify } from "./local-supervisor-observation.ts";
import { stageRuntime } from "./local-supervisor-runtime.ts";

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

export async function promote(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  priorProof: LocalRunProofV1,
  known: KnownInvocationsV1,
): Promise<LocalSupervisorResultV1> {
  if (request.revision === priorRevision) {
    // The requested revision is already the active runtime, so there is no
    // distinct prior revision an activation receipt could record. Acceptance
    // is never inferred from the pointer: refuse without writing a receipt and
    // without any child run or pointer change.
    return { status: "failed", detail: DETAIL_ALREADY_ACTIVE };
  }
  return await installAndActivate(
    input,
    clock,
    request,
    priorRevision,
    priorProof,
    null,
    known,
  );
}

export async function installAndActivate(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  priorProof: LocalRunProofV1,
  resumedCreatedAt: number | null,
  known: KnownInvocationsV1,
): Promise<LocalSupervisorResultV1> {
  const staged = await stageRuntime(input, request.revision);
  if (!staged.ok) return { status: "failed", detail: staged.detail };

  const now = clock.now();
  // The creation timestamp is written exactly once, by the first install. A
  // resumed install keeps the original immutable value so every later phase
  // (and the consumer's freshness check) rests on the same creation time.
  const installing = buildReceipt(
    request,
    priorRevision,
    "installing",
    null,
    priorProof,
    resumedCreatedAt === null ? now : resumedCreatedAt,
    now,
  );
  // The installing receipt (exact prior healthy proof + candidate identity) is
  // durable BEFORE any pointer change.
  if (!await persistReceipt(input.stateRoot, installing)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }

  const set = await compareAndSetLocalActiveRuntime(
    input.stateRoot,
    priorRevision,
    request.revision,
  );
  if (set !== "applied") {
    return await failReceipt(input, clock, installing, DETAIL_POINTER_CHANGED);
  }
  const verifying = buildReceipt(
    request,
    priorRevision,
    "verifying",
    null,
    priorProof,
    installing.createdAt,
    clock.now(),
  );
  if (!await persistReceipt(input.stateRoot, verifying)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }
  return await verifyCandidate(
    input,
    clock,
    request,
    priorRevision,
    priorProof,
    installing.createdAt,
    known,
  );
}

export async function verifyCandidate(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  priorProof: LocalRunProofV1 | null,
  createdAt: number,
  known: KnownInvocationsV1,
): Promise<LocalSupervisorResultV1> {
  if (priorProof === null) {
    return { status: "pending", detail: DETAIL_STATUS_STALE };
  }
  const run = await runAndVerify(input, clock, request.revision, known);
  if (run.kind === "proof") {
    // runAndVerify only returns kind proof for a settled, exactly bound run
    // whose repair state was available; the explicit healthy check below still
    // gates acceptance so an injected or unhealthy proof can never reach it.
    if (!isHealthyOutcome(run.proof.outcome)) {
      return { status: "failed", detail: DETAIL_PROOF_INVALID };
    }
    return await acceptCandidate(
      input,
      clock,
      request,
      priorProof,
      run.proof,
      createdAt,
    );
  }
  if (run.kind === "failed") {
    return await restorePrior(
      input,
      clock,
      request,
      priorRevision,
      priorProof,
      createdAt,
      run.proof,
      known,
    );
  }
  return { status: "pending", detail: run.detail };
}

async function acceptCandidate(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorProof: LocalRunProofV1,
  candidateProof: LocalRunProofV1,
  createdAt: number,
): Promise<LocalSupervisorResultV1> {
  const accepted = buildReceipt(
    request,
    priorProof.controllerSha,
    "accepted",
    candidateProof,
    priorProof,
    // The receipt keeps the original creation time: the observed candidate
    // proof must start at/after it.
    createdAt,
    clock.now(),
  );
  if (!await persistReceipt(input.stateRoot, accepted)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }
  return {
    status: "accepted",
    requestId: request.id,
    revision: request.revision,
    priorRevision: priorProof.controllerSha,
  };
}

export async function restorePrior(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  priorProof: LocalRunProofV1 | null,
  createdAt: number,
  failureProof: LocalRunProofV1 | null,
  known: KnownInvocationsV1,
  /** True when the pointer was already observed at the exact prior revision. */
  alreadyPrior = false,
): Promise<LocalSupervisorResultV1> {
  if (priorProof === null) {
    return { status: "pending", detail: DETAIL_STATUS_STALE };
  }
  const now = clock.now();
  const rollbackPending = buildReceipt(
    request,
    priorRevision,
    "rollback_pending",
    failureProof,
    priorProof,
    // The rollback keeps the original immutable creation time; the baseline
    // prior proof is never rewritten into a fresher-looking receipt.
    createdAt,
    now,
  );
  // rollback_pending is durable BEFORE the pointer is restored.
  if (!await persistReceipt(input.stateRoot, rollbackPending)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }
  // The pointer is only ever moved under the supervisor lock with an exact
  // compare immediately before the write. When the pointer already equals the
  // prior, the same-revision compare still refuses an unrelated concurrent
  // pointer without repeating the candidate-to-prior swap.
  const set = await compareAndSetLocalActiveRuntime(
    input.stateRoot,
    alreadyPrior ? priorRevision : request.revision,
    priorRevision,
  );
  if (set !== "applied") {
    return await failReceipt(
      input,
      clock,
      rollbackPending,
      DETAIL_POINTER_CHANGED,
    );
  }
  return await finishRollback(
    input,
    clock,
    request,
    priorRevision,
    priorProof,
    failureProof,
    createdAt,
    known,
  );
}

export async function finishRollback(
  input: LocalSupervisorInputV1,
  clock: Clock,
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  priorProof: LocalRunProofV1 | null,
  failureProof: LocalRunProofV1 | null,
  createdAt: number,
  known: KnownInvocationsV1,
): Promise<LocalSupervisorResultV1> {
  if (priorProof === null) {
    return { status: "pending", detail: DETAIL_STATUS_STALE };
  }
  const run = await runAndVerify(input, clock, priorRevision, known);
  if (run.kind === "pending") {
    // No objective failure was observed (no settlement, no receipt, an
    // unreadable or out-of-window proof). The durable rollback_pending
    // receipt is left exactly in place so a later pass repeats the exact
    // prior restore with a fresh run. Pending is never terminal failure.
    return { status: "pending", detail: run.detail };
  }
  if (run.kind === "failed") {
    // Only an observed objective failure of the restore run may write the
    // terminal failed receipt. The failure proof of the candidate is kept;
    // the failed prior run itself is not a candidate proof.
    const failed = buildReceipt(
      request,
      priorRevision,
      "failed",
      failureProof,
      priorProof,
      createdAt,
      clock.now(),
    );
    if (!await persistReceipt(input.stateRoot, failed)) {
      return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
    }
    return { status: "failed", detail: run.detail };
  }
  if (!isHealthyOutcome(run.proof.outcome)) {
    return { status: "failed", detail: DETAIL_PROOF_INVALID };
  }
  const rolledBack = buildReceipt(
    request,
    priorRevision,
    "rolled_back",
    failureProof,
    run.proof,
    // The receipt keeps its original creation time: the fresh prior proof
    // that proves the rollback must start at/after it.
    createdAt,
    clock.now(),
  );
  if (!await persistReceipt(input.stateRoot, rolledBack)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }
  return {
    status: "rolled_back",
    requestId: request.id,
    revision: request.revision,
    priorRevision,
  };
}

export async function failReceipt(
  input: LocalSupervisorInputV1,
  clock: Clock,
  receipt: LocalReleaseReceiptV1,
  detail: string,
): Promise<LocalSupervisorResultV1> {
  const failed = {
    ...receipt,
    phase: "failed" as const,
    updatedAt: clock.now(),
  };
  if (!await persistReceipt(input.stateRoot, failed)) {
    return { status: "failed", detail: DETAIL_RECEIPT_WRITE };
  }
  return { status: "failed", detail };
}

function buildReceipt(
  request: ReleaseRequestV1,
  priorRevision: GitSha,
  phase: LocalReleaseReceiptV1["phase"],
  candidateProof: LocalRunProofV1 | null,
  priorProof: LocalRunProofV1 | null,
  createdAt: number,
  updatedAt: number,
): LocalReleaseReceiptV1 {
  return {
    version: "v1",
    kind: "local_release_receipt",
    request,
    priorRevision,
    phase,
    candidateProof,
    priorProof,
    createdAt,
    updatedAt: updatedAt < createdAt ? createdAt : updatedAt,
  };
}

async function persistReceipt(
  stateRoot: string,
  receipt: LocalReleaseReceiptV1,
): Promise<boolean> {
  try {
    await writeLocalReleaseReceipt(stateRoot, receipt);
    return true;
  } catch {
    return false;
  }
}
