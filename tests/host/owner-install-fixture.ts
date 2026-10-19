import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { reservation, workRecord } from "../state/helpers.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ClosedCWaveBindingV1 } from "../../src/host/modern-matrix-recovery.ts";
import {
  ownerDevelopmentInstallFiles,
  runOwnerDevelopmentInstallMain,
} from "../../src/host/owner-development-install.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
  DenoGitRunner,
} from "../../src/state/mod.ts";
import {
  CONCURRENCY_REVISION,
  LAUNCHER,
  NOW,
  T0,
} from "./owner-install-fixture-constants.ts";
import { rawSha256 } from "./owner-install-fixture-proofs.ts";
import { STARTUP_NOW } from "./owner-install-fixture-startup.ts";
import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import { createOwnerInstallTransport } from "./owner-install-fixture-transport.ts";

export type OwnerInstallRefusal =
  | "ancestry"
  | "ci"
  | "parent"
  | "readback"
  | "artifact";
export type OwnerInstallMatrixRecovery = {
  binding: ClosedCWaveBindingV1;
  original: RepairStateSnapshotV1;
  ingested: RepairStateSnapshotV1;
  nativeRefusal?: boolean;
  /** Omit only the candidate override; keep the real-Git fixture binding. */
  useSourcePin?: boolean;
};
export type OwnerInstallStartupRecovery = {
  compareFault?: "base" | "merge_base" | "counter" | "missing";
  refusal?:
    | "native"
    | "controller_ci"
    | "source"
    | "proof"
    | "repair"
    | "ambiguous";
};
export type OwnerInstallGit = (
  args: string[],
  input?: string,
  index?: string,
) => Promise<string>;

/** Real production entrypoint, fake GitHub transport, real private Git objects. */
export async function concurrencyInstallerFixture(
  snapshot: ReleaseStateSnapshotV1,
  refusal?: OwnerInstallRefusal,
  candidateRevision: GitSha = CONCURRENCY_REVISION,
  matrixRecovery?: OwnerInstallMatrixRecovery,
  startupRecovery?: OwnerInstallStartupRecovery,
) {
  const directory = await Deno.makeTempDir({
    prefix: "sentinel-owner57-",
    dir: Deno.cwd(),
  });
  const remote = `${directory}/remote.git`;
  const originalCommand = Deno.Command;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalNow = Date.now;
  let fixtureNow = startupRecovery === undefined ? NOW : STARTUP_NOW;
  let archivesUnavailable = false;
  const originalCwd = Deno.cwd();
  const originalEnvironmentGet = Deno.env.get;
  const environment: Record<string, string> = {
    GITHUB_REPOSITORY: "ubiquity/sentinel",
    GITHUB_REF: "refs/heads/sentinel-supervisor",
    GITHUB_JOB: "prepare",
    GITHUB_SHA: LAUNCHER,
    GITHUB_WORKFLOW_SHA: LAUNCHER,
    GITHUB_TOKEN: "offline-native-token",
    SENTINEL_SUPERVISOR_TOKEN: "offline-app-token-value",
    ...(startupRecovery === undefined ? {} : {
      GITHUB_RUN_ID: "999999",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_WORKFLOW_REF:
        "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
    }),
  };
  const gitEnvironment = {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: directory,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Offline fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Offline fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  async function git(args: string[], input?: string, index?: string) {
    const command = new originalCommand("git", {
      args,
      cwd: directory,
      clearEnv: true,
      env: {
        ...gitEnvironment,
        ...(index === undefined ? {} : { GIT_INDEX_FILE: index }),
      },
      stdin: input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const child = command.spawn();
    if (input !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(input));
      await writer.close();
    }
    const output = await child.output();
    assert.equal(output.code, 0, new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout).trim();
  }
  const ref = "refs/heads/sentinel-state/release";
  const gitArgs = ["--git-dir", remote];
  try {
    await git(["init", "--bare", remote]);
    const store = createReleaseStateStore({
      remoteUrl: remote,
      scratchDir: `${directory}/seed-scratch`,
      runner: new DenoGitRunner(`${directory}/seed-home`),
    });
    // Historical parsed fixtures are seeded as immutable Git objects, not
    // passed through the live store's first-install transition authority.
    const files = await ownerDevelopmentInstallFiles(
      snapshot,
      snapshot.stateHead!,
    );
    files.manifest.text = `${
      canonicalStringify({
        ...JSON.parse(files.manifest.text),
        stateHead: null,
      })
    }\n`;
    const seedFiles = [files.manifest, files.record];
    for (const record of snapshot.hostedReleases) {
      seedFiles.push({
        path: `hostedReleases/${await rawSha256(record.id)}.json`,
        text: `${canonicalStringify(record)}\n`,
      });
    }
    for (const record of snapshot.githubCooldowns) {
      seedFiles.push({
        path: `githubCooldowns/${await rawSha256(
          String(record.installationId),
        )}.json`,
        text: `${canonicalStringify(record)}\n`,
      });
    }
    const seedIndex = `${directory}/seed-index`;
    await git([...gitArgs, "read-tree", "--empty"], undefined, seedIndex);
    for (const file of seedFiles) {
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
        seedIndex,
      );
    }
    const seedTree = await git(
      [...gitArgs, "write-tree"],
      undefined,
      seedIndex,
    );
    const initialHead = await git([
      ...gitArgs,
      "commit-tree",
      seedTree,
      "-m",
      "fixed offline historical state",
    ]) as GitSha;
    await git([...gitArgs, "update-ref", ref, initialHead]);
    await git([
      ...gitArgs,
      "update-ref",
      "refs/heads/sentinel-state/repair",
      initialHead,
    ]);
    let recoveryBinding: ClosedCWaveBindingV1 | undefined;
    let expectedRepairHead = initialHead;
    if (matrixRecovery !== undefined) {
      await git([
        ...gitArgs,
        "update-ref",
        "-d",
        "refs/heads/sentinel-state/repair",
        initialHead,
      ]);
      const repairStore = createRepairStateStore({
        remoteUrl: remote,
        scratchDir: `${directory}/matrix-repair`,
        runner: new DenoGitRunner(`${directory}/matrix-home`),
      });
      const original = await repairStore.writeRepair(
        matrixRecovery.original,
        null,
      );
      assert.ok(
        original.ok && original.value.status === "applied",
        JSON.stringify(original),
      );
      const ingested = await repairStore.writeRepair(
        parseRepairStateSnapshotV1({
          ...matrixRecovery.ingested,
          stateHead: original.value.head,
          sequence: 2,
        }),
        original.value.head,
      );
      assert.ok(
        ingested.ok && ingested.value.status === "applied",
        JSON.stringify(ingested),
      );
      expectedRepairHead = ingested.value.head;
      recoveryBinding = {
        ...matrixRecovery.binding,
        repairCommit: original.value.head,
        releaseCommit: initialHead,
      };
    }
    if (startupRecovery !== undefined) {
      await git([
        ...gitArgs,
        "update-ref",
        "-d",
        "refs/heads/sentinel-state/repair",
        initialHead,
      ]);
      const repairStore = createRepairStateStore({
        remoteUrl: remote,
        scratchDir: `${directory}/startup-repair`,
        runner: new DenoGitRunner(`${directory}/startup-home`),
      });
      const seeded = await repairStore.writeRepair(
        parseRepairStateSnapshotV1({
          version: "v1",
          kind: "repair_state_snapshot",
          sequence: 1,
          stateHead: null,
          updatedAt: STARTUP_NOW,
          incidents: [],
          evidence: [],
          work: [
            workRecord("retained-foreign", {
              nextStep: "blocked",
              blocker: {
                kind: "other",
                since: T0,
                message: "merge_not_observed",
              },
            }),
          ],
          reservations: [reservation("retained-charge")],
          reviews: [],
          replays: [],
          releaseRequests: [],
          githubCooldowns: [],
          attemptMemory: [],
          lessons: [],
        }),
        null,
      );
      assert.ok(
        seeded.ok && seeded.value.status === "applied",
        JSON.stringify(seeded),
      );
      expectedRepairHead = seeded.value.head;
      await git(["init", directory]);
      await Deno.writeTextFile(`${directory}/.gitignore`, "*\n");
      await Deno.writeTextFile(
        `${directory}/controller.txt`,
        "fixed offline controller\n",
      );
      await git(["add", "-f", ".gitignore", "controller.txt"]);
      await git(["commit", "-m", "offline controller"]);
      const controller = await git(["rev-parse", "HEAD"]);
      environment.GITHUB_SHA = controller;
      environment.GITHUB_WORKFLOW_SHA = controller;
      if (startupRecovery.refusal === "source") {
        await Deno.writeTextFile(`${directory}/controller.txt`, "dirty\n");
      }
    }
    if (refusal === "artifact") {
      const blob = await git(
        [...gitArgs, "hash-object", "-w", "--stdin"],
        "unsafe",
      );
      const index = `${directory}/artifact-index`;
      await git(
        [...gitArgs, "read-tree", `${initialHead}^{tree}`],
        undefined,
        index,
      );
      const manifestBlob = await git(
        [...gitArgs, "hash-object", "-w", "--stdin"],
        `${
          canonicalStringify({
            ...JSON.parse(files.manifest.text),
            stateHead: initialHead,
          })
        }\n`,
      );
      await git(
        [
          ...gitArgs,
          "update-index",
          "--add",
          "--cacheinfo",
          "100644",
          manifestBlob,
          "manifest.json",
        ],
        undefined,
        index,
      );
      await git(
        [
          ...gitArgs,
          "update-index",
          "--add",
          "--cacheinfo",
          "100644",
          blob,
          "unexpected.txt",
        ],
        undefined,
        index,
      );
      const tree = await git([...gitArgs, "write-tree"], undefined, index);
      const commit = await git([
        ...gitArgs,
        "commit-tree",
        tree,
        "-p",
        initialHead,
        "-m",
        "unsafe artifact fixture",
      ]);
      await git([...gitArgs, "update-ref", ref, commit, initialHead]);
    }
    const beforeHead = await git([...gitArgs, "rev-parse", ref]);
    const { requests, reports, patches } = createOwnerInstallTransport({
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
      state: {
        get archivesUnavailable() {
          return archivesUnavailable;
        },
        get fixtureNow() {
          return fixtureNow;
        },
        get expectedRepairHead() {
          return expectedRepairHead;
        },
        set expectedRepairHead(value) {
          expectedRepairHead = value;
        },
      },
    });
    Date.now = () => fixtureNow;
    Deno.env.get = (name) => {
      if (Object.hasOwn(environment, name)) return environment[name];
      assert.ok(name === "PATH" || name === "NODE_V8_COVERAGE");
      return originalEnvironmentGet(name);
    };
    Deno.chdir(directory);
    return {
      initialHead,
      beforeHead,
      requests,
      reports,
      run: () =>
        runOwnerDevelopmentInstallMain({
          queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
          existingPrRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
          rollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
          ...(startupRecovery !== undefined
            ? { startupRecovery: true, startupWitness: initialHead }
            : recoveryBinding === undefined
            ? {}
            : {
              ...(matrixRecovery?.useSourcePin
                ? {}
                : { matrixRecoveryRevision: candidateRevision }),
              matrixRecoveryBinding: recoveryBinding,
            }),
        }),
      patches,
      head: () => git([...gitArgs, "rev-parse", ref]),
      read: () => store.readRelease(),
      readRepair: () => store.readRepair(),
      releaseStore: store,
      setNow: (value: number) => {
        fixtureNow = value;
      },
      setRun: (runId: number) => {
        environment.GITHUB_RUN_ID = String(runId);
      },
      runIdentity: () => ({
        runId: Number(environment.GITHUB_RUN_ID),
        runAttempt: 1,
        launcherSha: environment.GITHUB_SHA as GitSha,
      }),
      expireArchives: () => {
        archivesUnavailable = true;
      },
      message: () => git([...gitArgs, "log", "-1", "--format=%B", ref]),
      close: async () => {
        assert.equal(
          await git([
            ...gitArgs,
            "rev-parse",
            "refs/heads/sentinel-state/repair",
          ]),
          expectedRepairHead,
        );
        Deno.Command = originalCommand;
        globalThis.fetch = originalFetch;
        console.log = originalLog;
        Date.now = originalNow;
        Deno.chdir(originalCwd);
        Deno.env.get = originalEnvironmentGet;
        await Deno.remove(directory, { recursive: true });
      },
    };
  } catch (error) {
    Deno.Command = originalCommand;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    Date.now = originalNow;
    Deno.chdir(originalCwd);
    Deno.env.get = originalEnvironmentGet;
    await Deno.remove(directory, { recursive: true });
    throw error;
  }
}
