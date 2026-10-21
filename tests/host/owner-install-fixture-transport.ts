import assert from "node:assert/strict";
import startupCompareResponse from "../fixtures/startup-recovery-compare.json" with {
  type: "json",
};
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { HostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ClosedCWaveBindingV1 } from "../../src/host/modern-matrix-recovery.ts";
import { createRepairStateStore, DenoGitRunner } from "../../src/state/mod.ts";
import type { createReleaseStateStore } from "../../src/state/mod.ts";
import { DIGEST, UNRELATED } from "./owner-install-fixture-constants.ts";
import { STARTUP_RUNTIME } from "./owner-install-fixture-startup.ts";
import type {
  OwnerInstallGit,
  OwnerInstallMatrixRecovery,
  OwnerInstallRefusal,
  OwnerInstallStartupRecovery,
} from "./owner-install-fixture.ts";

type OwnerInstallTransportInput = {
  directory: string;
  remote: string;
  originalCommand: typeof Deno.Command;
  environment: Record<string, string>;
  git: OwnerInstallGit;
  gitArgs: string[];
  ref: string;
  beforeHead: string;
  store: ReturnType<typeof createReleaseStateStore>;
  snapshot: ReleaseStateSnapshotV1;
  refusal?: OwnerInstallRefusal;
  candidateRevision: GitSha;
  matrixRecovery?: OwnerInstallMatrixRecovery;
  startupRecovery?: OwnerInstallStartupRecovery;
  recoveryBinding?: ClosedCWaveBindingV1;
  state: {
    readonly archivesUnavailable: boolean;
    readonly fixtureNow: number;
    expectedRepairHead: GitSha;
  };
};

export function createOwnerInstallTransport(input: OwnerInstallTransportInput) {
  const {
    directory,
    remote,
    originalCommand,
    environment,
    git,
    gitArgs,
    ref,
    beforeHead,
    store,
    snapshot,
    refusal,
    candidateRevision,
    matrixRecovery,
    startupRecovery,
    recoveryBinding,
    state,
  } = input;
  const requests: {
    method: string;
    path: string;
    body: Record<string, unknown>;
  }[] = [];
  const reports: Record<string, unknown>[] = [];
  let patches = 0;
  let blobCount = 0;
  let treeCount = 0;
  let parentMoved = false;
  let repairMoved = false;
  let createdCommit: string | null = null;
  const response = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status });
  // Only the fixed production Git remote is rewritten; all Git children are
  // real and isolated, with the production runner's scrubbed environment.
  Deno.Command = class extends originalCommand {
    constructor(command: string | URL, options: Deno.CommandOptions = {}) {
      if (command === "git") {
        options = {
          ...options,
          args: [
            "-c",
            `url.${remote}.insteadOf=https://github.com/ubiquity-sentinel/sentinel.git`,
            ...(options.args ?? []),
          ],
        };
      }
      super(command, options);
    }
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://api.github.com");
    assert.ok(url.pathname.startsWith("/repos/ubiquity-sentinel/sentinel/"));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ method, path: url.pathname, body });
    if (startupRecovery !== undefined) {
      const currentRunId = Number(environment.GITHUB_RUN_ID);
      const controller = environment.GITHUB_SHA;
      if (url.pathname.endsWith("/git/ref/heads/sentinel-supervisor")) {
        return response({ object: { sha: controller } });
      }
      if (url.pathname.includes("/actions/workflows/")) {
        const supervisor = url.pathname.includes("/supervisor.yml/");
        const runs = supervisor
          ? [{
            id: currentRunId,
            run_attempt: 1,
            head_sha: controller,
            status: "in_progress",
          }]
          : [];
        if (startupRecovery.refusal === "native") {
          runs.push({
            id: currentRunId + 7,
            run_attempt: 1,
            head_sha: controller,
            status: "in_progress",
          });
        }
        return response({ total_count: runs.length, workflow_runs: runs });
      }
      if (url.pathname.includes("/actions/runs/")) {
        const current = url.pathname.includes(`/runs/${currentRunId}/`);
        const latest = await store.readRelease();
        assert.ok(latest.ok && latest.value.status === "found");
        const saved = latest.value.snapshot.hostedRuntimes[0]
          .lastExecutionProof! as HostedRunProofV1;
        const proof = url.pathname.includes("/runs/37704666277/")
          ? STARTUP_RUNTIME.lastHealthyProof!
          : saved;
        if (url.pathname.endsWith("/jobs")) {
          return response({
            total_count: 1,
            jobs: [{
              id: current ? 999 : proof.jobId,
              name: current ? "prepare" : "repair",
              status: current ? "in_progress" : "completed",
              head_sha: current ? controller : proof.execution.launcherSha,
              conclusion: current
                ? null
                : startupRecovery.refusal === "proof"
                ? "cancelled"
                : proof.outcome === "healthy"
                ? "success"
                : "failure",
            }],
          });
        }
        return response({
          id: current ? currentRunId : proof.execution.runId,
          run_attempt: current ? 1 : proof.execution.runAttempt,
          head_sha: current ? controller : proof.execution.launcherSha,
          workflow_id: 357012162,
          head_branch: "sentinel-supervisor",
          status: current ? "in_progress" : "completed",
        });
      }
      if (url.pathname.includes("/compare/")) {
        assert.ok(
          url.pathname.endsWith(`${candidateRevision}...${controller}`),
        );
        // Sanitized real GitHub compare shape. The API does not return
        // head_commit; the requested immutable URL binds the controller.
        const compared: Record<string, unknown> = {
          ...startupCompareResponse,
          status: refusal === "ancestry" ? "diverged" : "ahead",
          base_commit: {
            sha: startupRecovery.compareFault === "base"
              ? UNRELATED
              : candidateRevision,
          },
          merge_base_commit: {
            sha: startupRecovery.compareFault === "merge_base"
              ? UNRELATED
              : candidateRevision,
          },
          behind_by: startupRecovery.compareFault === "counter" ? 1 : 0,
          commits: [
            startupCompareResponse.commits[0],
            { sha: controller },
          ],
        };
        if (startupRecovery.compareFault === "missing") {
          delete compared.merge_base_commit;
        }
        return response(compared);
      }
      if (url.pathname.includes("/check-runs")) {
        const head = url.pathname.includes(controller)
          ? controller
          : candidateRevision;
        return response({
          total_count: 1,
          check_runs: [{
            name: "test-local",
            status: "completed",
            conclusion: refusal === "ci" ||
                (head === controller &&
                  startupRecovery.refusal === "controller_ci")
              ? "failure"
              : "success",
            head_sha: head,
          }],
        });
      }
    }
    if (
      matrixRecovery !== undefined && url.pathname.includes("/actions/runs/")
    ) {
      const latest = await store.readRelease();
      assert.ok(latest.ok && latest.value.status === "found");
      const producer = snapshot.hostedRuntimes[0].lastExecutionProof!;
      const currentProof = latest.value.snapshot.hostedRuntimes[0]
        .lastExecutionProof!;
      const proof = url.pathname.includes(String(currentProof.execution.runId))
        ? currentProof
        : producer;
      if (url.pathname.endsWith("/jobs")) {
        return response({
          total_count: 1,
          jobs: [{
            id: proof.jobId,
            status: matrixRecovery.nativeRefusal ? "in_progress" : "completed",
          }],
        });
      }
      if (url.pathname.endsWith("/artifacts")) {
        if (state.archivesUnavailable) {
          return response({ total_count: 0, artifacts: [] });
        }
        const binding = recoveryBinding!;
        return response({
          total_count: binding.cells.length + 1,
          artifacts: [
            {
              id: 1,
              name:
                `sentinel-matrix-plan-${binding.run.runId}-${binding.run.runAttempt}`,
              expired: false,
              digest: `sha256:${binding.planZipDigest ?? DIGEST}`,
            },
            ...binding.cells.map((cell, index) => ({
              id: index + 2,
              name:
                `sentinel-matrix-cell-${binding.run.runId}-${binding.run.runAttempt}-${cell.cellId}`,
              expired: false,
              digest: `sha256:${DIGEST}`,
            })),
          ],
        });
      }
      return response({
        id: proof.execution.runId,
        run_attempt: proof.execution.runAttempt,
        head_sha: proof.execution.launcherSha,
        workflow_id: proof.workflowId,
        head_branch: "sentinel-supervisor",
        status: "completed",
      });
    }
    if (url.pathname.includes("/compare/")) {
      assert.ok(
        url.pathname.endsWith(`${candidateRevision}...development`),
      );
      return response({
        status: refusal === "ancestry" ? "diverged" : "ahead",
        base_commit: { sha: candidateRevision },
        merge_base_commit: { sha: candidateRevision },
        ahead_by: 1,
        behind_by: 0,
        total_commits: 1,
      });
    }
    if (url.pathname.includes("/check-runs")) {
      return response({
        total_count: 1,
        check_runs: [{
          name: "test-local",
          status: "completed",
          conclusion: refusal === "ci" ? "failure" : "success",
          head_sha: candidateRevision,
        }],
      });
    }
    if (method === "GET" && url.pathname.includes("/git/commits/")) {
      return response({
        tree: {
          sha: await git([
            ...gitArgs,
            "rev-parse",
            `${url.pathname.split("/").at(-1)}^{tree}`,
          ]),
        },
      });
    }
    if (method === "POST" && url.pathname.endsWith("/git/blobs")) {
      let text = atob(body.content);
      if (refusal === "readback" && blobCount === 0) {
        const manifest = JSON.parse(text);
        text = `${
          canonicalStringify({ ...manifest, sequence: manifest.sequence + 1 })
        }\n`;
      }
      blobCount++;
      return response({
        sha: await git([...gitArgs, "hash-object", "-w", "--stdin"], text),
      }, 201);
    }
    if (method === "POST" && url.pathname.endsWith("/git/trees")) {
      const index = `${directory}/api-index-${treeCount++}`;
      await git([...gitArgs, "read-tree", body.base_tree], undefined, index);
      for (const entry of body.tree) {
        await git(
          [
            ...gitArgs,
            "update-index",
            "--add",
            "--cacheinfo",
            entry.mode,
            entry.sha,
            entry.path,
          ],
          undefined,
          index,
        );
      }
      return response({
        sha: await git([...gitArgs, "write-tree"], undefined, index),
      }, 201);
    }
    if (method === "POST" && url.pathname.endsWith("/git/commits")) {
      assert.equal(body.parents.length, 1);
      createdCommit = await git([
        ...gitArgs,
        "commit-tree",
        body.tree,
        "-p",
        body.parents[0],
        "-m",
        body.message,
      ]);
      return response({ sha: createdCommit }, 201);
    }
    if (method === "GET" && url.pathname.includes("/git/ref/")) {
      if (
        startupRecovery?.refusal === "repair" && createdCommit !== null &&
        !repairMoved
      ) {
        repairMoved = true;
        const updater = createRepairStateStore({
          remoteUrl: remote,
          scratchDir: `${directory}/competing-repair`,
          runner: new DenoGitRunner(`${directory}/competing-home`),
        });
        const prior = await updater.readRepair();
        assert.ok(prior.ok && prior.value.status === "found");
        const changed = await updater.writeRepair(
          parseRepairStateSnapshotV1({
            ...prior.value.snapshot,
            stateHead: prior.value.head,
            sequence: prior.value.snapshot.sequence + 1,
            updatedAt: state.fixtureNow + 1,
          }),
          prior.value.head,
        );
        assert.ok(changed.ok && changed.value.status === "applied");
        state.expectedRepairHead = changed.value.head;
      }
      if (refusal === "parent" && !parentMoved) {
        parentMoved = true;
        const tree = await git([
          ...gitArgs,
          "rev-parse",
          `${beforeHead}^{tree}`,
        ]);
        const unrelated = await git([
          ...gitArgs,
          "commit-tree",
          tree,
          "-p",
          beforeHead,
          "-m",
          "unrelated newer owner",
        ]);
        await git([...gitArgs, "update-ref", ref, unrelated, beforeHead]);
      }
      return response({
        object: { sha: await git([...gitArgs, "rev-parse", ref]) },
      });
    }
    if (method === "PATCH" && url.pathname.includes("/git/refs/")) {
      assert.equal(
        url.pathname,
        "/repos/ubiquity-sentinel/sentinel/git/refs/heads/sentinel-state/release",
      );
      assert.ok(createdCommit !== null);
      assert.deepEqual(body, { sha: createdCommit, force: false });
      patches++;
      const expected = await git([
        ...gitArgs,
        "rev-parse",
        `${createdCommit}^`,
      ]);
      await git([...gitArgs, "update-ref", ref, body.sha, expected]);
      if (startupRecovery?.refusal === "ambiguous") return response({}, 503);
      return response({ object: { sha: body.sha } });
    }
    throw new Error(`unexpected offline request: ${method} ${url.pathname}`);
  };
  console.log = (value: unknown) => reports.push(JSON.parse(String(value)));
  return { requests, reports, patches: () => patches };
}
