/** Shared serial/matrix pre-admission custody coordinator; all writes use V1 CAS. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type {
  TakeoverEffectAuthorization,
  TakeoverOperation,
  TakeoverProofRequest,
} from "../contracts/existing-pr-takeover.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import { EXISTING_PR_TAKEOVER_ACTIVATED } from "../github/existing-pr-takeover-policy.ts";
import {
  hasTakeoverCustody,
  nativeTakeoverIntentKey,
  readTakeoverAnchor,
  TAKEOVER_EVIDENCE_NAMESPACE,
  TAKEOVER_NATIVE_PRESERVED,
  TAKEOVER_NATIVE_PRESERVING,
  takeoverAnchorRef,
} from "../github/existing-pr-takeover-provenance.ts";
import { checkGithubCooldown } from "./loop-bounds.ts";
import { holdQueueRecord } from "./loop-queue-guard.ts";
import { isNativeQueueTarget } from "../github/native-queue-guard.ts";
import { persistTransition, persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  canHoldExistingPrQueuePreflight,
  isExistingPrQueuePreflightHold,
  nativePreserveRequest,
  persistExistingPrQueuePreflightHold,
  persistNativeAnchor,
  persistNativeIntent,
  persistNativePointer,
  resumeExistingPrQueuePreflight,
} from "./loop-existing-pr-state.ts";

export type ExistingPrRoute =
  | { status: "ordinary_new_work_allowed" }
  | { status: "custody_ready" }
  | { status: "step"; step: StepResultV1 };
const ordinary = (): ExistingPrRoute => ({
  status: "ordinary_new_work_allowed",
});
const step = (value: StepResultV1): ExistingPrRoute => ({
  status: "step",
  step: value,
});
const defer = (detail: string): ExistingPrRoute =>
  step({ kind: "deferred", detail });
const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);

async function park(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  reason: string,
  prs: readonly number[] = [],
): Promise<ExistingPrRoute> {
  const message = `existing PR hold: ${reason}${
    prs.length ? ` (${prs.join(",")})` : ""
  }`;
  // Pending anchors must retain their exact restart shape. An error never erases custody.
  if (hasTakeoverCustody(record) || record.blocker?.message === message) {
    return defer(message);
  }
  const now = deps.clock.now();
  return step(
    await persistWork(deps, context, {
      ...record,
      nextStep: "blocked",
      wait: null,
      blocker: { kind: "other", message, since: now },
      updatedAt: now,
    }),
  );
}

/** Adoption is publication custody even before a branch/PR has been persisted. */
async function queuePreflight(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  if (!isNativeQueueTarget(record.repository)) return null;
  try {
    const observed = await deps.github.nativeQueue?.inspect({
      record,
      operation: "publication",
      deadline: context.bounds.runDeadline,
    });
    if (observed?.status === "allow") {
      if (
        record.wait?.reason !== "backoff" || record.wait.until !== null ||
        isExistingPrQueuePreflightHold(record)
      ) return null;
      return {
        kind: "deferred",
        detail: "existing wait is outside takeover preflight custody",
      };
    }
  } catch { /* Failed native observation cannot authorize a custody write. */ }
  if (canHoldExistingPrQueuePreflight(record)) {
    return await persistExistingPrQueuePreflightHold(deps, context, record);
  }
  // A retained wait does not expire into adoption. Only its exact fresh proof may retry it.
  return await holdQueueRecord(deps, context, record);
}

export async function routeExistingPr(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<ExistingPrRoute> {
  if (record.source.kind !== "issue" || record.nextStep === "done") {
    return ordinary();
  }
  const held = hasTakeoverCustody(record);
  const preflightHeld = isExistingPrQueuePreflightHold(record);
  // Ordinary already-bound Sentinel work is not retroactively relabeled as a takeover.
  if (!held && record.target.pr !== null) return ordinary();
  const port = deps.github.existingPrTakeover;
  if (port === undefined) {
    return held || preflightHeld || EXISTING_PR_TAKEOVER_ACTIVATED
      ? defer("existing PR custody capability unavailable")
      : ordinary();
  }
  // Dormant code does not observe or change unmarked work. Retained custody may
  // never fall back to replacement admission when its source policy is disabled.
  if (port.coordinationActivated !== true) {
    return held || preflightHeld
      ? defer("existing PR custody coordination inactive")
      : ordinary();
  }
  const queued = await queuePreflight(deps, context, record);
  if (queued !== null) return step(queued);
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind !== "ok") return step(cooling);
  if (context.head === null || deps.clock.now() >= context.bounds.runDeadline) {
    return defer("existing PR custody state/deadline unavailable");
  }
  try {
    if (
      held && record.blocker?.message !== TAKEOVER_NATIVE_PRESERVING &&
      record.blocker?.message !== TAKEOVER_NATIVE_PRESERVED
    ) {
      const anchor = await readTakeoverAnchor({
        state: deps.state,
        record,
        snapshot: context.snapshot,
        expectedStateHead: context.head,
      });
      if (anchor === null) {
        return defer("existing PR custody ancestry unavailable");
      }
      // This stage does not grant an effect; each later consumer resolves its own proof.
      return { status: "custody_ready" };
    }
    const discovered = await port.discover({
      record,
      deadline: context.bounds.runDeadline,
    });
    if (discovered.status === "unavailable") {
      return defer(`existing PR discovery ${discovered.reason} unavailable`);
    }
    if (discovered.status === "owner_park") {
      return await park(
        deps,
        context,
        record,
        discovered.reason,
        discovered.prNumbers,
      );
    }
    if (discovered.status === "none") {
      if (isExistingPrQueuePreflightHold(record)) {
        return step(
          await resumeExistingPrQueuePreflight(deps, context, record),
        );
      }
      return held
        ? defer("existing PR custody native association lost")
        : ordinary();
    }
    const candidate = discovered.candidate;
    const request = await nativePreserveRequest(context, candidate);
    if (request === null) {
      return defer("existing PR preservation binding unavailable");
    }
    if (!held) {
      if (record.intent !== null || record.target.head !== null) {
        return await park(deps, context, record, "candidate_divergent", [
          candidate.binding.pullRequest,
        ]);
      }
      const authorized = await port.authorizeAdoption({
        record,
        snapshot: context.snapshot,
        expectedStateHead: request.expectedStateHead,
        candidate,
        deadline: request.deadline,
      });
      if (!authorized.ok) {
        return await park(deps, context, record, "principal_unavailable", [
          candidate.binding.pullRequest,
        ]);
      }
      return step(await persistNativeIntent(deps, context, record, request));
    }
    const refs = record.evidence.filter((row) =>
      row.ref.startsWith(TAKEOVER_EVIDENCE_NAMESPACE)
    );
    if (
      !same(refs, [takeoverAnchorRef(request.bindingDigest)]) ||
      record.target.head !== request.head ||
      record.target.base !== request.base ||
      record.target.pr !== request.binding.pullRequest ||
      record.target.branch !== request.binding.headRef ||
      record.target.candidateState?.preserved !== null ||
      record.target.candidateState.publishedHead !== request.head ||
      record.nextStep !== "blocked" || record.wait !== null
    ) return defer("existing PR pending custody identity mismatch");
    if (
      record.blocker?.message === TAKEOVER_NATIVE_PRESERVING &&
      record.intent?.key === nativeTakeoverIntentKey(request)
    ) {
      const preserved = await port.preserveNativeHead(request);
      return preserved.ok
        ? step(await persistNativeAnchor(deps, context, record, request))
        : defer("existing PR native preservation unavailable");
    }
    if (
      record.blocker?.message === TAKEOVER_NATIVE_PRESERVED &&
      record.intent === null
    ) {
      const authorized = await port.authorizeAdoption({
        record,
        snapshot: context.snapshot,
        expectedStateHead: request.expectedStateHead,
        candidate,
        deadline: request.deadline,
      });
      return authorized.ok
        ? step(await persistNativePointer(deps, context, record, request))
        : defer("existing PR anchor authority unavailable");
    }
    return defer("existing PR pending custody unavailable");
  } catch {
    return defer("existing PR custody observation unavailable");
  }
}

/**
 * The parks that existing-PR discovery wrote for an issue another pull request
 * appeared to cover. Owner directive 2026-10-24: other people's pull requests
 * never hold or divert Sentinel's own repair. Takeover custody parks
 * (`closed_publication`, `self_merge_requires_owner`) are not matched.
 */
const RELEASABLE_EXISTING_PR_HOLD =
  /^existing PR hold: (association_unproven|ambiguous|foreign_repository|fork_head|unwritable_branch|protected_path|candidate_divergent|head_moved|source_changed|queue_custody|principal_unavailable|custody_unproven)( \([0-9]+(,[0-9]+)*\))?$/;

/**
 * A discovery park, or the takeover queue-preflight hold, on an issue record
 * without takeover custody or a bound PR.
 */
export function releasableExistingPrHold(record: WorkRecordV1): boolean {
  if (
    record.source.kind !== "issue" || record.target.pr !== null ||
    hasTakeoverCustody(record)
  ) return false;
  if (isExistingPrQueuePreflightHold(record)) return true;
  return record.nextStep === "blocked" && record.wait === null &&
    record.blocker?.kind === "other" &&
    RELEASABLE_EXISTING_PR_HOLD.test(record.blocker.message);
}

/**
 * Return every releasable discovery park to `work` in one checked state
 * transition, where that record's port has discovery off. Intent, target,
 * counters, evidence and reservations are kept; nothing is charged.
 */
async function releaseExistingPrHolds(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  githubFor?: (record: WorkRecordV1) => RepairCycleDepsV1["github"],
): Promise<StepResultV1 | null> {
  const ids = new Set(
    context.snapshot.work.filter((record) =>
      releasableExistingPrHold(record) &&
      (githubFor === undefined ? deps.github : githubFor(record))
          .existingPrTakeover?.coordinationActivated !== true
    ).map((record) => record.id),
  );
  if (ids.size === 0) return null;
  const now = deps.clock.now();
  return await persistTransition(deps, context, (draft) => {
    draft.work = draft.work.map((record) =>
      ids.has(record.id) && releasableExistingPrHold(record)
        ? {
          ...record,
          nextStep: "work",
          blocker: null,
          wait: null,
          updatedAt: now,
        }
        : record
    );
  });
}

/** One deterministic transition per call; callers reload after any progress. */
export async function reconcileExistingPrs(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  attempted: Set<string>,
  refused: Set<string>,
  githubFor?: (record: WorkRecordV1) => RepairCycleDepsV1["github"],
): Promise<StepResultV1 | null> {
  const released = await releaseExistingPrHolds(deps, context, githubFor);
  if (released !== null) return released;
  for (const record of context.snapshot.work) {
    if (
      record.source.kind !== "issue" || record.nextStep === "done" ||
      attempted.has(record.id) ||
      (record.target.pr !== null && !hasTakeoverCustody(record))
    ) continue;
    const routed = await routeExistingPr(
      githubFor === undefined ? deps : { ...deps, github: githubFor(record) },
      context,
      record,
    );
    if (routed.status === "step") {
      if (routed.step.kind !== "progress") {
        attempted.add(record.id);
        refused.add(record.id);
      }
      return routed.step;
    }
    attempted.add(record.id);
  }
  return null;
}

/** Admission/readiness only. Actual effects resolve fresh authority after their state CAS. */
export async function checkExistingPrCustody(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  operation: TakeoverOperation,
): Promise<StepResultV1 | null> {
  if (!hasTakeoverCustody(record)) return null;
  const unavailable: StepResultV1 = {
    kind: "deferred",
    detail: "existing PR operation custody unavailable",
  };
  const port = deps.github.existingPrTakeover;
  if (
    port === undefined || context.head === null || record.target.head === null
  ) return unavailable;
  const request = {
    record,
    snapshot: context.snapshot,
    expectedStateHead: context.head,
    expectedHead: record.target.head,
    operation,
    deadline: context.bounds.runDeadline,
  };
  try {
    const proof = await port.resolve(request);
    return proof.ok && (await port.authorizeEffect(proof.value, request)).ok
      ? null
      : unavailable;
  } catch {
    return unavailable;
  }
}

/** A fresh operation proof for the actual adapter; never serialized into state or worker input. */
export async function prepareExistingPrEffect(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  operation:
    & Pick<
      TakeoverProofRequest,
      | "operation"
      | "phase"
      | "observedBase"
      | "nextHead"
      | "candidate"
      | "taskDigest"
    >
    & { expectedHead?: TakeoverProofRequest["expectedHead"] },
): Promise<PortResultV1<TakeoverEffectAuthorization | undefined>> {
  if (!hasTakeoverCustody(record)) return portOk(undefined);
  const port = deps.github.existingPrTakeover;
  if (
    port === undefined || context.head === null || record.target.head === null
  ) {
    return portError("unavailable", "existing PR effect custody unavailable");
  }
  let expectedHead = operation.expectedHead ?? record.target.head;
  if (
    operation.operation === "refresh" && operation.nextHead !== undefined &&
    operation.expectedHead === undefined
  ) {
    const observed = await deps.github.readRef(
      `refs/heads/${record.target.branch}`,
    );
    if (
      !observed.ok || observed.value === null ||
      observed.value.sha !== record.target.head &&
        observed.value.sha !== operation.nextHead
    ) {
      return portError(
        "unavailable",
        "existing PR prepared publication identity unavailable",
      );
    }
    expectedHead = observed.value.sha;
  }
  const request: TakeoverProofRequest = {
    ...operation,
    record,
    snapshot: context.snapshot,
    expectedStateHead: context.head,
    expectedHead,
    deadline: context.bounds.runDeadline,
  };
  try {
    const proof = await port.resolve(request);
    return proof.ok ? portOk({ proof: proof.value, request }) : proof;
  } catch {
    return portError("unavailable", "existing PR effect custody unavailable");
  }
}

/** One fresh read/bookkeeping authority, distinct from the later concrete effect proof. */
export async function checkExistingPrOperation(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  operation: Parameters<typeof prepareExistingPrEffect>[3],
): Promise<StepResultV1 | null> {
  const grant = await prepareExistingPrEffect(deps, context, record, operation);
  if (grant.ok && grant.value === undefined) return null;
  if (
    grant.ok && grant.value?.kind !== "native_preservation" &&
    grant.value !== undefined &&
    (await deps.github.existingPrTakeover!.authorizeEffect(
      grant.value.proof,
      grant.value.request,
    )).ok
  ) return null;
  return {
    kind: "deferred",
    detail: "existing PR operation custody unavailable",
  };
}
