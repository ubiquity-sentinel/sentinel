import assert from "node:assert/strict";
import {
  authenticateReleaseBridgeJob,
  bridgeSha256,
  claimReleaseBridgeReplay,
  createNativeReleaseBridgeState,
  dispatchReleaseBridgeController,
  parseReleaseBridgeConfigDigest,
  parseReleaseBridgeInput,
  parseReleaseBridgeInstallation,
  readReleaseBridgeInput,
  RELEASE_BRIDGE_AUDIENCE,
  RELEASE_BRIDGE_ISSUER,
  RELEASE_BRIDGE_JWKS,
  RELEASE_BRIDGE_ROOT,
  RELEASE_BRIDGE_STATE_REF,
  RELEASE_BRIDGE_STATE_REPOSITORY,
  type ReleaseBridgeCapabilities,
  type ReleaseBridgeInput,
  requireReleaseBridgeState,
  runReleaseBridge,
} from "../../src/host/release-bridge.ts";
import { DenoGitRunner, type GitRunnerV1 } from "../../src/state/mod.ts";
import { githubGitAuthEnv } from "../../src/host/local-github-auth.ts";
import { parseVpsReleaseRecordV1 } from "../../src/contracts/vps-release.ts";
import {
  parseVpsReceipt,
  vpsDigest,
  type VpsHealthProof,
  type VpsIdentity,
  type VpsMutation,
  type VpsOperation,
  type VpsPrepare,
  type VpsSettlement,
} from "../../src/contracts/vps-release-wire.ts";
import {
  composeVpsReleasePort,
  type NativeVpsDriverV1,
} from "../../src/release/vps-port.ts";
import { makeGitCtx, publishRepairRequest } from "../release/helpers.ts";
import type { VpsReleaseEntrypointDepsV1 } from "../../src/release-main.ts";

const encoder = new TextEncoder();
const fixture = parseVpsReleaseRecordV1(
  JSON.parse(
    await Deno.readTextFile(
      new URL("../fixtures/vps/release-requested-v1.json", import.meta.url),
    ),
  ),
);
const NATIVE = "synthetic-native-state-token-never-public";
const execution = { runId: 123, runAttempt: 2, jobId: 456 };
const checkRunId = 789;
const workflow = encoder.encode(
  "name: sentinel-release\njobs:\n  release:\n    runs-on: ubuntu-latest\n",
);
const api = "https://api.github.com/repos/ubiquity-sentinel/sentinel";
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const url64 = (bytes: Uint8Array) =>
  b64(bytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
let signing: Promise<CryptoKeyPair> | null = null;
const signingKeys = () =>
  signing ??= crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );

async function authRig() {
  const pin = parseReleaseBridgeInstallation({
    version: "v1",
    kind: "vps_release_bridge_installation",
    activation: "owner_activated",
    controller: {
      revision: fixture.driver.controllerSha,
      root:
        `${RELEASE_BRIDGE_ROOT}/controller/releases/${fixture.driver.controllerSha}`,
      treeSha256: "a".repeat(64),
      entrypointSha256: "b".repeat(64),
    },
    driver: {
      root:
        `${RELEASE_BRIDGE_ROOT}/driver/releases/${fixture.driver.candidate.gitSha}`,
      identity: fixture.driver.candidate,
      moduleSha256: fixture.driver.driverSha256,
    },
    source: {
      revision: fixture.driver.controllerSha,
      workflowId: 42,
      workflowSha256: await bridgeSha256(workflow),
      repositoryId: 17,
      ownerId: 18,
      subject:
        "repo:ubiquity-sentinel/sentinel:environment:sentinel-release-bridge",
      environment: "sentinel-release-bridge",
    },
    targetInstallationId: 7,
    capabilitiesSha256: "c".repeat(64),
  });
  const pair = await signingKeys(),
    jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  let now = fixture.createdAt;
  const claims = {
    iss: RELEASE_BRIDGE_ISSUER,
    aud: RELEASE_BRIDGE_AUDIENCE,
    sub: pin.source.subject,
    exp: Math.floor(now / 1000) + 600,
    iat: Math.floor(now / 1000),
    nbf: Math.floor(now / 1000),
    jti: "synthetic-unique-jwt-id",
    repository: "ubiquity-sentinel/sentinel",
    repository_id: "17",
    repository_owner: "ubiquity-sentinel",
    repository_owner_id: "18",
    ref: "refs/heads/sentinel-supervisor",
    ref_type: "branch",
    sha: pin.source.revision,
    workflow_sha: pin.source.revision,
    workflow_ref:
      "ubiquity-sentinel/sentinel/.github/workflows/release.yml@refs/heads/sentinel-supervisor",
    workflow: "sentinel-release",
    environment: "sentinel-release-bridge",
    event_name: "workflow_dispatch",
    runner_environment: "github-hosted",
    run_id: "123",
    run_attempt: "2",
    check_run_id: String(checkRunId),
  };
  const nativeWorkflow: Record<string, unknown> = {
    id: 42,
    name: "sentinel-release",
    path: ".github/workflows/release.yml",
    state: "active",
  };
  const nativeRun: Record<string, unknown> = {
    id: 123,
    run_attempt: 2,
    workflow_id: 42,
    head_sha: pin.source.revision,
    head_branch: "sentinel-supervisor",
    event: "workflow_dispatch",
    status: "in_progress",
    repository: { id: 17, full_name: "ubiquity-sentinel/sentinel" },
  };
  const nativeJob: Record<string, unknown> = {
    id: 456,
    run_id: 123,
    run_attempt: 2,
    head_sha: pin.source.revision,
    name: "release",
    status: "in_progress",
    conclusion: null,
    check_run_url: `${api}/check-runs/${checkRunId}`,
  };
  const contents: Record<string, unknown> = {
    type: "file",
    path: ".github/workflows/release.yml",
    encoding: "base64",
    content: b64(workflow),
  };
  const calls: string[] = [];
  const http = ((url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    calls.push(target);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    if (target === RELEASE_BRIDGE_JWKS) {
      assert.equal(headers.has("authorization"), false);
      return Promise.resolve(Response.json({
        keys: [{ ...jwk, alg: "RS256", kid: "synthetic-kid", use: "sig" }],
      }));
    }
    assert.equal(headers.get("authorization"), `Bearer ${NATIVE}`);
    const value = new Map([
      [`${api}/actions/workflows/42`, nativeWorkflow],
      [`${api}/actions/runs/123/attempts/2`, nativeRun],
      [`${api}/actions/jobs/456`, nativeJob],
      [
        `${api}/contents/.github/workflows/release.yml?ref=${pin.source.revision}`,
        contents,
      ],
    ]).get(target);
    assert.ok(value, `unexpected fixed API path: ${target}`);
    return Promise.resolve(Response.json(value));
  }) as typeof fetch;
  const input = async (
    mutation: Record<string, unknown> = {},
    headerMutation: Record<string, unknown> = {},
  ): Promise<Extract<ReleaseBridgeInput, { operation: "run" }>> => {
    const header = url64(
      encoder.encode(
        JSON.stringify({
          alg: "RS256",
          kid: "synthetic-kid",
          typ: "JWT",
          ...headerMutation,
        }),
      ),
    );
    const body = url64(
      encoder.encode(JSON.stringify({ ...claims, ...mutation })),
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        encoder.encode(`${header}.${body}`),
      ),
    );
    return parseReleaseBridgeInput(
      encoder.encode(
        JSON.stringify({
          version: "v1",
          operation: "run",
          execution,
          oidcToken: `${header}.${body}.${url64(signature)}`,
          nativeStateToken: NATIVE,
        }),
      ),
    ) as Extract<ReleaseBridgeInput, { operation: "run" }>;
  };
  return {
    pin,
    claims,
    nativeWorkflow,
    nativeRun,
    nativeJob,
    contents,
    calls,
    http,
    input,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

Deno.test("release bridge: closed bounded stdin has no command/path/target/authority surface", async () => {
  assert.deepEqual(
    parseReleaseBridgeInput(
      encoder.encode('{"version":"v1","operation":"preflight"}'),
    ),
    { version: "v1", operation: "preflight" },
  );
  for (
    const bytes of [
      encoder.encode(
        '{"version":"v1","operation":"preflight","token":"hidden"}',
      ),
      encoder.encode('{"version":"v1","operation":"run","command":"id"}'),
      new Uint8Array(32_769),
      new Uint8Array([0xff]),
      encoder.encode("null"),
    ]
  ) assert.throws(() => parseReleaseBridgeInput(bytes), /input_rejected/);
  const rig = await authRig(), valid = await rig.input();
  for (
    const field of [
      "target",
      "revision",
      "role",
      "command",
      "path",
      "origin",
      "authorized",
    ]
  ) {
    assert.throws(() =>
      parseReleaseBridgeInput(
        encoder.encode(JSON.stringify({ ...valid, [field]: "attacker" })),
      ), /input_rejected/);
  }
  assert.throws(
    () =>
      parseReleaseBridgeInput(
        encoder.encode(
          JSON.stringify({
            ...valid,
            execution: { ...execution, callerJob: "release" },
          }),
        ),
      ),
    /input_rejected/,
  );
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(32_769));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(readReleaseBridgeInput(stream), /input_rejected/);
  assert.equal(cancelled, true);
});

Deno.test("release bridge: installed target/state/controller/driver scope is fixed", async () => {
  const { pin } = await authRig();
  const digest = "a".repeat(64);
  assert.equal(parseReleaseBridgeConfigDigest(encoder.encode(digest)), digest);
  assert.equal(
    parseReleaseBridgeConfigDigest(encoder.encode(`${digest}\n`)),
    digest,
  );
  const invalidDigests = [
    digest.slice(1),
    digest.toUpperCase(),
    `${digest} path`,
    `${digest}\n\n`,
  ];
  for (const value of invalidDigests) {
    assert.throws(
      () => parseReleaseBridgeConfigDigest(encoder.encode(value)),
      /installation_rejected/,
    );
  }
  for (
    const value of [{ ...pin, role: "repair" }, {
      ...pin,
      controller: { ...pin.controller, root: "/tmp/attacker" },
    }, {
      ...pin,
      driver: {
        ...pin.driver,
        root: `${RELEASE_BRIDGE_ROOT}/driver/releases/../../evil`,
      },
    }, {
      ...pin,
      source: {
        ...pin.source,
        subject: "repo:attacker/sentinel:environment:sentinel-release-bridge",
      },
    }, {
      ...pin,
      source: { ...pin.source, environment: "sentinel-supervisor" },
    }, {
      ...pin,
      source: { ...pin.source, environment: null },
    }, { ...pin, stateRepository: "https://attacker.invalid" }]
  ) {
    assert.throws(
      () => parseReleaseBridgeInstallation(value),
      /installation_rejected/,
    );
  }
  assert.equal(
    RELEASE_BRIDGE_STATE_REPOSITORY,
    "https://github.com/ubiquity-sentinel/sentinel.git",
  );
  assert.equal(RELEASE_BRIDGE_STATE_REF, "refs/heads/sentinel-state/release");
});

Deno.test("release bridge: accepts current id-qualified installation subject", async () => {
  const { pin } = await authRig();
  const subject =
    `repo:ubiquity-sentinel@${pin.source.ownerId}/sentinel@${pin.source.repositoryId}:environment:sentinel-release-bridge`;
  const accepted = parseReleaseBridgeInstallation({
    ...pin,
    source: { ...pin.source, subject },
  });
  assert.equal(accepted.source.subject, subject);
  assert.throws(
    () =>
      parseReleaseBridgeInstallation({
        ...pin,
        source: {
          ...pin.source,
          subject: subject.replace("ubiquity-sentinel", "ubiquity"),
        },
      }),
    /installation_rejected/,
  );
});

Deno.test("release bridge: real RS256 signed check-run authenticates exact native job and source", async () => {
  const rig = await authRig(), input = await rig.input();
  const proof = await authenticateReleaseBridgeJob(
    input,
    rig.pin,
    rig.http,
    rig.now(),
  );
  assert.equal(proof.checkRunId, checkRunId);
  assert.equal(proof.jobId, execution.jobId);
  assert.match(proof.replayDigest, /^[a-f0-9]{64}$/);
  assert.equal(rig.calls.length, 5);
  assert.equal(JSON.stringify(proof).includes(input.oidcToken), false);
  assert.equal(JSON.stringify(proof).includes(NATIVE), false);
});

Deno.test("release bridge: wrong audience/time/owner/ref/workflow/run/attempt/check-run/signature/JOSE refuses", async () => {
  const rig = await authRig();
  const wrong = [
    { aud: "wrong" },
    { iss: "https://attacker.invalid" },
    { exp: Math.floor(rig.now() / 1000) },
    { iat: Math.floor(rig.now() / 1000) + 1 },
    { nbf: Math.floor(rig.now() / 1000) + 1 },
    { repository_id: "19" },
    { repository_owner_id: "19" },
    { repository: "attacker/sentinel" },
    { ref: "refs/heads/sentinel-release" },
    { workflow_sha: "a".repeat(40) },
    { workflow_ref: "attacker/path" },
    {
      workflow_ref:
        "ubiquity-sentinel/sentinel/.github/workflows/release.yml@refs/heads/sentinel-release",
    },
    { run_id: "124" },
    { run_attempt: "3" },
    { check_run_id: "790" },
    { environment: "sentinel-supervisor" },
    { environment: undefined },
    {
      sub: "repo:ubiquity-sentinel/sentinel:ref:refs/heads/sentinel-supervisor",
    },
    { event_name: "pull_request" },
    { runner_environment: "self-hosted" },
  ];
  for (const mutation of wrong) {
    await assert.rejects(
      authenticateReleaseBridgeJob(
        await rig.input(mutation),
        rig.pin,
        rig.http,
        rig.now(),
      ),
      /authentication_rejected/,
    );
  }
  await assert.rejects(
    authenticateReleaseBridgeJob(
      await rig.input({}, { jku: "https://attacker.invalid/jwks" }),
      rig.pin,
      rig.http,
      rig.now(),
    ),
    /authentication_rejected/,
  );
  const input = await rig.input();
  const parts = input.oidcToken.split(".");
  parts[1] = url64(
    encoder.encode(JSON.stringify({ ...rig.claims, run_id: "124" })),
  );
  await assert.rejects(
    authenticateReleaseBridgeJob(
      { ...input, oidcToken: parts.join(".") },
      rig.pin,
      rig.http,
      rig.now(),
    ),
    /authentication_rejected/,
  );
});

Deno.test("release bridge: disabled/dead/wrong native job and changed source never authenticate", async () => {
  for (
    const change of [
      "disabled",
      "dead",
      "job",
      "attempt",
      "checkrun",
      "source",
      "branch",
    ]
  ) {
    const rig = await authRig();
    if (change === "disabled") rig.nativeWorkflow.state = "disabled_manually";
    if (change === "dead") rig.nativeJob.status = "completed";
    if (change === "job") rig.nativeJob.name = "repair";
    if (change === "attempt") rig.nativeJob.run_attempt = 1;
    if (change === "branch") rig.nativeRun.head_branch = "sentinel-release";
    if (change === "checkrun") {
      rig.nativeJob.check_run_url = `${api}/check-runs/790`;
    }
    if (change === "source") {
      rig.contents.content = b64(encoder.encode("changed protected source"));
    }
    await assert.rejects(
      authenticateReleaseBridgeJob(
        await rig.input(),
        rig.pin,
        rig.http,
        rig.now(),
      ),
      change === "disabled" ? /workflow_disabled/ : /authentication_rejected/,
    );
  }
});

Deno.test("release bridge: body/redirect errors are bounded and never echo token/error/header", async () => {
  const rig = await authRig(), input = await rig.input();
  for (
    const http of [
      (() => Promise.resolve(new Response("x".repeat(65_537)))) as typeof fetch,
      (() =>
        Promise.resolve(
          new Response(NATIVE, {
            status: 302,
            headers: { location: "https://attacker.invalid" },
          }),
        )) as typeof fetch,
      (() =>
        Promise.reject(
          new Error(`Authorization: Bearer ${NATIVE}`),
        )) as typeof fetch,
    ]
  ) {
    await assert.rejects(
      authenticateReleaseBridgeJob(input, rig.pin, http, rig.now()),
      (error: unknown) =>
        error instanceof Error && error.message === "authentication_rejected" &&
        !error.message.includes(NATIVE),
    );
  }
});

Deno.test("release bridge: setup/preflight and missing capability/custody perform no state or driver effect", async () => {
  const rig = await authRig(), input = await rig.input();
  const setup = { ...rig.pin, activation: "setup_only" as const };
  assert.equal(
    (await runReleaseBridge(
      { version: "v1", operation: "preflight" },
      setup,
      null,
      rig.http,
    )).status,
    "preflight",
  );
  assert.equal(
    (await runReleaseBridge(input, setup, null, rig.http)).code,
    "setup_only",
  );
  assert.equal(
    (await runReleaseBridge(input, rig.pin, null, rig.http)).code,
    "capability_unavailable",
  );
  assert.equal(rig.calls.length, 0);
  // sentinel#161: the pinned tree's own command and journal runners only.
  const substitute = {
    acquireOwner: () => {
      throw new Error("must not acquire custody");
    },
    claimReplay: () => {
      throw new Error("must not claim");
    },
    host: {
      clock: { now: rig.now },
      platform: { journal: () => Promise.resolve("") },
    },
  } as unknown as ReleaseBridgeCapabilities;
  assert.equal(
    (await runReleaseBridge(input, rig.pin, substitute, rig.http)).code,
    "capability_unavailable",
  );
  assert.equal(rig.calls.length, 0, "refused before authentication");
  const caps = {
    acquireOwner: () => Promise.resolve(null),
    claimReplay: () => {
      throw new Error("must not claim");
    },
    host: { clock: { now: rig.now } },
  } as unknown as ReleaseBridgeCapabilities;
  const result = await runReleaseBridge(input, rig.pin, caps, rig.http);
  assert.equal(result.code, "owner_unavailable");
  assert.equal(JSON.stringify(result).includes(NATIVE), false);
});

Deno.test("release bridge: durable replay reservation refuses reuse and interrupted reservations", async () => {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-bridge-replay-",
    dir: ".",
  });
  const realRoot = await Deno.realPath(root);
  try {
    await Deno.chmod(root, 0o700);
    const rig = await authRig(), input = await rig.input();
    const proof = await authenticateReleaseBridgeJob(
      input,
      rig.pin,
      rig.http,
      rig.now(),
    );
    assert.equal(
      await claimReleaseBridgeReplay(
        proof.replayDigest,
        proof.expiresAt,
        realRoot,
      ),
      true,
    );
    assert.equal(
      await claimReleaseBridgeReplay(
        proof.replayDigest,
        proof.expiresAt,
        realRoot,
      ),
      false,
    );
    const bytes = await Deno.readTextFile(`${root}/${proof.replayDigest}.json`);
    assert.equal(bytes.includes(input.oidcToken), false);
    assert.equal(bytes.includes(NATIVE), false);
    const interrupted = "e".repeat(64);
    await Deno.writeTextFile(`${root}/${interrupted}.json`, "", {
      createNew: true,
      mode: 0o600,
    });
    assert.equal(
      await claimReleaseBridgeReplay(interrupted, proof.expiresAt, realRoot),
      false,
    );
    assert.equal(await Deno.readTextFile(`${root}/${interrupted}.json`), "");
    await Deno.chmod(root, 0o755);
    assert.equal(
      await claimReleaseBridgeReplay("f".repeat(64), proof.expiresAt, realRoot),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function stateRig() {
  const context = await makeGitCtx("release-bridge");
  await publishRepairRequest(context, fixture.request);
  const native = new DenoGitRunner(
    `${context.tmp}/git-home`,
    githubGitAuthEnv(NATIVE, RELEASE_BRIDGE_STATE_REPOSITORY),
  );
  const calls: string[][] = [];
  let lose = false;
  const runner: GitRunnerV1 = {
    async runGit(args, opts) {
      calls.push([...args]);
      const result = await native.runGit(
        args.map((value) =>
          value === RELEASE_BRIDGE_STATE_REPOSITORY ? context.remoteUrl : value
        ),
        opts,
      );
      if (lose && args.includes("push") && result.ok) {
        lose = false;
        return {
          ...result,
          ok: false,
          code: 1,
          stderr: `synthetic lost reply ${NATIVE}`,
        };
      }
      return result;
    },
  };
  const state = createNativeReleaseBridgeState(NATIVE, {
    scratchDir: `${context.tmp}/native-state`,
    gitHome: `${context.tmp}/git-home`,
  }, runner);
  return {
    context,
    state,
    calls,
    losePush: () => {
      lose = true;
    },
  };
}

Deno.test("release bridge: native real Git facade writes release only with expected-head non-force CAS", async () => {
  const rig = await stateRig();
  try {
    assert.equal("writeRepair" in rig.state, false);
    assert.deepEqual(Object.keys(rig.state).sort(), [
      "readRelease",
      "readReleaseAt",
      "readRepair",
      "writeRelease",
    ]);
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    await assert.rejects(
      requireReleaseBridgeState(rig.state),
      /state_unavailable/,
    );
    assert.equal(rig.calls.some((call) => call.includes("push")), false);
    const write = await rig.state.writeRelease({
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: fixture.createdAt,
      releases: [],
      hostedRuntimes: [],
      hostedReleases: [],
      githubCooldowns: [],
    }, null);
    assert.ok(write.ok && write.value.status === "applied");
    const after = await rig.state.readRelease();
    assert.ok(after.ok && after.value.status === "found");
    await requireReleaseBridgeState(rig.state);
    const conflict = await rig.state.writeRelease({
      ...after.value.snapshot,
      sequence: 2,
      updatedAt: fixture.createdAt + 1,
    }, null);
    assert.ok(conflict.ok && conflict.value.status === "conflict");
    const pushes = rig.calls.filter((call) => call.includes("push"));
    assert.ok(pushes.length > 0);
    assert.equal(
      pushes.some((call) => call.some((value) => value.includes("--force"))),
      false,
    );
    assert.equal(
      pushes.every((call) =>
        call.some((value) => value.endsWith(`:${RELEASE_BRIDGE_STATE_REF}`))
      ),
      true,
    );
    assert.equal(
      rig.calls.some((call) => call.some((value) => value.includes(NATIVE))),
      false,
    );
  } finally {
    await rig.context.cleanup();
  }
});

Deno.test("release bridge: trusted Git clearEnv child sees scoped header but no unrelated environment", async () => {
  const created = await Deno.makeTempDir({
    prefix: "sentinel-bridge-git-env-",
    dir: ".",
  });
  const root = await Deno.realPath(created);
  const priorPath = Deno.env.get("PATH"),
    priorCoverage = Deno.env.get("NODE_V8_COVERAGE");
  try {
    await Deno.writeTextFile(
      `${root}/inspect.js`,
      'const env = Deno.env.toObject(); console.log(JSON.stringify({ header: Boolean(env.GIT_CONFIG_VALUE_0), coverage: "NODE_V8_COVERAGE" in env, prompt: env.GIT_TERMINAL_PROMPT, home: env.HOME, global: env.GIT_CONFIG_GLOBAL, system: env.GIT_CONFIG_SYSTEM }));\n',
    );
    await Deno.writeTextFile(
      `${root}/git`,
      `#!/bin/sh\nexec '${Deno.execPath()}' run --no-config --no-lock --allow-env '${root}/inspect.js' "$@"\n`,
      { mode: 0o700 },
    );
    Deno.env.set("PATH", `${root}:${priorPath ?? "/usr/bin:/bin"}`);
    Deno.env.set("NODE_V8_COVERAGE", "synthetic-unrelated-environment");
    const runner = new DenoGitRunner(root, githubGitAuthEnv(NATIVE));
    const result = await runner.runGit(["--version"], { cwd: root });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      header: true,
      coverage: false,
      prompt: "0",
      home: root,
      global: "/dev/null",
      system: "/dev/null",
    });
    assert.equal(result.stdout.includes(NATIVE), false);
    assert.equal(result.stderr.includes(NATIVE), false);
  } finally {
    if (priorPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", priorPath);
    if (priorCoverage === undefined) Deno.env.delete("NODE_V8_COVERAGE");
    else Deno.env.set("NODE_V8_COVERAGE", priorCoverage);
    await Deno.remove(root, { recursive: true });
  }
});

/** Only the external deployment boundary is fake; receipts are parsed producer returns. */
class ExternalDriver implements NativeVpsDriverV1 {
  receipt = structuredClone(fixture.driver);
  activations = 0;
  restorations = 0;
  loseActivation = false;
  constructor(private readonly now: () => number) {}
  inspectPrior() {
    return Promise.resolve(this.receipt.prior);
  }
  prepare(input: VpsPrepare) {
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      binding: input.binding,
      controllerSha: input.controllerSha,
    });
    return Promise.resolve(this.receipt);
  }
  sampleHealth(
    identity: VpsIdentity,
    surface: "loopback" | "public",
  ): Promise<VpsHealthProof> {
    return Promise.resolve({
      identity,
      surface,
      observedAt: this.now(),
      httpStatus: 200,
      bodyMatches: true,
      headersMatch: true,
      originMatches: true,
    });
  }
  observe(input: VpsOperation) {
    assert.equal(input.requestDigest, this.receipt.binding.requestDigest);
    return Promise.resolve(this.receipt);
  }
  async activate(input: VpsMutation) {
    assert.equal(input.expectedSequence, this.receipt.sequence);
    assert.equal(input.expectedDigest, await vpsDigest(this.receipt));
    this.activations++;
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      phase: "ingress_applied",
      sequence: this.receipt.sequence + 1,
      updatedAt: this.now(),
      intent: { action: "promote", persistedAt: this.now() },
      loopback: await this.sampleHealth(this.receipt.candidate, "loopback"),
      public: await this.sampleHealth(this.receipt.candidate, "public"),
    });
    if (this.loseActivation) {
      this.loseActivation = false;
      throw new Error(`synthetic lost activation ${NATIVE}`);
    }
    return this.receipt;
  }
  async restore(input: VpsMutation) {
    assert.equal(input.expectedDigest, await vpsDigest(this.receipt));
    this.restorations++;
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      phase: "rolled_back",
      sequence: this.receipt.sequence + 1,
      updatedAt: this.now(),
      intent: { action: "rollback", persistedAt: this.now() },
      restoration: {
        loopback: await this.sampleHealth(
          this.receipt.prior.identity,
          "loopback",
        ),
        public: await this.sampleHealth(this.receipt.prior.identity, "public"),
      },
    });
    return this.receipt;
  }
  settle(input: VpsSettlement) {
    this.receipt = parseVpsReceipt({
      ...this.receipt,
      phase: input.disposition,
      sequence: this.receipt.sequence + 1,
      updatedAt: this.now(),
      settlement: {
        stateRevision: input.stateRevision,
        disposition: input.disposition,
        digest: input.digest,
      },
      error: input.disposition === "failed" ? "acceptance_insufficient" : null,
    });
    return Promise.resolve(this.receipt);
  }
}

async function controllerRig(failures = 0) {
  const auth = await authRig(),
    git = await stateRig(),
    driver = new ExternalDriver(auth.now);
  const job = await authenticateReleaseBridgeJob(
    await auth.input(),
    auth.pin,
    auth.http,
    auth.now(),
  );
  const deps: VpsReleaseEntrypointDepsV1 = {
    stateRead: git.state,
    stateWrite: git.state,
    repository: fixture.request.target.repository,
    environment: "production",
    controllerSha: auth.pin.controller.revision,
    driverSha256: auth.pin.driver.moduleSha256,
    policy: fixture.policy,
    logsLagMs: 0,
    clock: { now: auth.now },
    wait: (ms) => {
      auth.advance(ms);
      return Promise.resolve();
    },
    deadline: auth.now() + 60_000,
    port: composeVpsReleasePort({
      driver,
      metrics: {
        sample: (input) =>
          Promise.resolve({
            ...input,
            sampledAt: auth.now(),
            requestCount: 100,
            fiveXxCount: input.identity.gitSha === fixture.request.revision
              ? failures
              : 0,
            timeoutCount: 0,
            streamFailureCount: 0,
            upstreamWideFault: false,
            coverage: "complete",
            coverageDigest: "e".repeat(64),
          }),
      },
      readInferenceProof: (identity) =>
        Promise.resolve({
          revision: identity.gitSha,
          observedAt: auth.now(),
          origin: "mac-direct-vps",
          authenticated: true,
          succeeded: true,
          proofDigest: "f".repeat(64),
        }),
    }),
  };
  return {
    auth,
    git,
    driver,
    deps,
    job,
    dispatch: () =>
      dispatchReleaseBridgeController(deps, job, NATIVE, auth.pin, auth.http),
  };
}

Deno.test("release bridge: actual controller refuses wrong role/protected target/dead native owner", async () => {
  const rig = await controllerRig();
  try {
    const role = await dispatchReleaseBridgeController(
      {
        ...rig.deps,
        stateWrite: {
          ...rig.git.state,
          writeRepair: () => {
            throw new Error("must not repair");
          },
        },
      } as VpsReleaseEntrypointDepsV1,
      rig.job,
      NATIVE,
      rig.auth.pin,
      rig.auth.http,
    );
    assert.equal(role.ok, false);
    const target = await dispatchReleaseBridgeController(
      { ...rig.deps, repository: { ...rig.deps.repository, name: "sentinel" } },
      rig.job,
      NATIVE,
      rig.auth.pin,
      rig.auth.http,
    );
    assert.equal(target.ok, false);
    rig.auth.nativeJob.status = "completed";
    await rig.dispatch();
    assert.equal(rig.driver.activations, 0);
    assert.equal(rig.git.calls.some((call) => call.includes("push")), false);
  } finally {
    await rig.git.context.cleanup();
  }
});

Deno.test("release bridge: connected real Git/native auth/driver/controller recovers interrupted effect and accepts exact state", async () => {
  const rig = await controllerRig();
  try {
    rig.driver.loseActivation = true;
    rig.git.losePush();
    await rig.dispatch();
    const afterIntent = await rig.git.state.readRelease();
    assert.ok(afterIntent.ok && afterIntent.value.status === "found");
    assert.equal(
      afterIntent.value.snapshot.vpsReleases?.[0].phase,
      "promoting",
    );
    assert.equal(
      afterIntent.value.snapshot.vpsReleases?.[0].intent?.action,
      "promote",
    );
    assert.equal(rig.driver.activations, 1);
    rig.deps.deadline = rig.auth.now() + 2_100_000;
    const result = await rig.dispatch();
    assert.ok(result.ok, JSON.stringify(result));
    const read = await rig.git.state.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    const accepted = read.value.snapshot.vpsReleases?.[0];
    assert.ok(accepted);
    assert.equal(accepted.phase, "accepted");
    assert.equal(accepted.monitoring.samples.length, 60);
    assert.equal(accepted.monitoring.continuous, true);
    assert.equal(rig.driver.activations, 1);
    assert.equal(rig.driver.restorations, 0);
    assert.equal(accepted.driver.candidate.gitSha, fixture.request.revision);
    assert.equal(
      accepted.driver.prior.identity.gitSha,
      fixture.driver.prior.identity.gitSha,
    );
    assert.equal(accepted.inference?.origin, "mac-direct-vps");
    assert.equal(JSON.stringify(result).includes(NATIVE), false);
    const repair = await rig.git.state.readRepair();
    assert.ok(repair.ok && repair.value.status === "found");
    assert.equal(repair.value.snapshot.releaseRequests[0].status, "open");
  } finally {
    await rig.git.context.cleanup();
  }
});

Deno.test("release bridge: connected controller restores only exact durable prior after failed acceptance", async () => {
  const rig = await controllerRig(5);
  try {
    rig.deps.deadline = rig.auth.now() + 2_100_000;
    const result = await rig.dispatch();
    assert.ok(result.ok);
    const read = await rig.git.state.readRelease();
    assert.ok(read.ok && read.value.status === "found");
    const record = read.value.snapshot.vpsReleases?.[0];
    assert.ok(record);
    assert.equal(record.phase, "rolled_back");
    assert.equal(rig.driver.activations, 1);
    assert.equal(rig.driver.restorations, 1);
    assert.equal(
      record.driver.restoration?.public.identity.gitSha,
      fixture.driver.prior.identity.gitSha,
    );
    assert.equal(
      record.driver.restoration?.loopback.identity.gitSha,
      fixture.driver.prior.identity.gitSha,
    );
  } finally {
    await rig.git.context.cleanup();
  }
});
