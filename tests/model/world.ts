/**
 * Concrete world builders for the decision-matrix checker. Every abstract
 * state the checker visits is turned into REAL contract objects here (parsed
 * by the frozen parsers), so the launcher planners and the runtime's pure
 * policy functions are always driven over shapes the state store accepts.
 *
 * The clock sits half a day after the generation-80 activation pin
 * (`LEGACY_REVIEW_CUTOFF`), with R80 installed at generation 80 holding its own
 * healthy proof, exactly the live installation the checker reasons about.
 */
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { parseBudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { HostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import {
  parseReviewReceiptV1,
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
  releaseRequestId,
  reviewOperationKey,
} from "../../src/repair/keys.ts";
import { LEGACY_REVIEW_CUTOFF } from "../../src/repair/review-round-cap.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";

/** The installed generation-80 runtime (R80). */
export const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
/** The one pinned legacy cutoff instant (generation 80's activation bound). */
export const CUTOFF = LEGACY_REVIEW_CUTOFF.activatedNotBefore!;
/** The checker clock: twelve hours after the activation bound. */
export const NOW = CUTOFF + 12 * 3_600_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const BASE = "f1b5a86b80ca4759ab37307484b223907bd1b1d6" as GitSha;
export const TIP = "0a1b2c3d4e5f60718293a4b5c6d7e8f901234567" as GitSha;
export const HEAD = "ae6ff044280a04803958fcd1f6f9304bb894249e" as GitSha;
export const SOURCE = "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha;

/** The live Gateway installation (the legacy class's repository). */
export const GATEWAY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
};
/** The sentinel self scope. */
export const SELF: RepositoryIdentityV1 = {
  owner: "Ubiquity-Sentinel",
  name: "sentinel",
  installationId: 0,
};
export const APP = "ubiquity-sentinel[bot]";

export function workId(repository: RepositoryIdentityV1, issue: number) {
  return `issue-${repository.owner}-${repository.name}-${issue}` as WorkItemId;
}

/** The trusted live statement of one issue, digest-bound like the surface. */
export async function taskStatement(
  issue: number,
  body = `Repair issue ${issue}.`,
): Promise<ReviewTaskStatementV1> {
  const title = `issue ${issue}`;
  return {
    issueNumber: issue,
    title,
    body,
    digest: await reviewTaskStatementDigest({
      issueNumber: issue,
      title,
      body,
    }),
  };
}

/** R80 at generation 80 with its own settled healthy proof. */
export function runtimeRecord(
  revision: GitSha = R80,
  generation = 80,
): HostedRuntimeRecordV1 {
  return {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: revision,
    generation,
    lastHealthyProof: {
      execution: {
        id: "40000000000:1:repair",
        runId: 40000000000,
        runAttempt: 1,
        launcherSha: SOURCE,
        purpose: "candidate",
        revision,
        generation,
        releaseId: "model-checker-release",
        createdAt: CUTOFF + 60_000,
      },
      workflowId: 357012162,
      workflowPath: ".github/workflows/supervisor.yml",
      repository: "Ubiquity-Sentinel/sentinel",
      ref: "refs/heads/sentinel-supervisor",
      jobId: 1,
      startedAt: CUTOFF + 61_000,
      finishedAt: CUTOFF + 62_000,
      observedAt: CUTOFF + 63_000,
      outcome: "healthy",
      startupReady: true,
      settled: true,
      baseSha: BASE,
      terminalAt: CUTOFF + 62_000,
      logDigest: "d".repeat(64),
    },
    lastExecutionProof: null,
    nextOrdinaryAt: NOW,
    execution: null,
    createdAt: CUTOFF,
    updatedAt: CUTOFF + 63_000,
  } as HostedRuntimeRecordV1;
}

export function releaseSnapshot(
  runtime: HostedRuntimeRecordV1 = runtimeRecord(),
): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: CUTOFF + 63_000,
    releases: [],
    hostedRuntimes: [runtime],
    hostedReleases: [],
    githubCooldowns: [],
  });
}

export function charge(
  id: string,
  repository: RepositoryIdentityV1,
  taskId: string,
  overrides: Partial<BudgetReservationV1> = {},
): BudgetReservationV1 {
  return parseBudgetReservationV1({
    version: "v1",
    kind: "budget_reservation",
    repository,
    id,
    taskId,
    attempt: 1,
    head: BASE,
    purpose: "implementation",
    createdAt: NOW - 2 * DAY,
    outcome: "submitted",
    settledAt: NOW - 2 * DAY + 1000,
    proofRef: null,
    ...overrides,
  });
}

/** The abstract record shape the checker concretizes. */
export interface RecordShapeV1 {
  repository: RepositoryIdentityV1;
  issue: number;
  nextStep: WorkRecordV1["nextStep"];
  blocker: WorkRecordV1["blocker"];
  wait: WorkRecordV1["wait"];
  /**
   * `fresh`: no candidate at all. `noted`: a head noted after a run but not
   * yet preserved (`candidateState.preserved` null). `published`: preserved,
   * published, PR open. `unpublished_pr_cleared`: preserved head whose PR
   * identity a terminal block cleared.
   */
  candidate: "fresh" | "noted" | "published" | "pr_cleared";
  /**
   * Retained intent: none, a settled-ambiguous implementation charge, a
   * still-reserved one, a candidate-preservation intent, a conflict
   * marker whose one resolution charge at the base is spent, or the next
   * round's review request whose admission settled ambiguous (the
   * submission may never have landed).
   */
  intent:
    | "none"
    | "impl_ambiguous"
    | "impl_reserved"
    | "preservation"
    | "conflict_spent"
    | "review_ambiguous";
  /**
   * Outcome of the implementation charge the record's attempt consumed;
   * default: `reserved` for a reserved intent, `ambiguous` for an uncertain
   * implementation intent, `submitted` otherwise (a completed run).
   */
  implOutcome?: "ambiguous" | "submitted" | "reserved";
  /** Review rounds spent (unrefunded review_request admissions). */
  rounds: number;
  /** True: those rounds were admitted before the cutoff (legacy class). */
  legacy: boolean;
  /** CI fixes spent (`counters.retries`). */
  ciFixes: number;
  /** Latest completed current-head review. */
  review: "none" | "clean" | "p1" | "unaccepted" | "not_fulfilled";
  /** Pad the task's ledger to at least this many reservations. */
  reservations: number;
  /** Extra counters. */
  stalled?: number;
  /** The candidate head (fleet records need distinct heads). */
  head?: GitSha;
  /** The record's pull request number (default 1000 + issue). */
  pr?: number;
  /** The live issue body the trusted surface returns (default: reviewed). */
  liveBody?: string;
}

export const DEFAULT_SHAPE: Omit<
  RecordShapeV1,
  "nextStep" | "blocker" | "wait" | "candidate"
> = {
  repository: GATEWAY,
  issue: 700,
  intent: "none",
  rounds: 0,
  legacy: false,
  ciFixes: 0,
  review: "none",
  reservations: 0,
};

export interface ConcreteV1 {
  record: WorkRecordV1;
  reservations: BudgetReservationV1[];
  reviews: ReviewReceiptV1[];
  releaseRequests: ReleaseRequestV1[];
  task: ReviewTaskStatementV1;
}

/**
 * A deterministic 64-hex reservation id for one label (the contract binds an
 * implementation operation key to a 64-hex reservation id).
 */
export function hexId(label: string): string {
  // Eight salted 32-bit FNV-1a digests: distinct labels, distinct ids.
  let out = "";
  for (let salt = 0; salt < 8; salt++) {
    let hash = 0x811c9dc5 ^ salt;
    for (const byte of new TextEncoder().encode(label)) {
      hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out;
}

/** Build the concrete record, ledger and receipts of one abstract shape. */
export async function concretize(
  shape: RecordShapeV1,
): Promise<ConcreteV1> {
  const pr = shape.pr ?? 1000 + shape.issue;
  const id = workId(shape.repository, shape.issue);
  const implChargeId = hexId(`${id}:impl`);
  const conflictChargeId = hexId(`${id}:conflict`);
  const reviewChargeId = hexId(`${id}:review-next`);
  const operationKey = implementationIntentKey(implChargeId);
  const reviewed = await taskStatement(shape.issue);
  const task = shape.liveBody === undefined
    ? reviewed
    : await taskStatement(shape.issue, shape.liveBody);
  const branch = candidateBranch(id);
  const reservations: BudgetReservationV1[] = [];
  const candidateHead = shape.head ?? HEAD;
  const head = shape.candidate === "fresh" ? null : candidateHead;
  const published = shape.candidate === "published" ||
    shape.candidate === "pr_cleared";
  const ref = await candidatePreservationRef(
    shape.repository,
    id,
    operationKey,
  );
  // Implementation charges: attempt 1 always; the impl intent names it.
  const implOutcome = shape.implOutcome ??
    (shape.intent === "impl_reserved"
      ? "reserved"
      : shape.intent === "impl_ambiguous"
      ? "ambiguous"
      : "submitted");
  const implCharge = charge(implChargeId, shape.repository, id, {
    purpose: "implementation",
    head: BASE,
    attempt: 1,
    createdAt: NOW - 9 * DAY,
    outcome: implOutcome,
    settledAt: implOutcome === "reserved" ? null : NOW - 9 * DAY + 1000,
  });
  reservations.push(implCharge);
  for (let round = 1; round <= shape.rounds; round++) {
    reservations.push(
      charge(hexId(`${id}:review-${round}`), shape.repository, id, {
        purpose: "review_request",
        head: head ?? HEAD,
        attempt: round,
        createdAt: shape.legacy
          ? CUTOFF - (10 - round) * HOUR
          : CUTOFF + round * 60_000,
        settledAt: shape.legacy
          ? CUTOFF - (10 - round) * HOUR + 1000
          : CUTOFF + round * 60_000 + 1000,
      }),
    );
  }
  for (let fix = 1; fix <= shape.ciFixes; fix++) {
    reservations.push(charge(hexId(`${id}:fix-${fix}`), shape.repository, id, {
      purpose: "retry",
      head: BASE,
      attempt: 1 + fix,
      createdAt: CUTOFF + (10 + fix) * 60_000,
      settledAt: CUTOFF + (10 + fix) * 60_000 + 1000,
    }));
  }
  if (shape.intent === "conflict_spent") {
    reservations.push(charge(conflictChargeId, shape.repository, id, {
      purpose: "retry",
      head: BASE,
      attempt: 2 + shape.ciFixes,
      createdAt: NOW - 3 * HOUR,
      settledAt: NOW - 3 * HOUR + 1000,
    }));
  }
  if (shape.intent === "review_ambiguous") {
    reservations.push(charge(reviewChargeId, shape.repository, id, {
      purpose: "review_request",
      head: head ?? HEAD,
      attempt: shape.rounds + 1,
      createdAt: NOW - 2 * DAY,
      outcome: "ambiguous",
      settledAt: NOW - 2 * DAY + 1000,
    }));
  }
  let pad = 0;
  while (reservations.length < shape.reservations) {
    pad++;
    reservations.push(charge(hexId(`${id}:pad-${pad}`), shape.repository, id, {
      purpose: "continuation",
      head: BASE,
      attempt: 100 + pad,
    }));
  }
  const attempts = Math.max(
    1,
    ...reservations.filter((row) =>
      row.purpose === "implementation" || row.purpose === "retry"
    ).map((row) => row.attempt),
  );
  const intent = (() => {
    switch (shape.intent) {
      case "none":
        return null;
      case "impl_ambiguous":
      case "impl_reserved":
        return {
          kind: "implementation",
          key: operationKey,
          startedAt: NOW - 9 * DAY,
          branch,
          expectedHead: null,
          observedBase: BASE,
          pr: null,
          requestId: implChargeId,
          resultId: null,
        };
      case "preservation":
        return {
          kind: "candidate_preservation",
          key: operationKey,
          startedAt: NOW - 9 * DAY,
          branch: ref,
          expectedHead: candidateHead,
          observedBase: BASE,
          pr: null,
          requestId: implChargeId,
          resultId: null,
        };
      case "conflict_spent":
        // A charged conflict resolution that did not publish: its
        // implementation intent keeps the conflict marker of the base tip
        // its one charge was spent on (`loop-implementation.ts`).
        return {
          kind: "implementation",
          key: implementationIntentKey(conflictChargeId),
          startedAt: NOW - 3 * HOUR,
          branch,
          expectedHead: null,
          observedBase: BASE,
          pr: null,
          requestId: conflictChargeId,
          resultId: null,
          failure: conflictMarker(BASE, NOW - 3 * HOUR),
        };
      case "review_ambiguous":
        return {
          kind: "review_request",
          key: reviewOperationKey(pr, head ?? HEAD, shape.rounds + 1),
          startedAt: NOW - 2 * DAY,
          branch,
          expectedHead: head ?? HEAD,
          observedBase: BASE,
          pr,
          requestId: reviewChargeId,
          resultId: null,
        };
    }
  })();
  const record = parseWorkRecordV1({
    version: "v1",
    kind: "work",
    repository: shape.repository,
    id,
    source: { kind: "issue", id: String(shape.issue), revision: SOURCE },
    related: { incidentId: null, issueNumber: shape.issue },
    fingerprint: null,
    failingRevision: null,
    sourceSnapshotDigest: null,
    classification: { severity: "P2", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    dependencies: [],
    controller: { sha: SOURCE },
    target: {
      base: BASE,
      branch: shape.candidate === "fresh" ? null : branch,
      checkpoint: null,
      head,
      pr: shape.candidate === "published" ? pr : null,
      ...(shape.candidate === "fresh" ? {} : {
        candidateState: {
          preserved: published
            ? {
              operationKey,
              base: BASE,
              head: candidateHead,
              ref,
            }
            : null,
          publishedHead: published ? candidateHead : null,
        },
      }),
    },
    nextStep: shape.nextStep,
    wait: shape.wait,
    blocker: shape.blocker,
    counters: {
      attempts,
      retries: shape.ciFixes,
      reviewRounds: shape.rounds,
      ...(shape.stalled === undefined ? {} : { stalled: shape.stalled }),
    },
    evidence: [],
    intent,
    firstSeenAt: NOW - 20 * DAY,
    createdAt: NOW - 20 * DAY,
    updatedAt: shape.blocker?.since ?? NOW - HOUR,
  });
  const reviews: ReviewReceiptV1[] = [];
  if (shape.review !== "none" && head !== null) {
    reviews.push(
      reviewReceipt(shape.repository, pr, head, BASE, shape.review, reviewed),
    );
  }
  return { record, reservations, reviews, releaseRequests: [], task };
}

/** One completed review of the exact head by the fixed App reviewer. */
export function reviewReceipt(
  repository: RepositoryIdentityV1,
  pr: number,
  head: GitSha,
  base: GitSha,
  verdict: "clean" | "p1" | "unaccepted" | "not_fulfilled",
  task: ReviewTaskStatementV1,
  id = `review-receipt:${pr.toString(16).padStart(8, "0")}${"c".repeat(56)}`,
): ReviewReceiptV1 {
  const p1 = verdict === "p1";
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id,
    requestId: `req-${pr}`,
    expectedReviewer: APP,
    observedReviewer: APP,
    repository,
    pullRequest: { number: pr, head, base },
    outcome: "completed",
    resultId: "msg_0123456789abcdef",
    summary: null,
    findings: p1
      ? [{
        id: "github-review-1-finding-0",
        fingerprint: "f".repeat(64),
        severity: "P1",
        path: "src/a.ts",
        message: "P1 finding",
        resolutionEvidence: null,
        resolved: false,
      }]
      : [],
    findingsUncounted: 0,
    unresolvedSeverities: p1 ? ["P1"] : [],
    submittedAt: CUTOFF + 5 * 60_000,
    completedAt: CUTOFF + 6 * 60_000,
    observedAt: CUTOFF + 7 * 60_000,
    ...(verdict === "unaccepted" ? {} : {
      taskAcceptance: {
        issueNumber: task.issueNumber,
        taskDigest: task.digest,
        verdict: verdict === "not_fulfilled" ? "not_fulfilled" : "fulfilled",
        evidence: ["the reviewed candidate addresses the issue"],
      },
    }),
  });
}

/** A production release request for the record's merged delivery. */
export async function releaseRequest(
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
): Promise<ReleaseRequestV1> {
  const revision = "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293" as GitSha;
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: await releaseRequestId(record.repository, revision, record.target.pr!),
    target: { repository: record.repository, environment: "production" },
    revision,
    source: {
      pullRequest: record.target.pr,
      reviewRequestId: receipt.requestId,
      reviewReceiptId: receipt.id,
      head: record.target.head,
      base: record.target.base,
    },
    status: "open",
    failureReason: null,
    createdAt: NOW - HOUR,
  });
}

export function repairSnapshot(
  parts: readonly ConcreteV1[],
  sequence = 1,
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence,
    updatedAt: NOW - HOUR,
    incidents: [],
    evidence: [],
    work: parts.map((part) => part.record),
    reservations: parts.flatMap((part) => part.reservations),
    reviews: parts.flatMap((part) => part.reviews),
    replays: [],
    releaseRequests: parts.flatMap((part) => part.releaseRequests),
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

/** The exact preservation ref every concretized candidate is preserved at. */
export function preservationRefOf(record: WorkRecordV1): string | null {
  return record.target.candidateState?.preserved?.ref ?? null;
}

export { candidateBranch };

export { RETIRED_TARGET_MESSAGE as RETIRED_MESSAGE } from "../../src/repair/selection.ts";
