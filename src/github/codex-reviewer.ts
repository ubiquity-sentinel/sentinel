/** One task-owned native Codex review over the existing durable transport.
 * Preparation opens a restricted thread without inference. The caller persists
 * and reads back its running journal before exactly one review/start may run.
 * Completion requires the correlated native entry/exit lifecycle, strict bound
 * result, runtime terminal and settled read-only commands/owned process.
 * Codex selects its reviewer; no caller model, provider, effort or output-schema
 * override is sent. Failures remain unavailable without retry or substitution.
 */

import {
  MAX_PROMPT_BYTES,
  renderReviewPrompt,
  type ReviewSnapshotV1,
  SNAPSHOT_DIGEST_DETAIL,
  validateReviewSnapshotV1,
  verifyReviewSnapshotDigest,
} from "./review-snapshot.ts";
import {
  checkReviewTaskStatement,
  type ReviewTaskStatementV1,
} from "../contracts/review-receipt.ts";
import type {
  ReviewJournalExecutionV1,
  ReviewJournalReadyExecutionV1,
  ReviewJournalRuntimeActualV1,
  ReviewResultV1,
} from "./review-journal.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import {
  CodexProtocolError,
  type CodexSessionV1,
} from "../repair/codex-transport.ts";
import {
  asRecord,
  boundedClose,
  isAbsoluteMs,
  isBoundedId,
  isValidPermissionProfile,
  racePromise,
  utf8Bytes,
} from "./reviewer-support.ts";
import {
  CLOSE_RESERVE_MS,
  DEADLINE_DETAIL,
  MAX_REVIEW_TOTAL_MS,
  PERMISSION_PROFILE_DETAIL,
  PREPARE_DETAIL,
  PREPARE_UNSETTLED_DETAIL,
  PROMPT_DETAIL,
  REQUEST_DETAIL,
  TASK_DETAIL,
  type ThreadAckV1,
} from "./reviewer-policy.ts";
import { PreparedStructuredReview } from "./reviewer-prepared.ts";
import { canonicalStringifySha256 } from "../contracts/canonical.ts";
import { nativeReviewInstructions } from "./native-review-result.ts";

/** One immutable prepare request for exactly one structured review. */
export interface StructuredReviewPrepareV1 {
  /** Immutable trusted snapshot the review is performed against. */
  snapshot: ReviewSnapshotV1;
  /**
   * Exact bounded source-issue task statement the review must judge, or
   * null/absent for work with no issue acceptance. When supplied, the result
   * MUST carry a task acceptance bound to this exact statement.
   */
  task?: ReviewTaskStatementV1 | null;
  /** Durable request identity carried by the transport journal. */
  requestId: string;
  /** Exact invocation identity bound to this review. */
  invocationId: string;
  /** Owning run identity persisted before any model start. */
  ownerRunId: string;
  /** Absolute ms: no turn may be submitted at or after this instant. */
  latestStartAt: number;
  /** Absolute ms: the whole review, including close, must settle by this. */
  settleBy: number;
}

/** Sanitized bounded review disposition using the accepted journal types. */
export interface StructuredReviewOutcomeV1 {
  status: "clean" | "findings" | "unavailable";
  /** Validated structured result; null when none was accepted. */
  result: ReviewResultV1 | null;
  /** Final result item identity; null when none was accepted. */
  resultId: string | null;
  /** Sanitized request/runtime receipt; null without correlated evidence. */
  actual: ReviewJournalRuntimeActualV1 | null;
  /** Ready execution binding; null unless clean/findings completed. */
  execution: ReviewJournalReadyExecutionV1 | null;
  /** Static sanitized failure detail; null on clean/findings. */
  detail: string | null;
}

/** Bounded idempotent close outcome of the owned transport. */
export interface StructuredReviewCloseV1 {
  /** True only when the owned transport proved full settlement. */
  settled: boolean;
  /** Static sanitized transport corruption marker; null when clean. */
  failure: string | null;
  /** True when the bounded close wait elapsed without settlement proof. */
  timedOut: boolean;
}

/** The prepared-but-not-started review session handed to the caller. */
export interface PreparedStructuredReviewV1 {
  /** Running execution identity; no turn exists yet. */
  readonly execution: ReviewJournalExecutionV1;
  readonly threadId: string;
  readonly invocationId: string;
  readonly requestId: string;
  readonly ownerRunId: string;
  readonly latestStartAt: number;
  readonly settleBy: number;
  /** True once the single start attempt has been consumed. */
  startAttempted(): boolean;
  /** Exactly-once single turn submission and bounded review result. */
  start(): Promise<PortResultV1<StructuredReviewOutcomeV1>>;
  /** Bounded idempotent close of the owned transport. */
  close(): Promise<StructuredReviewCloseV1>;
}

export interface CodexStructuredReviewerOptionsV1 {
  /** Deprecated compatibility input; trusted client config owns routing. Ignored. */
  provider: string;
  /** Deprecated compatibility input; native mode owns reviewer selection. Ignored. */
  model?: string;
  /** Trusted host capability opening the app-server session for one cwd. */
  openSession: (
    input: {
      cwd: string;
      requestId?: string;
      invocationId?: string;
      ownerRunId?: string;
      nativeReviewTargetDigest?: string;
    },
  ) => CodexSessionV1;
  /** Trusted absolute isolated session directory (read-only review cwd). */
  sessionCwd: string;
  /** Testable clock; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Required trusted host-defined named permission profile. It must match
   * /^[A-Za-z][A-Za-z0-9_-]{0,63}$/ and is never a built-in full-access id; a
   * missing or invalid value returns static unavailable BEFORE any session
   * opens, so a profile-less unrestricted review can never run. The reviewer
   * enables the app-server experimental capabilities, submits `permissions`
   * instead of the legacy `sandbox`, enables the ordinary shell read tool
   * (`features.shell_tool` with `features.unified_exec` disabled), requires
   * the exact `activePermissionProfile.id` acknowledgement before any turn and
   * leaves that acknowledged restriction active for native review/start.
   */
  permissionProfile: string;
}

/** Native reviewer; configuration and credential custody remain with its host. */
export class CodexStructuredReviewer {
  private readonly sessionCwd: string;
  private readonly openSession: CodexStructuredReviewerOptionsV1["openSession"];
  private readonly now: () => number;
  /** Required trusted configured named permission profile. */
  private readonly permissionProfile: string;

  constructor(options: CodexStructuredReviewerOptionsV1) {
    this.sessionCwd = options.sessionCwd;
    this.openSession = options.openSession;
    this.now = options.now ?? (() => Date.now());
    this.permissionProfile = options.permissionProfile;
  }

  /**
   * Initialize the app-server and open one acknowledged thread WITHOUT any
   * turn. The returned session exposes the running execution identity and may
   * be closed with zero starts; nothing here reserves model budget.
   */
  async prepare(
    request: StructuredReviewPrepareV1,
  ): Promise<PortResultV1<PreparedStructuredReviewV1>> {
    // The trusted named permission profile is REQUIRED and must be a valid
    // host-defined name BEFORE any session opens; built-in full-access ids are
    // never permitted and there is no profile-less read fallback.
    if (!isValidPermissionProfile(this.permissionProfile)) {
      return portError("unavailable", PERMISSION_PROFILE_DETAIL);
    }
    const input = asRecord(request);
    if (input === null) return portError("unavailable", REQUEST_DETAIL);
    const requestId = input.requestId;
    const invocationId = input.invocationId;
    const ownerRunId = input.ownerRunId;
    if (
      !isBoundedId(requestId) || !isBoundedId(invocationId) ||
      !isBoundedId(ownerRunId)
    ) {
      return portError("unavailable", REQUEST_DETAIL);
    }
    const snapshotValue = input.snapshot;
    const snapshotFailure = validateReviewSnapshotV1(snapshotValue);
    if (snapshotFailure !== null) {
      return portError("unavailable", snapshotFailure);
    }
    const snapshot = snapshotValue as ReviewSnapshotV1;
    if (!(await verifyReviewSnapshotDigest(snapshot))) {
      return portError("unavailable", SNAPSHOT_DIGEST_DETAIL);
    }
    const latestStartAt = input.latestStartAt;
    const settleBy = input.settleBy;
    if (!isAbsoluteMs(latestStartAt) || !isAbsoluteMs(settleBy)) {
      return portError("unavailable", DEADLINE_DETAIL);
    }
    const preparedAt = this.now();
    if (settleBy <= preparedAt || latestStartAt <= preparedAt) {
      return portError("unavailable", DEADLINE_DETAIL);
    }
    const hardSettleBy = Math.min(settleBy, preparedAt + MAX_REVIEW_TOTAL_MS);
    // Finite interrupt/close grace reserved INSIDE settleBy: the full
    // CLOSE_RESERVE_MS for ordinary deadlines, proportionally less when the
    // caller supplies a deliberately short (milliseconds) budget.
    const available = hardSettleBy - preparedAt;
    const closeReserve = Math.min(
      CLOSE_RESERVE_MS,
      Math.max(1, Math.floor(available / 2)),
    );
    const turnDeadline = hardSettleBy - closeReserve;
    if (turnDeadline <= preparedAt) {
      return portError("unavailable", DEADLINE_DETAIL);
    }
    // The optional source-issue task statement must be the strict bounded
    // shape AND its digest must actually bind its own text BEFORE any session
    // opens: a malformed statement never reaches a model, and an over-bound
    // one is a fail-closed refusal, never a silent truncation.
    let task: ReviewTaskStatementV1 | null = null;
    if (input.task !== undefined && input.task !== null) {
      const checked = await checkReviewTaskStatement(input.task);
      if (!checked.ok) return portError("unavailable", TASK_DETAIL);
      task = checked.statement;
    }
    // An empty native manifest is only meaningful with an independently
    // bound source task, never as a clean review of an absent candidate.
    const baseTask = snapshot.files.length === 0;
    if (baseTask && task === null) return portError("unavailable", TASK_DETAIL);
    const prompt = renderReviewPrompt(snapshot, task) + "\n\n" +
      nativeReviewInstructions(snapshot, task, this.sessionCwd);
    const targetDigest = await canonicalStringifySha256({
      type: "custom",
      instructions: prompt,
    });
    if (utf8Bytes(prompt) > MAX_PROMPT_BYTES) {
      return portError("unavailable", PROMPT_DETAIL);
    }

    // Both app-server handshake requests are raced against the absolute start
    // gate min(latestStartAt, turnDeadline): a hanging initialize or
    // thread/start can never outlive the caller's deadline, and every failure
    // closes the owned session inside the absolute hardSettleBy (never a fresh
    // now + CLOSE_BOUND_MS beyond the caller's deadline).
    const startGate = Math.min(latestStartAt, turnDeadline);
    let session: CodexSessionV1 | null = null;
    const failPreparation = async (
      owned: CodexSessionV1,
    ): Promise<PortResultV1<PreparedStructuredReviewV1>> => {
      const close = await boundedClose(owned, this.now, hardSettleBy);
      return portError(
        "unavailable",
        close.settled ? PREPARE_DETAIL : PREPARE_UNSETTLED_DETAIL,
      );
    };
    try {
      session = this.openSession({
        cwd: this.sessionCwd,
        requestId,
        invocationId,
        ownerRunId,
        nativeReviewTargetDigest: targetDigest,
      });
      session.open?.();
      const initialized = await racePromise(
        this.initialize(session),
        startGate,
        this.now,
      );
      if (!initialized.ok || this.now() >= startGate) {
        const owned = session;
        session = null;
        return await failPreparation(owned);
      }
      const threaded = await racePromise(
        this.startThread(session),
        startGate,
        this.now,
      );
      if (!threaded.ok || this.now() >= startGate) {
        const owned = session;
        session = null;
        return await failPreparation(owned);
      }
      const prepared = new PreparedStructuredReview({
        session,
        prompt,
        snapshot,
        task,
        now: this.now,
        request: {
          snapshot,
          task,
          requestId,
          invocationId,
          ownerRunId,
          latestStartAt,
          settleBy,
        },
        thread: threaded.value,
        hardSettleBy,
        turnDeadline,
        permissionProfile: this.permissionProfile,
        sessionCwd: this.sessionCwd,
        targetDigest,
      });
      session = null;
      return portOk(prepared);
    } catch {
      if (session === null) {
        return portError("unavailable", PREPARE_DETAIL);
      }
      return await failPreparation(session);
    }
  }

  private async initialize(session: CodexSessionV1): Promise<void> {
    const response = await session.send("initialize", {
      clientInfo: { name: "sentinel-structured-review", version: "0.1.0" },
      capabilities: {
        // The prepared session always binds a trusted named permission profile,
        // so the app-server experimental capabilities are always enabled.
        experimentalApi: true,
        // This bounded reviewer never consumes reasoning summary/text streams,
        // so ask the server to stop streaming them. Any that still arrive are
        // charged by the existing event bound like every other notification.
        optOutNotificationMethods: [
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta",
        ],
      },
    });
    const record = asRecord(response);
    if (record === null || typeof record.userAgent !== "string") {
      throw new CodexProtocolError(
        "malformed_line",
        "initialize response missing evidence",
      );
    }
    session.notify("initialized", {});
  }

  private async startThread(
    session: CodexSessionV1,
  ): Promise<ThreadAckV1> {
    // The ordinary agent shell read tool is enabled with the installed one-shot
    // exec handler (`shell_tool` true, `unified_exec` false): no write_stdin,
    // TTY or resumable authority is granted for the named restricted profile.
    const threadParams: Record<string, unknown> = {
      cwd: this.sessionCwd,
      approvalPolicy: "never",
      ephemeral: true,
      config: {
        "features.shell_tool": true,
        "features.unified_exec": false,
        "features.multi_agent": false,
        "features.apps": false,
        web_search: "disabled",
      },
      // The trusted named profile replaces the legacy read-only sandbox
      // entirely: the installed schema forbids combining the two fields.
      permissions: this.permissionProfile,
    };
    const response = await session.send("thread/start", threadParams);
    const record = asRecord(response);
    const thread = asRecord(record?.thread);
    const threadId = thread?.id;
    if (!isBoundedId(threadId)) {
      throw new CodexProtocolError(
        "malformed_line",
        "thread/start response missing a bounded thread id",
      );
    }
    const model = record?.model;
    const modelProvider = record?.modelProvider;
    const reasoningEffort = record?.reasoningEffort;
    if (
      !isBoundedId(model) || !isBoundedId(modelProvider) ||
      (reasoningEffort !== null && !isBoundedId(reasoningEffort))
    ) {
      throw new CodexProtocolError(
        "malformed_line",
        "thread/start response has malformed default selection metadata",
      );
    }
    // The required named profile must be acknowledged exactly BEFORE any turn
    // starts; a missing or wrong acknowledgement fails preparation (the owned
    // session is settled by the caller's bounded close path) and no turn is
    // ever submitted.
    const active = asRecord(record?.activePermissionProfile);
    if (active === null || active.id !== this.permissionProfile) {
      throw new CodexProtocolError(
        "malformed_line",
        "thread/start response does not acknowledge the configured permission profile",
      );
    }
    return { threadId, model, modelProvider, reasoningEffort };
  }
}
export { MAX_REVIEW_TOTAL_MS } from "./reviewer-policy.ts";
export { CLOSE_RESERVE_MS } from "./reviewer-policy.ts";
export { TURN_INTERRUPT_GRACE_MS } from "./reviewer-policy.ts";
export { CLOSE_BOUND_MS } from "./reviewer-policy.ts";
export { finalizeReviewCompletion } from "./reviewer-support.ts";
