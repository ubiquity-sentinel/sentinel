/** A separate canary surface: production mutation branch scope stays unchanged. */
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../src/contracts/canonical.ts";
import { portError, portOk } from "../src/contracts/ports.ts";
import type { GitHubApiClientOptionsV1 } from "../src/github/client-contracts.ts";
import { GitHubQueueDeliveryClient } from "../src/github/client-queue-delivery.ts";
import { headerMap, type HttpResponseV1 } from "../src/github/http.ts";
import {
  parseQueueAdmission,
  queueEnqueueBody,
} from "../src/github/merge-queue-protocol.ts";
import type {
  QueueActor,
  QueueAdmission,
  QueueDequeue,
  QueueEntry,
} from "../src/github/merge-queue-types.ts";
import { decideCiGate } from "../src/repair/loop-checks.ts";
import {
  CANARY_APP_ID,
  CANARY_APP_SLUG,
  CANARY_BRANCH,
  CANARY_REPOSITORY,
  CANARY_WORKFLOW,
  type CanaryGrant,
} from "./queue-canary-pins.ts";
import {
  canaryBindingDigest,
  type CanaryHost,
  type CanaryIdentity,
  type CanaryObservation,
  type CanaryPort,
} from "./queue-canary.ts";
import {
  createQueueProjectionGet,
  readQueueRulesProjection,
} from "./queue-rules-projection-read.ts";

const TARGET = "/repos/ubiquity/ai.ubq.fi";
const HOST = "/repos/ubiquity-sentinel/sentinel";
const CHECKS = [
  "validate",
  "verify-artifact",
  "darwin-native",
  "mac-containment",
];
const equal = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("unavailable");
  }
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256) {
    throw new Error("unavailable");
  }
  return value;
}
function id(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("unavailable");
  }
  return value as number;
}
function actor(value: unknown): QueueActor {
  const data = row(value);
  if (data.type !== "Bot") throw new Error("unavailable");
  return { nodeId: text(data.node_id), login: text(data.login), type: "Bot" };
}

export class CanaryGitHub extends GitHubQueueDeliveryClient
  implements CanaryPort {
  constructor(
    private readonly canaryOptions: GitHubApiClientOptionsV1,
    private readonly hostReadToken: string,
  ) {
    super(canaryOptions, null);
    if (
      !equal(canaryOptions.repository, CANARY_REPOSITORY) ||
      canaryOptions.apiBaseUrl !== "https://api.github.com"
    ) throw new Error("canary_scope");
  }
  private async get(
    path: string,
    host = false,
  ): Promise<Record<string, unknown>> {
    let response: HttpResponseV1;
    if (host) {
      if (!path.startsWith(`${HOST}/actions/`)) throw new Error("canary_scope");
      response = await this.canaryOptions.http({
        method: "GET",
        url: `https://api.github.com${path}`,
        headers: headerMap({
          authorization: `Bearer ${this.hostReadToken}`,
          accept: "application/vnd.github+json",
        }),
        body: null,
      });
    } else {
      const raw = await this.sendCore(
        "GET",
        `https://api.github.com${path}`,
        null,
      );
      if (raw.status !== "response") throw new Error("unavailable");
      response = raw.response;
    }
    if (response.status !== 200) throw new Error("unavailable");
    return row(JSON.parse(response.bodyText));
  }
  async identity(): Promise<CanaryIdentity | null> {
    try {
      // This authenticated endpoint accepts installation tokens, not owner PATs.
      // App/install identity comes from the trusted JWT-authenticated mint action.
      const installation = await this.get(
        "/installation/repositories?per_page=100",
      );
      if (
        installation.total_count !== 1 ||
        !Array.isArray(installation.repositories) ||
        installation.repositories.length !== 1
      ) return null;
      const repository = row(installation.repositories[0]);
      if (repository.full_name !== "ubiquity/ai.ubq.fi") return null;
      const nativeActor = actor(
        await this.get(`/users/${CANARY_APP_SLUG}%5Bbot%5D`),
      );
      if (nativeActor.login !== `${CANARY_APP_SLUG}[bot]`) return null;
      return {
        appId: CANARY_APP_ID,
        appSlug: CANARY_APP_SLUG,
        installationId: CANARY_REPOSITORY.installationId,
        repositoryId: id(repository.id),
        actor: nativeActor,
      };
    } catch {
      return null;
    }
  }
  collectProjection(
    host: CanaryHost,
    identity: CanaryIdentity,
    grant: CanaryGrant,
  ) {
    return readQueueRulesProjection({
      host,
      identity,
      targets: grant.projectionTargets ?? [],
      now: () => this.canaryOptions.clock.now(),
      get: createQueueProjectionGet(this.canaryOptions),
    });
  }
  async observe(grant: CanaryGrant): Promise<CanaryObservation> {
    const deadline = this.canaryOptions.clock.now() + 60_000;
    const queue = await this.readQueue(CANARY_BRANCH);
    const membership = await this.readPullMembership(grant.pull);
    const pull = await this.readQueuePull(grant.pull.number, deadline);
    const events = await this.readPullQueueEvents(grant.pull);
    const rules = await this.readBranchRules(CANARY_BRANCH);
    const ruleSets = rules.ok
      ? await Promise.all(
        [...new Set(rules.value.map((rule) => rule.rulesetId))].map((
          ruleSetId,
        ) =>
          ruleSetId === null
            ? Promise.resolve(null)
            : this.readRepositoryRuleSet(ruleSetId)
        ),
      )
      : [];
    const bypassUnavailable = ruleSets.some((ruleSet) =>
      ruleSet === null || !ruleSet.ok ||
      ruleSet.value.currentUserCanBypass !== "never"
    );
    const metadata = await this.get(
      `${TARGET}/actions/workflows/deno-deploy.yml`,
    );
    const workflow = await this.readQueueWorkflowDigest(
      grant.pull.head,
      deadline,
    );
    const tipWorkflow = queue.status === "complete"
      ? await this.readQueueWorkflowDigest(queue.value.baseTip, deadline)
      : null;
    const checks = await this.readBaseReviewChecks(grant.pull.head, CHECKS);
    const rulesSha256 = rules.ok
      ? await canonicalStringifySha256(
        [...rules.value].sort((a, b) =>
          canonicalStringify(a).localeCompare(canonicalStringify(b))
        ),
      )
      : null;
    const revision = membership.status === "complete"
      ? membership.value.mergedRevision
      : null;
    const commit = revision === null
      ? null
      : await this.readQueueCommit(revision, deadline);
    const patch = await this.readQueuePatch(
      grant.reviewedBase,
      grant.pull.head,
      deadline,
    );
    const integrated =
      commit?.status === "complete" && commit.value.parents.length === 2
        ? await this.readQueuePatch(
          commit.value.parents[0],
          commit.value.sha,
          deadline,
        )
        : null;
    const ancestry =
      commit?.status === "complete" && commit.value.parents.length === 2
        ? await this.readQueueAncestry(
          grant.reviewedBase,
          commit.value.parents[0],
          deadline,
        )
        : null;
    const runs = revision === null ? null : await new GitHubQueueDeliveryClient(
      this.canaryOptions,
      grant.workflowId,
    ).readMergeGroupRuns(revision);
    const mergedWorkflow = revision === null
      ? null
      : await this.readQueueWorkflowDigest(revision, deadline);
    const reachable = revision !== null && queue.status === "complete"
      ? await this.readQueueAncestry(revision, queue.value.baseTip, deadline)
      : null;
    return {
      complete: queue.status === "complete" &&
        membership.status === "complete" &&
        events.status === "complete" && pull.status === "complete" &&
        rules.ok &&
        ruleSets.every((ruleSet) =>
          ruleSet !== null && ruleSet.ok &&
          ruleSet.value.currentUserCanBypass !== null
        ) &&
        Number.isSafeInteger(metadata.id) &&
        typeof metadata.path === "string" &&
        typeof metadata.state === "string" && workflow.status === "complete" &&
        tipWorkflow?.status === "complete" && checks.ok &&
        patch.status === "complete" &&
        (revision === null || (commit?.status === "complete" &&
          integrated?.status === "complete" &&
          ancestry?.status === "complete" &&
          runs?.status === "complete" &&
          mergedWorkflow?.status === "complete" &&
          reachable?.status === "complete")),
      queue,
      membership,
      events,
      facts: {
        workflow: {
          id: metadata.id,
          path: metadata.path,
          state: metadata.state,
        },
        workflowBytes: workflow,
        tipWorkflowBytes: tipWorkflow,
        mergedWorkflowBytes: mergedWorkflow,
        rules: rules.ok ? rules.value : null,
        rulesSha256,
        ruleSets: ruleSets.map((ruleSet) => ruleSet?.ok ? ruleSet.value : null),
        headChecks: checks.ok ? checks.value : null,
        pull,
        commit,
        patch,
        integrated,
        ancestry,
        reachable,
        runs,
      },
      workflowAccepted: metadata.id === grant.workflowId &&
        metadata.path === ".github/workflows/deno-deploy.yml" &&
        metadata.state === "active" && workflow.status === "complete" &&
        workflow.value.sha256 === grant.workflowSha256 &&
        tipWorkflow?.status === "complete" &&
        tipWorkflow.value.sha256 === grant.workflowSha256,
      rulesAccepted: rules.ok && !bypassUnavailable &&
        rulesSha256 === grant.rulesSha256 &&
        rules.value.some((rule) => rule.type === "merge_queue") ===
          grant.expectQueueRule,
      headCiGreen: checks.ok && checks.value.head === grant.pull.head &&
        CHECKS.every((name) =>
          checks.value.checks.some((check) => check.name === name)
        ) &&
        decideCiGate(checks.value.checks) === "proceed",
    };
  }
  async firstDispatch(host: CanaryHost): Promise<boolean> {
    try {
      const workflow = await this.get(
        `${HOST}/actions/workflows/queue-canary.yml`,
        true,
      );
      if (workflow.path !== CANARY_WORKFLOW || workflow.state !== "active") {
        return false;
      }
      const workflowId = id(workflow.id);
      const current = await this.get(
        `${HOST}/actions/runs/${host.runId}`,
        true,
      );
      const title =
        `sentinel-queue-canary:${host.action}:${host.bindingDigest}`;
      if (
        current.id !== host.runId || current.workflow_id !== workflowId ||
        current.run_attempt !== 1 ||
        current.head_sha !== host.sha ||
        current.head_branch !== "sentinel-supervisor" ||
        current.path !== CANARY_WORKFLOW ||
        current.event !== "workflow_dispatch" || current.display_title !== title
      ) return false;
      const runs: Record<string, unknown>[] = [];
      let total: number | null = null;
      for (let page = 1; page <= 10; page++) {
        const read = await this.get(
          `${HOST}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&per_page=100&page=${page}`,
          true,
        );
        if (
          !Number.isSafeInteger(read.total_count) ||
          (read.total_count as number) >= 1000 ||
          !Array.isArray(read.workflow_runs)
        ) return false;
        if (total !== null && total !== read.total_count) return false;
        total = read.total_count as number;
        runs.push(...read.workflow_runs.map(row));
        if (runs.length >= total) break;
      }
      if (
        total === null || runs.length !== total ||
        new Set(runs.map((run) => run.id)).size !== runs.length
      ) return false;
      const bound = runs.filter((run) => run.display_title === title);
      // An earlier cancelled/failed attempt consumes this source grant too. No time cutoff.
      return bound.length === 1 && bound[0].id === host.runId &&
        bound[0].workflow_id === workflowId && bound[0].head_sha === host.sha;
    } catch {
      return false;
    }
  }
  async priorAccepted(grant: CanaryGrant): Promise<boolean> {
    const prior = grant.prior;
    if (prior === null) return false;
    try {
      const run = await this.get(`${HOST}/actions/runs/${prior.runId}`, true);
      const artifact = await this.get(
        `${HOST}/actions/artifacts/${prior.artifactId}`,
        true,
      );
      const bindingDigest = await canaryBindingDigest(grant);
      const expectedRequest = await canonicalStringifySha256({
        domain: "sentinel.queue-canary-request.v1",
        repository: "ubiquity-sentinel/sentinel",
        ref: "refs/heads/sentinel-supervisor",
        sha: prior.sourceSha,
        workflowSha: prior.sourceSha,
        expectedSha: prior.sourceSha,
        runId: prior.runId,
        attempt: 1,
        event: "workflow_dispatch",
        action: "enqueue",
        bindingDigest,
        mintedAppSlug: CANARY_APP_SLUG,
        mintedInstallationId: CANARY_REPOSITORY.installationId,
      });
      return run.id === prior.runId && run.head_sha === prior.sourceSha &&
        run.path === CANARY_WORKFLOW &&
        run.head_branch === "sentinel-supervisor" &&
        run.event === "workflow_dispatch" && run.run_attempt === 1 &&
        run.display_title ===
          `sentinel-queue-canary:enqueue:${bindingDigest}` &&
        prior.requestDigest === expectedRequest &&
        artifact.expired === false &&
        artifact.digest === `sha256:${prior.artifactDigest}` &&
        row(artifact.workflow_run).id === prior.runId &&
        row(artifact.workflow_run).head_sha === prior.sourceSha &&
        artifact.name ===
          `queue-canary-${prior.runId}-1-${prior.requestDigest}`;
    } catch {
      return false;
    }
  }
  async enqueueCanary(grant: CanaryGrant): Promise<QueueAdmission> {
    if (!this.canaryPull(grant)) {
      return { status: "not_submitted", reason: "unsupported" };
    }
    const raw = await this.sendCore(
      "PUT",
      `https://api.github.com${TARGET}/pulls/${grant.pull.number}/merge-async`,
      queueEnqueueBody(grant.pull),
    );
    return raw.status === "response"
      ? parseQueueAdmission(raw.response, grant.pull)
      : { status: "ambiguous", requestId: null };
  }
  async dequeueCanary(
    grant: CanaryGrant,
    entry: QueueEntry,
  ): Promise<QueueDequeue> {
    if (
      !this.canaryPull(grant) || grant.prior === null ||
      entry.id !== grant.prior.entryId ||
      !equal(entry.pull, grant.pull) || !equal(entry.enqueuer, grant.appActor)
    ) return { status: "not_submitted", reason: "unsupported" };
    const current = await this.readPullMembership(grant.pull);
    if (current.status !== "complete" || !equal(current.value.entry, entry)) {
      return { status: "not_submitted", reason: "drift" };
    }
    const raw = await this.sendCore("POST", "https://api.github.com/graphql", {
      query:
        "mutation($id:ID!) { dequeuePullRequest(input:{id:$id}) { mergeQueueEntry { id } } }",
      variables: { id: grant.pull.nodeId },
    });
    if (raw.status !== "response" || raw.response.status !== 200) {
      return { status: "ambiguous" };
    }
    try {
      const body = row(JSON.parse(raw.response.bodyText));
      if (
        body.errors !== undefined ||
        row(row(row(body.data).dequeuePullRequest).mergeQueueEntry).id !==
          entry.id
      ) return { status: "ambiguous" };
      return { status: "submitted" };
    } catch {
      return { status: "ambiguous" };
    }
  }
  private canaryPull(grant: CanaryGrant): boolean {
    return equal(grant.pull.repository, CANARY_REPOSITORY) &&
      grant.pull.baseRef === CANARY_BRANCH &&
      Number.isSafeInteger(grant.pull.number) && grant.pull.number > 0;
  }
}

/** Ephemeral canary stop gate: any native rate limit stops this invocation. */
export function canaryCooldown(): GitHubApiClientOptionsV1["cooldownGate"] {
  let stopped = false;
  return {
    beforeRequest: () =>
      Promise.resolve(
        stopped
          ? portError("unavailable", "canary rate limit observed")
          : portOk(undefined),
      ),
    recordRateLimit: () => {
      stopped = true;
      return Promise.resolve(portOk(undefined));
    },
  };
}
