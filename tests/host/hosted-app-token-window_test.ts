/** The repair child never plans GitHub work past its one App token's life. */
import assert from "node:assert/strict";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  childRunDeadlineV1,
  runActionsRepairHost,
  runActionsTargetCycles,
} from "../../src/host/actions.ts";
import {
  createLocalRepositoryConfig,
  unavailableIncidents,
  unavailableReplay,
} from "../../src/host/local.ts";
import { GIT_TIMEOUT_MS } from "../../src/host/local-policy.ts";
import { OPERATION_MARGIN_MS } from "../../src/repair/loop-bounds.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { makeRemoteCtx, T0, testGitEnv } from "../state/helpers.ts";
import {
  APP_TOKEN,
  FakeClock,
  FIXED_LAUNCHER,
  hostedEnv,
  makeCheckout,
  ROOT,
  RUN_ATTEMPT,
  RUN_ID,
} from "./hosted-runtime-fixture.ts";

interface WiringV1 {
  /** The deadline the host handed to its production target-cycle call. */
  supplied: number | null;
  /** The deadline each real per-target cycle received. */
  cycleDeadlines: number[];
  /** The early advisory run window. */
  window: Record<string, unknown> | null;
  setup: string[];
  queueReads: number;
  unexpectedHttp: number;
  error: unknown;
}

/**
 * Run the REAL `runActionsRepairHost` over one local fixture checkout and one
 * local bare state remote, faking only external boundaries (self refresh,
 * default branch, Codex preflight and the per-target cycle). No GitHub, model
 * or network request is made.
 */
async function runWiring(extraEnv: Record<string, string>): Promise<WiringV1> {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-app-token-window-",
    dir: ROOT,
  });
  const env = testGitEnv(`${root}/git-home`);
  await Deno.mkdir(`${root}/git-home`, { recursive: true });
  try {
    const checkoutDir = `${root}/checkout`;
    const checkoutSha = await makeCheckout(checkoutDir, env, {
      "sentinel.targets.json": JSON.stringify(["ubiquity-sentinel/sentinel"]),
      ".gitignore": ".sentinel-actions-state/\n",
    });
    const bin = `${root}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(`${bin}/codex`, "");
    const remote = await makeRemoteCtx(root, env);
    await Deno.mkdir(`${root}/release-scratch`, { recursive: true });
    const release = createReleaseStateStore({
      scratchDir: `${root}/release-scratch`,
      remoteUrl: remote.remoteUrl,
    });
    const execution = parseHostedExecutionIntentV1({
      id: `${RUN_ID}:${RUN_ATTEMPT}:repair`,
      runId: RUN_ID,
      runAttempt: RUN_ATTEMPT,
      launcherSha: checkoutSha,
      purpose: "ordinary",
      revision: checkoutSha,
      generation: 1,
      releaseId: null,
      createdAt: T0,
    });
    const seeded = await release.writeRelease(
      parseReleaseStateSnapshotV1({
        version: "v1",
        kind: "release_state_snapshot",
        stateHead: null,
        sequence: 1,
        updatedAt: T0,
        releases: [],
        hostedRuntimes: [{
          version: "v1",
          kind: "hosted_runtime",
          id: HOSTED_RUNTIME_ID,
          activeRevision: checkoutSha,
          generation: 1,
          lastHealthyProof: null,
          lastExecutionProof: null,
          nextOrdinaryAt: T0,
          execution,
          createdAt: T0,
          updatedAt: T0,
        }],
        hostedReleases: [],
        githubCooldowns: [],
      }),
      null,
    );
    assert.ok(
      seeded.ok && seeded.value.status === "applied",
      JSON.stringify(seeded),
    );

    const clock = new FakeClock(T0);
    const wiring: WiringV1 = {
      supplied: null,
      cycleDeadlines: [],
      window: null,
      setup: [],
      queueReads: 0,
      unexpectedHttp: 0,
      error: null,
    };
    const capability = {} as never;
    const stdout: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      stdout.push(args.map((value) => String(value)).join(" "));
    };
    try {
      await runActionsRepairHost({
        clock,
        env: {
          ...hostedEnv(checkoutSha),
          PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
          ...extraEnv,
        },
        workDir: checkoutDir,
        stateRemoteUrl: remote.remoteUrl,
        http: (request) => {
          const url = new URL(request.url);
          if (
            request.method === "GET" &&
            url.origin === "https://api.github.com" &&
            url.pathname ===
              "/repos/ubiquity/ai.ubq.fi/rules/branches/development"
          ) {
            wiring.queueReads++;
            return Promise.resolve({
              status: 200,
              headers: new Headers(),
              bodyText: "[]",
            });
          }
          wiring.unexpectedHttp++;
          throw new Error("fixture forbids other HTTP");
        },
        refreshSelf: () => {
          wiring.setup.push("refresh-self");
          clock.advance(4 * 60_000);
          return Promise.resolve(checkoutSha);
        },
        resolveDefaultBranch: () => Promise.resolve("development"),
        preflight: () => {
          wiring.setup.push("preflight");
          return Promise.resolve();
        },
        runTargetCycles: (input) => {
          wiring.setup.push("target-cycles");
          wiring.supplied = input.deadline;
          return runActionsTargetCycles({
            ...input,
            composeGithub: () => capability,
            runCycle: (_deps, options) => {
              wiring.cycleDeadlines.push(options.deadline);
              return Promise.resolve({ status: "idle", detail: "fixture" });
            },
          });
        },
      });
    } catch (error) {
      wiring.error = error;
    } finally {
      console.log = originalLog;
    }
    const line = stdout.find((text) => text.includes('"sentinel_run_window"'));
    wiring.window = line === undefined
      ? null
      : JSON.parse(line) as Record<string, unknown>;
    return wiring;
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
}

Deno.test("hosted app token window: the real repair host stops its GitHub work before its App token can expire", async () => {
  // The defect: the repair job mints ONE installation token (valid one hour)
  // and then plans GitHub work for 110 minutes, so every late write and own
  // pull-request read failed `auth_failed` (live: ai.ubq.fi 641 and 653 were
  // terminally blocked after three such reads). The trusted launcher now
  // forwards the instant before which that token is certainly valid.
  const notAfter = T0 + 50 * 60_000;
  assert.ok(notAfter < childRunDeadlineV1(T0));
  const bounded = await runWiring({
    SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN,
    SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER: String(notAfter),
  });
  assert.equal(bounded.error, null, String(bounded.error));
  assert.equal(bounded.queueReads, 1);
  assert.equal(bounded.unexpectedHttp, 0);
  assert.deepEqual(bounded.setup, [
    "refresh-self",
    "preflight",
    "target-cycles",
  ]);
  // The ONE absolute deadline, captured at the run origin, is the earlier of
  // the unchanged 110-minute budget and the token window, and it is what the
  // run announces and every real target cycle receives.
  assert.equal(bounded.supplied, notAfter);
  assert.deepEqual(bounded.cycleDeadlines, [notAfter]);
  assert.equal(bounded.window?.originAt, T0);
  assert.equal(bounded.window?.deadlineAt, notAfter);

  // A window later than the child's own budget never extends that budget.
  const late = await runWiring({
    SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN,
    SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER: String(T0 + 200 * 60_000),
  });
  assert.equal(late.error, null, String(late.error));
  assert.equal(late.queueReads, 1);
  assert.equal(late.unexpectedHttp, 0);
  assert.equal(late.supplied, childRunDeadlineV1(T0));
  assert.equal(late.window?.deadlineAt, childRunDeadlineV1(T0));

  // No forwarded window (an older launcher, or no App token) keeps the
  // unchanged origin-anchored budget exactly.
  const legacy = await runWiring({ SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN });
  assert.equal(legacy.error, null, String(legacy.error));
  assert.equal(legacy.queueReads, 1);
  assert.equal(legacy.unexpectedHttp, 0);
  assert.equal(legacy.supplied, childRunDeadlineV1(T0));
});

Deno.test("hosted app token window: a malformed forwarded window refuses before any setup", async () => {
  for (const malformed of ["soon", "1.5", "-1", "0", "1e12", "9".repeat(17)]) {
    const refused = await runWiring({
      SENTINEL_SUPERVISOR_TOKEN: APP_TOKEN,
      SENTINEL_SUPERVISOR_TOKEN_NOT_AFTER: malformed,
    });
    assert.ok(refused.error instanceof Error, malformed);
    assert.deepEqual(refused.setup, [], malformed);
    assert.equal(refused.queueReads, 0, malformed);
    assert.equal(refused.unexpectedHttp, 0, malformed);
    assert.equal(refused.supplied, null, malformed);
    assert.equal(refused.window, null, malformed);
  }
});

/**
 * Two serial targets under one App-token-bounded deadline. The first target's
 * cycle ends `remaining` before the deadline (its mandatory review drain may
 * run that far); every foreign preparation is an authenticated clone or fetch
 * that may spend Git's full 120-second timeout.
 */
async function runLaterTarget(deadline: number, remaining: number) {
  const self = createLocalRepositoryConfig();
  const foreign: RepositoryConfigV1 = {
    ...self,
    repository: { ...self.repository, name: "foreign-target" },
  };
  const slugOf = (config: RepositoryConfigV1): string =>
    `${config.repository.owner}/${config.repository.name}`;
  const capability = {} as never;
  const clock = new FakeClock(T0);
  const prepared: { slug: string; at: number; until: number }[] = [];
  const cycles: string[] = [];
  const result = await runActionsTargetCycles({
    clock,
    state: capability,
    configs: [self, foreign],
    controllerSha: FIXED_LAUNCHER,
    githubCooldown: capability,
    incidents: unavailableIncidents,
    replay: unavailableReplay,
    model: capability,
    budget: capability,
    deadline,
    stepLimit: 16,
    modelStartsEnabled: true,
    composeGithub: () => capability,
    prepareTarget: (config) => {
      const at = clock.now();
      if (slugOf(config) !== "ubiquity-sentinel/sentinel") {
        clock.advance(GIT_TIMEOUT_MS);
      }
      prepared.push({ slug: slugOf(config), at, until: clock.now() });
      return Promise.resolve();
    },
    runCycle: (deps) => {
      const slug = slugOf(deps.configs[0]!);
      cycles.push(slug);
      if (slug === "ubiquity-sentinel/sentinel") {
        clock.advance(deadline - clock.now() - remaining);
      }
      return Promise.resolve({ status: "idle", detail: slug });
    },
  });
  return { prepared, cycles, result };
}

Deno.test("hosted app token window: a later target is never prepared inside the final operation margin", async () => {
  // The token is certainly valid until the deadline and expires no earlier
  // than two minutes after it. A later target's preparation begun just before
  // the deadline could hold an authenticated fetch for Git's full 120-second
  // timeout, ending exactly at that earliest possible expiry.
  const notAfter = T0 + 50 * 60_000;
  const deadline = childRunDeadlineV1(T0, notAfter);
  assert.equal(deadline, notAfter);

  const late = await runLaterTarget(deadline, OPERATION_MARGIN_MS - 1_000);
  assert.deepEqual(late.prepared.map((entry) => entry.slug), [
    "ubiquity-sentinel/sentinel",
  ]);
  assert.deepEqual(late.cycles, ["ubiquity-sentinel/sentinel"]);
  assert.deepEqual(late.result.addressed, ["ubiquity-sentinel/sentinel"]);
  assert.deepEqual(late.result.skipped, ["ubiquity-sentinel/foreign-target"]);
  assert.deepEqual(late.result.failed, []);
  assert.deepEqual(late.result.outcome, {
    status: "idle",
    detail: "ubiquity-sentinel/sentinel",
  });

  // Control: with the whole margin left the later target is still prepared,
  // and even a full Git timeout ends minutes before the deadline.
  const inside = await runLaterTarget(deadline, OPERATION_MARGIN_MS);
  assert.deepEqual(inside.prepared.map((entry) => entry.slug), [
    "ubiquity-sentinel/sentinel",
    "ubiquity-sentinel/foreign-target",
  ]);
  for (const entry of inside.prepared) {
    assert.ok(entry.until <= deadline - (OPERATION_MARGIN_MS - GIT_TIMEOUT_MS));
  }
  assert.deepEqual(inside.cycles, [
    "ubiquity-sentinel/sentinel",
    "ubiquity-sentinel/foreign-target",
  ]);
  assert.deepEqual(inside.result.skipped, []);
});

Deno.test("hosted app token window: the first target is still addressed when setup left less than the margin", async () => {
  // No earlier cycle produced an outcome yet, so the first target keeps the
  // existing rule (prepared while the deadline lies ahead): a run whose setup
  // spent most of its token window still reports an outcome instead of
  // failing for having addressed no target.
  const deadline = childRunDeadlineV1(T0, T0 + 60_000);
  const self = createLocalRepositoryConfig();
  const clock = new FakeClock(T0);
  const prepared: string[] = [];
  const result = await runActionsTargetCycles({
    clock,
    state: {} as never,
    configs: [self],
    controllerSha: FIXED_LAUNCHER,
    githubCooldown: {} as never,
    incidents: unavailableIncidents,
    replay: unavailableReplay,
    model: {} as never,
    budget: {} as never,
    deadline,
    stepLimit: 16,
    modelStartsEnabled: true,
    composeGithub: () => ({}) as never,
    prepareTarget: (config) => {
      prepared.push(config.repository.name);
      return Promise.resolve();
    },
    runCycle: () => Promise.resolve({ status: "idle", detail: "first" }),
  });
  assert.deepEqual(prepared, ["sentinel"]);
  assert.deepEqual(result.addressed, ["ubiquity-sentinel/sentinel"]);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.outcome, { status: "idle", detail: "first" });
});
