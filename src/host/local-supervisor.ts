/**
 * The fixed trusted local supervisor (Wave C).
 *
 * One entrypoint that can install an exact reviewed and merged Sentinel repair,
 * execute that new runtime, and record exact acceptance or proven rollback
 * beneath the private local state root. It is deliberately a single fixed
 * program: it reads no model, makes no network or GitHub decision of its own,
 * takes no CLI flag, secret or revision selector, and never touches release
 * requests, work records, reservations or repair refs.
 *
 * Fixed authority and fixed evidence:
 *
 * - private `supervisor.lock` (distinct from the child's `runner.lock`) makes
 *   one supervisor invocation at a time; a held lock is an explicit busy
 *   refusal, never a wait;
 * - `active-runtime.json` is the one exact-SHA pointer; a missing pointer is a
 *   refusal (the installer initializes it to the reviewed installed runtime)
 *   and no revision is ever chosen by time, list order or the newest file;
 * - every claim of health is a fresh observed bounded child run: fresh private
 *   status receipt, unique invocation id, exact controller SHA, observed
 *   finished timestamp, a supported outcome, available state, an absent
 *   session marker and a reacquired/released runner lock after the child
 *   settled. A pointer or an intended phase can never become acceptance;
 * - promotion stages `request.revision` into `runtimes/<exact SHA>` from the
 *   private source mirror with a credential-free local clone and a detached
 *   exact checkout, then atomically renames it into place. Existing runtimes
 *   are never overwritten;
 * - the pointer only ever moves under the supervisor lock with an exact
 *   compare immediately before the atomic rename, so an unrelated newer
 *   pointer is preserved;
 * - a failed candidate is restored to the exact prior pointer and only a
 *   fresh exact prior run proof records `rolled_back`. Anything unproven stays
 *   `pending`.
 *
 * The supervisor is installed outside mutable runtime checkouts: model changes
 * cannot replace it, and no model or repair process writes its receipts or
 * pointer.
 */

import type { GitSha } from "../contracts/brands.ts";
import { type Clock, SystemClock } from "../contracts/ports.ts";
import type { LocalReleaseReceiptV1 } from "../contracts/local-release.ts";
import {
  compareAndSetLocalActiveRuntime,
  ensurePrivateDir,
  findPendingLocalReleaseReceipt,
  readLocalActiveRuntime,
} from "./local-release.ts";
import {
  DETAIL_POINTER_CHANGED,
  DETAIL_POINTER_MISSING,
  DETAIL_POINTER_UNREADABLE,
  DETAIL_RECEIPTS_UNREADABLE,
  DETAIL_STATE_READ,
  isHealthyOutcome,
  joinPath,
  type KnownInvocationsV1,
  type LocalSupervisorChildRunnerV1,
  type LocalSupervisorEnvV1,
  type LocalSupervisorInputV1,
  type LocalSupervisorOptionsV1,
  type LocalSupervisorResultV1,
  SOURCE_DIR,
} from "./local-supervisor-shared.ts";
import {
  failReceipt,
  finishRollback,
  installAndActivate,
  promote,
  restorePrior,
  verifyCandidate,
} from "./local-supervisor-release.ts";
import { selectLocalReleaseRequest } from "./local-supervisor-requests.ts";
import {
  addProofInvocation,
  runAndVerify,
  seedKnownInvocations,
} from "./local-supervisor-observation.ts";
import { defaultRunChild } from "./local-supervisor-child.ts";

export {
  type LocalSupervisorChildInputV1,
  type LocalSupervisorChildResultV1,
  type LocalSupervisorChildRunnerV1,
  type LocalSupervisorEnvV1,
  type LocalSupervisorOptionsV1,
  type LocalSupervisorResultV1,
} from "./local-supervisor-shared.ts";
export { defaultRunChild } from "./local-supervisor-child.ts";
export { runGit } from "./local-supervisor-git.ts";

/**
 * Run one bounded supervisor pass. A held supervisor lock is an explicit busy
 * refusal; every other outcome is an explicit result value.
 */
export async function runLocalSupervisor(
  options: LocalSupervisorOptionsV1,
): Promise<LocalSupervisorResultV1> {
  const input = readLocalSupervisorOptions(options);
  const clock = options.clock ?? new SystemClock();
  await ensurePrivateDir(input.stateRoot);
  const lock = await tryAcquireSupervisorLock(input.stateRoot);
  if (lock === null) return { status: "busy" };
  try {
    return await supervise(input, clock);
  } catch {
    return { status: "failed", detail: DETAIL_STATE_READ };
  } finally {
    try {
      lock.close();
    } catch {
      // the pass result is already decided
    }
  }
}

async function supervise(
  input: LocalSupervisorInputV1,
  clock: Clock,
): Promise<LocalSupervisorResultV1> {
  const pointer = await readLocalActiveRuntime(input.stateRoot);
  if (!pointer.ok) {
    return { status: "failed", detail: DETAIL_POINTER_UNREADABLE };
  }
  if (pointer.value === null) {
    return { status: "failed", detail: DETAIL_POINTER_MISSING };
  }
  const activeRevision = pointer.value.revision;
  const known = await seedKnownInvocations(input.stateRoot);

  const pending = await findPendingLocalReleaseReceipt(input.stateRoot);
  if (!pending.ok) {
    return { status: "failed", detail: DETAIL_RECEIPTS_UNREADABLE };
  }
  if (pending.value !== null) {
    return await reconcile(input, clock, pending.value, activeRevision, known);
  }

  // One healthy ordinary run of the exact active runtime before any promotion.
  const active = await runAndVerify(input, clock, activeRevision, known);
  if (active.kind !== "proof") {
    return active.kind === "failed"
      ? { status: "failed", detail: active.detail }
      : { status: "pending", detail: active.detail };
  }
  if (!isHealthyOutcome(active.proof.outcome)) {
    return {
      status: "failed",
      detail:
        `local supervisor refused: the active runtime reported ${active.proof.outcome}`,
    };
  }

  const selection = await selectLocalReleaseRequest(input);
  if (selection.kind === "error") {
    return { status: "failed", detail: selection.detail };
  }
  if (selection.kind === "none") {
    return { status: "idle", activeRevision };
  }

  return await promote(
    input,
    clock,
    selection.request,
    activeRevision,
    active.proof,
    known,
  );
}

// ---------------------------------------------------------------------------
// Crash reconciliation: exact pointer/receipt identities and fresh runs only
// ---------------------------------------------------------------------------

async function reconcile(
  input: LocalSupervisorInputV1,
  clock: Clock,
  receipt: LocalReleaseReceiptV1,
  activeRevision: GitSha,
  known: KnownInvocationsV1,
): Promise<LocalSupervisorResultV1> {
  addProofInvocation(known, receipt.candidateProof);
  addProofInvocation(known, receipt.priorProof);
  const request = receipt.request;
  const target = request.revision;
  const prior = receipt.priorRevision;

  if (receipt.phase === "installing") {
    if (activeRevision === target) {
      // The pointer moved but the verifying receipt never landed: finish
      // verification against the saved exact prior proof and the receipt's
      // original immutable creation time.
      return await verifyCandidate(
        input,
        clock,
        request,
        prior,
        receipt.priorProof,
        receipt.createdAt,
        known,
      );
    }
    if (activeRevision !== prior) {
      return await failReceipt(
        input,
        clock,
        receipt,
        DETAIL_POINTER_CHANGED,
      );
    }
    // The pointer never moved. Re-verify the active prior with a fresh run,
    // then continue the one promotion this invocation is allowed. The resumed
    // install keeps the original receipt creation time.
    const priorRun = await runAndVerify(input, clock, prior, known);
    if (priorRun.kind !== "proof") {
      return priorRun.kind === "failed"
        ? { status: "failed", detail: priorRun.detail }
        : { status: "pending", detail: priorRun.detail };
    }
    if (!isHealthyOutcome(priorRun.proof.outcome)) {
      return {
        status: "failed",
        detail:
          `local supervisor refused: the active runtime reported ${priorRun.proof.outcome}`,
      };
    }
    return await installAndActivate(
      input,
      clock,
      request,
      prior,
      priorRun.proof,
      receipt.createdAt,
      known,
    );
  }

  if (receipt.phase === "verifying") {
    if (activeRevision === target) {
      return await verifyCandidate(
        input,
        clock,
        request,
        prior,
        receipt.priorProof,
        receipt.createdAt,
        known,
      );
    }
    if (activeRevision !== prior) {
      return await failReceipt(
        input,
        clock,
        receipt,
        DETAIL_POINTER_CHANGED,
      );
    }
    // The candidate is not active: never infer acceptance from that. Only the
    // exact prior revision may be restored, and only a fresh exact prior run
    // records rolled_back. When the pointer already equals that prior, the
    // rollback intent is persisted first and the same-revision compare-set
    // finishes without a candidate-to-prior swap; an unrelated pointer was
    // refused above and is never overwritten.
    return await restorePrior(
      input,
      clock,
      request,
      prior,
      receipt.priorProof,
      receipt.createdAt,
      receipt.candidateProof,
      known,
      true,
    );
  }

  if (receipt.phase === "rollback_pending") {
    if (activeRevision === target) {
      const set = await compareAndSetLocalActiveRuntime(
        input.stateRoot,
        target,
        prior,
      );
      if (set !== "applied") {
        return await failReceipt(
          input,
          clock,
          receipt,
          DETAIL_POINTER_CHANGED,
        );
      }
    } else if (activeRevision !== prior) {
      return await failReceipt(
        input,
        clock,
        receipt,
        DETAIL_POINTER_CHANGED,
      );
    }
    return await finishRollback(
      input,
      clock,
      request,
      prior,
      receipt.priorProof,
      receipt.candidateProof,
      receipt.createdAt,
      known,
    );
  }

  // A terminal receipt is never reconciled or promoted again.
  return { status: "idle", activeRevision };
}

// ---------------------------------------------------------------------------
// Locks, environment and bounded child/git execution
// ---------------------------------------------------------------------------

export async function tryAcquireSupervisorLock(
  stateRoot: string,
): Promise<Deno.FsFile | null> {
  await ensurePrivateDir(stateRoot);
  const file = await Deno.open(joinPath(stateRoot, "supervisor.lock"), {
    create: true,
    read: true,
    write: true,
    mode: 0o600,
  });
  try {
    if (file.tryLockSync(true)) return file;
  } catch {
    // fall through to close + refusal
  }
  file.close();
  return null;
}

function readLocalSupervisorOptions(
  options: LocalSupervisorOptionsV1,
): LocalSupervisorInputV1 {
  const record = options as unknown as Record<string, unknown>;
  const stateRoot = requireText(record?.stateRoot);
  const denoExecutable = requireText(record?.denoExecutable);
  const env = record?.env as LocalSupervisorEnvV1 | undefined;
  const home = requireText(env?.HOME);
  const path = requireText(env?.PATH);
  const githubToken = requireText(env?.GITHUB_TOKEN);
  const uosToken = requireText(env?.UOS_AI_TOKEN);
  const runChild = record?.runChild;
  return {
    stateRoot,
    sourceDir: joinPath(stateRoot, SOURCE_DIR),
    env: {
      HOME: home,
      PATH: path,
      GITHUB_TOKEN: githubToken,
      UOS_AI_TOKEN: uosToken,
    },
    denoExecutable,
    runChild: typeof runChild === "function"
      ? runChild as LocalSupervisorChildRunnerV1
      : defaultRunChild,
  };
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("local supervisor rejected: options are invalid");
  }
  return value;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`local supervisor requires environment variable ${name}`);
  }
  return value;
}

if (import.meta.main) {
  let result: LocalSupervisorResultV1;
  try {
    const home = requireEnv("HOME");
    result = await runLocalSupervisor({
      stateRoot: joinPath(home, ".local", "state", "sentinel-local"),
      env: {
        HOME: home,
        PATH: Deno.env.get("PATH") ?? "",
        GITHUB_TOKEN: requireEnv("GITHUB_TOKEN"),
        UOS_AI_TOKEN: requireEnv("UOS_AI_TOKEN"),
      },
      denoExecutable: Deno.execPath(),
    });
  } catch {
    result = {
      status: "failed",
      detail: "local supervisor failed: trusted environment is incomplete",
    };
  }
  console.log(JSON.stringify(result));
  if (result.status === "failed") Deno.exitCode = 1;
}
