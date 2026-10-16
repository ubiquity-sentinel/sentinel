/**
 * The two closed parked-preservation classes the disposition pass owns, their
 * native repository surface and one real hosted maintenance run.
 */
import assert from "node:assert/strict";
import { deriveReservationId } from "../../src/budget/mod.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { MATRIX_PRESERVATION_UNCERTAINTY_DETAIL } from "../../src/host/matrix-uncertainty-maintenance.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  type HostedAutonomyGitHubV1,
  type HostedAutonomyResultV1,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import {
  snapshotOf,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";

export const REPO = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
};
export const BASE = SHA1;
export const HEAD = SHA2;
export const TIP = SHA3;
export const DAY = 24 * 60 * 60 * 1000;
export const UNRECOVERABLE = "candidate preservation unrecoverable";
export const REFUSED = "candidate preservation validation refused";

export type Charge = ReturnType<typeof reservation>;

/** The consumed admission that produced one exact candidate. */
export interface ProducerOptions {
  /** A request id to charge instead of the derived one. */
  dedicated?: string;
  attempt?: number;
  purpose?: "implementation" | "retry";
}

async function producer(
  id: string,
  options: ProducerOptions,
  fallbackAttempt: number,
): Promise<{ requestId: string; charge: Charge; attempt: number }> {
  const attempt = options.attempt ?? fallbackAttempt;
  const purpose = options.purpose ?? "retry";
  const requestId = options.dedicated ?? await deriveReservationId({
    repository: REPO,
    taskId: id as never,
    head: BASE,
    attempt,
    purpose,
  });
  const charge = reservation(requestId, {
    repository: REPO,
    taskId: id,
    attempt,
    head: BASE,
    purpose,
    outcome: "submitted",
    createdAt: T0 - 1000,
    settledAt: T0,
  });
  return { requestId, charge, attempt };
}

/** Historical matrix custody parked with its pending preservation intent. */
export async function parkedFixture(
  options: ProducerOptions & { issue?: number } = {},
): Promise<{ record: WorkRecordV1; charge: Charge }> {
  const issue = options.issue ?? 754;
  const id = `issue-ubiquity-ai.ubq.fi-${issue}`;
  const { requestId, charge, attempt } = await producer(id, options, 2);
  const key = implementationIntentKey(requestId);
  const record = workRecord(id, {
    repository: REPO,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: MATRIX_PRESERVATION_UNCERTAINTY_DETAIL,
      since: T0 + 500,
    },
    counters: { attempts: attempt, retries: 0, reviewRounds: 0 },
    intent: {
      kind: "candidate_preservation",
      key,
      startedAt: T0,
      branch: await candidatePreservationRef(REPO, id as never, key),
      expectedHead: HEAD,
      observedBase: BASE,
      pr: null,
      requestId,
      resultId: null,
    },
    target: {
      base: BASE,
      branch: candidateBranch(id as never),
      candidateState: { preserved: null, publishedHead: null },
      checkpoint: null,
      head: HEAD,
      pr: null,
    },
  });
  return { record, charge };
}

/** The runtime's trusted-validator refusal of one exact unpublished head. */
export async function refusedFixture(
  options: ProducerOptions & { message?: string } = {},
): Promise<{ record: WorkRecordV1; charge: Charge }> {
  const id = "issue-ubiquity-ai.ubq.fi-427";
  const { charge, attempt } = await producer(id, options, 3);
  const record = workRecord(id, {
    repository: REPO,
    source: { kind: "issue", id: "427", revision: SHA1 },
    related: { incidentId: null, issueNumber: 427 },
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: options.message ?? REFUSED,
      since: T0 + 500,
    },
    counters: { attempts: attempt, retries: 0, reviewRounds: 0 },
    target: {
      base: BASE,
      branch: candidateBranch(id as never),
      candidateState: { preserved: null, publishedHead: null },
      checkpoint: null,
      head: HEAD,
      pr: null,
    },
  });
  return { record, charge };
}

export interface Facts {
  issueOpen?: boolean;
  tip?: string | null;
  preservationRefAbsent?: boolean | null;
  branchAbsent?: boolean | null;
  headAbsent?: boolean | null;
  baseAbsent?: boolean | null;
  pulls?: { number: number; state: string; head: string | null }[] | null;
  commitCapability?: boolean;
}

/** An explicit null fact is an unreadable observation, never the default. */
const fact = (value: boolean | null | undefined, fallback: boolean) =>
  value === undefined ? fallback : value;

function surface(facts: Facts = {}): HostedAutonomyGitHubV1 {
  const observations = {
    readRefAbsent: (ref: string) =>
      Promise.resolve(
        ref.startsWith("refs/heads/sentinel-candidates/")
          ? fact(facts.preservationRefAbsent, true)
          : fact(facts.branchAbsent, true),
      ),
    listPullsByHead: () =>
      Promise.resolve(facts.pulls === undefined ? [] : facts.pulls),
    readRunTerminal: () => Promise.resolve(null),
    ...(facts.commitCapability === false ? {} : {
      readCommitAbsent: (sha: string) =>
        Promise.resolve(
          sha === HEAD
            ? fact(facts.headAbsent, true)
            : sha === BASE
            ? fact(facts.baseAbsent, false)
            : null,
        ),
    }),
  };
  return {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: (branch: string) =>
      Promise.resolve(
        branch === "development"
          ? (facts.tip === undefined ? TIP : facts.tip)
          : null,
      ),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => Promise.resolve(null),
    readIssueOpen: () => Promise.resolve(facts.issueOpen ?? true),
    merge: () => Promise.resolve(null),
    closeIssue: () => Promise.resolve(false),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    mismatchDisposition: observations,
  };
}

export function runAt(
  state: TransitionState,
  facts: Facts,
  now: number,
): Promise<HostedAutonomyResultV1> {
  return runHostedAutonomy({
    state: state as unknown as StateReadView & RepairStateWriter,
    githubFor: () => surface(facts),
    clock: { now: () => now },
  });
}

/**
 * Runs the real maintenance once and expects nothing written. `unparsed`
 * injects the records past the record parser, so the pass's own binding is
 * exercised even for custody the parser already refuses.
 */
export async function expectUnwritten(
  records: WorkRecordV1[],
  charges: unknown[],
  facts: Facts,
  now: number,
  unparsed = false,
): Promise<HostedAutonomyResultV1> {
  const state = new TransitionState(
    snapshotOf(unparsed ? [] : records, charges),
  );
  if (unparsed) state.snapshot = { ...state.snapshot, work: records };
  const before = canonicalStringify(state.snapshot);
  const result = await runAt(state, facts, now);
  assert.equal(state.writes, 0, JSON.stringify(result));
  assert.equal(canonicalStringify(state.snapshot), before);
  return result;
}

/** Runs the real maintenance once and expects one retention, nothing written. */
export async function expectRetained(
  records: WorkRecordV1[],
  charges: unknown[],
  facts: Facts,
  now: number,
  id: string,
  reason: string,
): Promise<void> {
  const result = await expectUnwritten(records, charges, facts, now);
  assert(
    result.actions.includes(`preservation:${id}:retained:${reason}`),
    JSON.stringify(result),
  );
}

/** Runs the real maintenance once and expects the pass not to judge at all. */
export async function expectNotJudged(
  records: WorkRecordV1[],
  charges: unknown[],
  facts: Facts,
  now: number,
  unparsed = false,
): Promise<void> {
  const result = await expectUnwritten(records, charges, facts, now, unparsed);
  assert(
    !result.actions.some((action) => action.startsWith("preservation:")),
    JSON.stringify(result),
  );
}

/** Runs the real maintenance once and expects exactly these dispositions. */
export async function expectDisposed(
  records: WorkRecordV1[],
  charges: unknown[],
  now: number,
  expected: string[],
): Promise<void> {
  const state = new TransitionState(snapshotOf(records, charges));
  const before = structuredClone(state.snapshot.reservations);
  const result = await runAt(state, {}, now);
  assert.equal(state.writes, 1, JSON.stringify(result));
  assert.deepEqual(
    result.actions.filter((action) => action.includes(":unrecoverable:")),
    expected,
  );
  assert.deepEqual(state.snapshot.reservations, before);
}
