import assert from "node:assert/strict";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { principalNativeFixture } from "./hosted-app-principal-fixtures.ts";
import { DORMANT_HOSTED_POLICIES } from "./actions-supervisor-fixture.ts";
import {
  attemptBody,
  FakeGate,
  OBSERVED,
} from "../github/hosted-execution-helpers.ts";
import {
  PRIVATE_CI_ID,
  PRIVATE_REPOSITORY,
  PRIVATE_SUPERVISOR_ID,
  privateControllerFixture,
} from "./hosted-controller-deployment-fixture.ts";

const reply = (body: unknown, status = 200) => ({
  status,
  headers: new Headers(),
  bodyText: JSON.stringify(body),
});

Deno.test("controller deployment: private committed source owns bootstrap, native proof, CI, mint and dispatch", async (t) => {
  const fixture = await privateControllerFixture();
  try {
    const { load } = fixture;
    const identity = await load<
      typeof import("../../src/host/hosted-runtime.ts")
    >("src/host/hosted-runtime.ts");
    const controller = await load<
      typeof import("../../src/host/actions-supervisor-controller.ts")
    >("src/host/actions-supervisor-controller.ts");
    const contracts = await load<
      typeof import("../../src/contracts/hosted-supervisor.ts")
    >("src/contracts/hosted-supervisor.ts");
    const binding = await load<
      typeof import("../../src/contracts/hosted-controller-deployment.ts")
    >("src/contracts/hosted-controller-deployment.ts");
    const workflowRef =
      `${PRIVATE_REPOSITORY}/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor`;
    const env = {
      GITHUB_REPOSITORY: PRIVATE_REPOSITORY,
      GITHUB_REF: "refs/heads/sentinel-supervisor",
      GITHUB_WORKFLOW_REF: workflowRef,
      GITHUB_SHA: fixture.head,
      GITHUB_WORKFLOW_SHA: fixture.head,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "prepare",
    };
    await t.step(
      "actual private Git/state boots generation1 and refuses public source identity",
      async () => {
        const state = await load<typeof import("../../src/state/mod.ts")>(
          "src/state/mod.ts",
        );
        const bootstrap = await load<
          typeof import("../../src/host/actions-supervisor-bootstrap.ts")
        >("src/host/actions-supervisor-bootstrap.ts");
        const store = state.createReleaseStateStore({
          scratchDir: fixture.root + "/release-scratch",
          remoteUrl: fixture.remote,
        });
        const clock = { now: () => OBSERVED };
        assert.equal(
          (await bootstrap.ensureHostedReleaseState(store, clock.now())).status,
          "seeded",
        );
        const native = identity.parseHostedEnvironment(env, "prepare");
        assert.equal(
          await identity.readCleanGitHead(
            new DenoReplayRuntime(Deno.execPath()),
            fixture.checkout,
          ),
          native.launcherSha,
        );
        assert.throws(() =>
          identity.parseHostedEnvironment({
            ...env,
            GITHUB_REPOSITORY: "ubiquity-sentinel/sentinel",
          }, "prepare")
        );
        assert.throws(() =>
          identity.parseHostedEnvironment({
            ...env,
            GITHUB_WORKFLOW_REF: workflowRef.replace(
              PRIVATE_REPOSITORY,
              "ubiquity-sentinel/sentinel",
            ),
          }, "prepare")
        );
        const { HostedSupervisorGitHubClient } = await load<
          typeof import("../../src/host/actions-supervisor-install-api.ts")
        >("src/host/actions-supervisor-install-api.ts");
        const paths: string[] = [];
        const client = new HostedSupervisorGitHubClient({
          repository: {
            owner: "ubiquity-sentinel",
            name: "sentinel-controller-fixture",
            installationId: 0,
          },
          apiBaseUrl: "https://api.github.com",
          clock,
          cooldownGate: new FakeGate(),
          auth: {
            authorizationHeader: () =>
              Promise.resolve({ ok: true, value: "Bearer synthetic" }),
          },
          http: (request) => {
            const path = new URL(request.url).pathname;
            paths.push(path);
            assert(path.startsWith(`/repos/${PRIVATE_REPOSITORY}/`));
            return Promise.resolve(reply({
              status: "identical",
              base_commit: { sha: fixture.head },
              merge_base_commit: { sha: fixture.head },
              ahead_by: 0,
              behind_by: 0,
              total_commits: 0,
            }));
          },
        });
        const core: Parameters<
          typeof controller.runHostedSupervisorPrepare
        >[0] = {
          ...DORMANT_HOSTED_POLICIES,
          state: store,
          clock,
          run: native,
          evidence: {
            verifyRevision: client.verifyHostedRevision.bind(client),
            readExecution: () => Promise.resolve({ ok: true, value: null }),
            verifyRequest: () => Promise.resolve({ ok: true, value: false }),
            readIssueTask: () => Promise.resolve({ ok: true, value: null }),
          },
        };
        const result = await controller.runHostedSupervisorPrepare(core);
        assert.equal(result.status, "run");
        assert(result.status === "run");
        assert.equal(result.execution.purpose, "bootstrap");
        assert.equal(result.execution.generation, 1);
        const saved = await store.readRelease();
        assert(saved.ok && saved.value.status === "found");
        assert.equal(
          saved.value.snapshot.hostedRuntimes[0].id,
          `${PRIVATE_REPOSITORY}:0:production`,
        );
        assert.equal(
          saved.value.snapshot.hostedRuntimes[0].lastHealthyProof,
          null,
        );
        assert(paths.length > 0);
        const publicProof = {
          execution: result.execution,
          workflowId: 357012162,
          workflowPath: ".github/workflows/supervisor.yml",
          repository: "ubiquity-sentinel/sentinel",
          ref: env.GITHUB_REF,
          jobId: 7,
          startedAt: OBSERVED + 1,
          finishedAt: OBSERVED + 2,
          observedAt: OBSERVED + 3,
          outcome: "healthy",
          startupReady: true,
          settled: true,
          baseSha: fixture.head,
          terminalAt: OBSERVED + 1,
          logDigest: "a".repeat(64),
        };
        assert.throws(() => contracts.parseHostedRunProofV1(publicProof));
        assert.throws(() =>
          contracts.parseHostedRunProofV1({
            ...publicProof,
            repository: PRIVATE_REPOSITORY,
          })
        );
        const privateProof = contracts.parseHostedRunProofV1({
          ...publicProof,
          repository: PRIVATE_REPOSITORY,
          workflowId: PRIVATE_SUPERVISOR_ID,
        });
        assert.equal(privateProof.outcome, "healthy");
        const finalized = await controller.runHostedSupervisorFinalize({
          ...core,
          clock: { now: () => OBSERVED + 5 },
          evidence: {
            ...core.evidence,
            readExecution: () =>
              Promise.resolve({ ok: true, value: privateProof }),
            confirmCompletedExecution: () => Promise.resolve(true),
          },
        });
        assert.equal(finalized.status, "idle");
        const healthy = await store.readRelease();
        assert(healthy.ok && healthy.value.status === "found");
        const runtime = healthy.value.snapshot.hostedRuntimes[0];
        assert.equal(runtime.lastHealthyProof?.repository, PRIVATE_REPOSITORY);
        const ordinary = await controller.runHostedSupervisorPrepare({
          ...core,
          run: { ...native, runId: 2 },
          clock: { now: () => Math.max(OBSERVED + 5, runtime.nextOrdinaryAt) },
          evidence: {
            ...core.evidence,
            verifyMatrixOrdinaryRevision: () =>
              Promise.resolve({ ok: true, value: true }),
          },
        });
        assert(ordinary.status === "run");
        assert.equal(ordinary.execution.purpose, "ordinary");
        const maintenance = {
          repository: PRIVATE_REPOSITORY,
          ref: env.GITHUB_REF,
          job: "maintenance",
          runId: "1",
          runAttempt: "1",
          workflowRef,
          sha: fixture.head,
          workflowSha: fixture.head,
          checkoutHead: fixture.head,
          checkoutClean: true,
        };
        assert(binding.isHostedControllerMaintenanceIdentity(maintenance));
        assert(
          !binding.isHostedControllerMaintenanceIdentity({
            ...maintenance,
            repository: "ubiquity-sentinel/sentinel",
          }),
        );
        assert(
          !binding.isHostedControllerMaintenanceIdentity({
            ...maintenance,
            checkoutClean: false,
          }),
        );
      },
    );
    await t.step(
      "private installation records its synthetic healthy prior and rolls back exactly",
      async () => {
        const installed = await load<
          typeof import("./hosted-self-install-fixtures.ts")
        >("tests/host/hosted-self-install-fixtures.ts");
        const proofs = await load<
          typeof import("./actions-supervisor-fixture.ts")
        >("tests/host/actions-supervisor-fixture.ts");
        const rig = await installed.liveInstallRig();
        try {
          const repairBefore = await rig.repair.readRepair();
          const candidate = await rig.prepare(1);
          assert(candidate.status === "run");
          assert.equal(candidate.execution.purpose, "bootstrap");
          assert.equal(candidate.execution.revision, installed.SUCCESSOR);
          assert.equal(candidate.execution.generation, 83);
          const journal = (await rig.snapshot()).hostedInstallations![0];
          assert.equal(journal.previousRevision, installed.LEGACY_RUNTIME);
          assert.equal(
            journal.previousHealthyProof?.repository,
            PRIVATE_REPOSITORY,
          );
          rig.clock.advance(5_000);
          rig.evidence.settlements.set(
            candidate.execution.id,
            proofs.startedFailureProof(candidate.execution),
          );
          const rollback = await rig.prepare(2);
          assert(rollback.status === "run");
          assert.equal(rollback.execution.revision, installed.LEGACY_RUNTIME);
          assert.equal(rollback.execution.generation, 84);
          const rolling = (await rig.snapshot()).hostedInstallations![0];
          assert.equal(rolling.phase, "rollback_verifying");
          assert.equal(rolling.previousRevision, journal.previousRevision);
          assert.deepEqual(
            rolling.previousHealthyProof,
            journal.previousHealthyProof,
          );
          rig.clock.advance(5_000);
          rig.evidence.settlements.set(
            rollback.execution.id,
            proofs.runProof(rollback.execution, "healthy"),
          );
          await rig.prepare(3);
          const settled = await rig.snapshot();
          assert.equal(settled.hostedInstallations![0].phase, "rolled_back");
          assert.equal(
            settled.hostedRuntimes[0].activeRevision,
            installed.LEGACY_RUNTIME,
          );
          assert.equal(settled.hostedRuntimes[0].generation, 84);
          assert.equal(
            settled.hostedRuntimes[0].lastHealthyProof?.repository,
            PRIVATE_REPOSITORY,
          );
          assert.deepEqual(await rig.repair.readRepair(), repairBefore);
        } finally {
          await rig.close();
        }
      },
    );
    await t.step(
      "native mint reads and validates only private controller attempts",
      async () => {
        const native = await load<
          typeof import("../../src/host/hosted-app-principal-native.ts")
        >("src/host/hosted-app-principal-native.ts");
        const rig = principalNativeFixture();
        const reads: string[] = [];
        const transport: HttpTransportV1 = (request) => {
          reads.push(request.url);
          assert(
            new URL(request.url).pathname.startsWith(
              `/repos/${PRIVATE_REPOSITORY}/`,
            ),
          );
          return rig.jobInput.http(request);
        };
        rig.model.attempt = attemptBody({
          repo: PRIVATE_REPOSITORY,
          workflowId: PRIVATE_SUPERVISOR_ID,
          status: "in_progress",
          conclusion: null,
        });
        assert(
          (await native.readHostedAppNativeJob({
            ...rig.jobInput,
            http: transport,
          })).ok,
        );
        for (
          const patch of [{
            repo: "ubiquity-sentinel/sentinel",
            workflowId: PRIVATE_SUPERVISOR_ID,
          }, { repo: PRIVATE_REPOSITORY, workflowId: 357012162 }]
        ) {
          rig.model.attempt = attemptBody({
            ...patch,
            status: "in_progress",
            conclusion: null,
          });
          assert.equal(
            (await native.readHostedAppNativeJob({
              ...rig.jobInput,
              http: transport,
            })).ok,
            false,
          );
        }
        assert(reads.length > 0);
      },
    );
    await t.step(
      "private launcher CI requires its own scope and exact successful candidate",
      async () => {
        const { HostedSupervisorGitHubClient } = await load<
          typeof import("../../src/host/actions-supervisor-install-api.ts")
        >("src/host/actions-supervisor-install-api.ts");
        const revision =
          identity.parseHostedEnvironment(env, "prepare").launcherSha;
        let head = fixture.head;
        let app = "github-actions";
        let reads = 0;
        const options = {
          repository: {
            owner: "ubiquity-sentinel",
            name: "sentinel-controller-fixture",
            installationId: 0,
          },
          apiBaseUrl: "https://api.github.com",
          clock: { now: () => OBSERVED },
          cooldownGate: new FakeGate(),
          auth: {
            authorizationHeader: () =>
              Promise.resolve({ ok: true as const, value: "Bearer synthetic" }),
          },
          http: ((request) => {
            reads++;
            assert.equal(
              new URL(request.url).pathname,
              `/repos/${PRIVATE_REPOSITORY}/commits/${revision}/check-runs`,
            );
            return Promise.resolve(
              reply({
                total_count: 1,
                check_runs: [{
                  id: 17,
                  name: "test-local",
                  head_sha: head,
                  status: "completed",
                  conclusion: "success",
                  app: { slug: app },
                }],
              }),
            );
          }) satisfies HttpTransportV1,
        };
        const client = new HostedSupervisorGitHubClient(options);
        assert.deepEqual(await client.verifyLauncherCi(revision), {
          ok: true,
          value: { revision, checkRunId: 17 },
        });
        head = "0".repeat(40);
        assert.deepEqual(await client.verifyLauncherCi(revision), {
          ok: true,
          value: null,
        });
        head = fixture.head;
        app = "foreign-app";
        assert.deepEqual(await client.verifyLauncherCi(revision), {
          ok: true,
          value: null,
        });
        const foreign = new HostedSupervisorGitHubClient({
          ...options,
          repository: {
            owner: "ubiquity",
            name: "sentinel",
            installationId: 0,
          },
        });
        const before = reads;
        assert.equal((await foreign.verifyLauncherCi(revision)).ok, false);
        assert.equal(reads, before);
      },
    );
    await t.step(
      "follow requires private CI workflow and rejects public or foreign repository proofs",
      async () => {
        const { HostedRuntimeFollowApi } = await load<
          typeof import("../../src/host/hosted-runtime-follow-api.ts")
        >("src/host/hosted-runtime-follow-api.ts");
        const { readFollowCi } = await load<
          typeof import("../../src/host/hosted-runtime-follow-ci.ts")
        >("src/host/hosted-runtime-follow-ci.ts");
        let workflowId = PRIVATE_CI_ID;
        let repository = PRIVATE_REPOSITORY;
        const run = {
          id: 12,
          run_attempt: 1,
          path: ".github/workflows/ci.yml",
          event: "push",
          head_branch: "development",
          head_sha: fixture.head,
          status: "completed",
          conclusion: "success",
        };
        const paths: string[] = [];
        const http: HttpTransportV1 = (request) => {
          const path = new URL(request.url).pathname;
          paths.push(path);
          assert(path.startsWith(`/repos/${PRIVATE_REPOSITORY}/`));
          const value = {
            ...run,
            workflow_id: workflowId,
            repository: { full_name: repository, id: 17 },
            head_repository: { full_name: repository, id: 17 },
          };
          return Promise.resolve(
            reply(
              path.endsWith("/jobs")
                ? {
                  total_count: 1,
                  jobs: [{
                    id: 5,
                    run_id: 12,
                    run_attempt: 1,
                    head_sha: fixture.head,
                    name: "test-local",
                    status: "completed",
                    conclusion: "success",
                  }],
                }
                : path.endsWith("/runs")
                ? { total_count: 1, workflow_runs: [value] }
                : value,
            ),
          );
        };
        const api = new HostedRuntimeFollowApi(http, "synthetic");
        try {
          assert((await readFollowCi(api, fixture.head, 17)) !== null);
          workflowId = 353613034;
          assert.equal(await readFollowCi(api, fixture.head, 17), null);
          workflowId = PRIVATE_CI_ID;
          repository = "ubiquity-sentinel/sentinel";
          assert.equal(await readFollowCi(api, fixture.head, 17), null);
          assert(
            paths.some((path) =>
              path.includes(`/workflows/${PRIVATE_CI_ID}/runs`)
            ),
          );
        } finally {
          api.dispose();
        }
      },
    );
    await t.step(
      "dispatcher writes only the committed private workflow route",
      async () => {
        const dispatch = await load<
          typeof import("../../src/host/supervisor-dispatch.ts")
        >("src/host/supervisor-dispatch.ts");
        let posts = 0;
        const result = await dispatch.runSupervisorDispatch({
          token: "synthetic",
          clock: { now: () => OBSERVED },
          log: () => {},
          http: (request) => {
            const path = new URL(request.url).pathname;
            assert(path.startsWith(`/repos/${PRIVATE_REPOSITORY}/`));
            if (request.method === "POST") {
              posts++;
              assert.equal(
                path,
                `/repos/${PRIVATE_REPOSITORY}/actions/workflows/supervisor.yml/dispatches`,
              );
              return Promise.resolve(reply({}, 204));
            }
            return Promise.resolve(
              reply({ total_count: 0, workflow_runs: [] }),
            );
          },
        });
        assert.equal(result.exitCode, 0);
        assert.equal(posts, 1);
      },
    );
    await t.step(
      "private source runs current-controller CI cases and refuses literal public history",
      async () => {
        const result = await new Deno.Command(Deno.execPath(), {
          args: [
            "test",
            "--frozen",
            "--allow-read=.,/usr,/bin," + Deno.execPath(),
            "--allow-run",
            "--allow-write",
            "--allow-env=PATH,NODE_V8_COVERAGE",
            "--filter",
            "/^(hosted supervisor core:|hosted supervisor interrupted step:|hosted supervisor PR110:|requested installation:|supervisor dispatch:|actions host: two committed targets|actions host: a foreign target)/",
            "tests/host/hosted-supervisor-lifecycle_test.ts",
            "tests/host/hosted-supervisor-evidence_test.ts",
            "tests/host/hosted-supervisor-installation-ci_test.ts",
            "tests/host/supervisor-dispatch_test.ts",
            "tests/host/actions-target-cycles_test.ts",
          ],
          cwd: fixture.checkout,
          clearEnv: true,
          env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
          signal: AbortSignal.timeout(180_000),
          stdout: "piped",
          stderr: "piped",
        }).output();
        const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
        assert.equal(
          result.code,
          0,
          decode(result.stderr) + decode(result.stdout),
        );
      },
    );
  } finally {
    await fixture.close();
  }
});
