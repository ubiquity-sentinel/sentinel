import type {
  CodexServerNotificationV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  ReviewTaskAcceptanceV1,
  ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import { FakeGithub } from "./helpers.ts";
import type {
  MergeOutcomeV1,
  MergeRequestV1,
  PortResultV1,
  PullRequestCreateV1,
  PullRequestPublishV1,
} from "../../src/contracts/ports.ts";
import type { ReplayRuntimeV1 } from "../../src/replay/runtime.ts";
import type { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type { GatewayAuthProviderV1 } from "../../src/adapters/gateway/http.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";

// ---------------------------------------------------------------------------
// Injected fake external transports (recording, no product logic).
// ---------------------------------------------------------------------------

/** In-process fake Codex app-server session (exact protocol surface). */
export class FakeCodexSession implements CodexSessionV1 {
  readonly sent: { method: string; params: unknown }[] = [];
  openCalls = 0;
  closeCalls = 0;
  private notifications:
    | ((event: CodexServerNotificationV1) => void)
    | null = null;
  private turnStarted = false;

  open(): void {
    this.openCalls++;
  }

  send(method: string, params: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    switch (method) {
      case "initialize":
        return Promise.resolve({ userAgent: "codex-app-server/0.153.4" });
      case "thread/start":
        return Promise.resolve({
          thread: { id: "thread-1" },
          model: "gpt-reserve",
          reasoningEffort: "max",
          modelProvider: "sentinel-host",
        });
      case "turn/start":
        this.turnStarted = true;
        return Promise.resolve({ turn: { id: "turn-1" } });
      case "turn/interrupt":
        return Promise.resolve({});
      default:
        return Promise.resolve({});
    }
  }

  notify(method: string, params?: unknown): void {
    this.sent.push({ method, params: params ?? {} });
  }

  onNotification(handler: (event: CodexServerNotificationV1) => void): void {
    this.notifications = handler;
    if (this.turnStarted) {
      // The real app-server emits the terminal event only after the listener
      // is registered inside awaitSettlement; the fake mirrors that order.
      // A completed run requires genuine correlated output evidence: one
      // successful file-change item for the exact thread/turn, delivered
      // before the terminal event (never notification-byte counts).
      queueMicrotask(() => {
        this.notifications?.({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "ok-output",
              type: "fileChange",
              status: "completed",
              changes: [{
                path: "src/app.ts",
                kind: { type: "update" },
                diff:
                  "@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n",
              }],
            },
          },
        });
        this.notifications?.({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", durationMs: 5 },
          },
        });
      });
    }
  }

  onServerRequest(): void {}

  close(): Promise<void> {
    this.closeCalls++;
    return Promise.resolve();
  }
}

/**
 * The trusted-host receipt verifier: certifies ONLY the app-server evidence
 * the fake session itself acknowledged (thread metadata + completed turn).
 * A mismatch returns null, which keeps the default fail-closed policy active.
 */
export function sessionVerifier(
  evidence: {
    threadModel: string | null;
    threadModelProvider: string | null;
    threadEffort: string | null;
    terminal: { status: string | null };
  },
):
  | { provider: string; observedModel: string; observedReasoning: string }
  | null {
  if (
    evidence.threadModel === "gpt-reserve" &&
    evidence.threadEffort === "max" &&
    evidence.terminal.status === "completed"
  ) {
    return {
      provider: evidence.threadModelProvider ?? "sentinel-host",
      observedModel: "gpt-reserve",
      observedReasoning: "max",
    };
  }
  return null;
}

/** One deterministic candidate identity per implementation call. */
export class ScriptedCandidateRegistry {
  private index = 0;
  constructor(
    private readonly heads: readonly GitSha[],
    private readonly changedPaths: readonly string[],
  ) {}

  next(): { head: GitSha; changedPaths: string[] } {
    const head = this.heads[Math.min(this.index, this.heads.length - 1)]!;
    this.index++;
    return { head, changedPaths: [...this.changedPaths] };
  }
}

/**
 * Reviewer acceptance bound to the EXACT task statement the loop submitted
 * for one source issue. A directly-assigned fake completion echoes the real
 * submitted statement, so the semantic acceptance chain (submitted task ->
 * bound verdict -> receipt -> merge gate) is exercised, not bypassed.
 */
export function submittedTaskAcceptance(
  tasks: readonly (ReviewTaskStatementV1 | null)[],
  issueNumber: number,
): ReviewTaskAcceptanceV1 | null {
  const task = tasks.find((item) => item?.issueNumber === issueNumber);
  if (task === undefined || task === null) return null;
  return {
    issueNumber: task.issueNumber,
    taskDigest: task.digest,
    verdict: "fulfilled",
    evidence: [`The exact candidate change satisfies issue #${issueNumber}.`],
  };
}

/** Exact-head fake GitHub: each head gets its own PR number, and a merge
 * returns the EXACT requested head/merge sha (never a stale shortcut). The
 * inherited lifecycle maps own the PR/ref observations, so create and merge
 * delegate to super and every read observes the same exact objects. */
export class ExactHeadFakeGithub extends FakeGithub {
  readonly mergedHeads: GitSha[] = [];

  override async createPullRequest(
    request: PullRequestCreateV1,
  ): Promise<PortResultV1<PullRequestPublishV1>> {
    const published = await super.createPullRequest(request);
    // Keep the exact per-head PR allocation in the call recording; the
    // inherited lifecycle fake already allocated it deterministically.
    if (published.ok && published.value.number !== null) {
      this.calls.push(`createPr:${published.value.number}`);
    }
    return published;
  }

  override async mergePullRequest(
    request: MergeRequestV1,
  ): Promise<PortResultV1<MergeOutcomeV1>> {
    this.mergedHeads.push(request.expectedHead);
    // The inherited lifecycle merge closes the exact requested PR on the exact
    // requested head; the merge receipt is never the global last push.
    return await super.mergePullRequest(request);
  }
}

/** Recording wrapper over the REAL Deno replay runtime (no product logic). */
export class RecordingReplayRuntime implements ReplayRuntimeV1 {
  readonly runs: {
    executable: string;
    args: string[];
    cwd: string;
    outcome: string | null;
    exitCode: number | null;
    outputText: string;
  }[] = [];
  constructor(private readonly inner: DenoReplayRuntime) {}

  async run(input: Parameters<ReplayRuntimeV1["run"]>[0]) {
    const result = await this.inner.run(input);
    const outputText = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    this.runs.push({
      executable: input.executable,
      args: [...input.args],
      cwd: input.cwd,
      outcome: result.outcome,
      exitCode: result.exitCode,
      outputText,
    });
    return result;
  }
}

// ---------------------------------------------------------------------------
// Composed repair host fixture.
// ---------------------------------------------------------------------------

export function gatewayAuth(): GatewayAuthProviderV1 {
  return {
    headers: () =>
      Promise.resolve(
        {
          ok: true,
          value: { Authorization: "Bearer synthetic-token" },
        } as const,
      ),
  };
}

export function composedConfig(
  repository: RepositoryIdentityV1,
): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    version: "v1",
    kind: "repository_config",
    repository,
    baseBranch: "development",
    adapter: { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
    commands: { replay: "replay", test: "test" },
    commandRegistry: {
      version: "v1",
      commands: {
        replay: {
          executable: "deno",
          args: ["task", "test"],
          maxDurationMs: 60_000,
          maxOutputBytes: 262_144,
        },
        test: {
          executable: "deno",
          args: ["task", "test"],
          maxDurationMs: 60_000,
          maxOutputBytes: 262_144,
        },
      },
    },
    protectedPaths: [],
    build: { projectId: null, acceptance: null },
    secretRef: null,
    liveStartLimits: { perHour: 5, perSevenDays: 20 },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    retention: null,
    stabilityPolicy: null,
  });
}
