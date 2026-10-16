/** Trusted local candidate commit and exact checkout identity resolution. */
import type { GitSha } from "../contracts/brands.ts";
import { CHECKPOINT_REF } from "./model-port-policy.ts";

/** Local credential-free checkout identity resolution (no remote, no creds). */
export interface CheckoutResolverV1 {
  resolve(): Promise<
    {
      head: GitSha | null;
      checkpointSha: GitSha | null;
      changedPaths: string[];
    } | null
  >;
}

/**
 * Trusted host capability that turns a completed model working tree into one
 * candidate commit. The model session itself may be unable to write `.git`
 * metadata under the app-server workspace sandbox; this capability runs after
 * the session has settled, outside that sandbox, and never publishes or edits
 * durable Sentinel state.
 */
export interface CandidateCommitterV1 {
  commit(base: GitSha): Promise<boolean>;
  /** Advisory only; absent or unknown values retain the generic failure. */
  readonly refusalCode?: CandidateCommitRefusalCodeV1 | null;
}

export const CANDIDATE_COMMIT_REFUSAL_DETAILS = {
  head_unavailable: "candidate checkout head is unavailable",
  ancestry_unverified: "candidate checkout ancestry is unverified",
  status_unavailable: "candidate checkout status is unavailable",
  dirty_descendant: "candidate descendant checkout has pending edits",
  unchanged_base: "candidate checkout is unchanged at base",
  unmerged_entries: "candidate checkout contains unmerged entries",
  staging_failed: "candidate checkout staging failed",
  staged_diff_empty: "candidate checkout staged diff is empty",
  staged_diff_failed: "candidate checkout staged diff is unavailable",
  commit_failed: "candidate checkout git commit failed",
  committed_head_unavailable: "candidate committed head is unavailable",
  committed_head_unchanged: "candidate committed head is unchanged",
  merge_identity_mismatch: "candidate merge checkout is not the planned merge",
  conflict_markers: "candidate merge checkout keeps conflict markers",
  merge_parents_mismatch: "candidate merge commit parents are not exact",
} as const;

export type CandidateCommitRefusalCodeV1 =
  keyof typeof CANDIDATE_COMMIT_REFUSAL_DETAILS;

/** Only authored literals cross this boundary; getters cannot change failure. */
export function candidateCommitRefusalDetail(
  committer: CandidateCommitterV1,
): string {
  try {
    const code: unknown = committer.refusalCode;
    if (
      typeof code === "string" &&
      Object.hasOwn(CANDIDATE_COMMIT_REFUSAL_DETAILS, code)
    ) {
      return CANDIDATE_COMMIT_REFUSAL_DETAILS[
        code as CandidateCommitRefusalCodeV1
      ];
    }
  } catch {
    // Diagnostic access is best effort and cannot replace the original refusal.
  }
  return "candidate checkout could not be committed";
}

/**
 * Local candidate committer for a trusted host. It only commits when HEAD is
 * still the requested base and the model left a non-empty working-tree
 * change. A model-created descendant is accepted for later identity
 * validation; an unrelated or malformed checkout fails closed.
 */
export class LocalCandidateCommitter implements CandidateCommitterV1 {
  private refusal: CandidateCommitRefusalCodeV1 | null = null;

  get refusalCode(): CandidateCommitRefusalCodeV1 | null {
    return this.refusal;
  }

  constructor(
    private readonly checkoutDir: string,
    private readonly message = "sentinel: autonomous repair candidate",
  ) {}

  async commit(base: GitSha): Promise<boolean> {
    this.refusal = null;
    const before = await this.run(["rev-parse", "HEAD"]);
    if (before === null || !/^[0-9a-f]{40}$/.test(before.trim())) {
      return this.refuse("head_unavailable");
    }
    const beforeSha = before.trim() as GitSha;
    const ancestry = await this.runResult([
      "merge-base",
      "--is-ancestor",
      base,
      beforeSha,
    ]);
    if (ancestry === null || ancestry.code !== 0) {
      return this.refuse("ancestry_unverified");
    }

    const status = await this.run([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (status === null) return this.refuse("status_unavailable");
    // Preserve a model-created descendant only when its checkout is clean;
    // otherwise the resolver would omit the pending edits from the receipt.
    if (beforeSha !== base) {
      return status.length === 0 || this.refuse("dirty_descendant");
    }
    if (status.length === 0) return this.refuse("unchanged_base");
    // Unmerged entries cannot be made into a trusted candidate by guessing at
    // conflict resolution. Keep every other path under the host's normal
    // protected-path and review gates.
    const entries = status.split("\0").filter((entry) => entry.length > 0);
    if (
      entries.some((entry) => {
        const x = entry[0] ?? "";
        const y = entry[1] ?? "";
        return x === "U" || y === "U" || (x === "A" && y === "A") ||
          (x === "D" && y === "D");
      })
    ) return this.refuse("unmerged_entries");

    const staged = await this.runResult(["add", "-A", "--", "."]);
    if (staged === null || staged.code !== 0) {
      return this.refuse("staging_failed");
    }
    const diff = await this.runResult([
      "diff",
      "--cached",
      "--quiet",
      "--exit-code",
    ]);
    if (diff === null || diff.code !== 0 && diff.code !== 1) {
      return this.refuse("staged_diff_failed");
    }
    if (diff.code === 0) return this.refuse("staged_diff_empty");
    const committed = await this.runResult([
      "-c",
      "user.name=ubiquity-sentinel[bot]",
      "-c",
      "user.email=319834869+ubiquity-sentinel[bot]@users.noreply.github.com",
      "commit",
      "--no-verify",
      "-m",
      this.message,
    ]);
    if (committed === null || committed.code !== 0) {
      return this.refuse("commit_failed");
    }
    const after = await this.run(["rev-parse", "HEAD"]);
    if (after === null || !/^[0-9a-f]{40}$/.test(after.trim())) {
      return this.refuse("committed_head_unavailable");
    }
    return after.trim() !== base || this.refuse("committed_head_unchanged");
  }

  private refuse(code: CandidateCommitRefusalCodeV1): false {
    this.refusal = code;
    return false;
  }

  private async run(args: string[]): Promise<string | null> {
    const result = await this.runResult(args);
    return result?.code === 0 ? result.stdout : null;
  }

  private async runResult(args: string[]): Promise<
    {
      code: number;
      stdout: string;
    } | null
  > {
    try {
      const result = await new Deno.Command("git", {
        args: ["-C", this.checkoutDir, ...args],
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          HOME: this.checkoutDir,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        code: result.code,
        stdout: new TextDecoder().decode(result.stdout),
      };
    } catch {
      return null;
    }
  }
}

/** Default resolver: local git in the checkout with a cleared environment. */
export class LocalCheckoutResolver implements CheckoutResolverV1 {
  constructor(
    private readonly checkoutDir: string,
    private readonly baseSha: GitSha,
  ) {}

  async resolve(): Promise<
    {
      head: GitSha | null;
      checkpointSha: GitSha | null;
      changedPaths: string[];
    } | null
  > {
    const head = await this.git(["rev-parse", "HEAD"]);
    if (head === null || !/^[0-9a-f]{40}$/.test(head.trim())) return null;
    const headSha = head.trim() as GitSha;
    const ancestor = await this.git([
      "merge-base",
      "--is-ancestor",
      this.baseSha,
      headSha,
    ]);
    if (ancestor === null || ancestor.trim() !== "") return null;
    // Candidate identity is commit-only. Reject a dirty checkout rather than
    // binding a receipt to base..HEAD while leaving working-tree edits out.
    const status = await this.git([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (status === null || status.length !== 0) return null;
    const files = await this.git([
      "diff",
      "--no-renames",
      "--name-only",
      `${this.baseSha}..${headSha}`,
    ]);
    const changedPaths = files === null
      ? []
      : files.split("\n").filter((line) => line.trim().length > 0);
    const checkpoint = await this.git([
      "rev-parse",
      "--verify",
      "-q",
      CHECKPOINT_REF,
    ]);
    const checkpointSha = checkpoint !== null &&
        /^[0-9a-f]{40}$/.test(checkpoint.trim())
      ? (checkpoint.trim() as GitSha)
      : null;
    return { head: headSha, checkpointSha, changedPaths };
  }

  private async git(args: string[]): Promise<string | null> {
    const command = new Deno.Command("git", {
      args: ["-C", this.checkoutDir, ...args],
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: this.checkoutDir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const status = await command.output();
    if (status.code !== 0) return null;
    return new TextDecoder().decode(status.stdout);
  }
}

/** Exact planned merge of one conflict-resolution checkout. */
export interface PlannedMergeV1 {
  /** Published candidate the checkout continues (first parent). */
  head: GitSha;
  /** Base tip merged into it (second parent). */
  mergeBase: GitSha;
  /** Paths the trusted merge preparation left conflicted. */
  conflictedPaths: readonly string[];
}

/** A conflict-marker line Git writes (`<<<<<<< ours` / `>>>>>>> theirs`). */
const CONFLICT_MARKER_LINE = /^(?:<{7}|>{7})(?: |$)/m;

/**
 * Trusted committer of a base-refresh CONFLICT RESOLUTION. The trusted host
 * prepared the merge (`prepareMergeCheckout`): HEAD must still be exactly the
 * published candidate and MERGE_HEAD exactly the planned base, and no path
 * the preparation left conflicted may keep a conflict marker. The resolved
 * tree is then committed as the merge itself, so the result has exactly the
 * two parents (candidate, base) and publishing it is a fast-forward of the
 * candidate. The model session never commits; a moved, aborted or redone
 * merge fails closed.
 */
export class LocalMergeCommitter implements CandidateCommitterV1 {
  private refusal: CandidateCommitRefusalCodeV1 | null = null;

  get refusalCode(): CandidateCommitRefusalCodeV1 | null {
    return this.refusal;
  }

  constructor(
    private readonly checkoutDir: string,
    private readonly planned: PlannedMergeV1,
    private readonly message = "sentinel: resolve base refresh conflicts",
  ) {}

  async commit(base: GitSha): Promise<boolean> {
    this.refusal = null;
    const { head, mergeBase } = this.planned;
    if (base !== head) return this.refuse("merge_identity_mismatch");
    const before = await runCheckoutGit(this.checkoutDir, [
      "rev-parse",
      "HEAD",
    ]);
    if (before === null || before.code !== 0) {
      return this.refuse("head_unavailable");
    }
    const merging = await runCheckoutGit(this.checkoutDir, [
      "rev-parse",
      "-q",
      "--verify",
      "MERGE_HEAD",
    ]);
    if (
      before.stdout.trim() !== head || merging === null ||
      merging.code !== 0 || merging.stdout.trim() !== mergeBase
    ) return this.refuse("merge_identity_mismatch");
    for (const path of this.planned.conflictedPaths) {
      if (await keepsConflictMarker(`${this.checkoutDir}/${path}`)) {
        return this.refuse("conflict_markers");
      }
    }
    const staged = await runCheckoutGit(this.checkoutDir, [
      "add",
      "-A",
      "--",
      ".",
    ]);
    if (staged === null || staged.code !== 0) {
      return this.refuse("staging_failed");
    }
    const unmerged = await runCheckoutGit(this.checkoutDir, [
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=U",
    ]);
    if (unmerged === null || unmerged.code !== 0) {
      return this.refuse("staged_diff_failed");
    }
    if (unmerged.stdout.trim().length > 0) {
      return this.refuse("unmerged_entries");
    }
    const committed = await runCheckoutGit(this.checkoutDir, [
      "-c",
      "user.name=ubiquity-sentinel[bot]",
      "-c",
      "user.email=319834869+ubiquity-sentinel[bot]@users.noreply.github.com",
      "commit",
      "--no-verify",
      "-m",
      this.message,
    ]);
    if (committed === null || committed.code !== 0) {
      return this.refuse("commit_failed");
    }
    const after = await runCheckoutGit(this.checkoutDir, ["rev-parse", "HEAD"]);
    const merged = after?.code === 0 ? after.stdout.trim() : "";
    if (!/^[0-9a-f]{40}$/.test(merged)) {
      return this.refuse("committed_head_unavailable");
    }
    const parents = await runCheckoutGit(this.checkoutDir, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      merged,
    ]);
    return parents?.code === 0 &&
        parents.stdout.trim() === `${merged} ${head} ${mergeBase}` ||
      this.refuse("merge_parents_mismatch");
  }

  private refuse(code: CandidateCommitRefusalCodeV1): false {
    this.refusal = code;
    return false;
  }
}

/**
 * Resolver of a conflict-resolution checkout: the ordinary clean-checkout
 * identity read bound to the MERGED base (so the changed paths are the
 * candidate's own change set as its pull request shows it against that base,
 * never the base's history), plus the proof that the head is a new commit
 * descending from the published candidate.
 */
export class LocalMergeResolver implements CheckoutResolverV1 {
  constructor(
    private readonly checkoutDir: string,
    private readonly planned: Pick<PlannedMergeV1, "head" | "mergeBase">,
  ) {}

  async resolve(): Promise<
    {
      head: GitSha | null;
      checkpointSha: GitSha | null;
      changedPaths: string[];
    } | null
  > {
    const resolved = await new LocalCheckoutResolver(
      this.checkoutDir,
      this.planned.mergeBase,
    ).resolve();
    if (
      resolved === null || resolved.head === null ||
      resolved.head === this.planned.head
    ) return null;
    const descends = await runCheckoutGit(this.checkoutDir, [
      "merge-base",
      "--is-ancestor",
      this.planned.head,
      resolved.head,
    ]);
    return descends?.code === 0 ? resolved : null;
  }
}

/** True when a regular file still holds a Git conflict-marker line. */
async function keepsConflictMarker(path: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(path);
    if (!info.isFile) return false;
    const text = new TextDecoder().decode(await Deno.readFile(path));
    return CONFLICT_MARKER_LINE.test(text);
  } catch (error) {
    // A resolution may delete a conflicted path; anything else is unproven.
    return !(error instanceof Deno.errors.NotFound);
  }
}

/** Local git in one checkout with a cleared, credential-free environment. */
async function runCheckoutGit(
  checkoutDir: string,
  args: string[],
): Promise<{ code: number; stdout: string } | null> {
  try {
    const result = await new Deno.Command("git", {
      args: ["-C", checkoutDir, ...args],
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: checkoutDir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
    };
  } catch {
    return null;
  }
}
