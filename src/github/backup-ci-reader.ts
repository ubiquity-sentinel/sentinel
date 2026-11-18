/**
 * Read-only access to the backup CI receipt store (docs/backup-ci-spec.md §7).
 *
 * The store is the branch `sentinel-backup-ci` of the public Sentinel
 * repository. Reads are anonymous git (no REST budget, no credential): the
 * tip comes from `git ls-remote` and is cached for `BACKUP_CI_TIP_TTL_MS`;
 * each new tip is shallow-fetched once per process into a private scratch
 * repository, and files are read with `git ls-tree`/`git cat-file` (a 100644
 * blob of at most `BACKUP_CI_MAX_FILE_BYTES`). Only listed targets are ever
 * looked up.
 *
 * A missing branch or file is `ok` with nothing in it. A file that does not
 * parse, or that names another path, commit, repository or repository id than
 * the committed targets file, is `invalid`; any git failure is `unavailable`.
 * Callers substitute nothing unless the read is `ok`, so missing evidence
 * never passes. Details are fixed strings: no git output is ever carried.
 */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import {
  BACKUP_CI_MAX_FILE_BYTES,
  BACKUP_CI_STORE_REF,
  BACKUP_CI_STORE_REMOTE,
  BACKUP_CI_TIP_TTL_MS,
  backupCiCalibrationPath,
  type BackupCiCalibrationV1,
  type BackupCiCommitFileV1,
  backupCiCommitPath,
  backupCiSuspensionPath,
  type BackupCiSuspensionV1,
  type BackupCiTargetV1,
  parseBackupCiCalibration,
  parseBackupCiCommitFile,
  parseBackupCiSuspension,
} from "../contracts/backup-ci.ts";
import {
  BACKUP_CI_NOTHING_EXCLUDED,
  BACKUP_CI_TRUST_FILE_RE,
  backupCiCheckCalibrationPath,
  type BackupCiCheckCalibrationV1,
  backupCiCheckDefinitionsPath,
  type BackupCiCheckDefinitionsV1,
  backupCiEnrolmentPath,
  backupCiExcludedRunners,
  type BackupCiExcludedRunnersV1,
  parseBackupCiCheckCalibration,
  parseBackupCiCheckDefinitions,
  parseBackupCiEnrolment,
} from "../contracts/backup-ci-trust.ts";
import type { Clock } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { GitRunnerV1 } from "../state/state-git.ts";

export type BackupCiReadV1 =
  | {
    kind: "ok";
    file: BackupCiCommitFileV1 | null;
    suspensions: BackupCiSuspensionV1[];
    calibration: BackupCiCalibrationV1 | null;
    /** The target's per-check calibration (`checks.json`), or null. */
    checks: BackupCiCheckCalibrationV1 | null;
    /** Agreements per job definition (`check-defs.json`), or null. */
    definitions?: BackupCiCheckDefinitionsV1 | null;
    /** Runners a false green on any target excludes (`backup-ci-trust.ts`). */
    excluded: BackupCiExcludedRunnersV1;
    /** The store tip read; null when the branch does not exist. */
    tip: GitSha | null;
  }
  | { kind: "unavailable" | "invalid"; detail: string };

export interface BackupCiReaderV1 {
  readonly targets: readonly BackupCiTargetV1[];
  /** The listed target of this repository, or null (never looked up). */
  target(repo: RepositoryIdentityV1): BackupCiTargetV1 | null;
  read(repo: RepositoryIdentityV1, sha: GitSha): Promise<BackupCiReadV1>;
}

export interface BackupCiReaderInputV1 {
  git: GitRunnerV1;
  scratchRoot: string;
  clock: Clock;
  targets: readonly BackupCiTargetV1[];
  remoteUrl?: string;
}

/** Parsed blobs one reader keeps (a blob id never changes content). */
const BLOB_MEMO_MAX = 256;

type Failure = { kind: "unavailable" | "invalid"; detail: string };
type Blob = { kind: "absent" } | { kind: "ok"; value: unknown } | Failure;

const unavailable = (detail: string): Failure => ({
  kind: "unavailable",
  detail,
});
const invalid = (detail: string): Failure => ({ kind: "invalid", detail });

export function createBackupCiReader(
  input: BackupCiReaderInputV1,
): BackupCiReaderV1 {
  return new BackupCiStoreReader(input);
}

class BackupCiStoreReader implements BackupCiReaderV1 {
  readonly targets: readonly BackupCiTargetV1[];
  private readonly remote: string;
  private tipCache: { tip: GitSha | null; at: number } | null = null;
  private repository: string | null = null;
  private readonly fetched = new Set<string>();
  private readonly blobs = new Map<string, Blob>();
  private exclusionMemo: {
    tip: GitSha;
    value: BackupCiExcludedRunnersV1;
  } | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly input: BackupCiReaderInputV1) {
    this.targets = input.targets.map((target) => ({ ...target }));
    this.remote = input.remoteUrl ?? BACKUP_CI_STORE_REMOTE;
  }

  target(repo: RepositoryIdentityV1): BackupCiTargetV1 | null {
    const name = `${repo.owner}/${repo.name}`;
    return this.targets.find((target) => target.repository === name) ?? null;
  }

  /** Reads are serialized: one scratch repository, one fetch at a time. */
  read(repo: RepositoryIdentityV1, sha: GitSha): Promise<BackupCiReadV1> {
    const run = this.queue.then(() => this.readNow(repo, sha));
    this.queue = run.catch(() => undefined);
    return run.catch(() => unavailable("backup CI store read failed"));
  }

  private async readNow(
    repo: RepositoryIdentityV1,
    sha: GitSha,
  ): Promise<BackupCiReadV1> {
    const target = this.target(repo);
    if (target === null) return unavailable("not a backup CI target");
    if (!isGitSha(sha)) return invalid("backup CI read of a malformed commit");
    const listed = await this.tip();
    if ("kind" in listed) return listed;
    if (listed.tip === null) {
      return {
        kind: "ok",
        file: null,
        suspensions: [],
        calibration: null,
        checks: null,
        definitions: null,
        excluded: BACKUP_CI_NOTHING_EXCLUDED,
        tip: null,
      };
    }
    const tip = await this.fetch(listed.tip);
    if (typeof tip !== "string") return tip;
    const excluded = await this.exclusion(tip);
    if ("kind" in excluded) return excluded;
    const { owner, name } = repo;
    const reads = await this.readAll(tip, [
      backupCiCommitPath(owner, name, sha),
      backupCiSuspensionPath(),
      backupCiSuspensionPath(owner, name),
      backupCiCalibrationPath(owner, name),
      backupCiCheckCalibrationPath(owner, name),
      backupCiEnrolmentPath(owner, name),
      backupCiCheckDefinitionsPath(owner, name),
    ]);
    if (!Array.isArray(reads)) return reads;
    const [file, global, local, calibration, checks, enrolment, defs] = reads;
    try {
      const parsedFile = file === null ? null : parseBackupCiCommitFile(file);
      const suspensions = [global, local].map((value) =>
        value === null ? null : parseBackupCiSuspension(value)
      );
      const parsedCalibration = calibration === null
        ? null
        : parseBackupCiCalibration(calibration);
      const parsedChecks = checks === null
        ? null
        : parseBackupCiCheckCalibration(checks);
      const parsedDefs = defs === null
        ? null
        : parseBackupCiCheckDefinitions(defs);
      // An enrolled row without a committed id binds the id its first
      // enrolment pinned (`enrolment.json`). Without a pin nothing binds
      // (and nothing was dispatched), so the commit file reads as absent.
      const pin = enrolment === null ? null : parseBackupCiEnrolment(enrolment);
      if (
        pin !== null &&
        (pin.repository.owner !== owner || pin.repository.name !== name)
      ) return invalid("backup CI enrolment does not bind its path");
      const pinned = target.id ?? pin?.repository.id ?? null;
      const binds = (r: { owner: string; name: string; id: number }) =>
        r.owner === owner && r.name === name && r.id === pinned;
      if (
        parsedFile !== null && pinned !== null &&
        (!binds(parsedFile.repository) || parsedFile.commit !== sha)
      ) return invalid("backup CI commit file does not bind its path");
      if (
        (suspensions[0] !== null && suspensions[0].scope !== "all") ||
        (suspensions[1] !== null && suspensions[1].scope !== target.repository)
      ) return invalid("backup CI suspension does not bind its path");
      if (
        parsedCalibration !== null && pinned !== null &&
        !binds(parsedCalibration.repository)
      ) return invalid("backup CI calibration does not bind its path");
      if (
        parsedChecks !== null && pinned !== null &&
        !binds(parsedChecks.repository)
      ) return invalid("backup CI check calibration does not bind its path");
      if (
        parsedDefs !== null && pinned !== null &&
        !binds(parsedDefs.repository)
      ) return invalid("backup CI check definitions do not bind their path");
      // Unpinned: nothing of the target is usable (files, calibration).
      return {
        kind: "ok",
        file: pinned === null ? null : parsedFile,
        suspensions: suspensions.filter((s) => s !== null),
        calibration: pinned === null ? null : parsedCalibration,
        checks: pinned === null ? null : parsedChecks,
        definitions: pinned === null ? null : parsedDefs,
        excluded,
        tip,
      };
    } catch {
      return invalid("backup CI store file does not parse");
    }
  }

  private async git(
    args: string[],
    cwd: string,
    rawOutput = false,
  ): Promise<{ ok: boolean; stdout: string; bytes?: Uint8Array }> {
    try {
      const result = await this.input.git.runGit(
        ["-c", "credential.helper=", ...args],
        { cwd, env: { GIT_TERMINAL_PROMPT: "0" }, rawOutput },
      );
      return {
        ok: result.ok,
        stdout: result.stdout,
        bytes: result.stdoutBytes,
      };
    } catch {
      return { ok: false, stdout: "" };
    }
  }

  /** The store tip, cached for `BACKUP_CI_TIP_TTL_MS`; failures uncached. */
  private async tip(): Promise<{ tip: GitSha | null } | Failure> {
    const now = this.input.clock.now();
    if (
      this.tipCache !== null && now >= this.tipCache.at &&
      now - this.tipCache.at < BACKUP_CI_TIP_TTL_MS
    ) return { tip: this.tipCache.tip };
    try {
      await Deno.mkdir(this.input.scratchRoot, { recursive: true });
    } catch {
      return unavailable("backup CI store scratch failed");
    }
    const listed = await this.git(
      ["ls-remote", "--refs", this.remote, BACKUP_CI_STORE_REF],
      this.input.scratchRoot,
    );
    if (!listed.ok) return unavailable("backup CI store tip is unreadable");
    const tips: string[] = [];
    for (const line of listed.stdout.split("\n")) {
      if (line.length === 0) continue;
      const match = /^([0-9a-f]{40})\t(\S+)$/.exec(line);
      if (match === null) {
        return unavailable("backup CI store tip is malformed");
      }
      if (match[2] === BACKUP_CI_STORE_REF) tips.push(match[1]);
    }
    if (tips.length > 1) return unavailable("backup CI store tip is ambiguous");
    const tip = (tips[0] ?? null) as GitSha | null;
    this.tipCache = { tip, at: now };
    return { tip };
  }

  /** Shallow-fetches the tip once; a moved branch yields the newer tip. */
  private async fetch(tip: GitSha): Promise<GitSha | Failure> {
    if (this.fetched.has(tip)) return tip;
    if (this.repository === null) {
      try {
        const directory = await Deno.makeTempDir({
          dir: this.input.scratchRoot,
          prefix: "backup-ci-store-",
        });
        const init = await this.git(["init", "-q", "--bare"], directory);
        if (!init.ok) return unavailable("backup CI store scratch failed");
        this.repository = directory;
      } catch {
        return unavailable("backup CI store scratch failed");
      }
    }
    const local = "refs/sentinel-backup-ci/tip";
    const fetched = await this.git([
      "fetch",
      "-q",
      "--depth=1",
      "--no-tags",
      "--no-auto-gc",
      this.remote,
      `+${BACKUP_CI_STORE_REF}:${local}`,
    ], this.repository);
    if (!fetched.ok) return unavailable("backup CI store fetch failed");
    const head = await this.git(
      ["rev-parse", "--verify", "-q", `${local}^{commit}`],
      this.repository,
    );
    const commit = head.stdout.trim();
    if (!head.ok || !/^[0-9a-f]{40}$/.test(commit)) {
      return unavailable("backup CI store fetch failed");
    }
    this.fetched.add(commit);
    if (commit !== tip) {
      this.tipCache = { tip: commit as GitSha, at: this.input.clock.now() };
    }
    return commit as GitSha;
  }

  private async readAll(
    tip: GitSha,
    paths: string[],
  ): Promise<unknown[] | Failure> {
    const values: unknown[] = [];
    for (const path of paths) {
      const blob = await this.readJson(tip, path);
      if (blob.kind === "absent") values.push(null);
      else if (blob.kind === "ok") values.push(blob.value);
      else return blob;
    }
    return values;
  }

  /**
   * The runners a false green excludes (`backup-ci-trust.ts`), from every
   * target's suspension and calibration file at `tip`: one recursive listing
   * per tip, blobs through the memo. Any unreadable or invalid file fails the
   * read (no stand-in), as for the target's own files.
   */
  private async exclusion(
    tip: GitSha,
  ): Promise<BackupCiExcludedRunnersV1 | Failure> {
    if (this.exclusionMemo?.tip === tip) return this.exclusionMemo.value;
    const listed = await this.git(
      ["ls-tree", "-r", tip, "--", "v1"],
      this.repository as string,
    );
    if (!listed.ok) return unavailable("backup CI store tree is unreadable");
    const suspensions: BackupCiSuspensionV1[] = [];
    const calibrations: BackupCiCalibrationV1[] = [];
    const checks: BackupCiCheckCalibrationV1[] = [];
    for (const line of listed.stdout.split("\n")) {
      const match = /^(\d{6}) (\w+) ([0-9a-f]{40})\t(.+)$/.exec(line);
      if (match === null || !BACKUP_CI_TRUST_FILE_RE.test(match[4])) continue;
      if (match[1] !== "100644" || match[2] !== "blob") {
        return invalid("backup CI store entry is not a regular file");
      }
      const blob = await this.readOid(match[3]);
      if (blob.kind !== "ok") {
        return blob.kind === "absent"
          ? unavailable("backup CI store blob is unreadable")
          : blob;
      }
      try {
        if (match[4].endsWith("suspended.json")) {
          suspensions.push(parseBackupCiSuspension(blob.value));
        } else if (match[4].endsWith("checks.json")) {
          checks.push(parseBackupCiCheckCalibration(blob.value));
        } else calibrations.push(parseBackupCiCalibration(blob.value));
      } catch {
        return invalid("backup CI trust file does not parse");
      }
    }
    const value = backupCiExcludedRunners(suspensions, calibrations, checks);
    this.exclusionMemo = { tip, value };
    return value;
  }

  private async readJson(tip: GitSha, path: string): Promise<Blob> {
    const repository = this.repository as string;
    const listed = await this.git(["ls-tree", tip, "--", path], repository);
    if (!listed.ok) return unavailable("backup CI store tree is unreadable");
    const lines = listed.stdout.split("\n").filter((line) => line.length > 0);
    if (lines.length === 0) return { kind: "absent" };
    const match = /^100644 blob ([0-9a-f]{40})\t(.+)$/.exec(lines[0]);
    if (lines.length !== 1 || match === null || match[2] !== path) {
      return invalid("backup CI store entry is not a regular file");
    }
    return await this.readOid(match[1]);
  }

  private async readOid(oid: string): Promise<Blob> {
    const repository = this.repository as string;
    const memo = this.blobs.get(oid);
    if (memo !== undefined) return memo;
    const size = await this.git(["cat-file", "-s", oid], repository);
    if (!size.ok || !/^[0-9]+$/.test(size.stdout.trim())) {
      return unavailable("backup CI store blob is unreadable");
    }
    if (Number(size.stdout.trim()) > BACKUP_CI_MAX_FILE_BYTES) {
      return this.remember(oid, invalid("backup CI store file is too large"));
    }
    const read = await this.git(["cat-file", "blob", oid], repository, true);
    if (!read.ok) return unavailable("backup CI store blob is unreadable");
    try {
      const text = read.bytes === undefined
        ? read.stdout
        : new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
      return this.remember(oid, { kind: "ok", value: JSON.parse(text) });
    } catch {
      return this.remember(oid, invalid("backup CI store file is not JSON"));
    }
  }

  private remember(oid: string, blob: Blob): Blob {
    if (this.blobs.size < BLOB_MEMO_MAX) this.blobs.set(oid, blob);
    return blob;
  }
}
