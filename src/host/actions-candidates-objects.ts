/** Hosted actions-candidates-objects responsibility. */
import type { GitSha } from "../contracts/brands.ts";

// ---------------------------------------------------------------------------
// Trusted candidate preservation (create-only operation-bound remote ref)
// ---------------------------------------------------------------------------

/** Bounded credential-scoped git run used ONLY by the fresh-store proof. */
export type PreserverGitRunV1 = (
  cwd: string,
  args: string[],
  credentials: boolean,
) => Promise<PreserverGitResultV1 | null>;

/**
 * One bounded git result. `settled` is false exactly when the owned process
 * group could not be proved settled; `exited` is false for a spawn failure or
 * timeout. A runtime throw is reported as a null result and is treated as
 * unsettled by the proof.
 */
interface PreserverGitResultV1 {
  code: number;
  stdout: string;
  settled: boolean;
  truncated: boolean;
  exited: boolean;
}

/** Exact commit object state in one private object store. */
export async function exactCommitAt(
  runGit: PreserverGitRunV1,
  cwd: string,
  sha: GitSha,
): Promise<boolean | null> {
  const read = await runGit(
    cwd,
    ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`],
    false,
  );
  if (read === null || !read.exited || !read.settled || read.truncated) {
    return null;
  }
  if (read.code === 1) return false;
  if (read.code !== 0) return null;
  return read.stdout.trim() === sha ? true : null;
}

/** True/false when proved; null when a stat failure makes the path unknown. */
export async function pathPresent(path: string): Promise<boolean | null> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? false : null;
  }
}
