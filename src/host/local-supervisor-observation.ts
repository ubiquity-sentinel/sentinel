import type { GitSha } from "../contracts/brands.ts";
import type { Clock } from "../contracts/ports.ts";
import type { LocalRunProofV1 } from "../contracts/local-release.ts";
import {
  type LocalRunStatusV1,
  localSessionMarkerExists,
  probeRunnerLock,
  readLocalRunStatus,
} from "./local-release.ts";
import {
  CHILD_DEADLINE_MS,
  DETAIL_CHILD_EXIT_FAILED,
  DETAIL_CHILD_UNSETTLED,
  DETAIL_LOCK_HELD,
  DETAIL_LOCK_NOT_RELEASED,
  DETAIL_MARKER_PRESENT,
  DETAIL_STATE_UNAVAILABLE,
  DETAIL_STATUS_DUPLICATE,
  DETAIL_STATUS_STALE,
  DETAIL_STATUS_UNREADABLE,
  isFailedOutcome,
  joinPath,
  type KnownInvocationsV1,
  type LocalSupervisorChildResultV1,
  type LocalSupervisorInputV1,
  REPAIR_TASK_NAME,
  type RunObservationV1,
  runtimePath,
} from "./local-supervisor-shared.ts";
import { verifyRuntime } from "./local-supervisor-runtime.ts";

// ---------------------------------------------------------------------------
// Runtimes: verify, stage, never overwrite
// ---------------------------------------------------------------------------

export async function runAndVerify(
  input: LocalSupervisorInputV1,
  clock: Clock,
  revision: GitSha,
  known: KnownInvocationsV1,
): Promise<RunObservationV1> {
  const verification = await verifyRuntime(input, revision);
  if (!verification.ok) {
    return { kind: "failed", proof: null, detail: verification.detail };
  }
  if (!await probeRunnerLock(input.stateRoot)) {
    return { kind: "pending", detail: DETAIL_LOCK_HELD };
  }
  // The session marker is checked before the child starts as well as after it
  // settles: a marker left by a prior run pauses this invocation instead of
  // layering a new child over an unsettled session.
  if (await localSessionMarkerExists(input.stateRoot)) {
    return { kind: "pending", detail: DETAIL_MARKER_PRESENT };
  }
  const runtimeDir = runtimePath(input.stateRoot, revision);
  const startedAt = clock.now();
  const logPath = joinPath(
    input.stateRoot,
    "supervisor-logs",
    `${revision}-${startedAt}-${crypto.randomUUID()}`,
  );
  let run: LocalSupervisorChildResultV1;
  try {
    run = await input.runChild({
      stateRoot: input.stateRoot,
      runtimeDir,
      revision,
      taskName: REPAIR_TASK_NAME,
      env: {
        HOME: input.env.HOME,
        PATH: input.env.PATH,
        GITHUB_TOKEN: input.env.GITHUB_TOKEN,
        UOS_AI_TOKEN: input.env.UOS_AI_TOKEN,
      },
      denoExecutable: input.denoExecutable,
      deadlineMs: CHILD_DEADLINE_MS,
      logPath,
    });
  } catch {
    return { kind: "pending", detail: DETAIL_CHILD_UNSETTLED };
  }
  if (!run.settled) {
    return { kind: "pending", detail: DETAIL_CHILD_UNSETTLED };
  }
  const settledAt = clock.now();
  if (await localSessionMarkerExists(input.stateRoot)) {
    return { kind: "pending", detail: DETAIL_MARKER_PRESENT };
  }
  if (!await probeRunnerLock(input.stateRoot)) {
    return { kind: "pending", detail: DETAIL_LOCK_NOT_RELEASED };
  }
  // A settled child with a nonzero exit, an absent marker and a free runner
  // lock is an objective failed run even when the status receipt is missing or
  // stale. No proof is fabricated for it: the saved exact prior proof drives
  // the ordinary rollback.
  if (run.exitCode !== 0) {
    return { kind: "failed", proof: null, detail: DETAIL_CHILD_EXIT_FAILED };
  }
  const status = await readLocalRunStatus(input.stateRoot);
  if (!status.ok || status.value === null) {
    return { kind: "pending", detail: DETAIL_STATUS_UNREADABLE };
  }
  const observed: LocalRunStatusV1 = status.value;
  if (
    observed.controllerSha !== revision ||
    !Number.isSafeInteger(observed.startedAt) ||
    !Number.isSafeInteger(observed.finishedAt)
  ) {
    return { kind: "pending", detail: DETAIL_STATUS_STALE };
  }
  // The proof must belong to this invocation's bounded window: the child
  // starts at/after the parent's recorded start, finishes at/after its own
  // start, and never finishes after the parent observed settlement. A stale or
  // future proof is never acceptance.
  if (
    observed.startedAt < startedAt ||
    observed.finishedAt < observed.startedAt ||
    observed.finishedAt > settledAt
  ) {
    return { kind: "pending", detail: DETAIL_STATUS_STALE };
  }
  if (known.has(observed.invocationId)) {
    return { kind: "pending", detail: DETAIL_STATUS_DUPLICATE };
  }
  known.add(observed.invocationId);
  const proof: LocalRunProofV1 = {
    invocationId: observed.invocationId,
    controllerSha: observed.controllerSha,
    startedAt: observed.startedAt,
    finishedAt: observed.finishedAt,
    outcome: observed.outcome,
  };
  // An explicitly failed outcome is an objective failure even when the child
  // reported its repair state as unavailable: the observed proof drives the
  // ordinary exact-prior rollback. State availability is required only before
  // a healthy proof may be accepted; a healthy missing/unavailable state is
  // never acceptance and stays pending.
  if (isFailedOutcome(observed.outcome)) {
    return {
      kind: "failed",
      proof,
      detail: `local supervisor refused: the run reported ${observed.outcome}`,
    };
  }
  if (!observed.stateAvailable) {
    return { kind: "pending", detail: DETAIL_STATE_UNAVAILABLE };
  }
  return { kind: "proof", proof };
}

export async function seedKnownInvocations(
  stateRoot: string,
): Promise<Set<string>> {
  const known = new Set<string>();
  const status = await readLocalRunStatus(stateRoot);
  if (status.ok && status.value !== null) {
    known.add(status.value.invocationId);
  }
  return known;
}

export function addProofInvocation(
  known: KnownInvocationsV1,
  proof: LocalRunProofV1 | null,
): void {
  if (proof !== null) known.add(proof.invocationId);
}
