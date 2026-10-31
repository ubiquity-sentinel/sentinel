/**
 * The backup CI store's only writer (docs/backup-ci-spec.md §7), run by the
 * trusted `backup_ci` job with its native `GITHUB_TOKEN`.
 *
 * `openBackupCiStore` lists the tip of `refs/heads/sentinel-backup-ci`
 * (anonymous `ls-remote`) and shallow-fetches it into a private scratch
 * repository; the view reads files with `ls-tree`/`cat-file` and finds the
 * files holding a fixed string with `git grep` (the ingest's dispatched
 * entries). `writeBackupCiStore` re-opens the tip, lets `mutate` compute
 * every touched file from what is there (the WP1 merge rules), writes one
 * commit whose parent is the tip (an orphan first commit when the branch is
 * absent) and pushes it WITHOUT force, so the push is fast-forward only. A
 * rejected push means another writer moved the tip: it re-reads and retries,
 * at most five times. Content is canonical JSON, one file per path.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  BACKUP_CI_MAX_FILE_BYTES,
  BACKUP_CI_STORE_REF,
} from "../src/contracts/backup-ci.ts";
import {
  BACKUP_CI_GIT_SAFETY,
  type BackupCiGitV1,
} from "./backup-ci-materialize.ts";

export const BACKUP_CI_STORE_ATTEMPTS = 5;
const LOCAL_TIP = "refs/sentinel-backup-ci/tip";
const STORE_PATH_RE =
  /^(?:README\.md|v1\/(?:[A-Za-z0-9._-]+\/){0,4}[A-Za-z0-9._-]+\.json)$/;
const README =
  "# sentinel-backup-ci\n\nBackup CI receipts written by the trusted `backup_ci` job " +
  "(docs/backup-ci-spec.md §7). Do not edit by hand.\n";

export interface BackupCiStoreInputV1 {
  git: BackupCiGitV1;
  /** A private scratch directory (created when absent). */
  scratch: string;
  /** The store remote (tests: a file URL). */
  remote: string;
  /** Push credentials (`GIT_CONFIG_*`); reads stay anonymous. */
  pushEnv?: Readonly<Record<string, string>>;
  /** Extra transports besides https (tests only). */
  protocols?: readonly string[];
}

/** A read-only view of one store tip. */
export class BackupCiStoreView {
  constructor(
    readonly tip: GitSha | null,
    private readonly dir: string,
    private readonly run: (args: string[], raw?: boolean) => Promise<
      { ok: boolean; code: number; stdout: string; bytes?: Uint8Array }
    >,
  ) {}

  /** The exact bytes at `path`, or null when absent. Throws when unreadable. */
  async readBytes(path: string): Promise<Uint8Array | null> {
    if (this.tip === null) return null;
    if (!STORE_PATH_RE.test(path)) throw new Error("invalid store path");
    const listed = await this.run(["ls-tree", "-z", this.tip, "--", path]);
    if (!listed.ok) throw new Error("store tree unreadable");
    const rows = listed.stdout.split("\0").filter((r) => r.length > 0);
    if (rows.length === 0) return null;
    const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/s.exec(rows[0]);
    if (rows.length !== 1 || match === null || match[2] !== path) {
      throw new Error("store entry is not a regular file");
    }
    const size = await this.run(["cat-file", "-s", match[1]]);
    if (!size.ok || Number(size.stdout.trim()) > BACKUP_CI_MAX_FILE_BYTES) {
      throw new Error("store file too large");
    }
    const blob = await this.run(["cat-file", "blob", match[1]], true);
    if (!blob.ok || blob.bytes === undefined) {
      throw new Error("store blob unreadable");
    }
    return blob.bytes;
  }

  /** The parsed JSON at `path`, or null when absent. Throws when invalid. */
  async read(path: string): Promise<unknown | null> {
    const bytes = await this.readBytes(path);
    if (bytes === null) return null;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }

  /** Paths under `prefix` whose content holds `fixed` (bounded). */
  async pathsContaining(
    fixed: string,
    prefix: string,
    max = 512,
  ): Promise<string[]> {
    if (this.tip === null) return [];
    const out = await this.run([
      "grep",
      "-l",
      "-F",
      "-e",
      fixed,
      this.tip,
      "--",
      `:(literal)${prefix}`,
    ]);
    if (out.code === 1 && out.stdout.length === 0) return [];
    if (out.code !== 0) throw new Error("store grep failed");
    const paths = out.stdout.split("\n").filter((l) => l.length > 0).map((l) =>
      l.startsWith(`${this.tip}:`) ? l.slice(this.tip!.length + 1) : l
    );
    if (paths.length > max) throw new Error("too many store paths");
    return paths.sort();
  }

  get directory(): string {
    return this.dir;
  }
}

async function gitIn(
  input: BackupCiStoreInputV1,
  dir: string,
  args: string[],
  options: { env?: Record<string, string>; stdin?: Uint8Array; raw?: boolean } =
    {},
) {
  const extra = (input.protocols ?? []).flatMap((p) => [
    "-c",
    `protocol.${p}.allow=always`,
  ]);
  const out = await input.git.runGit(
    [...BACKUP_CI_GIT_SAFETY, ...extra, "-c", "credential.helper=", ...args],
    {
      cwd: dir,
      env: options.env,
      stdin: options.stdin,
      rawOutput: options.raw === true,
    },
  );
  return {
    ok: out.ok,
    code: out.code,
    stdout: out.stdout,
    bytes: out.stdoutBytes,
  };
}

async function scratchRepo(input: BackupCiStoreInputV1): Promise<string> {
  await Deno.mkdir(input.scratch, { recursive: true });
  const dir = `${input.scratch}/store`;
  try {
    await Deno.stat(`${dir}/HEAD`);
    return dir;
  } catch { /* create */ }
  await Deno.mkdir(dir, { recursive: true });
  const init = await gitIn(input, dir, ["init", "-q", "--bare", "--template="]);
  if (!init.ok) throw new Error("store scratch init failed");
  return dir;
}

/** Lists and fetches the store tip; throws when the remote is unreadable. */
export async function openBackupCiStore(
  input: BackupCiStoreInputV1,
): Promise<BackupCiStoreView> {
  const dir = await scratchRepo(input);
  const run = (args: string[], raw?: boolean) =>
    gitIn(input, dir, args, { raw });
  const listed = await run([
    "ls-remote",
    "--refs",
    input.remote,
    BACKUP_CI_STORE_REF,
  ]);
  if (!listed.ok) throw new Error("store tip unreadable");
  const tips = listed.stdout.split("\n").filter((l) => l.length > 0).map((l) =>
    /^([0-9a-f]{40})\t(\S+)$/.exec(l)
  );
  if (
    tips.some((m) => m === null || m[2] !== BACKUP_CI_STORE_REF) ||
    tips.length > 1
  ) {
    throw new Error("store tip malformed");
  }
  if (tips.length === 0) return new BackupCiStoreView(null, dir, run);
  const fetched = await run([
    "fetch",
    "-q",
    "--depth=1",
    "--no-tags",
    "--no-auto-gc",
    "--no-write-fetch-head",
    input.remote,
    `+${BACKUP_CI_STORE_REF}:${LOCAL_TIP}`,
  ]);
  if (!fetched.ok) throw new Error("store fetch failed");
  const head = await run([
    "rev-parse",
    "--verify",
    "-q",
    `${LOCAL_TIP}^{commit}`,
  ]);
  const tip = head.stdout.trim();
  if (!head.ok || !/^[0-9a-f]{40}$/.test(tip)) {
    throw new Error("store fetch failed");
  }
  return new BackupCiStoreView(tip as GitSha, dir, run);
}

/** Path → new JSON value (null deletes the path). */
export type BackupCiStoreChangesV1 = Map<string, unknown | null>;

export type BackupCiStoreWriteV1 =
  | {
    kind: "committed";
    commit: GitSha;
    parent: GitSha | null;
    attempts: number;
  }
  | { kind: "unchanged"; tip: GitSha | null }
  | { kind: "failed"; detail: string };

const encoder = new TextEncoder();
const sameBytes = (a: Uint8Array | null, b: Uint8Array | null) =>
  a !== null && b !== null && a.length === b.length &&
  a.every((x, i) => x === b[i]);

/** The bytes the store holds for a value. */
export function backupCiStoreBytes(value: unknown): Uint8Array {
  return encoder.encode(`${canonicalStringify(value)}\n`);
}

/**
 * One CAS commit of everything `mutate` returns, retried on a moved tip.
 * `mutate` must be a pure function of the view (it is re-run per attempt).
 */
export async function writeBackupCiStore(
  input: BackupCiStoreInputV1 & {
    runId: number;
    now: () => number;
    mutate: (view: BackupCiStoreView) => Promise<BackupCiStoreChangesV1>;
    log?: (line: string) => void;
  },
): Promise<BackupCiStoreWriteV1> {
  for (let attempt = 1; attempt <= BACKUP_CI_STORE_ATTEMPTS; attempt++) {
    let view: BackupCiStoreView;
    try {
      view = await openBackupCiStore(input);
    } catch (error) {
      return { kind: "failed", detail: (error as Error).message };
    }
    const changes = await input.mutate(view);
    if (view.tip === null && !changes.has("README.md")) {
      changes.set("README.md", README);
    }
    const dir = view.directory;
    const index = `${input.scratch}/index-${attempt}`;
    await Deno.remove(index).catch(() => undefined);
    const env = { GIT_INDEX_FILE: index };
    const run = (args: string[], stdin?: Uint8Array) =>
      gitIn(input, dir, args, { env, stdin });
    const read = await run(
      view.tip === null ? ["read-tree", "--empty"] : ["read-tree", view.tip],
    );
    if (!read.ok) return { kind: "failed", detail: "store index failed" };
    let changed = 0;
    for (
      const [path, value] of [...changes].sort(([a], [b]) => a < b ? -1 : 1)
    ) {
      if (!STORE_PATH_RE.test(path)) {
        return { kind: "failed", detail: "invalid store path" };
      }
      const current = await view.readBytes(path).catch(() => null);
      if (value === null) {
        if (current === null) continue;
        // Mode 0 removes the entry (no work tree is needed, unlike
        // `--force-remove` in a bare repository).
        const removed = await run(
          ["update-index", "--index-info"],
          encoder.encode(`0 ${"0".repeat(40)}\t${path}\n`),
        );
        if (!removed.ok) {
          return { kind: "failed", detail: "store remove failed" };
        }
        changed++;
        continue;
      }
      const bytes = path === "README.md" && typeof value === "string"
        ? encoder.encode(value)
        : backupCiStoreBytes(value);
      if (sameBytes(current, bytes)) {
        continue;
      }
      const hashed = await run(["hash-object", "-w", "--stdin"], bytes);
      const oid = hashed.stdout.trim();
      if (!hashed.ok || !/^[0-9a-f]{40}$/.test(oid)) {
        return { kind: "failed", detail: "store blob write failed" };
      }
      const added = await run([
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${oid},${path}`,
      ]);
      if (!added.ok) return { kind: "failed", detail: "store index failed" };
      changed++;
    }
    if (changed === 0) return { kind: "unchanged", tip: view.tip };
    const tree = await run(["write-tree"]);
    if (!tree.ok) return { kind: "failed", detail: "store tree failed" };
    const date = `@${Math.floor(input.now() / 1000)} +0000`;
    const commit = await gitIn(input, dir, [
      "commit-tree",
      tree.stdout.trim(),
      ...(view.tip === null ? [] : ["-p", view.tip]),
      "-m",
      `sentinel-backup-ci: run ${input.runId} attempt 1`,
    ], {
      env: {
        GIT_AUTHOR_NAME: "sentinel-backup-ci",
        GIT_AUTHOR_EMAIL: "sentinel-backup-ci@users.noreply.github.com",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: "sentinel-backup-ci",
        GIT_COMMITTER_EMAIL: "sentinel-backup-ci@users.noreply.github.com",
        GIT_COMMITTER_DATE: date,
      },
    });
    const sha = commit.stdout.trim();
    if (!commit.ok || !/^[0-9a-f]{40}$/.test(sha)) {
      return { kind: "failed", detail: "store commit failed" };
    }
    const pushed = await gitIn(input, dir, [
      "push",
      "-q",
      input.remote,
      `${sha}:${BACKUP_CI_STORE_REF}`,
    ], { env: { ...(input.pushEnv ?? {}) } });
    if (pushed.ok) {
      input.log?.(JSON.stringify({
        kind: "sentinel_backup_ci_store_commit",
        commit: sha,
        parent: view.tip,
      }));
      return {
        kind: "committed",
        commit: sha as GitSha,
        parent: view.tip,
        attempts: attempt,
      };
    }
  }
  return { kind: "failed", detail: "store push rejected" };
}
