/**
 * Production delivery-train git for the maintenance launcher (sentinel #330).
 *
 * One private bare object store per target repository under the job's
 * scratch, the trusted deterministic executor (`DenoGitExecutor`:
 * `merge-tree --write-tree` integration, carried-patch proof and the guarded
 * non-force push) over the target's own authenticated remote, and two
 * bounded git operations of its own: the exact-commit fetch of the tip and
 * member heads before a composition, and the lease-guarded deletion of an
 * ended train ref (only while it still names exactly the pushed commit).
 * Credentials reach git only through the scoped `http.<remote>.extraheader`
 * environment (`githubGitAuthEnv`), never a URL, file or log line.
 *
 * `triggerCi` stays undefined: the train ref push runs every target workflow
 * that triggers on `push`. A target whose CI runs only on pull requests needs
 * an owner change (a push trigger for `sentinel-trains/**`, or an explicit
 * dispatch capability); until then its trains read `unavailable` and their
 * members fall back to the per-record path after the CI wait bound.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { deliveryTrainPath } from "../src/state/delivery-train-store.ts";
import { DenoGitExecutor } from "../src/github/git-executor.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";
import { gitDeliveryTrainComposer } from "./hosted-autonomy-train-compose.ts";
import type { DeliveryTrainComposerV1 } from "./hosted-autonomy-train-types.ts";
import { isGatewayVpsRepository } from "../src/repair/vps-delivery.ts";
import { isHostedSelf } from "./hosted-autonomy-policy.ts";

/** Bound of one fetch or ref deletion. */
const GIT_TIMEOUT_MS = 120_000;
const SHA = /^[0-9a-f]{40}$/;
const TRAIN_REF = /^refs\/heads\/sentinel-trains\/[0-9a-f]{24}$/;

export interface TrainGitOptionsV1 {
  /** Private scratch directory of this job. */
  scratch: string;
  /** The target's token (contents write), or null: no train there. */
  tokenFor(repository: RepositoryIdentityV1): string | null;
  /** The target's remote (default `https://github.com/<owner>/<name>.git`). */
  remoteUrlFor?(repository: RepositoryIdentityV1): string;
  gitPath?: string;
}

async function run(
  git: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const out = await new Deno.Command(git, {
      args: ["-c", "core.hooksPath=/dev/null", ...args],
      cwd,
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    }).output();
    return { ok: out.success, stdout: new TextDecoder().decode(out.stdout) };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/** The per-target composer factory the delivery pass's deps carry. */
export function createTrainComposerFor(
  options: TrainGitOptionsV1,
): (repository: RepositoryIdentityV1) => DeliveryTrainComposerV1 | null {
  const composers = new Map<string, DeliveryTrainComposerV1>();
  const git = options.gitPath ?? "git";
  return (repository) => {
    const path = deliveryTrainPath(repository);
    if (
      path === null || isHostedSelf(repository) ||
      isGatewayVpsRepository(repository)
    ) return null;
    const cached = composers.get(path);
    if (cached !== undefined) return cached;
    const token = options.tokenFor(repository);
    if (token === null || token.length === 0) return null;
    const remoteUrl = options.remoteUrlFor?.(repository) ??
      `https://github.com/${repository.owner}/${repository.name}.git`;
    const name = path.slice("trains/".length, -".json".length);
    const localDir = `${options.scratch}/delivery-train-git/${name}`;
    const home = `${options.scratch}/delivery-train-git/home`;
    const auth = githubGitAuthEnv(token, remoteUrl);
    const env = {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...auth,
    };
    let ready: Promise<boolean> | undefined;
    const init = () =>
      ready ??= (async () => {
        try {
          await Deno.mkdir(localDir, { recursive: true, mode: 0o700 });
          await Deno.mkdir(home, { recursive: true, mode: 0o700 });
        } catch {
          return false;
        }
        return (await run(git, ["init", "-q", "--bare"], localDir, env)).ok;
      })();
    const present = async (sha: string) =>
      (await run(git, ["cat-file", "-e", `${sha}^{commit}`], localDir, env))
        .ok;
    const executor = new DenoGitExecutor({
      localDir,
      remoteUrl,
      gitHome: home,
      gitPath: git,
      extraEnv: auth,
    });
    const composer = gitDeliveryTrainComposer(executor, {
      async ensureObjects(shas) {
        if (!await init() || shas.some((sha) => !SHA.test(sha))) return false;
        const missing: string[] = [];
        for (const sha of shas) if (!await present(sha)) missing.push(sha);
        if (missing.length === 0) return true;
        // GitHub serves any reachable commit by its exact id.
        await run(
          git,
          [
            "fetch",
            "-q",
            "--no-tags",
            "--no-write-fetch-head",
            remoteUrl,
            ...missing,
          ],
          localDir,
          env,
        );
        for (const sha of missing) if (!await present(sha)) return false;
        return true;
      },
      async retire({ ref, sha }) {
        if (!TRAIN_REF.test(ref) || !SHA.test(sha) || !await init()) {
          return "unavailable";
        }
        const deleted = await run(
          git,
          [
            "push",
            "-q",
            `--force-with-lease=${ref}:${sha}`,
            remoteUrl,
            `:${ref}`,
          ],
          localDir,
          env,
        );
        const listed = await run(
          git,
          ["ls-remote", remoteUrl, ref],
          localDir,
          env,
        );
        if (!listed.ok) return "unavailable";
        const line = listed.stdout.trim();
        if (line.length === 0) return "retired";
        if (deleted.ok) return "unavailable";
        return line.startsWith(`${sha}\t`) ? "unavailable" : "moved";
      },
    });
    composers.set(path, composer);
    return composer;
  };
}
