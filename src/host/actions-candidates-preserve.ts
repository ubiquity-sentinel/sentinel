import { isNativeQueueTarget } from "../github/native-queue-guard.ts";
import { hasTakeoverCustody } from "../github/existing-pr-takeover-provenance.ts";
/** Hosted actions-candidates-preserve responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { GitHubPort, PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type {
  CandidatePreservationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import { GitReviewSnapshot } from "../github/review-snapshot.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
  implementationIntentKey,
} from "../repair/keys.ts";
import { conflictResolutionInFlight } from "../repair/conflict-resolution.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import { githubGitAuthEnv } from "./local.ts";
import {
  GIT_MAX_OUTPUT_BYTES,
  GIT_TIMEOUT_MS,
  isPreservationRef,
  sameRepository,
  SELF_REPOSITORY,
  STATIC_PRESERVE_BINDING,
  STATIC_PRESERVE_CONFLICT,
  STATIC_PRESERVE_INPUT,
  STATIC_PRESERVE_LOCAL,
  STATIC_PRESERVE_PUSH,
  STATIC_PRESERVE_REMOTE,
} from "./actions-candidates-shared.ts";
import type { ActionsCandidatePreserverInputV1 } from "./actions-candidates-shared.ts";
import type { PreserverGitRunV1 } from "./actions-candidates-objects.ts";
import { freshStoreProof } from "./actions-candidates-proof.ts";

/**
 * Trusted candidate preservation over the SAME host port instance.
 *
 * The exact durable binding is revalidated BEFORE any external read: exactly
 * one nonterminal self-scope record for the task, present candidate state whose
 * recorded published head equals the request, and one of the two exact
 * operation shapes — a pending `candidate_preservation` intent bound to a
 * genuine submitted implementation reservation, a persisted `base_refresh`
 * result bound to its deterministic key and the retained original descriptor,
 * or an in-flight conflict resolution whose trusted merge the hosted ingest
 * preserves under that same refresh binding before it consumes the receipt.
 *
 * Then, in one bounded sequence: read the exact operation ref (a different
 * existing SHA is a conflict; the exact existing SHA is reconciliation and is
 * never pushed again); if absent, ensure the candidate locally through the
 * trusted callback and run the trusted publication validator in the source
 * mirror BEFORE sending any object; create the ref only through the SAME port
 * `pushHead(ref, head, null)`, reconciling one ambiguous response with exactly
 * one authenticated reread; and finally prove durability by fetching only the
 * fixed remote and exact operation ref into a NEW empty bare object store,
 * verifying the exact head/base objects, ancestry and the absence of
 * shallow/replace/alternate masking. When reconciling an existing ref, the
 * exact proved graph is first imported into the source mirror and validated
 * there; publication is then re-validated in the credential-free proof store
 * before re-reading the authenticated ref. Only then is success returned. No
 * model, PR, task-branch, review or release effect exists here.
 */
export function createCandidatePreserver(
  input: ActionsCandidatePreserverInputV1,
): GitHubPort["preserveCandidate"] {
  const repository = input.repository ?? SELF_REPOSITORY;
  const remoteUrl = input.remoteUrl ??
    `https://github.com/${repository.owner}/${repository.name}.git`;
  const runtime = input.runtime ?? new DenoReplayRuntime(input.trustedPath);
  const runGit: PreserverGitRunV1 = async (cwd, args, credentials) => {
    let result;
    try {
      result = await runtime.run({
        executable: input.gitExecutable,
        args: ["-c", "core.hooksPath=/dev/null", ...args],
        cwd,
        env: {
          PATH: input.trustedPath,
          HOME: input.scratch,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          ...(credentials ? githubGitAuthEnv(input.token, remoteUrl) : {}),
        },
        maxDurationMs: GIT_TIMEOUT_MS,
        maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      });
    } catch {
      // A runtime throw leaves settlement unproven: it is carried as a null
      // (unsettled) result instead of being discarded as a plain failure.
      return null;
    }
    return {
      code: result.exitCode ?? 1,
      stdout: result.outcome === "exited"
        ? new TextDecoder().decode(result.stdout)
        : "",
      settled: result.settled,
      truncated: result.truncated,
      exited: result.outcome === "exited",
    };
  };
  // The validator is credential-free trusted code over the trusted source
  // mirror; it never inherits the fetch token.
  const validator = new GitReviewSnapshot({
    trustedPath: input.trustedPath,
    repositoryDir: input.sourcePath,
    gitExecutable: input.gitExecutable,
  });

  return async (request, takeover) => {
    const taskId = request?.taskId;
    const candidate: CandidatePreservationV1 | undefined = request?.candidate;
    const publishedHead = request?.publishedHead ?? null;
    if (
      typeof taskId !== "string" || taskId.length === 0 ||
      candidate === undefined ||
      !isGitSha(candidate.base) || !isGitSha(candidate.head) ||
      typeof candidate.operationKey !== "string" ||
      candidate.operationKey.length === 0 ||
      !isPreservationRef(candidate.ref) ||
      (publishedHead !== null && !isGitSha(publishedHead))
    ) {
      return portError("invalid", STATIC_PRESERVE_INPUT);
    }
    // 1. Strict durable state binding BEFORE any external read.
    let record: WorkRecordV1 | null = null;
    let reservations: readonly BudgetReservationV1[] = [];
    try {
      const read = await input.state.readRepair();
      if (!read.ok || read.value.status !== "found") {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      const matches = read.value.snapshot.work.filter((work) =>
        sameRepository(work.repository, repository) && work.id === taskId &&
        work.nextStep !== "done"
      );
      if (matches.length !== 1) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      record = matches[0]!;
      reservations = read.value.snapshot.reservations;
    } catch {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (record === null) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      hasTakeoverCustody(record) &&
      (takeover === undefined || input.port.existingPrTakeover === undefined)
    ) {
      return portError(
        "unavailable",
        "existing PR preservation authority unavailable",
      );
    }
    const binding = await resolveCandidatePreservationBinding(
      record,
      reservations,
      candidate,
      publishedHead,
    );
    if (!binding.ok) return binding;
    const ref = binding.value;
    const exactRecord = record;
    const queueCheck = async (): Promise<PortResultV1<void>> => {
      if (!isNativeQueueTarget(repository)) return portOk(undefined);
      if (input.port.nativeQueue === undefined) {
        return portError(
          "unavailable",
          "native queue custody capability missing",
        );
      }
      const guard = await input.port.nativeQueue.inspect({
        record: exactRecord,
        operation: "publication",
        expectedHead: publishedHead,
        deadline: input.clock.now() + 30_000,
      });
      return guard.status === "allow" ? portOk(undefined) : portError(
        "unavailable",
        `native queue custody hold: ${guard.reason}`,
      );
    };
    const entryGuard = await queueCheck();
    if (!entryGuard.ok) return entryGuard;
    // 2. Authenticated exact operation-ref read through the SAME port.
    const before = await input.port.readRef(ref);
    if (!before.ok) return before;
    if (before.value !== null && before.value.sha !== candidate.head) {
      return portError("conflict", STATIC_PRESERVE_CONFLICT);
    }
    // 3. Absent ref: trusted local objects + source-mirror publication
    //    validation BEFORE any object is sent, then one create-only push.
    if (before.value === null) {
      let ensured: PortResultV1<void>;
      try {
        ensured = await input.ensureLocalCandidate(taskId, candidate.head);
      } catch {
        return portError("unavailable", STATIC_PRESERVE_LOCAL);
      }
      if (!ensured.ok) return ensured;
      const validated = await validator.validatePublication({
        base: candidate.base,
        head: candidate.head,
        publishedHead,
        protectedPaths: input.protectedPaths,
      });
      if (!validated.ok) return validated;
      const finalGuard = await queueCheck();
      if (!finalGuard.ok) return finalGuard;
      const pushed = await input.port.pushHead(
        ref,
        candidate.head,
        null,
        takeover,
      );
      if (!pushed.ok) return pushed;
      if (pushed.value === "ambiguous") {
        // Exactly one authenticated reread; a lost response never repeats the
        // push and never claims an unconfirmed effect.
        const reread = await input.port.readRef(ref);
        if (!reread.ok) return reread;
        if (reread.value === null) {
          return portError("unavailable", STATIC_PRESERVE_PUSH);
        }
        if (reread.value.sha !== candidate.head) {
          return portError("conflict", STATIC_PRESERVE_CONFLICT);
        }
      }
    }
    // 4. Fresh empty object-store proof: only the fixed remote and the exact
    //    operation ref are fetched; the identities, ancestry and absence of
    //    shallow/replace/alternate masking are all verified, publication is
    //    re-validated credential-free in that store, and the authenticated ref
    //    is re-read afterwards. Under a `proofPass` the store is that pass's
    //    one fresh store for this remote, and every check above still runs.
    const proved = await freshStoreProof({
      runGit,
      gate: input.gate,
      installationId: repository.installationId,
      remoteUrl,
      ref,
      candidate,
      publishedHead,
      protectedPaths: input.protectedPaths,
      sourcePath: input.sourcePath,
      restoreSource: before.value !== null,
      trustedPath: input.trustedPath,
      gitExecutable: input.gitExecutable,
      scratch: input.scratch,
      ...(input.proofPass === undefined ? {} : { pass: input.proofPass }),
    });
    if (!proved.ok) return proved;
    const after = await input.port.readRef(ref);
    if (!after.ok) return after;
    if (after.value === null) {
      return portError("unavailable", STATIC_PRESERVE_REMOTE);
    }
    if (after.value.sha !== candidate.head) {
      return portError("conflict", STATIC_PRESERVE_CONFLICT);
    }
    const finalGuard = await queueCheck();
    if (!finalGuard.ok) return finalGuard;
    if (
      before.value !== null &&
      (hasTakeoverCustody(record) || takeover !== undefined)
    ) {
      const custody = await input.port.existingPrTakeover?.authorizeBoundary({
        kind: "preserve",
        request,
      }, takeover);
      if (!custody?.ok) {
        return custody ??
          portError(
            "unavailable",
            "existing PR preservation authority unavailable",
          );
      }
    }
    return portOk(undefined);
  };
}

/**
 * Exact durable-binding resolution. Returns the exact preservation ref ONLY
 * for the two accepted shapes; every other state is unavailable.
 */
export async function resolveCandidatePreservationBinding(
  record: WorkRecordV1,
  reservations: readonly BudgetReservationV1[],
  candidate: CandidatePreservationV1,
  publishedHead: GitSha | null,
): Promise<PortResultV1<string>> {
  const candidateState = record.target.candidateState;
  const intent = record.intent;
  if (candidateState === undefined || intent === null) {
    return portError("unavailable", STATIC_PRESERVE_BINDING);
  }
  if (candidateState.publishedHead !== publishedHead) {
    return portError("unavailable", STATIC_PRESERVE_BINDING);
  }
  let operationKey: string;
  if (intent.kind === "candidate_preservation") {
    // (a) A pending preservation intent: no preserved descriptor yet, the
    // descriptor describes exactly this target, and the producing
    // implementation reservation is a genuine submitted attempt.
    if (candidateState.preserved !== null) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      candidate.base !== record.target.base ||
      candidate.head !== record.target.head
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      intent.expectedHead !== candidate.head ||
      intent.observedBase !== candidate.base
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      intent.requestId === null ||
      intent.key !== implementationIntentKey(intent.requestId)
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (candidate.operationKey !== intent.key) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (intent.branch !== candidate.ref) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (intent.pr !== null || intent.resultId !== null) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    const matching = reservations.filter((entry) =>
      entry.id === intent.requestId
    );
    if (matching.length !== 1) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    const reservation = matching[0]!;
    if (reservation.taskId !== record.id) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (!sameRepository(reservation.repository, record.repository)) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (reservation.outcome !== "submitted") {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      reservation.purpose !== "implementation" &&
      reservation.purpose !== "retry"
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (reservation.head !== candidate.base) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (reservation.attempt !== record.counters.attempts) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    operationKey = intent.key;
  } else if (intent.kind === "base_refresh") {
    // (b) A persisted prepared result: the descriptor is the sealed refresh
    // commit, the intent still retains the old candidate binding, and the
    // recorded original descriptor is untouched.
    if (
      intent.resultId === null || !isGitSha(intent.resultId) ||
      candidate.head !== intent.resultId
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      intent.observedBase === null ||
      candidate.base !== intent.observedBase
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (candidate.operationKey !== intent.key) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (intent.requestId !== null) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (intent.pr === null || intent.branch === null) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      intent.pr !== record.target.pr || intent.branch !== record.target.branch
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      intent.expectedHead === null ||
      intent.expectedHead !== record.target.head
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      intent.key !== baseRefreshIntentKey(
        intent.pr,
        intent.expectedHead,
        intent.observedBase,
      )
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    const preserved = candidateState.preserved;
    if (preserved === null && !hasTakeoverCustody(record)) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    // This is preliminary operation binding only. Native predecessors additionally
    // require the actual opaque takeover authority at the concrete preservation effect.
    if (preserved !== null) {
      if (
        preserved.base !== record.target.base ||
        preserved.head !== record.target.head
      ) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
      const preservedRef = await candidatePreservationRef(
        record.repository,
        record.id,
        preserved.operationKey,
      );
      if (preservedRef !== preserved.ref) {
        return portError("unavailable", STATIC_PRESERVE_BINDING);
      }
    }
    operationKey = intent.key;
  } else if (intent.kind === "implementation") {
    // (c) An in-flight conflict resolution (`conflict-resolution.ts`): the
    // record still holds the marked implementation intent of its ONE
    // charge (never ambiguous or refunded) and the published candidate H
    // with its retained descriptor. The descriptor is the trusted merge M
    // of H and the marked base B under the deterministic refresh binding
    // of (PR, H, B), the exact binding (b) the resolved intent later
    // publishes through, so the hosted ingest makes M durable before the
    // receipt is consumed.
    const mergeBase = conflictResolutionInFlight(intent);
    const { pr, head, branch, base } = record.target;
    const preserved = candidateState.preserved;
    if (
      mergeBase === null || record.nextStep !== "work" || pr === null ||
      head === null || branch === null || preserved === null ||
      publishedHead !== head || preserved.base !== base ||
      preserved.head !== head
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      candidate.base !== mergeBase || candidate.head === head ||
      candidate.head === mergeBase ||
      candidate.operationKey !== baseRefreshIntentKey(pr, head, mergeBase)
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    if (
      intent.requestId === null ||
      intent.key !== implementationIntentKey(intent.requestId) ||
      intent.observedBase !== base || intent.expectedHead !== null ||
      intent.resultId !== null || intent.pr !== null
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    const matching = reservations.filter((entry) =>
      entry.id === intent.requestId
    );
    if (matching.length !== 1) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    const reservation = matching[0]!;
    if (
      reservation.taskId !== record.id ||
      !sameRepository(reservation.repository, record.repository) ||
      // `reserved` until the receipt is consumed; `submitted` only when a
      // consumption settled it but failed to persist the resolved intent,
      // and the same receipt is re-ingested.
      (reservation.outcome !== "reserved" &&
        reservation.outcome !== "submitted") ||
      (reservation.purpose !== "implementation" &&
        reservation.purpose !== "retry") ||
      reservation.head !== base ||
      reservation.attempt !== record.counters.attempts
    ) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    const preservedRef = await candidatePreservationRef(
      record.repository,
      record.id,
      preserved.operationKey,
    );
    if (preservedRef !== preserved.ref) {
      return portError("unavailable", STATIC_PRESERVE_BINDING);
    }
    operationKey = candidate.operationKey;
  } else {
    return portError("unavailable", STATIC_PRESERVE_BINDING);
  }
  const ref = await candidatePreservationRef(
    record.repository,
    record.id,
    operationKey,
  );
  if (candidate.ref !== ref || !isPreservationRef(ref)) {
    return portError("unavailable", STATIC_PRESERVE_BINDING);
  }
  return portOk(ref);
}
