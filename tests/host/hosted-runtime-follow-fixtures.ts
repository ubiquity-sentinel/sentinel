import assert from "node:assert/strict";
import { CONTROLLER } from "./controller-identity-fixture.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { FOLLOW_CI_WORKFLOW_ID } from "../../src/host/hosted-runtime-follow-ci.ts";
import { sha256Hex } from "../../src/state/state-records.ts";
import {
  type HostedRuntimeFollowJournal,
  runHostedRuntimeFollow,
} from "../../src/host/hosted-runtime-follow.ts";

export const L = "a".repeat(40);
export const OLDER = "b".repeat(40);
export const D = "c".repeat(40);
export const P = "1".repeat(40);
export const STATE = "2".repeat(40);
const TREE = "3".repeat(40);
const BLOB = "4".repeat(40);
const INDEX_COMMIT = "6".repeat(40);
const INDEX_TREE = "7".repeat(40);
const INDEX_BLOB = "8".repeat(40);
const REPAIR_COMMIT = "9".repeat(40);
const REPAIR_TREE = "0".repeat(40);
export const NOW = Date.parse("2026-10-20T08:00:00Z");
const reservationBlob = async (id: string) =>
  (await sha256Hex(id)).slice(0, 40);
const ROOT = CONTROLLER.apiPath;
export const repository = {
  id: 101,
  node_id: "R_sentinel",
  full_name: CONTROLLER.fullName,
};

export function response(
  value: unknown,
  status = 200,
  headers = new Headers(),
): HttpResponseV1 {
  return { status, headers, bodyText: JSON.stringify(value) };
}

export function ciRun(
  head: string,
  id: number,
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    run_attempt: 1,
    workflow_id: FOLLOW_CI_WORKFLOW_ID,
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "development",
    head_sha: head,
    repository,
    head_repository: repository,
    status: "completed",
    conclusion: "success",
    ...changes,
  };
}

export function supervisorRun(
  head: string,
  id: number,
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    run_attempt: 1,
    workflow_id: CONTROLLER.workflowId,
    path: ".github/workflows/supervisor.yml",
    event: "workflow_dispatch",
    head_branch: "sentinel-supervisor",
    head_sha: head,
    repository,
    head_repository: repository,
    status: "queued",
    conclusion: null,
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...changes,
  };
}

/** The active execution intent a dispatched supervisor run leaves behind. */
export function executionIntent(
  runId: number,
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `${runId}:1:repair`,
    runId,
    runAttempt: 1,
    launcherSha: L,
    purpose: "ordinary",
    revision: P,
    generation: 81,
    releaseId: null,
    createdAt: NOW - 1000,
    ...changes,
  };
}

export function installation(
  candidate: string,
  phase = "rolled_back",
): Record<string, unknown> {
  const proof = (
    revision: string,
    generation: number,
    runId: number,
    outcome: string,
  ) => ({
    baseSha: D,
    execution: {
      createdAt: NOW - 2000,
      generation,
      id: `${runId}:1:repair`,
      launcherSha: candidate,
      purpose: "bootstrap",
      releaseId: null,
      revision,
      runAttempt: 1,
      runId,
    },
    finishedAt: NOW - 500,
    jobId: runId * 100,
    logDigest: "8".repeat(64),
    observedAt: NOW,
    outcome,
    ref: "refs/heads/sentinel-supervisor",
    repository: CONTROLLER.fullName,
    settled: true,
    startedAt: NOW - 1500,
    startupReady: true,
    terminalAt: NOW - 600,
    workflowId: CONTROLLER.workflowId,
    workflowPath: ".github/workflows/supervisor.yml",
  });
  return {
    version: "v1",
    kind: "hosted_installation",
    id: `installation:${candidate}`,
    candidateRevision: candidate,
    previousRevision: P,
    previousGeneration: 81,
    previousHealthyProof: null,
    ci: { revision: candidate, checkRunId: 2000 },
    phase,
    pointerIntent: phase === "requested"
      ? {
        action: "promote",
        expectedRevision: P,
        nextRevision: candidate,
        expectedGeneration: 81,
        createdAt: NOW,
      }
      : phase === "rollback_pending"
      ? {
        action: "rollback",
        expectedRevision: candidate,
        nextRevision: P,
        expectedGeneration: 82,
        createdAt: NOW,
      }
      : null,
    bootstrapExecutionId: phase === "requested" ? null : "800:1:repair",
    bootstrapProof: ["requested", "bootstrapping"].includes(phase)
      ? null
      : proof(candidate, 82, 800, phase === "accepted" ? "healthy" : "failed"),
    rollbackExecutionId:
      ["rollback_verifying", "rolled_back", "rollback_failed"].includes(phase)
        ? "801:1:repair"
        : null,
    rollbackProof: ["rolled_back", "rollback_failed"].includes(phase)
      ? proof(P, 83, 801, phase === "rolled_back" ? "healthy" : "failed")
      : null,
    createdAt: NOW - 3000,
    updatedAt: NOW,
  };
}

/** #191: the same journal after one never-started first attempt was retried. */
export function retriedInstallation(
  candidate: string,
  phase: string,
): Record<string, unknown> {
  return {
    ...installation(candidate, phase),
    retriedBootstrapProof: {
      execution: {
        createdAt: NOW - 2800,
        generation: 82,
        id: "799:1:repair",
        launcherSha: candidate,
        purpose: "bootstrap",
        releaseId: null,
        revision: candidate,
        runAttempt: 1,
        runId: 799,
      },
      evidenceDigest: "9".repeat(64),
      finishedAt: NOW - 2600,
      jobId: null,
      observedAt: NOW - 2500,
      outcome: "not_started",
      ref: "refs/heads/sentinel-supervisor",
      repository: CONTROLLER.fullName,
      workflowId: CONTROLLER.workflowId,
      workflowPath: ".github/workflows/supervisor.yml",
    },
  };
}

/** A valid maintenance index naming one producer plan for the follow guard. */
export function matrixWaveIndex(
  execution: Record<string, unknown>,
  reservationIds: readonly string[],
  sequence = 10,
) {
  return {
    version: "v1",
    kind: "current_matrix_index",
    controller: CONTROLLER.fullName,
    releaseRef: "refs/heads/sentinel-state/release",
    anchor: { head: STATE, sequence },
    ranges: [{
      from: { head: STATE, sequence },
      through: { head: STATE, sequence: 1 },
      next: null,
    }],
    producers: [{
      head: "f".repeat(40),
      sequence,
      execution,
      proofFingerprint: "a".repeat(64),
      plan: {
        planDigest: "b".repeat(64),
        plannerJobId: 1,
        reservationIds,
      },
    }],
  };
}

/** A valid reservation row for the follow guard's settle probe. */
export function matrixWaveReservation(
  id: string,
  createdAt: number,
  outcome: "reserved" | "submitted",
) {
  return {
    version: "v1",
    kind: "budget_reservation",
    repository: { owner: "ubiquity", name: "sentinel", installationId: 1 },
    id,
    taskId: "issue-ubiquity-sentinel-1",
    attempt: 1,
    head: "a".repeat(40),
    purpose: "implementation",
    createdAt,
    outcome,
    settledAt: outcome === "submitted" ? createdAt + 1000 : null,
    proofRef: null,
  };
}

/** Production consumers see only this fake external HTTP boundary. */
export class FollowFake {
  development = D;
  launcher = L;
  installed = P;
  stateHead = STATE;
  execution: unknown = null;
  matrixIndex: unknown = null;
  repairReservations = new Map<string, Record<string, unknown>>();
  now = NOW + 60_000;
  parents = new Map<string, string[]>([[D, [OLDER]], [OLDER, [L]], [L, [P]], [
    P,
    [],
  ]]);
  ci = new Map<string, Record<string, unknown>[]>([
    [D, [ciRun(D, 30, { conclusion: "failure" })]],
    [OLDER, [ciRun(OLDER, 20)]],
  ]);
  jobs = new Map<number, Record<string, unknown>[]>();
  installations: Record<string, unknown>[] = [];
  supervisorRuns: Record<string, unknown>[] = [];
  requests: HttpRequestV1[] = [];
  journals: HostedRuntimeFollowJournal[] = [];
  mutation: "normal" | "conflict" | "lost" | "mismatch" = "normal";
  dispatch: "normal" | "lost" | "invisible" | "wrong_sha" | "ambiguous" =
    "normal";
  intercept?: (request: HttpRequestV1, url: URL) => HttpResponseV1 | undefined;
  treeTruncated = false;
  /** Commit → its `.github/workflows` tree id (default shared by all). */
  workflowTrees = new Map<string, string>();
  private sourceTrees = new Map<string, { path: string; sha: string }>();
  private mutationCalls = 0;
  private dispatchCalls = 0;

  async follow(
    flag = "on",
    options: { maxDepth?: number; maxPages?: number } = {},
  ) {
    return await runHostedRuntimeFollow({
      http: this.http,
      token: "fake-token",
      flag,
      ...options,
      clock: { now: () => this.now },
      log: (journal) => this.journals.push(journal),
    });
  }

  get mutations(): number {
    return this.mutationCalls;
  }
  get dispatches(): number {
    return this.dispatchCalls;
  }

  readonly http: HttpTransportV1 = async (request) => {
    this.requests.push(request);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://api.github.com");
    const overridden = await this.intercept?.(request, url);
    if (overridden !== undefined) return overridden;
    const path = url.pathname.replace(ROOT, "");
    if (request.method === "POST" && path === "/graphql") {
      this.mutationCalls++;
      const body = JSON.parse(request.body!);
      const input = body.variables.input;
      assert.equal(input.repositoryId, repository.node_id);
      assert.equal(input.refUpdates.length, 1);
      const update = input.refUpdates[0];
      assert.equal(update.name, "refs/heads/sentinel-supervisor");
      assert.equal(update.force, false);
      if (this.mutation === "conflict" || update.beforeOid !== this.launcher) {
        return response({ errors: [{ type: "UNPROCESSABLE" }] });
      }
      if (this.mutation !== "mismatch") this.launcher = update.afterOid;
      if (this.mutation === "lost") {
        throw new Error("lost response with private material");
      }
      return response({
        data: { updateRefs: { clientMutationId: input.clientMutationId } },
      });
    }
    if (
      request.method === "POST" &&
      path === "/actions/workflows/supervisor.yml/dispatches"
    ) {
      this.dispatchCalls++;
      assert.deepEqual(JSON.parse(request.body!), {
        ref: "sentinel-supervisor",
      });
      if (this.dispatch !== "invisible") {
        this.supervisorRuns.push(
          supervisorRun(this.dispatch === "wrong_sha" ? D : this.launcher, 900),
        );
        if (this.dispatch === "ambiguous") {
          this.supervisorRuns.push(supervisorRun(this.launcher, 901));
        }
      }
      if (this.dispatch === "lost") throw new Error("lost dispatch response");
      return response(null, 204);
    }
    if (request.method !== "GET") {
      throw new Error(`unexpected fake mutation ${path}`);
    }
    if (path === "") return response(repository);
    if (
      path === "/git/matching-refs/heads/sentinel-state/maintenance-index"
    ) {
      return response(
        this.matrixIndex === null ? [] : [{
          ref: "refs/heads/sentinel-state/maintenance-index",
          object: { type: "commit", sha: INDEX_COMMIT },
        }],
      );
    }
    if (path.startsWith("/git/ref/")) {
      const name = path.slice("/git/ref/".length);
      const value = name === "heads/development"
        ? this.development
        : name === "heads/sentinel-supervisor"
        ? this.launcher
        : name === "heads/sentinel-state/release"
        ? this.stateHead
        : name === "heads/sentinel-state/maintenance-index"
        ? (this.matrixIndex === null ? null : INDEX_COMMIT)
        : name === "heads/sentinel-state/repair"
        ? (this.repairReservations.size === 0 ? null : REPAIR_COMMIT)
        : null;
      if (value === null) return response({ message: "Not Found" }, 404);
      return response({
        ref: `refs/${name}`,
        object: { type: "commit", sha: value },
      });
    }
    if (path === `/git/commits/${this.stateHead}`) {
      return response({ sha: this.stateHead, tree: { sha: TREE } });
    }
    if (path === `/git/commits/${INDEX_COMMIT}`) {
      return response({ sha: INDEX_COMMIT, tree: { sha: INDEX_TREE } });
    }
    if (path === `/git/commits/${REPAIR_COMMIT}`) {
      return response({ sha: REPAIR_COMMIT, tree: { sha: REPAIR_TREE } });
    }
    // Source commits: root tree → `.github` → `workflows`, whose id is the
    // commit's entry in `workflowTrees` (one shared default otherwise).
    const commitTree = /^\/git\/commits\/([0-9a-f]{40})$/.exec(path);
    if (commitTree !== null) {
      const commit = commitTree[1];
      const root = ("a" + commit).slice(0, 40);
      const github = ("b" + commit).slice(0, 40);
      this.sourceTrees.set(root, {
        path: ".github",
        sha: github,
      });
      this.sourceTrees.set(github, {
        path: "workflows",
        sha: this.workflowTrees.get(commit) ?? "e".repeat(40),
      });
      return response({ sha: commit, tree: { sha: root } });
    }
    const sourceTree = /^\/git\/trees\/([0-9a-f]{40})$/.exec(path);
    const entry = sourceTree === null
      ? undefined
      : this.sourceTrees.get(sourceTree[1]);
    if (sourceTree !== null && entry !== undefined) {
      return response({
        sha: sourceTree[1],
        truncated: false,
        tree: [{ ...entry, type: "tree", mode: "040000" }],
      });
    }
    if (path === `/git/trees/${INDEX_TREE}`) {
      return response({
        sha: INDEX_TREE,
        truncated: false,
        tree: [{
          path: "current-matrix.json",
          sha: INDEX_BLOB,
          type: "blob",
          mode: "100644",
        }],
      });
    }
    if (path === `/git/trees/${REPAIR_TREE}`) {
      return response({
        sha: REPAIR_TREE,
        truncated: false,
        tree: await Promise.all(
          [...this.repairReservations.keys()].map(async (id) => ({
            path: `reservations/${await sha256Hex(id)}.json`,
            sha: await reservationBlob(id),
            type: "blob",
            mode: "100644",
          })),
        ),
      });
    }
    if (path === `/git/trees/${TREE}`) {
      return response({
        sha: TREE,
        truncated: this.treeTruncated,
        tree: [
          {
            path: "hostedRuntimes/runtime.json",
            sha: BLOB,
            type: "blob",
            mode: "100644",
          },
          ...this.installations.map((_, index) => ({
            path: `hostedInstallations/${index}.json`,
            sha: String(index + 5).padStart(40, "0"),
            type: "blob",
            mode: "100644",
          })),
        ],
      });
    }
    if (path.startsWith("/git/blobs/")) {
      const identity = path.slice("/git/blobs/".length);
      if (identity === INDEX_BLOB) {
        return response({
          sha: identity,
          encoding: "base64",
          content: btoa(JSON.stringify(this.matrixIndex)),
        });
      }
      const repair = await Promise.all(
        [...this.repairReservations].map(async ([id, value]) => ({
          sha: await reservationBlob(id),
          value,
        })),
      );
      const reservation = repair.find((row) => row.sha === identity);
      if (reservation !== undefined) {
        return response({
          sha: identity,
          encoding: "base64",
          content: btoa(JSON.stringify(reservation.value)),
        });
      }
      const value = identity === BLOB
        ? {
          version: "v1",
          kind: "hosted_runtime",
          id: CONTROLLER.runtimeId,
          activeRevision: this.installed,
          generation: 81,
          lastHealthyProof: null,
          lastExecutionProof: null,
          nextOrdinaryAt: NOW,
          execution: this.execution,
          createdAt: NOW,
          updatedAt: NOW,
        }
        : this.installations[Number(identity) - 5];
      assert.notEqual(value, undefined);
      return response({
        sha: identity,
        encoding: "base64",
        content: btoa(JSON.stringify(value)),
      });
    }
    if (path.startsWith("/commits/")) {
      const head = path.slice("/commits/".length);
      const parents = this.parents.get(head);
      assert.notEqual(parents, undefined);
      return response({
        sha: head,
        parents: parents!.map((item) => ({ sha: item })),
      });
    }
    if (path.startsWith("/compare/")) {
      const [base, head] = path.slice("/compare/".length).split("...");
      const ancestor = this.isAncestor(base, head);
      return response({
        base_commit: { sha: base },
        merge_base_commit: { sha: ancestor ? base : L },
        status: ancestor ? "ahead" : "diverged",
        ahead_by: 1,
        behind_by: ancestor ? 0 : 1,
        total_commits: ancestor ? 1 : 2,
      });
    }
    if (path === `/actions/workflows/${FOLLOW_CI_WORKFLOW_ID}/runs`) {
      return this.page(
        this.ci.get(url.searchParams.get("head_sha")!) ?? [],
        "workflow_runs",
        url,
      );
    }
    if (path === "/actions/workflows/supervisor.yml/runs") {
      const status = url.searchParams.get("status");
      return this.page(
        this.supervisorRuns.filter((run) =>
          status === null || run.status === status
        ),
        "workflow_runs",
        url,
      );
    }
    const jobs = /^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/.exec(path);
    if (jobs !== null) {
      const runId = Number(jobs[1]);
      const run = this.findRun(runId);
      return this.page(
        this.jobs.get(runId) ?? [{
          id: runId * 100,
          run_id: runId,
          run_attempt: run.run_attempt,
          head_sha: run.head_sha,
          name: "test-local",
          status: "completed",
          conclusion: "success",
        }],
        "jobs",
        url,
      );
    }
    const run = /^\/actions\/runs\/(\d+)(?:\/attempts\/\d+)?$/.exec(path);
    if (run !== null) return response(this.findRun(Number(run[1])));
    throw new Error(`unexpected fake read ${path}`);
  };

  private findRun(id: number): Record<string, unknown> {
    const run = [...this.ci.values()].flat().concat(this.supervisorRuns).find((
      item,
    ) => item.id === id);
    assert.ok(run, `unknown run ${id}`);
    return run;
  }

  private page(
    rows: Record<string, unknown>[],
    key: string,
    url: URL,
  ): HttpResponseV1 {
    const page = Number(url.searchParams.get("page") ?? 1);
    const start = (page - 1) * 100;
    const headers = new Headers();
    if (rows.length > start + 100) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers.set("link", `<${next}>; rel="next"`);
    }
    return response(
      { total_count: rows.length, [key]: rows.slice(start, start + 100) },
      200,
      headers,
    );
  }

  private isAncestor(
    base: string,
    head: string,
    visited = new Set<string>(),
  ): boolean {
    if (head === base) return true;
    if (visited.has(head)) return false;
    visited.add(head);
    return (this.parents.get(head) ?? []).some((parent) =>
      this.isAncestor(base, parent, visited)
    );
  }
}
