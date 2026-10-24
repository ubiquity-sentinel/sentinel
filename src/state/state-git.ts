import type {
  PortErrorV1,
  PortResultV1,
  ReleaseHistoryViewV1,
  RepairHistoryViewV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../contracts/state-snapshots.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { StateKind } from "./state-records.ts";
import { readCommitTree } from "./state-codec.ts";
import {
  openReleaseHistoryView,
  openRepairHistoryView,
} from "./state-history.ts";
import type { StateTreeMemo } from "./state-repair-history-cache.ts";

/** The two fixed state refs; roles read both, each role writes only its own. */
export const REPAIR_STATE_REF = "refs/heads/sentinel-state/repair";
export const RELEASE_STATE_REF = "refs/heads/sentinel-state/release";

export type StateWriterRole = "repair" | "release";

/** Result of one `git` invocation (argv only, never a shell string). */
export interface GitRunResultV1 {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
  /** Present when rawOutput was requested; never decoded before framing. */
  stdoutBytes?: Uint8Array;
}

interface GitByteOptions {
  stdin?: Uint8Array;
  rawOutput?: boolean;
}

/**
 * Injected transport border. Production uses DenoGitRunner (real Deno.Command
 * git, credential-free). Tests may wrap it to simulate lost responses or
 * synchronize concurrent writers; wrappers must not carry state logic.
 */
export interface GitRunnerV1 {
  runGit(
    args: string[],
    opts: GitByteOptions & {
      cwd: string;
      env?: Readonly<Record<string, string>>;
    },
  ): Promise<GitRunResultV1>;
}

export interface GitStateStoreOptions {
  /** Scratch directory for private per-operation workdirs. */
  scratchDir: string;
  /** Remote repository URL or local path holding the state branches. */
  remoteUrl: string;
  /** Fixed writer role: a repair store never writes release state and vice versa. */
  role: StateWriterRole;
  /** Transport injection for tests; default is the real git runner. */
  runner?: GitRunnerV1;
}

/**
 * Production git runner. Every git child runs with clearEnv and only PATH,
 * a scratch HOME, and explicit config isolation, so Git global/system config,
 * credential helpers and hooks cannot supply hidden credentials, and
 * GIT_TERMINAL_PROMPT=0 keeps git from prompting for them.
 */
export class DenoGitRunner implements GitRunnerV1 {
  private readonly path: string;
  private readonly extraEnv: Readonly<Record<string, string>>;

  constructor(
    private readonly gitHome: string,
    extraEnv: Readonly<Record<string, string>> = {},
  ) {
    this.path = Deno.env.get("PATH") ?? "/usr/bin:/bin";
    this.extraEnv = { ...extraEnv };
  }

  async runGit(
    args: string[],
    opts: GitByteOptions & {
      cwd: string;
      env?: Readonly<Record<string, string>>;
    },
  ): Promise<GitRunResultV1> {
    const command = new Deno.Command("git", {
      args,
      cwd: opts.cwd,
      clearEnv: true,
      env: {
        PATH: this.path,
        HOME: this.gitHome,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        ...this.extraEnv,
        ...opts.env,
      },
      stdin: opts.stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    });
    let result: Deno.CommandOutput;
    const stdin = opts.stdin;
    if (stdin === undefined) {
      result = await command.output();
    } else {
      const child = command.spawn();
      const writer = child.stdin.getWriter();
      // Drain output while writing input so a large batch cannot deadlock
      // when Git fills stdout before consuming the remaining object ids.
      const [output, input] = await Promise.allSettled([
        child.output(),
        (async () => {
          try {
            await writer.write(stdin);
          } finally {
            try {
              await writer.close();
            } finally {
              writer.releaseLock();
            }
          }
        })(),
      ]);
      if (output.status === "rejected") throw output.reason;
      if (input.status === "rejected") throw input.reason;
      result = output.value;
    }
    const stdout = opts.rawOutput
      ? ""
      : new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    return {
      ok: result.success,
      code: result.code,
      stdout,
      stderr,
      ...(opts.rawOutput ? { stdoutBytes: result.stdout } : {}),
    };
  }
}

export const REPAIR_REF = REPAIR_STATE_REF;
export const RELEASE_REF = RELEASE_STATE_REF;

export interface OpContext {
  directory: string;
  treeMemo?: StateTreeMemo;
}

/** Local plumbing failure while forming the candidate state commit. */
export class StatePushError extends Error {
  constructor(operation: string) {
    super(`state commit plumbing failed at ${operation}`);
    this.name = "StatePushError";
  }
}

export type LoadedState =
  | { status: "absent" }
  | {
    status: "found";
    head: GitSha;
    snapshot: RepairStateSnapshotV1 | ReleaseStateSnapshotV1;
  };

export class StateGitTransport {
  protected readonly scratchDir: string;
  protected readonly remoteUrl: string;
  protected readonly role: StateWriterRole;
  protected readonly runner: GitRunnerV1;
  protected readonly gitHome: string;

  constructor(options: GitStateStoreOptions) {
    if (
      typeof options.scratchDir !== "string" || options.scratchDir.length === 0
    ) {
      throw new Error("GitStateStore requires a non-empty scratch directory");
    }
    if (
      typeof options.remoteUrl !== "string" || options.remoteUrl.length === 0
    ) {
      throw new Error("GitStateStore requires a remote URL or path");
    }
    if (options.role !== "repair" && options.role !== "release") {
      throw new Error("GitStateStore requires a fixed writer role");
    }
    this.scratchDir = options.scratchDir;
    this.remoteUrl = options.remoteUrl;
    this.role = options.role;
    this.gitHome = `${options.scratchDir}/state-git-home`;
    this.runner = options.runner ?? new DenoGitRunner(this.gitHome);
    // Scratch and per-run HOME only; no repository or branch is created here.
    Deno.mkdirSync(this.scratchDir, { recursive: true });
    Deno.mkdirSync(this.gitHome, { recursive: true });
  }

  protected async withOpDir<T>(
    run: (op: OpContext) => Promise<PortResultV1<T>>,
  ): Promise<PortResultV1<T>> {
    let directory: string;
    try {
      directory = await Deno.makeTempDir({
        prefix: "state-op-",
        dir: this.scratchDir,
      });
    } catch {
      // Local allocation failure: a sanitized typed result, never an
      // exception whose text could carry paths into a caller or log.
      return portError(
        "unavailable",
        "state operation could not allocate a protected working directory",
      );
    }
    const op: OpContext = { directory };
    try {
      return await run(op);
    } finally {
      try {
        await Deno.remove(op.directory, { recursive: true });
      } catch {
        // Best-effort scratch cleanup; results are unaffected.
      }
    }
  }

  protected async git(
    op: OpContext,
    args: string[],
    env?: Readonly<Record<string, string>>,
    options?: GitByteOptions,
  ): Promise<GitRunResultV1> {
    try {
      return await this.runner.runGit(args, {
        cwd: op.directory,
        env,
        ...options,
      });
    } catch {
      // A throwing transport (or local spawn failure) is a sanitized git
      // failure with no exception text: never leak paths, URLs or remote
      // error details into the typed result. The ref state is unknown.
      return { ok: false, code: -1, stdout: "", stderr: "" };
    }
  }

  /**
   * Strict exact ls-remote output parsing. Zero output lines means the ref
   * truly does not exist (ls-remote exited 0 with no match). Any malformed
   * line, a response with no matching record, or more than one matching
   * record is an invalid response — never "empty" — because a failed read can
   * never become a successful empty state.
   */
  protected parseLsRemote(
    stdout: string,
    ref: string,
  ): { status: "absent" } | { status: "invalid" } | {
    status: "found";
    head: string;
  } {
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    const matches: string[] = [];
    for (const line of lines) {
      const match = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
      if (match === null) {
        return { status: "invalid" };
      }
      if (match[2] === ref) matches.push(match[1]);
    }
    if (lines.length === 0) return { status: "absent" };
    if (matches.length === 0) return { status: "invalid" };
    if (matches.length > 1) return { status: "invalid" };
    return { status: "found", head: matches[0] };
  }

  /**
   * Reads the exact remote ref and, when present, the full validated state
   * tree underneath it. Absent means the ref does not exist (ls-remote exit
   * 0 with no match); every other transport outcome is a typed error.
   */
  protected async loadRemote(
    op: OpContext,
    ref: string,
    kind: StateKind,
    history: "latest" | "complete" = "latest",
    expectedHead?: GitSha,
  ): Promise<PortResultV1<LoadedState>> {
    const init = await this.git(op, ["init", "-q"]);
    if (!init.ok) return this.gitFailure("unavailable", "init", init);
    const remote = await this.git(op, [
      "remote",
      "add",
      "origin",
      this.remoteUrl,
    ]);
    if (!remote.ok) return this.gitFailure("unavailable", "remote add", remote);

    const lookup = await this.git(op, ["ls-remote", "origin", ref]);
    if (!lookup.ok) {
      return this.gitFailure(
        this.classifyGitError(lookup),
        "ls-remote",
        lookup,
      );
    }
    const lookupParsed = this.parseLsRemote(lookup.stdout, ref);
    if (lookupParsed.status === "absent") {
      return portOk({ status: "absent" });
    }
    if (lookupParsed.status === "invalid") {
      return portError(
        "invalid",
        "remote state ref ls-remote response is malformed or duplicate",
      );
    }
    const head = lookupParsed.head;
    if (expectedHead !== undefined && head !== expectedHead) {
      return portError(
        "conflict",
        "historical repair head changed or is absent",
      );
    }
    if (!/^[0-9a-f]{40}$/.test(head)) {
      return portError("invalid", "remote state ref has a malformed commit id");
    }

    const fetch = await this.git(op, [
      "fetch",
      "-q",
      "--no-tags",
      // Git >= 2.47 detaches `maintenance run --auto` after fetch, and since
      // 2.54 its geometric repack can still be pruning this private scratch
      // store when the history cache measures it (`diskBytes` NotFound).
      "--no-auto-gc",
      // Keep the current commit and its real parent for manifest validation;
      // exact historical witnesses explicitly retain complete ancestry.
      ...(history === "latest" ? ["--depth=2"] : []),
      "origin",
      ref,
    ]);
    if (!fetch.ok) {
      return this.gitFailure(this.classifyGitError(fetch), "fetch", fetch);
    }
    const fetchHead = await this.git(op, ["rev-parse", "FETCH_HEAD"]);
    if (!fetchHead.ok) {
      return this.gitFailure("unavailable", "rev-parse", fetchHead);
    }
    const fetched = fetchHead.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(fetched)) {
      return portError("invalid", "remote state ref has a malformed commit id");
    }

    const snapshot = await this.readCommitTree(op, fetched, kind);
    if (!snapshot.ok) return snapshot;
    return portOk({
      status: "found",
      head: fetched as GitSha,
      snapshot: snapshot.value,
    });
  }

  /** Pinned repair history; the consumer revalidates live state after closing. */
  openRepairHistory(
    input: { expectedHead: GitSha },
  ): Promise<PortResultV1<RepairHistoryViewV1>> {
    return openRepairHistoryView({
      scratchDir: this.scratchDir,
      ref: REPAIR_REF,
      loadComplete: (op) =>
        this.loadRemote(
          op,
          REPAIR_REF,
          "repair",
          "complete",
          input.expectedHead,
        ),
      git: (op, args) => this.git(op, args),
      readTree: (op, commit) => this.readCommitTree(op, commit, "repair"),
    }, input.expectedHead);
  }

  /** One bounded local view of the fixed release history (state-history.ts). */
  openReleaseHistory(
    input: { expectedHead: GitSha },
  ): Promise<PortResultV1<ReleaseHistoryViewV1>> {
    return openReleaseHistoryView({
      scratchDir: this.scratchDir,
      ref: RELEASE_REF,
      loadComplete: (op) =>
        this.loadRemote(op, RELEASE_REF, "release", "complete"),
      git: (op, args) => this.git(op, args),
      readTree: (op, commit) => this.readCommitTree(op, commit, "release"),
    }, input.expectedHead);
  }

  protected readCommitTree(op: OpContext, commitSha: string, kind: StateKind) {
    return readCommitTree(
      {
        git: (context, args, options) =>
          this.git(context, args, undefined, options),
        gitFailure: (kind, operation, result) =>
          this.gitFailure(kind, operation, result),
      },
      op,
      commitSha,
      kind,
    );
  }
  protected classifyGitError(
    result: GitRunResultV1,
  ): "auth_failed" | "not_found" | "unavailable" {
    // Classification only; stderr is never echoed (it may contain URLs).
    const text = result.stderr.toLowerCase();
    if (
      text.includes("authentication failed") ||
      text.includes("could not read username") ||
      text.includes("could not read password") ||
      text.includes("permission denied") ||
      text.includes("access denied") ||
      text.includes("401") ||
      text.includes("403")
    ) {
      return "auth_failed";
    }
    if (
      text.includes("not a git repository") ||
      text.includes("does not appear to be a git repository") ||
      text.includes("repository not found") ||
      text.includes("not found")
    ) {
      return "not_found";
    }
    return "unavailable";
  }

  protected gitFailure(
    kind: PortErrorV1["kind"],
    operation: string,
    _result: GitRunResultV1,
  ): PortResultV1<never> {
    return portError(
      kind,
      `state remote ${operation} failed; the remote ref state is unknown`,
    );
  }
}

export interface StateGitOps {
  git(
    op: OpContext,
    args: string[],
    options?: GitByteOptions,
  ): Promise<GitRunResultV1>;
  gitFailure(
    kind: PortErrorV1["kind"],
    operation: string,
    result: GitRunResultV1,
  ): PortResultV1<never>;
}

export function randomHex(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
