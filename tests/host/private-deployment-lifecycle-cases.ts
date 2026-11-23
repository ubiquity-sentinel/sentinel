/**
 * Private-role issue lifecycle. Runs ONLY inside a tree copy whose committed
 * private entry is bound and wired, under GITHUB_REPOSITORY of the private
 * repository (`private-deployment-lifecycle_test.ts` builds that copy and runs
 * this file).
 *
 * One private target (`ubiquity/auth.ubq.fi`) goes through the real hosted
 * consumers of the private deployment: the matrix planner takes its open
 * owner issue (intake), one isolated cell implements it with a fake model
 * port over the target's real Git mirror (implementation), the aggregate
 * publishes the candidate pull request and requests native review
 * (publication, review request), observes the completed review with no P0
 * and merges it. Every HTTP request is recorded, the state remote and the
 * target remote are temporary Git directories, and no request, remote or
 * composed GitHub surface names the public deployment's repository.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_CONTROLLER_REMOTE,
  HOSTED_CONTROLLER_REPOSITORY,
  HOSTED_CONTROLLER_ROLE,
} from "../../src/contracts/hosted-controller-deployment.ts";
import type {
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { PUBLIC_TARGET_REASON } from "../../src/repair/target-visibility.ts";
import { PRIVATE_TARGETS_KIND } from "../../src/repair/private-targets-line.ts";
import { scanStepLines } from "../../src/repair/step-line.ts";
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

const PRIVATE = "ubiquity-sentinel-private/sentinel";
// Built, never written whole, so no fixture rewrite can touch it.
const PUBLIC = ["ubiquity-sentinel", "sentinel"].join("/");
const TARGET = "ubiquity/auth.ubq.fi";
const SELF_INSTALLATION = "183425201";
const PRIVATE_BODY =
  '{"default_branch":"development","private":true,"visibility":"private"}';
const PUBLIC_BODY =
  '{"default_branch":"development","private":false,"visibility":"public"}';
// The committed setting of the private deployment lists private targets
// only; the public Sentinel and a public target listed beside them stay with
// the public deployment and are never read.
const SETTING = JSON.stringify([TARGET, PUBLIC, "ubiquity/ai.ubq.fi"]);

/** GitHub as the private deployment sees it; every request is recorded. */
function privateGithub(urls: string[]): HttpTransportV1 {
  const bodies: Record<string, string> = {
    [`/repos/${PRIVATE}`]: PRIVATE_BODY,
    [`/repos/${TARGET}`]: PRIVATE_BODY,
    "/repos/ubiquity/ai.ubq.fi": PUBLIC_BODY,
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
      (path === `/repos/${TARGET}/rules/branches/development` ||
        path === "/repos/ubiquity/ai.ubq.fi/rules/branches/development")
    ) return Promise.resolve(response([]));
    if (
      request.method === "POST" && path === "/graphql" &&
      request.body?.includes("mergeQueue(branch:")
    ) return Promise.resolve(response(snapshotWire(null)));
    return Promise.reject(new Error(`no other request: ${request.url}`));
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** The rig's only target surface: `slug`, with a real review lifecycle. */
function privatePort(r: Rig, slug: string): TargetGithub {
  const port = new TargetGithub({
    baseSha: r.foreignSha,
    candidateLifecycle: {
      preserveCandidate: () => Promise.resolve(portOk(undefined)),
    },
  });
  port.reviewStatus = "pending";
  port.prepareBaseRefresh = () =>
    Promise.reject(new Error("unchanged fixture base must not refresh"));
  r.github.clear();
  r.github.set(slug, port);
  return port;
}

/** Jobs of the current run as the private deployment, on its own setting. */
function privateJobs(
  r: Rig,
  seen: { urls: string[]; composed: string[]; remotes: string[] },
  setting = SETTING,
) {
  return async (name: string, role: string) => {
    const deps = await r.job(name, role);
    assert.equal(deps.env.GITHUB_REPOSITORY, PRIVATE);
    await Deno.writeTextFile(`${deps.workDir}/sentinel.targets.json`, setting);
    seen.remotes.push(deps.stateRemoteUrl);
    return {
      ...deps,
      env: { ...deps.env, SENTINEL_SELF_INSTALLATION_ID: SELF_INSTALLATION },
      // The production resolvers read the host and the target over `http`.
      resolveRepository: undefined,
      http: servingJobLogs(
        privateGithub(seen.urls),
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

Deno.test("private role: a private target's owner issue goes from intake to a reviewed merge without naming the public repository", async () => {
  assert.equal(HOSTED_CONTROLLER_ROLE, "private");
  assert.equal(HOSTED_CONTROLLER_REPOSITORY, PRIVATE);
  assert.equal(HOSTED_CONTROLLER_REMOTE, `https://github.com/${PRIVATE}.git`);
  const r = await rig();
  const urls: string[] = [];
  const composed: string[] = [];
  const remotes: string[] = [];
  try {
    const port = privatePort(r, TARGET);
    const job = privateJobs(r, { urls, composed, remotes });

    // Intake: the planner admits the private target's owner issue.
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
      [TARGET],
    );
    assert.deepEqual(
      scanStepLines(planned.lines.join("\n")).filter((entry) =>
        entry.kind === PRIVATE_TARGETS_KIND
      ).map((entry) => (entry as { reason?: string }).reason),
      [PUBLIC_TARGET_REASON],
    );

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
          TARGET,
        );
        const source = deps.workDir +
          "/.sentinel-actions-state/sources/ubiquity-auth.ubq.fi";
        remotes.push(
          await checked(source, ["remote", "get-url", "origin"], r.env),
        );
        await Deno.writeTextFile(source + "/repair.txt", "private repair\n");
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

    // Publication and review request: the aggregate of the same run.
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
              {
                pollWait: (ms) => {
                  r.clock.advance(ms);
                  return Promise.resolve();
                },
              },
            ),
        })
      );
    const published = await aggregate(await job("aggregate", "repair"), {
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
    });
    assert.equal(published.value.status, "ran", JSON.stringify(published));
    assert.equal(port.candidatePullRequests.size, 1);
    const pull = [...port.candidatePullRequests.values()][0]!;
    assert.equal(pull.state, "open");
    assert.ok(port.calls.includes("createPr"), port.calls.join("\n"));
    assert.ok(port.calls.includes("requestReview"), port.calls.join("\n"));
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
    await advanceWithLog(r, 72, QUIET_LOG, 101);
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
      `${row.repository.owner}/${row.repository.name}` === TARGET
    );
    assert.equal(work.length, 1, JSON.stringify(after.value.snapshot.work));

    // Nothing named the public deployment: no request, remote or surface.
    assert.ok(urls.length > 0);
    assert.ok(urls.some((url) => url.endsWith(`/repos/${PRIVATE}`)));
    const leaked = [...urls, ...remotes, ...composed].filter((value) =>
      value.includes(PUBLIC)
    );
    assert.deepEqual(leaked, [], [...urls, ...remotes].join("\n"));
    assert.deepEqual([...new Set(composed)], [TARGET]);
  } finally {
    await r.cleanup();
  }
});

Deno.test("private role: one planner pass grants at most one implementation cell (free tier)", async () => {
  assert.equal(HOSTED_CONTROLLER_ROLE, "private");
  const r = await rig();
  const seen = {
    urls: [] as string[],
    composed: [] as string[],
    remotes: [] as string[],
  };
  try {
    const port = privatePort(r, TARGET);
    const rows = [1, 2, 3].map(issue);
    port.listOpenIssues = () => Promise.resolve(portOk(rows));
    port.readIssue = (number) =>
      Promise.resolve(portOk(rows[number - 1] ?? null));
    const deps = await privateJobs(r, seen)("plan", "matrix_plan");
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
    // Three ready owner issues; the private role's ceiling grants one.
    assert.equal(planner.prepared, 1);
    assert.equal(planner.plan.cells.length, 1);
    const state = await r.store.readRepair();
    assert.ok(state.ok && state.value.status === "found");
    assert.equal(
      state.value.snapshot.reservations.filter((row) =>
        row.purpose === "implementation"
      ).length,
      1,
    );
  } finally {
    await r.cleanup();
  }
});
