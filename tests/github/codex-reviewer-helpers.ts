// codex reviewer helpers.

import { asGitSha, type GitSha } from "../../src/contracts/brands.ts";
import assert from "node:assert/strict";
import type {
  CodexProtocolError,
  CodexServerNotificationV1,
  CodexServerRequestV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";
import {
  reviewSnapshotDigest,
  type ReviewSnapshotV1,
} from "../../src/github/review-snapshot.ts";
import {
  CodexStructuredReviewer,
  type CodexStructuredReviewerOptionsV1,
  type StructuredReviewOutcomeV1,
  type StructuredReviewPrepareV1,
} from "../../src/github/codex-reviewer.ts";
import {
  NATIVE_REVIEW_CLOSE,
  NATIVE_REVIEW_OPEN,
  nativeFindingSuffix,
} from "../../src/github/native-review-result.ts";
import { MAX_RESULT_SUMMARY } from "../../src/github/review-journal.ts";
import {
  MAX_UNAVAILABLE_REASON_CHARS,
  staticUnavailableSummary,
} from "../../src/github/codex-review-transport.ts";

export const BASE: GitSha = asGitSha("a".repeat(40));

export const HEAD: GitSha = asGitSha("b".repeat(40));

export const PROVIDER = "openai";

export const REVIEW_PROFILE = "sentinel-review";

export const SESSION_CWD = "/tmp/sentinel-review-checkout";

export const CLEAN_RESULT = {
  verdict: "clean",
  summary: "The supplied change matches the specification.",
  findings: [],
} as const;

export const FINDINGS_RESULT = {
  verdict: "findings",
  summary: "deposit subtracts the amount instead of adding it.",
  findings: [{
    priority: 1,
    title: "Deposit uses subtraction",
    body: "The specification requires `deposit(balance, amount)` to return " +
      "`balance + amount`.\n\nThis implementation returns `balance - amount`, " +
      "so every non-negative deposit decreases the balance.",
    path: "account.ts",
    lineStart: 1,
    lineEnd: 3,
  }],
} as const;

export const ACCOUNT_CONTENT =
  "export function deposit(balance: number, amount: number) {\n" +
  '  if (amount < 0) throw new Error("negative");\n' +
  "  return balance + amount;\n" +
  "}\n";

export function contains(text: string, needle: string, message?: string): void {
  assert.ok(text.includes(needle), message ?? `expected ${needle} in text`);
}

/** Scripted app-server session double with an ordered pre-registration backlog. */
export class ScriptedCodexSession implements CodexSessionV1 {
  readonly sent: string[] = [];
  readonly params: unknown[] = [];
  opened = 0;
  closed = 0;
  settled = true;
  failure: CodexProtocolError | null = null;
  threadAck: unknown = {
    thread: { id: "thread-1" },
    model: "gpt-reserve",
    modelProvider: PROVIDER,
    reasoningEffort: "max",
    activePermissionProfile: { id: REVIEW_PROFILE },
  };
  turnId = "turn-1";
  nativeEntry = true;
  nativeBinding: unknown = null;
  private readonly nativeStarts = new Set<string>();
  turnResponse: unknown = null;
  turnFailure = false;
  /** Methods whose response never arrives (bounded handshake regression). */
  readonly hangMethods = new Set<string>();
  /** Per-method response delay in milliseconds. */
  sendDelayMs: Partial<Record<string, number>> = {};
  /** Emitted synchronously inside the turn/start request (early buffering). */
  plan: (session: ScriptedCodexSession) => void = () => {};
  /** Emitted on a macrotask after the turn/start response (live delivery). */
  live: ((session: ScriptedCodexSession) => void) | null = null;
  closeHook: (() => void | Promise<void>) | null = null;

  private notificationHandler:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;
  private serverRequestHandler:
    | ((request: CodexServerRequestV1) => void)
    | null = null;
  private readonly backlog: CodexServerNotificationV1[] = [];

  open(): void {
    this.opened++;
  }

  async send(method: string, params: unknown): Promise<unknown> {
    this.sent.push(method);
    this.params.push(params);
    if (this.hangMethods.has(method)) return await new Promise(() => {});
    const delay = this.sendDelayMs[method];
    if (delay !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (method === "initialize") {
      return { userAgent: "scripted/0.1.0" };
    }
    if (method === "thread/start") return this.threadAck;
    if (method === "review/start") {
      if (this.turnFailure) {
        throw new Error("scripted submission failure");
      }
      const prompt =
        (params as { target: { instructions: string } }).target.instructions;
      const match = /<SENTINEL_NATIVE_REVIEW_V1>\{"binding":(\{[^}]+\})/.exec(
        prompt,
      );
      this.nativeBinding = match ? JSON.parse(match[1]) : null;
      if (this.nativeEntry) {
        const entry = {
          threadId: "thread-1",
          turnId: this.turnId,
          item: {
            type: "enteredReviewMode",
            id: "entered-1",
            review: "custom review",
          },
        };
        this.emit("item/started", entry);
        this.emit("item/completed", entry);
      }
      this.plan(this);
      const live = this.live;
      if (live !== null) setTimeout(() => live(this), 0);
      return this.turnResponse ??
        {
          turn: { id: this.turnId, status: "inProgress" },
          reviewThreadId: "thread-1",
        };
    }
    return {};
  }

  notify(): void {}

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notificationHandler = handler;
    const backlog = [...this.backlog];
    this.backlog.length = 0;
    for (const event of backlog) handler(event);
  }

  onServerRequest(handler: (request: CodexServerRequestV1) => void): void {
    this.serverRequestHandler = handler;
  }

  async close(): Promise<void> {
    this.closed++;
    if (this.closeHook !== null) await this.closeHook();
  }

  isSettled(): boolean {
    return this.settled;
  }

  getFailure(): CodexProtocolError | null {
    return this.failure;
  }

  emit(method: string, params: unknown): void {
    const data = params as {
      threadId?: string;
      turnId?: string;
      item?: { type?: string; id: string; review?: string };
    };
    if (data?.item?.type === "exitedReviewMode") {
      const item = data.item;
      if (method === "item/completed" && !this.nativeStarts.has(item.id)) {
        this.emit("item/started", { ...data, item: { ...item, review: "" } });
      }
      if (method === "item/started") this.nativeStarts.add(item.id);
      if (
        method === "item/completed" && typeof item.review === "string" &&
        !item.review.startsWith(NATIVE_REVIEW_OPEN)
      ) {
        let suffix = "";
        try {
          suffix = nativeFindingSuffix(
            JSON.parse(item.review),
            (this.params[1] as { cwd: string }).cwd,
          );
        } catch { /* malformed results remain malformed */ }
        params = {
          ...data,
          item: {
            ...item,
            review: NATIVE_REVIEW_OPEN + '{"binding":' +
              JSON.stringify(this.nativeBinding) + ',"result":' + item.review +
              "}" + NATIVE_REVIEW_CLOSE + suffix,
          },
        };
      }
    }
    const event = { method, params };
    if (this.notificationHandler === null) {
      this.backlog.push(event);
      return;
    }
    this.notificationHandler(event);
  }

  requestServer(method: string): void {
    this.serverRequestHandler?.({ id: 1, method, params: {} });
  }

  turnStarts(): number {
    return this.sent.filter((method) => method === "review/start").length;
  }
}

export async function snapshotFixture(
  overrides: Partial<ReviewSnapshotV1> = {},
): Promise<ReviewSnapshotV1> {
  const draft: ReviewSnapshotV1 = {
    version: "v1",
    base: BASE,
    head: HEAD,
    mergeBase: BASE,
    files: [{
      path: "account.ts",
      kind: "modified",
      oldBlob: "1".repeat(40),
      newBlob: "2".repeat(40),
      oldMode: "100644",
      newMode: "100644",
      candidateLines: 4,
    }],
    digest: "",
    ...overrides,
  };
  const digest = await reviewSnapshotDigest(draft);
  return { ...draft, digest };
}

export function prepareRequest(
  snapshot: ReviewSnapshotV1,
  overrides: Partial<StructuredReviewPrepareV1> = {},
): StructuredReviewPrepareV1 {
  const now = Date.now();
  return {
    snapshot,
    requestId: "request-1",
    invocationId: "invocation-1",
    ownerRunId: "run-1",
    latestStartAt: now + 60_000,
    settleBy: now + 120_000,
    ...overrides,
  };
}

export function makeReviewer(
  session: ScriptedCodexSession,
  overrides: Record<string, unknown> = {},
): CodexStructuredReviewer {
  return new CodexStructuredReviewer(
    Object.assign(
      {
        provider: PROVIDER,
        openSession: () => session,
        sessionCwd: SESSION_CWD,
        permissionProfile: REVIEW_PROFILE,
      },
      overrides,
    ) as CodexStructuredReviewerOptionsV1,
  );
}

/**
 * One installed 0.154 `commandExecution` item shape for the trusted session
 * cwd: bounded id/command, `commandActions` best-effort classification and
 * agent provenance (source omitted).
 */
export function commandItem(
  itemId: string,
  status: "inProgress" | "completed" | "failed" | "declined",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "commandExecution",
    id: itemId,
    command: "rg --no-heading -n deposit account.ts",
    commandActions: [{ type: "read" }],
    cwd: SESSION_CWD,
    status,
    ...overrides,
  };
}

export function agentMessage(
  turnId: string,
  itemId: string,
  text: string,
  phase?: string | null,
): unknown {
  const item: Record<string, unknown> = {
    type: phase === "commentary" || phase === "analysis" || phase === "interim"
      ? "agentMessage"
      : "exitedReviewMode",
    id: itemId,
    ...(phase === "commentary" || phase === "analysis" || phase === "interim"
      ? { text }
      : { review: text }),
  };
  if (phase !== undefined) item.phase = phase;
  return { threadId: "thread-1", turnId, item };
}

export function turnCompleted(
  turnId: string,
  status: "completed" | "interrupted" | "failed" = "completed",
): unknown {
  return {
    threadId: "thread-1",
    turn: { id: turnId, status, durationMs: 1234 },
  };
}

/** One echoed user input item exactly as the app-server returns it. */
export function userItem(
  itemId: string,
  prompt: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "userMessage",
    id: itemId,
    clientId: "client-1",
    content: [{ type: "text", text: prompt, text_elements: [] }],
    ...overrides,
  };
}

export function userMessage(
  turnId: string,
  item: Record<string, unknown>,
): unknown {
  return { threadId: "thread-1", turnId, item };
}

export function reasoningItem(turnId: string, itemId: string): unknown {
  return {
    threadId: "thread-1",
    turnId,
    item: { type: "reasoning", id: itemId },
  };
}

/** Exact prompt the reviewer submitted in its single turn/start request. */
export function submittedPrompt(session: ScriptedCodexSession): string {
  const params = session.params[2] as { target: { instructions: string } };
  return params.target.instructions;
}

export function assertStrictObjectFields(schema: unknown): void {
  if (schema === null || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    for (const child of schema) assertStrictObjectFields(child);
    return;
  }
  const node = schema as Record<string, unknown>;
  if (node.properties !== undefined) {
    assert.ok(node.properties !== null && typeof node.properties === "object");
    assert.ok(!Array.isArray(node.properties));
    assert.ok(Array.isArray(node.required));
    assert.deepEqual(
      [...node.required].sort(),
      Object.keys(node.properties).sort(),
      "every submitted object property must be required",
    );
    assert.equal(node.additionalProperties, false);
  }
  for (const child of Object.values(node)) assertStrictObjectFields(child);
}

export function submittedResultContract(
  session: ScriptedCodexSession,
): Record<string, unknown> & {
  type: string;
  properties: { taskAcceptance: { type: string[] } };
} {
  const prompt = submittedPrompt(session);
  const marker =
    "RESULT must satisfy the following descriptive contract; it is not a protocol-enforced output schema:\n";
  return JSON.parse(
    prompt.slice(prompt.indexOf(marker) + marker.length).split("\n")[0],
  );
}

export function assertStrictSubmittedSchema(
  session: ScriptedCodexSession,
): void {
  const params = session.params[session.sent.indexOf("review/start")] as Record<
    string,
    unknown
  >;
  assert.equal(Object.hasOwn(params, "outputSchema"), false);
  const schema = submittedResultContract(session);
  assert.equal(schema.type, "object");
  assertStrictObjectFields(schema);
  assert.deepEqual(schema.properties.taskAcceptance.type, ["object", "null"]);
}

export async function startReview(
  session: ScriptedCodexSession,
  snapshot: ReviewSnapshotV1,
  model?: string,
): Promise<StructuredReviewOutcomeV1> {
  const reviewer = makeReviewer(session, model === undefined ? {} : { model });
  const prepared = await reviewer.prepare(prepareRequest(snapshot));
  if (!prepared.ok) assert.fail(prepared.error.detail);
  const review = prepared.value;
  const outcome = await review.start();
  if (!outcome.ok) assert.fail(outcome.error.detail);
  return outcome.value;
}

// ---------------------------------------------------------------------------
// Structured review contract: cross-field parser constraints are pinned by
// the submitted instructions, and every rejected final message keeps the
// fail-closed unavailable verdict with a distinct fixed sanitized category.
// ---------------------------------------------------------------------------

/**
 * Parser-only cross-field constraints. The supported JSON-Schema keywords
 * cannot express them, so the submitted instructions must state them exactly.
 */
export const CONTRACT_INSTRUCTIONS = [
  "Set findings to an empty array for a clean or unavailable verdict, and include at least one finding for a findings verdict.",
  "Every finding must satisfy lineStart <= lineEnd.",
  "Never repeat a finding: every finding must be distinct from every other finding.",
] as const;

export const UNAVAILABLE_PREFIX = "structured review unavailable:";

/** Exact sanitized prefix the reviewer emits for a refused structured result. */
export const MALFORMED_PREFIX =
  `${UNAVAILABLE_PREFIX} the structured result was malformed `;

export const RAW_PATH_SENTINEL = "RAW_PATH_SENTINEL";

export const RAW_TITLE_SENTINEL = "RAW_TITLE_SENTINEL";

export const RAW_SENTINELS = [
  "RAW_JSON_SENTINEL",
  "RAW_SHAPE_SENTINEL",
  "RAW_BOUND_SENTINEL",
  RAW_PATH_SENTINEL,
  RAW_TITLE_SENTINEL,
] as const;

export const JSON_REJECT_TEXT =
  "RAW_JSON_SENTINEL this is not a structured result";

export const JSON_REJECT_TEXT_ALT = "RAW_JSON_SENTINEL {verdict: clean}";

/** Complete instruction surface submitted for this review session. */
export function submittedGuidance(session: ScriptedCodexSession): string {
  const parts: string[] = [];
  for (const raw of session.params) {
    const params = raw as {
      input?: unknown;
      target?: { instructions?: unknown };
      baseInstructions?: unknown;
      developerInstructions?: unknown;
    };
    if (typeof params.target?.instructions === "string") {
      parts.push(params.target.instructions);
    }
    if (Array.isArray(params.input)) {
      for (const item of params.input) {
        const text = (item as { text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
    for (
      const value of [params.baseInstructions, params.developerInstructions]
    ) {
      if (typeof value === "string") parts.push(value);
    }
  }
  return parts.join("\n");
}

/** Strict-shape violation: a valid JSON result with a reversed line range. */
export function shapeRejectText(start: number): string {
  return JSON.stringify({
    verdict: "findings",
    summary: `RAW_SHAPE_SENTINEL ${start}`,
    findings: [{
      priority: 1,
      title: "t",
      body: "b",
      path: "account.ts",
      lineStart: start,
      lineEnd: start - 1,
    }],
  });
}

/** Parser-bound overflow: a valid JSON result over the summary bound. */
export function boundRejectText(): string {
  return JSON.stringify({
    verdict: "clean",
    summary: `RAW_BOUND_SENTINEL ${"s".repeat(MAX_RESULT_SUMMARY)}`,
    findings: [],
  });
}

/** Single-field violation: a valid JSON drive path the parser refuses. */
export function pathRejectText(): string {
  return JSON.stringify({
    verdict: "findings",
    summary: "ok",
    findings: [{
      priority: 1,
      title: "t",
      body: "b",
      path: `C:/${RAW_PATH_SENTINEL}/x.ts`,
      lineStart: 1,
      lineEnd: 1,
    }],
  });
}

/** Single-field violation: a valid JSON title carrying a real LF. */
export function titleRejectText(): string {
  return JSON.stringify({
    verdict: "findings",
    summary: "ok",
    findings: [{
      priority: 1,
      title: `${RAW_TITLE_SENTINEL}\n`,
      body: "b",
      path: "account.ts",
      lineStart: 1,
      lineEnd: 1,
    }],
  });
}

/** Cross-field violation: a clean verdict that still carries a finding. */
export function cardinalityRejectText(): string {
  return JSON.stringify({
    verdict: "clean",
    summary: "ok",
    findings: [{
      priority: 1,
      title: "t",
      body: "b",
      path: "account.ts",
      lineStart: 1,
      lineEnd: 1,
    }],
  });
}

/** Run one complete scripted turn whose only final message is `text`. */
export async function completedFinalMessage(
  text: string,
): Promise<StructuredReviewOutcomeV1> {
  const session = new ScriptedCodexSession();
  session.plan = (scripted) => {
    scripted.emit(
      "item/completed",
      agentMessage(scripted.turnId, "item-1", text),
    );
    scripted.emit("turn/completed", turnCompleted(scripted.turnId));
  };
  return await startReview(session, await snapshotFixture());
}

/** The rejected final message must keep the fail-closed unavailable shape. */
export async function rejectedFinalCategory(text: string): Promise<string> {
  const outcome = await completedFinalMessage(text);
  assert.equal(outcome.status, "unavailable");
  assert.equal(outcome.result, null);
  assert.equal(outcome.execution, null);
  const detail = outcome.detail === null ? "" : outcome.detail;
  assert.notEqual(detail, "", "a fixed sanitized category is required");
  assert.ok(detail.startsWith(UNAVAILABLE_PREFIX), "fixed category prefix");
  assert.ok(detail.length <= MAX_UNAVAILABLE_REASON_CHARS, "bounded category");
  assert.match(detail, /^[\x20-\x7e]+$/, "printable single-line category");
  assert.equal(
    staticUnavailableSummary(detail),
    detail,
    "the category must reach the unavailable summary verbatim",
  );
  for (const sentinel of RAW_SENTINELS) {
    assert.equal(
      detail.includes(sentinel),
      false,
      "raw content must not leak into the category",
    );
  }
  return detail;
}

// ---------------------------------------------------------------------------
// Structured review rubric: the authentic upstream Codex review rubric is
// vendored into the session's base instructions; only the read-only boundary
// and the harness output-schema override are added on top of it.
// ---------------------------------------------------------------------------

/** Distinctive phrases carried verbatim by the vendored upstream rubric. */
export const RUBRIC_PHRASES = [
  "You are acting as a reviewer for a proposed code change made by another engineer.",
  "[P0] – Drop everything to fix",
  "It is not enough to speculate that a change may disrupt another part of the codebase",
] as const;
