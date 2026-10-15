/** Trusted target-bound capture and replay capabilities. No operational defaults. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import {
  type Clock,
  type IncidentAdapter,
  portError,
  portOk,
  type PortResultV1,
  type ReplayPort,
} from "../contracts/ports.ts";
import {
  parseRepositoryConfigV1,
  type RepositoryConfigV1,
} from "../contracts/repository-config.ts";
import { GatewayIncidentAdapter } from "../adapters/gateway/incident-adapter.ts";
import type { GatewayTransportV1 } from "../adapters/gateway/http.ts";
import { GatewayReplayComposition } from "../adapters/gateway/replay-composition.ts";
import type { GatewaySanitizerPolicyV1 } from "../adapters/gateway/sanitize.ts";
import {
  type ArtifactStoreLimitsV1,
  type ArtifactStoreV1,
  LocalArtifactStore,
} from "../adapters/gateway/store.ts";
import {
  parseObserveAuthHeaders,
  parseObserveReplayKey,
} from "../observe-main.ts";
import { GatewayLocalCausalVerifier } from "../replay/causal-verifier.ts";
import type { GatewayCausalReaderBindingV1 } from "../replay/causal-verifier-contracts.ts";
import { prepareBunFrozenReader } from "../replay/bun-frozen-reader.ts";
import {
  materializeDependencyCache,
  removeDependencyRun,
  type ReplayDependencyCacheV1,
} from "../replay/dependency-cache.ts";
import type { ReplayPolicyV1 } from "../replay/fixture.ts";
import { LinuxReplayIsolation } from "../replay/isolation.ts";
import { ReplayPortImpl } from "../replay/port.ts";
import { validExpectedFailure } from "../replay/causal-verifier-protocol.ts";
import { DenoReplayRuntime, type ReplayRuntimeV1 } from "../replay/runtime.ts";
import { createGatewayAuthProvider } from "./providers.ts";
import { createLocalRepositoryConfig } from "./local-config.ts";
import { selectTrustedTargetPolicyV1 } from "./target-policy.ts";

export interface TargetRepairCapabilitiesV1 {
  incidents: IncidentAdapter;
  replay: ReplayPort;
}

/** Private host policy, supplied by the trusted owner; never matrix/model input. */
export interface TrustedGatewayRuntimeV1 {
  retained: {
    root: string;
    limits: ArtifactStoreLimitsV1;
    /** A supplied backend is used by BOTH capture and replay without substitution. */
    store?: ArtifactStoreV1;
  };
  dependencyCache?: ReplayDependencyCacheV1;
  /** Explicit trusted exact-source registry. An unmatched capture never falls back. */
  readerBindings?: readonly GatewayCausalReaderBindingV1[];
  sanitizer: GatewaySanitizerPolicyV1;
  replayPolicy: ReplayPolicyV1;
  testIds: readonly string[];
  /** The fixed gateway consumer's supported causal classifier. */
  failure: "stream_terminated";
  scratchDir: string;
  transport?: GatewayTransportV1;
  runtime?: ReplayRuntimeV1;
}

export interface PreparedGatewayTargetV1 {
  config: RepositoryConfigV1;
  sourcePath: string;
  sourceSha: GitSha;
  controllerSha: GitSha;
  execution?: HostedExecutionIntentV1;
  denoExecutable: string;
  gitExecutable: string;
}

export interface TrustedGatewayCapabilitiesV1
  extends TargetRepairCapabilitiesV1 {
  /** Private, invocation-bound identity; never an added persisted record key. */
  scopeDigest: string;
  fixtures: GatewayReplayComposition;
  store: ArtifactStoreV1;
}

const UNAVAILABLE = "trusted gateway capability is unavailable";
export function unavailableTargetCapabilities(): TargetRepairCapabilitiesV1 {
  return {
    incidents: {
      listUnresolvedIncidents: () =>
        Promise.resolve(portError("unavailable", UNAVAILABLE)),
      readIncident: () =>
        Promise.resolve(portError("unavailable", UNAVAILABLE)),
      readArtifact: () =>
        Promise.resolve(portError("unavailable", UNAVAILABLE)),
    },
    replay: {
      runReplay: () => Promise.resolve(portError("unavailable", UNAVAILABLE)),
    },
  };
}

export function isGatewayTarget(config: RepositoryConfigV1): boolean {
  return config.repository.owner === "ubiquity" &&
    config.repository.name === "ai.ubq.fi";
}

function validateTarget(
  config: RepositoryConfigV1,
  prepared: PreparedGatewayTargetV1,
): void {
  const policy = selectTrustedTargetPolicyV1(
    createLocalRepositoryConfig(),
    config.repository,
  );
  if (
    !isGatewayTarget(config) || config.repository.installationId < 1 ||
    config.adapter.kind !== "gateway" ||
    config.adapter.baseUrl !== "https://ai.ubq.fi" ||
    canonicalStringify(config) !== canonicalStringify(prepared.config) ||
    canonicalStringify(config.commands) !==
      canonicalStringify(policy.commands) ||
    canonicalStringify(config.commandRegistry) !==
      canonicalStringify(policy.commandRegistry) ||
    policy.protectedPaths.some((path) =>
      !config.protectedPaths.includes(path)
    ) ||
    !isGitSha(prepared.sourceSha) || !isGitSha(prepared.controllerSha) ||
    (prepared.execution !== undefined &&
      prepared.execution.revision !== prepared.controllerSha)
  ) throw new TypeError(UNAVAILABLE);
}

/** Real retained-store/decrypt/sanitizer/causal/replay factory over one prepared mirror. */
export async function createTrustedGatewayCapabilities(input: {
  config: RepositoryConfigV1;
  prepared: PreparedGatewayTargetV1;
  clock: Clock;
  authority: TrustedGatewayRuntimeV1;
  authJson: string;
  replayKeyB64: string;
}): Promise<PortResultV1<TrustedGatewayCapabilitiesV1>> {
  let key: Uint8Array<ArrayBuffer> | undefined;
  try {
    const config = parseRepositoryConfigV1(input.config);
    const prepared = input.prepared;
    validateTarget(config, prepared);
    const authority = {
      ...input.authority,
      dependencyCache: input.authority.dependencyCache === undefined
        ? undefined
        : { ...input.authority.dependencyCache },
      readerBindings: input.authority.readerBindings === undefined
        ? undefined
        : structuredClone(input.authority.readerBindings),
      testIds: [...input.authority.testIds],
      replayPolicy: {
        ...input.authority.replayPolicy,
        bundleScopes: [...input.authority.replayPolicy.bundleScopes],
      },
    };
    if (
      authority.failure !== "stream_terminated" ||
      authority.testIds.length === 0 ||
      authority.testIds.length > 64 ||
      new Set(authority.testIds).size !== authority.testIds.length ||
      authority.testIds.some((id) => !/^[A-Za-z0-9._:-]{1,64}$/.test(id)) ||
      !prepared.sourcePath.startsWith("/") ||
      !authority.scratchDir.startsWith("/tmp/") ||
      !authority.retained.root.startsWith("/") ||
      !prepared.denoExecutable.startsWith("/") ||
      !prepared.gitExecutable.startsWith("/") ||
      await Deno.realPath(prepared.sourcePath) !== prepared.sourcePath
    ) return portError("invalid", UNAVAILABLE);
    await Deno.mkdir(authority.scratchDir, { recursive: true, mode: 0o700 });
    const runtime = authority.runtime ??
      new DenoReplayRuntime("/usr/local/bin:/usr/bin:/bin");
    const git = async (args: string[]): Promise<string> => {
      const result = await runtime.run({
        executable: prepared.gitExecutable,
        args,
        cwd: prepared.sourcePath,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1" },
        maxDurationMs: 30_000,
        maxOutputBytes: 4096,
      });
      if (
        !result.settled || result.truncated || result.exitCode !== 0 ||
        result.outcome !== "exited"
      ) throw new TypeError(UNAVAILABLE);
      return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
        .trim();
    };
    if (
      await git([
          "rev-parse",
          "--verify",
          `refs/remotes/origin/${config.baseBranch}`,
        ]) !== prepared.sourceSha ||
      await git(["remote", "get-url", "origin"]) !==
        "https://github.com/ubiquity/ai.ubq.fi.git"
    ) return portError("invalid", UNAVAILABLE);
    // Verify the actual pinned bytes, protected inputs and runtime BEFORE capture intake.
    let dependencyIdentity: unknown = null;
    const readerIdentities: unknown[] = [];
    if (authority.readerBindings !== undefined) {
      if (
        authority.readerBindings.length === 0 ||
        new Set(authority.readerBindings.map((reader) => reader.sourceSha))
            .size !== authority.readerBindings.length ||
        !authority.readerBindings.some((reader) =>
          reader.sourceSha === prepared.sourceSha
        )
      ) return portError("invalid", UNAVAILABLE);
      for (const reader of authority.readerBindings) {
        if (!isGitSha(reader.sourceSha)) {
          return portError("invalid", UNAVAILABLE);
        }
        if (reader.kind === "bun") {
          const verified = await prepareBunFrozenReader(reader);
          readerIdentities.push({
            binding: verified.binding,
            manifest: verified.manifest,
            bootstrapDigest: verified.bootstrapDigest,
            preflightDigest: verified.preflightDigest,
          });
        } else if (reader.kind === "deno" && reader.denoPath.startsWith("/")) {
          readerIdentities.push(reader);
        } else return portError("invalid", UNAVAILABLE);
      }
    }
    if (
      authority.readerBindings === undefined ||
      authority.readerBindings.some((reader) =>
        reader.kind === "deno" && reader.sourceSha === prepared.sourceSha
      )
    ) {
      const cache = authority.readerBindings?.find((reader) =>
        reader.kind === "deno" && reader.sourceSha === prepared.sourceSha
      );
      const selectedCache = cache?.kind === "deno"
        ? cache.dependencyCache ?? authority.dependencyCache
        : authority.dependencyCache;
      if (selectedCache === undefined) return portError("invalid", UNAVAILABLE);
      const dependencyRun = await materializeDependencyCache(
        selectedCache,
        prepared.sourcePath,
        authority.scratchDir,
      );
      await removeDependencyRun(dependencyRun);
      const manifest = JSON.parse(
        await Deno.readTextFile(`${selectedCache.root}/manifest.json`),
      ) as { runtime: unknown };
      dependencyIdentity = {
        sourceSha: selectedCache.sourceSha,
        manifestDigest: selectedCache.manifestDigest,
        runtime: manifest.runtime,
      };
    }
    const scopeDigest = await canonicalStringifySha256({
      domain: "uos-sentinel-gateway-host-scope-v1",
      config,
      sourceSha: prepared.sourceSha,
      controllerSha: prepared.controllerSha,
      execution: prepared.execution ?? null,
      dependencyCache: dependencyIdentity,
      readerBindings: readerIdentities,
      testIds: authority.testIds,
      failure: authority.failure,
      sanitizer: authority.sanitizer,
      replayPolicy: {
        bundleScopes: authority.replayPolicy.bundleScopes,
        maxFixtureBytes: authority.replayPolicy.maxFixtureBytes,
        maxEntryBytes: authority.replayPolicy.maxEntryBytes,
      },
    });
    const headers = parseObserveAuthHeaders(input.authJson);
    key = parseObserveReplayKey(input.replayKeyB64);
    const store = authority.retained.store ?? new LocalArtifactStore({
      root: authority.retained.root,
      limits: authority.retained.limits,
    });
    if (
      canonicalStringify(store.limits) !==
        canonicalStringify(authority.retained.limits)
    ) return portError("invalid", UNAVAILABLE);
    if (store instanceof LocalArtifactStore && !(await store.open()).ok) {
      return portError("unavailable", UNAVAILABLE);
    }
    const isolation = new LinuxReplayIsolation(authority.scratchDir, {
      dependencyCache: authority.dependencyCache,
    });
    const adapter = new GatewayIncidentAdapter({
      config,
      transport: authority.transport ?? ((url, init) => fetch(url, init)),
      auth: createGatewayAuthProvider(() => headers),
      store,
      clock: input.clock,
    });
    const expectedFailure = {
      reason: "stream terminated unexpectedly",
      match: {
        kind: "contains" as const,
        text: "stream terminated unexpectedly",
      },
    };
    if (!validExpectedFailure(expectedFailure)) {
      return portError("invalid", UNAVAILABLE);
    }
    const composition = new GatewayReplayComposition({
      adapter,
      store,
      repository: config.repository,
      keyBytes: key,
      policy: authority.sanitizer,
      commandId: config.commands.replay,
      testCommandId: config.commands.test,
      testIds: authority.testIds,
      expectedFailure,
      clock: input.clock,
      verifier: {
        verify: (value) => {
          const binding = authority.readerBindings?.find((reader) =>
            reader.sourceSha === value.capture.gitSha
          );
          if (authority.readerBindings !== undefined && binding === undefined) {
            return Promise.resolve(null);
          }
          const causalIsolation = binding?.kind === "bun"
            ? new LinuxReplayIsolation(authority.scratchDir, {
              bunReader: binding,
            })
            : binding?.kind === "deno"
            ? new LinuxReplayIsolation(authority.scratchDir, {
              dependencyCache: binding.dependencyCache ??
                authority.dependencyCache,
            })
            : isolation;
          const root =
            `tests/fixtures/gateway-replay/${value.incidentId}/${value.captureId}`;
          return new GatewayLocalCausalVerifier({
            sourcePath: prepared.sourcePath,
            scratchDir: authority.scratchDir,
            consumerPath: "scripts/replay.ts",
            consumerRequestPath: `${root}/request.json`,
            consumerUpstreamPath: `${root}/upstream.json`,
            denoPath: prepared.denoExecutable,
            readerBindings: authority.readerBindings,
            maxDurationMs:
              config.commandRegistry.commands[config.commands.replay]
                .maxDurationMs,
            maxOutputBytes:
              config.commandRegistry.commands[config.commands.replay]
                .maxOutputBytes,
            isolation: causalIsolation,
            runtime,
          }).verify(value);
        },
      },
    });
    return portOk({
      incidents: composition,
      replay: new ReplayPortImpl({
        config,
        source: { kind: "local", path: prepared.sourcePath },
        scratchDir: authority.scratchDir,
        fixtures: composition,
        policy: authority.replayPolicy,
        isolation,
        runtime,
        clock: input.clock,
      }),
      scopeDigest,
      fixtures: composition,
      store,
    });
  } catch {
    return portError("unavailable", UNAVAILABLE);
  } finally {
    key?.fill(0);
  }
}
