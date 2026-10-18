import type {
  QueueDeliveryFacts,
  QueueProofPolicy,
} from "../../ops/hosted-autonomy-queue-proof.ts";
import type { QueueAuthorizationFacts } from "../../ops/hosted-autonomy-queue-policy.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import type {
  QueueActor,
  QueueGroupRun,
} from "../../src/github/merge-queue-types.ts";
import {
  PULL,
  QUEUE_REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
} from "../github/merge-queue-fixtures.ts";
import { SHA4 } from "../github/helpers.ts";
import { reviewReceipt, workRecord } from "../state/helpers.ts";

export { SHA1, SHA2, SHA3, SHA4, T0 };
export const APP: QueueActor = {
  type: "Bot",
  nodeId: "BOT_7",
  login: "ubiquity-sentinel[bot]",
};
export const GROUP_BOT: QueueActor = {
  type: "Bot",
  nodeId: "BOT_8",
  login: "github-merge-queue[bot]",
};
export const POLICY: QueueProofPolicy = {
  canaryDigest: "a".repeat(64),
  appActor: APP,
  mergedActors: [APP, GROUP_BOT],
  workflowId: 84,
  historicalDirectManifestDigest: "b".repeat(64),
  historicalDirectWitnesses: [],
};
export async function queueProofFacts(): Promise<QueueDeliveryFacts> {
  const text = {
    issueNumber: 1,
    title: "Repair the gateway",
    body: "Handle the failure.",
  };
  const task = { ...text, digest: await reviewTaskStatementDigest(text) };
  const receipt = reviewReceipt("review-1", {
    repository: QUEUE_REPO,
    expectedReviewer: APP.login,
    observedReviewer: APP.login,
    pullRequest: { number: 7, head: SHA2, base: SHA1 },
    outcome: "completed",
    resultId: "result-1",
    completedAt: T0 + 1000,
    taskAcceptance: {
      issueNumber: 1,
      taskDigest: task.digest,
      verdict: "fulfilled",
      evidence: ["The reviewed test proves the task."],
    },
  });
  const binding = {
    repository: QUEUE_REPO,
    pullRequest: 7,
    base: SHA1,
    head: SHA2,
    reviewRequestId: receipt.requestId,
    reviewReceiptId: receipt.id,
    taskDigest: task.digest,
  };
  const record = workRecord("issue-1", {
    repository: QUEUE_REPO,
    nextStep: "delivery",
    target: {
      base: SHA1,
      head: SHA2,
      branch: PULL.headRef,
      checkpoint: null,
      pr: 7,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 3 },
  });
  const changes = [{
    path: "src/fix.ts",
    oldMode: "100644",
    oldSha: SHA1,
    newMode: "100644",
    newSha: SHA2,
  }];
  const run: QueueGroupRun = {
    id: 83,
    attempt: 1,
    head: SHA4,
    event: "merge_group",
    workflowId: 84,
    workflowPath: ".github/workflows/deno-deploy.yml",
    suiteId: 85,
    status: "completed",
    conclusion: "success",
    checks: ["validate", "verify-artifact", "darwin-native", "mac-containment"]
      .map((name, index) => ({
        id: 90 + index,
        suiteId: 85,
        head: SHA4,
        name,
        appId: 15368,
        status: "completed",
        conclusion: "success",
      })),
  };
  return {
    binding,
    record,
    receipt,
    latestReceiptId: receipt.id,
    task,
    optedOut: false,
    pull: PULL,
    publicationAuthor: APP.login,
    revision: SHA4,
    mergedBy: GROUP_BOT,
    commit: { sha: SHA4, parents: [SHA3, SHA2], author: APP },
    reachable: {
      status: "complete",
      value: { revision: SHA4, branch: "development", reachable: true },
    },
    ancestry: {
      status: "complete",
      value: { ancestor: SHA1, descendant: SHA3, isAncestor: true },
    },
    reviewedPatch: {
      status: "complete",
      value: { base: SHA1, head: SHA2, mergeBase: SHA1, changes },
    },
    integratedPatch: {
      status: "complete",
      value: { base: SHA3, head: SHA4, mergeBase: SHA3, changes },
    },
    originalPatch: null,
    queue: {
      status: "complete",
      value: { binding, enqueuer: APP, evidenceIds: ["EV_1", "MQE_7"] },
    },
    anyQueueEvidence: true,
    groupRuns: { status: "complete", value: [run] },
    directWitness: null,
  };
}
export async function directProofFacts(): Promise<QueueDeliveryFacts> {
  const facts = await queueProofFacts();
  facts.commit = { sha: SHA4, parents: [SHA1, SHA2], author: APP };
  facts.mergedBy = APP;
  if (facts.integratedPatch.status === "complete") {
    facts.integratedPatch.value = {
      ...facts.integratedPatch.value,
      base: SHA1,
      mergeBase: SHA1,
    };
  }
  facts.queue = { status: "complete", value: null };
  facts.anyQueueEvidence = false;
  facts.groupRuns = { status: "complete", value: [] };
  facts.directWitness = {
    binding: facts.binding,
    revision: SHA4,
    provenance: {
      kind: "trusted_success",
      operationId: "merge:7",
      witnessDigest: "c".repeat(64),
    },
  };
  return facts;
}
export async function queueAuthorizationFacts(): Promise<
  QueueAuthorizationFacts
> {
  const facts = await queueProofFacts();
  return {
    binding: facts.binding,
    membership: {
      status: "complete",
      value: { pull: PULL, entry: null, mergedRevision: null },
    },
    reviewAuthorized: true,
    latestReceiptId: facts.receipt.id,
    taskDigest: facts.binding.taskDigest,
    optedOut: false,
    headCiGreen: true,
    workflowAccepted: true,
    rulesAccepted: true,
    exactPatch: true,
    pathsDisjoint: true,
    tipEligible: true,
    ownsEntry: false,
    definitiveRefusals: 0,
    admissionStartedAt: null,
    now: T0,
    admissionAmbiguous: false,
    reentry: false,
    failedQueueAdmissions: 0,
  };
}
