/** Real private Git/state and production native reader; every HTTP response is synthetic. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedReleaseRecordV1,
  parseHostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
  DenoGitRunner,
} from "../../src/state/mod.ts";
import { ownerDevelopmentInstallFiles } from "../../src/host/owner-install-snapshot.ts";
import {
  HOSTED_RUNTIME_ROLLOUT,
  parseHostedRuntimeRollout,
} from "../../src/host/hosted-runtime-rollout.ts";
import { sha256HexText } from "../../src/host/owner-install-api.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  localDeliveryRecord,
  referencedDeliveryReceipt,
} from "../repair/loop-delivery-fixtures.ts";
import { issueWire } from "../github/helpers.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-task-acceptance.ts";
import { originalPriorNativeFingerprint } from "../../src/host/owner-install-supersession-original.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_GEN81_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION,
} from "../../src/host/owner-install-runtime-pins.ts";
import { principalSourceFixture } from "./hosted-app-principal-fixtures.ts";
import { runHostedAutonomyMain } from "../../ops/hosted-autonomy-main.ts";
import type { HostedMaintenanceCompatibilityFixture } from "../../ops/hosted-autonomy-compatibility.ts";
import { snapshotWire } from "../github/merge-queue-fixtures.ts";
import { nativeWriterFixture } from "./existing-pr-runtime-fixtures.ts";
import { createOwnerInstallTransport } from "./owner-install-fixture-transport.ts";
import {
  releaseRequest,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import {
  attemptBody,
  iso,
  jobBody,
  logText,
  makeRig as nativeRig,
  response,
  runtimeStep,
  settlementProof,
  terminalRecord,
} from "../github/hosted-execution-helpers.ts";

export const FUTURE = "f".repeat(40) as GitSha;
export const PRIOR = "e".repeat(40) as GitSha;
export const NEXT_NORMAL = "d".repeat(40) as GitSha;
const BASE = 1_790_000_000_000;
export const RECOVERY_NOW = BASE + 100_000;
type Fault =
  | "source_ci"
  | "source_ci_rate_limit"
  | "target_ci"
  | "ancestry"
  | "profile"
  | "witness"
  | "proof"
  | "log"
  | "actor_source"
  | "active_writer"
  | "rate_limit"
  | "cooldown"
  | "chronology"
  | "purpose"
  | "observation";

async function nativeProof(
  revision: GitSha,
  generation: number,
  runId: number,
  at: number,
  outcome: "healthy" | "failed",
  released = false,
  saved?: HostedExecutionIntentV1,
  ordinary = false,
) {
  const execution = saved ?? parseHostedExecutionIntentV1({
    id: `${runId}:1:repair`,
    runId,
    runAttempt: 1,
    launcherSha: "a".repeat(40),
    revision,
    generation,
    purpose: released
      ? "candidate"
      : outcome === "failed" && !ordinary
      ? "bootstrap"
      : "ordinary",
    releaseId: released ? "fixture-release" : null,
    createdAt: at,
  });
  const healthy = outcome === "healthy";
  const attempt = {
    ...attemptBody({
      runId,
      attempt: 1,
      headSha: execution.launcherSha,
      conclusion: healthy ? "success" : "failure",
    }),
    run_started_at: iso(at + 500),
    updated_at: iso(at + 2500),
  };
  const job = jobBody({
    id: runId * 10,
    runId,
    attempt: 1,
    headSha: execution.launcherSha,
    startedAt: at + 500,
    completedAt: at + 2500,
    conclusion: healthy ? "success" : "failure",
    steps: [
      runtimeStep({
        started_at: iso(at + 900),
        completed_at: iso(at + 2000),
        conclusion: healthy ? "success" : "failure",
      }),
    ],
  });
  const log = logText([
    terminalRecord(execution, {
      controllerSha: revision,
      startedAt: at + 1000,
      finishedAt: at + 1500,
      outcome,
      startupReady: healthy,
      baseSha: healthy ? revision : null,
    }),
  ], at + 1500);
  const path =
    `/repos/ubiquity-sentinel/sentinel/actions/runs/${runId}/attempts/1`;
  const logPath = `/repos/ubiquity-sentinel/sentinel/actions/jobs/${
    runId * 10
  }/logs`;
  const signed =
    `https://productionresultssa17.blob.core.windows.net/logs/${runId}?sig=fixture`;
  const rig = nativeRig(at + 4000);
  rig.http.on("GET", path, () => response(200, attempt));
  rig.http.on(
    "GET",
    `${path}/jobs`,
    () => response(200, { total_count: 1, jobs: [job] }),
  );
  rig.http.on("GET", logPath, () => response(302, "", { location: signed }));
  rig.http.on("GET", `/logs/${runId}`, () => response(200, log));
  return {
    proof: settlementProof(await rig.client.readHostedExecution(execution)),
    path,
    attempt,
    job,
    logPath,
    signed,
    log,
  };
}

/** Genuine generic native settlement of the actual saved bootstrap intent. */
export async function futureNativeSettlement(
  execution: HostedExecutionIntentV1,
  outcome: "healthy" | "failed",
) {
  return (await nativeProof(
    execution.revision,
    execution.generation,
    execution.runId,
    execution.createdAt,
    outcome,
    false,
    execution,
  )).proof;
}

export async function futureRecoveryFixture(
  options: {
    ownHealth?: boolean;
    restored?: boolean;
    fault?: Fault;
    releaseCas?: boolean;
    legacyFirst?: boolean;
    ownerSupersession?: boolean;
  } = {},
) {
  const source = await principalSourceFixture();
  const original = {
    command: Deno.Command,
    fetch: globalThis.fetch,
    cwd: Deno.cwd,
    env: Deno.env.get,
    now: Date.now,
    log: console.log,
  };
  const remote = `${source.root}/state.git`;
  const ref = "refs/heads/sentinel-state/release";
  const gitArgs = ["--git-dir", remote];
  const git = (args: string[], input?: string, index?: string) =>
    new Promise<string>((resolve, reject) => {
      const child = new original.command("git", {
        args,
        cwd: source.root,
        clearEnv: true,
        env: {
          PATH: original.env("PATH") ?? "/usr/bin:/bin",
          HOME: source.root,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          ...(index === undefined ? {} : { GIT_INDEX_FILE: index }),
        },
        stdin: input === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      (async () => {
        if (input !== undefined) {
          const writer = child.stdin.getWriter();
          await writer.write(new TextEncoder().encode(input));
          await writer.close();
        }
        const result = await child.output();
        assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
        resolve(new TextDecoder().decode(result.stdout).trim());
      })().catch(reject);
    });
  try {
    await git(["init", "--bare", remote]);
    const state = createReleaseStateStore({
      remoteUrl: remote,
      scratchDir: `${source.root}/release-read`,
      runner: new DenoGitRunner(`${source.root}/git-home`),
    });
    const repair = createRepairStateStore({
      remoteUrl: remote,
      scratchDir: `${source.root}/repair-read`,
      runner: new DenoGitRunner(`${source.root}/repair-home`),
    });
    const supersededId =
      "release:f4374801275ca250d0df1d1b4c798e792b0608bf68f81711fa0139adeeaff6f5";
    const request = {
      ...releaseRequest(),
      id: supersededId,
      revision: "1838df313105bab219d71602695a7f758a65125e" as GitSha,
      source: { ...releaseRequest().source, pullRequest: 172 },
    };
    const work = parseWorkRecordV1({
      ...localDeliveryRecord(170),
      id: "issue-ubiquity-sentinel-170",
      target: {
        ...localDeliveryRecord(170).target,
        pr: request.source.pullRequest,
        head: request.source.head,
        base: request.source.base,
      },
    });
    const repairWrite = await repair.writeRepair(
      parseRepairStateSnapshotV1({
        version: "v1",
        kind: "repair_state_snapshot",
        stateHead: null,
        sequence: 1,
        updatedAt: BASE,
        incidents: [],
        evidence: [],
        work: options.ownerSupersession ? [work] : [],
        reservations: [],
        reviews: options.ownerSupersession
          ? [
            referencedDeliveryReceipt(
              request,
              work,
              await reviewTaskStatementDigest({
                issueNumber: 170,
                title: "issue 170",
                body: "still wanted",
              }),
            ),
          ]
          : [],
        replays: [],
        releaseRequests: options.ownerSupersession ? [request] : [],
        githubCooldowns: options.fault === "cooldown"
          ? [{
            installationId: 0,
            retryNotBefore: RECOVERY_NOW + 60_000,
            observedAt: BASE,
            observationId: "a".repeat(64),
            secondaryBackoff: 0,
          }]
          : [],
        attemptMemory: [],
        lessons: [],
      }),
      null,
    );
    assert.ok(repairWrite.ok && repairWrite.value.status === "applied");
    const repairHead = repairWrite.value.head;
    const fromRevision = options.legacyFirst
      ? OWNER_DEVELOPMENT_INSTALL_GEN81_REVISION
      : FUTURE;
    const fromGeneration = options.legacyFirst
      ? OWNER_DEVELOPMENT_INSTALL_GEN81_GENERATION
      : options.restored
      ? 84
      : 82;
    const healthy = await nativeProof(
      options.legacyFirst
        ? fromRevision
        : options.ownHealth || options.restored
        ? FUTURE
        : PRIOR,
      options.legacyFirst
        ? fromGeneration
        : options.ownHealth || options.restored
        ? 82
        : 81,
      500,
      BASE,
      "healthy",
    );
    if (options.fault === "observation") {
      healthy.proof = parseHostedRunProofV1({
        ...healthy.proof,
        observedAt: RECOVERY_NOW + 1,
      });
    }
    const failed = await nativeProof(
      fromRevision,
      fromGeneration,
      options.ownerSupersession ? 39170939335 : 501,
      BASE +
        (options.ownerSupersession
          ? 20_000
          : options.fault === "chronology"
          ? 1000
          : 10_000),
      "failed",
      options.fault === "purpose",
      options.ownerSupersession
        ? parseHostedExecutionIntentV1({
          id: "39170939335:1:repair",
          runId: 39170939335,
          runAttempt: 1,
          launcherSha: "00b6649eeff51a9754bf3748f793137db9bf8605",
          revision: fromRevision,
          generation: fromGeneration,
          purpose: "prior",
          releaseId: supersededId,
          createdAt: BASE + 20_000,
        })
        : undefined,
      options.legacyFirst,
    );
    const originalHistorical = options.ownerSupersession
      ? await nativeProof(
        fromRevision,
        fromGeneration,
        39167387867,
        BASE + 10_000,
        "failed",
        false,
        parseHostedExecutionIntentV1({
          ...failed.proof.execution,
          id: "39167387867:1:repair",
          runId: 39167387867,
          createdAt: BASE + 10_000,
        }),
      )
      : failed;
    const superseded = parseHostedReleaseRecordV1({
      version: "v1",
      kind: "hosted_release",
      id: supersededId,
      request,
      priorRevision: fromRevision,
      phase: "requested",
      priorProof: null,
      candidateProof: null,
      rollbackProof: null,
      pointerIntent: null,
      createdAt: BASE,
      updatedAt: BASE + 20_000,
    });
    let sequence = 0;
    const seed = async (runtime: HostedRuntimeRecordV1, parent?: GitSha) => {
      const previous = parent ?? "b".repeat(40) as GitSha;
      const snapshot = parseReleaseStateSnapshotV1({
        ...releaseSnapshot({
          runtime,
          hostedReleases: options.ownerSupersession ? [superseded] : [],
        }),
        stateHead: previous,
        sequence: ++sequence,
        updatedAt: BASE + sequence * 10_000,
      });
      const files = await ownerDevelopmentInstallFiles(snapshot, previous);
      if (!parent) {
        files.manifest.text = canonicalStringify({
          ...JSON.parse(files.manifest.text),
          stateHead: null,
        }) + "\n";
      }
      const index = `${source.root}/seed-index`;
      await git(
        [...gitArgs, "read-tree", ...(parent ? [parent] : ["--empty"])],
        undefined,
        index,
      );
      for (
        const file of [
          files.manifest,
          files.record,
          ...(options.ownerSupersession
            ? [{
              path: `hostedReleases/${await sha256HexText(supersededId)}.json`,
              text: canonicalStringify(superseded) + "\n",
            }]
            : []),
        ]
      ) {
        const blob = await git(
          [...gitArgs, "hash-object", "-w", "--stdin"],
          file.text,
        );
        await git(
          [
            ...gitArgs,
            "update-index",
            "--add",
            "--cacheinfo",
            "100644",
            blob,
            file.path,
          ],
          undefined,
          index,
        );
      }
      const tree = await git([...gitArgs, "write-tree"], undefined, index);
      const head = await git([
        ...gitArgs,
        "commit-tree",
        tree,
        ...(parent ? ["-p", parent] : []),
        "-m",
        "synthetic historical state",
      ]) as GitSha;
      await git([
        ...gitArgs,
        "update-ref",
        ref,
        head,
        ...(parent ? [parent] : []),
      ]);
      return head;
    };
    const witness = await seed(
      runtimeRecord({
        revision: healthy.proof.execution.revision,
        generation: healthy.proof.execution.generation,
        healthyProof: healthy.proof,
        executionProof: healthy.proof,
      }),
    );
    const originalFailedPriorWitnessHead = options.ownerSupersession
      ? await seed(
        runtimeRecord({
          revision: fromRevision,
          generation: fromGeneration,
          healthyProof: healthy.proof,
          executionProof: originalHistorical.proof,
        }),
        witness,
      )
      : witness;
    const currentHead = await seed(
      runtimeRecord({
        revision: fromRevision,
        generation: fromGeneration,
        healthyProof: healthy.proof,
        executionProof: failed.proof,
      }),
      originalFailedPriorWitnessHead,
    );
    const ownerAcceptanceBase = await source.git(source.runtime, [
      "rev-parse",
      "HEAD",
    ]) as GitSha;
    if (options.ownerSupersession) {
      await source.write(
        source.runtime,
        "runtime.ts",
        "// Newly accepted capable F implementation\n",
      );
      await source.write(
        source.runtime,
        "src/host/hosted-runtime-rollout.json",
        // Frozen F predates the launcher-owned LF authority.
        JSON.stringify({
          ...HOSTED_RUNTIME_ROLLOUT,
          installs: [],
          ownerSupersessions: [],
          ownerSuccessorTaskBindings: [],
        }),
      );
      await source.git(source.runtime, ["add", "."]);
      await source.git(source.runtime, [
        "commit",
        "-qm",
        "freeze capable F before LF intent data",
      ]);
    }
    const successor = await source.git(source.runtime, [
      "rev-parse",
      "HEAD",
    ]) as GitSha;
    const row = {
      fromRevision,
      fromGeneration,
      toRevision: successor,
      toGeneration: fromGeneration + 1,
      failedProofSha256: await sha256HexText(canonicalStringify(failed.proof)),
      retainedHealthyProofSha256: await sha256HexText(
        canonicalStringify(healthy.proof),
      ),
      healthyWitnessHead: options.fault === "witness"
        ? "0".repeat(40)
        : witness,
    };
    const currentSnapshot = await state.readRelease();
    const repairSnapshot = await repair.readRepair();
    assert.ok(currentSnapshot.ok && currentSnapshot.value.status === "found");
    assert.ok(repairSnapshot.ok && repairSnapshot.value.status === "found");
    const controllerSource = await source.git(source.launcher, [
      "rev-parse",
      "HEAD",
    ]) as GitSha;
    const ownerIntent = {
      releaseId: supersededId,
      requestSha256: await sha256HexText(canonicalStringify(request)),
      sourceSha256: await sha256HexText(canonicalStringify(request.source)),
      taskSha256: await reviewTaskStatementDigest({
        issueNumber: 170,
        title: "issue 170",
        body: "still wanted",
      }),
      workId: work.id,
      workSha256: await sha256HexText(canonicalStringify(work)),
      issueNumber: 170,
      repairHead,
      releaseHead: currentHead,
      repairSnapshotSha256: await sha256HexText(
        canonicalStringify(repairSnapshot.value.snapshot),
      ),
      releaseSnapshotSha256: await sha256HexText(
        canonicalStringify(currentSnapshot.value.snapshot),
      ),
      fromRevision,
      fromGeneration,
      authorizedAt: RECOVERY_NOW,
      toRevision: successor,
      toGeneration: fromGeneration + 1,
      controllerSourceRevision: controllerSource,
      controllerCodeSha256: source.profiles[0].codeSha256,
      acceptanceBaseRevision: ownerAcceptanceBase,
      ciRevision: successor,
      requiredAncestors: [
        "1838df313105bab219d71602695a7f758a65125e",
        controllerSource,
      ],
      failedProofSha256: row.failedProofSha256,
      retainedHealthyProofSha256: row.retainedHealthyProofSha256,
      healthyWitnessHead: witness,
      originalFailedPriorExecution: originalHistorical.proof.execution,
      originalFailedPriorJobId: originalHistorical.proof.jobId,
      originalFailedPriorNativeSha256: await originalPriorNativeFingerprint(
        originalHistorical.proof,
      ),
    };
    let rollout = parseHostedRuntimeRollout({
      ...HOSTED_RUNTIME_ROLLOUT,
      ownerSupersessions: options.ownerSupersession ? [ownerIntent] : [],
      recoveries: [row],
      installs: [
        ...(options.legacyFirst
          ? [{
            fromRevision,
            fromGeneration,
            toRevision: successor,
            toGeneration: fromGeneration + 1,
            rollbackToPrior: false,
          }]
          : [{
            fromRevision: PRIOR,
            fromGeneration: 81,
            toRevision: FUTURE,
            toGeneration: 82,
            rollbackToPrior: false,
          }]),
        ...(options.ownerSupersession ? [] : [{
          fromRevision: options.legacyFirst ? successor : FUTURE,
          fromGeneration: 82,
          toRevision: NEXT_NORMAL,
          toGeneration: 83,
          rollbackToPrior: true,
        }]),
      ],
    });
    const migrations = options.legacyFirst
      ? [{
        fromRevision,
        fromGeneration,
        toRevision: successor,
        toGeneration: fromGeneration + 1,
      }]
      : [];
    const revisions = options.legacyFirst
      ? [NEXT_NORMAL, successor]
      : [FUTURE, NEXT_NORMAL, successor];
    let queue = {
      proofActivated: true,
      revisions,
      ...(options.legacyFirst ? { ownerInstallMigrations: migrations } : {}),
    };
    let custody = {
      custodyActivated: true,
      revisions,
      ...(options.legacyFirst ? { ownerInstallMigrations: migrations } : {}),
    };
    if (options.legacyFirst) {
      await source.write(
        source.launcher,
        "src/host/hosted-custody-capability.json",
        JSON.stringify({
          version: 1,
          takeover: { activated: false },
          queue,
          existingPr: custody,
        }),
      );
    }
    await source.write(source.launcher, ".gitignore", ".sentinel/\n");
    await source.write(
      source.launcher,
      "src/host/hosted-runtime-rollout.json",
      JSON.stringify(rollout),
    );
    await source.write(
      source.launcher,
      "src/host/hosted-app-source-profiles.json",
      JSON.stringify(options.fault === "profile" ? [] : source.profiles),
    );
    await source.git(source.launcher, ["add", "."]);
    await source.git(source.launcher, [
      "commit",
      "-qm",
      "reviewed synthetic recovery data",
    ]);
    let controller = await source.git(source.launcher, [
      "rev-parse",
      "HEAD",
    ]) as GitSha;
    const run = { runId: 9000, runAttempt: 1, launcherSha: controller };
    const nativeProofs = [healthy, failed, originalHistorical];
    const environment: Record<string, string> = {
      GITHUB_REPOSITORY: "ubiquity-sentinel/sentinel",
      GITHUB_REF: "refs/heads/sentinel-supervisor",
      GITHUB_JOB: "prepare",
      GITHUB_RUN_ID: String(run.runId),
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: controller,
      GITHUB_WORKFLOW_SHA: controller,
      GITHUB_WORKFLOW_REF:
        "ubiquity-sentinel/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
      GITHUB_TOKEN: "offline-native-token-value",
      SENTINEL_SUPERVISOR_TOKEN: "offline-app-token-value",
    };
    const writer = createOwnerInstallTransport({
      directory: source.root,
      remote,
      originalCommand: original.command,
      environment,
      git,
      gitArgs,
      ref,
      beforeHead: currentHead,
      store: state,
      snapshot: (await state.readRelease() as {
        ok: true;
        value: {
          status: "found";
          snapshot: ReturnType<typeof releaseSnapshot>;
        };
      }).value.snapshot,
      candidateRevision: successor,
      refusal: options.releaseCas ? "parent" : undefined,
      state: {
        archivesUnavailable: false,
        fixtureNow: RECOVERY_NOW,
        expectedRepairHead: repairHead,
      },
    });
    const writerFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = async (request, init) => {
      const url = new URL(
        request instanceof Request ? request.url : String(request),
      );
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      const reply = (value: unknown, status = 200) =>
        new Response(
          typeof value === "string" ? value : JSON.stringify(value),
          { status },
        );
      if (url.pathname.endsWith("/issues/170")) {
        return reply(
          issueWire({
            number: 170,
            title: "issue 170",
            body: "still wanted",
            state: "closed",
          }),
        );
      }
      if (url.pathname.includes("/contents/")) {
        const path = url.pathname.split("/contents/")[1];
        const text = await git([
          ...gitArgs,
          "show",
          `${url.searchParams.get("ref")}:${path}`,
        ]);
        return reply({
          type: "file",
          encoding: "base64",
          content: btoa(text + "\n"),
        });
      }
      if (url.hostname.endsWith(".blob.core.windows.net")) {
        assert.equal(new Headers(init?.headers).has("authorization"), false);
        const proof = nativeProofs.find((p) =>
          new URL(p.signed).pathname === url.pathname
        );
        assert.ok(
          proof,
          "every fake signed-log port belongs to an actual native fixture proof",
        );
        return reply(
          options.fault === "log" ? proof.log + "changed\n" : proof.log,
        );
      }
      if (url.pathname.includes("/check-runs")) {
        const sha = url.pathname.split("/").at(-2)!;
        if (sha === controller && options.fault === "source_ci_rate_limit") {
          return new Response("{}", {
            status: 429,
            headers: { "retry-after": "60" },
          });
        }
        return reply({
          total_count: 1,
          check_runs: [{
            name: "test-local",
            status: "completed",
            conclusion: (sha === controller && options.fault === "source_ci") ||
                (sha === successor && options.fault === "target_ci")
              ? "failure"
              : "success",
            head_sha: sha,
          }],
        });
      }
      if (url.pathname.includes("/compare/")) {
        return reply({
          status: options.fault === "ancestry" ? "diverged" : "ahead",
          ahead_by: 1,
          behind_by: 0,
          base_commit: {
            sha: url.pathname.split("/compare/")[1].split("...")[0],
          },
          merge_base_commit: {
            sha: url.pathname.split("/compare/")[1].split("...")[0],
          },
          total_commits: 1,
        });
      }
      if (url.pathname.endsWith("/git/ref/heads/sentinel-supervisor")) {
        return reply({ object: { sha: controller } });
      }
      if (url.pathname.includes("/actions/workflows/")) {
        const current = url.pathname.includes("supervisor.yml") &&
          url.searchParams.get("status") === "in_progress";
        return reply({
          total_count: current ? 1 : 0,
          workflow_runs: current
            ? [{
              ...attemptBody({
                runId: run.runId,
                attempt: 1,
                headSha: controller,
                status: "in_progress",
                conclusion: null,
              }),
            }]
            : [],
        });
      }
      if (url.pathname.includes(`/actions/runs/${run.runId}/attempts/1`)) {
        if (url.pathname.endsWith("/jobs")) {
          return reply({
            total_count: 1,
            jobs: [{
              ...jobBody({
                id: 90001,
                name: "prepare",
                runId: run.runId,
                attempt: 1,
                headSha: controller,
                status: "in_progress",
                conclusion: null,
              }),
              completed_at: null,
              ...(options.fault === "active_writer" ? { name: "repair" } : {}),
            }],
          });
        }
        return reply(
          attemptBody({
            runId: run.runId,
            attempt: 1,
            headSha: controller,
            status: "in_progress",
            conclusion: null,
          }),
        );
      }
      for (const proof of nativeProofs) {
        if (url.pathname === proof.logPath) {
          return new Response(null, {
            status: 302,
            headers: { location: proof.signed },
          });
        }
        if (url.pathname === proof.path) {
          if (options.fault === "rate_limit") {
            return new Response("{}", {
              status: 429,
              headers: { "retry-after": "60" },
            });
          }
          return reply(
            options.fault === "actor_source"
              ? { ...proof.attempt, head_sha: "0".repeat(40) }
              : proof.attempt,
          );
        }
        if (url.pathname === proof.path + "/jobs") {
          return reply({
            total_count: 1,
            jobs: [{
              ...proof.job,
              ...(options.fault === "proof"
                ? { id: Number(proof.job.id) + 1 }
                : {}),
            }],
          });
        }
      }
      return await writerFetch(request, init);
    };
    let now = RECOVERY_NOW;
    Date.now = () => now;
    Deno.cwd = () => source.launcher;
    Deno.env.get = (key) => {
      if (Object.hasOwn(environment, key)) return environment[key];
      if (key === "SENTINEL_SELF_TOKEN") return undefined;
      return original.env(key);
    };
    const current = async () => {
      const read = await state.readRelease();
      assert.ok(read.ok && read.value.status === "found");
      return read.value;
    };
    return {
      source,
      state,
      repair,
      get rollout() {
        return rollout;
      },
      row: rollout.recoveries[0],
      get queue() {
        return queue;
      },
      get custody() {
        return custody;
      },
      run,
      healthy: healthy.proof,
      failed: failed.proof,
      originalHistorical: originalHistorical.proof,
      successor,
      current,
      nativeSettlement: async (
        execution: HostedExecutionIntentV1,
        outcome: "healthy" | "failed",
      ) => {
        const next = await nativeProof(
          execution.revision,
          execution.generation,
          execution.runId,
          execution.createdAt,
          outcome,
          false,
          execution,
        );
        nativeProofs.push(next);
        return next.proof;
      },
      publishRollout: async (
        next: typeof rollout,
        nextQueue = queue,
        nextCustody = custody,
      ) => {
        await source.write(
          source.launcher,
          "src/host/hosted-runtime-rollout.json",
          JSON.stringify(next),
        );
        await source.write(
          source.launcher,
          "src/host/hosted-custody-capability.json",
          JSON.stringify({
            version: 1,
            takeover: { activated: false },
            queue: nextQueue,
            existingPr: nextCustody,
          }),
        );
        await source.git(source.launcher, ["add", "."]);
        await source.git(source.launcher, [
          "commit",
          "-qm",
          "exact synthetic next recovery data",
        ]);
        controller = await source.git(source.launcher, [
          "rev-parse",
          "HEAD",
        ]) as GitSha;
        run.launcherSha = controller;
        environment.GITHUB_SHA = controller;
        environment.GITHUB_WORKFLOW_SHA = controller;
        rollout = next;
        queue = nextQueue;
        custody = nextCustody;
      },
      nextRun: () => {
        run.runId++;
        environment.GITHUB_RUN_ID = String(run.runId);
      },
      calls,
      ...writer,
      setNow: (value: number) => {
        now = value;
      },
      readerInput: async () => ({
        state,
        token: environment.GITHUB_TOKEN,
        current: { ...(await current()), status: "found" as const },
        run,
        queue,
        custody,
        rollout,
      }),
      maintenance: async (
        overrides: HostedMaintenanceCompatibilityFixture = {},
      ) => {
        const output = `${source.root}/maintenance-output`;
        let effects = 0;
        const forbidden = () => {
          effects++;
          throw new Error(
            "migration routing must never construct maintenance writers",
          );
        };
        const native = nativeWriterFixture(run, "maintenance");
        const code = await runHostedAutonomyMain({
          env: {
            ...environment,
            GITHUB_JOB: "maintenance",
            GITHUB_OUTPUT: output,
          },
          deps: {
            state: {
              readRepair: () => state.readRepair(),
              readRelease: () => state.readRelease(),
              writeRepair: forbidden,
            },
            clock: { now: () => now },
            githubFor: forbidden,
            uncertainMatrix: forbidden,
            onQueueCustodyReady: forbidden,
          },
          compatibility: {
            queue,
            custody,
            rollout,
            nativeRead: native.read,
            http: (request) => {
              const path = new URL(request.url).pathname;
              assert.ok(
                path.includes("/rules/branches/") || path === "/graphql",
              );
              if (path === "/graphql") {
                assert.ok(
                  JSON.parse(request.body!).query.trimStart().startsWith(
                    "query",
                  ),
                );
              } else assert.equal(request.method, "GET");
              return Promise.resolve({
                status: 200,
                headers: new Headers(),
                bodyText: JSON.stringify(
                  path === "/graphql" ? snapshotWire(null) : [],
                ),
              });
            },
            ...overrides,
          },
        });
        const outputs = Object.fromEntries(
          (await Deno.readTextFile(output)).trimEnd().split("\n").map((line) =>
            line.split("=", 2)
          ),
        );
        return { code, effects, outputs, native };
      },
      close: async () => {
        Deno.Command = original.command;
        globalThis.fetch = original.fetch;
        Deno.cwd = original.cwd;
        Deno.env.get = original.env;
        Date.now = original.now;
        console.log = original.log;
        await source.close();
      },
    };
  } catch (error) {
    Deno.Command = original.command;
    globalThis.fetch = original.fetch;
    Deno.cwd = original.cwd;
    Deno.env.get = original.env;
    Date.now = original.now;
    console.log = original.log;
    await source.close();
    throw error;
  }
}
