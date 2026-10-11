/** Hosted hosted-runtime-bootstrap_test responsibility. */
import assert from "node:assert/strict";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { gitRun, testGitEnv } from "../state/helpers.ts";
import { ROOT } from "./hosted-runtime-fixture.ts";

Deno.test("hosted runtime: real child bootstrap empty stdin aggregate", async () => {
  // Retain this private fixture and both complete child streams for diagnosis.
  const root = await Deno.makeTempDir({
    prefix: "sentinel-hosted-runtime-bootstrap57-",
    dir: ROOT,
  });
  await Deno.chmod(root, 0o700);
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
import { readMatrixNativeCarrier, runActionsMatrixAggregateCycles } from "./frozen/src/host/matrix-actions.ts";
import { parseHostedExecutionIntentV1, HOSTED_RUNTIME_ID } from "./frozen/src/contracts/hosted-supervisor.ts";
import { parseRepairStateSnapshotV1, parseReleaseStateSnapshotV1 } from "./frozen/src/contracts/state-snapshots.ts";
import { parseBudgetReservationV1 } from "./frozen/src/contracts/budget-reservation.ts";
import { createReleaseStateStore, createRepairStateStore } from "./frozen/src/state/mod.ts";
import { FakeGithub } from "./frozen/tests/repair/helpers.ts";
import { canonicalStringify } from "./frozen/src/contracts/canonical.ts";
import { makeRemoteCtx, pushRawTree, sha256Hex, testGitEnv, workRecord } from "./frozen/tests/state/helpers.ts";
const T0 = 1791034316336;
const root = ${JSON.stringify(root)};
const revision = ${JSON.stringify(revision)};
const launcher = ${JSON.stringify(launcher)};
const checkout = root + "/frozen";
const env = testGitEnv(root + "/git-home");
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
let modelCalls = 0, httpCalls = 0, artifactHttpCalls = 0, preflightCalls = 0;
const carrier = await readMatrixNativeCarrier(false, true);
assert.equal(carrier, undefined);
let result, failure;
try { result = await runActionsRepairHost({
  clock: { now: () => T0 },
  workDir: checkout,
  stateRemoteUrl: remote.remoteUrl,
  env: { GITHUB_RUN_ID: "37126414865", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "ubiquity/sentinel", GITHUB_REF: "refs/heads/sentinel-supervisor", GITHUB_SHA: launcher, GITHUB_WORKFLOW_SHA: launcher, GITHUB_WORKFLOW_REF: "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor", GITHUB_JOB: "repair", GITHUB_TOKEN: "synthetic-native-token", SENTINEL_SUPERVISOR_TOKEN: "synthetic-app-token", UOS_AI_TOKEN: "synthetic-model-token", PATH: root + "/bin:" + env.PATH, HOME: root + "/git-home" },
  refreshSelf: () => Promise.resolve(revision),
  resolveDefaultBranch: () => Promise.resolve("development"),
  preflight: () => { preflightCalls++; return Promise.resolve(); },
  prepareTarget: () => Promise.resolve(),
  composeGithub: () => github,
  model: { modelId: "gpt-reserve", runModel: () => { modelCalls++; throw Error("bootstrap must not start a model"); } },
  http: () => { httpCalls++; throw Error("fixture must not request external HTTP"); },
  artifactHttp: () => { artifactHttpCalls++; throw Error("empty recovery must not request artifacts"); },
  runTargetCycles: (input) => runActionsMatrixAggregateCycles(input, undefined, carrier),
}); } catch (error) { failure = error; }
const repair = await repairStore.readRepair();
assert.ok(repair.ok && repair.value.status === "found", JSON.stringify(repair));
if (!repair.ok || repair.value.status !== "found") throw Error("missing repair state");
assert.deepEqual(repair.value.snapshot.work, [blocked]);
assert.deepEqual(repair.value.snapshot.reservations, [reservation]);
assert.equal(modelCalls, 0);
assert.equal(httpCalls, 0);
assert.equal(artifactHttpCalls, 0);
console.log(JSON.stringify({ kind: "bootstrap_fixture_state", stateUnchanged: true, modelCalls, httpCalls, artifactHttpCalls, preflightCalls, error: failure?.message ?? null }));
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
assert.ok(github.calls.includes("listOpenIssues"));
console.log(JSON.stringify({ kind: "bootstrap_fixture", result, modelCalls, httpCalls, artifactHttpCalls, preflightCalls }));
`,
    { mode: 0o600 },
  );
  const runtime = new DenoReplayRuntime(Deno.execPath());
  const argv = [
    "run",
    "--frozen",
    "--cached-only",
    `--config=${frozen}/deno.json`,
    `--allow-read=${root},/usr,/bin,${Deno.execPath()}`,
    `--allow-write=${root}`,
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
