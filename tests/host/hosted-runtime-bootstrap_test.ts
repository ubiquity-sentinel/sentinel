/** Hosted hosted-runtime-bootstrap_test responsibility. */
import assert from "node:assert/strict";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { gitRun, testGitEnv } from "../state/helpers.ts";
import { ROOT } from "./hosted-runtime-fixture.ts";

Deno.test("hosted runtime: bootstrap-only real child empty stdin aggregate", async () => {
  // Retain this private fixture and both complete child streams for diagnosis.
  const root = await Deno.makeTempDir({
    prefix: "sentinel-hosted-runtime-bootstrap57-",
    dir: ROOT,
  });
  await Deno.chmod(root, 0o700);
  const gatewayRoot = await Deno.makeTempDir({
    dir: root,
    prefix: "sentinel-bootstrap-only-gateway-",
  });
  await Deno.chmod(gatewayRoot, 0o700);
  await Deno.mkdir(`${root}/git-home`);
  const env = testGitEnv(`${root}/git-home`);
  // CI may contain only HEAD. Historical failed-runtime proof stays private;
  // this permanent regression exercises the current checkout's real consumer.
  const current = await gitRun(ROOT, ["rev-parse", "HEAD"], env);
  assert.ok(current.ok, current.stderr);
  const revision = current.stdout.trim();
  const launcher = revision;
  const frozen = `${root}/frozen`;
  const cloned = await gitRun(root, [
    "clone",
    "-q",
    "--no-hardlinks",
    "--no-checkout",
    ROOT,
    frozen,
  ], env);
  assert.ok(cloned.ok, cloned.stderr);
  const detached = await gitRun(frozen, [
    "checkout",
    "-q",
    "--detach",
    revision,
  ], env);
  assert.ok(detached.ok, detached.stderr);
  const frozenHead = await gitRun(frozen, ["rev-parse", "HEAD"], env);
  assert.equal(frozenHead.stdout.trim(), revision);
  // Preserve a local aggregate correction over the immutable current snapshot.
  const aggregateSource = await Deno.readTextFile(
    `${ROOT}/src/host/matrix-actions.ts`,
  );
  await Deno.writeTextFile(
    `${frozen}/src/host/matrix-actions.ts`,
    aggregateSource,
  );
  const aggregateDigest = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(aggregateSource),
      ),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const sourceTree = await gitRun(ROOT, ["rev-parse", `${revision}:src`], env);
  assert.ok(sourceTree.ok, sourceTree.stderr);
  const protectedSources = await gitRun(ROOT, [
    "show",
    `${launcher}:src/host/hosted-runtime.ts`,
  ], env);
  assert.ok(protectedSources.ok, protectedSources.stderr);
  await Deno.writeTextFile(
    `${root}/protected-hosted-runtime.ts`,
    protectedSources.stdout,
    {
      mode: 0o600,
    },
  );
  const workflow = await gitRun(ROOT, [
    "show",
    `${launcher}:.github/workflows/supervisor.yml`,
  ], env);
  assert.ok(workflow.ok, workflow.stderr);
  await Deno.writeTextFile(
    `${root}/protected-supervisor.yml`,
    workflow.stdout,
    { mode: 0o600 },
  );
  const cacheInfo = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json"],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(cacheInfo.success, new TextDecoder().decode(cacheInfo.stderr));
  const cachedDenoDir =
    JSON.parse(new TextDecoder().decode(cacheInfo.stdout)).denoDir;
  assert.equal(typeof cachedDenoDir, "string");
  const child = `${root}/bootstrap-child.ts`;
  await Deno.writeTextFile(
    child,
    `
import assert from "node:assert/strict";
import { runActionsRepairHost } from "./frozen/src/host/actions.ts";
import { QUEUE_SNAPSHOT_QUERY } from "./frozen/src/github/merge-queue-wire.ts";
import { readMatrixNativeCarrier, runActionsMatrixAggregateCycles } from "./frozen/src/host/matrix-actions.ts";
import { parseHostedExecutionIntentV1, HOSTED_RUNTIME_ID } from "./frozen/src/contracts/hosted-supervisor.ts";
import { parseRepairStateSnapshotV1, parseReleaseStateSnapshotV1 } from "./frozen/src/contracts/state-snapshots.ts";
import { parseBudgetReservationV1 } from "./frozen/src/contracts/budget-reservation.ts";
import { createReleaseStateStore, createRepairStateStore } from "./frozen/src/state/mod.ts";
import { FakeGithub } from "./frozen/tests/repair/helpers.ts";
import { canonicalStringify } from "./frozen/src/contracts/canonical.ts";
import { gitRun, makeRemoteCtx, pushRawTree, sha256Hex, testGitEnv, workRecord } from "./frozen/tests/state/helpers.ts";
import { preparePublicDependencyCache } from "./frozen/src/replay/dependency-cache.ts";
import { DenoReplayRuntime } from "./frozen/src/replay/runtime.ts";
import { markerProofParser } from "./frozen/src/replay/fixture.ts";
import { makeIndexPage, recordingTransport } from "./frozen/tests/adapters/gateway/helpers.ts";
const T0 = 1791034316336;
const root = ${JSON.stringify(root)};
const gatewayRoot = ${JSON.stringify(gatewayRoot)};
const revision = ${JSON.stringify(revision)};
const launcher = ${JSON.stringify(launcher)};
const checkout = root + "/frozen";
const env = testGitEnv(root + "/git-home");
// Bootstrap contract only: this guarded public graph is not the AI application.
// No captured request, replay proof or target-validation result is fabricated.
const gatewaySeed = gatewayRoot + "/source";
const preparation = new DenoReplayRuntime("/usr/local/bin:/usr/bin:/bin");
const checkedPreparation = async (input) => {
  const result = await preparation.run(input);
  assert.equal(result.outcome, "exited");
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
  assert.equal(result.settled, true);
  assert.equal(result.truncated, false);
};
await Deno.mkdir(gatewayRoot + "/guard/package", { recursive: true });
await Deno.mkdir(gatewayRoot + "/preparation-home");
await Deno.writeTextFile(gatewayRoot + "/guard/package/package.json", JSON.stringify({ name: "bootstrap-only-guard", version: "1.0.0", main: "index.js" }));
await Deno.writeTextFile(gatewayRoot + "/guard/package/index.js", "throw new Error('bootstrap must not run target tooling');\\n");
await checkedPreparation({ executable: "/usr/bin/tar", args: ["-czf", gatewayRoot + "/guard.tgz", "package"], cwd: gatewayRoot + "/guard", env: { PATH: "/usr/bin:/bin", NODE_V8_COVERAGE: "" }, maxDurationMs: 30_000, maxOutputBytes: 4096 });
const gatewayInputs = {
  "deno.json": JSON.stringify({ imports: {}, nodeModulesDir: "none" }),
  "deno.lock": JSON.stringify({ version: "5", specifiers: {}, jsr: {}, npm: {} }),
  "tools/lint/package.json": JSON.stringify({ name: "bootstrap-only", version: "1.0.0", private: true, dependencies: { "bootstrap-only-guard": "file:" + gatewayRoot + "/guard.tgz" } }),
  "scripts/verify.sh": "#!/bin/sh\\necho 'bootstrap must not validate a target' >&2\\nexit 91\\n",
  "scripts/_bootstrap.sh": "# bootstrap-only public dependency graph\\n",
  "scripts/replay.ts": "throw new Error('bootstrap must not replay a capture');\\n",
};
for (const [path, text] of Object.entries(gatewayInputs)) {
  const target = gatewaySeed + "/" + path;
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(target, text);
}
const checkedGit = async (cwd, args) => {
  const result = await gitRun(cwd, args, env);
  assert.ok(result.ok, result.stderr);
  return result.stdout.trim();
};
// Bun deletes an empty lock: produce a real frozen lock for the local guard.
await checkedPreparation({
  executable: "/usr/bin/unshare",
  args: ["--user", "--map-root-user", "--net", "--", "/usr/local/bin/bun", "install", "--lockfile-only", "--ignore-scripts", "--no-summary"],
  cwd: gatewaySeed + "/tools/lint",
  env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: gatewayRoot + "/preparation-home", TMPDIR: gatewayRoot, BUN_INSTALL_CACHE_DIR: gatewayRoot + "/public-download-cache", NODE_V8_COVERAGE: "" },
  maxDurationMs: 30_000,
  maxOutputBytes: 4096,
});
await checkedGit(gatewaySeed, ["init", "-q", "--initial-branch=development"]);
await checkedGit(gatewaySeed, ["add", "."]);
await checkedGit(gatewaySeed, ["commit", "-q", "-m", "bootstrap-only public fixture"]);
const gatewaySha = await checkedGit(gatewaySeed, ["rev-parse", "HEAD"]);
const dependencyCache = await preparePublicDependencyCache({
  sourceDir: gatewaySeed,
  sourceSha: gatewaySha,
  root: gatewayRoot + "/public-cache",
  entrypoints: ["scripts/replay.ts"],
  // Run the real guarded public preparation with network physically denied.
  runtime: { run: (input) => preparation.run({ ...input, executable: "/usr/bin/unshare", args: ["--user", "--map-root-user", "--net", "--", input.executable, ...input.args] }) },
});
const gatewayTransport = recordingTransport((url) => {
  assert.equal(url.origin, "https://ai.ubq.fi");
  assert.equal(url.pathname, "/admin/sentinel/incidents");
  return new Response(JSON.stringify(makeIndexPage([])), { headers: { "content-type": "application/json" } });
});
const gateway = {
  retained: { root: gatewayRoot + "/retained", limits: { totalMaxBytes: 1024, artifactMaxBytes: 1024, retentionMaxAgeMs: 60_000 } },
  dependencyCache,
  sanitizer: { publicModels: ["bootstrap-only"], publicHeaders: {} },
  replayPolicy: { bundleScopes: ["tests/"], maxFixtureBytes: 1024, maxEntryBytes: 1024, proof: markerProofParser() },
  testIds: ["bootstrap-only-no-replay"],
  failure: "stream_terminated",
  scratchDir: gatewayRoot + "/scratch",
  transport: gatewayTransport,
};
const remote = await makeRemoteCtx(root, env);
const release = createReleaseStateStore({ scratchDir: root + "/release-scratch", remoteUrl: remote.remoteUrl });
const execution = parseHostedExecutionIntentV1({ id: "37126414865:1:repair", runId: 37126414865, runAttempt: 1, launcherSha: launcher, purpose: "bootstrap", revision, generation: 57, releaseId: null, createdAt: T0 });
const runtimeRecord = { version: "v1", kind: "hosted_runtime", id: HOSTED_RUNTIME_ID, activeRevision: revision, generation: 57, lastHealthyProof: null, lastExecutionProof: null, nextOrdinaryAt: T0, execution, createdAt: T0, updatedAt: T0 };
const seeded = await release.writeRelease(parseReleaseStateSnapshotV1({ version: "v1", kind: "release_state_snapshot", stateHead: null, sequence: 1, updatedAt: T0, releases: [], hostedRuntimes: [{ ...runtimeRecord, generation: 1, execution: null }], hostedReleases: [], githubCooldowns: [] }), null);
assert.ok(seeded.ok && seeded.value.status === "applied", JSON.stringify(seeded));
const prior = await release.readRelease();
assert.ok(prior.ok && prior.value.status === "found", JSON.stringify(prior));
if (!prior.ok || prior.value.status !== "found") throw Error("missing fixture state");
// Install only the sanitized persisted-generation fixture in this disposable remote.
const fixtureState = await pushRawTree(remote, prior.value.head, "refs/heads/sentinel-state/release", {
  "manifest.json": canonicalStringify({ version: "v1", kind: "release_state_manifest", sequence: 2, updatedAt: T0, stateHead: prior.value.head }) + "\\n",
  ["hostedRuntimes/" + await sha256Hex(HOSTED_RUNTIME_ID) + ".json"]: canonicalStringify(runtimeRecord) + "\\n",
}, env);
assert.ok(fixtureState.ok, fixtureState.stderr);
const reservationId = "e".repeat(64);
const taskId = "bootstrap-blocked-ai-114";
const repository = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 155687488 };
const base = "b".repeat(40);
const branch = "sentinel/repair/" + taskId;
const blocked = workRecord(taskId, {
  repository,
  source: { kind: "issue", id: "114", revision: "c".repeat(40) },
  related: { incidentId: null, issueNumber: 114 },
  target: { base, branch, checkpoint: null, head: null, pr: null },
  nextStep: "blocked", wait: null,
  blocker: { kind: "other", message: "synthetic uncertain implementation awaiting disposition", since: T0 - 1000 },
  counters: { attempts: 3, retries: 0, reviewRounds: 0 },
  intent: { kind: "implementation", key: "impl:" + reservationId, startedAt: T0 - 9000, branch, expectedHead: null, observedBase: base, pr: null, requestId: reservationId, resultId: null },
  createdAt: T0 - 10000, updatedAt: T0 - 1000,
});
const reservation = parseBudgetReservationV1({ version: "v1", kind: "budget_reservation", id: reservationId, repository, taskId, head: base, attempt: 3, purpose: "retry", createdAt: T0 - 10000, outcome: "ambiguous", settledAt: T0 - 2000, proofRef: null });
const repairStore = createRepairStateStore({ scratchDir: root + "/repair-seed", remoteUrl: remote.remoteUrl });
const repairSeed = await repairStore.writeRepair(parseRepairStateSnapshotV1({ version: "v1", kind: "repair_state_snapshot", stateHead: null, sequence: 1, updatedAt: T0, incidents: [], evidence: [], work: [blocked], reservations: [reservation], reviews: [], replays: [], releaseRequests: [], githubCooldowns: [], attemptMemory: [], lessons: [] }), null);
assert.ok(repairSeed.ok && repairSeed.value.status === "applied", JSON.stringify(repairSeed));
await Deno.mkdir(root + "/bin");
await Deno.writeTextFile(root + "/bin/codex", "");
const github = new FakeGithub({ baseSha: revision, openIssues: [] });
const gatewayGithub = new FakeGithub({ baseSha: gatewaySha, openIssues: [] });
const preparedTargets = [];
let modelCalls = 0, httpCalls = 0, artifactHttpCalls = 0, preflightCalls = 0;
const queueReads: string[] = [];
const carrier = await readMatrixNativeCarrier(false, true);
assert.equal(carrier, undefined);
let result, failure;
try { result = await runActionsRepairHost({
  clock: { now: () => T0 },
  workDir: checkout,
  stateRemoteUrl: remote.remoteUrl,
  env: { GITHUB_RUN_ID: "37126414865", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "ubiquity-sentinel/sentinel", GITHUB_REF: "refs/heads/sentinel-supervisor", GITHUB_SHA: launcher, GITHUB_WORKFLOW_SHA: launcher, GITHUB_WORKFLOW_REF: "ubiquity-sentinel/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor", GITHUB_JOB: "repair", GITHUB_TOKEN: "synthetic-native-token", SENTINEL_SUPERVISOR_TOKEN: "synthetic-app-token", UOS_AI_TOKEN: "synthetic-model-token", SENTINEL_GATEWAY_AUTH_JSON: JSON.stringify({ authorization: "Bearer synthetic-bootstrap-only-token" }), SENTINEL_REPLAY_KEY_B64: "11".repeat(32), PATH: root + "/bin:" + env.PATH, HOME: root + "/git-home" },
  refreshSelf: () => Promise.resolve(revision),
  resolveDefaultBranch: () => Promise.resolve("development"),
  preflight: () => { preflightCalls++; return Promise.resolve(); },
  prepareTarget: async (config, source) => {
    preparedTargets.push(config.repository.owner + "/" + config.repository.name);
    if (config.repository.name === "sentinel") {
      await checkedGit(source, ["update-ref", "refs/remotes/origin/development", revision]);
      return;
    }
    assert.equal(config.repository.owner, "ubiquity");
    assert.equal(config.repository.name, "ai.ubq.fi");
    await Deno.mkdir(source.slice(0, source.lastIndexOf("/")), { recursive: true });
    await checkedGit(root, ["clone", "-q", "--no-hardlinks", gatewaySeed, source]);
    await checkedGit(source, ["remote", "set-url", "origin", "https://github.com/ubiquity/ai.ubq.fi.git"]);
    assert.equal(await checkedGit(source, ["rev-parse", "refs/remotes/origin/development"]), gatewaySha);
  },
  gateway,
  composeGithub: (config) => config.repository.name === "sentinel" ? github : gatewayGithub,
  model: { modelId: "gpt-reserve", runModel: () => { modelCalls++; throw Error("bootstrap must not start a model"); } },
  http: (request) => {
    const url = new URL(request.url);
    if (url.origin === "https://api.github.com") {
      if (request.method === "GET" && url.pathname === "/repos/ubiquity/ai.ubq.fi/rules/branches/development") {
        queueReads.push("rules");
        return Promise.resolve({ status: 200, headers: new Headers(), bodyText: "[]" });
      }
      if (request.method === "POST" && url.pathname === "/graphql") {
        let body: unknown;
        try { body = JSON.parse(request.body ?? "null"); } catch { body = null; }
        if (canonicalStringify(body) === canonicalStringify({ query: QUEUE_SNAPSHOT_QUERY, variables: { owner: "ubiquity", name: "ai.ubq.fi", branch: "development", ref: "refs/heads/development", after: null } })) {
          queueReads.push("queue");
          return Promise.resolve({ status: 200, headers: new Headers(), bodyText: JSON.stringify({ data: { repository: { name: "ai.ubq.fi", owner: { login: "ubiquity" }, ref: { name: "development", target: { __typename: "Commit", oid: gatewaySha } }, mergeQueue: null } } }) });
        }
      }
    }
    httpCalls++;
    throw Error("fixture must not request external HTTP");
  },
  artifactHttp: () => { artifactHttpCalls++; throw Error("empty recovery must not request artifacts"); },
  runTargetCycles: (input) => runActionsMatrixAggregateCycles(input, undefined, carrier),
}); } catch (error) { failure = error; }
const repair = await repairStore.readRepair();
assert.ok(repair.ok && repair.value.status === "found", JSON.stringify(repair));
if (!repair.ok || repair.value.status !== "found") throw Error("missing repair state");
assert.deepEqual(repair.value.snapshot.work, [blocked]);
assert.deepEqual(repair.value.snapshot.reservations, [reservation]);
assert.equal(repair.value.head, repairSeed.value.head);
assert.equal(modelCalls, 0);
assert.equal(httpCalls, 0);
assert.equal(artifactHttpCalls, 0);
console.log(JSON.stringify({ kind: "bootstrap_fixture_state", stateUnchanged: true, modelCalls, httpCalls, queueReads, artifactHttpCalls, preflightCalls, error: failure?.message ?? null }));
if (failure) throw failure;
assert.equal(result.status, "ran");
assert.equal(result.startupReady, true);
assert.equal(result.controllerSha, revision);
assert.equal(result.baseSha, revision);
assert.deepEqual(result.execution, execution);
assert.equal(result.outcome.status, "idle");
assert.equal(preflightCalls, 1);
assert.equal(modelCalls, 0);
assert.equal(httpCalls, 0);
assert.equal(artifactHttpCalls, 0);
// A frozen predecessor has no host prelude; when present, only this complete
// negative native observation is allowed. Every other HTTP request stays fatal.
if (queueReads.length > 0) assert.deepEqual(queueReads, ["rules", "queue", "queue", "rules"]);
assert.ok(github.calls.includes("listOpenIssues"));
assert.ok(gatewayGithub.calls.includes("listOpenIssues"));
assert.deepEqual(preparedTargets, ["ubiquity-sentinel/sentinel", "ubiquity/ai.ubq.fi"]);
assert.equal(gatewayTransport.requests.length, 1);
gatewayTransport.assertReadOnly(["/admin/sentinel/incidents"]);
gatewayTransport.assertNoWriteEndpoints();
assert.equal(gatewayTransport.requests[0].headers.get("authorization"), "Bearer synthetic-bootstrap-only-token");
assert.deepEqual(await Array.fromAsync(Deno.readDir(gatewayRoot + "/retained/entries")), []);
console.log(JSON.stringify({ kind: "bootstrap_fixture", result, modelCalls, httpCalls, queueReads, artifactHttpCalls, preflightCalls }));
`,
    { mode: 0o600 },
  );
  const runtime = new DenoReplayRuntime(Deno.execPath());
  const argv = [
    "run",
    "--frozen",
    "--cached-only",
    `--config=${frozen}/deno.json`,
    `--allow-read=${root},${gatewayRoot},/usr,/bin,${Deno.execPath()}`,
    `--allow-write=${root},${gatewayRoot}`,
    "--allow-run",
    "--allow-env=PATH,NODE_V8_COVERAGE",
    child,
  ];
  const result = await runtime.run({
    executable: Deno.execPath(),
    args: argv,
    cwd: frozen,
    env: { ...env, DENO_DIR: cachedDenoDir },
    maxDurationMs: 240_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  const group = runtime.lastOwnedGroupId();
  await Deno.writeFile(`${root}/child.stdout`, result.stdout, { mode: 0o600 });
  await Deno.writeFile(`${root}/child.stderr`, result.stderr, { mode: 0o600 });
  await Deno.writeTextFile(
    `${root}/receipt.json`,
    JSON.stringify(
      {
        revision,
        launcher,
        snapshotOrigin: "current-checkout",
        sourceTree: sourceTree.stdout.trim(),
        aggregateDigest,
        argv: [Deno.execPath(), ...argv],
        group,
        result: { ...result, stdout: undefined, stderr: undefined },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ kind: "bootstrap_fixture_capture", root, group }),
  );
  assert.ok(group !== null, "fixture child must actually spawn");
  assert.throws(() => Deno.kill(-group, "SIGCONT"), Deno.errors.NotFound);
  assert.equal(result.settled, true, `${root}/child.stderr`);
  assert.equal(result.truncated, false, `${root}/child.stderr`);
  assert.equal(result.outcome, "exited", `${root}/child.stderr`);
  assert.equal(result.exitCode, 0, `${root}/child.stderr`);
  const stdout = new TextDecoder().decode(result.stdout);
  assert.ok(
    stdout.includes('"kind":"bootstrap_fixture"'),
    `${root}/child.stdout`,
  );
});
