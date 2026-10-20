import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { runHostedAutonomy } from "../../ops/hosted-autonomy.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import { makeRig as makeRepairRig, SHA4 } from "../repair/loop-rig.ts";
import {
  exactOpenPr,
  positiveLifecycle,
} from "../repair/loop-candidate-fixtures.ts";
import { check } from "../repair/ci-first-rig.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { releaseSnapshot, repairSnapshot } from "./hosted-autonomy-rig.ts";
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import { parseHostedAutonomyPull } from "../../ops/hosted-autonomy-github-pull.ts";

export const ORIGINAL = SHA3;
export const REJECTED = "cccccccccccccccccccccccccccccccccccccccc" as GitSha;
export const TASK = "issue-ubiquity-ai.ubq.fi-1" as never;
export const BRANCH = candidateBranch(TASK);
export const INITIAL_CHARGE = "a".repeat(64);
export const REJECTED_CHARGE = "b".repeat(64);

/** Real Git custody, fake target/model ports; no external request capability. */
export async function originalCandidateRig(advanced = false) {
  const refreshes: unknown[] = [];
  const rig = await makeRepairRig("original-candidate", {
    summaries: false,
    configOverrides: { repository: REPO, adapter: { kind: "github" } },
    github: {
      openIssues: [],
      baseSha: advanced ? SHA2 : SHA1,
      candidateLifecycle: {
        ...positiveLifecycle(),
        preserveCandidate: (request) => {
          assert.match(
            request.candidate.operationKey,
            /^(impl:[0-9a-f]{64}|base_refresh:\d+:[0-9a-f]{40}:[0-9a-f]{40})$/,
          );
          return Promise.resolve(portOk(undefined));
        },
        refs: { [`refs/heads/${BRANCH}`]: ORIGINAL },
        pullRequests: [exactOpenPr(7, ORIGINAL, BRANCH)],
        prepareBaseRefresh: (request) => {
          refreshes.push(request);
          return Promise.resolve(portOk(SHA4));
        },
      },
    },
  });
  const descriptor = {
    operationKey: implementationIntentKey(INITIAL_CHARGE),
    base: SHA1,
    head: ORIGINAL,
    ref: await candidatePreservationRef(
      REPO,
      TASK,
      implementationIntentKey(INITIAL_CHARGE),
    ),
  };
  const charges = [INITIAL_CHARGE, REJECTED_CHARGE].map((id, i) =>
    reservation(id, {
      repository: REPO,
      taskId: TASK,
      head: SHA1,
      attempt: i + 1,
      purpose: i === 0 ? "implementation" : "retry",
      outcome: "submitted",
      settledAt: T0 + 1000 + i,
    })
  );
  const prior = workRecord(TASK, {
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { issueNumber: 1, incidentId: null },
    failingRevision: null,
    target: {
      base: SHA1,
      branch: BRANCH,
      checkpoint: null,
      head: ORIGINAL,
      pr: 7,
      candidateState: { preserved: descriptor, publishedHead: ORIGINAL },
    },
    counters: { attempts: 2, retries: 1, reviewRounds: 0, stalled: 1 },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(REJECTED_CHARGE),
      requestId: REJECTED_CHARGE,
      startedAt: T0 + 1000,
      branch: BRANCH,
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      resultId: null,
    },
  });
  const seed = await rig.store.writeRepair({
    ...repairSnapshot([prior], [], [], charges),
    updatedAt: T0 + 10_000,
  }, null);
  assert(seed.ok && seed.value.status === "applied");
  const release = await rig.releaseStore.writeRelease(releaseSnapshot(), null);
  assert(release.ok && release.value.status === "applied");
  const blocked = parseWorkRecordV1({
    ...prior,
    nextStep: "blocked",
    intent: null,
    blocker: {
      kind: "other",
      message: "candidate touches a protected path",
      since: T0 + 20_000,
    },
    target: {
      ...prior.target,
      head: REJECTED,
      candidateState: { preserved: null, publishedHead: ORIGINAL },
    },
    updatedAt: T0 + 20_000,
  });
  const seedRead = await rig.store.readRepair();
  assert(seedRead.ok && seedRead.value.status === "found");
  const blockedWrite = await rig.store.writeRepair({
    ...seedRead.value.snapshot,
    stateHead: seedRead.value.head,
    sequence: seedRead.value.snapshot.sequence + 1,
    work: [blocked],
    updatedAt: T0 + 20_000,
  }, seedRead.value.head);
  assert(blockedWrite.ok && blockedWrite.value.status === "applied");
  rig.clock.advance(60_000);
  const observations = {
    base: advanced ? SHA2 : SHA1,
    prBase: SHA1,
    baseRef: "development",
    baseReads: 0,
    moveBaseOnRecheck: false,
    originalGreen: true as boolean | null,
    liveHead: ORIGINAL,
    preserved: ORIGINAL,
    issueOpen: true as boolean | null,
    paths: ["src/app.ts"],
    ancestry: true,
    prOpen: true,
  };
  const github: HostedAutonomyGitHubV1 = {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: (branch) =>
      Promise.resolve(
        branch === "development"
          ? (++observations.baseReads > 1 && observations.moveBaseOnRecheck
            ? SHA2
            : observations.base)
          : branch === BRANCH
          ? observations.liveHead
          : observations.preserved,
      ),
    hasSuccessfulCheck: () => Promise.resolve(true),
    hasAllChecksGreen: () => Promise.resolve(observations.originalGreen),
    readPull: () =>
      Promise.resolve(parseHostedAutonomyPull({
        number: 7,
        state: observations.prOpen ? "open" : "closed",
        merged: false,
        head: { sha: observations.liveHead },
        // REST base.sha / GraphQL baseRefOid can lag the independently read branch target.
        base: { ref: observations.baseRef, sha: observations.prBase },
        user: { login: "ubiquity-sentinel[bot]" },
      })),
    listPullsByHeadRef: () =>
      Promise.resolve([{
        number: 7,
        state: observations.prOpen ? "open" : "closed",
        merged: false,
        headSha: observations.liveHead,
        headRef: BRANCH,
        baseRef: observations.baseRef,
        author: "ubiquity-sentinel[bot]",
      }]),
    readIssueOpen: () => Promise.resolve(observations.issueOpen),
    baseAdvanced: () => Promise.resolve(observations.ancestry),
    mergeBaseTreeChanges: () =>
      Promise.resolve({
        mergeBase: SHA1,
        changes: observations.paths.map((path) => ({
          path,
          oldMode: "100644",
          oldSha: SHA1,
          newMode: "100644",
          newSha: ORIGINAL,
        })),
      }),
    merge: () => Promise.reject(new Error("recovery may not merge")),
    closeIssue: () => Promise.reject(new Error("recovery may not close")),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
  };
  rig.github.readChecks = (head) =>
    Promise.resolve(portOk({ head, checks: [check("ci", head, "success")] }));
  const runMaintenance = async () =>
    runHostedAutonomy(
      await withDarkQueueAuthority({
        state: rig.store,
        githubFor: () => github,
        clock: rig.clock,
      }),
    );
  return {
    rig,
    blocked,
    prior,
    charges,
    descriptor,
    observations,
    github,
    refreshes,
    runMaintenance,
  };
}
