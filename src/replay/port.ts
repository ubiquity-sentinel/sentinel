import { portError } from "../contracts/ports.ts";
import type {
  Clock,
  IsolatedReplayResultV1,
  PortResultV1,
  ReplayPort,
  ReplayRunRequestV1,
} from "../contracts/ports.ts";
import type { ReplayCommandResultV1, ReplayRuntimeV1 } from "./runtime.ts";
import type { ReplayPortOptions } from "./port-options.ts";
import { initializeReplayPort } from "./port-options.ts";
import type { ReplayIsolationCapabilityV1 } from "./isolation-capability.ts";
import { prepareReplayRequest } from "./port-request.ts";
import {
  boundedDetail,
  decodeText,
  ReplayResultClassifier,
} from "./port-result.ts";
import { materializeBundle } from "./port-materialize.ts";

/**
 * ReplayPort implementation (m03-owned): one isolated, deterministic
 * validation invocation of an exact repository revision.
 *
 * The run is one `runReplay` call: a disposable task scratch clone of the
 * configured source (never the shared source working directory), an exact
 * requested revision verified by `rev-parse` + `git rev-parse HEAD`, the
 * trusted sanitized fixture bundle materialized at its fixed safe paths in
 * the scratch checkout (missing entries only; an existing entry is accepted
 * only when byte-identical to the trusted bundle and never rewritten), and
 * then one configured target command executed as direct argv with a complete
 * credential-free environment and a deadline spanning the whole subprocess
 * + captured-stream lifetime. The repair module orchestrates the
 * before/after pair with the same bundle and owns ReplayResultV1
 * composition.
 *
 * Gateway dispatch: a request whose `fixtureRef` parses through the frozen
 * gateway identity grammar additionally receives the fixed root
 * `.sentinel-replay-input.json` record — the exact canonical
 * `{version,requestPath,upstreamPath,testIds}` bytes derived from the parsed
 * incident/capture paths and the trusted resolved test ids — materialized
 * OUTSIDE the digested two-entry bundle so the committed target consumer can
 * select the exact fixture instead of scanning or hardcoding it. The gateway
 * bundle must be exactly the two fixed request/upstream entries; missing,
 * ambiguous or extra entries are rejected. A reserved-but-malformed gateway
 * reference is rejected rather than silently treated as non-gateway, and
 * non-gateway requests are unchanged (no metadata).
 *
 * Command authority: `request.commandId` resolves against the trusted
 * configured `RepositoryConfigV1` command registry (own-property lookup
 * only). Request/model-supplied argv, shell strings and interpolations are
 * never executed. The targeted command is the target's own code, so it is
 * target-controlled: this port refuses to run any target command unless the
 * caller injected a trusted isolation capability from a restricted execution
 * host AND that capability carries a callable `run` boundary. The descriptive
 * attestation is required but is NOT sufficient: a boolean-only capability is
 * rejected at construction, the `run` property is captured exactly once and
 * receiver-bound, and the configured target command (unchanged argv/bounds)
 * executes ONLY through that captured runner with a read-write checkout. The
 * ordinary `runtime` option is retained ONLY for trusted Git
 * clone/checkout/SHA work; it is never the target execution path. `clearEnv`
 * removes inherited credentials but is NOT an OS sandbox — the callable
 * runner is the boundary, and local toy tests construct an explicitly trusted
 * fixture-mode capability (never a live config bypass).
 *
 * Failure semantics: spawn failure, missing executable, wrong revision,
 * timeout, unsettled descendants (uncertain cleanup — the scratch is
 * preserved for inspection, never deleted), truncated/unparseable proof and
 * unrelated non-zero exits are `unavailable` or `failed` with
 * `intended: false` — never a valid original regression. An intended failure
 * additionally requires the exact trusted matcher AND the expected executed
 * test identity from the bounded output; a pass requires exit code 0 AND the
 * expected executed test identity, so a no-op command that exits 0 without
 * executing the expected tests is never accepted as a passing regression.
 */

export type {
  ReplayIsolationAttestationV1,
  ReplayIsolationCapabilityV1,
  ReplayIsolationRunnerV1,
} from "./isolation-capability.ts";
export { validateReplayIsolationCapability } from "./isolation-capability.ts";
export type { ReplayPortOptions, ReplaySourceV1 } from "./port-options.ts";

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_BYTES = 64 * 1024;

export class ReplayPortImpl implements ReplayPort {
  private readonly runtime: ReplayRuntimeV1;
  private readonly isolation: ReplayIsolationCapabilityV1;
  private readonly clock: Clock;
  private readonly path: string;
  private readonly results: ReplayResultClassifier;

  constructor(private readonly options: ReplayPortOptions) {
    const prepared = initializeReplayPort(options);
    this.runtime = prepared.runtime;
    this.isolation = prepared.isolation;
    this.clock = prepared.clock;
    this.path = prepared.path;
    this.results = new ReplayResultClassifier(options, this.clock);
  }

  async runReplay(
    request: ReplayRunRequestV1,
  ): Promise<PortResultV1<IsolatedReplayResultV1>> {
    const prepared = await prepareReplayRequest(this.options, request);
    if (!prepared.ok) return prepared;
    const { resolved, proofValid, dispatchEntry, spec } = prepared.value;
    const startedAt = this.clock.now();
    let taskDir: string | null = null;
    let preserveScratch = false;
    try {
      await Deno.mkdir(this.options.scratchDir, { recursive: true });
      taskDir = await Deno.makeTempDir({
        prefix: "sentinel-replay-",
        dir: this.options.scratchDir,
      });
      const checkoutDir = `${taskDir}/checkout`;
      const homeDir = `${taskDir}/home`;
      await Deno.mkdir(homeDir);

      // Clone the configured read-only source into the disposable scratch.
      // --no-local forces a full object copy (no hardlinks/alternates to the
      // shared source), and core.hooksPath is pinned to /dev/null per call.
      const clone = await this.runGit(homeDir, {
        cwd: taskDir,
        args: ["clone", "-q", "--no-local", this.sourceValue(), checkoutDir],
      });
      if (!clone.settled) {
        preserveScratch = true;
        return this.results.unavailable(
          startedAt,
          resolved,
          proofValid,
          `git clone could not be proved settled on the owned process group; ` +
            `scratch preserved at ${taskDir}`,
        );
      }
      if (!exitedOk(clone)) {
        return this.results.unavailable(
          startedAt,
          resolved,
          proofValid,
          clone.detail,
        );
      }

      // Exact full revision: the object must exist, the checkout must be the
      // exact requested commit, and HEAD must verify to the same identity.
      const verify = await this.runGit(homeDir, {
        cwd: checkoutDir,
        args: ["rev-parse", "--verify", `${request.revision}^{commit}`],
      });
      if (!verify.settled) {
        preserveScratch = true;
        return this.results.unavailable(
          startedAt,
          resolved,
          proofValid,
          `git rev-parse could not be proved settled on the owned process ` +
            `group; scratch preserved at ${taskDir}`,
        );
      }
      if (!exitedOk(verify)) {
        return this.results.unavailable(
          startedAt,
          resolved,
          proofValid,
          `requested revision ${request.revision} is not present in the source`,
        );
      }
      const checkout = await this.runGit(homeDir, {
        cwd: checkoutDir,
        args: ["checkout", "-q", "--detach", request.revision],
      });
      if (!checkout.settled) {
        preserveScratch = true;
        return this.results.unavailable(
          startedAt,
          resolved,
          proofValid,
          `git checkout could not be proved settled on the owned process ` +
            `group; scratch preserved at ${taskDir}`,
        );
      }
      if (!exitedOk(checkout)) {
        return this.results.unavailable(
          startedAt,
          resolved,
          proofValid,
          `could not check out revision ${request.revision}`,
        );
      }
      const head = await this.runGit(homeDir, {
        cwd: checkoutDir,
        args: ["rev-parse", "HEAD"],
      });
      if (!head.settled) {
        preserveScratch = true;
        return this.results.unavailable(
          startedAt,
          resolved,
          proofValid,
          `git rev-parse HEAD could not be proved settled on the owned ` +
            `process group; scratch preserved at ${taskDir}`,
        );
      }
      if (
        !exitedOk(head) ||
        decodeText(head.stdout).trim() !== request.revision
      ) {
        return this.results.unavailable(
          startedAt,
          resolved,
          proofValid,
          "checked out HEAD does not match the requested revision",
        );
      }

      const materialized = await materializeBundle(
        checkoutDir,
        resolved.entries,
        dispatchEntry,
      );
      if (!materialized.ok) {
        return portError("invalid", materialized.reason);
      }

      // Run the one configured target command through the captured
      // restricted-execution boundary with direct argv (never rewritten), the
      // bounded credential-free environment and the existing spec caps. A
      // read-write checkout is bound because real replay tests may create
      // temporary files in the disposable checkout.
      const outputLimit = Math.min(
        spec.maxOutputBytes,
        request.outputLimitBytes,
      );
      const runResult = await this.isolation.run(
        {
          executable: spec.executable,
          args: spec.args,
          cwd: checkoutDir,
          env: this.commandEnv(homeDir),
          maxDurationMs: spec.maxDurationMs,
          maxOutputBytes: outputLimit,
        },
        "read-write",
      );
      if (!runResult.settled) {
        // Uncertain cleanup: no proof that an owned descendant is gone, so
        // the scratch must stay for inspection instead of being deleted.
        preserveScratch = true;
        return this.results.unavailable(
          startedAt,
          resolved,
          proofValid,
          `target command settlement could not be proven (` +
            `${runResult.detail}); scratch preserved at ${taskDir}`,
        );
      }
      const endedAt = this.clock.now();
      return this.results.finish(
        runResult,
        resolved,
        proofValid,
        startedAt,
        endedAt,
      );
    } catch (error) {
      return portError(
        "unavailable",
        `replay run failed: ${boundedDetail(error)}`,
      );
    } finally {
      if (taskDir !== null && !preserveScratch) {
        try {
          await Deno.remove(taskDir, { recursive: true });
        } catch {
          // Disposable scratch; the run result above is authoritative.
        }
      }
    }
  }

  private sourceValue(): string {
    return this.options.source.kind === "local"
      ? this.options.source.path
      : this.options.source.url;
  }

  private runGit(
    homeDir: string,
    input: { cwd: string; args: string[] },
  ): Promise<ReplayCommandResultV1> {
    return this.runtime.run({
      executable: "git",
      args: input.args,
      cwd: input.cwd,
      env: this.gitEnv(homeDir),
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
  }

  /**
   * Credential-free git environment: PATH, disposable HOME and explicit
   * config isolation (no global/system config, no credential helpers or
   * hooks, no terminal prompt). These variables go only to git children.
   */
  private gitEnv(homeDir: string): Record<string, string> {
    return {
      PATH: this.path,
      HOME: homeDir,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    };
  }

  /**
   * Target-command environment: trusted runtime PATH plus a disposable HOME
   * (and its DENO_DIR) and NO_COLOR for stable output. No host/model
   * credentials or workstation configuration reach the child.
   */
  private commandEnv(homeDir: string): Record<string, string> {
    return {
      PATH: this.path,
      HOME: homeDir,
      DENO_DIR: `${homeDir}/.cache/deno`,
      NO_COLOR: "1",
    };
  }

  lastUnavailableDetail(): string {
    return this.results.lastUnavailableDetail();
  }
}

function exitedOk(result: ReplayCommandResultV1): boolean {
  return result.outcome === "exited" && result.exitCode === 0;
}
