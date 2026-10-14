import { CAPTURE_ID_A, INCIDENT_A } from "../adapters/gateway/helpers.ts";
import type { ToyRepoV1 } from "./causal-capture-toy.ts";
import type { ReplayRuntimeV1 } from "../../src/replay/runtime.ts";
import type {
  GatewayCausalVerifierInputV1,
  GatewayCausalVerifierV1,
} from "../../src/replay/causal-verifier.ts";
import { LinuxReplayIsolation } from "../../src/replay/isolation.ts";
import { GatewayLocalCausalVerifier } from "../../src/replay/causal-verifier.ts";
import type { GatewayCausalProofV1 } from "../../src/replay/causal-proof.ts";
import type {
  CodexServerNotificationV1,
  CodexSessionV1,
} from "../../src/repair/codex-transport.ts";

// ---------------------------------------------------------------------------
// Concrete trusted causal verifier (plan 01): the real local Deno consumer
// protocol. It materializes two independent exact-original-SHA snapshots,
// places the private original request/upstream in one disposable restricted
// verifier scratch snapshot and the exact composed sanitized bundle in the
// other, executes the SAME committed trusted consumer in both under the
// confined Deno protocol, and returns only a fully bound proof carrying
// observed execution evidence. There is no oracle and no input-string
// predicate anywhere in the verifier or the test.
// ---------------------------------------------------------------------------

/** Fixed consumer fixtures paths of the committed toy consumer. */
function causalConsumerFixtureBase(): string {
  return `tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_A}`;
}

export async function makeConcreteVerifier(
  toy: ToyRepoV1,
  tmp: string,
  runtime: ReplayRuntimeV1,
): Promise<GatewayCausalVerifierV1> {
  const base = causalConsumerFixtureBase();
  const scratchDir = `${tmp}/causal-verifier-scratch`;
  // The verifier's trusted scratch root must already EXIST and be a real
  // directory (the Linux isolation constructor refuses a missing root), so
  // create the exact causal-verifier-scratch directory first with a
  // restrictive mode.
  await Deno.mkdir(scratchDir, { recursive: true, mode: 0o700 });
  // Linux consumes the REAL bubblewrap namespace boundary
  // (`LinuxReplayIsolation`, the same supplied recording runtime); macOS
  // keeps the verifier's embedded fixed sandbox-exec Seatbelt profile and
  // every other platform is explicitly skipped by the callers. The
  // capability is the real instance: its attestation is the production
  // description and the port-style validator captures and receiver-binds its
  // `run`. Nothing here overrides osName, fabricates an attestation or
  // rewrites runtime results.
  const isolation = Deno.build.os === "linux"
    ? new LinuxReplayIsolation(scratchDir, { runtime })
    : null;
  return new GatewayLocalCausalVerifier({
    sourcePath: toy.root,
    scratchDir,
    // The fixed `scripts/replay.ts` consumer bound to the trusted
    // trusted-consumer command identity (an interchangeable consumer path is
    // rejected by the verifier constructor).
    consumerPath: "scripts/replay.ts",
    consumerRequestPath: `${base}/request.json`,
    consumerUpstreamPath: `${base}/upstream.json`,
    denoPath: Deno.execPath(),
    maxDurationMs: 60_000,
    maxOutputBytes: 262_144,
    ...(isolation === null ? {} : { isolation }),
    runtime,
  });
}

/**
 * Negative-case mutation wrapper only: the produced proof is mutated after
 * the concrete verifier decided it, so a bound-mismatch case stays blocked
 * exactly like a missing proof. Never used to fabricate a proof.
 */
export function mutateVerifier(
  inner: GatewayCausalVerifierV1,
  mutate: (proof: GatewayCausalProofV1) => GatewayCausalProofV1 | null,
): GatewayCausalVerifierV1 {
  return {
    async verify(input: GatewayCausalVerifierInputV1) {
      const proof = await inner.verify(input);
      return proof === null ? null : mutate(proof);
    },
  };
}

// ---------------------------------------------------------------------------
// Injected fake external transports (recording, no product logic).
// ---------------------------------------------------------------------------

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

export function sessionVerifier(evidence: {
  threadModel: string | null;
  threadModelProvider: string | null;
  threadEffort: string | null;
  terminal: { status: string | null };
}):
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

// ---------------------------------------------------------------------------
// Platform boundary evidence helpers.
// ---------------------------------------------------------------------------

/**
 * The concrete trusted causal verifier has a real restricted-execution
 * boundary only on the two platforms this host can enforce: macOS (installed
 * fixed `/usr/bin/sandbox-exec` running the verifier's embedded Seatbelt
 * profile) and Linux (the injected `LinuxReplayIsolation` bubblewrap
 * namespace). Every other platform has no boundary, so the cases that require
 * a bound proof stay explicitly skipped instead of silently passing.
 */
export const CONCRETE_VERIFIER_UNSUPPORTED = Deno.build.os !== "darwin" &&
  Deno.build.os !== "linux";

/** Fixed bubblewrap binary the injected Linux isolation boundary spawns. */
export const LINUX_BWRAP_PATH = "/usr/bin/bwrap";

/** First value of a repeated `flag value` pair in a recorded argv, or null. */
export function argvFlagValue(
  args: readonly string[],
  flag: string,
): string | null {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === flag) return args[index + 1]!;
  }
  return null;
}

/** `--setenv <key> <value>` value of a recorded bubblewrap argv, or null. */
export function bwrapSetenvValue(
  args: readonly string[],
  key: string,
): string | null {
  for (let index = 0; index < args.length - 2; index += 1) {
    if (args[index] === "--setenv" && args[index + 1] === key) {
      return args[index + 2]!;
    }
  }
  return null;
}

/**
 * The snapshot checkout one recorded concrete-consumer run actually enters,
 * derived from the REAL boundary argv only: the sandbox-exec `SNAPSHOT=`
 * substitution parameter on macOS, the bubblewrap `--chdir` on Linux. The
 * outer runtime cwd (always `/` for a Linux bwrap spawn) is never snapshot
 * evidence.
 */
export function consumerSnapshot(
  args: readonly string[],
  osName: string,
): string | null {
  if (osName === "darwin") {
    for (let index = 0; index < args.length - 1; index += 1) {
      if (args[index] === "-D" && args[index + 1]!.startsWith("SNAPSHOT=")) {
        return args[index + 1]!.slice("SNAPSHOT=".length);
      }
    }
    return null;
  }
  return argvFlagValue(args, "--chdir");
}
