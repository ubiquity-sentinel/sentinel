/**
 * Shared rig for the CI-first review gate (owner decision 2026-10-16: "CI
 * first, then review, then merge"): an issue record whose published head SHA3
 * on PR 7 (base SHA1) waits at `work` for its review request, run through the
 * real repair loop over real Git state with fake GitHub/model ports. The head
 * is unreviewed unless `reviewed` is set. Every state write is captured so a
 * test can prove each one parses under the installed generation-79 runtime.
 */
import assert from "node:assert/strict";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import {
  type GitHubCheckV1,
  portError,
  portOk,
  type PrepareBaseRefreshRequestV1,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type {
  WorkBlockerV1,
  WorkRecordV1,
  WorkWaitV1,
} from "../../src/contracts/work-record.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import {
  candidateBranch,
  reviewOperationKey,
  reviewReceiptId,
} from "../../src/repair/keys.ts";
import { reservation, SHA1, SHA3, T0, workRecord } from "../state/helpers.ts";
import { makeRig, seededSnapshot, SHA4 } from "./loop-rig.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

export const TASK = asWorkItemId("issue-1");
export const BRANCH = candidateBranch(TASK);
export const HOUR = 60 * 60_000;
/**
 * Seeded charges predate the rolling start windows (the test budget allows 5
 * starts per hour and 20 per seven days), so a record carrying many spent
 * rounds is still admitted exactly as the uncapped production budget would.
 */
const SEEDED_AT = T0 - 8 * 24 * HOUR;

export function check(
  name: string,
  head: GitSha,
  conclusion: GitHubCheckV1["conclusion"],
  status: GitHubCheckV1["status"] = "completed",
): GitHubCheckV1 {
  return {
    name,
    status,
    conclusion,
    head,
    startedAt: T0,
    completedAt: status === "completed" ? T0 + 60_000 : null,
  };
}

export interface CiFirstRigOptions {
  /** Check runs by head; an unlisted head reads one green `ci` check. */
  checks: Record<string, GitHubCheckV1[]>;
  /** SHA3 holds a completed clean review against SHA1 (default: none). */
  reviewed?: boolean;
  /** Further review receipts seeded as they are (for example a P1 rejection). */
  reviews?: RepairStateSnapshotV1["reviews"];
  reviewRounds?: number;
  retries?: number;
  attempts?: number;
  nextStep?: WorkRecordV1["nextStep"];
  wait?: WorkWaitV1 | null;
  blocker?: WorkBlockerV1 | null;
  /** Development tip the base ref read reports (record base is SHA1). */
  baseTip?: GitSha;
  /**
   * Prepared refresh commit per refreshed head; a head not listed refuses
   * the refresh (unavailable).
   */
  refreshTo?: Record<string, GitSha>;
  /** Heads the model produces, in order (default: SHA4). */
  heads?: GitSha[];
  /** Run the loop as a hosted (matrix) run does. */
  hosted?: boolean;
  /** The legacy review cutoff the launcher hands the runtime. */
  legacyReviewCutoff?: number;
  /** The record's severity (default: the helper's own). */
  severity?: WorkRecordV1["classification"]["severity"];
  /** Repository, task identity and issue of the record (legacy shapes). */
  identity?: {
    repository: RepositoryIdentityV1;
    id: string;
    issue: number;
  };
}

export async function ciFirstRig(prefix: string, options: CiFirstRigOptions) {
  const rounds = options.reviewRounds ?? 0;
  const retries = options.retries ?? 0;
  const attempts = options.attempts ?? Math.max(1, retries);
  const identity = options.identity;
  const id = identity === undefined ? TASK : asWorkItemId(identity.id);
  const branch = candidateBranch(id);
  const issue = identity?.issue ?? 1;
  const refreshes: PrepareBaseRefreshRequestV1[] = [];
  const rig = await makeRig(prefix, {
    summaries: false,
    ...(options.hosted === true ? { externalImplementations: true } : {}),
    ...(options.legacyReviewCutoff === undefined
      ? {}
      : { legacyReviewCutoff: options.legacyReviewCutoff }),
    ...(identity === undefined ? {} : {
      configOverrides: {
        repository: identity.repository,
        // The sentinel self scope (installation 0) is no gateway target.
        ...(identity.repository.installationId === 0
          ? { adapter: { kind: "github" } }
          : {}),
      },
    }),
    model: { heads: options.heads ?? [SHA4] },
    github: {
      openIssues: [],
      baseSha: options.baseTip ?? SHA1,
      candidateLifecycle: {
        ...positiveLifecycle(),
        // A refreshed candidate is preserved under its refresh operation.
        preserveCandidate: (request) => {
          assert.match(
            request.candidate.operationKey,
            /^(impl:[0-9a-f]{64}|base_refresh:\d+:[0-9a-f]{40}:[0-9a-f]{40})$/,
            "preservation operation identity",
          );
          return Promise.resolve(portOk(undefined));
        },
        refs: { [`refs/heads/${branch}`]: SHA3 },
        pullRequests: [exactOpenPr(7, SHA3, branch)],
        prepareBaseRefresh: (request) => {
          refreshes.push(request);
          const prepared = options.refreshTo?.[request.expectedHead];
          return Promise.resolve(
            prepared === undefined
              ? portError("unavailable", "refresh not exercised by this case")
              : portOk(prepared),
          );
        },
      },
    },
  });
  const checkReads: GitSha[] = [];
  const checks = options.checks;
  rig.github.readChecks = (head: GitSha) => {
    checkReads.push(head);
    return Promise.resolve(
      portOk({ head, checks: checks[head] ?? [check("ci", head, "success")] }),
    );
  };
  const record = workRecord(id, {
    ...(identity === undefined ? {} : { repository: identity.repository }),
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    failingRevision: null,
    target: {
      base: SHA1,
      branch,
      checkpoint: null,
      head: SHA3,
      pr: 7,
    },
    nextStep: options.nextStep ?? "work",
    wait: options.wait ?? null,
    blocker: options.blocker ?? null,
    counters: { attempts, retries, reviewRounds: rounds },
    ...(options.severity === undefined
      ? {}
      : { classification: { severity: options.severity, priority: null } }),
  });
  const reviews = [
    ...(options.reviews ?? []),
    ...(options.reviewed === true
      ? [
        completedReceipt(7, SHA3, SHA1, {
          id: await reviewReceiptId(
            reviewOperationKey(7, SHA3, Math.max(rounds, 1)),
            SHA3,
          ),
          ...(identity === undefined ? {} : {
            repository: identity.repository,
            taskAcceptance: null,
          }),
        }),
      ]
      : []),
  ];
  const charges = [
    reservation("cf-impl-1", {
      ...(identity === undefined ? {} : { repository: identity.repository }),
      taskId: id,
      head: SHA1,
      attempt: 1,
      purpose: "implementation",
      outcome: "submitted",
      createdAt: SEEDED_AT,
      settledAt: SEEDED_AT + 500,
    }),
    ...Array.from(
      { length: attempts - 1 },
      (_, index) =>
        reservation(`cf-retry-${index + 2}`, {
          ...(identity === undefined
            ? {}
            : { repository: identity.repository }),
          taskId: id,
          head: SHA1,
          attempt: index + 2,
          purpose: "retry",
          outcome: "submitted",
          createdAt: SEEDED_AT,
          settledAt: SEEDED_AT + 600,
        }),
    ),
    ...Array.from(
      { length: rounds },
      (_, index) =>
        reservation(`cf-review-${index + 1}`, {
          ...(identity === undefined
            ? {}
            : { repository: identity.repository }),
          taskId: id,
          head: SHA3,
          attempt: index + 1,
          purpose: "review_request",
          outcome: "submitted",
          createdAt: SEEDED_AT,
          settledAt: SEEDED_AT + 900,
        }),
    ),
  ];
  const written = await rig.store.writeRepair(
    seededSnapshot([record], { reviews, reservations: charges }),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  rig.clock.advance(10 * 60_000);
  // Every snapshot the loop writes from here on, exactly as written.
  const writes: RepairStateSnapshotV1[] = [];
  const write = rig.store.writeRepair.bind(rig.store);
  rig.store.writeRepair = (snapshot, expectedHead) => {
    writes.push(structuredClone(snapshot));
    return write(snapshot, expectedHead);
  };
  /** Move the development tip the base ref read reports from now on. */
  const moveBase = (tip: GitSha) => {
    (rig.github as unknown as { options: { baseSha?: GitSha } }).options
      .baseSha = tip;
  };
  /** Replace the check runs one head reports from now on. */
  const setChecks = (head: GitSha, runs: GitHubCheckV1[]) => {
    checks[head] = runs;
  };
  return {
    rig,
    record,
    charges,
    refreshes,
    checkReads,
    writes,
    moveBase,
    setChecks,
  };
}

/** Review admissions this task holds, in creation order. */
export function reviewCharges(
  snapshot: RepairStateSnapshotV1,
  taskId: string = TASK,
) {
  return snapshot.reservations.filter((row) =>
    row.taskId === taskId && row.purpose === "review_request"
  );
}

/** Implementation/retry admissions this task holds. */
export function modelCharges(
  snapshot: RepairStateSnapshotV1,
  taskId: string = TASK,
) {
  return snapshot.reservations.filter((row) =>
    row.taskId === taskId && row.purpose !== "review_request"
  );
}

/** The one record of the rig's task in a snapshot. */
export function taskRecord(
  snapshot: RepairStateSnapshotV1,
  taskId: string = TASK,
): WorkRecordV1 {
  const record = snapshot.work.find((work) => work.id === taskId);
  assert.ok(record !== undefined, `record ${taskId} present`);
  return record;
}

export { SHA4 };
