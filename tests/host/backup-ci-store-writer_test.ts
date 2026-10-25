/**
 * The backup CI store writer (docs/backup-ci-spec.md §7) against a
 * temporary bare "remote" reached through a file URL: the first write is an
 * orphan commit with a README; one commit batches every touched file; an
 * unchanged write commits nothing; the push is fast-forward only, so a
 * concurrent writer's tip move rejects it and the writer re-reads and
 * re-applies its (pure) mutation; after five rejections it fails. The view
 * finds files holding dispatched entries with `git grep`. Synthetic.
 */
import assert from "node:assert/strict";
import { BACKUP_CI_STORE_REF } from "../../src/contracts/backup-ci.ts";
import {
  type BackupCiGitV1,
  createBackupCiGit,
} from "../../ops/backup-ci-materialize.ts";
import {
  BACKUP_CI_STORE_ATTEMPTS,
  backupCiStoreBytes,
  openBackupCiStore,
  writeBackupCiStore,
} from "../../ops/backup-ci-store-writer.ts";
import { fixtureGit, testDir } from "./backup-ci-test-repo.ts";

const NOW = Date.parse("2026-10-25T08:00:00Z");

async function remote() {
  const root = await testDir("backup-ci-store-");
  const bare = `${root}/store.git`;
  await fixtureGit(root, ["init", "-q", "--bare", bare]);
  return { root, url: `file://${bare}`, bare };
}

/** A concurrent writer: commits `path` on top of the remote tip. */
async function concurrent(root: string, url: string, path: string, n: number) {
  const work = `${root}/other-${n}`;
  await fixtureGit(root, ["clone", "-q", url, work]).catch(async () => {
    await fixtureGit(root, ["init", "-q", work]);
  });
  await fixtureGit(work, [
    "fetch",
    "-q",
    url,
    `+${BACKUP_CI_STORE_REF}:refs/remotes/tip`,
  ])
    .then(() =>
      fixtureGit(work, ["checkout", "-q", "--detach", "refs/remotes/tip"])
    )
    .catch(() => undefined);
  await Deno.mkdir(`${work}/${path.slice(0, path.lastIndexOf("/"))}`, {
    recursive: true,
  });
  await Deno.writeTextFile(`${work}/${path}`, `{"n":${n}}\n`);
  await fixtureGit(work, ["add", "-A"]);
  await fixtureGit(work, ["commit", "-q", "-m", `other ${n}`]);
  await fixtureGit(work, ["push", "-q", url, `HEAD:${BACKUP_CI_STORE_REF}`]);
}

function input(r: { root: string; url: string }, git: BackupCiGitV1) {
  return {
    git,
    scratch: `${r.root}/scratch`,
    remote: r.url,
    protocols: ["file"],
    runId: 4242,
    now: () => NOW,
  };
}

Deno.test("the first write is an orphan commit batching every file", async () => {
  const r = await remote();
  try {
    const git = createBackupCiGit(`${r.root}/home`);
    const lines: string[] = [];
    const out = await writeBackupCiStore({
      ...input(r, git),
      log: (l) => lines.push(l),
      mutate: (view) => {
        assert.equal(view.tip, null);
        return Promise.resolve(
          new Map<string, unknown>([
            ["v1/o/r/aa/a.json", { b: 1, a: 2 }],
            ["v1/o/r/calibration.json", { x: true }],
          ]),
        );
      },
    });
    assert(out.kind === "committed");
    assert.equal(out.parent, null);
    assert.equal(out.attempts, 1);
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [{
      kind: "sentinel_backup_ci_store_commit",
      commit: out.commit,
      parent: null,
    }]);
    const files = await fixtureGit(r.bare, [
      "ls-tree",
      "-r",
      "--name-only",
      out.commit,
    ]);
    assert.deepEqual(files.split("\n"), [
      "README.md",
      "v1/o/r/aa/a.json",
      "v1/o/r/calibration.json",
    ]);
    assert.equal(
      await fixtureGit(r.bare, ["show", `${out.commit}:v1/o/r/aa/a.json`]),
      '{"a":2,"b":1}',
    );
    assert.equal(
      await fixtureGit(r.bare, ["log", "-1", "--format=%s", out.commit]),
      "sentinel-backup-ci: run 4242 attempt 1",
    );
    const view = await openBackupCiStore(input(r, git));
    assert.equal(view.tip, out.commit);
    assert.deepEqual(await view.read("v1/o/r/aa/a.json"), { a: 2, b: 1 });
    assert.equal(await view.read("v1/o/r/bb/none.json"), null);
    assert.deepEqual(
      await view.readBytes("v1/o/r/aa/a.json"),
      backupCiStoreBytes({ a: 2, b: 1 }),
    );
    // Writing the same content again commits nothing.
    const again = await writeBackupCiStore({
      ...input(r, git),
      mutate: () =>
        Promise.resolve(new Map([["v1/o/r/aa/a.json", { a: 2, b: 1 }]])),
    });
    assert.deepEqual(again, { kind: "unchanged", tip: out.commit });
    // A deletion is a change; an invalid path is refused.
    const removed = await writeBackupCiStore({
      ...input(r, git),
      mutate: () =>
        Promise.resolve(new Map([["v1/o/r/calibration.json", null]])),
    });
    assert(removed.kind === "committed" && removed.parent === out.commit);
    const invalid = await writeBackupCiStore({
      ...input(r, git),
      mutate: () => Promise.resolve(new Map([["../escape.json", {}]])),
    });
    assert.equal(invalid.kind, "failed");
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("a moved tip rejects the push; the writer re-reads and retries", async () => {
  const r = await remote();
  try {
    const inner = createBackupCiGit(`${r.root}/home`);
    let pushes = 0;
    const git: BackupCiGitV1 = {
      async runGit(args, opts) {
        if (args.includes("push") && pushes++ === 0) {
          await concurrent(r.root, r.url, "v1/o/r/cc/other.json", 1);
        }
        return inner.runGit(args, opts);
      },
    };
    let calls = 0;
    const out = await writeBackupCiStore({
      ...input(r, git),
      mutate: async (view) => {
        calls++;
        const current = await view.read("v1/o/r/aa/a.json") as
          | { n?: number }
          | null;
        return new Map([["v1/o/r/aa/a.json", { n: (current?.n ?? 0) + 1 }]]);
      },
    });
    assert(out.kind === "committed");
    assert.equal(out.attempts, 2);
    assert.equal(calls, 2);
    const files = await fixtureGit(r.bare, [
      "ls-tree",
      "-r",
      "--name-only",
      out.commit,
    ]);
    assert(
      files.includes("v1/o/r/cc/other.json") &&
        files.includes("v1/o/r/aa/a.json"),
    );
    assert.equal(
      await fixtureGit(r.bare, ["rev-parse", `${out.commit}^`]),
      await fixtureGit(r.bare, ["rev-parse", `${BACKUP_CI_STORE_REF}^`]),
    );
    assert.equal(
      await fixtureGit(r.bare, ["rev-parse", BACKUP_CI_STORE_REF]),
      out.commit,
    );
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("five rejected pushes fail without forcing", async () => {
  const r = await remote();
  try {
    const inner = createBackupCiGit(`${r.root}/home`);
    let n = 0;
    const git: BackupCiGitV1 = {
      async runGit(args, opts) {
        if (args.includes("push")) {
          assert(
            !args.some((a) =>
              a === "-f" || a === "--force" || a.startsWith("+")
            ),
          );
          await concurrent(r.root, r.url, `v1/o/r/dd/x${n}.json`, n++);
        }
        return inner.runGit(args, opts);
      },
    };
    const out = await writeBackupCiStore({
      ...input(r, git),
      mutate: () => Promise.resolve(new Map([["v1/o/r/aa/a.json", { a: 1 }]])),
    });
    assert.deepEqual(out, { kind: "failed", detail: "store push rejected" });
    assert.equal(n, BACKUP_CI_STORE_ATTEMPTS);
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});

Deno.test("the view finds the files holding dispatched entries", async () => {
  const r = await remote();
  try {
    const git = createBackupCiGit(`${r.root}/home`);
    await writeBackupCiStore({
      ...input(r, git),
      mutate: () =>
        Promise.resolve(
          new Map<string, unknown>([
            ["v1/o/r/aa/a.json", { entries: [{ state: "dispatched" }] }],
            ["v1/o/r/bb/b.json", { entries: [{ state: "result" }] }],
            ["v1/o/s/cc/c.json", { entries: [{ state: "dispatched" }] }],
          ]),
        ),
    });
    const view = await openBackupCiStore(input(r, git));
    assert.deepEqual(
      await view.pathsContaining('"state":"dispatched"', "v1/o/r/"),
      ["v1/o/r/aa/a.json"],
    );
    assert.deepEqual(
      await view.pathsContaining('"state":"none"', "v1/o/r/"),
      [],
    );
  } finally {
    await Deno.remove(r.root, { recursive: true });
  }
});
