/** Root-only queue facts and narrowly reconstructed protected state transitions. */
import { type GitSha, isGitSha } from "../src/contracts/brands.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../src/contracts/canonical.ts";
import type { Clock, StateReadView } from "../src/contracts/ports.ts";
import { portError, portOk } from "../src/contracts/ports.ts";
import type { ExistingPrTakeoverPort } from "../src/contracts/existing-pr-takeover.ts";
import { hasTakeoverCustody } from "../src/github/existing-pr-takeover-provenance.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import type { GitHubQueueDeliveryClient } from "../src/github/client-queue-delivery.ts";
import { createDeadline } from "../src/github/http.ts";
import type {
  QueueRead,
  QueueSnapshot,
} from "../src/github/merge-queue-types.ts";
import { createQueueDeliveryReader } from "../src/github/queue-delivery-reader.ts";
import {
  createQueueProvenanceReader,
  hasQueueDeliveryProvenance,
  queueDeliveryProvenanceRef,
} from "../src/github/queue-delivery-provenance.ts";
import { resolveQueueLegacyDirect } from "../src/github/queue-legacy-direct.ts";
import {
  type HostedQueueAuthorityPins,
  QUEUE_AUTHORITY_PINS,
  QUEUE_MODE_CEILING,
  QUEUE_PROOF_ACTIVATED,
  QUEUE_PROOF_POLICY,
} from "../src/github/queue-runtime-policy.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
  candidatePreservationRef,
  closureIntentKey,
  workItemIdForIssue,
} from "../src/repair/keys.ts";
import { resolveCandidatePreservationBinding } from "../src/host/actions-candidates-preserve.ts";
import type { PublishedRefreshValidationInput } from "../src/host/published-refresh-validator.ts";
import { APP_LOGIN } from "../src/host/actions-target-cycles.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";
import {
  gatewayClosureIntentBindsRequest,
  gatewayRequestBindsDelivery,
  observeGatewayVpsDelivery,
} from "../src/repair/vps-delivery.ts";
import { buildHostedReleaseRequest } from "./hosted-autonomy-delivery.ts";
import { sameTreeChanges } from "./hosted-autonomy-github-trees.ts";
import type { HostedAutonomyDepsV1 } from "./hosted-autonomy-types.ts";
import type {
  HostedQueueAuthorizationPort,
  QueueAuthorizationRequest,
} from "./hosted-autonomy-queue-contracts.ts";
import {
  type HostedQueueCustodyContext,
  type QueueDeliveryRequest,
  type QueueDeliveryResolution,
  queueRecordProtected,
} from "./hosted-autonomy-queue-context.ts";
import { queueIntentBinding } from "./hosted-autonomy-queue-intent.ts";
import {
  hasQueueIntentNamespace,
  isQueueHeld,
  type QueueMode,
} from "./hosted-autonomy-queue-policy.ts";
import {
  isVerifiedDeliveryProof,
  type QueueProofPolicy,
  resolveQueueAwareDelivery,
} from "./hosted-autonomy-queue-proof.ts";

export type { HostedQueueAuthorityPins } from "../src/github/queue-runtime-policy.ts";
export interface HostedQueueAuthorityOptions {
  state: StateReadView;
  clock: Clock;
  githubFor: HostedAutonomyDepsV1["githubFor"];
  clientFor(repository: RepositoryIdentityV1): GitHubQueueDeliveryClient | null;
  /** Read-only exact Git/publication and unfiltered native-history proof; missing refuses recovery. */
  validatePublishedRefresh?(
    request: PublishedRefreshValidationInput,
  ): Promise<boolean>;
  /** Actual same-App host port; absent authority refuses retained native PR effects. */
  existingPrFor?(
    repository: RepositoryIdentityV1,
  ): ExistingPrTakeoverPort | undefined;
  /** Read-only retained publication identity; no repair/planner principal is minted here. */
  publicationFor?(
    repository: RepositoryIdentityV1,
  ): Pick<ExistingPrTakeoverPort, "resolvePublication"> | undefined;
  /** Trusted source construction only. No environment variable can supply pins. */
  configuration?: {
    mode: QueueMode;
    proofActivated: boolean;
    policy: QueueProofPolicy;
    pins: HostedQueueAuthorityPins;
  };
}
const READ_MS = 60_000;
const DIGEST = /^[0-9a-f]{64}$/;
const equal = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
const unavailable = (): QueueRead<never> => ({
  status: "unavailable",
  reason: "incomplete",
});
const deliveryUnavailable = (): QueueDeliveryResolution => ({
  status: "unavailable",
  reason: "queue_evidence_unavailable",
});
const queueEqual = (a: QueueSnapshot, b: QueueSnapshot) =>
  equal({ ...a, observedAt: 0 }, { ...b, observedAt: 0 });
const overlap = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export function createHostedQueueAuthority(
  options: HostedQueueAuthorityOptions,
): {
  authorization: HostedQueueAuthorizationPort;
  resolveDelivery: NonNullable<HostedQueueCustodyContext["resolveDelivery"]>;
  verifyProtectedWrite: NonNullable<
    HostedQueueCustodyContext["verifyProtectedWrite"]
  >;
} {
  const { state, clock } = options;
  const config = options.configuration ?? {
    mode: QUEUE_MODE_CEILING,
    proofActivated: QUEUE_PROOF_ACTIVATED,
    policy: QUEUE_PROOF_POLICY,
    pins: QUEUE_AUTHORITY_PINS,
  };
  const { policy, pins } = config;
  async function bounded<T>(
    run: (deadline: number) => Promise<T>,
    refused: () => T,
    until = clock.now() + READ_MS,
  ): Promise<T> {
    const remaining = Math.min(READ_MS, until - clock.now());
    if (!Number.isSafeInteger(until) || remaining <= 0) return refused();
    const deadline = createDeadline(remaining);
    try {
      return await deadline.race(run(Math.min(until, clock.now() + remaining)));
    } catch {
      return refused();
    } finally {
      deadline.dispose();
    }
  }
  async function current(
    snapshot: RepairStateSnapshotV1,
    head: GitSha,
    record?: WorkRecordV1,
  ): Promise<boolean> {
    const read = await state.readRepair();
    return read.ok && read.value.status === "found" &&
      read.value.head === head &&
      equal(read.value.snapshot, snapshot) &&
      (record === undefined ||
        equal(
          snapshot.work.find((row) => row.id === record.id) ?? null,
          record,
        ));
  }
  function reader(
    client: GitHubQueueDeliveryClient,
    repository: RepositoryIdentityV1,
  ) {
    return createQueueDeliveryReader({
      repository,
      clock,
      client,
      policy,
      provenance: createQueueProvenanceReader({ state, clock, policy }),
      publication: async (request) => {
        const port = options.publicationFor?.(repository);
        const observed = await state.readRepair();
        if (
          port === undefined || !observed.ok ||
          observed.value.status !== "found" ||
          !equal(observed.value.snapshot, request.snapshot)
        ) return unavailable();
        const proof = await port.resolvePublication({
          ...request,
          expectedStateHead: observed.value.head,
        });
        return proof.ok
          ? { status: "complete", value: proof.value }
          : unavailable();
      },
      directWitness: ({ binding, revision }) => {
        const matches = policy.historicalDirectWitnesses.filter((entry) =>
          equal(entry.binding, binding) && entry.revision === revision
        );
        return Promise.resolve({
          status: "complete",
          value: matches.length === 1 &&
              policy.historicalDirectManifestDigest !== null
            ? {
              binding,
              revision,
              provenance: {
                kind: "historical_exact",
                manifestDigest: policy.historicalDirectManifestDigest,
                witnessDigest: matches[0].witnessDigest,
              },
            }
            : null,
        });
      },
    });
  }
  function admissionPinsPresent(): boolean {
    const reasons = [
      ...pins.ciFailureRemovalReasons,
      ...pins.timeoutRemovalReasons,
      ...pins.otherRemovalReasons,
    ];
    return policy.canaryDigest !== null && DIGEST.test(policy.canaryDigest) &&
      policy.appActor?.type === "Bot" &&
      policy.appActor.login === "ubiquity-sentinel[bot]" &&
      policy.appActor.nodeId.length > 0 &&
      Number.isSafeInteger(policy.workflowId) && (policy.workflowId ?? 0) > 0 &&
      (policy.mergedRemovalReasons?.length ?? 0) > 0 &&
      (policy.mergedRemovalBeforeCommit === "pull_head" ||
        policy.mergedRemovalBeforeCommit === "merged_revision") &&
      pins.removalBeforeCommit === "pull_head" &&
      pins.removalActors.length > 0 &&
      pins.ciFailureRemovalReasons.length > 0 &&
      pins.timeoutRemovalReasons.length > 0 &&
      reasons.every((value) => value.length > 0 && value.length <= 1000) &&
      new Set(reasons).size === reasons.length &&
      typeof policy.workflowSha256 === "string" &&
      DIGEST.test(policy.workflowSha256) &&
      pins.effectiveRulesSha256 !== null &&
      DIGEST.test(pins.effectiveRulesSha256);
  }
  async function readAuthorization(
    request: QueueAuthorizationRequest,
  ): ReturnType<HostedQueueAuthorizationPort["readAuthorization"]> {
    return await bounded(async (deadline) => {
      const { snapshot, observedHead, record } = request;
      const client = options.clientFor(record.repository),
        github = options.githubFor(record.repository);
      if (
        client === null || github === null || !admissionPinsPresent() ||
        !await current(snapshot, observedHead, record)
      ) return unavailable();
      const input = { record, snapshot, deadline };
      const factsReader = reader(client, record.repository);
      const observed = await factsReader.readBinding(input);
      if (observed.status !== "complete") return observed;
      const saved = await queueIntentBinding(snapshot, record);
      if (hasQueueIntentNamespace(record) && saved === null) {
        return unavailable();
      }
      if (
        request.binding !== null &&
        (saved === null || !equal(request.binding, saved.binding))
      ) return unavailable();
      const binding = request.binding ?? observed.value.binding;
      const queue = await client.readQueue("development");
      if (queue.status !== "complete") return queue;
      if (
        !queueEqual(queue.value, request.queue) ||
        !equal(queue.value.repository, record.repository) ||
        queue.value.baseRef !== "development"
      ) return unavailable();
      const pull = await client.readQueuePull(binding.pullRequest, deadline);
      if (pull.status !== "complete") return pull;
      const membership = pull.value.membership;
      const listed = queue.value.entries.filter((entry) =>
        entry.pull.number === binding.pullRequest
      );
      if (listed.length > 1 || !equal(listed[0] ?? null, membership.entry)) {
        return unavailable();
      }
      const basis = await factsReader.readAuthorizationBasis(input);
      const rules = await client.readBranchRules("development");
      const rulesAccepted = !rules.ok
        ? null
        : rules.value.some((rule) => rule.type === "merge_queue") &&
          await canonicalStringifySha256([...rules.value].sort((a, b) =>
              canonicalStringify(a).localeCompare(canonicalStringify(b))
            )) === pins.effectiveRulesSha256;
      const workflows = await Promise.all(
        [queue.value.baseTip, binding.head].map((revision) =>
          client.readQueueWorkflowDigest(revision, deadline)
        ),
      );
      const workflowAccepted = workflows.some((read) =>
          read.status !== "complete"
        )
        ? null
        : workflows.every((read, index) =>
          read.status === "complete" &&
          read.value.revision === [queue.value.baseTip, binding.head][index] &&
          read.value.path === ".github/workflows/deno-deploy.yml" &&
          read.value.sha256 === policy.workflowSha256
        );
      const patch = await client.readQueuePatch(
        binding.base,
        binding.head,
        deadline,
      );
      const original = await client.readQueuePatch(
        observed.value.receipt.pullRequest.base,
        observed.value.receipt.pullRequest.head,
        deadline,
      );
      const exactPatch =
        patch.status !== "complete" || original.status !== "complete"
          ? null
          : patch.value.base === binding.base &&
            patch.value.head === binding.head &&
            patch.value.mergeBase === binding.base &&
            original.value.base === observed.value.receipt.pullRequest.base &&
            original.value.head === observed.value.receipt.pullRequest.head &&
            sameTreeChanges(patch.value.changes, original.value.changes);
      const tip = await client.readQueueAncestry(
        binding.base,
        queue.value.baseTip,
        deadline,
      );
      const changed = await client.readQueuePatch(
        binding.base,
        queue.value.baseTip,
        deadline,
      );
      let pathsDisjoint: boolean | null =
        patch.status !== "complete" || changed.status !== "complete"
          ? null
          : !patch.value.changes.some((a) =>
            changed.value.changes.some((b) => overlap(a.path, b.path))
          );
      for (const entry of queue.value.entries) {
        if (
          entry.pull.number === binding.pullRequest ||
          (membership.entry !== null &&
            entry.position >= membership.entry.position)
        ) continue;
        const predecessor = await client.readQueuePatch(
          queue.value.baseTip,
          entry.pull.head,
          deadline,
        );
        if (predecessor.status !== "complete") {
          pathsDisjoint = null;
          break;
        }
        if (
          predecessor.value.changes.some((change) =>
            change.path === ".github" || change.path.startsWith(".github/")
          ) ||
          (patch.status === "complete" &&
            patch.value.changes.some((a) =>
              predecessor.value.changes.some((b) => overlap(a.path, b.path))
            ))
        ) pathsDisjoint = false;
      }
      const livePull = await github.readPull(
        binding.pullRequest,
        "development",
      );
      const tipEligible = tip.status !== "complete" || livePull === null
        ? null
        : tip.value.ancestor === binding.base &&
          tip.value.descendant === queue.value.baseTip &&
          tip.value.isAncestor &&
          observed.value.sourceOpen && livePull.state === "open" &&
          !livePull.merged && livePull.headSha === binding.head &&
          livePull.baseRef === "development" &&
          livePull.baseSha === queue.value.baseTip &&
          livePull.mergeable === true;
      const ownsEntry = saved !== null && membership.entry !== null &&
        saved.state.intent.resultId === membership.entry.id &&
        equal(saved.binding, binding) &&
        equal(membership.entry.enqueuer, policy.appActor) &&
        equal(membership.entry.pull, membership.pull) &&
        membership.pull.head === binding.head &&
        membership.entry.enqueuedAt >=
          Math.floor(saved.state.intent.startedAt / 1000) * 1000 &&
        membership.entry.enqueuedAt <= clock.now();
      const finalQueue = await client.readQueue("development"),
        finalRules = await client.readBranchRules("development");
      const finalBinding = await factsReader.readBinding(input);
      const finalBasis = await factsReader.readAuthorizationBasis(input);
      const finalPull = await github.readPull(
        binding.pullRequest,
        "development",
      );
      if (
        finalQueue.status !== "complete" ||
        !queueEqual(queue.value, finalQueue.value) ||
        !equal(rules, finalRules) ||
        !equal(observed, finalBinding) || !equal(basis, finalBasis) ||
        !equal(livePull, finalPull) || clock.now() >= deadline ||
        !await current(snapshot, observedHead, record)
      ) return unavailable();
      const stage = saved?.state;
      return {
        status: "complete",
        value: {
          binding,
          pull: membership.pull,
          facts: {
            binding,
            membership: { status: "complete", value: membership },
            reviewAuthorized: basis.status === "complete"
              ? basis.value.reviewAuthorized
              : null,
            latestReceiptId: observed.value.receipt.id,
            taskDigest: observed.value.task.digest,
            optedOut: observed.value.optedOut,
            headCiGreen: basis.status === "complete"
              ? basis.value.headCiGreen
              : null,
            workflowAccepted,
            rulesAccepted,
            exactPatch,
            pathsDisjoint,
            tipEligible,
            ownsEntry,
            definitiveRefusals: stage?.refusals ?? 0,
            admissionStartedAt:
              stage !== undefined && stage.intent.resultId === null
                ? stage.intent.startedAt
                : null,
            now: clock.now(),
            admissionAmbiguous: stage?.stage === "ambiguous" ||
              stage?.stage === "unavailable" ||
              (stage?.intent.requestId !== null &&
                stage?.intent.requestId !== undefined &&
                stage.intent.resultId === null),
            reentry: (stage?.queueFailures ?? 0) > 0,
            failedQueueAdmissions: stage?.queueFailures ?? 0,
          },
        },
      };
    }, unavailable);
  }
  const readRemoval: HostedQueueAuthorizationPort["readRemoval"] = async (
    request,
  ) =>
    await bounded(async (deadline) => {
      const client = options.clientFor(request.record.repository);
      const saved = await queueIntentBinding(request.snapshot, request.record);
      if (
        client === null || !admissionPinsPresent() || saved === null ||
        !equal(saved.binding, request.binding) ||
        saved.state.intent.resultId !== request.entryId ||
        !await current(request.snapshot, request.observedHead, request.record)
      ) return unavailable();
      const pull = await client.readQueuePull(
        request.binding.pullRequest,
        deadline,
      );
      if (pull.status !== "complete") return pull;
      if (
        pull.value.membership.pull.head !== request.binding.head ||
        pull.value.membership.mergedRevision !== null ||
        pull.value.membership.pull.headRef !== request.record.target.branch ||
        pull.value.membership.pull.baseRef !== "development" ||
        !equal(pull.value.membership.pull.repository, request.record.repository)
      ) return unavailable();
      // Removal is an unmerged lifecycle: the delivery evidence reader requires
      // a merged revision and cannot classify CI/timeout ejections.
      const evidence = await client.readPullQueueEvents(
        pull.value.membership.pull,
      );
      if (evidence.status !== "complete") return evidence;
      const earliest = Math.floor(saved.state.intent.startedAt / 1000) * 1000;
      const added = evidence.value.added.filter((event) =>
        event.at >= earliest
      );
      const removed = evidence.value.removed.filter((event) =>
        event.at >= earliest
      );
      if (
        !equal(evidence.value.pull, pull.value.membership.pull) ||
        added.length !== 1 || !equal(added[0].actor, policy.appActor) ||
        added[0].at > clock.now() || removed.length > 1 ||
        removed.some((event) =>
          event.at < added[0].at || event.at > clock.now()
        )
      ) return unavailable();
      let classification: "ci_failed" | "timeout" | "other" | "none",
        eventId: string | null;
      if (removed.length === 0) {
        if (
          pull.value.membership.entry?.id !== request.entryId ||
          !equal(pull.value.membership.entry.enqueuer, policy.appActor)
        ) return unavailable();
        classification = "none";
        eventId = null;
      } else {
        const event = removed[0];
        if (
          pull.value.membership.entry !== null || event.reason === null ||
          pins.removalBeforeCommit !== "pull_head" ||
          event.beforeCommit !== request.binding.head ||
          !pins.removalActors.some((actor) => equal(actor, event.actor))
        ) return unavailable();
        const matches = ([["ci_failed", pins.ciFailureRemovalReasons], [
          "timeout",
          pins.timeoutRemovalReasons,
        ], ["other", pins.otherRemovalReasons]] as const)
          .filter(([, reasons]) => reasons.includes(event.reason!));
        if (matches.length !== 1) return unavailable();
        classification = matches[0][0];
        eventId = event.id;
      }
      const after = await client.readPullQueueEvents(
        pull.value.membership.pull,
      );
      const afterPull = await client.readQueuePull(
        request.binding.pullRequest,
        deadline,
      );
      if (
        !equal(after, evidence) || !equal(pull, afterPull) ||
        clock.now() >= deadline ||
        !await current(request.snapshot, request.observedHead, request.record)
      ) return unavailable();
      return { status: "complete", value: { classification, eventId } };
    }, unavailable);

  async function resolve(
    request: QueueDeliveryRequest,
    deadline: number,
  ): Promise<QueueDeliveryResolution> {
    const { snapshot, record, observedHead } = request;
    const client = options.clientFor(record.repository);
    if (
      client === null || record.target.pr === null ||
      !await current(snapshot, observedHead, record)
    ) return deliveryUnavailable();
    const factsReader = reader(client, record.repository);
    const legacyPull = await client.readQueueLegacyPull(
      record.target.pr,
      deadline,
    );
    if (legacyPull.status !== "complete") return deliveryUnavailable();
    const revision = request.expectedRevision ?? legacyPull.value.pull.mergeSha;
    if (!isGitSha(revision) || legacyPull.value.pull.mergeSha !== revision) {
      return deliveryUnavailable();
    }
    const legacy = await resolveQueueLegacyDirect({
      state,
      clock,
      client,
      reader: factsReader,
      mode: config.mode,
      proofActivated: config.proofActivated ||
        hasQueueDeliveryProvenance(record),
    }, { record, revision, deadline });
    if (legacy.status === "complete" && legacy.value !== null) {
      return await current(snapshot, observedHead, record)
        ? legacy.value
        : deliveryUnavailable();
    }
    if (legacy.status !== "complete") return deliveryUnavailable();
    const binding = await factsReader.readBinding({
      record,
      snapshot,
      deadline,
    });
    if (binding.status !== "complete") return deliveryUnavailable();
    const facts = await factsReader.read({
      record,
      snapshot,
      deadline,
      receipt: binding.value.receipt,
      currentTask: binding.value.task,
      revision,
      now: clock.now(),
    });
    if (facts.status !== "complete") return deliveryUnavailable();
    const result = await resolveQueueAwareDelivery(facts.value, policy);
    return clock.now() < deadline &&
        await current(snapshot, observedHead, record)
      ? result
      : deliveryUnavailable();
  }
  const resolveDelivery: NonNullable<
    HostedQueueCustodyContext["resolveDelivery"]
  > = (request) =>
    bounded((deadline) => resolve(request, deadline), deliveryUnavailable);

  const verifyProtectedWrite: NonNullable<
    HostedQueueCustodyContext["verifyProtectedWrite"]
  > = (before, next, expectedHead) =>
    bounded(async (deadline) => {
      if (
        !await current(before, expectedHead) ||
        next.stateHead !== expectedHead ||
        next.sequence !== before.sequence + 1 ||
        !Number.isSafeInteger(next.updatedAt) ||
        next.updatedAt < before.updatedAt || next.updatedAt > clock.now() ||
        next.work.length !== before.work.length ||
        !equal(next, {
          ...before,
          stateHead: expectedHead,
          sequence: before.sequence + 1,
          updatedAt: next.updatedAt,
          work: next.work,
          releaseRequests: next.releaseRequests,
        })
      ) return false;
      const requests = [...before.releaseRequests];
      let changed = false;
      for (let index = 0; index < before.work.length; index++) {
        const record = before.work[index], row = next.work[index];
        if (equal(record, row)) continue;
        if (
          record.id !== row.id ||
          (!queueRecordProtected(record) && !hasQueueDeliveryProvenance(record))
        ) return false;
        changed = true;
        const matches = before.releaseRequests.filter((request) =>
          releaseRequestMatchesDelivery(request, record)
        );
        if (matches.length > 1) return false;
        const proof = await resolve({
          snapshot: before,
          observedHead: expectedHead,
          record,
          expectedRevision: matches[0]?.revision ?? null,
          purpose: matches.length === 0 ? "delivery" : "closure",
        }, deadline);
        if (
          proof.status !== "verified" || proof.delivery.kind !== "queue" ||
          !isVerifiedDeliveryProof(proof.delivery)
        ) return false;
        const ref = queueDeliveryProvenanceRef(
          proof.delivery,
          record,
          expectedHead,
        );
        if (
          ref === null ||
          record.evidence.filter((item) => equal(item, ref)).length > 1
        ) return false;
        const evidence = record.evidence.some((item) => equal(item, ref))
          ? record.evidence
          : [...record.evidence, ref];
        if (evidence.length > 64) return false;
        const receipt = before.reviews.find((review) =>
          review.id === proof.delivery.reviewReceiptId
        );
        if (receipt === undefined) return false;
        let expected: WorkRecordV1;
        if (matches.length === 0) {
          const request = await buildHostedReleaseRequest(
            record.repository,
            proof.delivery.revision,
            proof.delivery.head,
            proof.delivery.base,
            proof.delivery.pullRequest,
            receipt,
            next.updatedAt,
          );
          if (
            request === null || requests.some((old) => old.id === request.id)
          ) return false;
          requests.push(request);
          expected = {
            ...record,
            nextStep: "delivery",
            blocker: null,
            evidence,
            updatedAt: next.updatedAt,
          };
        } else {
          const request = matches[0];
          if (
            !await gatewayRequestBindsDelivery(
              request,
              record,
              receipt,
              proof.delivery.revision,
            ) ||
            (await observeGatewayVpsDelivery(state, record, request, receipt))
                .kind !== "accepted" ||
            record.related.issueNumber === null
          ) return false;
          if (row.nextStep === "done") {
            if (
              !gatewayClosureIntentBindsRequest(record, request) ||
              await options.githubFor(record.repository)?.readIssueOpen(
                  record.related.issueNumber,
                ) !== false
            ) return false;
            expected = {
              ...record,
              nextStep: "done",
              wait: null,
              blocker: null,
              intent: null,
              evidence,
              updatedAt: next.updatedAt,
            };
          } else {
            if (!hasQueueIntentNamespace(record)) return false;
            expected = {
              ...record,
              evidence,
              updatedAt: next.updatedAt,
              intent: {
                kind: "issue_closure",
                key: closureIntentKey(record.related.issueNumber),
                startedAt: next.updatedAt,
                branch: null,
                expectedHead: record.target.head,
                observedBase: record.target.base,
                pr: record.target.pr,
                requestId: request.id,
                resultId: null,
              },
            };
          }
        }
        if (!equal(row, expected)) return false;
      }
      requests.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      return changed && equal(next.releaseRequests, requests) &&
        clock.now() < deadline && await current(before, expectedHead);
    }, () => false);
  const authorizeEnqueue: NonNullable<
    HostedQueueAuthorizationPort["authorizeEnqueue"]
  > = (request) =>
    bounded(
      async (deadline) => {
        const { record, snapshot, observedHead } = request;
        if (!hasTakeoverCustody(record)) return portOk(undefined);
        const port = options.existingPrFor?.(record.repository);
        if (
          port === undefined || record.target.head === null ||
          !await current(snapshot, observedHead, record)
        ) {
          return portError(
            "unavailable",
            "existing PR enqueue custody unavailable",
          );
        }
        const proofRequest = {
          record,
          snapshot,
          expectedStateHead: observedHead,
          expectedHead: record.target.head,
          operation: "enqueue" as const,
          deadline,
        };
        const proof = await port.resolve(proofRequest);
        if (!proof.ok) return proof;
        const allowed = await port.authorizeEffect(proof.value, proofRequest);
        if (!allowed.ok) return allowed;
        const client = options.clientFor(record.repository);
        const finalQueue = await client?.readQueue("development");
        return finalQueue?.status === "complete" &&
            queueEqual(finalQueue.value, request.queue) &&
            clock.now() < deadline &&
            await current(snapshot, observedHead, record)
          ? portOk(undefined)
          : portError("unavailable", "existing PR enqueue custody unavailable");
      },
      () => portError("unavailable", "existing PR enqueue custody unavailable"),
      request.deadline,
    );
  const readPublishedRefreshRecovery: NonNullable<
    HostedQueueAuthorizationPort["readPublishedRefreshRecovery"]
  > = (request) =>
    bounded(
      async (deadline) => {
        const { record, snapshot, observedHead } = request;
        const intent = record.intent, issue = record.related.issueNumber;
        const client = options.clientFor(record.repository);
        if (
          client === null || options.validatePublishedRefresh === undefined ||
          state.openRepairHistory === undefined || config.mode !== "off" ||
          !isQueueHeld(record) || record.nextStep !== "work" ||
          record.blocker !== null ||
          hasQueueIntentNamespace(record) ||
          hasQueueDeliveryProvenance(record) || hasTakeoverCustody(record) ||
          record.source.kind !== "issue" || issue === null ||
          record.source.id !== String(issue) ||
          record.id !== workItemIdForIssue(record.repository, issue) ||
          record.target.branch !== candidateBranch(record.id) ||
          record.target.pr === null ||
          record.target.head === null || intent?.kind !== "base_refresh" ||
          intent.failure !== undefined ||
          intent.requestId !== null || !isGitSha(intent.resultId) ||
          !isGitSha(intent.observedBase) ||
          intent.expectedHead !== record.target.head ||
          intent.branch !== record.target.branch ||
          intent.pr !== record.target.pr ||
          intent.key !==
            baseRefreshIntentKey(
              intent.pr,
              intent.expectedHead,
              intent.observedBase,
            ) ||
          request.queue.queueId !== null ||
          request.queue.entries.length !== 0 ||
          snapshot.reservations.some((entry) =>
            entry.taskId === record.id &&
            (entry.outcome === "reserved" || entry.outcome === "ambiguous" ||
              entry.settledAt === null)
          ) ||
          !await current(snapshot, observedHead, record)
        ) return unavailable();
        // A later queue tip is valid only when the published refresh's base
        // remains in its history. A rewrite or an unavailable ancestry proof
        // keeps the hold rather than acknowledging a stale publication.
        const queueTip = request.queue.baseTip;
        const ancestry = queueTip === intent.observedBase
          ? null
          : await client.readQueueAncestry(
            intent.observedBase,
            queueTip,
            deadline,
          );
        if (
          ancestry !== null && (ancestry.status !== "complete" ||
            ancestry.value.ancestor !== intent.observedBase ||
            ancestry.value.descendant !== queueTip ||
            !ancestry.value.isAncestor)
        ) return unavailable();
        const candidate = {
          operationKey: intent.key,
          base: intent.observedBase,
          head: intent.resultId,
          ref: await candidatePreservationRef(
            record.repository,
            record.id,
            intent.key,
          ),
        };
        if (
          !(await resolveCandidatePreservationBinding(
            record,
            snapshot.reservations,
            candidate,
            record.target.head,
          )).ok
        ) return unavailable();
        // Authenticate the adjacent hold-only CAS, not merely a matching ref or old timestamp.
        const opened = await state.openRepairHistory({
          expectedHead: observedHead,
        });
        if (!opened.ok) return unavailable();
        let adjacent = false;
        try {
          let held = snapshot;
          for (let count = 0; count < 1024 && clock.now() < deadline; count++) {
            const parent = held.stateHead;
            if (parent === null) break;
            const read = await opened.value.readAt(parent);
            if (
              !read.ok || read.value.status !== "found" ||
              read.value.head !== parent
            ) break;
            const previous = read.value.snapshot;
            if (previous.sequence + 1 !== held.sequence) break;
            const before = previous.work.find((row) => row.id === record.id);
            if (before === undefined) break;
            if (equal(before, record)) {
              held = previous;
              continue;
            }
            adjacent = before.wait === null &&
              record.updatedAt === record.wait!.since &&
              equal({
                ...before,
                wait: record.wait,
                updatedAt: record.updatedAt,
              }, record) &&
              equal(held, {
                ...previous,
                stateHead: parent,
                sequence: previous.sequence + 1,
                updatedAt: held.updatedAt,
                work: previous.work.map((row) =>
                  row.id === record.id ? record : row
                ),
              });
            break;
          }
        } finally {
          await opened.value.close();
        }
        if (!adjacent || !await current(snapshot, observedHead, record)) {
          return unavailable();
        }
        const observe = async () => {
          const [rules, queue, pull] = await Promise.all([
            client.readBranchRules("development"),
            client.readQueue("development"),
            client.readQueuePull(record.target.pr!, deadline),
          ]);
          if (
            !rules.ok ||
            rules.value.some((rule) => rule.type === "merge_queue") ||
            queue.status !== "complete" ||
            !queueEqual(queue.value, request.queue) ||
            pull.status !== "complete" || pull.value.author !== APP_LOGIN ||
            pull.value.base !== candidate.base ||
            pull.value.membership.entry !== null ||
            pull.value.membership.mergedRevision !== null ||
            pull.value.membership.pull.head !== candidate.head ||
            pull.value.membership.pull.headRef !== record.target.branch ||
            pull.value.membership.pull.baseRef !== "development" ||
            !equal(pull.value.membership.pull.repository, record.repository)
          ) return null;
          return { rules: rules.value, pull: pull.value };
        };
        const first = await observe();
        if (
          first === null ||
          !await options.validatePublishedRefresh({
            record,
            candidate,
            deadline,
          })
        ) return unavailable();
        const last = await observe();
        return last !== null && equal(first, last) && clock.now() < deadline &&
            await current(snapshot, observedHead, record)
          ? {
            status: "complete" as const,
            value: { candidate, at: clock.now() },
          }
          : unavailable();
      },
      unavailable,
      request.deadline,
    );
  return {
    authorization: {
      readAuthorization,
      readRemoval,
      authorizeEnqueue,
      readPublishedRefreshRecovery,
    },
    resolveDelivery,
    verifyProtectedWrite,
  };
}
