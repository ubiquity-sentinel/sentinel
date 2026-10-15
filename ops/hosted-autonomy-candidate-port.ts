/** Maintenance exposes only exact blocked-candidate preservation and its ref read. */
import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
  StateReadView,
} from "../src/contracts/ports.ts";
import { portError, portOk } from "../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../src/contracts/repository-config.ts";
import type { HttpTransportV1 } from "../src/github/http.ts";
import type { ReviewServiceTransportV1 } from "../src/github/review-service.ts";
import { composeGitHubHost } from "../src/host/github.ts";
import { createCandidatePreserver } from "../src/host/actions-candidates-preserve.ts";
import { createLocalCandidateLoader } from "../src/host/local-candidate.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";
import { blockedCandidateBinding } from "../src/host/matrix-blocked-candidate.ts";

export function createHostedCandidateRecoveryPort(input: {
  state: StateReadView;
  clock: Clock;
  gate: GitHubCooldownGateV1;
  config: RepositoryConfigV1;
  token: string;
  http: HttpTransportV1;
  sourcePath: string;
  scratch: string;
  remoteUrl: string;
}): GitHubPort {
  const refuse = () =>
    Promise.reject(new Error("C maintenance capability refused"));
  const host = composeGitHubHost({
    repository: input.config.repository,
    clock: input.clock,
    http: input.http,
    cooldownGate: input.gate,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk(`Bearer ${input.token}`)),
    },
    reviewService: new Proxy({}, {
      get: () => refuse,
    }) as ReviewServiceTransportV1,
    trustedPrAuthor: "ubiquity-sentinel[bot]",
    trustedReviewer: "ubiquity-sentinel[bot]",
    trustedResolutionAuthors: [],
    git: {
      localDir: input.sourcePath,
      remoteUrl: input.remoteUrl,
      gitHome: input.scratch,
      extraEnv: githubGitAuthEnv(input.token, input.remoteUrl),
      gitPath: "/usr/bin/git",
    },
  });
  const preserve = createCandidatePreserver({
    state: input.state,
    gate: input.gate,
    token: input.token,
    http: input.http,
    clock: input.clock,
    sourcePath: input.sourcePath,
    scratch: input.scratch,
    trustedPath: "/usr/bin:/bin",
    gitExecutable: "/usr/bin/git",
    repository: input.config.repository,
    remoteUrl: input.remoteUrl,
    port: host.port,
    protectedPaths: input.config.protectedPaths,
    ensureLocalCandidate: createLocalCandidateLoader({
      stateRoot: input.scratch,
      sourcePath: input.sourcePath,
      scratch: input.scratch,
      trustedPath: "/usr/bin:/bin",
    }),
  });
  const readBound = async (ref: string) => {
    const read = await input.state.readRepair();
    if (!read.ok || read.value.status !== "found") return false;
    return read.value.snapshot.work.some((row) =>
      blockedCandidateBinding(row) !== null && row.intent?.branch === ref &&
      row.repository.owner === input.config.repository.owner &&
      row.repository.name === input.config.repository.name &&
      row.repository.installationId === input.config.repository.installationId
    );
  };
  return new Proxy({} as GitHubPort, {
    get: (_, key) => {
      if (key === "readRef") {
        return async (ref: string) =>
          await readBound(ref) ? host.port.readRef(ref) : portError(
            "unavailable",
            "historical preservation binding unavailable",
          );
      }
      if (key === "preserveCandidate") {
        return async (
          request: Parameters<GitHubPort["preserveCandidate"]>[0],
        ) =>
          await readBound(request.candidate.ref)
            ? preserve(request)
            : portError(
              "unavailable",
              "historical preservation binding unavailable",
            );
      }
      return refuse;
    },
  });
}
