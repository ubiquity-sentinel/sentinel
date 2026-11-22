import type {
  AgentJobResultV1,
  AgentJobsCellResultV1,
} from "./agent-jobs-cell.ts";
import type { AgentJobReviewRound } from "./agent-jobs-native-review.ts";
import type { AgentJobV1 } from "./agent-jobs-plan.ts";

export interface PinnedAgentJobV1 extends AgentJobV1 {
  base: string;
  baseSha: string;
  review?: boolean;
}

export interface AgentJobReviewV1 {
  id: string;
  repository: string;
  base: string;
  baseSha: string;
  headSha: string;
  runTag: string;
  taskDigest: string;
  verdict: "accepted" | "already_satisfied" | "skipped_no_diff" | "blocked";
  rounds: AgentJobReviewRound[];
  detail: string;
}

export interface ReviewedAgentJobResultV1 extends AgentJobResultV1 {
  review: AgentJobReviewV1;
}

export interface AgentJobModelStartV1 {
  id: string;
  headSha: string;
  kind: "review" | "correction";
  round: number;
  at: number;
}

export interface ReviewedAgentJobsCellResultV1 extends AgentJobsCellResultV1 {
  results: ReviewedAgentJobResultV1[];
  modelStarts: AgentJobModelStartV1[];
}

export {
  agentJobTreeChanged,
  importAgentJobBundle,
  validateAgentJobPublication,
} from "./agent-jobs-review-git.ts";
