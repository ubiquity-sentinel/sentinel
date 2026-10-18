/** Owner-reviewed canary grants only. Workflow inputs cannot add a grant. */
import type { GitSha } from "../src/contracts/brands.ts";
import type {
  QueueActor,
  QueuePullIdentity,
} from "../src/github/merge-queue-types.ts";
import { DEFAULT_APP_INSTALLATION_ID } from "../src/host/actions-target-cycles.ts";
import type { QueueRulesProjectionTarget } from "./queue-rules-projection-read.ts";

export const CANARY_APP_ID = 4682172;
export const CANARY_APP_SLUG = "ubiquity-sentinel";
export const CANARY_BRANCH = "queue-canary";
export const CANARY_REPOSITORY = Object.freeze({
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: DEFAULT_APP_INSTALLATION_ID,
});
export const CANARY_WORKFLOW = ".github/workflows/queue-canary.yml";
export const CANARY_REF = "refs/heads/sentinel-supervisor";
export const CANARY_ACTIONS = [
  "preflight",
  "enqueue",
  "observe",
  "dequeue",
] as const;
export type CanaryAction = typeof CANARY_ACTIONS[number];

export interface CanaryPriorObservation {
  runId: number;
  sourceSha: GitSha;
  requestDigest: string;
  artifactId: number;
  artifactDigest: string;
  entryId: string;
  requestId: string | null;
}
export interface CanaryGrant {
  pull: QueuePullIdentity;
  reviewedBase: GitSha;
  appActor: QueueActor;
  workflowId: number;
  workflowSha256: string;
  rulesSha256: string;
  /** Explicit no-rule negative canary; never implies direct-merge fallback. */
  expectQueueRule: boolean;
  prior: CanaryPriorObservation | null;
  /** Source-owned GET-only capture scope; never accepted from workflow inputs. */
  projectionTargets?: readonly QueueRulesProjectionTarget[];
}

/** Empty ships dark. Populate only after owner App/canary approval and source review. */
export const CANARY_GRANTS: readonly CanaryGrant[] = Object.freeze([]);
