/**
 * Pure self-merge executor receipts, as the executor persists them on
 * `target.selfMerge` (stage `issue_closed`), and the self record carrying
 * one at the delivery step. Built through the frozen contract parsers; no
 * Git, no network.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseSelfMergeProof,
  type SelfMergeProofV1,
} from "../../src/contracts/self-merge.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { workRecord } from "../state/helpers.ts";

export const SELF_REPOSITORY = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
} as const;

/** A distinct full SHA per seed. */
export const fixtureSha = (seed: number) =>
  seed.toString(16).padStart(40, "0") as GitSha;

/** A receipt's task and Git identity, when a test binds it to its record. */
export interface SelfMergeIdentityV1 {
  taskId: string;
  issueNumber: number;
  headRef: string;
  head: GitSha;
  base: GitSha;
  merge: GitSha;
}

/**
 * The executor's receipt for pull request `pr`: by default for issue
 * `pr - 1` with SHAs derived from `pr`, or bound to `identity`.
 */
export function selfMergeReceipt(
  pr: number,
  prState: SelfMergeProofV1["prState"] = "merged",
  identity: Partial<SelfMergeIdentityV1> = {},
): SelfMergeProofV1 {
  const head = identity.head ?? fixtureSha(pr * 10 + 1);
  const base = identity.base ?? fixtureSha(pr * 10 + 2);
  const tree = fixtureSha(pr * 10 + 3);
  const merge = identity.merge ?? fixtureSha(pr * 10 + 4);
  const headRef = identity.headRef ??
    `sentinel/repair/issue-ubiquity-sentinel-${pr - 1}`;
  return parseSelfMergeProof({
    version: "v1",
    taskId: identity.taskId ?? `issue-ubiquity-sentinel-${pr - 1}`,
    operationKey: `merge:${pr}:${head}`,
    pr,
    headRef,
    head,
    base,
    tree,
    merge,
    ref: `refs/heads/sentinel/self-merge/${"a".repeat(64)}`,
    requestId: `review-request-${pr}`,
    resultId: `review-result-${pr}`,
    issueNumber: identity.issueNumber ?? pr - 1,
    taskDigest: "b".repeat(64),
    ci: {
      proof: {
        version: "v1",
        repository: "ubiquity-sentinel/sentinel",
        repositoryId: 17,
        runId: 500 + pr,
        attempt: 1,
        job: "test-local",
        pr,
        headRef,
        head,
        base,
        testedCommit: head,
        testedTree: tree,
        workflowSource: base,
        sources: { workflow: base, harness: base, emitter: base },
      },
      jobId: 600 + pr,
      checkId: 700 + pr,
    },
    stage: "issue_closed",
    observedTarget: merge,
    prState,
  });
}

/**
 * The self record of pull request `pr` at the delivery step: with the
 * executor's receipt once merged, or without one (before the merge, or a
 * pull request another path merged).
 */
export function selfDeliveryRecord(
  pr: number,
  receipt: SelfMergeProofV1 | null,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  const shape = receipt ?? selfMergeReceipt(pr);
  return workRecord(shape.taskId, {
    repository: SELF_REPOSITORY,
    source: {
      kind: "issue",
      id: String(shape.issueNumber),
      revision: shape.base,
    },
    related: { incidentId: null, issueNumber: shape.issueNumber },
    target: {
      base: shape.base,
      branch: shape.headRef,
      checkpoint: null,
      head: shape.head,
      pr,
      ...(receipt === null ? {} : { selfMerge: receipt }),
    },
    nextStep: "delivery",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}
