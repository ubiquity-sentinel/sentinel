/** Fresh-store native PR custody. No model descriptor or producer claim is synthesized. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import type { Clock, GitHubCooldownGateV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { NativeAssociationPull } from "../github/pr-association-wire.ts";
import {
  normalizeProtectedPaths,
  parseShaList,
} from "../github/snapshot-git-wire.ts";
import { DenoReplayRuntime, type ReplayRuntimeV1 } from "../replay/runtime.ts";
import {
  pathPresent,
  type PreserverGitRunV1,
} from "./actions-candidates-objects.ts";
import { githubGitAuthEnv } from "./local-github-auth.ts";
import { GitReviewSnapshot } from "../github/review-snapshot.ts";

export interface NativeTakeoverGitInput {
  repository: RepositoryIdentityV1;
  sourcePath: string;
  scratch: string;
  trustedPath: string;
  gitExecutable: string;
  remoteUrl: string;
  token: string;
  clock: Clock;
  gate: GitHubCooldownGateV1;
  protectedPaths: readonly string[];
  runtime?: ReplayRuntimeV1;
}
const failed = (): PortResultV1<never> =>
  portError(
    "unavailable",
    "existing pull request native Git custody unavailable",
  );

export function createNativeTakeoverGit(input: NativeTakeoverGitInput) {
  const runtime = input.runtime ?? new DenoReplayRuntime(input.trustedPath);
  const protectedPaths = normalizeProtectedPaths(input.protectedPaths);
  const configuredRemote =
    `https://github.com/${input.repository.owner}/${input.repository.name}.git`;
  if (
    input.remoteUrl !== configuredRemote &&
    !input.remoteUrl.startsWith("file:///")
  ) throw new TypeError("existing pull request remote identity is invalid");
  const live = (deadline: number) =>
    Number.isSafeInteger(deadline) && input.clock.now() < deadline;
  const runner =
    (deadline: number): PreserverGitRunV1 => async (cwd, args, credentials) => {
      if (!live(deadline)) return null;
      try {
        const result = await runtime.run({
          executable: input.gitExecutable,
          args: [
            "--no-replace-objects",
            "-c",
            "core.hooksPath=/dev/null",
            ...args,
          ],
          cwd,
          env: {
            PATH: input.trustedPath,
            HOME: input.scratch,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            ...(credentials
              ? githubGitAuthEnv(input.token, input.remoteUrl)
              : {}),
          },
          maxDurationMs: Math.min(120_000, deadline - input.clock.now()),
          maxOutputBytes: 1024 * 1024,
        });
        return {
          code: result.exitCode ?? 1,
          stdout: result.outcome === "exited"
            ? new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
            : "",
          settled: result.settled,
          truncated: result.truncated,
          exited: result.outcome === "exited",
        };
      } catch {
        return null;
      }
    };

  async function observe(
    headRef: string,
    head: GitSha,
    baseRef: string,
    base: GitSha,
    deadline: number,
    restoreSource: boolean,
  ): Promise<PortResultV1<{ protectedPathsClear: boolean }>> {
    if (
      !live(deadline) || !isGitSha(head) || !isGitSha(base) ||
      protectedPaths === null || !headRef.startsWith("refs/heads/") ||
      (!baseRef.startsWith("refs/heads/") && !isGitSha(baseRef))
    ) return failed();
    let store: string;
    try {
      store = await Deno.makeTempDir({
        dir: input.scratch,
        prefix: "pr-native-",
      });
    } catch {
      return failed();
    }
    const raw = runner(deadline);
    let unsettled = false;
    const run: PreserverGitRunV1 = async (cwd, args, credentials) => {
      const result = await raw(cwd, args, credentials);
      if (result === null || !result.settled) unsettled = true;
      return result !== null && result.settled && result.exited &&
          !result.truncated && live(deadline)
        ? result
        : null;
    };
    const exactFetch = async (ref: string, expected: GitSha) => {
      const gate = await input.gate.beforeRequest(
        input.repository.installationId,
      );
      if (!gate.ok || !live(deadline)) return false;
      const fetched = await run(store, [
        "fetch",
        "--no-tags",
        input.remoteUrl,
        ref,
      ], true);
      if (fetched?.code !== 0) return false;
      const checked = await run(store, [
        "rev-parse",
        "--verify",
        "FETCH_HEAD^{commit}",
      ], false);
      return checked?.code === 0 && checked.stdout.trim() === expected;
    };
    try {
      if ((await run(store, ["init", "--bare", "-q"], false))?.code !== 0) {
        return failed();
      }
      if (
        !await exactFetch(headRef, head) || !await exactFetch(baseRef, base)
      ) return failed();
      const shallow = await run(
        store,
        ["rev-parse", "--is-shallow-repository"],
        false,
      );
      const replaced = await run(store, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/replace",
      ], false);
      if (
        shallow?.code !== 0 || shallow.stdout.trim() !== "false" ||
        replaced?.code !== 0 || replaced.stdout.trim() !== "" ||
        await pathPresent(`${store}/objects/info/alternates`) !== false
      ) return failed();
      // All native contribution commits are inspected, including reverted edits.
      // B may have advanced independently; custody does not pretend H was based on B.
      const commits = await run(store, [
        "rev-list",
        "--max-count=501",
        head,
        `^${base}`,
      ], false);
      if (commits?.code !== 0) return failed();
      const list = parseShaList(commits.stdout);
      if (list === null || list.length > 500) return failed();
      let clear = true;
      for (const commit of list) {
        const paths = await run(store, [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-only",
          "--no-renames",
          "-r",
          "-m",
          "-z",
          commit,
          "--",
        ], false);
        if (paths?.code !== 0) return failed();
        if (paths.stdout !== "" && !paths.stdout.endsWith("\0")) {
          return failed();
        }
        for (const path of paths.stdout.split("\0").filter(Boolean)) {
          if (
            protectedPaths.some((p) =>
              path === p || path.startsWith(`${p}/`) || p.startsWith(`${path}/`)
            )
          ) clear = false;
        }
      }
      if (clear && restoreSource) {
        const imported = await run(input.sourcePath, [
          "fetch",
          "--no-tags",
          store,
          head,
          base,
        ], false);
        if (imported?.code !== 0) return failed();
      }
      return live(deadline) ? portOk({ protectedPathsClear: clear }) : failed();
    } catch {
      return failed();
    } finally {
      if (!unsettled) {
        await Deno.remove(store, { recursive: true }).catch(() => {});
      }
    }
  }

  return {
    async validateLocal(
      base: GitSha,
      head: GitSha,
      publishedHead: GitSha | null,
      deadline: number,
    ) {
      if (!live(deadline)) return failed();
      const validator = new GitReviewSnapshot({
        trustedPath: input.trustedPath,
        repositoryDir: input.sourcePath,
        gitExecutable: input.gitExecutable,
      });
      const checked = await validator.validatePublication({
        base,
        head,
        publishedHead,
        protectedPaths: input.protectedPaths,
      });
      return checked.ok && live(deadline)
        ? portOk({ protectedPathsClear: true })
        : failed();
    },
    inspect(
      pull: NativeAssociationPull,
      deadline: number,
      restoreSource = false,
    ) {
      return observe(
        `refs/heads/${pull.headRef}`,
        pull.head,
        `refs/heads/${pull.baseRef}`,
        pull.base,
        deadline,
        restoreSource,
      );
    },
    restore(ref: string, head: GitSha, base: GitSha, deadline: number) {
      if (!/^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/.test(ref)) {
        return Promise.resolve(failed());
      }
      return observe(ref, head, base, base, deadline, true);
    },
    async isAncestor(
      ancestor: GitSha,
      descendant: GitSha,
      deadline: number,
    ): Promise<PortResultV1<boolean>> {
      if (!isGitSha(ancestor) || !isGitSha(descendant) || !live(deadline)) {
        return failed();
      }
      const result = await runner(deadline)(input.sourcePath, [
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant,
      ], false);
      return result !== null && result.settled && result.exited &&
          !result.truncated &&
          (result.code === 0 || result.code === 1) && live(deadline)
        ? portOk(result.code === 0)
        : failed();
    },
  };
}
