import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { runTrustedGitResult } from "./local-git.ts";
import {
  ensurePrivateDir,
  joinPath,
  pathExists,
  writePrivateFile,
} from "./local-io.ts";

/** Stable private checkout key of one task (SHA-256 hex). */
export async function localCheckoutKey(taskId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(taskId),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Create the one-time checkout at the exact base; reuse is exact-match only. */
export async function ensureTaskCheckout(input: {
  taskId: string;
  base: GitSha;
  key: string;
  stateRoot: string;
  sourcePath: string;
  scratch: string;
  trustedPath: string;
}): Promise<
  { ok: true; checkout: string; commitBase: GitSha } | { ok: false }
> {
  const checkoutsDir = joinPath(input.stateRoot, "checkouts");
  const checkout = joinPath(checkoutsDir, input.key);
  const mappingPath = joinPath(checkoutsDir, `${input.key}.json`);
  if (await pathExists(checkout)) {
    const mapping = await readCheckoutMapping(mappingPath);
    if (mapping === null || mapping.taskId !== input.taskId) {
      return { ok: false };
    }
    if (mapping.base !== input.base) {
      // Only the durable base advanced (queued issue work): reuse this exact
      // checkout with a clean, verified movement instead of refusing the work.
      // Any other divergence (saved candidate head, dirty worktree, non-ancestor
      // base) is refused without touching the checkout or the mapping.
      const advanced = await advanceTaskCheckout({
        checkout,
        mappingPath,
        mapped: mapping,
        base: input.base,
        key: input.key,
        sourcePath: input.sourcePath,
        stateRoot: input.stateRoot,
        scratch: input.scratch,
        trustedPath: input.trustedPath,
      });
      if (!advanced) return { ok: false };
    }
  } else {
    if (await pathExists(mappingPath)) return { ok: false };
    await ensurePrivateDir(checkoutsDir);
    const cloned = await runTrustedGitResult({
      args: [
        "clone",
        "--no-hardlinks",
        "--no-checkout",
        input.sourcePath,
        checkout,
      ],
      cwd: input.stateRoot,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    });
    if (cloned.code !== 0) return { ok: false };
    const fetched = await runTrustedGitResult({
      args: [
        "-C",
        checkout,
        "fetch",
        "--no-tags",
        input.sourcePath,
        "+refs/sentinel/candidates/*:refs/sentinel/candidates/*",
      ],
      cwd: input.stateRoot,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    });
    if (fetched.code !== 0) return { ok: false };
    const detached = await runTrustedGitResult({
      args: [
        "-C",
        checkout,
        "-c",
        "advice.detachedHead=false",
        "checkout",
        "--detach",
        input.base,
      ],
      cwd: input.stateRoot,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    });
    if (detached.code !== 0) return { ok: false };
    await writePrivateFile(
      mappingPath,
      JSON.stringify({
        version: "v1",
        kind: "local_checkout",
        taskId: input.taskId,
        base: input.base,
        key: input.key,
      }) + "\n",
    );
  }

  const headRead = await runTrustedGitResult({
    args: ["-C", checkout, "rev-parse", "HEAD"],
    cwd: input.stateRoot,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
  });
  const head = headRead.code === 0 ? headRead.stdout.trim() : "";
  if (!isGitSha(head)) return { ok: false };
  const ancestor = await runTrustedGitResult({
    args: ["-C", checkout, "merge-base", "--is-ancestor", input.base, head],
    cwd: input.stateRoot,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
  });
  if (ancestor.code !== 0) return { ok: false };
  return { ok: true, checkout, commitBase: head };
}

/**
 * Advance one reusable checkout from its mapped base to the newly requested
 * base. Movement is allowed only when the mapped base is a real Git SHA and an
 * ancestor of the requested base, the checkout is clean with no untracked work,
 * and HEAD is exactly the mapped base (normal case) or exactly the requested
 * base (crash between the clean checkout movement and the mapping publication).
 * The requested exact SHA is fetched from the already-refreshed local source
 * (never the network) and moved with an ordinary detached checkout — no force,
 * reset or clean. The resulting exact HEAD and clean state are verified before
 * the mapping is published atomically; prior objects and history are kept and
 * nothing is recloned.
 */
async function advanceTaskCheckout(input: {
  checkout: string;
  mappingPath: string;
  mapped: { taskId: string; base: string; version: string; kind: string };
  base: GitSha;
  key: string;
  sourcePath: string;
  stateRoot: string;
  scratch: string;
  trustedPath: string;
}): Promise<boolean> {
  const git = (args: string[]) =>
    runTrustedGitResult({
      args,
      cwd: input.stateRoot,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    });
  const clean = async (): Promise<boolean> => {
    const status = await git([
      "-C",
      input.checkout,
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]);
    return status.code === 0 && status.stdout.trim().length === 0;
  };
  // The mapped base is durable state: validate it as a SHA before any Git use.
  if (!isGitSha(input.mapped.base)) return false;
  if (!(await clean())) return false;
  const headRead = await git(["-C", input.checkout, "rev-parse", "HEAD"]);
  const head = headRead.code === 0 ? headRead.stdout.trim() : "";
  if (!isGitSha(head)) return false;
  // A saved candidate/checkpoint head is never moved.
  const recovered = head === input.base;
  if (!recovered && head !== input.mapped.base) return false;
  // Prove ancestry read-only in the refreshed local source before writing any
  // object into the checkout: a divergent requested base is refused untouched.
  const ancestor = await git([
    "-C",
    input.sourcePath,
    "merge-base",
    "--is-ancestor",
    input.mapped.base,
    input.base,
  ]);
  if (ancestor.code !== 0) return false;
  if (!recovered) {
    const fetched = await git([
      "-C",
      input.checkout,
      "fetch",
      "--no-tags",
      input.sourcePath,
      input.base,
    ]);
    if (fetched.code !== 0) return false;
    const detached = await git([
      "-C",
      input.checkout,
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "--detach",
      input.base,
    ]);
    if (detached.code !== 0) return false;
  }
  const movedHead = await git(["-C", input.checkout, "rev-parse", "HEAD"]);
  if (movedHead.code !== 0 || movedHead.stdout.trim() !== input.base) {
    return false;
  }
  if (!(await clean())) return false;
  // Publish the updated mapping only after the verified move, atomically.
  const temporary = `${input.mappingPath}.tmp`;
  await writePrivateFile(
    temporary,
    JSON.stringify({
      version: input.mapped.version,
      kind: input.mapped.kind,
      taskId: input.mapped.taskId,
      base: input.base,
      key: input.key,
    }) + "\n",
  );
  await Deno.rename(temporary, input.mappingPath);
  return true;
}

/** Fetch the exact candidate head into the trusted source object repo. */
export async function importCandidate(input: {
  sourcePath: string;
  checkout: string;
  head: GitSha;
  key: string;
  scratch: string;
  trustedPath: string;
}): Promise<boolean> {
  const ref = `refs/sentinel/candidates/${input.key}`;
  // The EXACT requested commit is fetched, never the checkout's mutable HEAD:
  // a later commit or a moved HEAD must not silently replace the candidate.
  const fetched = await runTrustedGitResult({
    args: [
      "-C",
      input.sourcePath,
      "fetch",
      "--no-tags",
      input.checkout,
      `+${input.head}:${ref}`,
    ],
    cwd: input.sourcePath,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
  });
  if (fetched.code !== 0) return false;
  const observed = await runTrustedGitResult({
    args: ["-C", input.sourcePath, "rev-parse", ref],
    cwd: input.sourcePath,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
  });
  return observed.code === 0 && observed.stdout.trim() === input.head;
}

async function readCheckoutMapping(
  mappingPath: string,
): Promise<
  { taskId: string; base: string; version: string; kind: string } | null
> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(mappingPath)) as {
      taskId?: unknown;
      base?: unknown;
      version?: unknown;
      kind?: unknown;
    };
    if (typeof parsed.taskId !== "string" || typeof parsed.base !== "string") {
      return null;
    }
    return {
      taskId: parsed.taskId,
      base: parsed.base,
      version: typeof parsed.version === "string" ? parsed.version : "v1",
      kind: typeof parsed.kind === "string" ? parsed.kind : "local_checkout",
    };
  } catch {
    return null;
  }
}

/** Fixed identity of the trusted merge preparation (no commit is written). */
const MERGE_IDENTITY = [
  "-c",
  "user.name=ubiquity-sentinel[bot]",
  "-c",
  "user.email=319834869+ubiquity-sentinel[bot]@users.noreply.github.com",
];

/**
 * Prepare a base-refresh CONFLICT RESOLUTION checkout: the persistent task
 * checkout must sit exactly and cleanly on the published candidate `head`;
 * the exact `mergeBase` is fetched from the already-ensured local source
 * (never the network) and merged with `--no-ff --no-commit`, so the merge
 * stops with its conflicts left in the tree and MERGE_HEAD naming the base.
 * Returns the exact conflicted paths the trusted committer later checks for
 * leftover markers. Any other state (moved or dirty checkout, missing base,
 * an unexpected merge exit or MERGE_HEAD) fails closed with no commit, ref or
 * mapping change beyond the in-progress merge itself.
 */
export async function prepareMergeCheckout(input: {
  checkout: string;
  head: GitSha;
  mergeBase: GitSha;
  sourcePath: string;
  stateRoot: string;
  scratch: string;
  trustedPath: string;
}): Promise<{ ok: true; conflictedPaths: string[] } | { ok: false }> {
  const git = async (args: string[]) => {
    try {
      return await runTrustedGitResult({
        args: ["-C", input.checkout, ...args],
        cwd: input.stateRoot,
        scratch: input.scratch,
        trustedPath: input.trustedPath,
      });
    } catch {
      return { code: -1, stdout: "" };
    }
  };
  const head = await git(["rev-parse", "HEAD"]);
  if (head.code !== 0 || head.stdout.trim() !== input.head) {
    return { ok: false };
  }
  const status = await git(["status", "--porcelain", "--untracked-files=all"]);
  if (status.code !== 0 || status.stdout.trim().length !== 0) {
    return { ok: false };
  }
  const fetched = await git([
    "fetch",
    "--no-tags",
    input.sourcePath,
    input.mergeBase,
  ]);
  if (fetched.code !== 0) return { ok: false };
  const present = await git(["cat-file", "-e", `${input.mergeBase}^{commit}`]);
  if (present.code !== 0) return { ok: false };
  const merged = await git([
    ...MERGE_IDENTITY,
    "-c",
    "rerere.enabled=false",
    "merge",
    "--no-ff",
    "--no-commit",
    "--no-edit",
    input.mergeBase,
  ]);
  // 0: merged cleanly (still uncommitted); 1: stopped on conflicts.
  if (merged.code !== 0 && merged.code !== 1) return { ok: false };
  const mergeHead = await git(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  if (mergeHead.code !== 0 || mergeHead.stdout.trim() !== input.mergeBase) {
    return { ok: false };
  }
  const unmerged = await git([
    "diff",
    "--name-only",
    "--diff-filter=U",
    "-z",
  ]);
  if (unmerged.code !== 0) return { ok: false };
  return {
    ok: true,
    conflictedPaths: unmerged.stdout.split("\0").filter((path) =>
      path.length > 0
    ),
  };
}
