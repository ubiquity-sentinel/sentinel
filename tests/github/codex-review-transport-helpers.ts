// codex review transport helpers.

import { asGitSha, type GitSha } from "../../src/contracts/brands.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  REPO,
  REVIEWER,
  T0,
} from "./helpers.ts";
import {
  GitHubCodexReviewTransport,
  type GitReviewSnapshotCaptureV1,
  REVIEW_TRANSPORT_TOTAL_MS,
} from "../../src/github/codex-review-transport.ts";
import {
  REVIEW_MODEL,
  REVIEW_REASONING,
  type ReviewJournalReadyExecutionV1,
  type ReviewJournalReadyV1,
  reviewResultDigest,
  type ReviewResultV1,
} from "../../src/github/review-journal.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import assert from "node:assert/strict";
import type {
  CodexProtocolError,
  CodexServerNotificationV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";
import {
  GitReviewSnapshot,
  reviewSnapshotDigest,
  type ReviewSnapshotV1,
} from "../../src/github/review-snapshot.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { CodexStructuredReviewer } from "../../src/github/codex-reviewer.ts";
import type { CodexStructuredReviewerOptionsV1 } from "../../src/github/codex-reviewer.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  NATIVE_REVIEW_CLOSE,
  NATIVE_REVIEW_OPEN,
  nativeFindingSuffix,
} from "../../src/github/native-review-result.ts";

export const API = "https://api.github.com";

export const PROVIDER = "openai";

export const OWNER_RUN_ID = "run-transport-1";

export const PR = 1;

export const BASE: GitSha = asGitSha("a".repeat(40));

export const HEAD: GitSha = asGitSha("b".repeat(40));

export const OP_KEY = "review:work-1:head-b";

export const REQUEST_ID = `review-${OP_KEY}`.slice(0, 256);

export const LATEST_START = T0 + 60_000;

export const SETTLE_BY = T0 + REVIEW_TRANSPORT_TOTAL_MS;

export const ACCOUNT_CONTENT =
  "export function deposit(balance: number, amount: number) {\n" +
  '  if (amount < 0) throw new Error("negative");\n' +
  "  return balance + amount;\n" +
  "}\n";

export const CLEAN_RESULT: ReviewResultV1 = {
  verdict: "clean",
  summary: "The supplied change matches the specification.",
  findings: [],
};

export const FINDINGS_RESULT: ReviewResultV1 = {
  verdict: "findings",
  summary: "deposit subtracts the amount instead of adding it.",
  findings: [{
    priority: 1,
    title: "Deposit uses subtraction",
    body:
      "The specification requires `deposit(balance, amount)` to return `balance + amount`.\n\nThis implementation returns `balance - amount`.",
    path: "account.ts",
    lineStart: 1,
    lineEnd: 3,
  }],
};

export function oversizedFindingsResult(): ReviewResultV1 {
  const body = "x".repeat(7_000);
  return {
    verdict: "findings",
    summary: "four valid findings exceed the rendered journal bound",
    findings: Array.from({ length: 4 }, (_, index) => ({
      priority: index as 0 | 1 | 2 | 3,
      title: `oversized finding ${index}`,
      body,
      path: "account.ts",
      lineStart: index + 1,
      lineEnd: index + 1,
    })),
  };
}

// ---------------------------------------------------------------------------
// Durable scripted remote store (real GitHubApiClient endpoints)
// ---------------------------------------------------------------------------

export interface StoredReviewV1 {
  id: number;
  prNumber: number;
  author: string;
  state: "pending" | "commented";
  body: string | null;
  head: GitSha;
  submittedAt: number | null;
}

export function jsonResponse(status: number, value: unknown): HttpResponseV1 {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    bodyText: JSON.stringify(value),
  };
}

export function reviewJson(review: StoredReviewV1): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: review.id,
    user: { login: review.author },
    state: review.state === "pending" ? "PENDING" : "COMMENTED",
    body: review.body,
    commit_id: review.head,
  };
  // Genuine GitHub PENDING reviews omit `submitted_at`; a submitted review
  // carries the standing timestamp.
  if (review.state === "commented") {
    wire.submitted_at = new Date(review.submittedAt ?? T0).toISOString();
  }
  return wire;
}

export class DurableReviewStore {
  readonly reviews = new Map<number, StoredReviewV1>();
  readonly requests: string[] = [];
  readonly submittedBodies: string[] = [];
  nextId = 100;
  creates = 0;
  updates = 0;
  submits = 0;
  /** Simulated lost responses: the write still applies (or not) and throws. */
  lostCreate = false;
  lostCreateApplies = true;
  lostUpdate = false;
  lostSubmit = false;
  /** A tampered durable running body: the readback must reject it. */
  tamperUpdates = false;
  failUpdate = false;
  /**
   * Controllable gate: while non-null, the running-journal PUT waits for it.
   * Tests always release the gate before returning (no leaked promise).
   */
  updateGate: Promise<void> | null = null;
  /**
   * Controllable gate: while non-null, the READY-journal PUT (the second PUT
   * for one review, i.e. the finalization after the owned process closed)
   * waits for it. Tests always release the gate before returning.
   */
  readyUpdateGate: Promise<void> | null = null;
  private readonly updateCounts = new Map<number, number>();

  handle = async (request: HttpRequestV1): Promise<HttpResponseV1> => {
    const path = request.url.startsWith(API)
      ? request.url.slice(API.length).split("?")[0]
      : request.url;
    this.requests.push(`${request.method} ${path}`);
    const list = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(path);
    const exact = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)$/.exec(
      path,
    );
    const events =
      /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews\/(\d+)\/events$/.exec(
        path,
      );

    if (request.method === "GET" && list !== null) {
      const prNumber = Number(list[1]);
      const items = [...this.reviews.values()].filter((review) =>
        review.prNumber === prNumber
      );
      return Promise.resolve(jsonResponse(200, items.map(reviewJson)));
    }
    if (request.method === "GET" && exact !== null) {
      const review = this.reviews.get(Number(exact[2]));
      if (review === undefined) {
        return Promise.resolve(jsonResponse(404, { message: "Not Found" }));
      }
      return Promise.resolve(jsonResponse(200, reviewJson(review)));
    }
    if (request.method === "POST" && list !== null) {
      this.creates++;
      const payload = JSON.parse(request.body ?? "{}") as {
        commit_id: GitSha;
        body: string;
      };
      const created: StoredReviewV1 = {
        id: this.nextId++,
        prNumber: Number(list[1]),
        author: REVIEWER,
        state: "pending",
        body: payload.body,
        head: payload.commit_id,
        submittedAt: null,
      };
      if (this.lostCreate) {
        if (this.lostCreateApplies) this.reviews.set(created.id, created);
        return Promise.reject(new Error("synthetic lost create response"));
      }
      this.reviews.set(created.id, created);
      return Promise.resolve(jsonResponse(201, reviewJson(created)));
    }
    if (request.method === "PUT" && exact !== null) {
      this.updates++;
      const reviewId = Number(exact[2]);
      const priorUpdates = this.updateCounts.get(reviewId) ?? 0;
      this.updateCounts.set(reviewId, priorUpdates + 1);
      const gate = this.updateGate;
      if (gate !== null) await gate;
      if (priorUpdates > 0) {
        const readyGate = this.readyUpdateGate;
        if (readyGate !== null) await readyGate;
      }
      const review = this.reviews.get(Number(exact[2]));
      if (review === undefined) {
        return Promise.resolve(jsonResponse(404, { message: "Not Found" }));
      }
      if (this.failUpdate) {
        return Promise.resolve(
          jsonResponse(500, { message: "synthetic server error" }),
        );
      }
      const payload = JSON.parse(request.body ?? "{}") as { body: string };
      review.body = this.tamperUpdates ? `${payload.body}\n` : payload.body;
      if (this.lostUpdate) {
        return Promise.reject(new Error("synthetic lost update response"));
      }
      return Promise.resolve(jsonResponse(200, reviewJson(review)));
    }
    if (request.method === "POST" && events !== null) {
      this.submits++;
      const review = this.reviews.get(Number(events[2]));
      if (review === undefined) {
        return Promise.resolve(jsonResponse(404, { message: "Not Found" }));
      }
      const payload = JSON.parse(request.body ?? "{}") as {
        event: string;
        body: string;
      };
      assert.equal(payload.event, "COMMENT");
      this.submittedBodies.push(payload.body);
      review.state = "commented";
      review.submittedAt = T0;
      review.body = payload.body;
      if (this.lostSubmit) {
        return Promise.reject(new Error("synthetic lost submit response"));
      }
      return Promise.resolve(jsonResponse(200, reviewJson(review)));
    }
    return Promise.resolve(jsonResponse(404, { message: "unexpected" }));
  };
}

// ---------------------------------------------------------------------------
// Recording app-server session (real reviewer, no model call)
// ---------------------------------------------------------------------------

export class RecordingSession implements CodexSessionV1 {
  readonly sent: string[] = [];
  readonly params: unknown[] = [];
  opened = 0;
  closed = 0;
  settled = true;
  failure: CodexProtocolError | null = null;
  result: ReviewResultV1 = CLEAN_RESULT;
  failStart = false;
  /** A turn whose response only settles when the session is closed. */
  hangStart = false;
  /** Real milliseconds before the terminal events arrive. */
  delayMs = 0;
  readonly turnId = "turn-1";
  readonly threadId = "thread-1";
  /** Configured model the scripted server acknowledges (default frozen id). */
  model: string = REVIEW_MODEL;

  private handler: ((event: CodexServerNotificationV1) => void) | null = null;
  private readonly backlog: CodexServerNotificationV1[] = [];
  private readonly closeWaiters: ((error: Error) => void)[] = [];

  open(): void {
    this.opened++;
  }

  send(method: string, params: unknown): Promise<unknown> {
    this.sent.push(method);
    this.params.push(params);
    if (method === "initialize") {
      return Promise.resolve({ userAgent: "scripted/0.1.0" });
    }
    if (method === "thread/start") {
      return Promise.resolve({
        thread: { id: this.threadId },
        model: this.model,
        modelProvider: PROVIDER,
        reasoningEffort: REVIEW_REASONING,
        activePermissionProfile: { id: "sentinel-review" },
      });
    }
    if (method === "review/start") {
      if (this.hangStart) {
        return new Promise<unknown>((_resolve, reject) => {
          this.closeWaiters.push(reject);
        });
      }
      if (this.failStart) {
        return Promise.reject(new Error("scripted submission failure"));
      }
      const emit = () => {
        const target = (params as { target: { instructions: string } }).target;
        const match = /<SENTINEL_NATIVE_REVIEW_V1>\{"binding":(\{[^}]+\})/.exec(
          target.instructions,
        );
        if (!match) throw new Error("native target binding missing");
        const binding = JSON.parse(match[1]);
        const entry = {
          threadId: this.threadId,
          turnId: this.turnId,
          item: {
            type: "enteredReviewMode",
            id: "entered-1",
            review: "custom review",
          },
        };
        this.emit("item/started", entry);
        this.emit("item/completed", entry);
        this.emit("item/started", this.item("item-1", ""));
        this.emit(
          "item/completed",
          this.item(
            "item-1",
            NATIVE_REVIEW_OPEN +
              JSON.stringify({ binding, result: this.result }) +
              NATIVE_REVIEW_CLOSE +
              nativeFindingSuffix(
                this.result,
                (this.params[1] as { cwd: string }).cwd,
              ),
          ),
        );
        this.emit("turn/completed", {
          threadId: this.threadId,
          turn: { id: this.turnId, status: "completed", durationMs: 5 },
        });
      };
      if (this.delayMs > 0) setTimeout(emit, this.delayMs);
      else emit();
      return Promise.resolve({
        turn: { id: this.turnId, status: "inProgress" },
        reviewThreadId: this.threadId,
      });
    }
    return Promise.resolve({});
  }

  notify(): void {}

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.handler = handler;
    const backlog = [...this.backlog];
    this.backlog.length = 0;
    for (const event of backlog) handler(event);
  }

  onServerRequest(): void {}

  close(): Promise<void> {
    this.closed++;
    const waiters = [...this.closeWaiters];
    this.closeWaiters.length = 0;
    for (const reject of waiters) {
      reject(new Error("scripted session closed during an owned turn"));
    }
    return Promise.resolve();
  }

  isSettled(): boolean {
    return this.settled;
  }

  getFailure(): CodexProtocolError | null {
    return this.failure;
  }

  turnStarts(): number {
    return this.sent.filter((method) => method === "review/start").length;
  }

  private item(id: string, text: string): unknown {
    return {
      threadId: this.threadId,
      turnId: this.turnId,
      item: { type: "exitedReviewMode", id, review: text },
    };
  }

  private emit(method: string, params: unknown): void {
    const event = { method, params } as CodexServerNotificationV1;
    if (this.handler === null) this.backlog.push(event);
    else this.handler(event);
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

export function makeClient(
  store: DurableReviewStore,
  clock: FakeClock,
): GitHubApiClient {
  return new GitHubApiClient({
    repository: REPO,
    apiBaseUrl: API,
    http: (request) => store.handle(request),
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock,
  });
}

export function makeReviewer(
  session: RecordingSession,
  clock: FakeClock,
  model?: string,
): CodexStructuredReviewer {
  return new CodexStructuredReviewer(
    Object.assign(
      {
        provider: PROVIDER,
        openSession: () => session,
        sessionCwd: "/tmp/sentinel-review-transport",
        permissionProfile: "sentinel-review",
        now: () => clock.now(),
      },
      model === undefined ? {} : { model },
    ) as CodexStructuredReviewerOptionsV1,
  );
}

export interface HarnessV1 {
  store: DurableReviewStore;
  clock: FakeClock;
  sessions: RecordingSession[];
  snapshotCaptures: () => number;
  transport: GitHubCodexReviewTransport;
  freshTransport: () => GitHubCodexReviewTransport;
}

export function makeHarness(
  options: {
    store?: DurableReviewStore;
    session?: RecordingSession;
    snapshot?: GitReviewSnapshotCaptureV1;
    maxActiveReviews?: number;
    /** Trusted configured review model for the composed reviewer. */
    reviewModel?: string;
  } = {},
): HarnessV1 {
  const store = options.store ?? new DurableReviewStore();
  const clock = new FakeClock(T0);
  const sessions: RecordingSession[] = [];
  let captures = 0;
  const inner: GitReviewSnapshotCaptureV1 = options.snapshot ?? {
    capture: async () => portOk(await snapshotFixture()),
  };
  const snapshot: GitReviewSnapshotCaptureV1 = {
    async capture(input) {
      captures++;
      return await inner.capture(input);
    },
  };
  const build = (): GitHubCodexReviewTransport =>
    new GitHubCodexReviewTransport({
      client: makeClient(store, clock),
      repository: REPO,
      publisher: REVIEWER,
      clock,
      ownerRunId: OWNER_RUN_ID,
      snapshot,
      reviewer: {
        prepare: (request) => {
          const session = options.session ?? new RecordingSession();
          sessions.push(session);
          return makeReviewer(session, clock, options.reviewModel)
            .prepare(request);
        },
      },
      maxActiveReviews: options.maxActiveReviews,
    });
  return {
    store,
    clock,
    sessions,
    snapshotCaptures: () => captures,
    transport: build(),
    freshTransport: build,
  };
}

export function submission(
  overrides: Partial<
    Parameters<GitHubCodexReviewTransport["submitReview"]>[0]
  > = {},
) {
  return {
    operationKey: OP_KEY,
    prNumber: PR,
    expectedHead: HEAD,
    expectedBase: BASE,
    expectedReviewer: REVIEWER,
    latestStartAt: LATEST_START,
    settleBy: SETTLE_BY,
    ...overrides,
  };
}

export function readyExecution(
  overrides: Partial<ReviewJournalReadyExecutionV1> = {},
): ReviewJournalReadyExecutionV1 {
  return {
    ownerRunId: OWNER_RUN_ID,
    invocationId: `review-invocation-${OP_KEY}`.slice(0, 256),
    threadId: "thread-1",
    submittedProvider: PROVIDER,
    model: null,
    reasoning: null,
    nativeReview: { mode: "review/start", targetDigest: "d".repeat(64) },
    startMayOccur: true,
    turnId: "turn-1",
    resultId: "result-1",
    actual: {
      evidenceKind: "native-review",
      provider: PROVIDER,
      threadId: "thread-1",
      turnId: "turn-1",
      terminalOrigin: "runtime",
      observedTerminalStatus: "completed",
      observedModel: null,
      observedReasoning: null,
      nativeReview: {
        targetDigest: "d".repeat(64),
        reviewThreadId: "thread-1",
        enteredItemId: "entered-1",
        exitedItemId: "result-1",
      },
      durationMs: 5,
      outputChars: 10,
    },
    ...overrides,
  };
}

export async function readyJournal(
  result: ReviewResultV1,
  overrides: Partial<ReviewJournalReadyV1> = {},
): Promise<ReviewJournalReadyV1> {
  return {
    version: "v1",
    phase: "ready",
    repository: { owner: REPO.owner, name: REPO.name },
    prNumber: PR,
    expectedHead: HEAD,
    expectedBase: BASE,
    operationKey: OP_KEY,
    publisher: REVIEWER,
    requestId: REQUEST_ID,
    requestedAt: T0 - 5_000,
    reviewId: 100,
    completedAt: T0 - 1_000,
    result,
    resultDigest: await reviewResultDigest(result),
    execution: readyExecution(),
    ...overrides,
  };
}

export function seed(
  store: DurableReviewStore,
  body: string,
  state: "pending" | "commented",
  options: { id?: number; author?: string; head?: GitSha } = {},
): StoredReviewV1 {
  const review: StoredReviewV1 = {
    id: options.id ?? 100,
    prNumber: PR,
    author: options.author ?? REVIEWER,
    state,
    body,
    head: options.head ?? HEAD,
    submittedAt: state === "commented" ? T0 - 1_000 : null,
  };
  store.reviews.set(review.id, review);
  return review;
}

export function onlyReview(store: DurableReviewStore): StoredReviewV1 {
  const review = [...store.reviews.values()][0];
  if (review === undefined) throw new Error("no stored review");
  return review;
}

export async function settle(
  transport: GitHubCodexReviewTransport,
  interrupt = false,
): Promise<void> {
  const drain = await transport.drain({
    deadline: T0 + REVIEW_TRANSPORT_TOTAL_MS,
    interrupt,
  });
  assert.equal(drain.ok, true, drain.faults.join(","));
}

// ---------------------------------------------------------------------------
// End-to-end: real Git snapshot + real reviewer + durable store
// ---------------------------------------------------------------------------

export const PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";

export const here = new URL(import.meta.url);

export const testsDir = here.protocol === "file:"
  ? decodeURIComponent(here.pathname).replace(
    /\/codex-review-transport-helpers\.ts$/,
    "",
  )
  : ".";

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env: {
      PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Sentinel Test",
      GIT_AUTHOR_EMAIL: "sentinel-test@example.invalid",
      GIT_COMMITTER_NAME: "Sentinel Test",
      GIT_COMMITTER_EMAIL: "sentinel-test@example.invalid",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** Real temporary Git range with one changed file, cleaned up afterwards. */
export async function withRealGitRange<T>(
  fn: (input: {
    base: GitSha;
    head: GitSha;
    snapshot: GitReviewSnapshotCaptureV1;
  }) => Promise<T>,
): Promise<T> {
  const repo = await Deno.makeTempDir({
    prefix: ".review-transport-",
    dir: testsDir,
  });
  try {
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "sentinel-test@example.invalid"]);
    await git(repo, ["config", "user.name", "Sentinel Test"]);
    await Deno.writeTextFile(
      `${repo}/account.ts`,
      "export const deposit = 0;\n",
    );
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "base"]);
    const base = asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
    await Deno.writeTextFile(`${repo}/account.ts`, ACCOUNT_CONTENT);
    await git(repo, ["add", "-A"]);
    await git(repo, ["commit", "-q", "-m", "head"]);
    const head = asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
    const snapshot = new GitReviewSnapshot({
      trustedPath: PATH,
      repositoryDir: repo,
    });
    return await fn({ base, head, snapshot });
  } finally {
    await Deno.remove(repo, { recursive: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// v3 identity and deadline corrections
// ---------------------------------------------------------------------------

export const OTHER_HEAD: GitSha = asGitSha("e".repeat(40));

/** Finite, real-time wait for a controllable test condition. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("control condition was not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** A close whose settlement lands after a controllable real delay. */
export class DelayedCloseSession extends RecordingSession {
  closeCalls = 0;
  constructor(private readonly closeDelayMs: number) {
    super();
  }
  override async close(): Promise<void> {
    this.closeCalls++;
    await new Promise((resolve) => setTimeout(resolve, this.closeDelayMs));
    await super.close();
  }
}
