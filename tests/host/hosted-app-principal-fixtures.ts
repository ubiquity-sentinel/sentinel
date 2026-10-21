/** Native principal reader fixtures; all credentials and HTTP are synthetic. */
import assert from "node:assert/strict";
import type { Clock } from "../../src/contracts/ports.ts";
import type { HttpRequestV1, HttpTransportV1 } from "../../src/github/http.ts";
import { requestHeader } from "../../src/github/http.ts";
import { parseHostedAppMintGrant } from "../../src/host/hosted-app-grant.ts";
import type { HostedRuntimeIdentityV1 } from "../../src/host/hosted-runtime-identity.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { readHostedAppSourceManifest } from "../../src/host/hosted-app-principal-source.ts";
import { MemoryState } from "../repair/helpers.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedExecutionIntentV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { runProof } from "./actions-supervisor-fixture.ts";
import { SHA1, workRecord } from "../state/helpers.ts";
import {
  attemptBody,
  FakeGate,
  intent,
  JOB_STARTED,
  jobBody,
  LAUNCHER,
  OBSERVED,
  RUN_ATTEMPT,
  RUN_ID,
} from "../github/hosted-execution-helpers.ts";

export function principalGrant(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    appId: 4682172,
    installationId: 155687488,
    appSlug: "ubiquity-sentinel",
    expiresAt: new Date(OBSERVED + 60 * 60 * 1000).toISOString(),
    permissions: { contents: "write", metadata: "read" },
    repositoryIds: [101, 102],
    repositoryNames: ["sentinel", "ai.ubq.fi"],
    ...overrides,
  });
}

export function principalNativeFixture(
  job: "repair" | "matrix_plan" = "repair",
) {
  let now = OBSERVED;
  const clock: Clock = { now: () => now };
  const gate = new FakeGate();
  const identity: HostedRuntimeIdentityV1 = {
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    launcherSha: LAUNCHER,
    job,
  };
  const execution = intent();
  const names = {
    dependencyStep: "Install locked Sentinel App token dependencies",
    mintStep: "Mint the scoped sentinel App token",
    runtimeStep: job === "repair"
      ? "Run selected Sentinel runtime"
      : "Plan isolated issue matrix",
  };
  const step = (
    name: string,
    number: number,
    start: number,
    end: number | null,
  ) => ({
    name,
    number,
    status: end === null ? "in_progress" : "completed",
    conclusion: end === null ? null : "success",
    started_at: new Date(start).toISOString(),
    completed_at: end === null ? null : new Date(end).toISOString(),
  });
  const activeJob = {
    ...jobBody({ name: job, status: "in_progress", conclusion: null }),
    completed_at: null,
    steps: [
      step(names.dependencyStep, 3, JOB_STARTED + 10, JOB_STARTED + 20),
      step(names.mintStep, 5, JOB_STARTED + 30, JOB_STARTED + 40),
      step(names.runtimeStep, 6, JOB_STARTED + 50, null),
    ],
  };
  const repository = (id: number, name: string) => ({
    id,
    node_id: `R_${id}`,
    name,
    full_name: `ubiquity/${name}`,
    owner: { login: "ubiquity" },
  });
  const model = {
    attempt: attemptBody({ status: "in_progress", conclusion: null }),
    jobs: [activeJob] as Array<Record<string, unknown>>,
    repositories: [repository(101, "sentinel"), repository(102, "ai.ubq.fi")],
    calls: [] as Array<{ path: string; page: number; token: string }>,
    rejectPath: null as string | null,
    rejectStatus: 401,
    jobsTotalOverride: null as number | null,
    repositoriesTotalOverride: null as number | null,
    nextLinkOverride: null as string | null,
    omitNext: false,
    mutateBeforeReply: (_request: HttpRequestV1, _count: number) => {},
  };
  const http: HttpTransportV1 = (request) => {
    assert.equal(request.method, "GET");
    assert.equal(request.redirect, "error");
    const url = new URL(request.url);
    assert.equal(url.origin, "https://api.github.com");
    const page = Number(url.searchParams.get("page") ?? 1);
    const native = url.pathname.includes("/actions/");
    const expectedToken = native
      ? "fixture-native-actions"
      : "fixture-App-installation";
    assert.equal(
      requestHeader(request.headers, "authorization"),
      `Bearer ${expectedToken}`,
    );
    model.calls.push({ path: url.pathname, page, token: expectedToken });
    model.mutateBeforeReply(request, model.calls.length);
    const headers = new Headers({ "content-type": "application/json" });
    if (model.rejectPath !== null && url.pathname.includes(model.rejectPath)) {
      return Promise.resolve({
        status: model.rejectStatus,
        headers,
        bodyText: "{}",
      });
    }
    let body: unknown;
    if (url.pathname.endsWith("/jobs")) {
      body = {
        total_count: model.jobsTotalOverride ?? model.jobs.length,
        jobs: model.jobs.slice((page - 1) * 100, page * 100),
      };
      if (!model.omitNext && page * 100 < model.jobs.length) {
        headers.set(
          "link",
          `<https://api.github.com${url.pathname}?per_page=100&page=${
            page + 1
          }>; rel="next"`,
        );
      }
    } else if (native) body = model.attempt;
    else if (url.pathname === "/installation/repositories") {
      body = {
        total_count: model.repositoriesTotalOverride ??
          model.repositories.length,
        repositories: model.repositories.slice((page - 1) * 100, page * 100),
      };
      if (!model.omitNext && page * 100 < model.repositories.length) {
        headers.set(
          "link",
          `<https://api.github.com${url.pathname}?per_page=100&page=${
            page + 1
          }>; rel="next"`,
        );
      }
    } else {
      body = model.repositories.find((row) =>
        url.pathname === `/repos/${row.full_name}`
      );
      assert(body !== undefined);
    }
    if (
      model.nextLinkOverride !== null &&
      (url.pathname.endsWith("/jobs") ||
        url.pathname === "/installation/repositories")
    ) headers.set("link", model.nextLinkOverride);
    return Promise.resolve({
      status: 200,
      headers,
      bodyText: JSON.stringify(body),
    });
  };
  const grant = parseHostedAppMintGrant(principalGrant(), clock.now());
  assert(grant !== null);
  return {
    model,
    clock,
    gate,
    identity,
    execution,
    names,
    grant,
    setNow: (value: number) => {
      now = value;
    },
    jobInput: {
      http,
      clock,
      gate,
      token: "fixture-native-actions",
      identity,
      execution,
      steps: names,
      deadline: now + 30_000,
    },
    scopeInput: {
      http,
      clock,
      gate,
      token: "fixture-App-installation",
      repository: {
        owner: "ubiquity",
        name: "ai.ubq.fi",
        installationId: 155687488,
      },
      grant,
      deadline: now + 30_000,
    },
  };
}

/** Actual clean Git launcher/runtime siblings; every file remains checkout-owned. */
export async function principalSourceFixture(selfInstalled = false) {
  const native = principalNativeFixture();
  await Deno.mkdir(".sentinel-artifacts", { recursive: true });
  const root = await Deno.realPath(
    await Deno.makeTempDir({
      dir: ".sentinel-artifacts",
      prefix: "principal-source-",
    }),
  );
  const launcher = `${root}/launcher`;
  const runtime = `${root}/runtime`;
  const path = Deno.env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin";
  const git = async (dir: string, args: string[]) => {
    const result = await new Deno.Command("git", {
      args,
      cwd: dir,
      clearEnv: true,
      env: {
        PATH: path,
        HOME: root,
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
    assert.equal(result.success, true, "fixture Git must settle successfully");
    return new TextDecoder().decode(result.stdout).trim();
  };
  const write = async (dir: string, name: string, text: string) => {
    const destination = `${dir}/${name}`;
    await Deno.mkdir(destination.slice(0, destination.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(destination, text);
  };
  const targetText = '["ubiquity-sentinel/sentinel","ubiquity/ai.ubq.fi"]\n';
  await Deno.mkdir(runtime);
  await git(runtime, ["init", "-q"]);
  await write(runtime, "sentinel.targets.json", targetText);
  await write(runtime, "runtime.ts", "// Accepted fixture runtime\n");
  await git(runtime, ["add", "."]);
  await git(runtime, ["commit", "-qm", "fixture runtime"]);
  native.execution.revision = await git(runtime, [
    "rev-parse",
    "HEAD",
  ]) as GitSha;
  await Deno.mkdir(launcher);
  await git(launcher, ["init", "-q"]);
  for (
    const name of [
      ".github/workflows/supervisor.yml",
      "deno.json",
      "src/host/hosted-runtime-main.ts",
      "src/host/hosted-runtime-child.ts",
      "src/host/hosted-runtime-launcher.ts",
      ".github/actions/sentinel-app-token/action.yml",
      ".github/actions/sentinel-app-token/main.js",
      ".github/actions/sentinel-app-token/post.js",
      ".github/actions/sentinel-app-token/package.json",
      ".github/actions/sentinel-app-token/package-lock.json",
    ]
  ) {
    await write(launcher, name, `fixture reviewed code: ${name}\n`);
  }
  await write(launcher, "sentinel.targets.json", targetText);
  const capability = {
    version: 1,
    takeover: { activated: false },
    queue: { proofActivated: false, revisions: [], ownerInstallMigrations: [] },
    existingPr: {
      custodyActivated: true,
      revisions: [native.execution.revision],
      ownerInstallMigrations: [],
    },
  };
  await write(
    launcher,
    "src/host/hosted-custody-capability.json",
    JSON.stringify(capability),
  );
  await write(launcher, "src/host/hosted-app-source-profiles.json", "[]\n");
  await write(
    launcher,
    "src/host/hosted-runtime-rollout.json",
    JSON.stringify({
      version: 1,
      installs: [],
      ciCorrection: [],
      refreshRearm: [],
      conflictResolution: [],
      ciFirst: [],
      ciFirstFix: [],
      acceptanceCorrection: [],
      legacyReview: [],
      recoveries: [],
    }),
  );
  await git(launcher, ["add", "."]);
  await git(launcher, ["commit", "-qm", "fixture launcher"]);
  const launcherSha = await git(launcher, ["rev-parse", "HEAD"]) as GitSha;
  native.identity.launcherSha = launcherSha;
  native.execution.launcherSha = launcherSha;
  native.model.attempt.head_sha = launcherSha;
  native.model.jobs[0].head_sha = launcherSha;
  if (selfInstalled) {
    await git(runtime, ["fetch", "--no-tags", launcher, "HEAD"]);
    await git(runtime, ["checkout", "--detach", "FETCH_HEAD"]);
    native.execution.revision = launcherSha;
    native.names.dependencyStep = "Install locked self-test dependencies";
    const jobSteps = native.model.jobs[0].steps as Array<{ name: string }>;
    jobSteps[0].name = native.names.dependencyStep;
  }
  const source = {
    launcherDir: launcher,
    runtimeDir: runtime,
    identity: native.identity,
    execution: native.execution,
    process: new DenoReplayRuntime(path),
  };
  const manifest = await readHostedAppSourceManifest(source, launcher);
  const targetsSha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(targetText),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const profiles = [{
    version: 1,
    codeSha256: manifest.digest,
    targetsSha256,
    appClientId: "Iv23liHUJNXds9mU3j7Q",
    jobs: {
      repair: native.names,
      matrix_plan: {
        ...native.names,
        runtimeStep: "Plan isolated issue matrix",
      },
    },
  }];
  return {
    ...native,
    root,
    launcher,
    runtime,
    source,
    profiles,
    capability,
    git,
    write,
    close: () => Deno.remove(root, { recursive: true }),
  };
}

/** Real snapshot parsers and exact source/native inputs for the private factory. */
export async function principalHostFixture(selfInstalled = false) {
  const rig = await principalSourceFixture(selfInstalled);
  const state = new MemoryState();
  const healthy = parseHostedExecutionIntentV1({
    ...rig.execution,
    id: "899:2:repair",
    runId: 899,
    purpose: "bootstrap",
    createdAt: rig.execution.createdAt - 10_000,
  });
  state.setRelease(parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: OBSERVED,
    releases: [],
    hostedReleases: [],
    githubCooldowns: [],
    hostedRuntimes: [{
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: rig.execution.revision,
      generation: rig.execution.generation,
      lastHealthyProof: runProof(healthy, "healthy"),
      lastExecutionProof: null,
      nextOrdinaryAt: OBSERVED,
      execution: rig.execution,
      createdAt: healthy.createdAt,
      updatedAt: OBSERVED,
    }],
  }));
  const task = workRecord("principal-task", {
    repository: {
      owner: "ubiquity-sentinel",
      name: "sentinel",
      installationId: 0,
    },
  });
  state.repair = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: OBSERVED,
    incidents: [],
    evidence: [],
    work: [task],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  state.repairHead = SHA1;
  const hostInput = {
    source: rig.source,
    state,
    clock: rig.clock,
    gate: rig.gate,
    http: rig.jobInput.http,
    nativeToken: rig.jobInput.token,
    appToken: rig.scopeInput.token as string | undefined,
    mintGrant: principalGrant() as string | undefined,
    appTokenNotAfter: String(OBSERVED + 58 * 60_000) as string | undefined,
    deadline: OBSERVED + 30_000,
  };
  const commitLauncher = async () => {
    await rig.git(rig.launcher, ["add", "."]);
    await rig.git(rig.launcher, ["commit", "-qm", "fixture launcher data"]);
    const head = await rig.git(rig.launcher, ["rev-parse", "HEAD"]) as GitSha;
    rig.identity.launcherSha = head;
    rig.execution.launcherSha = head;
    rig.model.attempt.head_sha = head;
    rig.model.jobs[0].head_sha = head;
    const release = parseReleaseStateSnapshotV1(state.release!.snapshot);
    release.hostedRuntimes[0].execution = structuredClone(rig.execution);
    state.setRelease(release);
  };
  return { ...rig, state, task, hostInput, commitLauncher };
}

/** Convert an existing owned-child fixture to the installed launcher SHA. */
export async function selfInstallPrincipalFixture(
  rig: Awaited<ReturnType<typeof principalHostFixture>>,
) {
  // The source-only launcher fixture becomes an actual Deno child checkout.
  await rig.write(rig.launcher, "deno.json", "{}\n");
  for (const path of ["src/host/actions.ts", "src/host/matrix-actions.ts"]) {
    await rig.write(
      rig.launcher,
      path,
      await Deno.readTextFile(`${rig.runtime}/${path}`),
    );
  }
  await rig.commitLauncher();
  await rig.git(rig.runtime, ["fetch", "--no-tags", rig.launcher, "HEAD"]);
  await rig.git(rig.runtime, ["checkout", "--detach", "FETCH_HEAD"]);
  rig.execution.revision = rig.identity.launcherSha;
  rig.names.dependencyStep = "Install locked self-test dependencies";
  const steps = rig.model.jobs[0].steps as Array<{ name: string }>;
  steps[0].name = rig.names.dependencyStep;
  const release = parseReleaseStateSnapshotV1(rig.state.release!.snapshot);
  const runtime = release.hostedRuntimes[0];
  runtime.activeRevision = rig.execution.revision;
  runtime.execution = structuredClone(rig.execution);
  assert(runtime.lastHealthyProof !== null);
  runtime.lastHealthyProof = runProof({
    ...runtime.lastHealthyProof.execution,
    revision: rig.execution.revision,
    launcherSha: rig.identity.launcherSha,
  }, "healthy");
  rig.state.setRelease(release);
}
