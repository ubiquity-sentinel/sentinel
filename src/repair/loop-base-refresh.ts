import {
  holdQueueRecord,
  queueEffectRefused,
  queueRefusalIsTransient,
} from "./loop-queue-guard.ts";
import { guardQueueOperation } from "./loop-queue-guard.ts";
import {
  checkExistingPrOperation,
  prepareExistingPrEffect,
} from "./loop-existing-pr.ts";
import { hasTakeoverCustody } from "../github/existing-pr-takeover-provenance.ts";
/** Repair loop internals: base refresh. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { BASE_REFRESH_CONFLICT_DETAIL } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import {
  conflictMarkerBase,
  conflictResolutionRouteOpen,
  conflictResolutionShape,
  pendingConflictRecord,
  resolvedConflictResolution,
} from "./conflict-resolution.ts";
import { candidatePreservationRef } from "./keys.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import {
  BASE_REFRESH_BASE_READ_DETAIL,
  BASE_REFRESH_CAPABILITY_DETAIL,
  BASE_REFRESH_FOREIGN_HEAD_DETAIL,
  BASE_REFRESH_PR_OBSERVATION_DETAIL,
  BASE_REFRESH_PRESERVE_DETAIL,
  BASE_REFRESH_PUSH_DETAIL,
  BASE_REFRESH_REF_READ_DETAIL,
  BASE_REFRESH_UNPREPARED_DETAIL,
  baseRefreshRefusalReason,
  failBaseRefresh,
  refuseBaseRefresh,
} from "./loop-base-refresh-failure.ts";
import { configFor, retireClosedPublication } from "./loop-records.ts";
import { legacyCutoff } from "./loop-review-round-cap.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { RETIRED_MERGED_MESSAGE } from "./selection.ts";
import {
  clearIntent,
  markBlocked,
  markTerminalBlocked,
  setIntent,
  setWait,
} from "./transitions.ts";

// The failure accounting moved to loop-base-refresh-failure.ts; this module
// keeps exporting every name it exported in generation 76, which launcher
// code (ops/hosted-autonomy-refresh-rearm.ts) imports from here.
export {
  BASE_REFRESH_BASE_READ_DETAIL,
  BASE_REFRESH_CAPABILITY_DETAIL,
  BASE_REFRESH_FOREIGN_HEAD_DETAIL,
  BASE_REFRESH_PR_OBSERVATION_DETAIL,
  BASE_REFRESH_PRESERVE_DETAIL,
  BASE_REFRESH_PUSH_DETAIL,
  BASE_REFRESH_REF_READ_DETAIL,
  BASE_REFRESH_REFUSED_PREFIX,
  BASE_REFRESH_UNPREPARED_DETAIL,
  baseRefreshRefusedMessage,
  failBaseRefresh,
  isBaseRefreshRefusedPark,
  MAX_BASE_REFRESH_FAILURES,
} from "./loop-base-refresh-failure.ts";

/**
 * Deterministic base-refresh intent identity: exact PR, old candidate head and
 * observed new base. Never time- or list-derived, so a restart reproduces the
 * identical key.
 */
export function baseRefreshIntentKey(
  pullRequestNumber: number,
  expectedHead: GitSha,
  observedBase: GitSha,
): string {
  return `base_refresh:${pullRequestNumber}:${expectedHead}:${observedBase}`;
}

/**
 * Observe the actual configured base ref for an eligible issue delivery. A
 * moved base persists the durable refresh intent BEFORE any preparation or
 * side effect and performs no reservation, model call or external write. The
 * immutable record identities, counters, evidence and reviews are untouched;
 * the target stays on the old base/head until publication succeeded. Returns
 * null when the base did not move (the existing merge path is unchanged), or
 * an explicit step result for a wait/refusal/deferral. `beforeRefresh` runs
 * only once the base was observed to move, before the intent is written.
 */
export async function ensureBaseRefreshIntent(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  beforeRefresh?: (observedBase: GitSha) => Promise<StepResultV1 | null>,
): Promise<StepResultV1 | null> {
  const queueGuard = await guardQueueOperation(
    deps,
    context,
    record,
    "refresh",
  );
  if (queueGuard !== null) return queueGuard;
  const config = configFor(deps, record.repository);
  if (config === null) return null;
  if (
    record.target.pr === null || record.target.head === null ||
    record.target.branch === null
  ) {
    return null;
  }
  // The base read is a GitHub read: the shared gate is checked first (a
  // cooling installation never writes a refresh intent it cannot act on).
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  const readAt = deps.clock.now();
  const ref = await deps.github.readRef(`refs/heads/${config.baseBranch}`);
  if (!ref.ok || ref.value === null) {
    // The base ref could not be observed: a bounded wait, never a fabricated
    // "unchanged" base and never a refresh intent against unknown state.
    return persistWork(
      deps,
      context,
      setWait(
        record,
        {
          reason: "unavailable",
          since: readAt,
          until: readAt + CHECK_POLL_MS,
        },
        readAt,
      ),
    );
  }
  const observedBase = ref.value.sha;
  if (observedBase === record.target.base) return null;
  // The caller may settle the reviewed head first (a CI-rejected candidate is
  // corrected instead of refreshed); null keeps the ordinary refresh.
  const settled = beforeRefresh === undefined
    ? null
    : await beforeRefresh(observedBase);
  if (settled !== null) return settled;
  const intent: IncompleteOperationV1 = {
    kind: "base_refresh",
    key: baseRefreshIntentKey(
      record.target.pr,
      record.target.head,
      observedBase,
    ),
    startedAt: readAt,
    branch: record.target.branch,
    expectedHead: record.target.head,
    observedBase,
    pr: record.target.pr,
    requestId: null,
    resultId: null,
  };
  const authority = await prepareExistingPrEffect(deps, context, record, {
    operation: "refresh",
    phase: "prepare",
    observedBase,
  });
  if (!authority.ok) {
    return {
      kind: "deferred",
      detail: "existing PR refresh planning custody unavailable",
    };
  }
  if (authority.value !== undefined) {
    const grant = authority.value;
    if (
      grant.kind === "native_preservation" ||
      !(await deps.github.existingPrTakeover!.authorizeEffect(
        grant.proof,
        grant.request,
      )).ok
    ) {
      return {
        kind: "deferred",
        detail: "existing PR refresh planning custody unavailable",
      };
    }
  }
  return persistWork(
    deps,
    context,
    setIntent(record, intent, readAt),
    authority.value === undefined ? undefined : context.head!,
  );
}

/**
 * Execute or resume one durable base-refresh intent.
 *
 * The record's own publication is reconciled FIRST: a merge outside the trusted
 * review path is terminal for capacity and is never republished, and a
 * closed-unmerged pull request retires the closed publication so the next
 * publish step creates its replacement. The deterministic prepared commit is
 * then regenerated through the optional trusted port capability (a fresh run
 * reproduces the identical SHA after a runner disappeared) and persisted as the
 * intent result BEFORE any push. The exact branch is read: only the old
 * candidate head or the exact prepared result are accepted, and the old head is
 * pushed with the existing expected-ref pushHead; an already-published prepared
 * commit is reconciled without a duplicate push. Unknown heads, failures and
 * lost responses leave the same durable intent with a bounded wait AND a
 * bounded failure record, and after MAX_BASE_REFRESH_FAILURES consecutive
 * failed executions the record blocks with a classified message instead of
 * re-arming that wait forever, while a known merge conflict either schedules
 * the one charged conflict resolution of that exact base (route open, shape
 * held) or blocks the task with the existing blocker fields, retaining the
 * candidate either way. A resolved conflict merge skips the regeneration and
 * is published through the same preserve/push tail. On success
 * the target advances to the exact new base/prepared head, the intent is
 * cleared and nextStep returns to `work`, so the existing publication and
 * fresh-review admission handle the exact new head (an old review is never
 * reused).
 */
export async function executeBaseRefreshIntent(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueOperation(
    deps,
    context,
    record,
    "refresh",
  );
  if (queueGuard !== null) return queueGuard;
  const intent = record.intent;
  if (
    intent === null || intent.kind !== "base_refresh" ||
    record.target.pr === null || record.target.head === null ||
    record.target.branch === null
  ) {
    return {
      kind: "state_error",
      detail: "base refresh intent identity mismatch",
    };
  }
  const observedBase = intent.observedBase;
  const persistedPrepared = intent.resultId;
  if (
    intent.branch !== record.target.branch ||
    intent.expectedHead !== record.target.head ||
    intent.pr !== record.target.pr ||
    intent.requestId !== null ||
    observedBase === null ||
    !isGitSha(observedBase) ||
    (persistedPrepared !== null && !isGitSha(persistedPrepared))
  ) {
    return {
      kind: "state_error",
      detail: "base refresh intent identity mismatch",
    };
  }
  const config = configFor(deps, record.repository);
  if (config === null) {
    return {
      kind: "state_error",
      detail: "base refresh without repository configuration",
    };
  }
  const reconciled = await reconcileRefreshPublication(
    deps,
    context,
    record,
    intent,
  );
  if (reconciled !== null) return reconciled;
  const expectedBase: GitSha = observedBase;
  // A model-resolved conflict merge was charged and settled when its receipt
  // was consumed and can never be regenerated: it is published exactly like a
  // persisted prepared result (preserved, lease-pushed over H, then the target
  // advances). Every other refresh regenerates its deterministic commit.
  const resolvedMerge = resolvedConflictResolution(intent);
  let preparedHead: GitSha;
  if (resolvedMerge !== null) {
    preparedHead = resolvedMerge;
  } else {
    const prepared = await prepareRefreshHead(
      deps,
      context,
      record,
      intent,
      config,
    );
    if (prepared.kind !== "regenerated") return prepared;
    preparedHead = prepared.head;
  }
  // Persist the exact prepared result BEFORE any push: a crash after a
  // successful push is then recoverable from the durable intent alone. The
  // exact persisted result is part of the intent identity every failure below
  // stays bound to (same key, same observed base, same prepared commit).
  const durableIntent: IncompleteOperationV1 = {
    ...intent,
    resultId: preparedHead,
  };
  let durable = record;
  if (persistedPrepared === null) {
    durable = setIntent(record, durableIntent, deps.clock.now());
    const persisted = await persistWork(deps, context, durable);
    if (persisted.kind !== "progress") return persisted;
  }
  // A new-format refresh preserves the EXACT prepared commit under the
  // existing base_refresh binding BEFORE the task push: the successor is
  // durable first, and a failed or lost acknowledgement retains the same
  // intent, resultId, target descriptor and accounting for a bounded retry of
  // the SAME operation (never a new model or review).
  const candidateState = durable.target.candidateState;
  const preservationRef = candidateState === undefined
    ? null
    : await candidatePreservationRef(
      durable.repository,
      durable.id,
      intent.key,
    );
  if (candidateState !== undefined) {
    if (
      candidateState.preserved === null && !hasTakeoverCustody(durable) ||
      preservationRef === null ||
      candidateState.publishedHead !== durable.target.head
    ) {
      return {
        kind: "state_error",
        detail: "base refresh published head mismatch",
      };
    }
    const candidate = {
      operationKey: intent.key,
      base: expectedBase,
      head: preparedHead,
      ref: preservationRef,
    };
    const authority = await prepareExistingPrEffect(deps, context, durable, {
      operation: "refresh",
      phase: "preserve",
      observedBase: expectedBase,
      nextHead: preparedHead,
      candidate,
    });
    if (!authority.ok) {
      return {
        kind: "deferred",
        detail: "existing PR refresh preservation custody unavailable",
      };
    }
    const preserved = await deps.github.preserveCandidate({
      taskId: durable.id,
      candidate,
      publishedHead: candidateState.publishedHead,
    }, authority.value);
    if (!preserved.ok) {
      // The trusted validator's verdict on the deterministic merge of the
      // exact candidate and base is final for this intent: re-running it can
      // only repeat the verdict (sentinel issue 157: a candidate R79 produced
      // edits paths R80 protects). It parks once for the owner, with the
      // closed reason and the open PR kept. A marked conflict-resolution
      // refresh keeps its marker accounting below.
      const reason = conflictMarkerBase(intent) === null
        ? baseRefreshRefusalReason(
          preserved.error.kind,
          preserved.error.detail,
        )
        : null;
      if (reason !== null) {
        return refuseBaseRefresh(deps, context, durable, reason);
      }
      return failBaseRefresh(deps, context, durable, durableIntent, {
        kind: preserved.error.kind,
        detail: BASE_REFRESH_PRESERVE_DETAIL,
        portDetail: preserved.error.detail,
      });
    }
  }
  // Recheck the total run deadline and the shared cooldown immediately before
  // the external write (the gate wait may have crossed the deadline).
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "base refresh crossed the total run deadline before push",
    };
  }
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "base refresh crossed the total run deadline before push",
    };
  }
  const ref = `refs/heads/${record.target.branch}`;
  const current = await deps.github.readRef(ref);
  const observedGuard = await guardQueueOperation(
    deps,
    context,
    durable,
    "refresh",
    current.ok && current.value?.sha === preparedHead
      ? preparedHead
      : undefined,
  );
  if (observedGuard !== null) return observedGuard;
  if (!current.ok || current.value === null) {
    return failBaseRefresh(deps, context, durable, durableIntent, {
      kind: current.ok ? "unavailable" : current.error.kind,
      detail: BASE_REFRESH_REF_READ_DETAIL,
      ...(current.ok ? {} : { portDetail: current.error.detail }),
    });
  }
  const currentHead = current.value.sha;
  if (currentHead === record.target.head) {
    // The candidate ref read is awaited wall-clock time: recheck the total run
    // deadline immediately before the push. A slow read that crossed the bound
    // keeps the exact durable intent/prepared SHA with zero push after cutoff.
    if (deps.clock.now() >= context.bounds.runDeadline) {
      return {
        kind: "margin",
        detail:
          "base refresh crossed the total run deadline after the ref read",
      };
    }
    // The branch still carries the old candidate: one exact expected-ref push
    // publishes the deterministic prepared commit.
    const authority = await prepareExistingPrEffect(deps, context, durable, {
      operation: "refresh",
      phase: "publish",
      observedBase: expectedBase,
      nextHead: preparedHead,
      ...(preservationRef === null ? {} : {
        candidate: {
          operationKey: intent.key,
          base: expectedBase,
          head: preparedHead,
          ref: preservationRef,
        },
      }),
    });
    if (!authority.ok) {
      return {
        kind: "deferred",
        detail: "existing PR refresh publication custody unavailable",
      };
    }
    const pushed = await deps.github.pushHead(
      ref,
      preparedHead,
      record.target.head,
      authority.value,
    );
    if (!pushed.ok && queueEffectRefused(pushed.error)) {
      return holdQueueRecord(
        deps,
        context,
        durable,
        queueRefusalIsTransient(pushed.error),
      );
    }
    if (!pushed.ok || pushed.value !== "applied") {
      // Unknown/error/lost push: keep the same durable intent and wait bounded;
      // a later run reconciles the exact ref before repeating. The bounded
      // failure record makes a repeated non-application a classified blocker.
      return failBaseRefresh(deps, context, durable, durableIntent, {
        kind: pushed.ok ? "unavailable" : pushed.error.kind,
        detail: BASE_REFRESH_PUSH_DETAIL,
        ...(pushed.ok ? {} : { portDetail: pushed.error.detail }),
      });
    }
  } else if (currentHead !== preparedHead) {
    // Any unrelated head is never adopted: preserve the intent, record the
    // closed conflict identity and wait bounded.
    return failBaseRefresh(deps, context, durable, durableIntent, {
      kind: "conflict",
      detail: BASE_REFRESH_FOREIGN_HEAD_DETAIL,
    });
  }
  const publishedGuard = await guardQueueOperation(
    deps,
    context,
    durable,
    "refresh",
    preparedHead,
  );
  if (publishedGuard !== null) return publishedGuard;
  // Success: the refreshed candidate becomes the exact target and the existing
  // publication path requests a fresh review for the new head. For a
  // new-format record the target base/head, the successor descriptor and the
  // published head advance ATOMICALLY here — only after the exact publication
  // proof — and the old H1 target/descriptor is retained until this point.
  // Branch, PR, checkpoint, counters, source, evidence and prior reviews are
  // preserved.
  const doneAt = deps.clock.now();
  const acknowledgedCustody = await checkExistingPrOperation(
    deps,
    context,
    durable,
    {
      operation: "refresh",
      phase: "publish",
      observedBase: expectedBase,
      nextHead: preparedHead,
      ...(preservationRef === null ? {} : {
        candidate: {
          operationKey: intent.key,
          base: expectedBase,
          head: preparedHead,
          ref: preservationRef,
        },
      }),
    },
  );
  if (acknowledgedCustody !== null) return acknowledgedCustody;
  const refreshed = acknowledgeBaseRefresh(
    durable,
    durableIntent,
    preservationRef,
    doneAt,
  );
  return persistWork(
    deps,
    context,
    refreshed,
    hasTakeoverCustody(durable) ? context.head! : undefined,
  );
}

/** Shared exact acknowledgment; callers must first prove publication and custody. */
export function acknowledgeBaseRefresh(
  durable: WorkRecordV1,
  intent: IncompleteOperationV1,
  preservationRef: string | null,
  doneAt: number,
): WorkRecordV1 {
  const preparedHead = intent.resultId;
  const expectedBase = intent.observedBase;
  if (
    intent.kind !== "base_refresh" || !isGitSha(preparedHead) ||
    !isGitSha(expectedBase) || intent.expectedHead !== durable.target.head ||
    intent.branch !== durable.target.branch || intent.pr !== durable.target.pr
  ) throw new TypeError("base refresh acknowledgment identity mismatch");
  const candidateState = durable.target.candidateState;
  return {
    ...durable,
    target: candidateState === undefined || preservationRef === null
      ? { ...durable.target, base: expectedBase, head: preparedHead }
      : {
        ...durable.target,
        base: expectedBase,
        head: preparedHead,
        candidateState: {
          preserved: {
            operationKey: intent.key,
            base: expectedBase,
            head: preparedHead,
            ref: preservationRef,
          },
          publishedHead: preparedHead,
        },
      },
    nextStep: "work",
    wait: null,
    blocker: null,
    intent: null,
    updatedAt: doneAt,
  };
}

/**
 * The record's OWN publication may have been merged or closed unmerged while
 * a refresh intent was parked across runs. A refresh can never complete
 * against a published disposition, so it is reconciled before any refresh
 * work: a human merge is terminal for capacity and is never republished, and
 * a closed-unmerged pull request retires the closed publication so the next
 * publish step creates its replacement for the same preserved candidate. A
 * resolved conflict merge whose pull request was closed keeps the terminal
 * conflict block instead: its one charge per base tip is spent, and a
 * republished H would only conflict at the same base again. A foreign branch
 * at that number and an unreadable observation change nothing (the
 * observation is a bounded failure, never a fabricated disposition). Returns
 * null when the publication is still the record's open pull request.
 */
export async function reconcileRefreshPublication(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  intent: IncompleteOperationV1,
): Promise<StepResultV1 | null> {
  const queueGuard = await guardQueueOperation(
    deps,
    context,
    record,
    "refresh",
  );
  if (queueGuard !== null) return queueGuard;
  if (record.target.pr === null) return null;
  const pull = await deps.github.readPullRequest(record.target.pr);
  if (!pull.ok) {
    return failBaseRefresh(deps, context, record, intent, {
      kind: pull.error.kind,
      detail: BASE_REFRESH_PR_OBSERVATION_DETAIL,
      portDetail: pull.error.detail,
    });
  }
  if (pull.value === null || pull.value.headRef !== record.target.branch) {
    return null;
  }
  const at = deps.clock.now();
  if (pull.value.state === "merged") {
    return persistWork(
      deps,
      context,
      clearIntent(markBlocked(record, "other", RETIRED_MERGED_MESSAGE, at), at),
    );
  }
  if (pull.value.state !== "closed" || pull.value.mergeSha !== null) {
    return null;
  }
  if (resolvedConflictResolution(intent) !== null) {
    return persistWork(
      deps,
      context,
      markTerminalBlocked(
        record,
        "other",
        `base refresh has conflicts at ${intent.observedBase}`,
        at,
      ),
    );
  }
  return persistWork(
    deps,
    context,
    clearIntent(retireClosedPublication(record, at, "work"), at),
  );
}

/**
 * Regenerate the deterministic refresh commit through the optional trusted
 * port capability (a fresh run reproduces the identical SHA after a runner
 * disappeared). A known merge conflict schedules the one charged conflict
 * resolution of this exact (head, base) while that route is open and the
 * record keeps its shape (`conflict-resolution.ts`); otherwise it blocks with
 * the existing terminal conflict message.
 */
async function prepareRefreshHead(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  intent: IncompleteOperationV1,
  config: RepositoryConfigV1,
): Promise<{ kind: "regenerated"; head: GitSha } | StepResultV1> {
  const expectedBase = intent.observedBase;
  const persistedPrepared = intent.resultId;
  if (
    expectedBase === null || !isGitSha(expectedBase) ||
    (persistedPrepared !== null && !isGitSha(persistedPrepared)) ||
    record.target.pr === null || record.target.head === null ||
    record.target.branch === null
  ) {
    return {
      kind: "state_error",
      detail: "base refresh intent identity mismatch",
    };
  }
  const prepare = deps.github.prepareBaseRefresh?.bind(deps.github);
  if (prepare === undefined) {
    // Capability absence is an explicit bounded wait: the durable intent and
    // the old candidate are preserved and no deprecated path is taken. The
    // bounded failure record still applies, so a permanently missing
    // capability becomes a classified blocker instead of a silent loop.
    return failBaseRefresh(deps, context, record, intent, {
      kind: "unavailable",
      detail: BASE_REFRESH_CAPABILITY_DETAIL,
    });
  }
  const authority = await prepareExistingPrEffect(deps, context, record, {
    operation: "refresh",
    phase: "prepare",
    observedBase: expectedBase,
    ...(persistedPrepared === null ? {} : { nextHead: persistedPrepared }),
  });
  if (!authority.ok) {
    return {
      kind: "deferred",
      detail: "existing PR refresh preparation custody unavailable",
    };
  }
  const prepared = await prepare({
    pullRequestNumber: record.target.pr,
    branch: record.target.branch,
    expectedHead: record.target.head,
    previousBase: record.target.base,
    expectedBase,
    ...(persistedPrepared === null ? {} : { preparedHead: persistedPrepared }),
  }, authority.value);
  if (!prepared.ok) {
    if (queueEffectRefused(prepared.error)) {
      return holdQueueRecord(
        deps,
        context,
        record,
        queueRefusalIsTransient(prepared.error),
      );
    }
    if (
      prepared.error.kind === "conflict" &&
      prepared.error.detail === BASE_REFRESH_CONFLICT_DETAIL
    ) {
      const at = deps.clock.now();
      // An open conflict-resolution route schedules ONE charged resolution
      // of this exact conflict: the pending refresh intent keeps its key and
      // the PR identity and carries the conflict marker; nothing is charged
      // until the resolution is admitted.
      if (
        conflictResolutionRouteOpen(deps) &&
        conflictResolutionShape(
          record,
          context.snapshot,
          legacyCutoff(context),
        )
      ) {
        return persistWork(
          deps,
          context,
          pendingConflictRecord(record, intent, expectedBase, at),
        );
      }
      // Otherwise a known deterministic merge conflict retains the candidate,
      // spends no model work and blocks with the existing blocker fields. The
      // exact base the candidate conflicts with is recorded in the existing
      // message (the legacy bare "base refresh has conflicts" stays a valid
      // blocker). Every other failure (identity mismatch, moved base, bounds,
      // unavailable objects) keeps the exact durable intent and waits bounded
      // below.
      return persistWork(
        deps,
        context,
        markTerminalBlocked(
          clearIntent(record, at),
          "other",
          `base refresh has conflicts at ${expectedBase}`,
          at,
        ),
      );
    }
    if (persistedPrepared === null) {
      // No authorized push can exist before the prepared result was persisted.
      // Re-observe the configured base under the shared cooldown: a SECOND
      // movement after this intent was written clears ONLY this unprepared
      // intent so the next step plans a fresh one against the newest base.
      // Target, source, counters, reviews, evidence and history are preserved.
      const cooling = await checkGithubCooldown(
        deps,
        record.repository,
        context.bounds,
      );
      if (cooling.kind === "state_error") {
        return { kind: "state_error", detail: cooling.detail };
      }
      if (cooling.kind === "deferred") {
        return { kind: "deferred", detail: cooling.detail };
      }
      const currentBase = await deps.github.readRef(
        `refs/heads/${config.baseBranch}`,
      );
      const observedAt = deps.clock.now();
      if (!currentBase.ok || currentBase.value === null) {
        // A failed ref read retains the exact intent with a bounded wait and a
        // bounded failure record (never a fabricated "unchanged" base).
        return failBaseRefresh(deps, context, record, intent, {
          kind: currentBase.ok ? "unavailable" : currentBase.error.kind,
          detail: BASE_REFRESH_BASE_READ_DETAIL,
          ...(currentBase.ok ? {} : { portDetail: currentBase.error.detail }),
        });
      }
      if (currentBase.value.sha !== expectedBase) {
        // Clear only this unprepared intent; the same run replans a fresh
        // refresh against the newly observed base before any model/review
        // spend. No other intent is ever cleared here.
        return persistWork(deps, context, clearIntent(record, observedAt));
      }
    }
    return failBaseRefresh(deps, context, record, intent, {
      kind: prepared.error.kind,
      detail: BASE_REFRESH_UNPREPARED_DETAIL,
      portDetail: prepared.error.detail,
    });
  }
  const preparedHead = prepared.value;
  if (!isGitSha(preparedHead)) {
    return {
      kind: "state_error",
      detail: "base refresh prepared identity invalid",
    };
  }
  if (persistedPrepared !== null && persistedPrepared !== preparedHead) {
    // The persisted deterministic result must regenerate byte-identically.
    return {
      kind: "state_error",
      detail: "base refresh prepared identity mismatch",
    };
  }
  return { kind: "regenerated", head: preparedHead };
}
