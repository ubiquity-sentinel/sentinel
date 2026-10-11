import { asFixtureDigest } from "../contracts/brands.ts";
import type { FixtureDigest } from "../contracts/brands.ts";
import { portOk } from "../contracts/ports.ts";
import type {
  Clock,
  IsolatedReplayResultV1,
  PortResultV1,
} from "../contracts/ports.ts";
import type { ReplayLimitationV1 } from "../contracts/replay-result.ts";
import type { ExpectedFailureV1, ResolvedFixtureV1 } from "./fixture.ts";
import type { ReplayCommandResultV1 } from "./runtime.ts";
import type { ReplayPortOptions } from "./port-options.ts";

export class ReplayResultClassifier {
  private lastUnavailableDetailText = "";
  constructor(
    private readonly options: ReplayPortOptions,
    private readonly clock: Clock,
  ) {}

  async finish(
    runResult: ReplayCommandResultV1,
    resolved: ResolvedFixtureV1,
    proofValid: boolean,
    startedAt: number,
    endedAt: number,
  ): Promise<PortResultV1<IsolatedReplayResultV1>> {
    const limitations: ReplayLimitationV1[] = [];
    if (runResult.truncated) limitations.push("output_truncated");
    // `fixture_redacted` is suppressed ONLY under a fully bound trusted
    // causal proof; provenance remains redacted and every other limitation
    // (truncation, unavailable, unrelated failure) still fails closed.
    if (resolved.provenance.redacted && !proofValid) {
      limitations.push("fixture_redacted");
    }

    if (
      runResult.outcome === "spawn_failed" || runResult.outcome === "timed_out"
    ) {
      this.lastUnavailableDetailText = boundedDetail(runResult.detail);
      return portOk({
        outcome: "unavailable",
        exitCode: null,
        output: null,
        failure: null,
        limitations,
        startedAt,
        endedAt,
      });
    }

    const stdoutDigest = runResult.stdout.byteLength === 0
      ? null
      : sha256Hex(runResult.stdout);
    const stderrDigest = runResult.stderr.byteLength === 0
      ? null
      : sha256Hex(runResult.stderr);
    const output = {
      stdoutDigest: await stdoutDigest,
      stderrDigest: await stderrDigest,
      truncated: runResult.truncated,
    };

    const text = decodeText(runResult.stdout) + decodeText(runResult.stderr);
    const proof = this.options.policy.proof.parse(text);
    const executedExpected = proof.parsed &&
      resolved.testIds.every((id) => proof.testIds.includes(id));

    if (runResult.exitCode === 0) {
      // A pass needs the expected executed test identity and untruncated
      // output: an exit-0 no-op that never ran the expected tests is
      // unavailable, never a passing regression.
      if (!executedExpected || runResult.truncated) {
        return portOk({
          outcome: "unavailable",
          exitCode: null,
          output: null,
          failure: null,
          limitations,
          startedAt,
          endedAt,
        });
      }
      return portOk({
        outcome: "passed",
        exitCode: 0,
        output,
        failure: null,
        limitations,
        startedAt,
        endedAt,
      });
    }

    // Non-zero exit: intended only with exact matcher + test identity and no
    // truncation; anything else is an unrelated failure.
    const intended = !runResult.truncated && executedExpected &&
      matchesExpected(text, resolved.expectedFailure);
    return portOk({
      outcome: "failed",
      exitCode: runResult.exitCode,
      output,
      failure: intended
        ? { intended: true, reason: resolved.expectedFailure.reason }
        : {
          intended: false,
          reason: `command exited with code ${runResult.exitCode}; ` +
            (runResult.truncated
              ? "output was truncated"
              : "expected failure signature not matched"),
        },
      limitations,
      startedAt,
      endedAt,
    });
  }

  unavailable(
    startedAt: number,
    resolved: ResolvedFixtureV1,
    proofValid: boolean,
    detail: string,
  ): PortResultV1<IsolatedReplayResultV1> {
    // The frozen port interface records an unavailable run as outcome only
    // (no durable detail field); the bounded diagnostic detail is kept on the
    // concrete instance for the orchestrator's local logs and never persisted
    // into a ReplayResultV1.
    this.lastUnavailableDetailText = boundedDetail(detail);
    const limitations: ReplayLimitationV1[] = [];
    if (resolved.provenance.redacted && !proofValid) {
      limitations.push("fixture_redacted");
    }
    return portOk({
      outcome: "unavailable",
      exitCode: null,
      output: null,
      failure: null,
      limitations,
      startedAt,
      endedAt: this.clock.now(),
    });
  }

  /**
   * Bounded diagnostic detail of the most recent unavailable run (empty when
   * the last run was not unavailable). Local diagnostics only — the durable
   * ReplayResultV1 carries no such field (reporting dependency: the frozen
   * interface has no bounded unavailable-reason field).
   */
  lastUnavailableDetail(): string {
    return this.lastUnavailableDetailText;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<FixtureDigest> {
  // Copy to a plain ArrayBuffer view: crypto.subtle demands a non-shared
  // ArrayBuffer, and the retained bytes may be a subarray of a larger chunk.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return asFixtureDigest(hex);
}

export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function matchesExpected(
  text: string,
  expected: ExpectedFailureV1,
): boolean {
  if (expected.match.kind === "contains") {
    return text.includes(expected.match.text);
  }
  try {
    return new RegExp(expected.match.source, "m").test(text);
  } catch {
    return false;
  }
}

/**
 * Fail-closed materialization guard. Every ancestor is lstat-checked — a
 * symlink ancestor or an existing file/dir at the target is rejected (the
 * bundle must never rewrite existing repository content or escape through a
 * checked-out symlink). An existing REGULAR FILE target is accepted only
 * when byte-identical to the trusted bundle bytes ("the actual candidate
 * already contains the permanent regression"), and is never rewritten;
 * different bytes and any non-regular target are rejected.
 */
export function boundedDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const single = text.replace(/[\r\n\t]+/g, " ").trim();
  return single.length === 0 ? "unknown error" : single.slice(0, 240);
}
