import type { GitSha } from "../contracts/brands.ts";
import { ensurePrivateDir } from "./local-release.ts";
import {
  DETAIL_RUNTIME_INVALID,
  DETAIL_SOURCE_UNAVAILABLE,
  DETAIL_STAGE_FAILED,
  joinPath,
  LOCAL_DEVELOPMENT_REF,
  type LocalSupervisorInputV1,
  MAX_TRACKED_SYMLINKS,
  runtimePath,
  RUNTIMES_DIR,
} from "./local-supervisor-shared.ts";
import { runGit } from "./local-supervisor-git.ts";

export async function verifyRuntime(
  input: LocalSupervisorInputV1,
  revision: GitSha,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const runtimeDir = runtimePath(input.stateRoot, revision);
  const runtimesRoot = joinPath(input.stateRoot, RUNTIMES_DIR);
  let realRoot: string;
  try {
    realRoot = await Deno.realPath(runtimesRoot);
  } catch {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  let realRuntime: string;
  try {
    const info = await Deno.lstat(runtimeDir);
    if (!info.isDirectory) return { ok: false, detail: DETAIL_RUNTIME_INVALID };
    realRuntime = await Deno.realPath(runtimeDir);
  } catch {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  if (
    realRuntime === realRoot || !realRuntime.startsWith(`${realRoot}/`)
  ) {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  const head = await runGit(input, ["-C", runtimeDir, "rev-parse", "HEAD"]);
  if (
    !head.ok || head.exitCode !== 0 || head.stdout.trim() !== revision
  ) {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  const status = await runGit(input, [
    "-C",
    runtimeDir,
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (!status.ok || status.exitCode !== 0 || status.stdout.trim() !== "") {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  const symlinks = await verifyTrackedSymlinks(input, runtimeDir, realRuntime);
  if (!symlinks.ok) return symlinks;
  return { ok: true };
}

async function verifyTrackedSymlinks(
  input: LocalSupervisorInputV1,
  runtimeDir: string,
  realRuntime: string,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const listed = await runGit(input, [
    "-C",
    runtimeDir,
    "ls-files",
    "-s",
  ]);
  if (!listed.ok || listed.exitCode !== 0) {
    return { ok: false, detail: DETAIL_RUNTIME_INVALID };
  }
  const links: string[] = [];
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("120000 ")) continue;
    const tab = line.indexOf("\t");
    if (tab < 0) return { ok: false, detail: DETAIL_RUNTIME_INVALID };
    links.push(line.slice(tab + 1));
    if (links.length > MAX_TRACKED_SYMLINKS) {
      return { ok: false, detail: DETAIL_RUNTIME_INVALID };
    }
  }
  for (const link of links) {
    let resolved: string;
    try {
      resolved = await Deno.realPath(joinPath(runtimeDir, link));
    } catch {
      return { ok: false, detail: DETAIL_RUNTIME_INVALID };
    }
    if (resolved !== realRuntime && !resolved.startsWith(`${realRuntime}/`)) {
      return { ok: false, detail: DETAIL_RUNTIME_INVALID };
    }
  }
  return { ok: true };
}

export async function stageRuntime(
  input: LocalSupervisorInputV1,
  revision: GitSha,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const runtimesRoot = joinPath(input.stateRoot, RUNTIMES_DIR);
  const target = runtimePath(input.stateRoot, revision);
  try {
    await ensurePrivateDir(runtimesRoot);
  } catch {
    return { ok: false, detail: DETAIL_STAGE_FAILED };
  }
  let targetExists = true;
  try {
    const info = await Deno.lstat(target);
    if (!info.isDirectory) return { ok: false, detail: DETAIL_STAGE_FAILED };
  } catch {
    targetExists = false;
  }
  if (targetExists) {
    // An existing runtime is never overwritten: it is either the exact clean
    // revision (reused) or a refusal.
    const verified = await verifyRuntime(input, revision);
    return verified.ok
      ? { ok: true }
      : { ok: false, detail: DETAIL_STAGE_FAILED };
  }

  const stage = joinPath(
    runtimesRoot,
    `.stage-${revision}-${crypto.randomUUID()}`,
  );
  try {
    await ensurePrivateDir(stage);
    const cloned = await runGit(input, [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      input.sourceDir,
      stage,
    ]);
    if (!cloned.ok) throw new Error(DETAIL_STAGE_FAILED);
    // The source mirror's refreshed development tip lives on its remote-tracking
    // ref, so the exact revision's objects are carried over explicitly before
    // the detached checkout. Local path, no credentials.
    const carried = await runGit(input, [
      "-C",
      stage,
      "fetch",
      "--no-tags",
      input.sourceDir,
      "+refs/remotes/origin/development:refs/remotes/origin/development",
    ]);
    if (!carried.ok) throw new Error(DETAIL_STAGE_FAILED);
    const checkedOut = await runGit(input, [
      "-C",
      stage,
      "checkout",
      "--detach",
      revision,
    ]);
    if (!checkedOut.ok) throw new Error(DETAIL_STAGE_FAILED);
    const head = await runGit(input, ["-C", stage, "rev-parse", "HEAD"]);
    if (!head.ok || head.exitCode !== 0 || head.stdout.trim() !== revision) {
      throw new Error(DETAIL_STAGE_FAILED);
    }
    try {
      await Deno.rename(stage, target);
    } catch {
      // A concurrent writer may have created the exact same immutable runtime;
      // it is reused only when it verifies as the exact clean revision.
      const verified = await verifyRuntime(input, revision);
      if (!verified.ok) throw new Error(DETAIL_STAGE_FAILED);
    }
  } catch {
    try {
      await Deno.remove(stage, { recursive: true });
    } catch {
      // the staged temp directory is private and never part of history
    }
    return { ok: false, detail: DETAIL_STAGE_FAILED };
  }
  const verified = await verifyRuntime(input, revision);
  return verified.ok
    ? { ok: true }
    : { ok: false, detail: DETAIL_STAGE_FAILED };
}

// ---------------------------------------------------------------------------
// Source ancestry: exact revision must be contained in refreshed development
// ---------------------------------------------------------------------------

export async function sourceRevisionIsAncestor(
  input: LocalSupervisorInputV1,
  revision: GitSha,
): Promise<{ ok: true; value: boolean } | { ok: false; detail: string }> {
  // The healthy real child host already refreshes the local source mirror's
  // development remote-tracking ref. The supervisor performs no fetch and
  // needs no GitHub credential for its own Git commands; a missing ref or a
  // missing exact revision object is an explicit refusal, never ancestry.
  const resolved = await runGit(input, [
    "-C",
    input.sourceDir,
    "rev-parse",
    "--verify",
    "--quiet",
    LOCAL_DEVELOPMENT_REF,
  ]);
  if (
    !resolved.ok || resolved.exitCode !== 0 || resolved.stdout.trim() === ""
  ) {
    return { ok: false, detail: DETAIL_SOURCE_UNAVAILABLE };
  }
  const ancestor = await runGit(input, [
    "-C",
    input.sourceDir,
    "merge-base",
    "--is-ancestor",
    revision,
    LOCAL_DEVELOPMENT_REF,
  ]);
  if (!ancestor.ok) return { ok: false, detail: DETAIL_SOURCE_UNAVAILABLE };
  // 0 = contained, 1 = not contained. Anything else (for example 128 for an
  // absent revision object) is a refusal, never a silent non-ancestor value.
  if (ancestor.exitCode !== 0 && ancestor.exitCode !== 1) {
    return { ok: false, detail: DETAIL_SOURCE_UNAVAILABLE };
  }
  return { ok: true, value: ancestor.exitCode === 0 };
}
