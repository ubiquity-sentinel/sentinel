import assert from "node:assert/strict";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import {
  type HostedRuntimeRecordV1,
  parseHostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { recordFiles } from "../../src/state/state-codec.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { TASK_ACCEPTANCE_UNCERTAIN_DETAIL } from "../../src/repair/review-gate.ts";
import { runHostedAutonomyMain } from "../../ops/hosted-autonomy-main.ts";
import type { HostedAutonomyResultV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  ACCEPTANCE_CORRECTION_REQUIRES_RUNTIME,
  ACCEPTANCE_READMISSION_DETAIL,
  acceptanceCorrectionRuntimeProven,
  acceptanceCorrectionSelfInstalledRuntimeProven,
  planAcceptanceReadmissions,
} from "../../ops/hosted-autonomy-acceptance.ts";
import {
  BASE,
  deliveryRecord,
  ENV,
  HEAD,
  pullFacts,
} from "./hosted-autonomy-fixtures.ts";
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import { TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL } from "../../src/repair/review-gate.ts";
import { TASK_ACCEPTANCE_OWNER_GATE_DETAIL } from "../../src/repair/acceptance-correction.ts";
import {
  healthyProof,
  makeRig,
  releaseSnapshot,
  repairSnapshot,
} from "./hosted-autonomy-rig.ts";
import { nativeWriterFixture } from "./existing-pr-runtime-fixtures.ts";
import { CONTROLLER } from "./controller-identity-fixture.ts";
import { snapshotWire } from "../github/merge-queue-fixtures.ts";
import { completedReceipt } from "../repair/loop-review-fixtures.ts";
import { gitRun, pushRawTree, reservation, T0 } from "../state/helpers.ts";

const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 155687488,
};
const NOW = T0 + 10_000;

function selfInstalledRelease(revision: GitSha, generation = 130) {
  const proof = parseHostedRunProofV1({
    ...healthyProof(revision, generation, "unused"),
    execution: {
      ...healthyProof(revision, generation, "unused").execution,
      purpose: "bootstrap",
      releaseId: null,
      launcherSha: revision,
    },
  });
  const release = releaseSnapshot([], revision);
  Object.assign(release.hostedRuntimes[0], {
    generation,
    lastHealthyProof: proof,
    lastExecutionProof: proof,
    updatedAt: NOW,
  });
  return parseReleaseStateSnapshotV1({
    ...release,
    updatedAt: NOW,
    hostedInstallations: [{
      version: "v1",
      kind: "hosted_installation",
      id: `installation:${revision}`,
      candidateRevision: revision,
      previousRevision: BASE,
      previousGeneration: generation - 1,
      previousHealthyProof: null,
      ci: { revision, checkRunId: 1 },
      phase: "accepted",
      pointerIntent: null,
      bootstrapExecutionId: proof.execution.id,
      bootstrapProof: proof,
      rollbackExecutionId: null,
      rollbackProof: null,
      createdAt: T0,
      updatedAt: NOW,
    }],
  });
}

async function acceptanceFixture(installed?: GitSha) {
  const previous = Deno.cwd();
  const root = await Deno.makeTempDir({
    dir: previous,
    prefix: ".sentinel-m20-",
  });
  const checkout = `${root}/source`;
  await Deno.mkdir(checkout);
  const git = async (args: string[], cwd = checkout) => {
    const result = await gitRun(cwd, args, ENV);
    assert.ok(result.ok, result.stderr);
    return result.stdout.trim();
  };
  await git(["init", "-q"]);
  await Deno.writeTextFile(`${checkout}/.gitignore`, "*\n");
  await git(["add", "-f", ".gitignore"]);
  await git(["commit", "-q", "-m", "clean acceptance runtime source"]);
  const revision = await git(["rev-parse", "HEAD"]) as GitSha;
  const originalId = "e".repeat(64);
  const operationKey = implementationIntentKey(originalId);
  const record = deliveryRecord({
    repository: PASSPORT,
    id: "issue-ubiquity-passport.ubq.fi-47",
    source: { kind: "issue", id: "47", revision: BASE },
    related: { incidentId: null, issueNumber: 47 },
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
      since: T0,
    },
    evidence: [],
    target: {
      base: BASE,
      head: HEAD,
      pr: 172,
      branch: "sentinel/repair/issue-ubiquity-passport.ubq.fi-47",
      checkpoint: null,
      candidateState: {
        preserved: {
          operationKey,
          base: BASE,
          head: HEAD,
          ref: await candidatePreservationRef(
            PASSPORT,
            asWorkItemId("issue-ubiquity-passport.ubq.fi-47"),
            operationKey,
          ),
        },
        publishedHead: HEAD,
      },
    },
  });
  const old = completedReceipt(172, HEAD, BASE, {
    repository: PASSPORT,
    taskAcceptance: {
      issueNumber: 47,
      taskDigest: "a".repeat(64),
      verdict: "uncertain",
      evidence: ["The prior review did not establish task acceptance."],
    },
  });
  const charge = reservation(originalId, {
    repository: PASSPORT,
    taskId: record.id,
    attempt: 1,
    purpose: "implementation",
    head: BASE,
    outcome: "submitted",
    settledAt: T0,
  });
  const { rig } = await makeRig("acceptance-runtime", {
    fixtureDir: root,
    repair: repairSnapshot([record], [old], [], [charge]),
    release: releaseSnapshot([], null),
    pull: pullFacts({
      number: 172,
      state: "open",
      merged: false,
      headSha: HEAD,
      baseRef: "main",
      baseSha: BASE,
      author: "ubiquity-sentinel[bot]",
    }),
  });
  const release = createReleaseStateStore({
    scratchDir: `${rig.tmp}/release-observer`,
    remoteUrl: `${rig.tmp}/remote.git`,
  });
  const seeded = await release.readRelease();
  assert.ok(seeded.ok && seeded.value.status === "found");
  // Model an authenticated historical installation, as the live-install fixtures
  // do; maintenance must consume the real Git reader, not a substituted snapshot.
  const accepted = selfInstalledRelease(
    installed ?? revision,
    installed === undefined ? 130 : 131,
  );
  const files = Object.fromEntries(
    (await recordFiles(accepted, "release")).map((row) => [row.path, row.text]),
  );
  files["manifest.json"] = canonicalStringify({
    version: "v1",
    kind: "release_state_manifest",
    stateHead: seeded.value.head,
    sequence: 2,
    updatedAt: NOW,
  }) + "\n";
  const persisted = await pushRawTree(
    { bare: `${rig.tmp}/remote.git`, work: `${rig.tmp}/work` },
    seeded.value.head,
    "refs/heads/sentinel-state/release",
    files,
    ENV,
  );
  assert.ok(persisted.ok, persisted.stderr);
  const native = nativeWriterFixture({
    runId: 900,
    runAttempt: 1,
    launcherSha: revision,
  }, "maintenance");
  const environment: Record<string, string> = {
    GITHUB_REPOSITORY: CONTROLLER.fullName,
    GITHUB_REF: "refs/heads/sentinel-supervisor",
    GITHUB_JOB: "maintenance",
    GITHUB_RUN_ID: "900",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_WORKFLOW_REF: CONTROLLER.workflowRef,
    GITHUB_SHA: revision,
    GITHUB_WORKFLOW_SHA: revision,
    GITHUB_TOKEN: "offline-native-token",
    SENTINEL_SUPERVISOR_TOKEN: "offline-target-token",
  };
  const original = {
    command: Deno.Command,
    env: Deno.env.get,
    temp: Deno.makeTempDir,
    fetch: globalThis.fetch,
    now: Date.now,
    log: console.log,
  };
  const reports: HostedAutonomyResultV1[] = [];
  const http: string[] = [];
  const effects: string[] = [];
  const remote = `${rig.tmp}/remote.git`;
  Deno.Command = class extends original.command {
    constructor(command: string | URL, options: Deno.CommandOptions = {}) {
      assert.equal(
        command,
        "git",
        "maintenance cannot launch a model or reviewer",
      );
      super(command, {
        ...options,
        args: [
          "-c",
          `url.${remote}.insteadOf=https://github.com/ubiquity-sentinel/sentinel.git`,
          ...(options.args ?? []),
        ],
      });
    }
  };
  Deno.env.get = (key) => key === "PATH" ? ENV.PATH : environment[key];
  Date.now = () => NOW;
  Deno.makeTempDir = (options) =>
    original.temp(
      options?.prefix === "sentinel-maintenance-matrix-" &&
        options.dir === undefined
        ? { ...options, dir: root }
        : options,
    );
  console.log = (...values: unknown[]) => {
    original.log(...values);
    if (typeof values[0] !== "string" || !values[0].startsWith("{")) return;
    const value = JSON.parse(values[0]);
    if (value.kind === "hosted_autonomy") reports.push(value);
  };
  globalThis.fetch = async (request, init) => {
    const url = new URL(
      request instanceof Request ? request.url : String(request),
    );
    const method = init?.method ??
      (request instanceof Request ? request.method : "GET");
    http.push(`${method} ${url.pathname}`);
    assert.equal(url.origin, "https://api.github.com");
    const response = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status });
    if (url.pathname === "/graphql") {
      assert.ok(
        JSON.parse(String(init?.body)).query.trimStart().startsWith("query"),
      );
      return response(snapshotWire(null));
    }
    if (method !== "GET") {
      effects.push(`${method} ${url.pathname}`);
      throw new Error("maintenance must not review, merge or close an issue");
    }
    const value = await native.read(url.pathname + url.search);
    if (value !== null) return response(value);
    if (url.pathname.includes("/rules/branches/")) return response([]);
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
      return response({ default_branch: "main" });
    }
    if (url.pathname.endsWith("/git/ref/heads/main")) {
      return response({ ref: "refs/heads/main", object: { sha: BASE } });
    }
    if (url.pathname.endsWith("/issues/47")) {
      return response({
        number: 47,
        state: "open",
        title: "issue 47",
        body: "",
        labels: [],
      });
    }
    if (url.pathname.endsWith("/pulls/172")) {
      return response({
        number: 172,
        state: "open",
        merged: false,
        head: { sha: HEAD },
        base: { ref: "main", sha: BASE },
        user: { login: "ubiquity-sentinel[bot]" },
      });
    }
    if (url.pathname.endsWith("/pulls")) return response([]);
    return response({}, 404);
  };
  Deno.chdir(checkout);
  return {
    rig,
    record,
    old,
    charge,
    revision,
    environment,
    reports,
    http,
    effects,
    release,
    checkout,
    git,
    async run() {
      assert.equal(await runHostedAutonomyMain(), 0);
      assert.ok(reports.length > 0);
      return reports.at(-1)!;
    },
    async runInjected(sourceRevision?: GitSha) {
      const deps = await withDarkQueueAuthority({
        state: rig.state,
        githubFor: rig.githubFor,
        clock: { now: () => NOW },
        ...(sourceRevision === undefined
          ? {}
          : { acceptanceCorrectionSourceRevision: sourceRevision }),
      });
      const exit = await runHostedAutonomyMain({ env: environment, deps });
      assert.ok(reports.length > 0);
      return { exit, result: reports.at(-1)! };
    },
    async close() {
      Deno.chdir(previous);
      Deno.Command = original.command;
      Deno.env.get = original.env;
      Deno.makeTempDir = original.temp;
      globalThis.fetch = original.fetch;
      Date.now = original.now;
      console.log = original.log;
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test("acceptance runtime: production composition admits exact self-installed Passport acceptance without override", async () => {
  const fixture = await acceptanceFixture();
  try {
    const before = await fixture.rig.state.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const releaseBefore = await fixture.release.readRelease();
    const result = await fixture.run();
    const after = await fixture.rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.ok(
      result.actions.some((action) =>
        action ===
          `retry:${fixture.record.id}:denied:${ACCEPTANCE_CORRECTION_REQUIRES_RUNTIME}` ||
        action ===
          `retry:${fixture.record.id}:grant=0:${ACCEPTANCE_READMISSION_DETAIL}`
      ),
      JSON.stringify(result),
    );
    assert.equal(
      after.value.snapshot.work[0].nextStep,
      "review",
      JSON.stringify(result),
    );
    assert.equal(after.value.snapshot.work[0].blocker, null);
    assert.deepEqual(
      after.value.snapshot.work[0].counters,
      fixture.record.counters,
    );
    assert.deepEqual(
      after.value.snapshot.reservations,
      before.value.snapshot.reservations,
    );
    assert.deepEqual(after.value.snapshot.reviews, [fixture.old]);
    assert.equal(result.beforeHead, before.value.head);
    assert.equal(result.appliedHead, after.value.head);
    assert.equal(
      await fixture.git([
        "--git-dir",
        `${fixture.rig.tmp}/remote.git`,
        "rev-parse",
        `${after.value.head}^`,
      ]),
      before.value.head,
    );
    assert.equal(
      after.value.snapshot.sequence,
      before.value.snapshot.sequence + 1,
    );
    assert.deepEqual(await fixture.release.readRelease(), releaseBefore);
    await fixture.run();
    assert.deepEqual(await fixture.rig.state.readRepair(), after);
    assert.deepEqual(fixture.effects, []);
    assert.ok(fixture.http.some((path) => path.endsWith("/pulls/172")));
  } finally {
    await fixture.close();
  }
});

Deno.test("acceptance runtime: modern capability requires exact own source launcher and healthy generation", () => {
  const runtime = selfInstalledRelease(HEAD).hostedRuntimes[0];
  assert.equal(
    acceptanceCorrectionSelfInstalledRuntimeProven(runtime, HEAD),
    true,
  );
  assert.equal(
    acceptanceCorrectionSelfInstalledRuntimeProven(runtime, undefined),
    false,
  );
  assert.equal(
    acceptanceCorrectionSelfInstalledRuntimeProven(null, HEAD),
    false,
  );
  assert.equal(
    acceptanceCorrectionSelfInstalledRuntimeProven(undefined, HEAD),
    false,
  );
  const controls: Record<string, (row: HostedRuntimeRecordV1) => void> = {
    "old regime": (row) => {
      row.generation = 81;
      row.lastHealthyProof!.execution.generation = 81;
    },
    "unsafe generation": (row) => {
      row.generation = Number.MAX_SAFE_INTEGER + 1;
      row.lastHealthyProof!.execution.generation = row.generation;
    },
    "fractional generation": (row) => {
      row.generation = 130.5;
      row.lastHealthyProof!.execution.generation = row.generation;
    },
    "missing proof": (row) => {
      row.lastHealthyProof = null;
    },
    "failed proof": (row) => {
      row.lastHealthyProof!.outcome = "failed";
    },
    "unsettled proof": (row) => {
      Object.assign(row.lastHealthyProof!, { settled: false });
    },
    "not ready": (row) => {
      row.lastHealthyProof!.startupReady = false;
    },
    "foreign proof": (row) => {
      row.lastHealthyProof!.execution.revision = BASE;
    },
    "stale generation": (row) => {
      row.lastHealthyProof!.execution.generation--;
    },
    "different launcher": (row) => {
      row.lastHealthyProof!.execution.launcherSha = BASE;
    },
    "incompatible rollback at higher generation": (row) => {
      row.activeRevision = BASE;
      row.generation++;
      row.lastHealthyProof!.execution.revision = BASE;
      row.lastHealthyProof!.execution.launcherSha = BASE;
      row.lastHealthyProof!.execution.generation = row.generation;
    },
  };
  for (const [label, mutate] of Object.entries(controls)) {
    const candidate = structuredClone(runtime);
    mutate(candidate);
    assert.equal(
      acceptanceCorrectionSelfInstalledRuntimeProven(candidate, HEAD),
      false,
      label,
    );
  }
});

Deno.test("acceptance runtime: historical R81 cannot authorize any Passport trial class", () => {
  const runtime = selfInstalledRelease(HEAD, 81).hostedRuntimes[0];
  assert.equal(
    acceptanceCorrectionRuntimeProven(runtime, new Set([HEAD])),
    true,
  );
  assert.equal(
    acceptanceCorrectionSelfInstalledRuntimeProven(runtime, HEAD),
    false,
  );
  for (
    const message of [
      TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
      TASK_ACCEPTANCE_OWNER_GATE_DETAIL,
      TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
    ]
  ) {
    for (const rounds of [1, 10]) {
      const record = deliveryRecord({
        repository: PASSPORT,
        nextStep: "blocked",
        blocker: { kind: "other", message, since: T0 },
        counters: { attempts: 1, retries: 0, reviewRounds: rounds },
      });
      const charge = reservation("trial-legacy-control", {
        repository: PASSPORT,
        taskId: record.id,
        head: BASE,
        attempt: 1,
        purpose: "implementation",
        outcome: "submitted",
        settledAt: T0,
      });
      const snapshot = repairSnapshot([record], [], [], [charge]);
      const before = structuredClone(snapshot);
      assert.deepEqual(
        planAcceptanceReadmissions(snapshot, new Set(), true),
        [],
        `${message}: ${rounds}`,
      );
      assert.equal(
        planAcceptanceReadmissions(snapshot, new Set(), false, undefined, true)
          .length,
        1,
        `${message}: ${rounds}`,
      );
      assert.deepEqual(snapshot, before);
    }
  }
  const record = deliveryRecord({
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
      since: T0,
    },
  });
  const snapshot = repairSnapshot([record], [], [], []);
  assert.equal(
    planAcceptanceReadmissions(snapshot, new Set(), true).length,
    1,
    "historical nontrial not_fulfilled remains supported",
  );
  assert.equal(
    planAcceptanceReadmissions(snapshot, new Set(), false, undefined, true)
      .length,
    1,
    "modern source also supports original nontrial correction",
  );
});

Deno.test("acceptance runtime: injected main overwrites supplied provenance with verified clean source", async () => {
  const fixture = await acceptanceFixture();
  try {
    const result = await fixture.runInjected(BASE);
    assert.equal(result.exit, 0);
    const read = await fixture.rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(
      read.value.snapshot.work[0].nextStep,
      "review",
      JSON.stringify(result),
    );
    assert.deepEqual(read.value.snapshot.reservations, [fixture.charge]);
    assert.deepEqual(fixture.effects, []);
  } finally {
    await fixture.close();
  }
});

Deno.test("acceptance runtime: forged caller provenance cannot authorize an incompatible installed rollback", async () => {
  const fixture = await acceptanceFixture(HEAD);
  try {
    const before = await fixture.rig.state.readRepair();
    const result = await fixture.runInjected(HEAD);
    assert.equal(result.exit, 0);
    assert.ok(
      result.result.actions.includes(
        `retry:${fixture.record.id}:denied:${ACCEPTANCE_CORRECTION_REQUIRES_RUNTIME}`,
      ),
    );
    assert.deepEqual(await fixture.rig.state.readRepair(), before);
    assert.deepEqual(fixture.effects, []);
  } finally {
    await fixture.close();
  }
});

Deno.test("acceptance runtime: dirty source and mismatched native identity fail before granting provenance", async (t) => {
  for (const control of ["dirty", "workflow mismatch"] as const) {
    await t.step(control, async () => {
      const fixture = await acceptanceFixture();
      try {
        const before = await fixture.rig.state.readRepair();
        if (control === "dirty") {
          await Deno.writeTextFile(
            `${fixture.checkout}/.gitignore`,
            "*\n# dirty\n",
          );
        } else fixture.environment.GITHUB_WORKFLOW_SHA = HEAD;
        const result = await fixture.runInjected(fixture.revision);
        assert.equal(result.exit, 1);
        assert.equal(result.result.reason, "identity_rejected");
        assert.deepEqual(await fixture.rig.state.readRepair(), before);
        assert.deepEqual(fixture.effects, []);
      } finally {
        await fixture.close();
      }
    });
  }
});
