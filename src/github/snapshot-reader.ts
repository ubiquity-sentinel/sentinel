// snapshot reader.

import { DenoReplayRuntime, type ReplayRuntimeV1 } from "../replay/runtime.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import type { ReviewSnapshotV1 } from "./snapshot-manifest.ts";
import type { RawChangeV1 } from "./snapshot-git-wire.ts";
import {
  GIT_FIXED_ARGV,
  MAX_SNAPSHOT_TOTAL_MS,
  SNAPSHOT_DEADLINE_DETAIL,
  SNAPSHOT_OVERBOUND_DETAIL,
  SNAPSHOT_READ_DETAIL,
  SNAPSHOT_UNSETTLED_DETAIL,
} from "./snapshot-policy.ts";

export interface GitReviewSnapshotOptionsV1 {
  /** Trusted PATH exposed to the Git child only (no host credential). */
  trustedPath: string;
  /** Trusted local Git object repository directory (never a worktree read). */
  repositoryDir: string;
  /** Executable resolved through the trusted PATH; default `git`. */
  gitExecutable?: string;
  /** Injected bounded subprocess runtime; default `DenoReplayRuntime`. */
  runtime?: ReplayRuntimeV1;
  /** Whole-snapshot bound override (finite, defaults to 30s). */
  totalDeadlineMs?: number;
  /** Testable clock; defaults to `Date.now`. */
  now?: () => number;
}

export type GitReadV1 =
  | { ok: true; exitCode: number; bytes: Uint8Array }
  | { ok: false; detail: string };
export abstract class GitSnapshotReader {
  protected readonly trustedPath: string;
  protected readonly repositoryDir: string;
  protected readonly gitExecutable: string;
  protected readonly runtime: ReplayRuntimeV1;
  protected readonly totalDeadlineMs: number;
  protected readonly now: () => number;

  constructor(options: GitReviewSnapshotOptionsV1) {
    const totalDeadlineMs = options.totalDeadlineMs ?? MAX_SNAPSHOT_TOTAL_MS;
    if (!Number.isSafeInteger(totalDeadlineMs) || totalDeadlineMs < 1) {
      throw new TypeError("totalDeadlineMs must be a positive integer");
    }
    this.trustedPath = options.trustedPath;
    this.repositoryDir = options.repositoryDir;
    this.gitExecutable = options.gitExecutable ?? "git";
    this.runtime = options.runtime ??
      new DenoReplayRuntime(options.trustedPath);
    this.totalDeadlineMs = totalDeadlineMs;
    this.now = options.now ?? (() => Date.now());
  }

  /** Fixed-argv, cleared-environment, bounded Git object read. */
  protected async read(
    args: readonly string[],
    allowExitCodes: readonly number[],
    maxOutputBytes: number,
    deadline: number,
  ): Promise<GitReadV1> {
    const remaining = deadline - this.now();
    if (remaining <= 0) return { ok: false, detail: SNAPSHOT_DEADLINE_DETAIL };
    const result = await this.runtime.run({
      executable: this.gitExecutable,
      args: [...GIT_FIXED_ARGV, ...args],
      cwd: this.repositoryDir,
      env: {
        PATH: this.trustedPath,
        HOME: this.repositoryDir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_NO_LAZY_FETCH: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_ATTR_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/bin/false",
        GIT_PAGER: "cat",
        LC_ALL: "C",
        LANG: "C",
        TZ: "UTC",
      },
      maxDurationMs: remaining,
      maxOutputBytes,
    });
    if (result.outcome !== "exited" || result.exitCode === null) {
      return {
        ok: false,
        detail: result.outcome === "timed_out"
          ? SNAPSHOT_DEADLINE_DETAIL
          : SNAPSHOT_READ_DETAIL,
      };
    }
    if (result.truncated) {
      return { ok: false, detail: SNAPSHOT_OVERBOUND_DETAIL };
    }
    if (!result.settled) {
      return { ok: false, detail: SNAPSHOT_UNSETTLED_DETAIL };
    }
    if (!allowExitCodes.includes(result.exitCode)) {
      return { ok: false, detail: SNAPSHOT_READ_DETAIL };
    }
    return { ok: true, exitCode: result.exitCode, bytes: result.stdout };
  }

  /** Fatal UTF-8 decode; null when the exact bytes are not valid UTF-8 text. */
  protected text(bytes: Uint8Array): string | null {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  abstract capture(input: {
    base: GitSha;
    head: GitSha;
  }): Promise<PortResultV1<ReviewSnapshotV1>>;

  protected abstract validateChanges(changes: RawChangeV1[]): string | null;

  abstract validatePublication(input: {
    base: GitSha;
    head: GitSha;
    publishedHead: GitSha | null;
    protectedPaths: readonly string[];
  }): Promise<PortResultV1<void>>;
}
