/**
 * Synthetic, sanitized GitHub wire values and a fake store reader for the
 * backup CI consumers (docs/backup-ci-spec.md §11.2, §11.4, §11.7): a
 * Passport-shaped target whose one `deno` check of `ci.yml` never started
 * (completed `failure`, no step, no runner) on a push and a pull request
 * suite. Nothing here comes from a live system.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  BackupCiCalibrationV1,
  BackupCiCommitFileV1,
  BackupCiModeV1,
  BackupCiSuspensionV1,
  BackupCiTargetV1,
} from "../../src/contracts/backup-ci.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type {
  BackupCiReaderV1,
  BackupCiReadV1,
} from "../../src/github/backup-ci-reader.ts";
import {
  type BackupCiConsumerV1,
  createBackupCiLog,
} from "../../src/github/backup-ci-observations.ts";
import {
  calibration,
  CHECK,
  H,
  NAME,
  OWNER,
  TARGET,
  WORKFLOW,
} from "./backup-ci-fixtures.ts";

export const REPOSITORY: RepositoryIdentityV1 = {
  owner: OWNER,
  name: NAME,
  installationId: 7,
};
export const SCOPE = `/repos/${OWNER}/${NAME}`;
export const ACTIONS = { id: 15368, slug: "github-actions" };
export const PUSH_SUITE = 31;
export const PR_SUITE = 32;
/** The latest (never-started) check run of `deno` in the push suite. */
export const RUN = 120993841213;
/** An earlier attempt of the same job (hidden by the default listing). */
export const EARLIER = RUN - 7;

/** A raw check run of `head` (default: H, the never-started `deno`). */
export function rawRun(
  id: number,
  over: Record<string, unknown> = {},
  head: GitSha = H,
): Record<string, unknown> {
  return {
    id,
    name: CHECK,
    head_sha: head,
    status: "completed",
    conclusion: "failure",
    started_at: "2026-10-25T08:00:00Z",
    completed_at: "2026-10-25T08:00:01Z",
    app: ACTIONS,
    check_suite: { id: PUSH_SUITE },
    ...over,
  };
}

/** The job body of a check run GitHub never started (billing stop). */
export function neverStartedJob(id: number, head: GitSha = H) {
  return {
    id,
    run_id: 40134771282,
    head_sha: head,
    name: CHECK,
    status: "completed",
    conclusion: "failure",
    steps: [],
    runner_id: 0,
    runner_name: "",
  };
}

/** The job body of a check run that ran (a step and a runner). */
export function startedJob(id: number, head: GitSha = H) {
  return {
    ...neverStartedJob(id, head),
    steps: [{ number: 1, name: "test", status: "completed" }],
    runner_id: 4,
    runner_name: "GitHub Actions 4",
  };
}

/** The workflow run of one check suite (the suite → path/event map). */
export function workflowRun(
  suiteId: number,
  event: string,
  over: Record<string, unknown> = {},
  head: GitSha = H,
): Record<string, unknown> {
  return {
    id: 40000 + suiteId,
    check_suite_id: suiteId,
    path: WORKFLOW,
    event,
    head_sha: head,
    run_attempt: 2,
    status: "completed",
    conclusion: "failure",
    ...over,
  };
}

/** One `ok` store read. */
export function okRead(
  file: BackupCiCommitFileV1 | null,
  over: {
    suspensions?: BackupCiSuspensionV1[];
    calibration?: BackupCiCalibrationV1 | null;
  } = {},
): BackupCiReadV1 {
  return {
    kind: "ok",
    file,
    suspensions: over.suspensions ?? [],
    calibration: over.calibration === undefined
      ? calibration()
      : over.calibration,
    tip: "e".repeat(40) as GitSha,
  };
}

/** A store reader answering from `answer` per commit, counting reads. */
export class FakeBackupCiReader implements BackupCiReaderV1 {
  reads: string[] = [];
  readonly targets: readonly BackupCiTargetV1[];

  constructor(
    public answer: (sha: GitSha) => BackupCiReadV1,
    targets: readonly BackupCiTargetV1[] = [TARGET],
  ) {
    this.targets = targets;
  }

  target(repo: RepositoryIdentityV1): BackupCiTargetV1 | null {
    const name = `${repo.owner}/${repo.name}`;
    return this.targets.find((target) => target.repository === name) ?? null;
  }

  read(repo: RepositoryIdentityV1, sha: GitSha): Promise<BackupCiReadV1> {
    this.reads.push(`${repo.owner}/${repo.name}@${sha}`);
    return Promise.resolve(this.answer(sha));
  }
}

/** A temporary bare store remote and a work tree that publishes its tip. */
export interface TempStoreV1 {
  root: string;
  url: string;
  /** Commits `files` (path → JSON value) as the new store tip. */
  publish(files: Record<string, unknown>): Promise<void>;
  close(): Promise<void>;
}

async function fixtureGit(cwd: string, args: string[]): Promise<void> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(`git ${args[0]}: ${new TextDecoder().decode(out.stderr)}`);
  }
}

export async function tempStore(): Promise<TempStoreV1> {
  const root = await Deno.makeTempDir({ prefix: "backup-ci-consumer-" });
  const remote = `${root}/store.git`;
  const work = `${root}/work`;
  await fixtureGit(root, ["init", "-q", "--bare", remote]);
  await fixtureGit(root, ["init", "-q", work]);
  return {
    root,
    url: `file://${remote}`,
    async publish(files) {
      for (const [path, value] of Object.entries(files)) {
        const target = `${work}/${path}`;
        await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(target, JSON.stringify(value));
      }
      await fixtureGit(work, ["add", "-A"]);
      await fixtureGit(work, ["commit", "-q", "--allow-empty", "-m", "store"]);
      await fixtureGit(work, [
        "push",
        "-q",
        remote,
        "HEAD:refs/heads/sentinel-backup-ci",
      ]);
    },
    close: () => Deno.remove(root, { recursive: true }),
  };
}

/** A consumer over `reader` with a capturing log. */
export function consumer(
  mode: BackupCiModeV1,
  reader: BackupCiReaderV1,
): { backupCi: BackupCiConsumerV1; lines: string[] } {
  const lines: string[] = [];
  return {
    backupCi: {
      mode,
      reader,
      log: createBackupCiLog((line) => lines.push(line)),
    },
    lines,
  };
}
