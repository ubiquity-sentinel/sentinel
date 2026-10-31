/**
 * Composition of the backup CI consumer (docs/backup-ci-spec.md §11.2, §11.4,
 * §11.8) for the runtime host and the maintenance launcher: the lower-only
 * mode from `SENTINEL_BACKUP_CI`, the committed targets file and one store
 * reader over anonymous, time-bounded git.
 *
 * - The mode is exactly `on` or `shadow`, else `off`; a process that was not
 *   granted the variable reads it as unset (`off`), so installing a runtime
 *   before its workflow grants the variable changes nothing.
 * - An absent, malformed or empty targets file means no consumer at all, as
 *   does mode `off`: every check read is then exactly the native one.
 * - The reader's git runs with a cleared environment, no credential helper,
 *   no global or system config, no repository discovery above its own scratch
 *   directory, https only, and a per-command deadline that kills the child.
 */
import {
  type BackupCiModeV1,
  type BackupCiTargetV1,
  parseBackupCiMode,
  parseBackupCiTargets,
} from "../contracts/backup-ci.ts";
import type { Clock } from "../contracts/ports.ts";
import {
  type BackupCiConsumerV1,
  BackupCiListingCache,
} from "../github/backup-ci-observations.ts";
import { createBackupCiReader } from "../github/backup-ci-reader.ts";
import type { GitRunnerV1, GitRunResultV1 } from "../state/state-git.ts";

/** The workflow variable (and child environment key) of the mode. */
export const BACKUP_CI_MODE_ENV = "SENTINEL_BACKUP_CI";

/** The committed backup targets, relative to the checkout root. */
export const BACKUP_CI_TARGETS_FILE_NAME = "sentinel.backup-ci-targets.json";

/** Per git command bound of the store reader. */
export const BACKUP_CI_GIT_TIMEOUT_MS = 20_000;

/** Sentinel's own repository is never a backup target. */
const SELF_REPOSITORY = "ubiquity-sentinel/sentinel";

/** The mode, lower-only: an unreadable, unset or invalid value is `off`. */
export function readBackupCiMode(
  read: (name: string) => string | null | undefined,
): BackupCiModeV1 {
  try {
    return parseBackupCiMode(read(BACKUP_CI_MODE_ENV) ?? undefined);
  } catch {
    return "off";
  }
}

/** The committed targets file under `root`; any failure lists nothing. */
export async function readBackupCiTargets(
  root: string,
  readFile: (path: string) => Promise<string> = (path) =>
    Deno.readTextFile(path),
): Promise<BackupCiTargetV1[]> {
  try {
    const targets = parseBackupCiTargets(
      JSON.parse(await readFile(`${root}/${BACKUP_CI_TARGETS_FILE_NAME}`)),
    );
    return targets.filter((target) => target.repository !== SELF_REPOSITORY);
  } catch {
    return [];
  }
}

/** The parent of an absolute directory, for `GIT_CEILING_DIRECTORIES`. */
function parentOf(directory: string): string | null {
  if (!directory.startsWith("/")) return null;
  const trimmed = directory.replace(/\/+$/, "");
  const at = trimmed.lastIndexOf("/");
  return at <= 0 ? "/" : trimmed.slice(0, at);
}

/**
 * The store reader's git: argv only, a cleared environment (PATH, a scratch
 * HOME and config isolation), never stdin, and a deadline per command.
 */
export class BoundedAnonymousGitRunner implements GitRunnerV1 {
  private readonly path: string;

  constructor(
    private readonly home: string,
    private readonly timeoutMs: number = BACKUP_CI_GIT_TIMEOUT_MS,
    private readonly allowProtocol: string = "https",
  ) {
    let path = "/usr/bin:/bin";
    try {
      path = Deno.env.get("PATH") ?? path;
    } catch {
      // Without a PATH grant the fixed system path is used.
    }
    this.path = path;
  }

  async runGit(
    args: string[],
    opts: {
      cwd: string;
      env?: Readonly<Record<string, string>>;
      stdin?: Uint8Array;
      rawOutput?: boolean;
    },
  ): Promise<GitRunResultV1> {
    if (opts.stdin !== undefined) {
      return { ok: false, code: -1, stdout: "", stderr: "" };
    }
    const ceiling = parentOf(opts.cwd);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await new Deno.Command("git", {
        args,
        cwd: opts.cwd,
        clearEnv: true,
        env: {
          PATH: this.path,
          HOME: this.home,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: this.allowProtocol,
          ...(ceiling === null ? {} : { GIT_CEILING_DIRECTORIES: ceiling }),
          ...opts.env,
        },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: controller.signal,
      }).output();
      return {
        ok: result.success && !controller.signal.aborted,
        code: result.code,
        stdout: opts.rawOutput ? "" : new TextDecoder().decode(result.stdout),
        stderr: "",
        ...(opts.rawOutput ? { stdoutBytes: result.stdout } : {}),
      };
    } catch {
      return { ok: false, code: -1, stdout: "", stderr: "" };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface BackupCiComposeInputV1 {
  mode: BackupCiModeV1;
  /** The checkout root holding the committed targets file. */
  root: string;
  /** A private scratch directory for the reader's repository and git HOME. */
  scratch: string;
  clock: Clock;
  /** Test seams: the git runner, the store remote and the file read. */
  git?: GitRunnerV1;
  remoteUrl?: string;
  readFile?: (path: string) => Promise<string>;
}

/** The consumer, or undefined (mode `off` or no listed target). */
export async function composeBackupCi(
  input: BackupCiComposeInputV1,
): Promise<BackupCiConsumerV1 | undefined> {
  if (input.mode === "off") return undefined;
  const targets = await readBackupCiTargets(input.root, input.readFile);
  if (targets.length === 0) return undefined;
  const reader = createBackupCiReader({
    git: input.git ??
      new BoundedAnonymousGitRunner(`${input.scratch}/git-home`),
    scratchRoot: input.scratch,
    clock: input.clock,
    targets,
    ...(input.remoteUrl === undefined ? {} : { remoteUrl: input.remoteUrl }),
  });
  return Object.freeze({
    reader,
    mode: input.mode,
    listings: new BackupCiListingCache(() => input.clock.now()),
  });
}

/**
 * The runtime host's consumer: the mode read through the host's own
 * environment reader, the targets file of the runtime checkout `root`, and a
 * scratch directory under the host's private state root.
 */
export function hostBackupCi(
  read: (name: string) => string | null | undefined,
  root: string,
  stateRoot: string,
  clock: Clock,
): Promise<BackupCiConsumerV1 | undefined> {
  return composeBackupCi({
    mode: readBackupCiMode(read),
    root,
    scratch: `${stateRoot}/tmp/backup-ci`,
    clock,
  });
}
