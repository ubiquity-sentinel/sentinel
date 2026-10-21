/** Bounded one-shot canary, with no repair/release state or model capability. */
import { isGitSha } from "../src/contracts/brands.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../src/contracts/canonical.ts";
import type {
  QueueActor,
  QueueAdmission,
  QueueDequeue,
  QueueEntry,
  QueueEvents,
  QueueMembership,
  QueueRead,
  QueueSnapshot,
} from "../src/github/merge-queue-types.ts";
import {
  CANARY_ACTIONS,
  CANARY_APP_ID,
  CANARY_APP_SLUG,
  CANARY_BRANCH,
  CANARY_REF,
  CANARY_REPOSITORY,
  type CanaryAction,
  type CanaryGrant,
} from "./queue-canary-pins.ts";
import {
  type QueueRulesProjectionCollection,
  validProjectionTargets,
} from "./queue-rules-projection-read.ts";

export interface CanaryHost {
  repository: string;
  ref: string;
  sha: string;
  workflowSha: string;
  expectedSha: string;
  runId: number;
  attempt: number;
  event: string;
  action: CanaryAction;
  bindingDigest: string;
  mintedAppSlug: string;
  mintedInstallationId: number;
}
export interface CanaryObservation {
  /** All applicable native reads completed; independent of acceptance or CI result. */
  complete: boolean;
  queue: QueueRead<QueueSnapshot>;
  membership: QueueRead<QueueMembership>;
  events: QueueRead<QueueEvents>;
  /** Parsed/sanitized native facts, not production delivery authorization. */
  facts: unknown;
  workflowAccepted: boolean;
  rulesAccepted: boolean;
  headCiGreen: boolean;
}
export interface CanaryIdentity {
  appId: number;
  appSlug: string;
  installationId: number;
  repositoryId: number;
  actor: QueueActor;
}
export interface CanaryPort {
  identity(): Promise<CanaryIdentity | null>;
  observe(grant: CanaryGrant): Promise<CanaryObservation>;
  firstDispatch(host: CanaryHost): Promise<boolean>;
  priorAccepted(grant: CanaryGrant): Promise<boolean>;
  enqueueCanary(grant: CanaryGrant): Promise<QueueAdmission>;
  dequeueCanary(grant: CanaryGrant, entry: QueueEntry): Promise<QueueDequeue>;
  /** Optional readers fail closed; existing mutation-only ports gain no capability. */
  collectProjection?(
    host: CanaryHost,
    identity: CanaryIdentity,
    grant: CanaryGrant,
  ): Promise<QueueRulesProjectionCollection>;
}
export interface CanaryEvidence {
  kind: "sentinel.queue-canary.v1";
  request: CanaryHost;
  requestDigest: string;
  bindingDigest: string;
  observedAt: number;
  status: "refused" | "observed" | "submitted" | "ambiguous";
  reason: string;
  identity: CanaryIdentity | null;
  before: CanaryObservation | null;
  after: CanaryObservation | null;
  outcome: QueueAdmission | QueueDequeue | null;
  productionDeliveryProof: false;
  projection?: QueueRulesProjectionCollection;
}
const equal = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
const digest = (value: string) => /^[0-9a-f]{64}$/.test(value);
export async function canaryBindingDigest(grant: CanaryGrant): Promise<string> {
  // Stable across source changes and caller nonces: same PR/H has the same one-shot claim.
  return await canonicalStringifySha256({
    domain: "sentinel.queue-canary-binding.v1",
    repository: "ubiquity/ai.ubq.fi",
    pullRequest: grant.pull.number,
    head: grant.pull.head,
  });
}
function validGrant(grant: CanaryGrant): boolean {
  const { pull, appActor, prior } = grant;
  return (grant.projectionTargets === undefined ||
    validProjectionTargets(grant.projectionTargets)) &&
    equal(pull.repository, CANARY_REPOSITORY) &&
    pull.baseRef === CANARY_BRANCH && Number.isSafeInteger(pull.number) &&
    pull.number > 0 &&
    /^[A-Za-z0-9_-]{1,256}$/.test(pull.nodeId) &&
    /^queue-canary-fixtures\/[A-Za-z0-9_./-]{1,180}$/.test(pull.headRef) &&
    !pull.headRef.includes("..") && isGitSha(pull.head) &&
    isGitSha(grant.reviewedBase) &&
    appActor.login === `${CANARY_APP_SLUG}[bot]` && appActor.type === "Bot" &&
    /^[A-Za-z0-9_-]{1,256}$/.test(appActor.nodeId) &&
    Number.isSafeInteger(grant.workflowId) && grant.workflowId > 0 &&
    digest(grant.workflowSha256) && digest(grant.rulesSha256) &&
    typeof grant.expectQueueRule === "boolean" &&
    (prior === null || (Number.isSafeInteger(prior.runId) && prior.runId > 0 &&
      isGitSha(prior.sourceSha) && digest(prior.requestDigest) &&
      Number.isSafeInteger(prior.artifactId) && prior.artifactId > 0 &&
      digest(prior.artifactDigest) &&
      /^[A-Za-z0-9_-]{1,256}$/.test(prior.entryId) &&
      (prior.requestId === null || /^[0-9a-f-]{36}$/i.test(prior.requestId))));
}
function matches(grant: CanaryGrant, observation: CanaryObservation): boolean {
  const { queue, membership, events } = observation;
  if (
    queue.status !== "complete" || membership.status !== "complete" ||
    events.status !== "complete"
  ) return false;
  return queue.value.baseRef === CANARY_BRANCH &&
    equal(queue.value.repository, CANARY_REPOSITORY) &&
    equal(membership.value.pull, grant.pull) &&
    equal(events.value.pull, grant.pull) &&
    equal(
      queue.value.entries.find((entry) =>
        entry.pull.number === grant.pull.number
      ) ?? null,
      membership.value.entry,
    );
}
export async function runQueueCanary(input: {
  host: CanaryHost;
  grants: readonly CanaryGrant[];
  port: CanaryPort;
  now: () => number;
  /** Flush an intent artifact before the only effect; never authoritative repair state. */
  retain: (evidence: CanaryEvidence) => Promise<void>;
}): Promise<CanaryEvidence> {
  const { host, port } = input;
  const evidence: CanaryEvidence = {
    kind: "sentinel.queue-canary.v1",
    request: host,
    requestDigest: await canonicalStringifySha256({
      domain: "sentinel.queue-canary-request.v1",
      ...host,
    }),
    bindingDigest: host.bindingDigest,
    observedAt: input.now(),
    status: "refused",
    reason: "invalid_host",
    identity: null,
    before: null,
    after: null,
    outcome: null,
    productionDeliveryProof: false,
  };
  const finish = async (reason: string) => {
    evidence.reason = reason;
    await input.retain(evidence);
    return evidence;
  };
  if (
    host.repository !== "Ubiquity-Sentinel/sentinel" ||
    host.ref !== CANARY_REF ||
    !isGitSha(host.sha) || host.sha !== host.workflowSha ||
    host.sha !== host.expectedSha ||
    host.event !== "workflow_dispatch" || !digest(host.bindingDigest) ||
    !Number.isSafeInteger(host.runId) || host.runId < 1 ||
    !Number.isSafeInteger(host.attempt) || host.attempt < 1 ||
    !CANARY_ACTIONS.includes(host.action) ||
    host.mintedAppSlug !== CANARY_APP_SLUG ||
    host.mintedInstallationId !== CANARY_REPOSITORY.installationId
  ) return await finish("invalid_host");
  const until = input.now() + 285_000;
  try {
    evidence.identity = await port.identity();
    if (
      evidence.identity === null || evidence.identity.appId !== CANARY_APP_ID ||
      evidence.identity.appSlug !== CANARY_APP_SLUG ||
      evidence.identity.installationId !== CANARY_REPOSITORY.installationId
    ) return await finish("installation_identity_unavailable");
    const selected: CanaryGrant[] = [];
    for (const grant of input.grants) {
      if (!validGrant(grant)) return await finish("invalid_source_grant");
      if (await canaryBindingDigest(grant) === host.bindingDigest) {
        selected.push(grant);
      }
    }
    if (selected.length !== 1) return await finish("source_grant_missing");
    const grant = selected[0];
    if (!equal(evidence.identity.actor, grant.appActor)) {
      return await finish("actor_pin_mismatch");
    }
    if (grant.projectionTargets !== undefined) {
      if (host.action !== "preflight" && host.action !== "observe") {
        return await finish("projection_read_only");
      }
      if (!port.collectProjection) {
        return await finish("projection_reader_unavailable");
      }
      evidence.projection = await port.collectProjection(
        host,
        evidence.identity,
        grant,
      );
      if (evidence.projection.status !== "collected") {
        return await finish("projection_unavailable");
      }
      evidence.status = "observed";
      return await finish("projection_observation");
    }
    evidence.before = await port.observe(grant);
    if (host.action === "preflight" || host.action === "observe") {
      if (!evidence.before.complete || !matches(grant, evidence.before)) {
        return await finish("observation_unavailable");
      }
      evidence.status = "observed";
      return await finish("native_observation");
    }
    if (host.attempt !== 1 || !await port.firstDispatch(host)) {
      return await finish("one_shot_already_consumed_or_unavailable");
    }
    if (!matches(grant, evidence.before)) {
      return await finish("observation_unavailable");
    }
    const before = evidence.before.membership;
    if (before.status !== "complete") {
      return await finish("observation_unavailable");
    }
    if (host.action === "enqueue") {
      if (
        grant.prior !== null || before.value.entry !== null ||
        before.value.mergedRevision !== null ||
        evidence.before.events.status !== "complete" ||
        evidence.before.events.value.added.length > 0 ||
        evidence.before.events.value.removed.length > 0 ||
        !evidence.before.workflowAccepted || !evidence.before.rulesAccepted ||
        !evidence.before.headCiGreen
      ) {
        return await finish("enqueue_preflight_refused");
      }
    } else {
      if (
        grant.prior === null || before.value.entry === null ||
        before.value.entry.id !== grant.prior.entryId ||
        !equal(before.value.entry.enqueuer, grant.appActor) ||
        !await port.priorAccepted(grant)
      ) {
        return await finish("owned_entry_provenance_unavailable");
      }
    }
    // A complete fresh read just before effect must agree with the retained observation.
    const final = await port.observe(grant);
    if (
      !matches(grant, final) ||
      !equal(final.membership, evidence.before.membership) ||
      !equal(final.events, evidence.before.events) ||
      final.workflowAccepted !== evidence.before.workflowAccepted ||
      final.rulesAccepted !== evidence.before.rulesAccepted ||
      (host.action === "enqueue" && !final.headCiGreen) || input.now() >= until
    ) {
      return await finish("pre_effect_drift_or_deadline");
    }
    evidence.status = "ambiguous";
    evidence.reason = "effect_intent_retained";
    await input.retain(evidence);
    evidence.outcome = host.action === "enqueue"
      ? await port.enqueueCanary(grant)
      : await port.dequeueCanary(grant, before.value.entry!);
    evidence.status = evidence.outcome.status === "ambiguous"
      ? "ambiguous"
      : evidence.outcome.status === "refused" ||
          evidence.outcome.status === "not_submitted"
      ? "refused"
      : "submitted";
    evidence.after = await port.observe(grant);
    return await finish("effect_observed_never_delivery_proof");
  } catch {
    // Never render exception/response text; it can contain credentials or attacker text.
    return await finish(
      evidence.status === "ambiguous"
        ? "effect_outcome_unknown"
        : host.action === "preflight" || host.action === "observe"
        ? "observation_unavailable"
        : "native_observation_unavailable",
    );
  }
}
