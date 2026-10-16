import type { GitSha, WorkItemId } from "./brands.ts";
import type {
  AttemptFailureClassV1,
  AttemptStageV1,
} from "./attempt-memory.ts";
import type { EvidenceRefV1, RepositoryIdentityV1 } from "./shared.ts";
import type { PortResultV1 } from "./ports.ts";

/**
 * Route-selected runtime model id. The implementation model is chosen by the
 * trusted model route (`src/host/model-route.ts`) and MUST always be the id
 * actually requested and acknowledged by the run — a receipt never keeps one
 * model id while another was requested. `ReasoningEffortV1` remains frozen at
 * `max` for every route.
 */
export type ModelIdV1 = string;
export type ReasoningEffortV1 = "max";

/**
 * One bounded, VERIFIED prior-attempt fact from durable attempt memory for the
 * same work item at the same base and runtime revision. It is evidence for the
 * implementer, never permission: it cannot change budgets, credentials, review
 * policy, runtime promotion or the authorized model. `count` is the number of
 * equivalent outcomes recorded for this exact failure detail.
 */
export interface PriorAttemptFactV1 {
  /** Closed settlement detail constant (sanitized by construction). */
  detail: string;
  stage: AttemptStageV1;
  failureClass: AttemptFailureClassV1;
  count: number;
  lastAtMs: number;
}

/**
 * One bounded regression fact: a failure mode observed at the current runtime
 * revision for this repository whose SAME work previously produced an
 * accepted candidate at an OLDER runtime revision. The repository is
 * version-controlled: this is the "it worked before, it is broken now"
 * signal that argues for restoring/aligning with the older working behavior
 * instead of pressing forward. Advisory evidence, never an automatic
 * rollback command.
 */
export interface RepositoryRegressionFactV1 {
  /** Closed settlement detail constant that now fails. */
  detail: string;
  /** Runtime revision at which this work last succeeded. */
  priorSuccessRevision: GitSha;
  priorSuccessAtMs: number;
  /** Equivalent failures recorded at the current revision. */
  failuresAtCurrentRevision: number;
  lastFailureAtMs: number;
}

export interface ModelRunRequestV1 {
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  /** Secret-free checkout base; no credential or state-write fields exist. */
  base: GitSha;
  /**
   * Exact rejected candidate head to use as the checkout base for a review
   * correction. The durable reviewed base remains in `base`; this field is
   * present only when the correction must continue from that candidate.
   */
  checkoutBase?: GitSha;
  /**
   * Exact base tip a base-refresh CONFLICT RESOLUTION merges into the
   * candidate. Present only together with `checkoutBase` (the published
   * candidate): the checkout is that candidate with this base merged in and
   * its conflicts left in the tree, and the trusted host commits the merge
   * with exactly those two parents. Never equal to `base` or `checkoutBase`.
   */
  mergeBase?: GitSha;
  issue: { number: number; title: string; body: string } | null;
  evidence: EvidenceRefV1[];
  /**
   * Exact unresolved findings of the review that rejected this candidate, when
   * the run is a CORRECTION. Without them a correction cannot know what the
   * reviewer objected to and re-implements the same change; they are bounded
   * severity/path/message triples (the reviewer's own text), never a payload.
   */
  reviewFindings?: readonly {
    severity: string;
    path: string | null;
    message: string;
  }[];
  /**
   * Bounded verified prior-attempt facts from durable attempt memory, present
   * only when equivalent failures were recorded for the current base and
   * runtime revision. The model port renders them as an "already tried"
   * section so a fresh session does not repeat a refused approach. Never
   * permission to change budgets, credentials, review or model policy.
   */
  priorAttempts?: readonly PriorAttemptFactV1[];
  /**
   * Bounded cross-task lessons from durable memory: recent distinct failure
   * modes recorded for OTHER work items in the same repository at this exact
   * runtime revision. Shared operational context for a fresh session; never
   * permission to change budgets, credentials, review or model policy.
   */
  repositoryLessons?: readonly PriorAttemptFactV1[];
  /**
   * Bounded regression facts: work that succeeded at an older runtime
   * revision and now fails at the current one. Shared version-control
   * awareness for a fresh session; never permission to change budgets,
   * credentials, review, promotion or model policy.
   */
  regressions?: readonly RepositoryRegressionFactV1[];
  model: ModelIdV1;
  reasoning: ReasoningEffortV1;
  maxDurationMs: number;
  maxOutputChars: number;
  /**
   * Optional sub-task scope note for decomposed work. When an issue times out
   * repeatedly the planner splits it into serial parts; each part's cell
   * carries this note telling the model which slice of the issue to implement
   * (e.g. "part 2 of 3: ..."). Absent for whole-issue runs. Part of the
   * request digest, so a grant cannot be rebound to a different scope.
   */
  scopeNote?: string;
}

export interface CandidateOutcomeV1 {
  /** Locally validated candidate commit; push/publication is the writer's job. */
  head: GitSha | null;
  /** Durable checkpoint SHA produced before termination, if any. */
  checkpointSha: GitSha | null;
  /** Bounded changed path list (paths only, never payloads). */
  changedPaths: string[];
}

/**
 * Receipt of ONE bounded model run. The `actual` block is explicit
 * request/runtime evidence: `evidenceKind: "request-runtime"` labels trusted
 * submitted provider/model/effort configuration bound to the exact
 * invocation/thread/turn identity and runtime routing/terminal events. It is
 * NEVER a backend-observed provider attestation. The old field names are the
 * existing contract; `observedModel`/`observedReasoning` document the
 * acknowledged request/runtime metadata, not backend observation.
 */
export interface ModelRunReceiptV1 {
  invocationId: string;
  outcome: "completed" | "failed" | "interrupted";
  actual: {
    /** Evidence class: request/runtime evidence, never backend attestation. */
    evidenceKind: "request-runtime";
    /** Acknowledged provider configuration submitted with the run. */
    provider: string;
    /** Exact app-server thread identity acknowledged for the run. */
    threadId: string;
    /** Exact app-server turn identity acknowledged for the run. */
    turnId: string;
    /**
     * Terminal evidence origin: `runtime` means a correlated runtime terminal
     * event was actually observed for the exact thread/turn; `host-timeout`
     * means the host's own bounds elapsed without any runtime terminal and the
     * receipt is failed ACCOUNTING only — the run never claims an observed
     * terminal.
     */
    terminalOrigin: "runtime" | "host-timeout";
    /**
     * Observed runtime terminal status: `completed`/`interrupted`/`failed`
     * when a correlated runtime terminal event was actually observed for the
     * exact thread/turn, and null on a host timeout. The exact runtime status
     * is preserved even when the host's own loop stop yields `interrupted`
     * accounting over a completed terminal; null never pretends a terminal
     * was observed.
     */
    observedTerminalStatus: "completed" | "interrupted" | "failed" | null;
    /** Acknowledged model (request/runtime metadata, not backend observation). */
    observedModel: string;
    /** Acknowledged reasoning effort (request/runtime metadata, not observation). */
    observedReasoning: string;
    durationMs: number;
    outputChars: number;
  };
  candidate: CandidateOutcomeV1 | null;
  error: string | null;
}

export interface ImplementationPort {
  /**
   * Route-selected implementation model id this port is configured with. The
   * repair loop submits EXACTLY this id as `ModelRunRequestV1.model` (and the
   * port still validates that the submitted request equals it), so the receipt
   * records the id actually requested. Absence means the caller keeps the
   * frozen gateway default (`gpt-reserve`); the value is never rewritten by
   * the port after construction.
   */
  readonly modelId?: string;
  runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>>;
}
