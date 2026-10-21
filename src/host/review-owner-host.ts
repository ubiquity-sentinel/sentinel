/** Protected parent construction, using the actual Actions preparer's fixed paths. */
import { parseHostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";
import { resolveExecutable } from "./actions-host-io.ts";
import { parseAppInstallationId } from "./actions-target-cycles.ts";
import { codexChildEnv } from "./local-client.ts";
import { joinPath } from "./local-io.ts";
import {
  LOCAL_REPOSITORY,
  REVIEW_SESSION_DEADLINE_MS,
} from "./local-policy.ts";
import { readTargetSlugsV1, TARGETS_FILE_NAME } from "./targets.ts";
import {
  type LauncherReviewSessionTargetV1,
  ReviewOwnerCustodyBroker,
} from "./review-owner-custody.ts";
import {
  readCleanGitHead,
  resolveRuntimeDirectories,
} from "./hosted-runtime-child.ts";
import {
  parseHostedEnvironment,
  readHostedRuntimeExecution,
  unavailableResult,
} from "./hosted-runtime-identity.ts";
import type {
  HostedRuntimeLauncherInputV1,
  HostedRuntimeLauncherResultV1,
} from "./hosted-runtime-identity.ts";
import { runtimeJob } from "./hosted-runtime-matrix.ts";
import { runHostedRuntimeLauncher } from "./hosted-runtime-launcher.ts";

const UNAVAILABLE = "protected review owner configuration unavailable";

/** Validate only the explicit future path; never search alternative checkouts. */
async function knownDirectory(root: string, relative: string): Promise<string> {
  let current = root;
  for (const part of relative.split("/")) {
    if (!part || part === "." || part === "..") throw new Error(UNAVAILABLE);
    current = joinPath(current, part);
    try {
      const info = await Deno.lstat(current);
      if (
        !info.isDirectory || info.isSymlink ||
        await Deno.realPath(current) !== current ||
        (info.mode !== null && (info.mode & 0o077) !== 0)
      ) throw new Error(UNAVAILABLE);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error(UNAVAILABLE);
      }
      // These exact paths are created by the trusted repair preparer later.
    }
  }
  return current;
}

export async function createHostedReviewOwnerCustody(
  input: {
    execution: HostedExecutionIntentV1;
    runtimeDir: string;
    env: Record<string, string | undefined>;
  },
): Promise<ReviewOwnerCustodyBroker> {
  try {
    const execution = parseHostedExecutionIntentV1(input.execution);
    if (execution.purpose !== "ordinary") throw new Error(UNAVAILABLE);
    const root = await Deno.realPath(input.runtimeDir);
    if (root !== input.runtimeDir) throw new Error(UNAVAILABLE);
    const trustedPath = input.env.PATH;
    if (
      !trustedPath ||
      trustedPath.split(":").some((part) => !part.startsWith("/"))
    ) {
      throw new Error(UNAVAILABLE);
    }
    const codexExecutable = await resolveExecutable("codex", trustedPath);
    const binary = await Deno.lstat(codexExecutable);
    if (
      !binary.isFile || binary.isSymlink ||
      (binary.mode !== null && (binary.mode & 0o111) === 0)
    ) throw new Error(UNAVAILABLE);
    const setting = await Deno.lstat(joinPath(root, TARGETS_FILE_NAME));
    if (!setting.isFile || setting.isSymlink || setting.size > 64 * 1024) {
      throw new Error(UNAVAILABLE);
    }
    const slugs = await readTargetSlugsV1({ root });
    if (slugs.length === 0) throw new Error(UNAVAILABLE);
    const foreign = slugs.some((target) =>
      target.owner !== LOCAL_REPOSITORY.owner ||
      target.name !== LOCAL_REPOSITORY.name
    );
    const appInstallation = foreign
      ? parseAppInstallationId(
        input.env.SENTINEL_APP_INSTALLATION_ID || undefined,
      )
      : 0;
    const state = ".sentinel-actions-state";
    const home = await knownDirectory(root, `${state}/clients/review`);
    const tmp = await knownDirectory(root, `${state}/tmp/review`);
    const deno = await knownDirectory(root, `${state}/deno/review`);
    // Only file metadata is inspected; no token or client credential is read.
    for (const name of ["config.toml", "model.token"]) {
      try {
        const info = await Deno.lstat(joinPath(home, name));
        if (
          !info.isFile || info.isSymlink ||
          (info.mode !== null && (info.mode & 0o077) !== 0)
        ) throw new Error(UNAVAILABLE);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw new Error(UNAVAILABLE);
        }
      }
    }
    const paths = new Set<string>();
    const targets: LauncherReviewSessionTargetV1[] = [];
    for (const target of slugs) {
      const self = target.owner === LOCAL_REPOSITORY.owner &&
        target.name === LOCAL_REPOSITORY.name;
      const cwd = await knownDirectory(
        root,
        self
          ? `${state}/review-checkout`
          : `${state}/review-checkouts/${target.owner}-${target.name}`,
      );
      if (paths.has(cwd)) throw new Error(UNAVAILABLE);
      paths.add(cwd);
      targets.push({
        repository: parseRepositoryIdentity({
          owner: target.owner,
          name: target.name,
          installationId: self
            ? LOCAL_REPOSITORY.installationId
            : appInstallation,
        }, "$.repository"),
        permissionProfile: "sentinel-review",
        session: {
          command: [codexExecutable, "app-server"],
          cwd,
          env: codexChildEnv(home, tmp, deno, trustedPath),
          operationDeadlineMs: REVIEW_SESSION_DEADLINE_MS,
        },
      });
    }
    return new ReviewOwnerCustodyBroker(execution, targets);
  } catch {
    throw new Error(UNAVAILABLE);
  }
}

/** The production parent verifies source and native custody before any broker exists. */
export async function runHostedRuntimeWithReviewCustody(
  input: HostedRuntimeLauncherInputV1,
): Promise<HostedRuntimeLauncherResultV1> {
  let custody: ReviewOwnerCustodyBroker | undefined;
  let handedToLauncher = false;
  try {
    const job = runtimeJob(input.env.GITHUB_JOB);
    if (job !== "repair") return await runHostedRuntimeLauncher(input);
    const identity = parseHostedEnvironment(input.env, job);
    const dirs = await resolveRuntimeDirectories(
      input.launcherDir,
      input.runtimeDir,
    );
    if (
      await readCleanGitHead(input.process, dirs.launcher) !==
        identity.launcherSha
    ) {
      throw new Error(UNAVAILABLE);
    }
    const revision = await readCleanGitHead(input.process, dirs.runtime);
    if (revision === null) throw new Error(UNAVAILABLE);
    const execution = await readHostedRuntimeExecution({
      state: input.state,
      identity,
      controllerSha: revision,
    });
    if (execution.purpose !== "ordinary") {
      return await runHostedRuntimeLauncher(input);
    }
    custody = await createHostedReviewOwnerCustody({
      execution,
      runtimeDir: dirs.runtime,
      env: input.env,
    });
    // The launcher revalidates the same exact source/pointer before starting the channel.
    handedToLauncher = true;
    return await runHostedRuntimeLauncher({ ...input, reviewCustody: custody });
  } catch {
    return unavailableResult();
  } finally {
    if (!handedToLauncher) await custody?.dispose();
  }
}
