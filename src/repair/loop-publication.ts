import {
  holdQueueRecord,
  queueEffectRefused,
  queueRefusalIsTransient,
} from "./loop-queue-guard.ts";
import { guardQueueOperation } from "./loop-queue-guard.ts";
/** Repair loop internals: publication. */
import type { GitSha } from "../contracts/brands.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { candidateBranch, pushIntentKey } from "./keys.ts";
import {
  checkExistingPrOperation,
  prepareExistingPrEffect,
} from "./loop-existing-pr.ts";
import { hasTakeoverCustody } from "../github/existing-pr-takeover-provenance.ts";
import { settleReviewCharge } from "./loop-accounting.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import {
  continuePublication,
  createPullRequestFor,
} from "./loop-publication-state.ts";
import {
  configFor,
  retireClosedPublication,
  withPublishedHead,
} from "./loop-records.ts";
import { observeReview } from "./loop-review-observation.ts";
import { requestReviewFor } from "./loop-review-request.ts";
import { loadSnapshot, persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { hasPublishedIdentity } from "./selection.ts";
import {
  clearIntent,
  markTerminalBlocked,
  setIntent,
  setWait,
} from "./transitions.ts";

// ---------------------------------------------------------------------------
// Publish phase (also reconciles every saved operation by exact remote object).
// ---------------------------------------------------------------------------

export async function executePublishStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueOperation(
    deps,
    context,
    record,
    "publication",
  );
  if (queueGuard !== null) return queueGuard;
  const now = deps.clock.now();
  const head = record.target.head;
  if (head === null) {
    return { kind: "state_error", detail: "publish without candidate head" };
  }
  // Publication is a GitHub read/write: gate before any remote effect (the
  // concrete adapter rechecks each remote call; a cooling installation never
  // reaches a fake port or writes a fresh push intent).
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
  const branch = hasTakeoverCustody(record)
    ? record.target.branch
    : candidateBranch(record.id);
  if (branch === null) {
    return {
      kind: "deferred",
      detail: "existing PR publication branch unavailable",
    };
  }

  if (record.intent !== null) {
    return reconcilePublishIntent(deps, context, record, config);
  }

  // A new-format record publishes only a durably preserved candidate: with no
  // descriptor and no pending preservation intent it stops safely instead of
  // regenerating or publishing an unverified head.
  const candidateState = record.target.candidateState;
  if (candidateState !== undefined && candidateState.preserved === null) {
    return {
      kind: "deferred",
      detail: "candidate preservation descriptor unavailable",
    };
  }

  // No unfinished-PR admission cap exists on this surface: a fresh publication
  // is not deferred because other publications are open. Every identity,
  // candidate-preservation, CI, review and merge gate below is unchanged.
  // Push the exact candidate. The expected old ref is the verified published
  // head: an already-published exact candidate is adopted, the exact saved old
  // head is one expected-ref update, and any unrelated head is a conflict that
  // is never overwritten. A missing ref is a creation only with a null saved
  // head. Legacy records keep their existing "existing PR" observation.
  let expectedRemoteHead: GitSha | null = null;
  if (candidateState !== undefined) {
    const ref = await deps.github.readRef(`refs/heads/${branch}`);
    const observedGuard = await guardQueueOperation(
      deps,
      context,
      record,
      "publication",
      ref.ok && ref.value?.sha === head ? head : undefined,
    );
    if (observedGuard !== null) return observedGuard;
    if (!ref.ok) {
      return persistWork(
        deps,
        context,
        setWait(
          record,
          { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
          now,
        ),
      );
    }
    if (ref.value !== null && ref.value.sha === head) {
      const custody = await checkExistingPrOperation(deps, context, record, {
        operation: "publish",
        expectedHead: head,
        nextHead: head,
      });
      if (custody !== null) return custody;
      // The exact candidate is already published: adopt the completed push and
      // persist the publication proof before any PR/review continuation.
      const adopted = withPublishedHead(record, head, deps.clock.now());
      const persisted = await persistWork(
        deps,
        context,
        adopted,
        hasTakeoverCustody(record) ? context.head! : undefined,
      );
      if (persisted.kind !== "progress") return persisted;
      return continuePublication(deps, context, adopted, config);
    }
    if (
      ref.value !== null && ref.value.sha !== candidateState.publishedHead
    ) {
      return persistWork(
        deps,
        context,
        markTerminalBlocked(
          record,
          "other",
          "candidate branch ref identity mismatch",
          deps.clock.now(),
        ),
      );
    }
    if (ref.value === null && candidateState.publishedHead !== null) {
      return persistWork(
        deps,
        context,
        markTerminalBlocked(
          record,
          "other",
          "published candidate ref is missing",
          deps.clock.now(),
        ),
      );
    }
    expectedRemoteHead = ref.value === null ? null : ref.value.sha;
  } else if (record.target.pr !== null) {
    const ref = await deps.github.readRef(`refs/heads/${branch}`);
    const observedGuard = await guardQueueOperation(
      deps,
      context,
      record,
      "publication",
      ref.ok && ref.value?.sha === head ? head : undefined,
    );
    if (observedGuard !== null) return observedGuard;
    if (!ref.ok || ref.value === null) {
      return persistWork(
        deps,
        context,
        setWait(
          record,
          { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
          now,
        ),
      );
    }
    expectedRemoteHead = ref.value.sha;
  }
  const pushIntent = {
    kind: "push" as const,
    key: pushIntentKey(head),
    startedAt: now,
    branch,
    expectedHead: head,
    observedBase: record.target.base,
    pr: null,
    requestId: null,
    resultId: null,
  };
  const withIntent = setIntent(record, pushIntent, now);
  const persisted = await persistWork(deps, context, withIntent);
  if (persisted.kind !== "progress") return persisted;

  // The push intent write is awaited wall-clock time: the total deadline is
  // rechecked before the first publication mutation (no push may start at or
  // after it). The durable push intent lets a later run re-push exactly once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "publication crossed the total run deadline before push",
    };
  }

  const authority = await prepareExistingPrEffect(deps, context, withIntent, {
    operation: "publish",
    expectedHead: expectedRemoteHead ?? undefined,
    nextHead: head,
  });
  if (!authority.ok) {
    return {
      kind: "deferred",
      detail: "existing PR publication custody unavailable",
    };
  }
  const push = await deps.github.pushHead(
    `refs/heads/${branch}`,
    head,
    expectedRemoteHead,
    authority.value,
  );
  if (!push.ok) {
    if (queueEffectRefused(push.error)) {
      return holdQueueRecord(
        deps,
        context,
        withIntent,
        queueRefusalIsTransient(push.error),
      );
    }
    // The saved push intent must stay durable: the response may have been
    // lost after the write, and the next run reconciles the exact remote ref
    // before repeating rather than blindly retrying an ambiguous write.
    return persistWork(
      deps,
      context,
      setWait(
        withIntent,
        { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }
  if (push.value === "ambiguous") {
    return { kind: "progress" }; // reconciled next run by exact ref read
  }
  // The push is a real remote mutation: it may have crossed the total
  // deadline. The finished push must not be repeated or lost, so the durable
  // push intent stays and the run stops; the next run reconciles the exact
  // ref and creates/reuses the PR once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "publication crossed the total run deadline after push",
    };
  }
  // New-format records acknowledge the exact publication proof (publishedHead
  // plus a cleared push intent) BEFORE the PR/review continuation. A legacy
  // record keeps its single pending intent, which the next operation replaces.
  if (candidateState === undefined) {
    return continuePublication(
      deps,
      context,
      { ...record, updatedAt: now },
      config,
    );
  }
  const publishedGuard = await guardQueueOperation(
    deps,
    context,
    withIntent,
    "publication",
    head,
  );
  if (publishedGuard !== null) return publishedGuard;
  const proved = withPublishedHead(withIntent, head, deps.clock.now());
  const provedWrite = await persistWork(deps, context, proved);
  if (provedWrite.kind !== "progress") return provedWrite;
  return continuePublication(deps, context, proved, config);
}

export async function reconcilePublishIntent(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueOperation(
    deps,
    context,
    record,
    "publication",
  );
  if (queueGuard !== null) return queueGuard;
  const intent = record.intent!;
  const now = deps.clock.now();
  // Reconciliation observes exact remote objects: gate before the first
  // external call. A cooldown deferral keeps the intent durable (it is never
  // cleared without an exact observation), so the next run reconciles the same
  // operation exactly once.
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
  if (intent.kind === "push") {
    const candidateState = record.target.candidateState;
    const ref = await deps.github.readRef(`refs/heads/${intent.branch}`);
    const observedGuard = await guardQueueOperation(
      deps,
      context,
      record,
      "publication",
      ref.ok && ref.value?.sha === intent.expectedHead
        ? intent.expectedHead
        : undefined,
    );
    if (observedGuard !== null) return observedGuard;
    if (!ref.ok) {
      return persistWork(
        deps,
        context,
        setWait(
          record,
          { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
          now,
        ),
      );
    }
    if (ref.value === null) {
      // A new-format record that recorded a published head cannot have lost
      // its ref: the contradiction is never overwritten with a creation.
      if (
        candidateState !== undefined && candidateState.publishedHead !== null
      ) {
        return persistWork(
          deps,
          context,
          markTerminalBlocked(
            record,
            "other",
            "published candidate ref is missing",
            now,
          ),
        );
      }
      // The push provably never applied: a new push with expectedRef null is
      // deterministic and non-duplicating.
      const cleared = clearIntent(record, now);
      return persistWork(deps, context, cleared); // next step re-pushes
    }
    if (ref.value.sha !== intent.expectedHead) {
      // The exact saved OLD head means the push never applied: clear the
      // intent and re-push against that verified lease (never a blind create
      // and never an overwrite of an unrelated head).
      if (
        candidateState !== undefined &&
        ref.value.sha === candidateState.publishedHead
      ) {
        return persistWork(deps, context, clearIntent(record, now));
      }
      return persistWork(
        deps,
        context,
        markTerminalBlocked(
          record,
          "other",
          "candidate branch ref identity mismatch",
          now,
        ),
      );
    }
    // The ref read is awaited wall-clock time: if it crossed the total
    // deadline, the push is proven applied and the push intent must stay
    // durable so the next run continues the same publication (PR creation or
    // review request) without repeating the push.
    if (deps.clock.now() >= context.bounds.runDeadline) {
      return {
        kind: "margin",
        detail: "publication continuation crossed the total run deadline",
      };
    }
    const proved = withPublishedHead(record, ref.value.sha, now);
    const custody = await checkExistingPrOperation(deps, context, record, {
      operation: "publish",
      expectedHead: ref.value.sha,
      nextHead: ref.value.sha,
    });
    if (custody !== null) return custody;
    const persisted = await persistWork(
      deps,
      context,
      proved,
      hasTakeoverCustody(record) ? context.head! : undefined,
    );
    if (persisted.kind !== "progress") return persisted;
    // The push may have succeeded immediately before the process stopped. The
    // exact ref observation above is the publication proof; continue the same
    // publication sequence now so a bounded run does not leave a pushed branch
    // without its PR (or its next review request).
    if (proved.target.pr !== null) {
      return requestReviewFor(deps, context, proved, proved.target.pr);
    }
    return createPullRequestFor(deps, context, proved, config);
  }
  if (intent.kind === "pull_request") {
    if (intent.branch === null) {
      return {
        kind: "state_error",
        detail: "PR intent without branch identity",
      };
    }
    const pr = await deps.github.findPullRequestByHeadRef(intent.branch);
    const observedGuard = await guardQueueOperation(
      deps,
      context,
      record,
      "publication",
    );
    if (observedGuard !== null) return observedGuard;
    if (!pr.ok) {
      return persistWork(
        deps,
        context,
        setWait(
          record,
          { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
          now,
        ),
      );
    }
    if (pr.value !== null && pr.value.head === intent.expectedHead) {
      if (pr.value.baseRef !== config.baseBranch) {
        return persistWork(
          deps,
          context,
          markTerminalBlocked(
            record,
            "other",
            "PR base identity mismatch",
            now,
          ),
        );
      }
      const updated = clearIntent(
        { ...record, target: { ...record.target, pr: pr.value.number } },
        now,
      );
      return persistWork(deps, context, updated);
    }
    if (pr.value !== null) {
      return persistWork(
        deps,
        context,
        markTerminalBlocked(
          record,
          "other",
          "PR head identity mismatch",
          now,
        ),
      );
    }
    // The remote PR read is awaited wall-clock time: no PR creation mutation
    // may start at/after the total deadline. The pull_request intent stays
    // durable, so the next run creates the PR exactly once.
    if (deps.clock.now() >= context.bounds.runDeadline) {
      return {
        kind: "margin",
        detail: "PR reconciliation crossed the total run deadline",
      };
    }
    return createPullRequestFor(
      deps,
      context,
      clearIntent(record, now),
      config,
    );
  }
  if (intent.kind === "review_request") {
    const prNumber = intent.pr;
    const head = intent.expectedHead;
    if (prNumber === null || head === null) {
      return { kind: "state_error", detail: "review intent identity missing" };
    }
    // Recovery observes the exact remote review state. The admission charge
    // is preserved as ambiguous (submission may have happened); it is never
    // resubmitted and never charged a second time.
    if (intent.requestId !== null) {
      const settled = await settleReviewCharge(
        deps,
        context,
        intent.requestId,
        "ambiguous",
      );
      if (settled.kind !== "progress") return settled;
    }
    const afterSettlement = await loadSnapshot(deps, context.bounds);
    if (afterSettlement === null) {
      return { kind: "state_error", detail: "repair state unavailable" };
    }
    const current = afterSettlement.snapshot.work.find(
      (work) => work.id === record.id,
    );
    if (current === undefined) {
      return {
        kind: "state_error",
        detail: "work record missing after review reconciliation",
      };
    }
    // The exact PR this review intent names is observed BEFORE the identity is
    // resurrected. A closed-unmerged own PR can never produce a verdict, so the
    // intent is cleared and the publication retired in ONE transition: the next
    // run re-publishes the preserved candidate instead of re-arming the dead PR
    // (the issue-140 livelock, where a closed PR recorded only in intent.pr was
    // re-adopted on every run).
    const dead = await deps.github.readPullRequest(prNumber);
    const observedGuard = await guardQueueOperation(
      deps,
      afterSettlement,
      current,
      "publication",
    );
    if (observedGuard !== null) return observedGuard;
    if (
      dead.ok && dead.value !== null &&
      dead.value.headRef === candidateBranch(current.id) &&
      dead.value.head === head &&
      dead.value.state === "closed" && dead.value.mergeSha === null
    ) {
      return persistWork(
        deps,
        afterSettlement,
        clearIntent(retireClosedPublication(current, now, "work"), now),
      );
    }
    const withPr = {
      ...current,
      target: { ...current.target, pr: prNumber, head },
      nextStep: "review" as const,
      updatedAt: now,
    };
    const persisted = await persistWork(deps, afterSettlement, withPr);
    if (persisted.kind !== "progress") return persisted;
    return observeReview(deps, afterSettlement, withPr);
  }
  return { kind: "state_error", detail: "unsupported publish intent" };
}

/**
 * Attach an existing live PR to a record that has a durable publication intent
 * naming its deterministic branch but no persisted `target.pr` yet. The PR is
 * adopted only when it is OPEN, its head is the record's exact candidate
 * head, and its base is the configured base branch; a foreign or divergent PR
 * is never adopted. This runs before ranking, so discovery precedes selection
 * (issue-141 / PR 433).
 */
export async function reconcileOrphanPublication(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  attempted: Set<string>,
): Promise<StepResultV1 | null> {
  for (const record of context.snapshot.work) {
    if (record.nextStep !== "work") continue;
    if (record.target.pr !== null) continue;
    if (!hasPublishedIdentity(record)) continue;
    const branch = record.target.branch;
    const head = record.target.head;
    if (branch === null || head === null) continue;
    if (attempted.has(record.id)) continue;
    attempted.add(record.id);
    const queueGuard = await guardQueueOperation(
      deps,
      context,
      record,
      "publication",
    );
    if (queueGuard !== null) return queueGuard;
    const config = configFor(deps, record.repository);
    if (config === null) continue;
    const found = await deps.github.findPullRequestByHeadRef(branch);
    const observedGuard = await guardQueueOperation(
      deps,
      context,
      record,
      "publication",
      head,
    );
    if (observedGuard !== null) return observedGuard;
    if (!found.ok) {
      return { kind: "deferred", detail: "orphan PR discovery unavailable" };
    }
    if (
      found.value === null || found.value.head !== head ||
      found.value.state !== "open" ||
      found.value.baseRef !== config.baseBranch
    ) {
      continue;
    }
    const adopted = {
      ...record,
      target: { ...record.target, pr: found.value.number },
      updatedAt: deps.clock.now(),
    };
    return persistWork(deps, context, adopted);
  }
  return null;
}
