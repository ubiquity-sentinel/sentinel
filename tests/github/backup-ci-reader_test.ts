/**
 * The backup CI store reader (docs/backup-ci-spec.md §7) over a temporary
 * bare "remote" reached through a file URL and the production git runner: the
 * tip is listed anonymously and cached for 10 s on an injected clock, each
 * new tip is fetched once, a missing branch or file reads as nothing, a file
 * that does not parse or binds another path, commit or repository id is
 * `invalid`, a git failure is `unavailable`, files are bounded to 256 KiB,
 * and only listed targets are ever read. All synthetic.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  BACKUP_CI_TIP_TTL_MS,
  backupCiCalibrationPath,
  backupCiCommitPath,
  backupCiSuspensionPath,
} from "../../src/contracts/backup-ci.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import {
  type BackupCiReaderV1,
  createBackupCiReader,
} from "../../src/github/backup-ci-reader.ts";
import { DenoGitRunner, type GitRunnerV1 } from "../../src/state/state-git.ts";
import {
  calibration,
  commitFile,
  H,
  NAME,
  OTHER,
  OWNER,
  REPO_ID,
  result,
  RUNNER2,
  suspension,
  T0,
  TARGET,
} from "./backup-ci-fixtures.ts";

const REPOSITORY: RepositoryIdentityV1 = {
  owner: OWNER,
  name: NAME,
  installationId: 1,
};
const STORE_BRANCH = "refs/heads/sentinel-backup-ci";

async function run(cwd: string, args: string[]): Promise<string> {
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
  }).output();
  if (!out.success) {
    throw new Error(`git ${args[0]}: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

interface Store {
  root: string;
  remote: string;
  /** Commits `files` (path → JSON value or raw text) as the new store tip. */
  publish(files: Record<string, unknown>): Promise<GitSha>;
  close(): Promise<void>;
}

async function store(): Promise<Store> {
  const root = await Deno.makeTempDir({ prefix: "backup-ci-reader-" });
  const remote = `${root}/store.git`;
  await run(root, ["init", "-q", "--bare", remote]);
  const work = `${root}/work`;
  await run(root, ["init", "-q", work]);
  return {
    root,
    remote,
    async publish(files) {
      for (const [path, value] of Object.entries(files)) {
        const target = `${work}/${path}`;
        await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(
          target,
          typeof value === "string" ? value : JSON.stringify(value),
        );
      }
      await run(work, ["add", "-A"]);
      await run(work, ["commit", "-q", "--allow-empty", "-m", "store"]);
      await run(work, ["push", "-q", remote, `HEAD:${STORE_BRANCH}`]);
      return await run(work, ["rev-parse", "HEAD"]) as GitSha;
    },
    close: () => Deno.remove(root, { recursive: true }),
  };
}

/** The production runner, counting each git subcommand it runs. */
function counted(home: string): { runner: GitRunnerV1; calls: string[] } {
  const inner = new DenoGitRunner(home);
  const calls: string[] = [];
  return {
    calls,
    runner: {
      runGit(args, opts) {
        calls.push(
          args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "",
        );
        return inner.runGit(args, opts);
      },
    },
  };
}

function reader(
  s: Store,
  clock: { t: number },
  runner?: GitRunnerV1,
  remoteUrl = `file://${s.remote}`,
): BackupCiReaderV1 {
  return createBackupCiReader({
    git: runner ?? new DenoGitRunner(`${s.root}/home`),
    scratchRoot: `${s.root}/scratch`,
    clock: { now: () => clock.t },
    targets: [TARGET],
    remoteUrl,
  });
}

const FILE_PATH = backupCiCommitPath(OWNER, NAME, H);

Deno.test("an absent branch, or an absent file, reads as nothing", async () => {
  const s = await store();
  try {
    const r = reader(s, { t: T0 });
    assert.deepEqual(await r.read(REPOSITORY, H), {
      kind: "ok",
      file: null,
      suspensions: [],
      calibration: null,
      tip: null,
    });
    const tip = await s.publish({ "README.md": "store\n" });
    const fresh = reader(s, { t: T0 });
    assert.deepEqual(await fresh.read(REPOSITORY, H), {
      kind: "ok",
      file: null,
      suspensions: [],
      calibration: null,
      tip,
    });
  } finally {
    await s.close();
  }
});

Deno.test("the reader returns the commit file, suspensions and calibration", async () => {
  const s = await store();
  try {
    const file = commitFile([result()]);
    const global = suspension({ scope: "all", runnerIds: [RUNNER2] });
    const local = suspension();
    const tip = await s.publish({
      [FILE_PATH]: file,
      [backupCiSuspensionPath()]: global,
      [backupCiSuspensionPath(OWNER, NAME)]: local,
      [backupCiCalibrationPath(OWNER, NAME)]: calibration(),
    });
    const read = await reader(s, { t: T0 }).read(REPOSITORY, H);
    assert.deepEqual(read, {
      kind: "ok",
      file,
      suspensions: [global, local],
      calibration: calibration(),
      tip,
    });
  } finally {
    await s.close();
  }
});

Deno.test("the tip is cached for 10 s and each new tip is fetched once", async () => {
  const s = await store();
  try {
    const first = await s.publish({ [FILE_PATH]: commitFile([]) });
    const clock = { t: T0 };
    const { runner, calls } = counted(`${s.root}/home`);
    const r = reader(s, clock, runner);
    const tipOf = async (sha: GitSha = H) => {
      const read = await r.read(REPOSITORY, sha);
      assert.equal(read.kind, "ok");
      return read.kind === "ok" ? read.tip : null;
    };
    assert.equal(await tipOf(), first);
    assert.equal(await tipOf(OTHER), first);
    const second = await s.publish({ [FILE_PATH]: commitFile([result()]) });
    clock.t = T0 + BACKUP_CI_TIP_TTL_MS - 1;
    assert.equal(await tipOf(), first);
    assert.equal(calls.filter((c) => c === "ls-remote").length, 1);
    assert.equal(calls.filter((c) => c === "fetch").length, 1);
    clock.t = T0 + BACKUP_CI_TIP_TTL_MS;
    const read = await r.read(REPOSITORY, H);
    assert.ok(read.kind === "ok");
    assert.equal(read.tip, second);
    assert.equal(read.file?.entries.length, 1);
    // The same tip again after the TTL lists once more and fetches nothing.
    clock.t = T0 + 2 * BACKUP_CI_TIP_TTL_MS;
    assert.equal(await tipOf(), second);
    assert.equal(calls.filter((c) => c === "ls-remote").length, 3);
    assert.equal(calls.filter((c) => c === "fetch").length, 2);
  } finally {
    await s.close();
  }
});

Deno.test("a file that does not parse or bind its path is invalid", async () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["malformed", { [FILE_PATH]: "{not json" }, "not JSON"],
    ["unknown key", { [FILE_PATH]: { ...commitFile([]), extra: 1 } }, "parse"],
    [
      "other commit",
      { [FILE_PATH]: commitFile([], { commit: OTHER }) },
      "commit file",
    ],
    [
      "other id",
      {
        [FILE_PATH]: commitFile([], {
          repository: { owner: OWNER, name: NAME, id: REPO_ID + 1 },
        }),
      },
      "commit file",
    ],
    [
      "global suspension scoped to a target",
      { [backupCiSuspensionPath()]: suspension() },
      "suspension",
    ],
    [
      "target suspension scoped to all",
      { [backupCiSuspensionPath(OWNER, NAME)]: suspension({ scope: "all" }) },
      "suspension",
    ],
    [
      "other calibration id",
      {
        [backupCiCalibrationPath(OWNER, NAME)]: {
          ...calibration(),
          repository: { owner: OWNER, name: NAME, id: 1 },
        },
      },
      "calibration",
    ],
    [
      "a directory at the file path",
      { [`${FILE_PATH}/x.json`]: commitFile([]) },
      "regular file",
    ],
    [
      "over 256 KiB",
      { [FILE_PATH]: JSON.stringify({ pad: "x".repeat(256 * 1024) }) },
      "too large",
    ],
  ];
  for (const [label, files, detail] of cases) {
    const s = await store();
    try {
      await s.publish(files);
      const read = await reader(s, { t: T0 }).read(REPOSITORY, H);
      assert.equal(read.kind, "invalid", label);
      assert.ok(read.kind === "invalid");
      assert.match(read.detail, new RegExp(detail), label);
    } finally {
      await s.close();
    }
  }
});

Deno.test("a git failure is unavailable and never cached", async () => {
  const s = await store();
  try {
    await s.publish({ [FILE_PATH]: commitFile([]) });
    const missing = reader(
      s,
      { t: T0 },
      undefined,
      `file://${s.root}/none.git`,
    );
    const read = await missing.read(REPOSITORY, H);
    assert.equal(read.kind, "unavailable");
    let fail = true;
    const inner = new DenoGitRunner(`${s.root}/home`);
    const flaky: GitRunnerV1 = {
      runGit(args, opts) {
        if (fail) return Promise.reject(new Error("spawn failed"));
        return inner.runGit(args, opts);
      },
    };
    const r = reader(s, { t: T0 }, flaky);
    assert.equal((await r.read(REPOSITORY, H)).kind, "unavailable");
    fail = false;
    assert.equal((await r.read(REPOSITORY, H)).kind, "ok");
  } finally {
    await s.close();
  }
});

Deno.test("only listed targets are ever read", async () => {
  const s = await store();
  try {
    await s.publish({ [FILE_PATH]: commitFile([]) });
    const { runner, calls } = counted(`${s.root}/home`);
    const r = reader(s, { t: T0 }, runner);
    const unlisted = {
      owner: "ubiquity",
      name: "ai.ubq.fi",
      installationId: 1,
    };
    assert.equal(r.target(unlisted), null);
    assert.deepEqual(r.target(REPOSITORY), TARGET);
    assert.equal((await r.read(unlisted, H)).kind, "unavailable");
    // A malformed commit never reaches git either.
    assert.equal((await r.read(REPOSITORY, "--all" as GitSha)).kind, "invalid");
    assert.deepEqual(calls, []);
    // Concurrent reads are serialized onto one fetch.
    const reads = await Promise.all([
      r.read(REPOSITORY, H),
      r.read(REPOSITORY, OTHER),
    ]);
    assert.deepEqual(reads.map((x) => x.kind), ["ok", "ok"]);
    assert.equal(calls.filter((c) => c === "fetch").length, 1);
  } finally {
    await s.close();
  }
});
