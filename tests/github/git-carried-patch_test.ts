/**
 * Carried-review patch proof (owner decision 2026-10-16 (2), the
 * coordinator's option (b)) over REAL temporary Git repositories and the REAL
 * DenoGitExecutor: the reviewed head H0 on its reviewed base B0 carries its
 * review to the refreshed head H1 on the moved tip T only when the
 * merge-base patches `git diff B0...H0` and `git diff T...H1` are the same
 * bytes. No network, no credentials, no ref or index update.
 */
import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import {
  carriedPatchHolds,
  type CarriedPatchRequestV1,
} from "../../src/contracts/ports.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";

const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/github\/git-carried-patch_test\.ts$/,
  "",
);
const TRUSTED_PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";

interface Repo {
  tmp: string;
  dir: string;
  env: Record<string, string>;
  git(args: string[]): Promise<{ ok: boolean; stdout: string }>;
  commit(files: Record<string, string | Uint8Array | null>): Promise<GitSha>;
  executor(): DenoGitExecutor;
  cleanup(): Promise<void>;
}

async function makeRepo(): Promise<Repo> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-carried-patch-",
    dir: ROOT,
  });
  const env = {
    PATH: TRUSTED_PATH,
    HOME: `${tmp}/home`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "sentinel-carried-patch-test",
    GIT_AUTHOR_EMAIL: "sentinel-carried-patch-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-carried-patch-test",
    GIT_COMMITTER_EMAIL: "sentinel-carried-patch-test@localhost",
  };
  await Deno.mkdir(`${tmp}/home`, { recursive: true });
  const dir = `${tmp}/repo`;
  const git = async (args: string[]) => {
    const result = await new Deno.Command("git", {
      args,
      cwd: dir,
      clearEnv: true,
      env,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      ok: result.success,
      stdout: new TextDecoder().decode(result.stdout),
    };
  };
  await Deno.mkdir(dir, { recursive: true });
  assert.ok((await git(["init", "-q", "-b", "development"])).ok);
  const commit = async (files: Record<string, string | Uint8Array | null>) => {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) {
        await Deno.remove(`${dir}/${name}`);
      } else if (typeof content === "string") {
        await Deno.writeTextFile(`${dir}/${name}`, content);
      } else {
        await Deno.writeFile(`${dir}/${name}`, content);
      }
    }
    assert.ok((await git(["add", "-A"])).ok);
    assert.ok((await git(["commit", "-q", "--allow-empty", "-m", "c"])).ok);
    return (await git(["rev-parse", "HEAD"])).stdout.trim() as GitSha;
  };
  return {
    tmp,
    dir,
    env,
    git,
    commit,
    executor: () =>
      new DenoGitExecutor({
        localDir: dir,
        remoteUrl: `file://${dir}`,
        gitHome: `${tmp}/home`,
      }),
    cleanup: () => Deno.remove(tmp, { recursive: true }).catch(() => {}),
  };
}

const LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join("");
const BINARY_OLD = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80, 0, 3]);
const BINARY_NEW = new Uint8Array([0, 1, 2, 0xff, 0xfd, 0x81, 0, 3, 4]);

/** B0, the reviewed head H0 on it, and a base move T that leaves H0's paths. */
async function reviewedPair(repo: Repo) {
  const b0 = await repo.commit({
    "a.txt": LINES,
    "bin.dat": BINARY_OLD,
    "run.sh": "echo run\n",
    "old.txt": "moved\n",
  });
  assert.ok((await repo.git(["checkout", "-q", "-b", "candidate"])).ok);
  // Text edit, binary edit, mode change and a rename in one patch.
  await Deno.chmod(`${repo.dir}/run.sh`, 0o755);
  const h0 = await repo.commit({
    "a.txt": LINES.replace("line 1\n", "line one\n"),
    "bin.dat": BINARY_NEW,
    "old.txt": null,
    "new.txt": "moved\n",
  });
  assert.ok((await repo.git(["checkout", "-q", "development"])).ok);
  const t = await repo.commit({ "other.txt": "unrelated base change\n" });
  return { b0, h0, t };
}

function request(
  b0: GitSha,
  h0: GitSha,
  t: GitSha,
  h1: GitSha,
): CarriedPatchRequestV1 {
  return { reviewedBase: b0, reviewedHead: h0, base: t, head: h1 };
}

Deno.test("carried patch: the runtime's mechanical refresh of a reviewed head carries the exact reviewed patch (text, binary, mode, rename)", async () => {
  const repo = await makeRepo();
  try {
    const { b0, h0, t } = await reviewedPair(repo);
    const git = repo.executor();
    const refreshed = await git.integrateBase(h0, t);
    assert.ok(refreshed.ok, JSON.stringify(refreshed));
    const h1 = refreshed.value;
    const refsBefore = (await repo.git(["show-ref"])).stdout;
    const statusBefore = (await repo.git(["status", "--porcelain"])).stdout;
    const proof = await git.carriedPatchProof(request(b0, h0, t, h1));
    assert.ok(proof.ok, JSON.stringify(proof));
    assert.equal(proof.value.reviewedMergeBase, b0);
    assert.equal(proof.value.refreshedMergeBase, t);
    assert.match(proof.value.reviewedPatch, /^[0-9a-f]{64}$/);
    assert.equal(proof.value.refreshedPatch, proof.value.reviewedPatch);
    assert.equal(carriedPatchHolds(request(b0, h0, t, h1), proof.value), true);
    // The digest is SHA-256 of the exact `git diff --raw --no-abbrev -z
    // --no-renames B0...H0` listing (length-prefixed) and then the exact
    // `git diff --binary --full-index --no-renames B0...H0` bytes (#156).
    const diff = async (args: string[]) =>
      (await new Deno.Command("git", {
        args: ["diff", ...args, b0, h0, "--"],
        cwd: repo.dir,
        clearEnv: true,
        env: repo.env,
        stdout: "piped",
        stderr: "null",
      }).output()).stdout;
    const listing = await diff([
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--raw",
      "--no-abbrev",
      "-z",
      "--no-renames",
      "--ignore-submodules=none",
    ]);
    const patchBytes = await diff([
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--binary",
      "--full-index",
      "--no-renames",
      "--ignore-submodules=none",
      "--submodule=short",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--diff-algorithm=myers",
    ]);
    // Every changed path of the reviewed patch is on the listing, the
    // mode-only one included.
    assert.match(
      new TextDecoder().decode(listing),
      /:100644 100755 [0-9a-f]{40} [0-9a-f]{40} M\0run\.sh\0/,
    );
    const header = new TextEncoder().encode(`${listing.byteLength}\n`);
    const framed = new Uint8Array([...header, ...listing, ...patchBytes]);
    const expected = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", framed)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    assert.equal(proof.value.reviewedPatch, expected);
    // Read only: no ref, index or worktree change.
    assert.equal((await repo.git(["show-ref"])).stdout, refsBefore);
    assert.equal(
      (await repo.git(["status", "--porcelain"])).stdout,
      statusBefore,
    );
    // The reviewed head itself is never a carried head.
    assert.equal(
      carriedPatchHolds(request(b0, h0, t, h0), {
        ...proof.value,
        refreshedMergeBase: t,
      }),
      false,
    );
  } finally {
    await repo.cleanup();
  }
});

Deno.test("carried patch: the proof names the head each refresh was made from and counts the refreshes the patch was carried through", async () => {
  const repo = await makeRepo();
  try {
    const { b0, h0, t } = await reviewedPair(repo);
    const git = repo.executor();
    const first = await git.integrateBase(h0, t);
    assert.ok(first.ok, JSON.stringify(first));
    const h1 = first.value;
    const once = await git.carriedPatchProof(request(b0, h0, t, h1));
    assert.ok(once.ok, JSON.stringify(once));
    assert.equal(once.value.refreshedFrom, h0, "H1 was refreshed from H0");
    assert.equal(once.value.refreshes, 1);
    // The base moves again: the second refresh is made from H1.
    const t2 = await repo.commit({ "third.txt": "another base change\n" });
    const second = await git.integrateBase(h1, t2);
    assert.ok(second.ok, JSON.stringify(second));
    const h2 = second.value;
    const twice = await git.carriedPatchProof(request(b0, h0, t2, h2));
    assert.ok(twice.ok, JSON.stringify(twice));
    assert.equal(twice.value.refreshedFrom, h1, "H2 was refreshed from H1");
    assert.equal(twice.value.refreshes, 2);
    assert.equal(twice.value.refreshedPatch, twice.value.reviewedPatch);
    assert.equal(carriedPatchHolds(request(b0, h0, t2, h2), twice.value), true);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("carried patch: a base move that touches a reviewed path changes the patch even when every hunk merges cleanly", async () => {
  const repo = await makeRepo();
  try {
    const b0 = await repo.commit({ "a.txt": LINES });
    assert.ok((await repo.git(["checkout", "-q", "-b", "candidate"])).ok);
    const h0 = await repo.commit({
      "a.txt": LINES.replace("line 1\n", "line one\n"),
    });
    assert.ok((await repo.git(["checkout", "-q", "development"])).ok);
    // Far from the reviewed hunk: the merge is clean and the hunk text is the
    // same, but the reviewed file's old content is not the reviewed one.
    const t = await repo.commit({
      "a.txt": LINES.replace("line 30\n", "line thirty\n"),
    });
    const git = repo.executor();
    const refreshed = await git.integrateBase(h0, t);
    assert.ok(refreshed.ok, JSON.stringify(refreshed));
    const proof = await git.carriedPatchProof(
      request(b0, h0, t, refreshed.value),
    );
    assert.ok(proof.ok, JSON.stringify(proof));
    assert.notEqual(proof.value.refreshedPatch, proof.value.reviewedPatch);
    assert.equal(
      carriedPatchHolds(request(b0, h0, t, refreshed.value), proof.value),
      false,
    );
  } finally {
    await repo.cleanup();
  }
});

Deno.test("carried patch: a mode-only change binds the content it applies to (#156)", async () => {
  const repo = await makeRepo();
  try {
    const b0 = await repo.commit({ "s.sh": "echo one\n", "a.txt": LINES });
    assert.ok((await repo.git(["checkout", "-q", "-b", "candidate"])).ok);
    await Deno.chmod(`${repo.dir}/s.sh`, 0o755);
    const h0 = await repo.commit({});
    assert.ok((await repo.git(["checkout", "-q", "development"])).ok);
    // The base changes the content the reviewed mode change applies to; the
    // refresh merges cleanly (the mode from the head, the content from T).
    const t = await repo.commit({ "s.sh": "echo two\n" });
    const git = repo.executor();
    const refreshed = await git.integrateBase(h0, t);
    assert.ok(refreshed.ok, JSON.stringify(refreshed));
    const h1 = refreshed.value;
    // Both merge-base patches are the same bytes: a mode-only change prints
    // no index line, so the patch alone binds no blob of that path.
    const patch = async (from: GitSha, to: GitSha) =>
      (await repo.git([
        "diff",
        "--binary",
        "--full-index",
        "--no-renames",
        from,
        to,
      ])).stdout;
    assert.equal(await patch(b0, h0), await patch(t, h1));
    assert.match(await patch(b0, h0), /^old mode 100644\nnew mode 100755$/m);
    const proof = await git.carriedPatchProof(request(b0, h0, t, h1));
    assert.ok(proof.ok, JSON.stringify(proof));
    assert.equal(proof.value.refreshedMergeBase, t);
    assert.notEqual(proof.value.refreshedPatch, proof.value.reviewedPatch);
    assert.equal(carriedPatchHolds(request(b0, h0, t, h1), proof.value), false);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("carried patch: a refreshed head with any change beyond the base merge does not carry the review", async () => {
  const repo = await makeRepo();
  try {
    const { b0, h0, t } = await reviewedPair(repo);
    const git = repo.executor();
    const refreshed = await git.integrateBase(h0, t);
    assert.ok(refreshed.ok, JSON.stringify(refreshed));
    assert.ok(
      (await repo.git(["checkout", "-q", "-b", "extra", refreshed.value])).ok,
    );
    const extra = await repo.commit({ "new.txt": "moved and changed\n" });
    const proof = await git.carriedPatchProof(request(b0, h0, t, extra));
    assert.ok(proof.ok, JSON.stringify(proof));
    assert.notEqual(proof.value.refreshedPatch, proof.value.reviewedPatch);
    assert.equal(
      carriedPatchHolds(request(b0, h0, t, extra), proof.value),
      false,
    );
    // A head that does not contain the claimed base is no proof either.
    const stale = await git.carriedPatchProof(request(b0, h0, t, h0));
    assert.ok(stale.ok, JSON.stringify(stale));
    assert.equal(stale.value.refreshedMergeBase, b0);
    assert.equal(carriedPatchHolds(request(b0, h0, t, h0), stale.value), false);
  } finally {
    await repo.cleanup();
  }
});

Deno.test("carried patch: a criss-cross history or a missing commit is a typed failure, never a proof", async () => {
  const repo = await makeRepo();
  try {
    const root = await repo.commit({ "a.txt": "root\n" });
    assert.ok((await repo.git(["checkout", "-q", "-b", "p"])).ok);
    const p1 = await repo.commit({ "p.txt": "p\n" });
    assert.ok((await repo.git(["checkout", "-q", "-b", "q", root])).ok);
    const q1 = await repo.commit({ "q.txt": "q\n" });
    assert.ok((await repo.git(["checkout", "-q", "p"])).ok);
    assert.ok((await repo.git(["merge", "-q", "--no-ff", "--no-edit", q1])).ok);
    const p2 = (await repo.git(["rev-parse", "HEAD"])).stdout.trim() as GitSha;
    assert.ok((await repo.git(["checkout", "-q", "q"])).ok);
    assert.ok((await repo.git(["merge", "-q", "--no-ff", "--no-edit", p1])).ok);
    const q2 = (await repo.git(["rev-parse", "HEAD"])).stdout.trim() as GitSha;
    const bases = (await repo.git(["merge-base", "--all", p2, q2])).stdout
      .trim().split("\n");
    assert.equal(bases.length, 2, "the fixture is criss-cross");
    const git = repo.executor();
    const crossed = await git.carriedPatchProof(request(q2, p2, root, p1));
    assert.equal(crossed.ok, false);
    assert.equal(!crossed.ok && crossed.error.kind, "conflict");
    const missing = await git.carriedPatchProof(
      request(
        root,
        p1,
        root,
        "0123456789abcdef0123456789abcdef01234567" as GitSha,
      ),
    );
    assert.equal(missing.ok, false);
    assert.equal(!missing.ok && missing.error.kind, "unavailable");
    const invalid = await git.carriedPatchProof(
      request(root, p1, root, "not-a-sha" as GitSha),
    );
    assert.equal(!invalid.ok && invalid.error.kind, "invalid");
  } finally {
    await repo.cleanup();
  }
});
