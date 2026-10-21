import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { reservation, T0, workRecord } from "../state/helpers.ts";
import assert from "node:assert/strict";
import { CONTROLLER } from "./controller-identity-fixture.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedSupervisorRunIdentityV1 } from "../../src/host/actions-supervisor-types.ts";

export function nativeWriterFixture(
  run: HostedSupervisorRunIdentityV1,
  phase = "prepare",
) {
  const root = CONTROLLER.apiPath;
  const nativeRun = {
    id: run.runId,
    run_attempt: run.runAttempt,
    head_sha: run.launcherSha,
    head_branch: "sentinel-supervisor",
    workflow_id: CONTROLLER.workflowId,
    path: ".github/workflows/supervisor.yml",
    status: "in_progress",
  };
  const currentJobs: Record<string, unknown>[] = [{
    id: 11,
    name: phase,
    status: "in_progress",
    head_sha: run.launcherSha,
    runner_id: 1,
    started_at: "2026-10-18T00:00:00Z",
  }];
  const peers: Record<string, unknown>[] = [];
  const peerJobs: Record<string, unknown>[] = [];
  const paths: string[] = [];
  let ref = run.launcherSha;
  const read = (path: string): Promise<unknown | null> => {
    paths.push(path);
    const url = new URL(path, "https://example.invalid");
    if (url.pathname === `${root}/git/ref/heads/sentinel-supervisor`) {
      return Promise.resolve({ object: { sha: ref } });
    }
    if (
      url.pathname ===
        `${root}/actions/runs/${run.runId}/attempts/${run.runAttempt}`
    ) return Promise.resolve(structuredClone(nativeRun));
    if (url.pathname.endsWith("/jobs")) {
      const jobs = url.pathname.includes(`/runs/${run.runId}/`)
        ? currentJobs
        : peerJobs;
      return Promise.resolve({
        total_count: jobs.length,
        jobs: structuredClone(jobs),
      });
    }
    if (url.pathname.includes("/actions/workflows/")) {
      const status = url.searchParams.get("status");
      const rows = url.pathname.includes("/supervisor.yml/")
        ? [nativeRun, ...peers].filter((row) => row.status === status)
        : [];
      return Promise.resolve({
        total_count: rows.length,
        workflow_runs: structuredClone(rows),
      });
    }
    return Promise.resolve(null);
  };
  return {
    run,
    read,
    nativeRun,
    currentJobs,
    peers,
    peerJobs,
    paths,
    setRef: (sha: GitSha) => {
      ref = sha;
    },
  };
}

/** Extend the existing real-Git installer fixture with a clean exact launcher. */
export async function installNativeWriterFixture() {
  const get = Deno.env.get;
  const fetch = globalThis.fetch;
  const cwd = Deno.cwd();
  async function git(args: string[]) {
    const result = await new Deno.Command("git", {
      args,
      cwd,
      clearEnv: true,
      env: {
        PATH: get("PATH") ?? "/usr/bin:/bin",
        HOME: cwd,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(10_000),
    }).output();
    assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  }
  await git(["init"]);
  await Deno.writeTextFile(`${cwd}/.gitignore`, "*\n");
  await Deno.writeTextFile(
    `${cwd}/fence-controller.txt`,
    "accepted fixture launcher\n",
  );
  await git(["add", "-f", ".gitignore", "fence-controller.txt"]);
  await git(["commit", "-m", "fixture launcher"]);
  const sha = await git(["rev-parse", "HEAD"]) as GitSha;
  const native = nativeWriterFixture({
    runId: 700,
    runAttempt: 1,
    launcherSha: sha,
  });
  Deno.env.get = (name) => {
    if (name === "GITHUB_SHA" || name === "GITHUB_WORKFLOW_SHA") return sha;
    if (name === "GITHUB_RUN_ID") return "700";
    if (name === "GITHUB_RUN_ATTEMPT") return "1";
    if (name === "GITHUB_WORKFLOW_REF") {
      return CONTROLLER.workflowRef;
    }
    return get(name);
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const value = await native.read(url.pathname + url.search);
    if (value !== null) {
      return new Response(JSON.stringify(value), { status: 200 });
    }
    return await fetch(input, init);
  };
  return {
    ...native,
    close: () => {
      Deno.env.get = get;
      globalThis.fetch = fetch;
    },
  };
}

/** Real valid repair history; the legacy install fixture otherwise seeds a release manifest at this ref. */
export function retainedRepairHistory() {
  const original = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    sequence: 1,
    stateHead: null,
    updatedAt: T0 + 1000,
    incidents: [],
    evidence: [],
    work: [workRecord("task:retained-charge")],
    reservations: [reservation("retained-charge")],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  return { binding: CLOSED_C_WAVE, original, ingested: original };
}
