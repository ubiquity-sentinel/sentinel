/** Public implementation adapter: session admission, protocol starts and failover. */
import type {
  Clock,
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError } from "../contracts/ports.ts";
import type { ModelRunOptionsV1 } from "../contracts/ports-model.ts";
import { CodexProtocolError, type CodexSessionV1 } from "./codex-transport.ts";
import type {
  CandidateCommitterV1,
  CheckoutResolverV1,
} from "./model-port-checkout.ts";
import {
  createRequestRuntimeReceiptVerifier,
  finishReceipt,
  type ReceiptVerifierV1,
} from "./model-port-receipt.ts";
import { buildPrompt } from "./model-port-prompt.ts";
import { awaitSettlement } from "./model-port-settlement.ts";
import { EarlyNotificationSession } from "./model-port-notifications.ts";
import {
  failoverWindowMsV1,
  isProviderThrottledResultV1,
  retryRateLimitedV1,
  sessionBudgetAnchorV1,
} from "./model-port-retry.ts";
import {
  DEFAULT_INTERRUPT_SETTLEMENT_GRACE_MS,
  DEFAULT_MODEL_ID,
  isBoundedId,
  isValidModelId,
  isValidPermissionProfile,
  isValidProvider,
  MODEL_POLICY_DETAIL,
  PERMISSION_PROFILE_POLICY_DETAIL,
  PROVIDER_POLICY_DETAIL,
  REQUIRED_REASONING_EFFORT,
  requireRecord,
  UNAVAILABLE_RECEIPT_DETAIL,
  unavailableFor,
} from "./model-port-policy.ts";

export interface CodexImplementationPortOptionsV1 {
  /** Opens one bounded app-server session per run (injectable for tests). */
  openSession(): Promise<CodexSessionV1>;
  /** Absolute path of the secret-free model checkout. */
  checkoutDir: string;
  /**
   * Trusted host mode for the owner-only local iteration pause. Repository
   * identity is not a mode because hosted repair also operates on Sentinel.
   */
  localIteration?: boolean;
  /** Local checkout identity resolver (injectable for tests). */
  checkout?: CheckoutResolverV1;
  /**
   * Explicit selected provider, e.g. `openai` or a host provider name. A
   * nonempty finite string is REQUIRED before any session opens — including
   * the custom-verifier path: a missing provider stays unavailable and a
   * callback never enables a missing provider. With a selected provider the
   * port always binds the real request/runtime receipt producer for that exact
   * provider, submits the provider explicitly on thread/start, and validates
   * the acknowledged thread provider/model/effort and bounded thread id BEFORE
   * any turn starts.
   */
  modelProvider?: string;
  /**
   * Route-selected runtime model id this port is configured with. Callers that
   * do not pass one keep the frozen gateway default (`gpt-reserve`). The port
   * validates the submitted request against EXACTLY this value (and the receipt
   * verifier requires the requested model to equal it), so the id is never
   * rewritten after construction and a receipt always records the model that
   * was actually requested. An invalid value (empty, over bound, control
   * characters or surrounding whitespace) fails closed with no model call.
   */
  modelId?: string;
  /**
   * Gateway failover model id (e.g. `gpt-6-luna`) the port retries with when
   * the primary model is rate limited (HTTP 429). Same gateway endpoint,
   * same credentials, frozen `max` reasoning — only the model id changes,
   * and only on a 429. The retry is a fresh, self-consistent attempt: its
   * request names the failover model and its receipt records exactly that.
   * When the failover is ALSO rate limited, a bounded backoff alternates the
   * primary and the failover inside the same admission and the remaining
   * session budget (see `model-port-retry.ts`). An invalid value (or one
   * equal to the primary) disables the failover and that backoff.
   */
  failoverModelId?: string;
  /** 429 backoff clock and sleep (injectable; default system time). */
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The caller's model start boundary: the 429 backoff never extends past it
   * plus the request's duration bound (default: `runModel` entry).
   */
  sessionStartedAt?: number;
  /**
   * Optional trusted host-defined named permission profile. When present it
   * must match /^[A-Za-z][A-Za-z0-9_-]{0,63}$/ and is never a built-in
   * full-access id; an invalid value returns static unavailable before any
   * session opens. With a configured profile the port enables the app-server
   * experimental capabilities, submits `permissions` INSTEAD of the legacy
   * `sandbox` on thread/start, and requires the exact
   * `activePermissionProfile.id` acknowledgement BEFORE any turn starts.
   * When omitted the legacy workspace-write sandbox behavior is unchanged.
   */
  permissionProfile?: string;
  /**
   * Trusted-host receipt verifier (kept for tests/host injection); it is only
   * an ADDITIONAL restriction applied AFTER the concrete core request/runtime
   * checks, so it can never bypass correlation, routing or model-policy
   * validation. Without a provider the port stays unavailable regardless.
   */
  receiptVerifier?: ReceiptVerifierV1;
  /** Optional trusted host commit step for sandboxed model checkouts. */
  commitCandidate?: CandidateCommitterV1;
  /** Grace for terminal settlement after an interrupt request. */
  interruptSettlementGraceMs?: number;
  /**
   * The trusted configured protected path prefixes of the checkout's
   * repository, named in the prompt (`renderProtectedPaths`). Never part of
   * the request, its digest or a receipt; omitted means none are named.
   */
  protectedPaths?: readonly string[];
}

export class CodexImplementationPort implements ImplementationPort {
  private readonly options: CodexImplementationPortOptionsV1;
  /** Core concrete request/runtime producer; ALWAYS the first receipt gate. */
  private readonly coreVerifier: ReceiptVerifierV1;
  /** Optional additional restriction applied only after the core checks. */
  private readonly customVerifier: ReceiptVerifierV1 | null;
  private readonly graceMs: number;
  /** Trusted configured named permission profile; null when omitted. */
  private readonly permissionProfile: string | null;
  /** Whether this session is the explicitly paused owner-local iteration. */
  private readonly localIteration: boolean;
  /**
   * Exact route-selected runtime model id this port submits and certifies. An
   * invalid configured value becomes the empty string, which no valid request
   * can ever match: the port then fails closed before any session opens.
   */
  readonly modelId: string;
  /**
   * Gateway failover model id for HTTP 429 retries. Empty when disabled: the
   * port then never retries and behaves exactly as before.
   */
  readonly failoverModelId: string;
  /** Receipt verifier bound to the failover model; null when disabled. */
  private readonly failoverVerifier: ReceiptVerifierV1 | null;
  private readonly backoff: Required<
    Pick<CodexImplementationPortOptionsV1, "clock" | "sleep">
  >;

  constructor(options: CodexImplementationPortOptionsV1) {
    this.options = options;
    const configuredModelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.modelId = isValidModelId(configuredModelId) ? configuredModelId : "";
    const configuredFailover = options.failoverModelId ?? "";
    this.failoverModelId =
      isValidModelId(configuredFailover) && configuredFailover !== this.modelId
        ? configuredFailover
        : "";
    // The concrete request/runtime receipt producer for the exact selected
    // provider and model is ALWAYS the core gate (an invalid/missing provider
    // or model returns unavailable before any session opens, so an invalid
    // expected value is just a never-satisfied gate). A custom verifier can
    // only restrict.
    this.coreVerifier = createRequestRuntimeReceiptVerifier(
      options.modelProvider ?? "",
      this.modelId,
    );
    // The failover attempt is a separate self-consistent run: its own
    // verifier binds the failover model id so its receipt records exactly
    // the model that was actually requested on the retry.
    this.failoverVerifier = this.failoverModelId === ""
      ? null
      : createRequestRuntimeReceiptVerifier(
        options.modelProvider ?? "",
        this.failoverModelId,
      );
    this.customVerifier = options.receiptVerifier ?? null;
    this.graceMs = options.interruptSettlementGraceMs ??
      DEFAULT_INTERRUPT_SETTLEMENT_GRACE_MS;
    this.permissionProfile = options.permissionProfile ?? null;
    this.localIteration = options.localIteration === true;
    this.backoff = {
      clock: options.clock ?? { now: () => Date.now() },
      sleep: options.sleep ??
        ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  async runModel(
    request: ModelRunRequestV1,
    options?: ModelRunOptionsV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    // Untrusted CI evidence rides beside the request into every attempt's
    // turn input (failover and backoff included), never into the thread's
    // instructions, and it is never part of a receipt.
    const ciEvidence = options?.untrustedCiEvidence;
    // Fail-closed model policy validation BEFORE any session or model work:
    // the requested runtime model must be exactly the route-selected model this
    // port was constructed with (never a literal) and the effort exactly `max`.
    if (
      !isValidModelId(request.model) ||
      request.model !== this.modelId ||
      request.reasoning !== REQUIRED_REASONING_EFFORT
    ) {
      return portError("unavailable", MODEL_POLICY_DETAIL);
    }
    const { clock, sleep } = this.backoff;
    const budgetEndsAt = request.maxDurationMs +
      sessionBudgetAnchorV1(clock.now(), this.options.sessionStartedAt);
    const primary = await this.runAttempt(
      request,
      this.modelId,
      this.coreVerifier,
      undefined,
      ciEvidence,
    );
    // Gateway 429 failover: when the primary model is rate limited, retry
    // ONCE with the failover model on the same endpoint and credentials.
    // Every other failure returns as-is — the failover engages ONLY on 429.
    const failoverVerifier = this.failoverVerifier;
    if (
      failoverVerifier === null ||
      !isProviderThrottledResultV1(primary, request)
    ) return primary;
    // The failover runs in what remains of the session budget, never a fresh
    // full bound: a primary that ran long before its 429 leaves less.
    const failoverWindowMs = failoverWindowMsV1(
      request.maxDurationMs,
      budgetEndsAt,
      clock.now(),
    );
    if (failoverWindowMs === null) return primary;
    console.error(
      `[sentinel] model ${this.modelId} rate limited (429); failing over ` +
        `to ${this.failoverModelId} with max reasoning`,
    );
    const failoverRequest = { ...request, model: this.failoverModelId };
    const failover = await this.runAttempt(
      failoverRequest,
      this.failoverModelId,
      failoverVerifier,
      failoverWindowMs,
      ciEvidence,
    );
    if (!isProviderThrottledResultV1(failover, request)) return failover;
    // Both throttled: bounded backoff in this admission and session budget,
    // alternating fresh attempts each certified by its own model's verifier.
    return await retryRateLimitedV1({
      request,
      models: [this.modelId, this.failoverModelId],
      budgetEndsAt,
      last: failover,
      now: () => clock.now(),
      sleep,
      attempt: (model, windowMs) =>
        model === this.modelId
          ? this.runAttempt(
            request,
            this.modelId,
            this.coreVerifier,
            windowMs,
            ciEvidence,
          )
          : this.runAttempt(
            failoverRequest,
            this.failoverModelId,
            failoverVerifier,
            windowMs,
            ciEvidence,
          ),
    });
  }

  /**
   * One self-consistent model attempt: the request names exactly the model
   * this attempt submits, and the receipt records exactly that model. The
   * failover retry is a separate attempt with its own verifier, never a
   * mid-run model swap. A backoff retry passes `durationBoundMs`, the
   * remaining session budget, which only ever shortens the request's bound.
   */
  private async runAttempt(
    request: ModelRunRequestV1,
    expectedModel: string,
    verifier: ReceiptVerifierV1,
    durationBoundMs?: number,
    ciEvidence?: string,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    // The attempt's request must name exactly the model this attempt submits;
    // the receipt then truthfully records the model that was requested.
    if (request.model !== expectedModel) {
      return portError("unavailable", MODEL_POLICY_DETAIL);
    }
    // An explicit valid modelProvider is REQUIRED before ANY session opens,
    // including the custom-verifier path: a missing provider stays
    // unavailable and a callback never enables a missing provider.
    if (this.options.modelProvider === undefined) {
      return portError("unavailable", UNAVAILABLE_RECEIPT_DETAIL);
    }
    if (!isValidProvider(this.options.modelProvider)) {
      return portError("unavailable", PROVIDER_POLICY_DETAIL);
    }
    // A configured named permission profile must be a valid host-defined name
    // BEFORE any session opens; built-in full-access ids are never permitted.
    if (
      this.permissionProfile !== null &&
      !isValidPermissionProfile(this.permissionProfile)
    ) {
      return portError("unavailable", PERMISSION_PROFILE_POLICY_DETAIL);
    }
    let session: CodexSessionV1 | null = null;
    const invocationId = `codex-${request.taskId}-${Date.now()}`;
    try {
      session = await this.options.openSession();
      // CodexSubprocessSession is intentionally lazy so construction remains
      // side-effect free. Open it at the exact model boundary; an already
      // opened concrete session is accepted because open() is idempotent.
      session.open?.();
      // Consume before any protocol request: a model can emit a whole turn
      // before turn/start responds, so transport backpressure must never
      // wait for the response that enables settlement registration.
      let earlyNotifications: EarlyNotificationSession;
      try {
        earlyNotifications = new EarlyNotificationSession(session);
      } catch {
        return portError("unavailable", "notification registration failed");
      }
      session = earlyNotifications;
      await this.initialize(session);
      // The thread's base instructions are the system-level slot: they hold
      // only the trusted prompt. Untrusted CI evidence (output of running the
      // candidate's code) reaches the model only once, in the user turn, so
      // it never arrives with instruction authority.
      const protectedPaths = this.options.protectedPaths ?? [];
      const instructions = buildPrompt(
        request,
        this.localIteration,
        undefined,
        protectedPaths,
      );
      const prompt = ciEvidence === undefined
        ? instructions
        : buildPrompt(request, this.localIteration, ciEvidence, protectedPaths);
      const thread = await this.startThread(session, request, instructions);
      const turn = await this.startTurn(
        session,
        request,
        prompt,
        thread.threadId,
      );
      const captureSettlement = await awaitSettlement(
        this.options.checkoutDir,
        this.graceMs,
        session,
        request,
        thread.threadId,
        turn.turnId,
        request.maxOutputChars,
        durationBoundMs,
        () => earlyNotifications.getEarlyEvidence(),
      );
      // The model must be fully closed, including its owned process group,
      // before the trusted host inspects or commits the checkout. A direct
      // child exit is not proof that a descendant has stopped writing files.
      const ownedSession = session;
      session = null;
      await ownedSession.close();
      if (ownedSession.isSettled !== undefined && !ownedSession.isSettled()) {
        return portError(
          "unavailable",
          "model session process group did not settle",
        );
      }
      // A fatal transport/session error observed before close is static typed
      // unavailable evidence: a verified receipt can never escape a transport
      // that already failed closed. Intentionally closing a healthy session
      // never manufactures one (getFailure stays null after a clean close).
      if (ownedSession.getFailure !== undefined) {
        const failure = ownedSession.getFailure();
        if (failure !== null) {
          return portError("unavailable", failure.detail);
        }
      }
      // Final evidence capture happens ONLY after the session is fully closed
      // and its settlement/transport state is verified: bounded correlated
      // routing notifications delivered during close are still validated into
      // this snapshot, and a later notification can never change the receipt.
      const settled = captureSettlement();
      return await finishReceipt(
        this.options,
        this.customVerifier,
        this,
        request,
        invocationId,
        thread,
        turn.turnId,
        settled,
        verifier,
      );
    } catch (error) {
      const failure = unavailableFor(error);
      return portError(failure.kind, failure.detail);
    } finally {
      await session?.close();
    }
  }

  private async initialize(session: CodexSessionV1): Promise<unknown> {
    const response = await session.send("initialize", {
      clientInfo: {
        name: "sentinel-repair",
        title: "Sentinel repair controller",
        version: "0.1.0",
      },
      capabilities: {
        // Experimental app-server capabilities are enabled ONLY for a trusted
        // configured named permission profile; the legacy path stays as is.
        experimentalApi: this.permissionProfile !== null,
        requestAttestation: false,
        // This bounded port never consumes reasoning summary/text streams, so
        // ask the server to stop streaming them. Any that still arrive are
        // charged by the existing output bound like every other notification.
        optOutNotificationMethods: [
          "item/reasoning/summaryTextDelta",
          "item/reasoning/summaryPartAdded",
          "item/reasoning/textDelta",
        ],
      },
    });
    if (
      typeof response !== "object" || response === null ||
      typeof (response as Record<string, unknown>).userAgent !== "string"
    ) {
      throw new CodexProtocolError(
        "malformed_line",
        "initialize response missing evidence",
      );
    }
    session.notify("initialized", {});
    return response;
  }

  private async startThread(
    session: CodexSessionV1,
    request: ModelRunRequestV1,
    prompt: string,
  ): Promise<
    {
      threadId: string;
      model: string | null;
      effort: string | null;
      provider: string | null;
    }
  > {
    const startParams: Record<string, unknown> = {
      model: request.model,
      // The thread response is the only app-server model/effort evidence
      // available to this bounded port.  Bind the required runtime effort in
      // the thread config as well as the per-turn override below so the
      // observed thread receipt cannot silently inherit a weaker host default.
      config: { model_reasoning_effort: request.reasoning },
      cwd: this.options.checkoutDir,
      approvalPolicy: "never",
      ephemeral: true,
      baseInstructions: prompt,
      // A valid provider is required before this session opened: submit it
      // explicitly so the thread response can acknowledge the exact provider.
      modelProvider: this.options.modelProvider,
    };
    if (this.permissionProfile !== null) {
      // Trusted named profile: the installed schema forbids combining
      // `permissions` with the legacy `sandbox` field, so the configured
      // profile replaces the sandbox entirely for this thread.
      startParams.permissions = this.permissionProfile;
    } else {
      // Bounded isolated-checkout write capability: the session may write
      // within the secret-free checkout only (the thread cwd is the checkout
      // root); the host approval policy stays "never" and no other sandbox is
      // granted. "read-only" would make the requested commit impossible.
      startParams.sandbox = "workspace-write";
    }
    const response = await session.send("thread/start", startParams);
    const record = requireRecord(response, "thread/start");
    const thread = (record.thread ?? null) as Record<string, unknown> | null;
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (threadId === null || !isBoundedId(threadId)) {
      throw new CodexProtocolError(
        "malformed_line",
        "thread/start response missing a nonempty bounded thread id",
      );
    }
    const model = typeof record.model === "string" ? record.model : null;
    const effort = typeof record.reasoningEffort === "string"
      ? record.reasoningEffort
      : null;
    const provider = typeof record.modelProvider === "string"
      ? record.modelProvider
      : null;
    // The thread response MUST acknowledge the exact route provider/model and a
    // nonempty bounded thread id BEFORE any turn starts: a mismatch never
    // spends a model turn.
    if (
      model !== request.model || effort !== request.reasoning ||
      provider !== this.options.modelProvider
    ) {
      throw new CodexProtocolError(
        "malformed_line",
        "thread/start response does not acknowledge the requested provider/model/effort",
      );
    }
    // A configured named profile must be acknowledged exactly BEFORE any turn
    // starts; a missing or wrong acknowledgement fails closed (the session is
    // settled by the caller's owned close path) and no model turn is spent.
    if (this.permissionProfile !== null) {
      const active = record.activePermissionProfile;
      if (
        typeof active !== "object" || active === null ||
        (active as Record<string, unknown>).id !== this.permissionProfile
      ) {
        throw new CodexProtocolError(
          "malformed_line",
          "thread/start response does not acknowledge the configured permission profile",
        );
      }
    }
    return { threadId, model, effort, provider };
  }

  private async startTurn(
    session: CodexSessionV1,
    request: ModelRunRequestV1,
    prompt: string,
    threadId: string,
  ): Promise<{ turnId: string }> {
    const response = await session.send("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      model: request.model,
      effort: request.reasoning,
    });
    const record = requireRecord(response, "turn/start");
    const turn = (record.turn ?? null) as Record<string, unknown> | null;
    const turnId = typeof turn?.id === "string" ? turn.id : null;
    if (turnId === null || !isBoundedId(turnId)) {
      throw new CodexProtocolError(
        "malformed_line",
        "turn/start response missing a nonempty bounded turn id",
      );
    }
    return { turnId };
  }
}
