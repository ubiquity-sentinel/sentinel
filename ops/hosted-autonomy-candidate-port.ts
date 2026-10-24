/** Maintenance exposes only exact candidate and conflict-merge preservation and its ref read. */
import type {
  Clock,
  GitHubCooldownGateV1,
  GitHubPort,
  StateReadView,
} from "../src/contracts/ports.ts";
import { portError, portOk } from "../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../src/contracts/repository-config.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import { conflictResolutionInFlight } from "../src/repair/conflict-resolution.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
} from "../src/repair/keys.ts";
import type { HttpTransportV1 } from "../src/github/http.ts";
import type { ReviewServiceTransportV1 } from "../src/github/review-service.ts";
import { composeGitHubHost } from "../src/host/github.ts";
import { createCandidatePreserver } from "../src/host/actions-candidates-preserve.ts";
import type { CandidateProofPassV1 } from "../src/host/actions-candidates-proof.ts";
import { createMaintenanceNativeQueue } from "../src/host/maintenance-native-queue.ts";
import { createLocalCandidateLoader } from "../src/host/local-candidate.ts";
import { githubGitAuthEnv } from "../src/host/local.ts";
import { restorableCandidate } from "./hosted-autonomy-blocked-candidate.ts";

/**
 * The exact operation ref an in-flight conflict resolution's merge M is
 * preserved under before its receipt is consumed (`preserveConflictMerge`):
 * the refresh binding of the record's own (PR, H) and its marked base B. Any
 * record without the marked implementation intent at `work` has none. The
 * preserver itself re-proves the full binding (the task's one charge, the
 * published descriptor, M's parents) before any remote read.
 */
export async function inflightConflictMergeRef(
  record: WorkRecordV1,
): Promise<string | null> {
  const mergeBase = conflictResolutionInFlight(record.intent);
  const { head, pr } = record.target;
  if (
    mergeBase === null || record.nextStep !== "work" ||
    record.source.kind !== "issue" || head === null || pr === null
  ) return null;
  return await candidatePreservationRef(
    record.repository,
    record.id,
    baseRefreshIntentKey(pr, head, mergeBase),
  );
}

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
  /** The owning producer pass's one fresh proof store per target (#185). */
  proofPass?: CandidateProofPassV1;
}): GitHubPort {
  const refuse = () =>
    Promise.reject(new Error("C maintenance capability refused"));
  const nativeQueue = createMaintenanceNativeQueue({
    ...input,
    repository: input.config.repository,
  });
  const host = composeGitHubHost({
    repository: input.config.repository,
    clock: input.clock,
    http: input.http,
    cooldownGate: input.gate,
    nativeQueue,
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
    ...(input.proofPass === undefined ? {} : { proofPass: input.proofPass }),
  });
  // A ref opens only for a record of this repository that is bound to it:
  // a restorable candidate's own preservation intent, or the merge of an
  // in-flight conflict resolution, which a consumer of its late cell must
  // preserve before the receipt is consumed (M lives in no other ref, and
  // this pass's mirror is discarded).
  const readBound = async (ref: string) => {
    const read = await input.state.readRepair();
    if (!read.ok || read.value.status !== "found") return false;
    for (const row of read.value.snapshot.work) {
      if (
        row.repository.owner !== input.config.repository.owner ||
        row.repository.name !== input.config.repository.name ||
        row.repository.installationId !==
          input.config.repository.installationId
      ) continue;
      if (restorableCandidate(row) && row.intent?.branch === ref) return true;
      if (await inflightConflictMergeRef(row) === ref) return true;
    }
    return false;
  };
  return new Proxy({} as GitHubPort, {
    get: (_, key) => {
      if (key === "nativeQueue") return nativeQueue;
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
