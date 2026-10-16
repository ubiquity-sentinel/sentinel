/**
 * The trusted host side of a conflict resolution over real Git: the merge
 * preparation leaves the conflicts of (H, B) in a checkout of H, the merge
 * committer refuses leftover markers and a moved or aborted merge and commits
 * exactly the two-parent merge, and the resolver reads the change set against
 * the merged base and requires a commit descending from H. No network, no
 * model, no credentials.
 */
import assert from "node:assert/strict";
import { prepareMergeCheckout } from "../../src/host/local-checkout.ts";
import {
  LocalMergeCommitter,
  LocalMergeResolver,
} from "../../src/repair/model-port-checkout.ts";
import { buildPrompt } from "../../src/repair/model-port-prompt.ts";
import { REPO } from "../state/helpers.ts";
import {
  type ConflictGitV1,
  makeConflictGit,
} from "./conflict-resolution-rig.ts";

const RESOLVED =
  "export const value = 'candidate';\nexport const upstreamValue = 'upstream';\n";

async function checkoutAt(ctx: ConflictGitV1, name: string) {
  const dir = `${ctx.tmp}/${name}`;
  await ctx.git(["clone", "-q", "--no-checkout", ctx.repo, dir], ctx.tmp);
  await ctx.git(["checkout", "-q", "--detach", ctx.head], dir);
  await Deno.mkdir(`${ctx.tmp}/scratch`, { recursive: true });
  return dir;
}

function prepare(ctx: ConflictGitV1, dir: string) {
  return prepareMergeCheckout({
    checkout: dir,
    head: ctx.head,
    mergeBase: ctx.base,
    sourcePath: ctx.repo,
    stateRoot: ctx.tmp,
    scratch: `${ctx.tmp}/scratch`,
    trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  });
}

Deno.test("conflict checkout: the merge stops with the conflicts of (H, B) left in the tree", async () => {
  const ctx = await makeConflictGit();
  try {
    const dir = await checkoutAt(ctx, "checkout");
    const merged = await prepare(ctx, dir);
    assert.deepEqual(merged, { ok: true, conflictedPaths: ["src/app.ts"] });
    assert.equal(
      (await ctx.git(["rev-parse", "MERGE_HEAD"], dir)).trim(),
      ctx.base,
    );
    assert.equal((await ctx.git(["rev-parse", "HEAD"], dir)).trim(), ctx.head);
    assert.match(await Deno.readTextFile(`${dir}/src/app.ts`), /^<{7} /m);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("conflict checkout: a dirty or moved checkout is never merged", async () => {
  const ctx = await makeConflictGit();
  try {
    const dirty = await checkoutAt(ctx, "dirty");
    await Deno.writeTextFile(`${dirty}/stray.txt`, "pending\n");
    assert.deepEqual(await prepare(ctx, dirty), { ok: false });
    const moved = await checkoutAt(ctx, "moved");
    await ctx.git(["checkout", "-q", "--detach", ctx.b0], moved);
    assert.deepEqual(await prepare(ctx, moved), { ok: false });
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("conflict committer: leftover markers and an aborted merge are refused", async () => {
  const ctx = await makeConflictGit();
  try {
    const dir = await checkoutAt(ctx, "markers");
    const merged = await prepare(ctx, dir);
    assert.ok(merged.ok);
    const planned = {
      head: ctx.head,
      mergeBase: ctx.base,
      conflictedPaths: merged.conflictedPaths,
    };
    const committer = new LocalMergeCommitter(dir, planned);
    assert.equal(await committer.commit(ctx.head), false);
    assert.equal(committer.refusalCode, "conflict_markers");
    assert.equal(await committer.commit(ctx.base), false, "foreign base");
    assert.equal(committer.refusalCode, "merge_identity_mismatch");
    await ctx.git(["merge", "--abort"], dir);
    await Deno.writeTextFile(`${dir}/src/app.ts`, RESOLVED);
    assert.equal(await committer.commit(ctx.head), false);
    assert.equal(committer.refusalCode, "merge_identity_mismatch");
    assert.equal(
      (await ctx.git(["rev-parse", "HEAD"], dir)).trim(),
      ctx.head,
      "nothing was committed",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("conflict committer: a resolved merge commits exactly (H, B) and resolves against B", async () => {
  const ctx = await makeConflictGit();
  try {
    const dir = await checkoutAt(ctx, "resolved");
    const merged = await prepare(ctx, dir);
    assert.ok(merged.ok);
    await Deno.writeTextFile(`${dir}/src/app.ts`, RESOLVED);
    const planned = {
      head: ctx.head,
      mergeBase: ctx.base,
      conflictedPaths: merged.conflictedPaths,
    };
    const committer = new LocalMergeCommitter(dir, planned);
    assert.equal(await committer.commit(ctx.head), true);
    assert.equal(committer.refusalCode, null);
    const head = (await ctx.git(["rev-parse", "HEAD"], dir)).trim();
    const parents =
      (await ctx.git(["rev-list", "--parents", "-n", "1", head], dir))
        .trim().split(" ").slice(1);
    assert.deepEqual(parents, [ctx.head, ctx.base]);
    const resolved = await new LocalMergeResolver(dir, planned).resolve();
    assert.deepEqual(resolved, {
      head,
      checkpointSha: null,
      // The candidate's own change set against the merged base: never the
      // base's history (src/upstream.ts is not listed).
      changedPaths: ["src/app.ts", "src/feature.ts"],
    });
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("conflict resolver: a head that misses the base or is H itself is no candidate", async () => {
  const ctx = await makeConflictGit();
  try {
    const dir = await checkoutAt(ctx, "unmerged");
    const planned = { head: ctx.head, mergeBase: ctx.base };
    assert.equal(await new LocalMergeResolver(dir, planned).resolve(), null);
    await Deno.writeTextFile(`${dir}/src/app.ts`, RESOLVED);
    await ctx.git(["add", "-A"], dir);
    await ctx.git(["commit", "-q", "-m", "no merge"], dir);
    assert.equal(
      await new LocalMergeResolver(dir, planned).resolve(),
      null,
      "a commit that never merged the base is refused",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("conflict prompt: the session is told to resolve the prepared merge, never to commit it", () => {
  const head = "a".repeat(40);
  const base = "b".repeat(40);
  const prompt = buildPrompt({
    taskId: "issue-1" as never,
    repository: REPO,
    base: head as never,
    checkoutBase: head as never,
    mergeBase: base as never,
    issue: { number: 1, title: "issue 1", body: "" },
    evidence: [],
    model: "gpt-reserve",
    reasoning: "max",
    maxDurationMs: 1000,
    maxOutputChars: 1000,
  }, false);
  assert.match(prompt, /Merge conflict resolution: the current checkout/);
  assert.ok(prompt.includes(`updated base revision ${base}`));
  assert.match(prompt, /Do not abort, restart or redo the merge/);
  assert.match(prompt, /Do not run git add, git commit or git push/);
});
