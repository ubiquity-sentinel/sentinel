/**
 * Generated production-shaped repair snapshot for the hot/cold tier suite
 * (shared fixtures only; this module registers no tests).
 *
 * 731 issue work records (416 blocked, 241 done, 56 work, 18 delivery), 2,048
 * live and 549 archived reservations, 593 review receipts, 803 attempt
 * memories and 238 release requests, all in one repository.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { parseAttemptMemoryRecordV1 } from "../../src/contracts/attempt-memory.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { workItemIdForIssue } from "../../src/repair/keys.ts";
import {
  DenoGitRunner,
  type GitRunnerV1,
  type GitRunResultV1,
} from "../../src/state/mod.ts";
import { repairSnapshot } from "./git-state-fixtures.ts";
import {
  releaseRequest,
  REPO,
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "./helpers.ts";

export const DAY = 24 * 60 * 60 * 1000;
/** Pass clock: thirty days after the fixture's old settlements. */
export const NOW = T0 + 30 * DAY;
const OLD = T0;

export const COUNTS = {
  blocked: 416,
  done: 241,
  work: 56,
  delivery: 18,
  reservations: 2048,
  reservationArchive: 549,
  reviews: 593,
  attemptMemory: 803,
  releaseRequests: 238,
} as const;

/** Blocked closed records the fixture deliberately keeps hot (and why). */
export const KEPT_HOT = {
  /** A reservation settled inside the seven-day accounting window. */
  recentSettlement: 1,
  /** A bound review that is still pending. */
  pendingReview: 2,
  /** A live `work` record depends on it. */
  dependency: 5,
} as const;

export const TOTAL_WORK = COUNTS.blocked + COUNTS.done + COUNTS.work +
  COUNTS.delivery;

export function issueNumber(index: number): number {
  return index + 1;
}

export function workId(index: number): string {
  return workItemIdForIssue(REPO, issueNumber(index));
}

export function stepOf(index: number): WorkRecordV1["nextStep"] {
  if (index < COUNTS.blocked) return "blocked";
  if (index < COUNTS.blocked + COUNTS.done) return "done";
  if (index < COUNTS.blocked + COUNTS.done + COUNTS.work) return "work";
  return "delivery";
}

/** Blocked issues with index % 4 === 0 and every live record stay open. */
export function issueOpen(index: number): boolean {
  const step = stepOf(index);
  if (step === "done") return false;
  if (step === "blocked") return index % 4 === 0;
  return true;
}

export function openIssueWorkIds(): Set<string> {
  const open = new Set<string>();
  for (let index = 0; index < TOTAL_WORK; index++) {
    if (issueOpen(index)) open.add(workId(index));
  }
  return open;
}

/** Families the first full demotion must move (blocked-closed + done). */
export function expectedDemotedWork(): Set<string> {
  const ids = new Set<string>();
  const kept = new Set<number>(Object.values(KEPT_HOT));
  for (let index = 0; index < TOTAL_WORK; index++) {
    const step = stepOf(index);
    if (step !== "blocked" && step !== "done") continue;
    if (issueOpen(index) || kept.has(index)) continue;
    ids.add(workId(index));
  }
  return ids;
}

function hex64(prefix: string, index: number): string {
  return `${prefix}${index.toString(16)}`.padStart(64, "0");
}

function work(index: number): WorkRecordV1 {
  const step = stepOf(index);
  const firstWork = COUNTS.blocked + COUNTS.done;
  return workRecord(workId(index), {
    source: { kind: "issue", id: String(issueNumber(index)), revision: SHA1 },
    related: { incidentId: null, issueNumber: issueNumber(index) },
    nextStep: step,
    blocker: step === "blocked"
      ? { kind: "other", message: "fixture blocker", since: OLD }
      : null,
    target: {
      base: SHA1,
      branch: null,
      checkpoint: null,
      head: step === "done" || step === "delivery" ? SHA2 : null,
      pr: step === "done" || step === "delivery" ? 1000 + index : null,
    },
    dependencies: index === firstWork ? [workId(KEPT_HOT.dependency)] : [],
    counters: { attempts: 3, retries: 1, reviewRounds: 1 },
  });
}

/** 2,597 reservations spread over the tasks (four for the first 404). */
function reservations(): BudgetReservationV1[] {
  const rows: BudgetReservationV1[] = [];
  const total = COUNTS.reservations + COUNTS.reservationArchive;
  for (let index = 0; index < TOTAL_WORK && rows.length < total; index++) {
    const perTask = index < 404 ? 4 : 3;
    const live = stepOf(index) === "work" || stepOf(index) === "delivery";
    for (let attempt = 1; attempt <= perTask; attempt++) {
      const id = `res-${String(index).padStart(4, "0")}-${attempt}`;
      const unsettled = live && attempt === perTask;
      const recent = index === KEPT_HOT.recentSettlement && attempt === 1;
      rows.push(reservation(id, {
        taskId: workId(index),
        attempt,
        head: SHA2,
        purpose: attempt === 2 ? "review_request" : "implementation",
        createdAt: recent ? NOW - 2 * DAY : OLD + attempt,
        outcome: unsettled
          ? "reserved"
          : attempt === 3 && index % 7 === 0
          ? "confirmed_not_submitted"
          : "submitted",
        settledAt: unsettled ? null : recent ? NOW - DAY : OLD + 1000,
        proofRef: !unsettled && attempt === 3 && index % 7 === 0
          ? `artifact://proof/${id}`
          : null,
      }));
    }
  }
  return rows;
}

export function reviewRequestId(index: number): string {
  return `res-${String(index).padStart(4, "0")}-2`;
}

/** The generated 731-record snapshot, ordered as the store reads it. */
export function tierFixtureSnapshot(): RepairStateSnapshotV1 {
  const byId = <T extends { id: string }>(rows: T[]) =>
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const all = reservations();
  // The oldest blocked families' rows already sit in the hot archive.
  const archived = all.slice(0, COUNTS.reservationArchive);
  const live = all.slice(COUNTS.reservationArchive);
  const workRows = Array.from(
    { length: TOTAL_WORK },
    (_, index) => work(index),
  );
  const live0 = COUNTS.blocked + COUNTS.done;
  const reviews = Array.from({ length: COUNTS.reviews }, (_, index) => {
    const pending = index >= live0 || index === KEPT_HOT.pendingReview;
    return reviewReceipt(`review-${String(index).padStart(4, "0")}`, {
      requestId: reviewRequestId(index),
      pullRequest: { number: 1000 + index, head: SHA1, base: SHA2 },
      ...(pending ? {} : {
        outcome: "completed",
        observedReviewer: "chatgpt-codex-connector[bot]",
        resultId: `result-${index}`,
        summary: "no findings",
        completedAt: T0 + 1500,
      }),
    });
  });
  const releaseRequests = Array.from(
    { length: COUNTS.releaseRequests },
    (_, offset) => {
      const index = COUNTS.blocked + offset;
      return releaseRequest(`release-${String(index).padStart(4, "0")}`, {
        source: {
          pullRequest: 1000 + index,
          reviewRequestId: reviewRequestId(index),
          reviewReceiptId: null,
          head: SHA1,
          base: SHA2,
        },
        status: "fulfilled",
      });
    },
  );
  const attemptMemory = Array.from(
    { length: COUNTS.attemptMemory },
    (_, index) =>
      parseAttemptMemoryRecordV1({
        version: "v1",
        kind: "attempt_memory",
        id: hex64("a", index),
        repository: REPO,
        taskId: workId(index % TOTAL_WORK),
        base: index < TOTAL_WORK ? SHA1 : SHA2,
        purpose: "implementation",
        entries: [{
          fingerprint: hex64("b", index),
          stage: "model",
          failureClass: "semantic_no_progress",
          detail: "model run did not complete with a trusted candidate",
          controllerSha: SHA2,
          count: 1,
          firstAtMs: T0,
          lastAtMs: T0 + 1000,
        }],
      }),
  );
  return repairSnapshot({
    updatedAt: T0 + 2000,
    work: byId(workRows),
    reservations: byId(live),
    reservationArchive: byId(archived),
    reviews: byId(reviews),
    releaseRequests: byId(releaseRequests),
    attemptMemory: byId(attemptMemory),
  });
}

/** Totals every accounting reader derives from the reservation ledger. */
export function accountingTotals(rows: readonly BudgetReservationV1[]) {
  const byOutcome: Record<string, number> = {};
  const byTask: Record<string, number> = {};
  let charged = 0;
  for (const row of rows) {
    byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
    byTask[row.taskId] = (byTask[row.taskId] ?? 0) + 1;
    if (row.outcome !== "confirmed_not_submitted") charged++;
  }
  return {
    total: rows.length,
    charged,
    byOutcome,
    tasks: Object.keys(byTask).length,
    byTask,
    ids: rows.map((row) => row.id).sort(),
  };
}

/** Counts what each Git child of a store lists and reads. */
export class CountingRunner implements GitRunnerV1 {
  readonly inner: DenoGitRunner;
  catFileShas: string[] = [];
  listedPaths: string[] = [];
  constructor(home: string) {
    this.inner = new DenoGitRunner(home);
  }
  reset(): void {
    this.catFileShas = [];
    this.listedPaths = [];
  }
  async runGit(
    args: string[],
    opts: Parameters<GitRunnerV1["runGit"]>[1],
  ): Promise<GitRunResultV1> {
    const result = await this.inner.runGit(args, opts);
    if (args[0] === "cat-file" && opts.stdin !== undefined) {
      this.catFileShas.push(
        ...new TextDecoder().decode(opts.stdin).split("\n").filter(Boolean),
      );
    }
    if (args[0] === "ls-tree" && result.ok) {
      for (const line of result.stdout.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab !== -1) this.listedPaths.push(line.slice(tab + 1));
      }
    }
    return result;
  }
}

export type { GitSha };
