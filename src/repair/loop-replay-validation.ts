/** Repair loop internals: replay validation. */
import type { GitSha } from "../contracts/brands.ts";
import type { IsolatedReplayResultV1 } from "../contracts/ports.ts";
import {
  parseReplayResultV1,
  type ReplayResultV1,
} from "../contracts/replay-result.ts";
import type { EvidenceRefV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { replayEvidenceRef, replayResultId } from "./keys.ts";
import { CHECK_POLL_MS, MAX_OUTPUT_LIMIT_BYTES } from "./loop-bounds.ts";
import { evidenceForRecord, isCausalReplayResult } from "./loop-evidence.ts";
import { configFor, mergeEvidence } from "./loop-records.ts";
import { sameStringArray } from "./loop-replay-evidence.ts";
import { persistTransition } from "./loop-state.ts";
import type {
  CarryV1,
  LoopContextV1,
  RepairCycleDepsV1,
} from "./loop-types.ts";
import { markBlocked, setWait } from "./transitions.ts";

/** Candidate validation before publication (incident tasks only). */
export async function candidateValidated(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  carry: CarryV1,
): Promise<
  | { kind: "blocked"; record: WorkRecordV1 }
  | { kind: "state_error"; detail: string }
  | { kind: "retry" }
  | {
    kind: "ready";
  }
> {
  if (record.source.kind !== "incident") return { kind: "ready" };
  const head = record.target.head;
  if (head === null) return { kind: "retry" };
  const evidence = evidenceForRecord(context.snapshot, record);
  if (evidence === undefined || evidence === null || evidence.replay === null) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "missing_evidence",
        "incident has no replay fixture for candidate validation",
        deps.clock.now(),
      ),
    };
  }
  const config = configFor(deps, record.repository);
  if (config === null) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "unavailable",
        "repository not configured",
        deps.clock.now(),
      ),
    };
  }
  // A cached passed result for the exact current head is publish-ready only
  // when it passes the causal predicate AND every currently carried identity
  // (fixture ref/digest/test ids, replay command, config test command); any
  // mismatch or non-causal saved proof is missing evidence and the saved
  // record is never replaced, cleared or replayed under the same id.
  const existing = context.snapshot.replays.find(
    (result) =>
      result.taskId === record.id &&
      result.candidate.revision === head &&
      result.candidate.outcome === "passed",
  );
  if (
    existing !== undefined &&
    (!isCausalReplayResult(existing, record) ||
      carry.fixtureRef === null ||
      carry.fixtureDigest === null ||
      carry.testIds === null ||
      carry.replayCommandId === null ||
      existing.fixture.ref !== carry.fixtureRef ||
      existing.fixture.digest !== carry.fixtureDigest ||
      !sameStringArray(existing.fixture.testIds, carry.testIds) ||
      existing.commands.replay !== carry.replayCommandId ||
      existing.commands.test !== config.commands.test)
  ) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "missing_evidence",
        "saved replay result does not match current evidence identities",
        deps.clock.now(),
      ),
    };
  }
  if (existing !== undefined) return { kind: "ready" };
  const fixtureDigest = evidence.replay.fixtureDigest;
  if (fixtureDigest === null) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "missing_evidence",
        "replay fixture digest not retained",
        deps.clock.now(),
      ),
    };
  }
  const testIds = carry.testIds;
  if (testIds === null) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "missing_evidence",
        "fixture test identity was not carried from before replay",
        deps.clock.now(),
      ),
    };
  }
  const run = await deps.replay.runReplay({
    taskId: record.id,
    repository: record.repository,
    revision: head,
    commandId: config.commands.test,
    fixtureRef: evidence.replay.fixtureRef,
    fixtureDigest,
    testIds,
    outputLimitBytes: MAX_OUTPUT_LIMIT_BYTES,
  });
  if (!run.ok || run.value.outcome === "unavailable") {
    const at = deps.clock.now();
    return {
      kind: "blocked",
      record: setWait(
        record,
        { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
        at,
      ),
    };
  }
  if (run.value.outcome !== "passed") {
    return { kind: "retry" };
  }
  const after = run.value;
  // Persist the durable causal ReplayResultV1 with exact identities.
  const result = await buildReplayResult(deps, record, carry, after);
  if (result === null) {
    return {
      kind: "blocked",
      record: markBlocked(
        record,
        "other",
        "replay result identity invalid",
        deps.clock.now(),
      ),
    };
  }
  const withEvidence = withReplayEvidence(record, result);
  const persisted = await persistTransition(deps, context, (draft) => {
    const index = draft.work.findIndex((work) => work.id === record.id);
    draft.work[index] = withEvidence;
    if (!draft.replays.some((item) => item.id === result.id)) {
      draft.replays.push(result);
    }
  });
  if (persisted.kind !== "progress") {
    // A failed transition is never converted into a "blocked" write of the
    // ORIGINAL unchanged record: that would make executeWorkStep persist a
    // no-op transition as progress and spin until step_limit. Propagate the
    // real checkpoint failure so the run stops explicitly.
    return persisted.kind === "state_error"
      ? { kind: "state_error", detail: persisted.detail }
      : { kind: "state_error", detail: "candidate replay checkpoint failed" };
  }
  // An after run carrying limitations is not a clean verification: the passed
  // result (combined limitations included) is persisted above first, then the
  // task is blocked with the replay-bearing record so the durable proof
  // survives and is never replayed or replaced under the same id.
  if (after.limitations.length > 0) {
    return {
      kind: "blocked",
      record: markBlocked(
        withEvidence,
        "missing_evidence",
        "candidate replay result carries unresolved limitations",
        deps.clock.now(),
      ),
    };
  }
  return { kind: "ready" };
}

export async function buildReplayResult(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  carry: CarryV1,
  after: IsolatedReplayResultV1,
): Promise<ReplayResultV1 | null> {
  if (
    carry.beforeRun === null || carry.fixtureRef === null ||
    carry.fixtureDigest === null || carry.testIds === null ||
    carry.replayCommandId === null ||
    record.failingRevision === null || record.target.head === null
  ) {
    return null;
  }
  const config = configFor(deps, record.repository);
  if (config === null) return null;
  const id = await replayResultId(
    record.id,
    record.failingRevision,
    record.target.head,
    carry.fixtureDigest,
  );
  const result = {
    version: "v1" as const,
    kind: "replay_result" as const,
    id,
    taskId: record.id,
    repository: record.repository,
    original: readRun(carry.beforeRun, record.failingRevision),
    candidate: readRun(after, record.target.head),
    fixture: {
      ref: carry.fixtureRef,
      digest: carry.fixtureDigest,
      testIds: carry.testIds,
    },
    commands: { replay: carry.replayCommandId, test: config.commands.test },
    expected: { beforeReason: carry.beforeReason },
    limitations: combineUniqueLimitations(
      carry.beforeRun.limitations,
      after.limitations,
    ),
    createdAt: deps.clock.now(),
  };
  try {
    return parseReplayResultV1(result);
  } catch {
    return null;
  }
}

/** Combined order-preserving unique limitation set across both replay runs. */
export function combineUniqueLimitations(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const seen = new Set<string>();
  const combined: string[] = [];
  for (const limitation of [...before, ...after]) {
    if (!seen.has(limitation)) {
      seen.add(limitation);
      combined.push(limitation);
    }
  }
  return combined;
}

export function readRun(result: IsolatedReplayResultV1, revision: GitSha) {
  return {
    revision,
    outcome: result.outcome,
    exitCode: result.exitCode,
    output: result.output,
    failure: result.failure,
  };
}

export function withReplayEvidence(
  record: WorkRecordV1,
  result: ReplayResultV1,
): WorkRecordV1 {
  const ref: EvidenceRefV1 = {
    kind: "replay_result",
    ref: replayEvidenceRef(result.id),
  };
  return {
    ...record,
    evidence: mergeEvidence(record.evidence, [ref]),
    updatedAt: record.updatedAt,
  };
}
