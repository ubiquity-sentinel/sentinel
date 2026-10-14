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
}

/**
 * Local candidate committer for a trusted host. It only commits when HEAD is
 * still the requested base and the model left a non-empty working-tree
 * change. A model-created descendant is accepted for later identity
 * validation; an unrelated or malformed checkout fails closed.
 */
export class LocalCandidateCommitter implements CandidateCommitterV1 {
  constructor(
    private readonly checkoutDir: string,
    private readonly message = "sentinel: autonomous repair candidate",
  ) {}

  async commit(base: GitSha): Promise<boolean> {
    const before = await this.run(["rev-parse", "HEAD"]);
    if (before === null || !/^[0-9a-f]{40}$/.test(before.trim())) {
      return false;
    }
    const beforeSha = before.trim() as GitSha;
    const ancestry = await this.runResult([
      "merge-base",
      "--is-ancestor",
      base,
      beforeSha,
    ]);
    if (ancestry === null || ancestry.code !== 0) return false;

    const status = await this.run([
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (status === null) return false;
    // Preserve a model-created descendant only when its checkout is clean;
    // otherwise the resolver would omit the pending edits from the receipt.
    if (beforeSha !== base) return status.length === 0;
    if (status.length === 0) return false;
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
    ) return false;

    const staged = await this.runResult(["add", "-A", "--", "."]);
    if (staged === null || staged.code !== 0) return false;
    const diff = await this.runResult([
      "diff",
      "--cached",
      "--quiet",
      "--exit-code",
    ]);
    if (diff === null || diff.code === 0 || diff.code !== 1) return false;
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
    if (committed === null || committed.code !== 0) return false;
    const after = await this.run(["rev-parse", "HEAD"]);
    if (after === null || !/^[0-9a-f]{40}$/.test(after.trim())) return false;
    return after.trim() !== base;
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
