import { AGENT_JOB_SHA } from "./agent-jobs-admission.ts";
import { git, gitOk } from "./agent-jobs-git.ts";

type Inbox = "inbox" | "cleanup";

/** Require the authenticated sender of the GitHub event, independent of any commit attribution. */
export function requireAgentJobOperator(event: unknown, actor: string): void {
  const envelope = event as { sender?: { type?: unknown; login?: unknown } };
  if (
    envelope?.sender?.type !== "User" ||
    envelope.sender.login !== actor ||
    !actor ||
    /\[bot\]$/i.test(actor)
  ) throw new Error("agent jobs requires a matching GitHub User sender");
}

function validSha(sha: unknown): sha is string {
  return typeof sha === "string" && AGENT_JOB_SHA.test(sha) &&
    sha !== "0".repeat(40);
}

/** Resolve only new paths from a verified forward push, including merged commits. */
export async function freshAgentJobRequests(
  directory: Inbox,
  before: unknown,
  after: unknown,
  checkedOutSha: unknown,
  cwd = ".",
): Promise<string[]> {
  if (!validSha(before) || !validSha(after) || after !== checkedOutSha) {
    throw new Error("agent jobs push has unavailable commit bounds");
  }
  const head = await gitOk(["rev-parse", "HEAD"], { cwd });
  if (
    after !== head ||
    (await git(["merge-base", "--is-ancestor", before, after], { cwd }))
        .code !== 0
  ) throw new Error("agent jobs push is not a verified forward update");

  const raw = await gitOk([
    "diff",
    "--no-renames",
    "--name-only",
    "--diff-filter=A",
    "-z",
    before,
    after,
    "--",
    ":(glob)jobs/" + directory + "/*.json",
  ], { cwd });
  const fresh: string[] = [];
  for (const path of raw.split("\0").filter(Boolean)) {
    // A file restored after deletion is historical intake, even if absent
    // from the tree immediately before this push.
    const prior = await gitOk([
      "--literal-pathspecs",
      "log",
      "--full-history",
      "-1",
      "--format=%H",
      before,
      "--",
      path,
    ], { cwd });
    if (prior) continue;
    const mode = await gitOk([
      "--literal-pathspecs",
      "ls-tree",
      "--format=%(objectmode)",
      after,
      "--",
      path,
    ], { cwd });
    if (mode !== "100644" && mode !== "100755") {
      throw new Error("agent jobs request must be a regular Git file");
    }
    fresh.push(path);
  }
  return fresh;
}

export function parseAgentJobJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new Error("invalid agent jobs request JSON");
  }
}

export async function readAgentJobsPushRequests(
  directory: Inbox,
  event: unknown,
  sha: string,
  cwd = ".",
): Promise<unknown[]> {
  const { before, after, ref } = event as {
    before?: unknown;
    after?: unknown;
    ref?: unknown;
  } ?? {};
  if (ref !== "refs/heads/development") {
    throw new Error("agent jobs push is not on development");
  }
  const paths = await freshAgentJobRequests(directory, before, after, sha, cwd);
  return await Promise.all(
    paths.map(async (path) =>
      parseAgentJobJson(await gitOk(["show", sha + ":" + path], { cwd }))
    ),
  );
}
