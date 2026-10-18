/** Real authority/reader/proof/controller code; fake external API and state storage only. */
import assert from "node:assert/strict";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  portError,
  portOk,
  type ReleaseStateWriter,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import type {
  QueueEntry,
  QueueEvidence,
  QueueSnapshot,
} from "../../src/github/merge-queue-types.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import { createHostedQueueAuthority } from "../../ops/hosted-autonomy-queue-authority.ts";
import { createQueueIntent } from "../../ops/hosted-autonomy-queue-intent.ts";
import type { HostedQueueAuthorityPins } from "../../src/github/queue-runtime-policy.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
} from "../github/helpers.ts";
import {
  APP,
  GROUP_BOT,
  POLICY,
  queueProofFacts,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  T0,
} from "./merge-queue-proof-fixtures.ts";

export async function authorityRig(custody = false) {
  const facts = await queueProofFacts();
  facts.receipt.id = `review-receipt:${"d".repeat(64)}`;
  facts.binding.reviewReceiptId = facts.receipt.id;
  facts.latestReceiptId = facts.receipt.id;
  const task = facts.task;
  assert.ok(task !== null && task !== "unavailable");
  const clock = new FakeClock(T0 + 5000);
  let record = facts.record;
  if (custody) {
    const intent = await createQueueIntent(record, facts.binding, T0 + 2000);
    record = {
      ...record,
      wait: { reason: "backoff", until: null, since: T0 + 2000 },
      intent: { ...intent, resultId: "MQE_7" },
    };
  }
  let snapshot = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0 + 4000,
    work: [record],
    reviews: [facts.receipt],
    reservations: [],
    releaseRequests: [],
    incidents: [],
    evidence: [],
    replays: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  let head = SHA1;
  let release: ReleaseStateSnapshotV1 | null = null;
  let releaseHead: GitSha | null = null;
  const history = new Map([[head, structuredClone(snapshot)]]);
  const toggles = {
    merged: custody,
    issueOpen: true,
    rule: true,
    ruleUnavailable: false,
    workflow: "e".repeat(64),
    overlap: false,
    ci: true,
    optOut: false,
    stateMoved: false,
    mergeable: true,
    tipAncestry: true,
  };
  const state: StateReadView & ReleaseStateWriter = {
    readRepair: () =>
      Promise.resolve(
        portOk({
          status: "found",
          head: toggles.stateMoved ? SHA3 : head,
          snapshot: structuredClone(snapshot),
          ref: "refs/heads/sentinel-state/repair",
        }),
      ),
    readRepairAt: ({ commit, expectedHead }) => {
      assert.equal(expectedHead, head);
      const prior = history.get(commit);
      return Promise.resolve(
        portOk(
          prior === undefined
            ? { status: "absent", currentHead: head, ref: null }
            : {
              status: "found",
              head: commit,
              snapshot: structuredClone(prior),
              ref: null,
            },
        ),
      );
    },
    readRelease: () =>
      Promise.resolve(
        portOk(
          release === null
            ? { status: "absent", currentHead: null, ref: null }
            : {
              status: "found",
              head: releaseHead!,
              snapshot: structuredClone(release),
              ref: "refs/heads/sentinel-state/release",
            },
        ),
      ),
    writeRelease: (next, expected) => {
      if (expected !== releaseHead) {
        return Promise.resolve(
          portOk({ status: "conflict", currentHead: releaseHead }),
        );
      }
      release = structuredClone(next);
      releaseHead = ((next.sequence % 10).toString().repeat(40)) as GitSha;
      return Promise.resolve(portOk({ status: "applied", head: releaseHead }));
    },
  };
  const client = new GitHubQueueDeliveryClient({
    repository: record.repository,
    clock,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    http: () => Promise.reject(new Error("Unexpected external API method")),
  }, 84);
  const rules = [{
    id: 1,
    type: "merge_queue",
    name: null,
    rulesetSourceType: "Repository" as const,
    rulesetSource: "ubiquity/ai.ubq.fi",
    rulesetId: 2,
    parameters: { merge_method: "MERGE" },
  }];
  const policy = {
    ...POLICY,
    workflowSha256: "e".repeat(64) as string | null,
    mergedRemovalReasons: ["MERGED"],
    mergedRemovalBeforeCommit: "pull_head" as const,
  };
  const pins: HostedQueueAuthorityPins = {
    effectiveRulesSha256: await canonicalStringifySha256(rules),
    removalBeforeCommit: "pull_head",
    ciFailureRemovalReasons: ["CHECKS_FAILED"],
    timeoutRemovalReasons: ["CHECKS_TIMEOUT"],
    otherRemovalReasons: ["REMOVED"],
    removalActors: [APP, GROUP_BOT],
  };
  const entry: QueueEntry = {
    id: "MQE_7",
    pull: facts.pull,
    position: 1,
    state: "QUEUED",
    enqueuer: APP,
    enqueuedAt: T0 + 2000,
    baseCommit: SHA3,
    headCommit: SHA4,
    jump: false,
    solo: false,
  };
  let queue: QueueSnapshot = {
    repository: record.repository,
    baseRef: "development",
    baseTip: SHA3,
    queueId: "MQ_1",
    entries: [],
    observedAt: clock.now(),
  };
  let evidence: QueueEvidence = {
    pull: facts.pull,
    entry: null,
    added: custody ? [{ id: "ADD_7", at: T0 + 2000, actor: APP }] : [],
    removed: custody
      ? [{
        id: "REM_7",
        at: T0 + 3000,
        actor: GROUP_BOT,
        reason: "MERGED",
        beforeCommit: SHA2,
      }]
      : [],
    mergeGroupRuns: facts.groupRuns.status === "complete"
      ? facts.groupRuns.value
      : [],
  };
  let nativeReads = 0;
  client.readIssue = () =>
    Promise.resolve(portOk({
      ...task,
      number: task.issueNumber,
      state: toggles.issueOpen ? "open" : "closed",
      author: APP.login,
      labels: toggles.optOut ? ["sentinel:skip"] : [],
      createdAt: T0,
      updatedAt: T0,
      closedAt: toggles.issueOpen ? null : T0 + 4000,
    }));
  const checks = (sha: GitSha) =>
    portOk({
      head: sha,
      checks: [
        "validate",
        "verify-artifact",
        "darwin-native",
        "mac-containment",
      ].map((name) => ({
        name,
        head: sha,
        status: "completed" as const,
        conclusion: toggles.ci ? "success" as const : "failure" as const,
        startedAt: T0,
        completedAt: T0 + 1000,
      })),
    });
  client.readChecks = (sha) => Promise.resolve(checks(sha));
  client.readBaseReviewChecks = (sha) => Promise.resolve(checks(sha));
  client.readBranchRules = () =>
    Promise.resolve(
      toggles.ruleUnavailable
        ? portError("unavailable", "test")
        : portOk(toggles.rule ? rules : []),
    );
  client.readQueueLegacyPull = () =>
    Promise.resolve({
      status: "complete",
      value: {
        pull: {
          number: 7,
          title: "Repair",
          body: "Resolves #1",
          state: toggles.merged ? "merged" : "open",
          head: SHA2,
          base: SHA1,
          mergeSha: toggles.merged ? SHA4 : null,
          headRef: record.target.branch!,
          baseRef: "development",
          author: APP.login,
          createdAt: T0,
          updatedAt: T0,
          mergedAt: toggles.merged ? T0 + 3000 : null,
          reviewDecision: "approved",
        },
        mergedBy: APP,
      },
    });
  client.readQueuePull = () => {
    nativeReads++;
    return Promise.resolve({
      status: "complete",
      value: {
        membership: {
          pull: facts.pull,
          entry: evidence.entry,
          mergedRevision: toggles.merged ? SHA4 : null,
        },
        base: SHA3,
        author: APP.login,
        mergedBy: GROUP_BOT,
      },
    });
  };
  client.readQueue = () => {
    nativeReads++;
    return Promise.resolve({
      status: "complete",
      value: structuredClone(queue),
    });
  };
  client.readPullEvidence = () => {
    nativeReads++;
    // Match the real delivery reader: unmerged removals require the native
    // event reader, exercised with actual HTTP in the removal regression.
    if (!toggles.merged) {
      return Promise.resolve({ status: "unavailable", reason: "incomplete" });
    }
    return Promise.resolve({
      status: "complete",
      value: structuredClone(evidence),
    });
  };
  client.readQueueWorkflowDigest = (revision) =>
    Promise.resolve({
      status: "complete",
      value: {
        revision,
        path: ".github/workflows/deno-deploy.yml",
        sha256: toggles.workflow,
      },
    });
  client.readQueueCommit = (sha) =>
    Promise.resolve({
      status: "complete",
      value: { sha, parents: [SHA3, SHA2], author: APP },
    });
  client.readQueueAncestry = (ancestor, descendant) =>
    Promise.resolve({
      status: "complete",
      value: { ancestor, descendant, isAncestor: toggles.tipAncestry },
    });
  client.readQueuePatch = (base, tip) => {
    const changes = facts.reviewedPatch.status === "complete"
      ? facts.reviewedPatch.value.changes
      : [];
    return Promise.resolve({
      status: "complete",
      value: {
        base,
        head: tip,
        mergeBase: base,
        changes: tip === SHA3 ? (toggles.overlap ? changes : []) : changes,
      },
    });
  };
  client.readRef = () =>
    Promise.resolve(
      portOk({
        ref: "refs/heads/development",
        sha: toggles.merged ? SHA4 : SHA3,
      }),
    );
  const github: HostedAutonomyGitHubV1 = {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: () => Promise.resolve(SHA3),
    hasSuccessfulCheck: () => Promise.resolve(true),
    hasAllChecksGreen: () => Promise.resolve(toggles.ci),
    readPull: () =>
      Promise.resolve({
        number: 7,
        state: toggles.merged ? "closed" : "open",
        merged: toggles.merged,
        mergeCommitSha: toggles.merged ? SHA4 : null,
        headSha: SHA2,
        baseRef: "development",
        baseSha: SHA3,
        author: APP.login,
        parents: [SHA3, SHA2],
        revisionOnBaseBranch: true,
        baseAncestorOfRevision: true,
        mergeable: toggles.mergeable,
      }),
    readIssueOpen: () => Promise.resolve(toggles.issueOpen),
    merge: () =>
      Promise.reject(new Error("No merge authority in reader tests")),
    closeIssue: () =>
      Promise.reject(new Error("No close authority in reader tests")),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.reject(new Error("No approval authority")),
  };
  const options = {
    state,
    clock,
    githubFor: () => github,
    clientFor: () => client,
  };
  const configuration = {
    mode: "on" as const,
    proofActivated: true,
    policy,
    pins,
  };
  const authority = createHostedQueueAuthority({ ...options, configuration });
  return {
    facts,
    clock,
    state,
    client,
    github,
    policy,
    pins,
    configuration,
    options,
    authority,
    toggles,
    entry,
    get snapshot() {
      return snapshot;
    },
    get record() {
      return snapshot.work[0];
    },
    get head() {
      return head;
    },
    get evidence() {
      return evidence;
    },
    get queue() {
      return queue;
    },
    get nativeReads() {
      return nativeReads;
    },
    setEvidence(value: QueueEvidence) {
      evidence = value;
    },
    setQueue(value: QueueSnapshot) {
      queue = value;
    },
    replace(next: typeof snapshot, newHead: GitSha = SHA3) {
      history.set(head, structuredClone(snapshot));
      snapshot = next;
      head = newHead;
    },
    request() {
      return {
        snapshot,
        observedHead: head,
        record: snapshot.work[0],
        binding: null,
        queue,
      };
    },
    deliveryRequest() {
      return {
        snapshot,
        observedHead: head,
        record: snapshot.work[0],
        expectedRevision: SHA4,
        purpose: "delivery" as const,
      };
    },
  };
}
