import type { GitSha } from "../contracts/brands.ts";
import { isSafeBundlePath } from "./fixture.ts";
import { validateReplayIsolationCapability } from "./isolation-capability.ts";
import type { ReplayIsolationRunnerV1 } from "./isolation-capability.ts";
import { DenoReplayRuntime } from "./runtime.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "./runtime.ts";
import type {
  GatewayCausalReaderBindingV1,
  GatewayLocalCausalVerifierOptionsV1,
} from "./causal-verifier-contracts.ts";
import {
  prepareBunFrozenReader,
  type PreparedBunReaderV1,
  verifyBunReaderBootstrap,
} from "./bun-frozen-reader.ts";
import {
  BUN_READER_BOOTSTRAP_PATH,
  BUN_READER_PREFLIGHT_PATH,
} from "./bun-reader-bootstrap.ts";
import {
  CAUSAL_CONSUMER_PATH,
  CAUSAL_SANDBOX_EXEC_PATH,
  SENTINEL_REPLAY_INPUT_PATH,
} from "./causal-dispatch.ts";
import { decodeGit, exitedOk } from "./causal-verifier-protocol.ts";

/**
 * Fixed deny-by-default seatbelt profile. Byte-copy of the immutable
 * /tmp/sentinel-deno-import-boundary-profile-v3-20260909.sb (host acceptance
 * receipt cc48556d…): the only reads are the installed Deno binary, the
 * single snapshot of the current run, that run's own cache, the System
 * library paths, localtime and the urandom/null devices; the only writes are
 * under that cache and /dev/null; execution is limited to the Deno binary.
 * Every sibling snapshot, shared cache, repo working tree, user/source/task
 * root and network/fork path stays denied.
 */
const CAUSAL_SANDBOX_PROFILE = `(version 1)
(deny default)
(import "dyld-support.sb")
(allow file-map-executable (literal (param "DENO")) (subpath "/System") (subpath "/usr/lib") (subpath "/Library/Apple"))
(allow process-exec (literal (param "DENO")))
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
(allow file-read-data
  (literal (param "DENO"))
  (subpath (param "SNAPSHOT"))
  (subpath (param "CACHE"))
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/Library/Apple")
  (literal "/private/etc/localtime")
  (literal "/dev/urandom")
  (literal "/dev/random")
  (literal "/dev/null"))
(allow file-write* (subpath (param "CACHE")) (literal "/dev/null"))
`;

const GIT_TIMEOUT_MS = 60_000;
const GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_LIMIT_MS = 600_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type PreparedCausalReaderV1 =
  | { kind: "deno"; executable: string }
  | PreparedBunReaderV1;

export class CausalVerifierExecution {
  private readonly path: string;
  private readonly runtime: ReplayRuntimeV1;
  private readonly readerBindings?: readonly GatewayCausalReaderBindingV1[];
  readonly sandboxExecPath: string;
  readonly osName: string;
  /**
   * Captured Linux isolation boundary: the validated capability's `run`
   * function, already receiver-bound at construction. Null when the caller
   * supplied no valid capability (the Linux preflight then returns no proof).
   */
  readonly isolationRunner: ReplayIsolationRunnerV1 | null;

  constructor(private readonly options: GatewayLocalCausalVerifierOptionsV1) {
    if (
      typeof options.sourcePath !== "string" ||
      !options.sourcePath.startsWith("/")
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires an absolute local source path",
      );
    }
    if (
      typeof options.scratchDir !== "string" ||
      !options.scratchDir.startsWith("/")
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires an absolute scratch root",
      );
    }
    if (
      typeof options.denoPath !== "string" ||
      !options.denoPath.startsWith("/") ||
      options.denoPath.length === 0
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires an absolute installed Deno binary",
      );
    }
    // Neither input may ever be the fixed dispatch metadata path (checked
    // before the generic safe-path validation so the specific rejection is
    // observable): the metadata record is written by this verifier and is
    // never an input destination.
    if (
      options.consumerRequestPath === SENTINEL_REPLAY_INPUT_PATH ||
      options.consumerUpstreamPath === SENTINEL_REPLAY_INPUT_PATH
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier input paths must differ from the fixed " +
          "dispatch metadata path " + SENTINEL_REPLAY_INPUT_PATH,
      );
    }
    // Fixed safe root-relative destinations only.
    for (
      const path of [
        options.consumerPath,
        options.consumerRequestPath,
        options.consumerUpstreamPath,
      ]
    ) {
      if (typeof path !== "string" || !isSafeBundlePath(path)) {
        throw new TypeError(
          "GatewayLocalCausalVerifier requires fixed safe root-relative paths",
        );
      }
    }
    // The three fixed destinations must never overlap as ancestor/descendant
    // paths: placing a file at one destination would make another destination
    // unplaceable after the whole preflight (a partial placement). Rejected
    // before any filesystem work.
    const fixedPaths = [
      options.consumerPath,
      options.consumerRequestPath,
      options.consumerUpstreamPath,
    ];
    for (let i = 0; i < fixedPaths.length; i += 1) {
      for (let j = 0; j < fixedPaths.length; j += 1) {
        if (i === j) continue;
        if (fixedPaths[j]!.startsWith(`${fixedPaths[i]!}/`)) {
          throw new TypeError(
            "GatewayLocalCausalVerifier paths must not overlap as ancestor " +
              "and descendant",
          );
        }
      }
    }
    // The consumer path is BOUND to the fixed trusted-consumer command
    // identity: an interchangeable arbitrary consumerPath is never accepted.
    if (options.consumerPath !== CAUSAL_CONSUMER_PATH) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires the fixed trusted consumer path " +
          CAUSAL_CONSUMER_PATH,
      );
    }
    // Consumer/request/upstream must be three DISTINCT fixed paths: the
    // private original inputs are never written over the consumer and no
    // path is shared between the private and sanitized writes.
    if (
      options.consumerRequestPath === options.consumerUpstreamPath ||
      options.consumerPath === options.consumerRequestPath ||
      options.consumerPath === options.consumerUpstreamPath
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier consumer/request/upstream paths must differ",
      );
    }
    if (
      typeof options.maxDurationMs !== "number" ||
      !Number.isSafeInteger(options.maxDurationMs) ||
      options.maxDurationMs <= 0 ||
      options.maxDurationMs > MAX_LIMIT_MS
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires a bounded execution deadline",
      );
    }
    if (
      typeof options.maxOutputBytes !== "number" ||
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes <= 0 ||
      options.maxOutputBytes > MAX_OUTPUT_BYTES
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires a bounded output retention",
      );
    }
    const sandboxExecPath = options.sandboxExecPath ?? CAUSAL_SANDBOX_EXEC_PATH;
    if (
      typeof sandboxExecPath !== "string" ||
      !sandboxExecPath.startsWith("/") ||
      sandboxExecPath.length === 0
    ) {
      throw new TypeError(
        "GatewayLocalCausalVerifier requires an absolute sandbox-exec path",
      );
    }
    this.sandboxExecPath = sandboxExecPath;
    this.osName = options.osName ?? Deno.build.os;
    // Same whole-capability metadata checks as the replay port: the `run`
    // property is captured ONCE and receiver-bound (or null when the caller
    // supplied no valid capability). A hostile accessor/proxy never escapes.
    this.isolationRunner =
      validateReplayIsolationCapability(options.isolation)?.run ?? null;
    this.path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    this.runtime = options.runtime ?? new DenoReplayRuntime(this.path);
    this.readerBindings = options.readerBindings === undefined
      ? undefined
      : structuredClone(options.readerBindings);
    if (
      this.readerBindings !== undefined &&
      (this.readerBindings.length === 0 ||
        new Set(this.readerBindings.map((reader) => reader.sourceSha)).size !==
          this.readerBindings.length)
    ) {
      throw new TypeError(
        "causal reader registry must contain unique exact sources",
      );
    }
  }

  /** Resolve once before private writes; explicit registries never fall back. */
  async selectReader(
    sourceSha: GitSha,
  ): Promise<PreparedCausalReaderV1 | null> {
    const binding = this.readerBindings?.find((reader) =>
      reader.sourceSha === sourceSha
    );
    if (this.readerBindings !== undefined && binding === undefined) return null;
    if (binding?.kind === "bun") {
      if (this.osName !== "linux") return null;
      return await prepareBunFrozenReader(binding);
    }
    if (binding !== undefined && binding.kind !== "deno") return null;
    const executable = await Deno.realPath(
      binding?.denoPath ?? this.options.denoPath,
    );
    if (!(await Deno.stat(executable)).isFile) return null;
    return { kind: "deno", executable };
  }

  /** A real confined public child establishes ABI/TSYNC before private fixture writes. */
  async preflightBunReader(
    snapshotDir: string,
    reader: PreparedBunReaderV1,
  ): Promise<ReplayCommandResultV1> {
    if (this.osName !== "linux" || this.isolationRunner === null) {
      throw new Error("Bun causal reader requires its Linux boundary");
    }
    await verifyBunReaderBootstrap(snapshotDir, reader, true);
    return await this.isolationRunner({
      executable: reader.binding.runtime.path,
      args: [
        "--no-env-file",
        "--no-install",
        "run",
        `${snapshotDir}/${BUN_READER_PREFLIGHT_PATH}`,
      ],
      cwd: snapshotDir,
      env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", NO_COLOR: "1" },
      maxDurationMs: Math.min(this.options.maxDurationMs, 10_000),
      maxOutputBytes: 4096,
    }, "read-only");
  }

  async cloneAt(
    parentDir: string,
    dir: string,
    sha: GitSha,
  ): Promise<void> {
    const clone = await this.runtime.run({
      executable: "git",
      args: ["clone", "-q", "--no-local", this.options.sourcePath, dir],
      cwd: parentDir,
      env: this.gitEnv(),
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
    if (!exitedOk(clone)) throw new Error("verifier git clone failed");
    const verify = await this.runtime.run({
      executable: "git",
      args: ["rev-parse", "--verify", `${sha}^{commit}`],
      cwd: dir,
      env: this.gitEnv(),
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
    if (!exitedOk(verify)) {
      // Missing/wrong SHA: the source does not contain the exact revision.
      throw new Error("verifier requested revision is not in the source");
    }
    const checkout = await this.runtime.run({
      executable: "git",
      args: ["checkout", "-q", "--detach", sha],
      cwd: dir,
      env: this.gitEnv(),
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
    if (!exitedOk(checkout)) throw new Error("verifier checkout failed");
    const head = await this.runtime.run({
      executable: "git",
      args: ["rev-parse", "HEAD"],
      cwd: dir,
      env: this.gitEnv(),
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_OUTPUT_BYTES,
    });
    if (!exitedOk(head) || decodeGit(head.stdout).trim() !== sha) {
      throw new Error("verifier checked out HEAD does not match the SHA");
    }
  }

  /**
   * One boundary-confined consumer execution over the CURRENT snapshot.
   *
   * macOS (unchanged): the direct installed Deno binary under the embedded
   * fixed seatbelt profile with DENO/SNAPSHOT/CACHE substitution parameters
   * as realpath-resolved paths, cwd = this snapshot, read confined to this
   * snapshot (relative reads resolve against cwd; outside reads are denied by
   * BOTH Deno permissions and the OS boundary), no
   * env/network/run/ffi/write permissions.
   *
   * Linux: the SAME fixed direct-Deno protocol (never `deno task`, never a
   * target-supplied permission or argv) runs through the captured isolation
   * `run` with a read-only checkout bound at its own absolute path; no macOS
   * sandbox binary and no host cache path are needed.
   */
  async runConsumer(
    snapshotDir: string,
    homeDir: string,
    reader: PreparedCausalReaderV1,
  ): Promise<ReplayCommandResultV1> {
    if (reader.kind === "bun") {
      if (this.osName !== "linux" || this.isolationRunner === null) {
        throw new Error("Bun causal reader requires its Linux boundary");
      }
      await verifyBunReaderBootstrap(snapshotDir, reader);
      return await this.isolationRunner({
        executable: reader.binding.runtime.path,
        args: [
          "--no-env-file",
          "--no-install",
          "run",
          `${snapshotDir}/${BUN_READER_BOOTSTRAP_PATH}`,
        ],
        cwd: snapshotDir,
        env: { BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", NO_COLOR: "1" },
        maxDurationMs: this.options.maxDurationMs,
        maxOutputBytes: this.options.maxOutputBytes,
      }, "read-only");
    }
    const denoResolved = reader.executable;
    const fixedArgs = [
      "run",
      "--no-prompt",
      "--no-config",
      "--no-remote",
      "--allow-read=.",
      `${snapshotDir}/${this.options.consumerPath}`,
    ];
    const input: ReplayCommandInputV1 = {
      executable: denoResolved,
      args: fixedArgs,
      cwd: snapshotDir,
      env: {
        PATH: this.path,
        HOME: homeDir,
        DENO_DIR: `${homeDir}/.cache/deno`,
        NO_COLOR: "1",
      },
      maxDurationMs: this.options.maxDurationMs,
      maxOutputBytes: this.options.maxOutputBytes,
    };
    if (this.osName === "linux") {
      const runner = this.isolationRunner;
      if (runner === null) {
        // Unreachable after the preflight; fail closed without spawning.
        throw new Error("causal verifier isolation capability is not bound");
      }
      return await runner(input, "read-only");
    }
    const cacheDir = input.env.DENO_DIR;
    await Deno.mkdir(cacheDir, { recursive: true });
    const snapshotResolved = await Deno.realPath(snapshotDir);
    const cacheResolved = await Deno.realPath(cacheDir);
    return this.runtime.run({
      executable: this.sandboxExecPath,
      args: [
        "-p",
        CAUSAL_SANDBOX_PROFILE,
        "-D",
        `DENO=${denoResolved}`,
        "-D",
        `SNAPSHOT=${snapshotResolved}`,
        "-D",
        `CACHE=${cacheResolved}`,
        denoResolved,
        ...fixedArgs,
      ],
      cwd: snapshotDir,
      env: input.env,
      maxDurationMs: input.maxDurationMs,
      maxOutputBytes: input.maxOutputBytes,
    });
  }

  private gitEnv(): Record<string, string> {
    return {
      PATH: this.path,
      HOME: "/tmp",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/dev/null",
    };
  }
}
