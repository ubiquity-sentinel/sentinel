/** Preserved candidate and exact pull-request lifecycle fixtures. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubPullRequestV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import type { FakeGithubCandidateLifecycleV1 } from "./helpers.ts";
import { SHA4 } from "./loop-rig.ts";

export const CANDIDATE_REF = `refs/heads/sentinel-candidates/${
  "ab".repeat(32)
}`;
export const PRODUCING_RESERVATION = "cd".repeat(32);
export const CHECK_POLL_MS = 5 * 60_000;
/** Candidate head used by the candidate-state fixtures. */
export const H0 = SHA2;
export const H1 = SHA4;

/**
 * Explicit per-test positive lifecycle callbacks. These callbacks simulate
 * capability success over the fake ports (no storage); real preservation
 * storage evidence comes only from the existing destructive host fixtures. A
 * base refresh must never run while the configured base is unchanged.
 */
export function positiveLifecycle(): FakeGithubCandidateLifecycleV1 {
  return {
    preserveCandidate: (request) => {
      assert.ok(request.taskId.length > 0, "preservation task identity");
      assert.match(
        request.candidate.ref,
        /^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/,
        "preservation ref identity",
      );
      assert.match(
        request.candidate.operationKey,
        /^impl:[0-9a-f]{64}$/,
        "preservation operation identity",
      );
      assert.equal(request.candidate.head.length, 40);
      assert.equal(request.candidate.base.length, 40);
      return Promise.resolve(portOk(undefined));
    },
    prepareBaseRefresh: () => {
      throw new Error("a base refresh must never run for an unchanged base");
    },
  };
}

/** Exact open PR bound to the candidate branch/head/base. */
export function exactOpenPr(
  number: number,
  head: GitSha,
  headRef: string,
  base: GitSha = SHA1,
): GitHubPullRequestV1 {
  return {
    number,
    title: "Sentinel repair",
    body: "Refs 1",
    state: "open",
    head,
    base,
    mergeSha: null,
    headRef,
    baseRef: "development",
    author: null,
    createdAt: T0,
    updatedAt: T0,
    mergedAt: null,
    reviewDecision: "none",
  };
}

export function candidateStateFor(
  base: GitSha,
  head: GitSha | null,
): Record<string, unknown> {
  return head === null ? { preserved: null, publishedHead: null } : {
    preserved: {
      operationKey: implementationIntentKey(PRODUCING_RESERVATION),
      base,
      head,
      ref: CANDIDATE_REF,
    },
    publishedHead: head,
  };
}

/** Preserved/published issue candidate bound to its exact branch and PR. */
export function preservedIssueWork(
  id: string,
  head: GitSha,
  options: {
    base?: GitSha;
    /** Explicit null models a preserved-but-never-published candidate. */
    publishedHead?: GitSha | null;
    pr?: number | null;
    nextStep?: WorkRecordV1["nextStep"];
    counters?: WorkRecordV1["counters"];
  } = {},
): WorkRecordV1 {
  const workId = asWorkItemId(id);
  const base = options.base ?? SHA1;
  return workRecord(id, {
    source: { kind: "issue", id, revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base,
      branch: candidateBranch(workId),
      checkpoint: null,
      head,
      pr: options.pr === undefined ? 7 : options.pr,
      candidateState: {
        preserved: {
          operationKey: implementationIntentKey(PRODUCING_RESERVATION),
          base,
          head,
          ref: CANDIDATE_REF,
        },
        publishedHead: options.publishedHead === undefined
          ? head
          : options.publishedHead,
      },
    },
    nextStep: options.nextStep ?? "work",
    counters: options.counters ?? { attempts: 1, retries: 0, reviewRounds: 1 },
  });
}

/** Stable candidate/accounting subset that no freshness refusal may alter. */
export function candidateAccounting(record: WorkRecordV1): unknown {
  // `counters.stalled` is the per-record no-progress budget, not candidate or
  // attempt accounting: a refused/failed read legitimately advances it while
  // the charged counters and the candidate bytes stay exactly as recorded.
  const { stalled: _noProgress, ...chargedCounters } = record.counters;
  return {
    id: record.id,
    source: record.source,
    fingerprint: record.fingerprint,
    target: record.target,
    counters: chargedCounters,
    dependencies: record.dependencies,
    controller: record.controller,
    evidence: record.evidence,
  };
}

/** Exact closed-unmerged PR bound to the candidate branch/head/base. */
export function exactClosedPr(
  number: number,
  head: GitSha,
  headRef: string,
  base: GitSha = SHA1,
): GitHubPullRequestV1 {
  return {
    ...exactOpenPr(number, head, headRef, base),
    state: "closed",
    mergeSha: null,
  };
}
