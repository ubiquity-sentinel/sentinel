import type { ExistingPrTakeoverPort } from "../contracts/existing-pr-takeover.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type {
  ReviewOwnerCustodyV1,
  ReviewOwnerSettlementResolverV1,
} from "../github/review-owner-evidence.ts";
import { ReviewOwnerChannelClient } from "./review-owner-channel.ts";
import {
  type Clock,
  type GitHubCooldownGateV1,
  type GitHubIssueV1,
  type GitHubPort,
  portError,
  portOk,
  type PortResultV1,
  type RepairStateWriter,
  type StateReadView,
} from "../contracts/ports.ts";
import {
  parseRepositoryIdentity,
  type RepositoryIdentityV1,
} from "../contracts/shared.ts";
import { GATEWAY_PROVIDER, type ModelRouteV1 } from "./model-route.ts";
import type { GitHubAuthProviderV1 } from "../github/auth.ts";
import { GitHubPrAssociationsClient } from "../github/client-pr-associations.ts";
import {
  createExistingPrTakeover,
  type ExistingPrTakeoverHostInput,
} from "./existing-pr-takeover.ts";
import { createQueueProvenanceReader } from "../github/queue-delivery-provenance.ts";
import { createQueueDeliveryReader } from "../github/queue-delivery-reader.ts";
import type { ExistingPrTakeoverPolicy } from "../github/existing-pr-takeover-policy.ts";
import { createNativeQueueGuard } from "../github/native-queue-guard.ts";
import {
  type QueueRuntimeConfiguration,
  resolveQueueRuntimeConfiguration,
} from "../github/queue-runtime-policy.ts";
import type { HttpTransportV1 } from "../github/http.ts";
import type { BackupCiConsumerV1 } from "../github/backup-ci-observations.ts";
import { GitReviewSnapshot } from "../github/review-snapshot.ts";
import { CodexStructuredReviewer } from "../github/codex-reviewer.ts";
import { GitHubCodexReviewTransport } from "../github/codex-review-transport.ts";
import { CodexSubprocessSession } from "../repair/codex-transport.ts";
import { composeGitHubHost } from "./github.ts";
import {
  createCandidatePreserver,
  createLegacyBaseRefreshLossProver,
} from "./actions-candidates.ts";
import {
  API_BASE_URL,
  GIT_MAX_OUTPUT_BYTES,
  GIT_TIMEOUT_MS,
  LOCAL_BASE_BRANCH,
  LOCAL_REPOSITORY,
  REVIEW_SESSION_DEADLINE_MS,
  STATIC_GITHUB_REPOSITORY,
} from "./local-policy.ts";
import { createLocalRepositoryConfig } from "./local-config.ts";
import { selectTrustedTargetPolicyV1 } from "./target-policy.ts";
import {
  createPrepareBaseRefresh,
  STATIC_BASE_REFRESH_BASE_MOVED,
  STATIC_BASE_REFRESH_BASE_OBJECTS,
  STATIC_BASE_REFRESH_BASE_REPOSITORY,
} from "./local-base-refresh.ts";
import { githubGitAuthEnv } from "./local-github-auth.ts";
import { createLocalCandidateLoader } from "./local-candidate.ts";
import { codexChildEnv, type LocalSessionTracker } from "./local-client.ts";
import { prepareReviewCheckout } from "./local-review-checkout.ts";
import { refreshDevelopment } from "./local-git.ts";
import { trustedGitPath } from "./local-io.ts";
import { BaseTaskReviewService } from "../github/base-review-service.ts";
import type { BaseTaskReviewGitHubV1 } from "../repair/loop-base-satisfaction.ts";

// ---------------------------------------------------------------------------
// GitHub composition (one client, one gate, one actor)
// ---------------------------------------------------------------------------

export interface LocalGitHubInputV1 {
  /** Trusted runtime composition only; produces a durable non-PR owner journal. */
  onOwnerSuccessorReviewPorts?: (
    ports: import("./owner-successor-acceptance.ts").OwnerSuccessorReviewPorts,
  ) => void;
  clock: Clock;
  state: StateReadView & RepairStateWriter;
  gate: GitHubCooldownGateV1;
  http: HttpTransportV1;
  token: string;
  login: string;
  invocationId: string;
  /**
   * Exact private state root this host owns: the trusted source `checkouts`
   * mapping and the owned scratch used by candidate preservation.
   */
  stateRoot: string;
  sourcePath: string;
  scratch: string;
  reviewCheckout: string;
  reviewClientHome: string;
  reviewTmpDir: string;
  reviewDenoDir: string;
  trustedPath: string;
  codexExecutable: string;
  tracker: LocalSessionTracker;
  /**
   * Optional trusted capability: ensure the exact candidate base/head objects
   * exist in the private source repository before a review snapshot capture or
   * an ancestry check. Ordinary local callers omit it (behavior unchanged).
   */
  ensureCandidateObjects?: (
    input: {
      base: GitSha;
      head: GitSha;
      /**
       * Exact repository the objects belong to. A multi-target host owns one
       * source mirror and one authenticated remote per target, and the objects
       * of a foreign target exist only in that target's mirror and remote.
       */
      repository: RepositoryIdentityV1;
    },
  ) => Promise<PortResultV1<void>>;
  /** Provider endpoint used by the isolated reviewer client. */
  modelBaseUrl?: string;
  /**
   * Trusted route selection. The composed reviewer submits the route's
   * provider (the same provider the review client config names) with the
   * dedicated `reviewModelId`, so a route-selected fallback never submits a
   * provider the config lacks. The review model is never the route's model.
   * Omitted callers keep the primary gateway provider; an unset review model
   * makes the reviewer refuse at prepare.
   */
  route?: ModelRouteV1;
  /**
   * Dedicated structured-review model id, resolved from
   * `SENTINEL_REVIEW_MODEL_ID` by `resolveReviewModelId`. The reviewer
   * submits ONLY this model: it is never the shared implementation route's
   * model, so pointing reviews at `codex-auto-review` cannot hijack the
   * implementation worker's model. An unset or invalid value yields the
   * invalid empty sentinel, which the reviewer refuses at prepare before
   * any session opens.
   */
  reviewModelId?: string;
  /**
   * Optional exact repository identity this port is composed for. Omitted
   * callers keep the frozen sentinel identity, so every existing call site is
   * unchanged. A multi-target host supplies the committed target's own
   * identity: the REST client, the review service, the trusted git remote and
   * the cooldown scope then all address exactly this repository and no other.
   * The remote URL is derived from the validated owner/name.
   */
  repository?: RepositoryIdentityV1;
  /**
   * Optional GitHub installation scope for every gated request this port
   * makes. Defaults to the composed repository's own installation id, which is
   * `LOCAL_REPOSITORY.installationId` (0, the reserved no-App owner scope)
   * when no repository is supplied.
   */
  installationId?: number;
  /**
   * Exact base branch this port's reconciliation and proofs must target. A
   * multi-target host supplies the target's own default branch (the same value
   * the cycle reads from its configuration), so a target whose default branch
   * is not `development` is never judged against `development`. Omitted
   * callers keep the frozen sentinel base branch.
   */
  baseBranch?: string;
  /** Protected native owner and its private surviving parent channel. */
  ownerExecution?: HostedExecutionIntentV1;
  ownerCustody?: ReviewOwnerCustodyV1;
  /** Separate authenticated Sentinel self-scope reader, never the target client. */
  ownerSettlement?: ReviewOwnerSettlementResolverV1;
  /** Trusted opt-in; the port additionally requires the exact reserved self scope. */
  selfMergeEnabled?: boolean;
  /** Trusted host selector can only lower the reviewed queue admission mode. */
  queueMode?: unknown;
  /**
   * Backup CI consumer (docs/backup-ci-spec.md §11.2) for every check read of
   * this port: its client, the queue delivery reader and the review service
   * share it. Absent, every read is native.
   */
  backupCi?: BackupCiConsumerV1;
  /** Trusted source capabilities; missing grants refuse takeover effects. */
  takeoverAuthority?: Pick<
    ExistingPrTakeoverHostInput,
    | "runtimeCapabilityAccepted"
    | "contentsWriteAllowed"
    | "principal"
    | "verifyProducedCandidate"
  >;
}

/** Compose the one authenticated GitHub port over the shared cooldown gate. */
export function composeLocalGitHub(
  input: LocalGitHubInputV1,
  sourceQueueConfiguration?: QueueRuntimeConfiguration,
  sourceTakeoverPolicy?: ExistingPrTakeoverPolicy,
): GitHubPort {
  const queue = resolveQueueRuntimeConfiguration(
    input.queueMode,
    sourceQueueConfiguration,
  );
  const custody = input.ownerCustody;
  if (
    (input.ownerExecution !== undefined || custody !== undefined) &&
    (!(custody instanceof ReviewOwnerChannelClient) ||
      input.ownerExecution === undefined ||
      custody.descriptor.ownerRunId !== input.ownerExecution.id)
  ) throw new TypeError("native review owner custody unavailable");
  // The port is composed for exactly ONE repository. Omitted callers keep the
  // frozen sentinel identity (installation scope 0); a multi-target host
  // supplies the committed target's own identity, including its App
  // installation scope, so the REST client, the review service, the trusted
  // git remote and every gate admission agree on that repository.
  let repository: RepositoryIdentityV1;
  try {
    repository = parseRepositoryIdentity(
      input.repository ?? LOCAL_REPOSITORY,
      "$.repository",
    );
  } catch {
    throw new TypeError(STATIC_GITHUB_REPOSITORY);
  }
  if (input.installationId !== undefined) {
    if (
      !Number.isSafeInteger(input.installationId) ||
      input.installationId < 0
    ) {
      throw new TypeError(STATIC_GITHUB_REPOSITORY);
    }
    repository = { ...repository, installationId: input.installationId };
  }
  // The trusted git transport addresses the same repository as the REST
  // client: an unpublished candidate is pushed to (and read from) the exact
  // target remote, never to a built-in one.
  const remoteUrl =
    `https://github.com/${repository.owner}/${repository.name}.git`;
  // The configured base branch and the repository are decided together: the
  // base-refresh adapter and the loss prover must judge EXACTLY the branch the
  // cycle's own configuration uses.
  const baseBranch = input.baseBranch ?? LOCAL_BASE_BRANCH;
  const auth: GitHubAuthProviderV1 = {
    authorizationHeader: () => Promise.resolve(portOk(`Bearer ${input.token}`)),
  };
  const gate = input.gate;
  const client = new GitHubPrAssociationsClient({
    repository,
    apiBaseUrl: API_BASE_URL,
    http: input.http,
    auth,
    cooldownGate: gate,
    clock: input.clock,
    includeIssueRelations: true,
    ...(input.backupCi === undefined ? {} : { backupCi: input.backupCi }),
  }, queue.policy.workflowId);
  let takeoverPort: ExistingPrTakeoverPort | undefined;
  const queueReader = createQueueDeliveryReader({
    repository,
    clock: input.clock,
    client,
    policy: queue.policy,
    publication: async (request) => {
      const observed = await input.state.readRepair();
      if (
        takeoverPort === undefined || !observed.ok ||
        observed.value.status !== "found" ||
        canonicalStringify(observed.value.snapshot) !==
          canonicalStringify(request.snapshot)
      ) return { status: "unavailable", reason: "drift" };
      const proof = await takeoverPort.resolvePublication({
        ...request,
        expectedStateHead: observed.value.head,
      });
      return proof.ok
        ? { status: "complete", value: proof.value }
        : { status: "unavailable", reason: "incomplete" };
    },
    provenance: createQueueProvenanceReader({
      state: input.state,
      clock: input.clock,
      policy: queue.policy,
    }),
  });
  const nativeQueue = createNativeQueueGuard({
    repository,
    state: input.state,
    clock: input.clock,
    client,
    reader: queueReader,
    mode: queue.mode,
    proofActivated: queue.proofActivated,
    policy: queue.policy,
  });
  const snapshot = new GitReviewSnapshot({
    trustedPath: input.trustedPath,
    repositoryDir: input.reviewCheckout,
    gitExecutable: trustedGitPath(input.trustedPath),
  });
  const ensureCandidateObjects = input.ensureCandidateObjects;
  // Every capture first restores the exact durable candidate objects when the
  // host has that capability, then prepares the independent exact review
  // checkout under trusted ownership and captures the immutable manifest from
  // that exact checkout. A failed restore or preparation propagates as this
  // operation's sanitized unavailability, never a host-wide exception.
  const snapshotSource = {
    capture: async (value: { base: GitSha; head: GitSha }) => {
      if (ensureCandidateObjects !== undefined) {
        const ensured = await ensureCandidateObjects({
          ...value,
          repository,
        });
        if (!ensured.ok) return ensured;
      }
      const prepared = await prepareReviewCheckout({
        sourcePath: input.sourcePath,
        reviewCheckout: input.reviewCheckout,
        base: value.base,
        head: value.head,
        trustedPath: input.trustedPath,
        scratch: input.scratch,
      });
      if (!prepared.ok) return prepared;
      return await snapshot.capture(value);
    },
  };
  const reviewer = new CodexStructuredReviewer({
    // Trusted isolated client config retains gateway auth/routing; native mode
    // owns reviewer selection and sends no caller selection overrides.
    provider: GATEWAY_PROVIDER,
    sessionCwd: input.reviewCheckout,
    permissionProfile: "sentinel-review",
    openSession: (value) =>
      custody instanceof ReviewOwnerChannelClient
        ? custody.openSession(value)
        : input.tracker.open(() =>
          new CodexSubprocessSession({
            command: [input.codexExecutable, "app-server"],
            cwd: value.cwd,
            env: codexChildEnv(
              input.reviewClientHome,
              input.reviewTmpDir,
              input.reviewDenoDir,
              input.trustedPath,
            ),
            operationDeadlineMs: REVIEW_SESSION_DEADLINE_MS,
          })
        ),
  });
  if (
    repository.owner === "ubiquity-sentinel" &&
    repository.name === "sentinel" &&
    repository.installationId === 0
  ) {
    input.onOwnerSuccessorReviewPorts?.({
      capture: snapshotSource.capture,
      reviewer,
      ...(custody instanceof ReviewOwnerChannelClient ? { custody } : {}),
      task: async (issueNumber) => {
        const read = await client.readIssue(issueNumber);
        if (!read.ok || !read.value) return;
        const { reviewTaskStatementDigest } = await import(
          "../contracts/review-task-acceptance.ts"
        );
        const task = {
          issueNumber,
          title: read.value.title,
          body: read.value.body,
        };
        return { ...task, digest: await reviewTaskStatementDigest(task) };
      },
      verify: async (revision) => {
        const read = await client.readChecks(revision);
        return read.ok &&
          read.value.checks.some((c) =>
            c.name === "test-local" && c.status === "completed" &&
            c.conclusion === "success"
          );
      },
    });
  }
  const reviewService = new GitHubCodexReviewTransport({
    client,
    repository,
    publisher: input.login,
    clock: input.clock,
    ownerRunId: input.invocationId,
    ...(input.ownerExecution === undefined
      ? {}
      : { ownerExecution: input.ownerExecution }),
    ...(custody === undefined ? {} : { ownerCustody: custody }),
    ...(input.ownerSettlement === undefined
      ? {}
      : { ownerSettlement: input.ownerSettlement }),
    snapshot: snapshotSource,
    reviewer,
    // Explicit uncapped review concurrency: no artificial in-flight bound.
    maxActiveReviews: null,
  });
  const host = composeGitHubHost({
    repository,
    nativeQueue,
    http: input.http,
    auth,
    cooldownGate: gate,
    clock: input.clock,
    reviewService,
    trustedPrAuthor: input.login,
    trustedReviewer: input.login,
    trustedResolutionAuthors: [input.login],
    git: {
      localDir: input.sourcePath,
      remoteUrl,
      gitHome: input.scratch,
      extraEnv: githubGitAuthEnv(input.token, remoteUrl),
      gitPath: trustedGitPath(input.trustedPath),
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    },
    includeIssueRelations: true,
    ...(input.selfMergeEnabled === undefined
      ? {}
      : { selfMergeEnabled: input.selfMergeEnabled }),
    ...(input.backupCi === undefined ? {} : { backupCi: input.backupCi }),
  });
  if (ensureCandidateObjects !== undefined) {
    // Wrap the SAME executor instance the port holds (never a parallel one):
    // a resumed merge proves ancestry only after the exact objects exist.
    const originalIsAncestor = host.git.isAncestor.bind(host.git);
    host.git.isAncestor = async (ancestor, descendant) => {
      const ensured = await ensureCandidateObjects({
        base: ancestor,
        head: descendant,
        repository,
      });
      if (!ensured.ok) return ensured;
      return await originalIsAncestor(ancestor, descendant);
    };
  }
  // The optional deterministic base-refresh capability is composed HERE on the
  // SAME port + executor identities: it re-observes through this exact port and
  // integrates through this exact executor, so host reconciliation and port
  // publication can never drift to a parallel instance.
  //
  // The freshly observed target base is ensured through the SAME target
  // mirror, authenticated remote, configured base branch, host token and
  // shared cooldown gate this port already uses. The closure fixes all of them
  // to this port's validated identity, so a request can never select another
  // repository, branch or remote. The existing gated refresh returns the
  // fetched branch head; only the exact observed base is accepted, and a
  // concurrent advance is a bounded conflict, never adoption of an
  // unobserved base.
  const ensureBaseObjects = async (value: {
    base: GitSha;
    repository: RepositoryIdentityV1;
  }): Promise<PortResultV1<void>> => {
    if (
      value.repository.owner !== repository.owner ||
      value.repository.name !== repository.name ||
      value.repository.installationId !== repository.installationId
    ) {
      return portError("invalid", STATIC_BASE_REFRESH_BASE_REPOSITORY);
    }
    let fetchedBase: string;
    try {
      fetchedBase = await refreshDevelopment(
        input.sourcePath,
        {
          stateRoot: input.stateRoot,
          trustedPath: input.trustedPath,
          githubToken: input.token,
        },
        input.scratch,
        gate,
        repository.installationId,
        { remoteUrl, baseBranch },
      );
    } catch {
      return portError("unavailable", STATIC_BASE_REFRESH_BASE_OBJECTS);
    }
    if (fetchedBase !== value.base) {
      return portError("conflict", STATIC_BASE_REFRESH_BASE_MOVED);
    }
    return portOk(undefined);
  };
  host.port.prepareBaseRefresh = createPrepareBaseRefresh({
    clock: input.clock,
    git: host.git,
    repository,
    observer: host.port,
    baseBranch,
    trustedPrAuthor: input.login,
    ensureCandidateObjects,
    ensureBaseObjects,
  });
  Object.defineProperty(host.port, "existingPrTakeover", {
    enumerable: true,
    value: takeoverPort = createExistingPrTakeover({
      repository,
      baseBranch,
      client,
      port: host.port,
      state: input.state,
      clock: input.clock,
      gate,
      token: input.token,
      sourcePath: input.sourcePath,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
      gitExecutable: trustedGitPath(input.trustedPath),
      remoteUrl,
      policy: sourceTakeoverPolicy,
      ensureLocalCandidate: createLocalCandidateLoader({
        stateRoot: input.stateRoot,
        sourcePath: input.sourcePath,
        scratch: input.scratch,
        trustedPath: input.trustedPath,
      }),
      protectedPaths: selectTrustedTargetPolicyV1(
        createLocalRepositoryConfig(),
        repository,
      ).protectedPaths,
      ...input.takeoverAuthority,
    }),
  });
  // The carried-review patch proof is composed on the SAME executor: the
  // refreshed candidate's exact durable objects are restored first (its
  // first parent is the reviewed head, which normally contains the reviewed
  // base, so one restore brings every commit the proof reads; a commit still
  // missing makes the proof unavailable, never a pass), then the proof only
  // reads the local object store.
  const carriedPatchProof = host.git.carriedPatchProof?.bind(host.git);
  if (carriedPatchProof !== undefined) {
    host.port.proveCarriedPatch = async (request) => {
      if (ensureCandidateObjects !== undefined) {
        const ensured = await ensureCandidateObjects({
          base: request.base,
          head: request.head,
          repository,
        });
        if (!ensured.ok) return ensured;
      }
      return await carriedPatchProof(request);
    };
  }
  // Candidate preservation is composed on the SAME port + executor identities:
  // the authenticated operation-ref read and the create-only push use this
  // exact port, and the trusted loader imports only the exact task-mapped
  // producer checkout under this host's private state root.
  host.port.preserveCandidate = createCandidatePreserver({
    state: input.state,
    gate,
    token: input.token,
    http: input.http,
    clock: input.clock,
    sourcePath: input.sourcePath,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
    gitExecutable: trustedGitPath(input.trustedPath),
    remoteUrl,
    // The durable record, the gate scope and the remote must all name THIS
    // port's repository: defaulting to the sentinel self-identity would make a
    // foreign target's own record unfindable and its push unauthenticated.
    repository,
    port: host.port,
    protectedPaths: selectTrustedTargetPolicyV1(
      createLocalRepositoryConfig(),
      repository,
    ).protectedPaths,
    ensureLocalCandidate: createLocalCandidateLoader({
      stateRoot: input.stateRoot,
      sourcePath: input.sourcePath,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    }),
  });
  // The legacy candidate-loss proof is composed on the SAME port identity and
  // the SAME exact loader inputs as preservation. The port object is passed
  // BEFORE the scope wrapper replaces `readIssue`, so the prover resolves the
  // scoped reader dynamically at invocation and never captures a pre-scope one.
  host.port.proveLegacyBaseRefreshLoss = createLegacyBaseRefreshLossProver({
    state: input.state,
    port: host.port,
    gate,
    token: input.token,
    scratch: input.scratch,
    trustedPath: input.trustedPath,
    gitExecutable: trustedGitPath(input.trustedPath),
    remoteUrl,
    repository,
    baseBranch,
    trustedPrAuthor: input.login,
    ensureLocalCandidate: createLocalCandidateLoader({
      stateRoot: input.stateRoot,
      sourcePath: input.sourcePath,
      scratch: input.scratch,
      trustedPath: input.trustedPath,
    }),
  });
  (host.port as BaseTaskReviewGitHubV1).baseTaskReview =
    new BaseTaskReviewService({
      client,
      repository,
      baseBranch,
      publisher: input.login,
      clock: input.clock,
      state: input.state,
      ownerRunId: input.invocationId,
      provider: GATEWAY_PROVIDER,
      snapshot: snapshotSource,
      reviewer,
      ...(custody instanceof ReviewOwnerChannelClient ? { custody } : {}),
    });
  return scopeLocalRepairIssues(host.port);
}

/**
 * Explicit local coding-task opt-OUT. Every open issue is repaired by default;
 * an issue is excluded only when its body's first line is exactly this
 * standalone marker, or when it carries the matching label (honoured wherever
 * the repository bot has not removed it yet).
 */
const LOCAL_SKIP_MARKER = "<!-- sentinel:skip -->";

const LOCAL_SKIP_LABEL = "sentinel:skip";

/**
 * Scope the privately-owned concrete local port to the issues this deployment
 * may repair.
 *
 * Only `listOpenIssues` and `readIssue` are replaced, and both originals are
 * bound to this exact port before replacement, so every other method keeps
 * the class instance and its `this` binding. EVERY open issue is in scope:
 * nothing is silently filtered out, and an issue is excluded only by an
 * explicit opt-out — the exact standalone first line `<!-- sentinel:skip -->`
 * or the `sentinel:skip` label. The historical `<!-- sentinel:repair -->`
 * opt-in marker is still accepted and is simply no longer required. Errors
 * pass through unchanged; an excluded or absent read passes through as `null`,
 * preserving the existing pre-admission wait gate. The loop re-reads the
 * source issue before every admission, so a queued issue that gains the
 * opt-out cannot consume budget.
 */
export function scopeLocalRepairIssues(port: GitHubPort): GitHubPort {
  const listOpenIssues = port.listOpenIssues.bind(port);
  const readIssue = port.readIssue.bind(port);
  port.listOpenIssues = async () => {
    const listed = await listOpenIssues();
    return listed.ok
      ? { ...listed, value: listed.value.filter(isLocalRepairIssue) }
      : listed;
  };
  port.readIssue = async (issueNumber) => {
    const read = await readIssue(issueNumber);
    if (!read.ok || read.value === null || isLocalRepairIssue(read.value)) {
      return read;
    }
    return portOk(null);
  };
  return port;
}

/**
 * Default admission with an explicit opt-out. The skip marker must be the whole
 * first line with no leading whitespace, quoting or fencing, followed by LF,
 * CRLF or the end of the body; the skip label is honoured according to
 * GitHub's own case-insensitive label identity. Anything else is in scope, and
 * the historical `<!-- sentinel:repair -->` marker changes nothing.
 */
function isLocalRepairIssue(issue: GitHubIssueV1): boolean {
  if (issue.labels.some((label) => label.toLowerCase() === LOCAL_SKIP_LABEL)) {
    return false;
  }
  if (!issue.body.startsWith(LOCAL_SKIP_MARKER)) return true;
  const rest = issue.body.slice(LOCAL_SKIP_MARKER.length);
  return !(rest === "" || rest.startsWith("\n") || rest.startsWith("\r\n"));
}
