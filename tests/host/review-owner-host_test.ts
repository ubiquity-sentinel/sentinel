import assert from "node:assert/strict";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import {
  createHostedReviewOwnerCustody,
  type runHostedRuntimeWithReviewCustody,
} from "../../src/host/review-owner-host.ts";
import { reviewOwnerChildInput } from "../../src/host/review-owner-child-input.ts";
import { emitHostedRuntimeCliResult } from "../../src/host/hosted-runtime-main.ts";
import { snapshot } from "./actions-candidates-fixture.ts";
import {
  childLine,
  exited,
  makeRig,
  seedRelease,
} from "./hosted-runtime-fixture.ts";
import {
  attemptBody,
  iso,
  jobBody,
  jobsBody,
  logText,
  makeRig as nativeRig,
  runtimeStep,
  scriptAttemptAndJobs,
  scriptLog,
} from "../github/hosted-execution-helpers.ts";

const PROJECT = new URL("../../", import.meta.url).pathname;
const CHANNEL =
  new URL("../../src/host/review-owner-channel.ts", import.meta.url).href;
const COMPOSITION =
  new URL("../../src/host/local-github.ts", import.meta.url).href;
const CLIENT = new URL("../../src/host/local-client.ts", import.meta.url).href;
const IO = new URL("../../src/host/actions-host-io.ts", import.meta.url).href;

/** This review-owner scenario uses an explicit historical deployment policy. */
function runFixtureReviewOwnerHost(
  input: Parameters<typeof runHostedRuntimeWithReviewCustody>[0],
) {
  return withHostedProductionPolicy(
    DORMANT_HOSTED_SUPERVISOR_POLICY,
    async (graph) => {
      const host = await graph.reviewOwnerHost();
      return host.runHostedRuntimeWithReviewCustody(input);
    },
  );
}

function shellQuote(text: string): string {
  return "'" + text.replaceAll("'", "'\\''") + "'";
}

async function fakeCodex(root: string): Promise<string> {
  const bin = root + "/fake-bin";
  await Deno.mkdir(bin, { mode: 0o700 });
  const server = bin + "/reviewer.ts";
  await Deno.writeTextFile(
    server,
    `
await Deno.writeTextFile(${
      JSON.stringify(root + "/reviewer.json")
    }, JSON.stringify({
  pid: Deno.pid, args: Deno.args, env: Deno.env.toObject(), cwd: Deno.cwd()
}));
let text = "";
setInterval(() => {}, 1000);
for await (const part of Deno.stdin.readable) {
  text += new TextDecoder().decode(part);
  let end;
  while ((end = text.indexOf("\\n")) >= 0) {
    const frame = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
    if (frame.id !== undefined) {
      const result = frame.method === "thread/start" ? {
        thread: { id: "synthetic-thread" }, model: "codex-auto-review",
        modelProvider: "uos", reasoningEffort: "max",
        activePermissionProfile: { id: "sentinel-review" }
      } : frame.method === "review/start" ? {
        turn: { id: "synthetic-turn", status: "inProgress" }, reviewThreadId: "synthetic-thread"
      } : { userAgent: "synthetic-reviewer" };
      console.log(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    }
  }
}
await new Promise(() => {});
`,
  );
  await Deno.writeTextFile(
    bin + "/codex",
    "#!/bin/sh\nexec " +
      shellQuote(Deno.execPath()) +
      " run --no-config --no-lock --allow-read --allow-write --allow-env " +
      shellQuote(server) + ' "$@"\n',
    { mode: 0o700 },
  );
  return bin;
}

function inputFor(rig: Awaited<ReturnType<typeof makeRig>>) {
  return {
    state: rig.release,
    clock: rig.clock,
    env: rig.env,
    launcherDir: rig.launcherDir,
    runtimeDir: rig.runtimeDir,
    denoExecutable: Deno.execPath(),
    process: rig.process,
  };
}

function runtimeFiles(extra: Record<string, string> = {}) {
  return {
    ".gitignore": ".sentinel-actions-state/\n.sentinel/\n",
    "sentinel.targets.json": '["ubiquity/sentinel","ubiquity/ai.ubq.fi"]\n',
    ...extra,
  };
}

Deno.test("review owner host: production construction passes its descriptor only through trusted repair stdin", async () => {
  const rig = await makeRig({ runtimeFiles: runtimeFiles() });
  const root = rig.runtimeDir.slice(0, rig.runtimeDir.lastIndexOf("/"));
  try {
    const bin = await fakeCodex(root);
    rig.env.PATH = bin + ":/usr/bin:/bin";
    rig.env.SENTINEL_APP_INSTALLATION_ID = "42";
    rig.env.SENTINEL_MODEL_FALLBACK = "deepseek";
    rig.env.SENTINEL_MODEL_ID = "gpt-5.6-luna";
    rig.env.SENTINEL_DEEPSEEK_API_KEY = "synthetic-implementation-key";
    await seedRelease(rig);
    rig.process.child = exited(childLine(rig.execution));
    const result = await runFixtureReviewOwnerHost(inputFor(rig));
    assert.equal(result.status, "healthy", JSON.stringify(result));
    const child = rig.process.childCalls()[0]!;
    const decoded = reviewOwnerChildInput(child.stdin, rig.execution);
    assert.equal(decoded.matrix, undefined);
    assert.ok(decoded.reviewCustody);
    assert.equal(decoded.reviewCustody.ownerRunId, rig.execution.id);
    assert.equal(Object.hasOwn(child.env, "reviewCustody"), false);
    assert.equal(
      child.args.some((arg) => arg.includes("review-custody-")),
      false,
    );
    await assert.rejects(
      Deno.lstat(decoded.reviewCustody.directory),
      Deno.errors.NotFound,
    );
    const publicLines: string[] = [];
    const log = console.log;
    try {
      console.log = (...values: unknown[]) =>
        publicLines.push(values.join(" "));
      assert.equal(emitHostedRuntimeCliResult(result), 0);
    } finally {
      console.log = log;
    }
    assert.equal(
      publicLines.join("\n").includes(decoded.reviewCustody.directory),
      false,
    );
    assert.equal(
      publicLines.join("\n").includes("synthetic-implementation-key"),
      false,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("review owner host: actual parent survives repair death, cleans its fake reviewer and supplies a native carrier", async () => {
  const script = `
import { ReviewOwnerChannelClient } from ${JSON.stringify(CHANNEL)};
import { composeLocalGitHub } from ${JSON.stringify(COMPOSITION)};
import { LocalSessionTracker } from ${JSON.stringify(CLIENT)};
import { resolveExecutable } from ${JSON.stringify(IO)};
let text = "";
for await (const part of Deno.stdin.readable) text += new TextDecoder().decode(part);
const descriptor = JSON.parse(text).reviewCustody;
const execution = JSON.parse(await Deno.readTextFile(".sentinel-actions-state/fixture.json"));
const stateRoot = Deno.cwd() + "/.sentinel-actions-state";
const source = stateRoot + "/source", scratch = stateRoot + "/scratch";
const trustedPath = Deno.env.get("PATH");
await Deno.mkdir(source, { recursive: true, mode: 0o700 });
await Deno.mkdir(scratch, { recursive: true, mode: 0o700 });
async function git(args) {
  const result = await new Deno.Command("/usr/bin/git", {
    args: ["-c", "user.name=Sentinel Test", "-c", "user.email=sentinel@example.invalid", "-C", source, ...args],
    clearEnv: true, env: { PATH: trustedPath, HOME: scratch, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
  }).output();
  if (!result.success) throw new Error("synthetic Git preparation refused");
  return new TextDecoder().decode(result.stdout).trim();
}
await git(["init", "-q"]);
await Deno.writeTextFile(source + "/value.ts", "export const value = 0;\\n");
await git(["add", "-A"]); await git(["commit", "-q", "-m", "base"]);
const base = await git(["rev-parse", "HEAD"]);
await Deno.writeTextFile(source + "/value.ts", "export const value = 1;\\n");
await git(["add", "-A"]); await git(["commit", "-q", "-m", "candidate"]);
const head = await git(["rev-parse", "HEAD"]);
const login = "ubiquity-sentinel[bot]";
let standing = null;
const response = (status, value) => Promise.resolve({ status, headers: new Headers(), bodyText: JSON.stringify(value) });
const custody = new ReviewOwnerChannelClient(descriptor);
const tracker = new LocalSessionTracker();
tracker.open = () => { throw new Error("native reviewer must stay in the parent"); };
const repairSnapshot = ${JSON.stringify(snapshot([]))};
let repairReads = 0, rulesReads = 0;
const port = composeLocalGitHub({
  clock: { now: () => Date.now() }, state: {
    readRepair: () => {
      repairReads++;
      return Promise.resolve({ ok: true, value: { status: "found", snapshot: repairSnapshot, head, ref: null } });
    },
    readRelease: () => { throw new Error("no release state authority expected"); },
    writeRepair: () => { throw new Error("no repair write authority expected"); }
  }, gate: { beforeRequest: () => Promise.resolve({ ok: true, value: undefined }), recordRateLimit: () => Promise.resolve({ ok: true, value: undefined }) },
  token: "synthetic-token", login, invocationId: "disposable-owner",
  stateRoot, sourcePath: source, scratch, reviewCheckout: stateRoot + "/review-checkout",
  reviewClientHome: stateRoot + "/clients/review", reviewTmpDir: stateRoot + "/tmp/review",
  reviewDenoDir: stateRoot + "/deno/review", trustedPath,
  codexExecutable: await resolveExecutable("codex", trustedPath), tracker,
  ownerExecution: execution, ownerCustody: custody,
  http: (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.endsWith("/rules/branches/development")) {
      rulesReads++; return response(200, []);
    }
    if (path.endsWith("/pulls/55")) return response(200, {
      number: 55, title: "Synthetic review", body: "Synthetic bounded task", state: "open",
      head: { ref: "sentinel/synthetic", sha: head }, base: { ref: "development", sha: base },
      user: { login }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      merged_at: null, merge_commit_sha: null
    });
    if (request.method === "POST" && path.endsWith("/reviews")) {
      const body = JSON.parse(request.body);
      standing = { id: 100, user: { login }, state: "PENDING", body: body.body, commit_id: head, submitted_at: null };
      return response(201, standing);
    }
    if (request.method === "PUT" && path.endsWith("/reviews/100")) {
      standing.body = JSON.parse(request.body).body; return response(200, standing);
    }
    if (path.endsWith("/reviews/100")) return response(200, standing);
    if (path.endsWith("/reviews")) return response(200, standing === null ? [] : [standing]);
    throw new Error("unscripted synthetic review API");
  }
});
const result = await port.requestReview({
  operationKey: "review:host:1", prNumber: 55, expectedHead: head, expectedBase: base,
  expectedReviewer: login, latestStartAt: Date.now() + 60000, settleBy: Date.now() + 1200000
});
if (!result.ok || result.value.outcome !== "applied") throw new Error("synthetic composed review refused");
if (repairReads === 0 || rulesReads === 0) throw new Error("synthetic queue observation missing");
console.log("synthetic composed reviewer opened");
Deno.kill(Deno.pid, "SIGKILL");
`;
  const rig = await makeRig({
    runtimeFiles: runtimeFiles({ "src/host/actions.ts": script }),
  });
  const root = rig.runtimeDir.slice(0, rig.runtimeDir.lastIndexOf("/"));
  let pid: number | undefined;
  try {
    const bin = await fakeCodex(root);
    rig.env.PATH = bin + ":/usr/bin:/bin";
    rig.env.SENTINEL_APP_INSTALLATION_ID = "42";
    rig.execution.runId = 900;
    rig.execution.id = "900:2:repair";
    rig.env.GITHUB_RUN_ID = "900";
    await Deno.mkdir(rig.runtimeDir + "/.sentinel-actions-state", {
      mode: 0o700,
    });
    await Deno.writeTextFile(
      rig.runtimeDir + "/.sentinel-actions-state/fixture.json",
      JSON.stringify(rig.execution),
    );
    await seedRelease(rig);
    rig.process.realChild = true;
    const result = await runFixtureReviewOwnerHost(inputFor(rig));
    assert.equal(result.status, "failed", JSON.stringify(result));
    assert.equal(
      result.reviewOwnerSettlements?.length,
      1,
      JSON.stringify(result),
    );
    const record = result.reviewOwnerSettlements![0]!;
    const reviewer = JSON.parse(
      await Deno.readTextFile(root + "/reviewer.json"),
    );
    pid = reviewer.pid;
    assert.throws(() => Deno.kill(reviewer.pid, 0), Deno.errors.NotFound);
    assert.deepEqual(reviewer.args, ["app-server"]);
    assert.equal(
      reviewer.cwd,
      rig.runtimeDir + "/.sentinel-actions-state/review-checkout",
    );
    assert.equal(
      reviewer.env.CODEX_HOME,
      rig.runtimeDir + "/.sentinel-actions-state/clients/review",
    );
    for (
      const key of [
        "GITHUB_TOKEN",
        "UOS_AI_TOKEN",
        "SENTINEL_SUPERVISOR_TOKEN",
        "SENTINEL_DEEPSEEK_API_KEY",
      ]
    ) {
      assert.equal(Object.hasOwn(reviewer.env, key), false);
    }
    assert.equal(record.carrier.noRetainedHandle, true);
    assert.equal(record.carrier.journal.phase, "running");
    assert.equal(
      record.carrier.preparedExecution?.ownerRunId,
      rig.execution.id,
    );
    assert.equal(record.carrier.preparedExecution?.submittedProvider, "uos");
    assert.equal(record.carrier.preparedExecution?.model, null);
    const finish = record.carrier.settledAt + 1000;
    const native = nativeRig(finish + 1000);
    const begun = record.execution.createdAt;
    scriptAttemptAndJobs(
      native,
      {
        ...attemptBody({
          updatedAt: finish,
          headSha: record.execution.launcherSha,
        }),
        run_started_at: iso(begun),
      },
      jobsBody([jobBody({
        headSha: record.execution.launcherSha,
        startedAt: begun,
        completedAt: finish,
        steps: [
          runtimeStep({ started_at: iso(begun), completed_at: iso(finish) }),
        ],
      })]),
    );
    scriptLog(
      native,
      logText(
        [record as unknown as Record<string, unknown>],
        record.carrier.settledAt,
      ),
    );
    assert.equal(typeof native.client.readNativeCiEvidence, "function");
    const read = await native.client.readReviewOwnerSettlement({
      repository: record.carrier.repository,
      reviewId: record.carrier.reviewId,
      journal: record.carrier.journal,
      bodyDigest: record.carrier.bodyDigest,
    });
    assert.ok(read.ok && read.value !== null, JSON.stringify(read));
    if (read.ok && read.value) assert.deepEqual(read.value.record, record);
  } finally {
    if (pid === undefined) {
      try {
        pid = JSON.parse(await Deno.readTextFile(root + "/reviewer.json")).pid;
      } catch { /* No fake spawned. */ }
    }
    if (pid !== undefined) {
      try {
        Deno.kill(-pid, "SIGKILL");
      } catch { /* Already proved absent. */ }
    }
    await rig.cleanup();
  }
});

Deno.test("review owner host: invalid private paths refuse while obsolete model selection is ignored", async (test) => {
  for (
    const fault of [
      "missing-targets",
      "invalid-model",
      "symlink-client",
      "private-config",
      "path-collision",
      "foreign-pointer",
    ]
  ) {
    await test.step(fault, async () => {
      const rig = await makeRig({ runtimeFiles: runtimeFiles() });
      const root = rig.runtimeDir.slice(0, rig.runtimeDir.lastIndexOf("/"));
      try {
        const bin = await fakeCodex(root);
        rig.env.PATH = bin + ":/usr/bin:/bin";
        await seedRelease(rig);
        rig.process.child = exited(childLine(rig.execution));
        if (fault === "missing-targets") {
          await Deno.remove(rig.runtimeDir + "/sentinel.targets.json");
        }
        if (fault === "invalid-model") {
          rig.env.SENTINEL_REVIEW_MODEL_ID = "invalid model\n";
        }
        if (fault === "foreign-pointer") rig.env.GITHUB_RUN_ATTEMPT = "3";
        if (fault === "path-collision") {
          await Deno.writeTextFile(
            rig.runtimeDir + "/sentinel.targets.json",
            '["a-b/c","a/b-c"]',
          );
        }
        if (fault === "symlink-client" || fault === "private-config") {
          const state = rig.runtimeDir + "/.sentinel-actions-state";
          await Deno.mkdir(state + "/clients", {
            recursive: true,
            mode: 0o700,
          });
          if (fault === "symlink-client") {
            const linked = await new Deno.Command("/bin/ln", {
              args: ["-s", root, state + "/clients/review"],
              clearEnv: true,
            }).output();
            assert.equal(linked.success, true);
          } else {
            await Deno.mkdir(state + "/clients/review", { mode: 0o700 });
            const linked = await new Deno.Command("/bin/ln", {
              args: [
                "-s",
                root + "/reviewer.json",
                state + "/clients/review/config.toml",
              ],
              clearEnv: true,
            }).output();
            assert.equal(linked.success, true);
          }
        }
        const result = await runFixtureReviewOwnerHost(inputFor(rig));
        if (fault === "invalid-model") {
          assert.equal(result.status, "healthy");
          assert.equal(rig.process.childCalls().length, 1);
        } else {
          assert.equal(result.status, "unavailable");
          assert.equal(result.terminal, null);
          assert.equal(rig.process.childCalls().length, 0);
        }
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("review owner host: deterministic registry refuses a nonordinary owner without creating any process", async () => {
  await assert.rejects(
    createHostedReviewOwnerCustody({
      execution: { purpose: "promotion" } as never,
      runtimeDir: PROJECT,
      env: {},
    }),
    /protected review owner configuration unavailable/,
  );
});
