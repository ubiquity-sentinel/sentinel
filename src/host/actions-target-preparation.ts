/**
 * One committed target's private hosted state: its exact source mirror and
 * independent review checkout directories, the mirror's preparation from its
 * own authenticated remote at its own base branch, and the trusted capability
 * pair resolved only after that preparation. The host composition supplies
 * every bound input (the per-target credential selection, the shared cooldown
 * gate, the run's private paths); this module never chooses a token or a
 * target of its own.
 */
import { asGitSha, type GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { Clock, GitHubCooldownGateV1 } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import { optionalEnv } from "./actions-host-io.ts";
import {
  type ActionsRepairHostDepsV1,
  STATIC_TARGET_UNKNOWN,
} from "./actions-target-cycles.ts";
import {
  createTrustedGatewayCapabilities,
  isGatewayTarget,
  type TargetRepairCapabilitiesV1,
  unavailableTargetCapabilities,
} from "./gateway-capabilities.ts";
import {
  joinPath,
  type LocalRepairHostOptionsV1,
  prepareSourceRepository,
  refreshDevelopment,
  unavailableIncidents,
  unavailableReplay,
} from "./local.ts";
import { isReadOnlyCellJob } from "./repair-cell-job.ts";

/** The exact inputs one hosted run has bound before it prepares any target. */
export interface ActionsTargetPreparationInputV1 {
  deps: ActionsRepairHostDepsV1;
  readEnv: (name: string) => string | undefined;
  clock: Clock;
  /** The trusted sentinel self-repository template. */
  templateConfig: RepositoryConfigV1;
  /** Every committed, usable target configuration, in setting order. */
  targetConfigs: readonly RepositoryConfigV1[];
  stateRoot: string;
  /** The sentinel self mirror, already prepared from this run's checkout. */
  sourcePath: string;
  /** The sentinel self-target's independent review checkout. */
  reviewCheckout: string;
  scratch: string;
  hostInput: LocalRepairHostOptionsV1;
  /** The run's bound per-target write credential selection. */
  tokenFor: (config: RepositoryConfigV1) => string;
  gate: GitHubCooldownGateV1;
  gitExecutable: string;
  trustedPath: string;
  controllerSha: GitSha;
  execution: HostedExecutionIntentV1;
  denoExecutable: string;
}

/** Per-target private paths, mirror preparation and capabilities of one run. */
export function createActionsTargetPreparation(
  input: ActionsTargetPreparationInputV1,
) {
  const {
    deps,
    readEnv,
    clock,
    templateConfig,
    targetConfigs,
    stateRoot,
    sourcePath,
    reviewCheckout,
    scratch,
    hostInput,
    tokenFor,
    gate,
    gitExecutable,
    trustedPath,
    controllerSha,
    execution,
    denoExecutable,
  } = input;
  /**
   * Exact private mirror directory for one committed target. The sentinel
   * self-target keeps the original single `source` mirror so every existing
   * path, checkpoint and candidate object of the self-repair lane is
   * unchanged; every other target gets its own directory derived from its
   * validated owner/name.
   */
  /**
   * Exact independent review checkout for one target. It is a real clone of
   * THAT target's mirror, created and detached inside the review snapshot
   * capture, so a review can never read another repository's objects or carry
   * a previous target's checkout state into this target's snapshot.
   */
  const reviewCheckoutFor = (config: RepositoryConfigV1): string =>
    config.repository.owner === templateConfig.repository.owner &&
      config.repository.name === templateConfig.repository.name
      ? reviewCheckout
      : joinPath(
        stateRoot,
        "review-checkouts",
        `${config.repository.owner}-${config.repository.name}`,
      );
  const mirrorPathFor = (config: RepositoryConfigV1): string =>
    config.repository.owner === templateConfig.repository.owner &&
      config.repository.name === templateConfig.repository.name
      ? sourcePath
      : joinPath(
        stateRoot,
        "sources",
        `${config.repository.owner}-${config.repository.name}`,
      );
  /** The exact mirror each requested repository must be served from. */
  const sourcePathBySlug = new Map<string, string>();
  for (const config of targetConfigs) {
    sourcePathBySlug.set(
      `${config.repository.owner}/${config.repository.name}`,
      mirrorPathFor(config),
    );
  }

  /**
   * Prepare ONE target's own private state immediately before its cycle: its
   * mirror seeded from its own authenticated remote, fetched at its own base
   * branch through the shared cooldown gate. The sentinel self-target is
   * already prepared above from this run's own checkout, so it needs nothing
   * here and its existing path is unchanged. A foreign target's preparation
   * failure is contained to that target by the loop, which records it as
   * failed rather than treating it as addressed.
   */
  const capabilitiesByConfig = new Map<string, TargetRepairCapabilitiesV1>();
  const preparedTargets = new Set<string>();
  const prepareTarget = async (config: RepositoryConfigV1): Promise<void> => {
    const slug = `${config.repository.owner}/${config.repository.name}`;
    const committed = targetConfigs.find((entry) =>
      canonicalStringify(entry) === canonicalStringify(config)
    );
    if (
      committed === undefined ||
      sourcePathBySlug.get(slug) !== mirrorPathFor(config)
    ) throw new Error(STATIC_TARGET_UNKNOWN);
    if (preparedTargets.has(canonicalStringify(config))) return;
    if (deps.prepareTarget !== undefined) {
      await deps.prepareTarget(config, mirrorPathFor(config));
    } else if (mirrorPathFor(config) !== sourcePath) {
      const remoteUrl =
        `https://github.com/${config.repository.owner}/${config.repository.name}.git`;
      // A foreign target's mirror MUST authenticate with the App token, never the
      // native Actions token. The native token is scoped to the sentinel
      // repository, and Git applies an `http.<url>.extraheader` to that url: the
      // header is then SENT, the server rejects the credential, and Git fails
      // with "could not read Username" instead of falling back to anonymous
      // access. That is why a public foreign repository still could not be
      // cloned or fetched while the same operation succeeds with the App token.
      const targetInput = { ...hostInput, githubToken: tokenFor(config) };
      await prepareSourceRepository(
        mirrorPathFor(config),
        targetInput,
        scratch,
        remoteUrl,
      );
      await refreshDevelopment(
        mirrorPathFor(config),
        targetInput,
        scratch,
        gate,
        config.repository.installationId,
        { remoteUrl, baseBranch: config.baseBranch },
      );
    }
    // Only a trusted controller receives private capture capabilities. Model cells never do.
    let capabilities: TargetRepairCapabilitiesV1 = {
      incidents: unavailableIncidents,
      replay: unavailableReplay,
    };
    if (isGatewayTarget(config)) {
      capabilities = unavailableTargetCapabilities();
      if (!isReadOnlyCellJob(deps.job) && deps.gateway !== undefined) {
        const native = new DenoReplayRuntime(trustedPath);
        const base = await native.run({
          executable: gitExecutable,
          args: [
            "rev-parse",
            "--verify",
            `refs/remotes/origin/${config.baseBranch}`,
          ],
          cwd: mirrorPathFor(config),
          env: { PATH: trustedPath, GIT_CONFIG_NOSYSTEM: "1" },
          maxDurationMs: 30_000,
          maxOutputBytes: 4096,
        });
        if (
          base.outcome === "exited" && base.exitCode === 0 && base.settled &&
          !base.truncated
        ) {
          const resolved = await createTrustedGatewayCapabilities({
            config,
            prepared: {
              config,
              sourcePath: mirrorPathFor(config),
              sourceSha: asGitSha(
                new TextDecoder("utf-8", { fatal: true }).decode(base.stdout)
                  .trim(),
              ),
              controllerSha,
              execution,
              denoExecutable,
              gitExecutable,
            },
            clock,
            authority: deps.gateway,
            authJson: optionalEnv(readEnv, "SENTINEL_GATEWAY_AUTH_JSON") ?? "",
            replayKeyB64: optionalEnv(readEnv, "SENTINEL_REPLAY_KEY_B64") ?? "",
          });
          if (resolved.ok) capabilities = resolved.value;
        }
      }
    }
    capabilitiesByConfig.set(canonicalStringify(config), capabilities);
    preparedTargets.add(canonicalStringify(config));
  };

  return {
    reviewCheckoutFor,
    mirrorPathFor,
    sourcePathBySlug,
    capabilitiesByConfig,
    prepareTarget,
  };
}
