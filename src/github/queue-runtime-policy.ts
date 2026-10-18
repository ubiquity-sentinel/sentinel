/** Reviewed source pins. Repository variables may lower enqueue mode only. */
import type { QueueMode } from "../../ops/hosted-autonomy-queue-policy.ts";
import type { QueueProofPolicy } from "../../ops/hosted-autonomy-queue-proof.ts";
import type { QueueActor } from "./merge-queue-types.ts";

/** Populated only by a reviewed, accepted canary configuration. */
export interface HostedQueueAuthorityPins {
  effectiveRulesSha256: string | null;
  removalBeforeCommit: "pull_head" | null;
  ciFailureRemovalReasons: readonly string[];
  timeoutRemovalReasons: readonly string[];
  otherRemovalReasons: readonly string[];
  removalActors: readonly QueueActor[];
}

export const QUEUE_AUTHORITY_PINS: HostedQueueAuthorityPins = Object.freeze({
  effectiveRulesSha256: null,
  removalBeforeCommit: null,
  ciFailureRemovalReasons: Object.freeze([]),
  timeoutRemovalReasons: Object.freeze([]),
  otherRemovalReasons: Object.freeze([]),
  removalActors: Object.freeze([]),
});

export const QUEUE_MODE_CEILING: QueueMode = "off";

/**
 * This is independent of the enqueue kill switch. Once activated, a later
 * mode="off" keeps queue custody and strict delivery verification enabled.
 */
export const QUEUE_PROOF_ACTIVATED = false;

/**
 * Only an accepted App-identity canary and exact historical witness inventory
 * can populate these pins. Missing policy is unavailable evidence, never an
 * instruction to infer a direct merge or to trust an arbitrary queue actor.
 */
export const QUEUE_PROOF_POLICY: QueueProofPolicy = Object.freeze({
  canaryDigest: null,
  appActor: null,
  mergedActors: Object.freeze([]),
  workflowId: null,
  workflowSha256: null,
  historicalDirectManifestDigest: null,
  historicalDirectWitnesses: Object.freeze([]),
});
