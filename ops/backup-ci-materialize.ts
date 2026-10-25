/**
 * Materialization of a backup CI unit in the trusted job
 * (docs/backup-ci-spec.md §9.4, A7). Target bytes are only ever data here:
 * a bare repository is fetched by exact SHA, read with git plumbing
 * (`cat-file`, `ls-tree`, `grep`) and shipped to the untrusted leg as a
 * deterministic tar. No target file is checked out and no target code runs.
 *
 * - Every git child runs with a cleared environment (PATH, a scratch HOME,
 *   `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM=/dev/null`,
 *   `GIT_TERMINAL_PROMPT=0`) and `-c core.hooksPath=/dev/null -c
 *   core.fsmonitor=false -c protocol.allow=never -c protocol.https.allow=always
 *   -c submodule.recurse=false`. The read token travels only as
 *   `GIT_CONFIG_COUNT/KEY_0/VALUE_0` (an `http.https://github.com/.extraheader`)
 *   of the one fetch; it is never in argv or a config file.
 * - A pull_request unit's exec commit is the synthetic merge
 *   M = parents [B, H], tree(H), authored `GitHub <noreply@github.com>` at the
 *   planned time; its raw parent lines are verified.
 * - Before the tar is written the repository is bounded to 256 MiB and its
 *   `config`, `FETCH_HEAD`, `packed-refs` and `logs/` are scanned for the
 *   token and for `extraheader`; the tar itself is scanned again.
 */
import { createHash } from "node:crypto";
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  BACKUP_CI_MAX_TREE_BYTES,
  type BackupCiUnitV1,
} from "../src/contracts/backup-ci.ts";
import type { GitRunnerV1, GitRunResultV1 } from "../src/state/state-git.ts";

export const BACKUP_CI_GIT_SAFETY = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "submodule.recurse=false",
] as const;
export const BACKUP_CI_EXEC_REF = "refs/heads/backup-exec";
export const BACKUP_CI_GREP_TIMEOUT_MS = 30_000;
const SHA_RE = /^[0-9a-f]{40}$/;

export interface BackupCiGitOptionsV1 {
  cwd: string;
  env?: Readonly<Record<string, string>>;
  stdin?: Uint8Array;
  rawOutput?: boolean;
  timeoutMs?: number;
}
/** A git runner whose children run with a cleared environment. */
export interface BackupCiGitV1 extends GitRunnerV1 {
  runGit(args: string[], opts: BackupCiGitOptionsV1): Promise<GitRunResultV1>;
}

/** The production runner: clearEnv, PATH, a scratch HOME, no system config. */
export function createBackupCiGit(
  home: string,
  path: string = "/usr/local/bin:/usr/bin:/bin",
): BackupCiGitV1 {
  return {
    async runGit(args, opts) {
      const command = new Deno.Command("git", {
        args,
        cwd: opts.cwd,
        clearEnv: true,
        env: {
          PATH: path,
          HOME: home,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          ...opts.env,
        },
        stdin: opts.stdin === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
        ...(opts.timeoutMs === undefined
          ? {}
          : { signal: AbortSignal.timeout(opts.timeoutMs) }),
      });
      let result: Deno.CommandOutput;
      try {
        if (opts.stdin === undefined) result = await command.output();
        else {
          const child = command.spawn();
          const writer = child.stdin.getWriter();
          const [output] = await Promise.all([
            child.output(),
            writer.write(opts.stdin).finally(() => writer.close()),
          ]);
          result = output;
        }
      } catch {
        return { ok: false, code: -1, stdout: "", stderr: "" };
      }
      return {
        ok: result.success,
        code: result.code,
        stdout: opts.rawOutput ? "" : new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
        ...(opts.rawOutput ? { stdoutBytes: result.stdout } : {}),
      };
    },
  };
}

/** The `GIT_CONFIG_*` auth header of one https fetch from github.com. */
export function backupCiFetchAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${
      btoa(`x-access-token:${token}`)
    }`,
  };
}

/** Every encoding of a token a leaked header or URL would carry. */
export function backupCiTokenNeedles(token: string): string[] {
  return [token, btoa(`x-access-token:${token}`), btoa(token)];
}

export interface BackupCiTreeEntryV1 {
  mode: string;
  type: string;
  oid: GitSha;
}

/** A fetched bare repository, read with plumbing only. */
export class BackupCiBareRepo {
  constructor(
    readonly dir: string,
    private readonly git: BackupCiGitV1,
    private readonly protocols: readonly string[],
  ) {}

  private run(
    args: string[],
    options: Omit<BackupCiGitOptionsV1, "cwd"> = {},
  ): Promise<GitRunResultV1> {
    const extra = this.protocols.flatMap((p) => [
      "-c",
      `protocol.${p}.allow=always`,
    ]);
    return this.git.runGit([...BACKUP_CI_GIT_SAFETY, ...extra, ...args], {
      cwd: this.dir,
      ...options,
    });
  }

  async objectType(sha: string): Promise<string | null> {
    if (!SHA_RE.test(sha)) return null;
    const out = await this.run(["cat-file", "-t", sha]);
    return out.ok ? out.stdout.trim() : null;
  }

  async treeOf(commit: GitSha): Promise<GitSha | null> {
    const out = await this.run(["rev-parse", "--verify", `${commit}^{tree}`]);
    const tree = out.stdout.trim();
    return out.ok && SHA_RE.test(tree) ? tree as GitSha : null;
  }

  async entry(
    commit: GitSha,
    path: string,
  ): Promise<BackupCiTreeEntryV1 | null> {
    const out = await this.run(["ls-tree", "-z", commit, "--", path]);
    if (!out.ok) return null;
    const rows = out.stdout.split("\0").filter((row) => row.length > 0);
    if (rows.length !== 1) return null;
    const match = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/s
      .exec(rows[0]);
    if (match === null || match[4] !== path) return null;
    return { mode: match[1], type: match[2], oid: match[3] as GitSha };
  }

  async rootNames(commit: GitSha): Promise<string[] | null> {
    const out = await this.run(["ls-tree", "-z", "--name-only", commit]);
    return out.ok ? out.stdout.split("\0").filter((n) => n.length > 0) : null;
  }

  async listFiles(commit: GitSha): Promise<string[] | null> {
    const out = await this.run(["ls-tree", "-r", "-z", "--name-only", commit]);
    return out.ok ? out.stdout.split("\0").filter((n) => n.length > 0) : null;
  }

  async readBlob(oid: string, max: number): Promise<Uint8Array | null> {
    if (!SHA_RE.test(oid)) return null;
    const size = await this.run(["cat-file", "-s", oid]);
    const n = Number(size.stdout.trim());
    if (!size.ok || !Number.isSafeInteger(n) || n > max) return null;
    const out = await this.run(["cat-file", "blob", oid], { rawOutput: true });
    return out.ok && out.stdoutBytes !== undefined ? out.stdoutBytes : null;
  }

  /** A regular (100644 or 100755) file at the commit, at most `max` bytes. */
  async readFile(
    commit: GitSha,
    path: string,
    max: number,
  ): Promise<Uint8Array | null> {
    const entry = await this.entry(commit, path);
    if (
      entry === null || entry.type !== "blob" ||
      (entry.mode !== "100644" && entry.mode !== "100755")
    ) return null;
    return await this.readBlob(entry.oid, max);
  }

  /**
   * `git grep -I -E -l --max-count=1` of `pattern` over `paths` at the
   * commit: true on a match, false on none, null on an error or timeout.
   */
  async grep(
    commit: GitSha,
    pattern: string,
    paths: readonly string[],
    timeoutMs: number = BACKUP_CI_GREP_TIMEOUT_MS,
  ): Promise<boolean | null> {
    if (paths.length === 0) return false;
    const out = await this.run([
      "grep",
      "-I",
      "-E",
      "-l",
      "--max-count=1",
      "-e",
      pattern,
      commit,
      "--",
      ...paths.map((p) => `:(literal)${p}`),
    ], { timeoutMs });
    if (out.code === 0) return true;
    if (out.code === 1 && out.stdout.length === 0) return false;
    return null;
  }

  /** The raw `parent` header lines of a commit object. */
  async rawParents(commit: string): Promise<GitSha[] | null> {
    if (!SHA_RE.test(commit)) return null;
    const out = await this.run(["cat-file", "commit", commit]);
    if (!out.ok) return null;
    const header = out.stdout.split("\n\n")[0].split("\n");
    const parents: GitSha[] = [];
    for (const line of header) {
      const match = /^parent ([0-9a-f]{40})$/.exec(line);
      if (match !== null) parents.push(match[1] as GitSha);
    }
    return parents;
  }

  /** M = parents [base, head], tree(head), or null when anything differs. */
  async syntheticMerge(
    base: GitSha,
    head: GitSha,
    plannedAt: number,
  ): Promise<GitSha | null> {
    const tree = await this.treeOf(head);
    if (tree === null || await this.objectType(base) !== "commit") return null;
    const date = `@${Math.floor(plannedAt / 1000)} +0000`;
    const out = await this.run([
      "commit-tree",
      tree,
      "-p",
      base,
      "-p",
      head,
      "-m",
      `Merge ${head} into ${base}`,
    ], {
      env: {
        GIT_AUTHOR_NAME: "GitHub",
        GIT_AUTHOR_EMAIL: "noreply@github.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "GitHub",
        GIT_COMMITTER_EMAIL: "noreply@github.com",
        GIT_COMMITTER_DATE: date,
      },
    });
    const merge = out.stdout.trim();
    if (!out.ok || !SHA_RE.test(merge)) return null;
    const parents = await this.rawParents(merge);
    const mergeTree = await this.treeOf(merge as GitSha);
    return parents !== null && parents.length === 2 && parents[0] === base &&
        parents[1] === head && mergeTree === tree
      ? merge as GitSha
      : null;
  }

  /** Points the bare `HEAD` at `refs/heads/backup-exec` = `commit`. */
  async setExec(commit: GitSha): Promise<boolean> {
    const ref = await this.run(["update-ref", BACKUP_CI_EXEC_REF, commit]);
    const head = await this.run(["symbolic-ref", "HEAD", BACKUP_CI_EXEC_REF]);
    return ref.ok && head.ok;
  }

  async writeUnit(unit: BackupCiUnitV1): Promise<void> {
    await Deno.writeTextFile(
      `${this.dir}/unit.json`,
      canonicalStringify(unit),
      { mode: 0o644 },
    );
  }

  /** Total bytes of every regular file (symlinks are not followed). */
  async sizeBytes(): Promise<number> {
    let total = 0;
    const walk = async (dir: string) => {
      for await (const entry of Deno.readDir(dir)) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory) await walk(path);
        else if (entry.isFile) total += (await Deno.lstat(path)).size;
      }
    };
    await walk(this.dir);
    return total;
  }

  /** Whether a credential-bearing file names a needle or `extraheader`. */
  async leaksCredential(needles: readonly string[]): Promise<boolean> {
    const files = ["config", "FETCH_HEAD", "packed-refs"].map((f) =>
      `${this.dir}/${f}`
    );
    const logs = `${this.dir}/logs`;
    const walk = async (dir: string) => {
      try {
        for await (const entry of Deno.readDir(dir)) {
          const path = `${dir}/${entry.name}`;
          if (entry.isDirectory) await walk(path);
          else files.push(path);
        }
      } catch { /* no logs directory */ }
    };
    await walk(logs);
    for (const file of files) {
      let text: string;
      try {
        text = await Deno.readTextFile(file);
      } catch {
        continue;
      }
      if (/extraheader/i.test(text)) return true;
      if (needles.some((n) => n.length > 0 && text.includes(n))) return true;
    }
    return false;
  }
}

export interface BackupCiFetchInputV1 {
  git: BackupCiGitV1;
  /** A fresh, empty directory for the bare repository. */
  dir: string;
  /** `https://github.com/<owner>/<repo>` (tests: a file URL). */
  remoteUrl: string;
  token: string | null;
  commits: readonly GitSha[];
  /** Extra transports allowed besides https (tests only: `file`). */
  protocols?: readonly string[];
}

/**
 * `git init --bare` and one depth-1 fetch of exact SHAs; null when any
 * fetched SHA is not a commit afterwards (`fetch_failed`).
 */
export async function fetchBackupCiBare(
  input: BackupCiFetchInputV1,
): Promise<BackupCiBareRepo | null> {
  const repo = new BackupCiBareRepo(
    input.dir,
    input.git,
    input.protocols ?? [],
  );
  if (
    input.commits.length === 0 || input.commits.some((c) => !SHA_RE.test(c))
  ) {
    return null;
  }
  await Deno.mkdir(input.dir, { recursive: true });
  const init = await input.git.runGit(
    [...BACKUP_CI_GIT_SAFETY, "init", "-q", "--bare", "--template="],
    { cwd: input.dir },
  );
  if (!init.ok) return null;
  const extra = (input.protocols ?? []).flatMap((p) => [
    "-c",
    `protocol.${p}.allow=always`,
  ]);
  const fetched = await input.git.runGit([
    ...BACKUP_CI_GIT_SAFETY,
    ...extra,
    "fetch",
    "-q",
    "--depth=1",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-auto-gc",
    "--no-write-fetch-head",
    input.remoteUrl,
    ...input.commits,
  ], {
    cwd: input.dir,
    env: input.token === null ? {} : backupCiFetchAuthEnv(input.token),
  });
  if (!fetched.ok) return null;
  for (const commit of input.commits) {
    if (await repo.objectType(commit) !== "commit") return null;
  }
  return repo;
}

/** A response body of at most `max` bytes, or null (the read is cancelled). */
export async function readBoundedBody(
  response: Response,
  max: number,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    total += step.value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(step.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** sha256 hex of a file, streamed. */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await Deno.open(path, { read: true });
  for await (const chunk of file.readable) hash.update(chunk);
  return hash.digest("hex");
}

/** Whether a file contains any needle (chunked, with overlap). */
export async function fileContainsAny(
  path: string,
  needles: readonly string[],
): Promise<boolean> {
  const encoded = needles.filter((n) => n.length > 0).map((n) =>
    new TextEncoder().encode(n)
  );
  if (encoded.length === 0) return false;
  const overlap = Math.max(...encoded.map((n) => n.length)) - 1;
  let carry = new Uint8Array(0);
  const file = await Deno.open(path, { read: true });
  for await (const chunk of file.readable) {
    const window = new Uint8Array(carry.length + chunk.length);
    window.set(carry);
    window.set(chunk, carry.length);
    for (const needle of encoded) {
      outer: for (let i = 0; i + needle.length <= window.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (window[i + j] !== needle[j]) continue outer;
        }
        return true;
      }
    }
    carry = window.slice(Math.max(0, window.length - overlap));
  }
  return false;
}

export type BackupCiPackResultV1 =
  | { ok: true; tar: string; sha256: string }
  | { ok: false; reason: "tree_too_large" | "credential" | "tar_failed" };

/**
 * Bounds, scans and tars a materialized bare repository (named `bare` in
 * the tar, so the leg extracts `<dir>/bare`). Deterministic: sorted names,
 * mtime 0, owner and group 0, symlinks stored, never followed.
 */
export async function packBackupCiBare(
  repo: BackupCiBareRepo,
  out: string,
  needles: readonly string[],
): Promise<BackupCiPackResultV1> {
  if (await repo.sizeBytes() > BACKUP_CI_MAX_TREE_BYTES) {
    return { ok: false, reason: "tree_too_large" };
  }
  if (await repo.leaksCredential(needles)) {
    return { ok: false, reason: "credential" };
  }
  const parent = repo.dir.slice(0, repo.dir.lastIndexOf("/"));
  const name = repo.dir.slice(repo.dir.lastIndexOf("/") + 1);
  if (name !== "bare") return { ok: false, reason: "tar_failed" };
  const result = await new Deno.Command("tar", {
    args: [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--format=gnu",
      "-cf",
      out,
      "-C",
      parent,
      name,
    ],
    clearEnv: true,
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", LC_ALL: "C" },
    stdout: "null",
    stderr: "null",
  }).output().catch(() => null);
  if (result === null || !result.success) {
    return { ok: false, reason: "tar_failed" };
  }
  if (await fileContainsAny(out, [...needles, "extraheader"])) {
    await Deno.remove(out).catch(() => undefined);
    return { ok: false, reason: "credential" };
  }
  return { ok: true, tar: out, sha256: await fileSha256(out) };
}
