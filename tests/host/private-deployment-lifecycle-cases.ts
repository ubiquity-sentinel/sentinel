/**
 * Both deployments run these cases through the hosted planner, cell,
 * maintenance recovery and repair aggregate. Temporary Git repositories
 * carry the state and candidate objects. Fixture ports supply GitHub's API,
 * the implementation result and the native review receipt.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_CONTROLLER_PROFILE as profile,
  HOSTED_CONTROLLER_PROFILES,
  HOSTED_CONTROLLER_REMOTE,
} from "../../src/contracts/hosted-controller-deployment.ts";
import type {
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  type MatrixCellResultV1,
  MAX_MATRIX_CELLS,
} from "../../src/contracts/matrix.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { PRIVATE_TARGETS_KIND } from "../../src/repair/private-targets-line.ts";
import { scanStepLines } from "../../src/repair/step-line.ts";
import { recoverLateCell } from "./private-matrix-maintenance.ts";
import { response, snapshotWire } from "../github/merge-queue-fixtures.ts";
import {
  checked,
  issue,
  PROVIDER,
  rig,
  TargetGithub,
} from "./matrix-actions-fixtures.ts";
import {
  advanceWithLog,
  QUIET_LOG,
  quietly,
  reply,
  servingJobLogs,
} from "./targets-deferral-fixtures.ts";

const [PUBLIC_CONTROLLER, PRIVATE_CONTROLLER] = HOSTED_CONTROLLER_PROFILES.map(
  ({ repository }) => repository,
);
type TargetPair = Readonly<Record<"public" | "private", string>>;
const DIRECT_TARGETS: TargetPair = {
  public: "ubiquity/lifecycle-public",
  private: "ubiquity/auth.ubq.fi",
};
const LATE_TARGETS: TargetPair = {
  public: "ubiquity/lifecycle-public-late",
  private: "ubiquity/prospector",
};
const PRIVATE_BODY =
  '{"default_branch":"development","private":true,"visibility":"private"}';
const PUBLIC_BODY =
  '{"default_branch":"development","private":false,"visibility":"public"}';
/** Each deployment gets the same repository metadata and branch rules. */
function repositoryHttp(
  urls: string[],
  targets: TargetPair,
): HttpTransportV1 {
  const bodies: Record<string, string> = {
    [`/repos/${PUBLIC_CONTROLLER}`]: PUBLIC_BODY,
    [`/repos/${PRIVATE_CONTROLLER}`]: PRIVATE_BODY,
    [`/repos/${targets.public}`]: PUBLIC_BODY,
    [`/repos/${targets.private}`]: PRIVATE_BODY,
  };
  return (request) => {
    urls.push(`${request.method} ${request.url}`);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && bodies[path] !== undefined) {
      return reply(200, {}, bodies[path])();
    }
    // The gateway merge-queue custody pass (hard-wired to the public
    // ai.ubq.fi) reads its branch rules on every host, as the API answers a
    // public repository's rules to any token.
    if (
      request.method === "GET" &&
      [
        `/repos/${targets.public}/rules/branches/development`,
        `/repos/${targets.private}/rules/branches/development`,
        "/repos/ubiquity/ai.ubq.fi/rules/branches/development",
      ].includes(path)
    ) return Promise.resolve(response([]));
    if (
      request.method === "POST" && path === "/graphql" &&
      request.body?.includes("mergeQueue(branch:")
    ) return Promise.resolve(response(snapshotWire(null)));
    return Promise.reject(new Error(`no other request: ${request.url}`));
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** The fixture's active target has one issue and a pending native review. */
function lifecyclePort(r: Rig, slug: string): TargetGithub {
  const port: TargetGithub = new TargetGithub({
    baseSha: r.foreignSha,
    candidateLifecycle: {
      preserveCandidate: ({ candidate }) => {
        port.candidateRefs.set(candidate.ref, candidate.head);
        return Promise.resolve(portOk(undefined));
      },
    },
  });
  port.reviewStatus = "pending";
  port.prepareBaseRefresh = () =>
    Promise.reject(new Error("unchanged fixture base must not refresh"));
  const self = r.github.get(profile.repository);
  r.github.clear();
  if (profile.worksControllerTargets) {
    assert.ok(self, "the controller's fixture port is missing");
    self.listOpenIssues = () => Promise.resolve(portOk([]));
    r.github.set(profile.repository, self);
  }
  r.github.set(slug, port);
  return port;
}

/** Native jobs have the same mixed-visibility setting on both deployments. */
function lifecycleJobs(
  r: Rig,
  seen: { urls: string[]; composed: string[]; remotes: string[] },
  targets: TargetPair,
) {
  return async (name: string, role: string) => {
    const deps = await r.job(name, role);
    assert.equal(deps.env.GITHUB_REPOSITORY, profile.repository);
    await Deno.writeTextFile(
      `${deps.workDir}/sentinel.targets.json`,
      JSON.stringify([targets.public, targets.private, PUBLIC_CONTROLLER]),
    );
    seen.remotes.push(deps.stateRemoteUrl);
    return {
      ...deps,
      env: {
        ...deps.env,
        ...(profile.selfInstallationId === null ? {} : {
          SENTINEL_SELF_INSTALLATION_ID: String(profile.selfInstallationId),
        }),
      },
      // The production resolvers read the host and the target over `http`.
      resolveRepository: undefined,
      http: servingJobLogs(
        repositoryHttp(seen.urls, targets),
        new Map([[101, QUIET_LOG]]),
      ),
      composeGithub: (
        config: { repository: { owner: string; name: string } },
      ) => {
        const slug = `${config.repository.owner}/${config.repository.name}`;
        seen.composed.push(slug);
        const target = r.github.get(slug);
        assert.ok(target, `no surface composed for ${slug}`);
        return target;
      },
    };
  };
}

/**
 * One eligible target flows from intake to a reviewed merge. In the late
 * case the aggregate's first scan finishes before the cell uploads.
 */
async function issueToMerge(targets: TargetPair, late = false): Promise<void> {
  assert.equal(profile.repository, Deno.env.get("GITHUB_REPOSITORY"));
  assert.equal(
    HOSTED_CONTROLLER_REMOTE,
    `https://github.com/${profile.repository}.git`,
  );
  const target = targets[profile.targetVisibility];
  const r = await rig();
  const urls: string[] = [];
  const composed: string[] = [];
  const remotes: string[] = [];
  try {
    const port = lifecyclePort(r, target);
    const job = lifecycleJobs(r, { urls, composed, remotes }, targets);

    // Intake: the planner finds the eligible repository's owner issue.
    const planDeps = await job("plan", "matrix_plan");
    const planned = await quietly(() =>
      runActionsMatrixHost({
        ...planDeps,
        model: {
          modelId: "gpt-reserve",
          runModel: () => {
            throw Error("planner must not run a model");
          },
        },
      })
    );
    const planner = planned.value;
    assert.ok("plan" in planner, JSON.stringify(planner));
    assert.equal(
      planner.prepared,
      1,
      JSON.stringify({ planner, lines: planned.lines, urls, composed }),
    );
    assert.deepEqual(
      planner.plan.cells.map((cell) =>
        `${cell.repository.owner}/${cell.repository.name}`
      ),
      [target],
    );
    assert.ok(port.calls.includes("listOpenIssues"));
    assert.deepEqual(
      scanStepLines(planned.lines.join("\n")).filter((entry) =>
        entry.kind === PRIVATE_TARGETS_KIND
      ),
      [{
        kind: PRIVATE_TARGETS_KIND,
        reason: profile.excludedTargetReason,
        listed: 3,
        configured: profile.worksControllerTargets ? 2 : 1,
        skipped: profile.worksControllerTargets ? 1 : 2,
      }],
    );

    // A single scan reproduces the exhausted aggregate wait window.
    const aggregateModel = {
      modelId: "gpt-reserve",
      runModel: () => Promise.reject(new Error("aggregate cannot infer")),
    };
    const aggregate = (
      deps: Awaited<ReturnType<typeof job>>,
      waves: Parameters<typeof runActionsMatrixAggregateCycles>[1],
    ) =>
      quietly(() =>
        runActionsRepairHost({
          ...deps,
          model: aggregateModel,
          runTargetCycles: (input) =>
            runActionsMatrixAggregateCycles(
              { ...input, modelStartsEnabled: true },
              waves,
              { planDigest: planner.planDigest },
              { maxWaitMs: 0 },
            ),
        })
      );
    const empty = { recover: () => Promise.resolve([]) };
    if (late) {
      const early = await aggregate(
        await job("before-upload", "repair"),
        empty,
      );
      assert.equal(early.value.status, "ran");
      assert.equal(port.candidatePullRequests.size, 0);
      r.clock.advance(1_000);
    }

    // Implementation: one isolated cell commits the repair in its mirror.
    const cell = planner.plan.cells[0]!;
    const name = "cell-" + cell.cellId;
    const deps = await job(name, "matrix_cell");
    const artifactRoot = r.root + "/" + name + "/.sentinel-matrix";
    await Deno.mkdir(artifactRoot, { recursive: true });
    await Deno.writeTextFile(
      artifactRoot + "/plan.json",
      JSON.stringify(planner.plan),
    );
    let modelCalls = 0;
    const model: ImplementationPort = {
      modelId: "gpt-reserve",
      runModel: async (request: ModelRunRequestV1) => {
        modelCalls++;
        assert.equal(
          `${request.repository.owner}/${request.repository.name}`,
          target,
        );
        const source = deps.workDir +
          "/.sentinel-actions-state/sources/" + target.replace("/", "-");
        remotes.push(
          await checked(source, ["remote", "get-url", "origin"], r.env),
        );
        await Deno.writeTextFile(source + "/repair.txt", "repair\n");
        await checked(source, ["add", "repair.txt"], r.env);
        await checked(source, ["commit", "-q", "-m", "repair"], r.env);
        const head = await checked(source, ["rev-parse", "HEAD"], r.env);
        const receipt: ModelRunReceiptV1 = {
          invocationId: "invocation-" + cell.cellId,
          outcome: "completed",
          actual: {
            evidenceKind: "request-runtime",
            provider: PROVIDER,
            threadId: "thread-" + cell.cellId,
            turnId: "turn-" + cell.cellId,
            terminalOrigin: "runtime",
            observedTerminalStatus: "completed",
            observedModel: request.model,
            observedReasoning: "max",
            durationMs: 1,
            outputChars: 1,
          },
          candidate: {
            head: head as GitSha,
            checkpointSha: null,
            changedPaths: ["repair.txt"],
          },
          error: null,
        };
        return portOk(receipt);
      },
    };
    const result = await quietly(() =>
      runActionsMatrixHost({
        ...deps,
        model,
        carrier: { planDigest: planner.planDigest, cellId: cell.cellId },
      })
    );
    const done = result.value as MatrixCellResultV1;
    assert.ok("cellId" in done, JSON.stringify(done));
    assert.equal(done.status, "completed", JSON.stringify(done));
    assert.ok(done.bundle);
    assert.equal(modelCalls, 1);
    const archive = r.root + "/archive";
    await Deno.mkdir(archive);
    await Deno.copyFile(
      artifactRoot + "/" + done.bundle.file,
      archive + "/" + done.bundle.file,
    );

    if (late) {
      const previous = Deno.cwd();
      try {
        Deno.chdir(planDeps.workDir);
        await recoverLateCell(
          r,
          planner,
          done,
          archive,
          planDeps.workDir,
          planDeps.http,
          port,
        );
      } finally {
        Deno.chdir(previous);
      }
    }
    const published = await aggregate(
      await job("aggregate", "repair"),
      late ? empty : {
        recover: () =>
          Promise.resolve([{
            plan: planner.plan,
            planDigest: planner.planDigest,
            results: [done],
            bundlesDir: archive,
            provenance: {
              run: planner.plan.run,
              plannerJobId: 101,
              cellJobIds: [102],
            },
          }]),
      },
    );
    assert.equal(published.value.status, "ran", JSON.stringify(published));
    assert.equal(port.candidatePullRequests.size, 1);
    const pull = [...port.candidatePullRequests.values()][0]!;
    assert.equal(pull.state, "open");
    assert.equal(pull.head, done.bundle.head);
    assert.equal(pull.body, "Resolves #1");
    assert.ok(port.calls.includes("createPr"), port.calls.join("\n"));
    assert.ok(port.calls.includes("requestReview"), port.calls.join("\n"));
    assert.deepEqual(
      port.reviewRequestIdentities.map(({ prNumber, expectedHead }) => ({
        prNumber,
        expectedHead,
      })),
      [{ prNumber: pull.number, expectedHead: done.bundle.head }],
    );
    assert.ok(!port.calls.includes("merge"), port.calls.join("\n"));
    const requested = await r.store.readRepair();
    assert.ok(requested.ok && requested.value.status === "found");
    assert.ok(
      requested.value.snapshot.reservations.some((row) =>
        row.purpose === "review_request" && row.outcome === "submitted"
      ),
    );

    // The native review completes with no finding; the next run's aggregate
    // observes it at the current head and merges.
    port.completeReview([]);
    const wait = requested.value.snapshot.work[0]?.wait;
    assert.equal(wait?.reason, "review_pending");
    r.clock.advance((wait?.until ?? 0) - r.clock.now() + 1);
    await advanceWithLog(r, late ? 73 : 72, QUIET_LOG, 101);
    const merged = await aggregate(await job("aggregate-next", "repair"), {
      recover: () => Promise.resolve([]),
    });
    assert.equal(merged.value.status, "ran", JSON.stringify(merged));
    assert.ok(
      port.calls.includes("observeReview"),
      JSON.stringify({
        lines: merged.lines,
        calls: port.calls,
        now: r.clock.now(),
        work: requested.value.snapshot.work,
      }),
    );
    assert.ok(
      port.calls.includes("merge"),
      JSON.stringify({ lines: merged.lines, calls: port.calls }),
    );
    assert.equal(
      port.candidatePullRequests.get(pull.number)?.state,
      "merged",
    );
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    const work = after.value.snapshot.work.filter((row) =>
      `${row.repository.owner}/${row.repository.name}` === target
    );
    assert.equal(work.length, 1, JSON.stringify(after.value.snapshot.work));

    assert.ok(urls.some((url) => url.endsWith(`/repos/${profile.repository}`)));
    const fixturePrefix = r.root + "/";
    const remoteNames = remotes.map((remote) =>
      remote.startsWith(fixturePrefix)
        ? remote.slice(fixturePrefix.length)
        : remote
    );
    const otherController = profile.worksControllerTargets
      ? PRIVATE_CONTROLLER
      : PUBLIC_CONTROLLER;
    const leaked = [...urls, ...remoteNames, ...composed].filter((value) =>
      value.includes(otherController)
    );
    assert.deepEqual(leaked, [], [...urls, ...remotes].join("\n"));
    const expectedTargets = profile.worksControllerTargets
      ? [PUBLIC_CONTROLLER, target]
      : [target];
    assert.deepEqual([...new Set(composed)].sort(), expectedTargets.sort());
  } finally {
    await r.cleanup();
  }
}

Deno.test("an owner issue goes from intake to a reviewed merge", () =>
  issueToMerge(DIRECT_TARGETS));

Deno.test("maintenance recovers a late cell for publication, native review and merge", () =>
  issueToMerge(LATE_TARGETS, true));

Deno.test("the planner applies the deployment's cell ceiling", async () => {
  const r = await rig();
  const seen = {
    urls: [] as string[],
    composed: [] as string[],
    remotes: [] as string[],
  };
  try {
    const port = lifecyclePort(r, DIRECT_TARGETS[profile.targetVisibility]);
    const rows = [1, 2, 3, 4, 5, 6, 7].map(issue);
    port.listOpenIssues = () => Promise.resolve(portOk(rows));
    port.readIssue = (number) =>
      Promise.resolve(portOk(rows[number - 1] ?? null));
    const expectedGrants = Math.min(
      rows.length,
      profile.cycleCells?.matrix ?? MAX_MATRIX_CELLS,
    );
    const readyUnplanned = rows.length - expectedGrants;
    const deps = await lifecycleJobs(r, seen, DIRECT_TARGETS)(
      "plan",
      "matrix_plan",
    );
    const { value: planner } = await quietly(() =>
      runActionsMatrixHost({
        ...deps,
        model: {
          modelId: "gpt-reserve",
          runModel: () => {
            throw Error("planner must not run a model");
          },
        },
      })
    );
    assert.ok("plan" in planner, JSON.stringify(planner));
    assert.equal(planner.prepared, expectedGrants);
    assert.equal(planner.plan.cells.length, expectedGrants);
    assert.deepEqual(planner.refusal, { reason: null, readyUnplanned });
    const state = await r.store.readRepair();
    assert.ok(state.ok && state.value.status === "found");
    const plannedIds = new Set(planner.plan.cells.map((cell) => cell.taskId));
    assert.equal(plannedIds.size, expectedGrants);
    const granted = state.value.snapshot.reservations.filter((row) =>
      row.purpose === "implementation"
    );
    assert.equal(granted.length, expectedGrants);
    assert.deepEqual(new Set(granted.map((row) => row.taskId)), plannedIds);
    const waiting = state.value.snapshot.work.filter((row) =>
      !plannedIds.has(row.id)
    );
    assert.deepEqual(
      waiting.map((row) => row.related.issueNumber),
      rows.slice(expectedGrants).map((row) => row.number),
    );
    for (const row of waiting) {
      assert.equal(row.nextStep, "work");
      assert.equal(row.intent, null);
      assert.equal(row.counters.attempts, 0);
    }
  } finally {
    await r.cleanup();
  }
});
