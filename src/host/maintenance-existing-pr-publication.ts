/** Read-only maintenance publication identity; no retained-PR effect capability escapes. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { ExistingPrTakeoverPort } from "../contracts/existing-pr-takeover.ts";
import {
  type Clock,
  type GitHubCooldownGateV1,
  portError,
  portOk,
  type StateReadView,
} from "../contracts/ports.ts";
import { GitHubPrAssociationsClient } from "../github/client-pr-associations.ts";
import { hasTakeoverCustody } from "../github/existing-pr-takeover-provenance.ts";
import { fetchHttpTransport, type HttpTransportV1 } from "../github/http.ts";
import { ISSUE_PULL_ASSOCIATIONS_QUERY } from "../github/pr-association-wire.ts";
import { DenoReplayRuntime, type ReplayRuntimeV1 } from "../replay/runtime.ts";
import type { HostedQueueAuthorityOptions } from "../../ops/hosted-autonomy-queue-authority.ts";
import { DEFAULT_APP_INSTALLATION_ID } from "./actions-target-cycles.ts";
import { createExistingPrTakeover } from "./existing-pr-takeover.ts";
import { createLocalRepositoryConfig } from "./local-config.ts";
import { trustedGitPath } from "./local-io.ts";
import { createDefaultBranchResolver, loadTargetConfigsV1 } from "./targets.ts";

type PublicationPort = Pick<ExistingPrTakeoverPort, "resolvePublication">;
const REPOSITORY = Object.freeze({
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: DEFAULT_APP_INSTALLATION_ID,
});
const TRUSTED_PATH = "/usr/bin:/bin";
const REMOTE = "https://github.com/ubiquity/ai.ubq.fi.git";
const API = "https://api.github.com";
const unavailable = () =>
  portError("unavailable", "maintenance publication custody unavailable");
const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);

/** Construction is inert. Exact merged custody is read lazily under the caller's deadline. */
export function createMaintenancePublicationFor(input: {
  sourceDir: string;
  scratch: string;
  state: Pick<StateReadView, "readRepair" | "readRepairAt">;
  clock: Clock;
  token: string;
  gate: Pick<GitHubCooldownGateV1, "beforeRequest">;
  http?: HttpTransportV1;
  /** Trusted test subprocess seam; production owns the bounded native runtime. */
  runtime?: ReplayRuntimeV1;
}): NonNullable<HostedQueueAuthorityOptions["publicationFor"]> {
  const runtime = input.runtime ?? new DenoReplayRuntime(Deno.execPath());
  const transport = input.http ?? fetchHttpTransport();
  const state = Object.freeze({
    readRepair: () => input.state.readRepair(),
    ...(input.state.readRepairAt === undefined ? {} : {
      readRepairAt: input.state.readRepairAt.bind(input.state),
    }),
  });
  const gate: GitHubCooldownGateV1 = Object.freeze({
    beforeRequest: (installation: number) =>
      installation === REPOSITORY.installationId
        ? input.gate.beforeRequest(installation)
        : Promise.resolve(unavailable()),
    // A durable cooldown observer can write state. This facade never acquires it.
    recordRateLimit: () => Promise.resolve(unavailable()),
  });
  const http: HttpTransportV1 = (request) => {
    const url = new URL(request.url);
    let accepted = url.origin === API && url.search === "" &&
      url.hash === "" && request.method === "GET" &&
      /^\/repos\/ubiquity\/ai\.ubq\.fi(?:\/pulls\/[1-9][0-9]*)?$/.test(
        url.pathname,
      );
    if (
      url.origin === API && url.pathname === "/graphql" &&
      url.search === "" && url.hash === "" && request.method === "POST"
    ) {
      try {
        const body = JSON.parse(request.body ?? "");
        accepted = body.query === ISSUE_PULL_ASSOCIATIONS_QUERY &&
          body.variables?.owner === REPOSITORY.owner &&
          body.variables?.name === REPOSITORY.name;
      } catch {
        accepted = false;
      }
    }
    if (!accepted) return Promise.reject(new Error("maintenance HTTP refused"));
    return transport(request);
  };
  const live = (deadline: number) =>
    Number.isSafeInteger(deadline) && input.clock.now() < deadline;
  let prepared: Promise<PublicationPort | null> | undefined;
  async function prepare(deadline: number): Promise<PublicationPort | null> {
    try {
      if (!live(deadline) || input.token.length === 0) return null;
      const resolveBranch = createDefaultBranchResolver({
        token: input.token,
        http: async (request) => {
          if (
            !live(deadline) || !(await gate.beforeRequest(
              REPOSITORY.installationId,
            )).ok
          ) throw new Error("maintenance target unavailable");
          return http({
            ...request,
            deadlineMs: Math.max(1, deadline - input.clock.now()),
          });
        },
      });
      const targets = await loadTargetConfigsV1({
        root: input.sourceDir,
        template: createLocalRepositoryConfig(),
        resolveDefaultBranch: (target) =>
          target.owner === REPOSITORY.owner && target.name === REPOSITORY.name
            ? resolveBranch(target)
            : Promise.resolve(null),
      });
      const config = targets.configs.find((entry) =>
        entry.repository.owner === REPOSITORY.owner &&
        entry.repository.name === REPOSITORY.name
      );
      if (config?.baseBranch !== "development" || !live(deadline)) return null;
      const sourcePath = await Deno.makeTempDir({
        dir: input.scratch,
        prefix: "sentinel-maintenance-publication-",
      });
      if (!live(deadline)) return null;
      const gitExecutable = trustedGitPath(TRUSTED_PATH);
      const initialized = await runtime.run({
        executable: gitExecutable,
        args: ["-c", "core.hooksPath=/dev/null", "init", "--bare", "--quiet"],
        cwd: sourcePath,
        env: {
          PATH: TRUSTED_PATH,
          HOME: input.scratch,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
        },
        maxDurationMs: Math.min(120_000, deadline - input.clock.now()),
        maxOutputBytes: 1024 * 1024,
      });
      if (
        !live(deadline) || initialized.outcome !== "exited" ||
        !initialized.settled || initialized.truncated ||
        initialized.exitCode !== 0
      ) return null;
      const factory = createExistingPrTakeover({
        repository: REPOSITORY,
        baseBranch: config.baseBranch,
        state,
        clock: input.clock,
        gate,
        token: input.token,
        client: new GitHubPrAssociationsClient({
          repository: REPOSITORY,
          clock: input.clock,
          cooldownGate: gate,
          http,
          apiBaseUrl: API,
          auth: {
            authorizationHeader: () =>
              Promise.resolve(portOk(`Bearer ${input.token}`)),
          },
        }, null),
        port: {
          readRef: () => Promise.resolve(unavailable()),
          pushHead: () => Promise.resolve(unavailable()),
        },
        sourcePath,
        scratch: input.scratch,
        trustedPath: TRUSTED_PATH,
        gitExecutable,
        remoteUrl: REMOTE,
        protectedPaths: config.protectedPaths,
        runtime,
        policy: Object.freeze({ activated: false }),
        runtimeCapabilityAccepted: () => false,
        contentsWriteAllowed: () => false,
      });
      return Object.freeze({ resolvePublication: factory.resolvePublication });
    } catch {
      return null;
    }
  }
  const port: PublicationPort = Object.freeze({
    async resolvePublication(request) {
      try {
        if (
          !live(request.deadline) || !hasTakeoverCustody(request.record) ||
          !same(request.record.repository, REPOSITORY)
        ) return unavailable();
        prepared ??= prepare(request.deadline);
        const reader = await prepared;
        return reader === null || !live(request.deadline)
          ? unavailable()
          : await reader.resolvePublication(request);
      } catch {
        return unavailable();
      }
    },
  });
  return (repository) => same(repository, REPOSITORY) ? port : undefined;
}
