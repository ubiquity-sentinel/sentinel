/** Hosted actions-candidates-legacy_test responsibility. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type {
  GitHubPort,
  LegacyBaseRefreshLossProofV1,
  PortResultV1,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import {
  createActionsCandidateRestorer,
  createLegacyBaseRefreshLossProver,
} from "../../src/host/actions-candidates.ts";
import {
  createLocalCandidateLoader,
  createPrepareBaseRefresh,
} from "../../src/host/local.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { baseRefreshIntentKey } from "../../src/repair/keys.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "../repair/helpers.ts";
import {
  REPO,
  type reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  countingCandidateLoader,
  CountingRuntime,
  LEGACY_AUTHOR,
  LEGACY_BRANCH,
  LEGACY_PR,
  LEGACY_TASK_ID,
  legacyIssue,
  LegacyLossPort,
  legacyProver,
  legacyPull,
  legacyRecord,
  legacyReservation,
  legacyReview,
  legacyState,
  legacyStoreLeftovers,
  makeLegacyLossCtx,
} from "./actions-candidates-legacy-fixture.ts";
import {
  CANDIDATE_TASK_ID,
  RealRefHttp,
  remoteSha,
} from "./actions-candidates-preservation-fixture.ts";
import {
  FakeGate,
  gitRun,
  makeCandidateCtx,
  objectPresent,
  SELF_REPO,
  snapshot,
  TRUSTED_PATH,
} from "./actions-candidates-fixture.ts";

Deno.test(
  "legacy loss: proves the exact scoped legacy candidate loss over the real loader and a fresh store",
  async () => {
    const fixture = await makeLegacyLossCtx();
    const { ctx } = fixture;
    try {
      const taskId = CANDIDATE_TASK_ID;
      const refsBefore = await gitRun(
        ctx.bare,
        ["for-each-ref", "--format=%(refname) %(objectname)"],
        ctx.env,
      );
      assert.ok(refsBefore.ok);
      const loader = createLocalCandidateLoader({
        stateRoot: fixture.stateRoot,
        sourcePath: fixture.sourcePath,
        scratch: `${ctx.tmp}/home`,
        trustedPath: TRUSTED_PATH,
      });
      let loaderCalls = 0;
      const countedLoader = (id: WorkItemId, head: GitSha) => {
        loaderCalls++;
        return loader(id, head);
      };
      // The trusted source and the exact producer checkout really lack H1.
      assert.equal(
        await objectPresent(fixture.sourcePath, ctx.env, fixture.lost),
        false,
      );
      assert.equal(
        await objectPresent(fixture.producer, ctx.env, fixture.lost),
        false,
      );
      // B0 is an ancestor of H0 while the PR's current base differs from B0.
      assert.notEqual(fixture.movedBase, ctx.base);
      assert.equal(
        (await gitRun(
          ctx.bare,
          ["merge-base", "--is-ancestor", ctx.base, ctx.head],
          ctx.env,
        )).code,
        0,
      );
      const reviews = [
        legacyReview({ id: "review-b", head: ctx.head, base: ctx.base }),
        legacyReview({ id: "review-a", head: ctx.head, base: ctx.base }),
      ];
      const record = legacyRecord({
        lost: fixture.lost,
        base: ctx.base,
        observedBase: fixture.movedBase,
      });
      // The snapshot's own stateHead deliberately differs from the read head.
      const state = legacyState(
        [record],
        [legacyReservation(record)],
        reviews,
        {
          snapshotHead: SHA2,
          readHead: SHA1,
        },
      );
      const durableBefore = structuredClone(state.repair);
      const port = new LegacyLossPort({
        issue: portOk(legacyIssue()),
        pull: portOk(legacyPull({
          predecessor: ctx.head,
          base: fixture.movedBase,
        })),
        ref: portOk({ ref: `refs/heads/${fixture.branch}`, sha: ctx.head }),
      });
      const result = await legacyProver({
        ctx,
        state,
        port,
        ensure: countedLoader,
        runtime: new DenoReplayRuntime(TRUSTED_PATH),
      })(taskId);
      assert.ok(result.ok, JSON.stringify(result));
      if (!result.ok) throw new Error("unreachable");
      const expected: LegacyBaseRefreshLossProofV1 = {
        taskId,
        repository: { ...SELF_REPO },
        stateHead: SHA1,
        shape: "legacy_base_refresh",
        lostBase: ctx.base,
        lostHead: fixture.lost,
        predecessorHead: ctx.head,
        branch: fixture.branch,
        pr: LEGACY_PR,
        intentKey: baseRefreshIntentKey(
          LEGACY_PR,
          fixture.lost,
          fixture.movedBase,
        ),
        reviewId: "review-a",
      };
      assert.deepEqual(result.value, expected);

      // The blocked+missing_evidence shape proves the identical loss.
      const blockedRecord = legacyRecord({
        lost: fixture.lost,
        base: ctx.base,
        observedBase: fixture.movedBase,
        nextStep: "blocked",
        blocker: {
          kind: "missing_evidence",
          message: "candidate is unavailable for review",
          since: T0,
        },
      });
      const blockedState = legacyState(
        [blockedRecord],
        [legacyReservation(blockedRecord)],
        reviews,
        { snapshotHead: SHA2, readHead: SHA1 },
      );
      const blockedPort = new LegacyLossPort({
        issue: portOk(legacyIssue()),
        pull: portOk(legacyPull({
          predecessor: ctx.head,
          base: fixture.movedBase,
        })),
        ref: portOk({ ref: `refs/heads/${fixture.branch}`, sha: ctx.head }),
      });
      const blocked = await legacyProver({
        ctx,
        state: blockedState,
        port: blockedPort,
        ensure: countedLoader,
        runtime: new DenoReplayRuntime(TRUSTED_PATH),
      })(taskId);
      assert.ok(blocked.ok, JSON.stringify(blocked));
      if (!blocked.ok) throw new Error("unreachable");
      assert.deepEqual(blocked.value, expected);
      assert.equal(loaderCalls, 4, "both shapes drove the real loader twice");

      // No state, remote or candidate-ref write of any kind.
      assert.equal(state.repairWrites, 0);
      assert.equal(blockedState.repairWrites, 0);
      assert.deepEqual(state.repair, durableBefore);
      assert.deepEqual(
        (await gitRun(
          ctx.bare,
          ["for-each-ref", "--format=%(refname) %(objectname)"],
          ctx.env,
        )).stdout,
        refsBefore.stdout,
        "no remote ref changed",
      );
      const candidateRefs = await gitRun(
        ctx.bare,
        [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/sentinel-candidates",
        ],
        ctx.env,
      );
      assert.equal(candidateRefs.stdout.trim(), "");
      assert.deepEqual(legacyStoreLeftovers(`${ctx.tmp}/home`), []);
      assert.deepEqual(port.calls, [
        "issue:1",
        `ref:refs/heads/${fixture.branch}`,
        `pr:${LEGACY_PR}`,
        "issue:1",
        `ref:refs/heads/${fixture.branch}`,
        `pr:${LEGACY_PR}`,
      ]);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: remotely present candidate continues through the real loop and base restoration without a charge",
  async () => {
    const fixture = await makeLegacyLossCtx();
    const { ctx } = fixture;
    try {
      const sourcePath = `${ctx.tmp}/resumed.git`;
      assert.ok(
        (await gitRun(ctx.tmp, ["init", "-q", "--bare", sourcePath], ctx.env))
          .ok,
      );
      const record = legacyRecord({
        lost: ctx.head,
        base: ctx.base,
        observedBase: fixture.movedBase,
      });
      const state = legacyState([record], [legacyReservation(record)]);
      const reservationsBefore = structuredClone(state.repair!.reservations);
      const clock = new FakeClock(T0 + 6000);
      const gate = new FakeGate();
      const git = new DenoGitExecutor({
        localDir: sourcePath,
        remoteUrl: `file://${ctx.bare}`,
        gitHome: `${ctx.tmp}/home`,
        gitPath: "git",
      });
      const github: GitHubPort = new FakeGithub({
        issues: [legacyIssue()],
        openIssues: [],
      });
      github.readIssue = () => Promise.resolve(portOk(legacyIssue()));
      github.readRef = async (ref) => {
        const read = await git.readRemoteRef(ref);
        return read.ok
          ? portOk(read.value === null ? null : { ref, sha: read.value })
          : read;
      };
      github.readPullRequest = () =>
        Promise.resolve(portOk(legacyPull({
          predecessor: ctx.head,
          base: fixture.movedBase,
        })));
      const restorer = createActionsCandidateRestorer({
        state,
        gate,
        token: "dummy-token",
        http: new RealRefHttp(git).transport,
        clock,
        sourcePath,
        scratch: `${ctx.tmp}/home`,
        trustedPath: TRUSTED_PATH,
        gitExecutable: "git",
        remoteUrl: `file://${ctx.bare}`,
      });
      let proofCalls = 0;
      let proofResult:
        | PortResultV1<LegacyBaseRefreshLossProofV1 | null>
        | null = null;
      const prove = createLegacyBaseRefreshLossProver({
        state,
        port: github,
        gate,
        token: "dummy-token",
        scratch: `${ctx.tmp}/home`,
        trustedPath: TRUSTED_PATH,
        gitExecutable: "git",
        baseBranch: "development",
        trustedPrAuthor: LEGACY_AUTHOR,
        remoteUrl: `file://${ctx.bare}`,
        ensureLocalCandidate: async (_id, head) =>
          await objectPresent(sourcePath, ctx.env, head)
            ? portOk(undefined)
            : portError(
              "not_found",
              "exact candidate absent from resumed mirror",
            ),
      });
      github.proveLegacyBaseRefreshLoss = async (id) => {
        proofCalls++;
        proofResult = await prove(id);
        return proofResult;
      };
      let restoreCalls = 0;
      let prepared: GitSha | null = null;
      const prepare = createPrepareBaseRefresh({
        git,
        observer: github,
        baseBranch: "development",
        trustedPrAuthor: LEGACY_AUTHOR,
        ensureCandidateObjects: (request) => {
          restoreCalls++;
          return restorer.ensure(request);
        },
        ensureBaseObjects: async () => {
          const fetched = await gitRun(sourcePath, [
            "fetch",
            "--no-tags",
            `file://${ctx.bare}`,
            "refs/heads/development",
          ], ctx.env);
          return fetched.ok
            ? portOk(undefined)
            : portError("unavailable", "fixture base fetch failed");
        },
      });
      github.prepareBaseRefresh = async (request) => {
        const result = await prepare(request);
        if (!result.ok) return result;
        prepared = result.value;
        return portError(
          "unavailable",
          "fixture stops after real base preparation",
        );
      };
      const configs = repairConfigs({
        repository: { ...SELF_REPO },
        adapter: { kind: "github" },
        protectedPaths: [],
      });
      const model = new FakeModel();
      assert.equal(await objectPresent(sourcePath, ctx.env, ctx.head), false);
      const outcome = await runRepairCycle({
        clock,
        state,
        configs,
        controllerSha: SHA1,
        github,
        githubCooldown: gate,
        incidents: new FakeIncidents({ summaries: [], evidence: null }),
        replay: new FakeReplay(),
        model,
        budget: new RollingStartBudget({ clock, state, configs }),
      }, {
        deadline: clock.now() + 60 * 60_000,
        stepLimit: 4,
        modelStartsEnabled: false,
      });
      assert.equal(proofCalls, 1, JSON.stringify(outcome));
      assert.equal(
        restoreCalls,
        1,
        `exact remote presence must continue to ordinary restoration: ${
          JSON.stringify({ outcome, proofResult })
        }`,
      );
      assert.equal(await objectPresent(sourcePath, ctx.env, ctx.head), true);
      assert.notEqual(
        prepared,
        null,
        "the real adapter generated the base-refresh candidate",
      );
      assert.deepEqual(state.repair!.reservations, reservationsBefore);
      assert.equal(model.requests.length, 0);
      assert.deepEqual(state.repair!.work[0]!.target, record.target);
      assert.equal(state.repair!.work[0]!.blocker, null);
      assert.equal(
        await remoteSha(ctx, `refs/heads/${LEGACY_BRANCH}`),
        ctx.head,
      );
      // Non-loss never authorizes a refresh against an untrusted publication.
      github.readPullRequest = () =>
        Promise.resolve(portOk(legacyPull({
          predecessor: ctx.head,
          base: fixture.movedBase,
          overrides: { author: "untrusted" },
        })));
      const refused = await prepare({
        pullRequestNumber: LEGACY_PR,
        branch: LEGACY_BRANCH,
        expectedHead: ctx.head,
        previousBase: ctx.base,
        expectedBase: fixture.movedBase,
      });
      assert.equal(refused.ok, false);
      assert.equal(refused.ok ? "" : refused.error.kind, "conflict");
      assert.equal(
        restoreCalls,
        1,
        "the ordinary PR guard refuses before restoration",
      );
      assert.deepEqual(state.repair!.reservations, reservationsBefore);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: unsupported shapes and cheap binding negatives refuse before local or remote work",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const base = SHA1;
      const lost = SHA2;
      const observed = SHA3;
      const valid = () => legacyRecord({ lost, base, observedBase: observed });
      const emptyState = new MemoryState();
      emptyState.repair = snapshot([]);
      emptyState.repairHead = SHA1;
      const withRecord = (
        record: WorkRecordV1,
        options: {
          extra?: WorkRecordV1[];
          reservations?: ReturnType<typeof reservation>[];
        } = {},
      ) =>
        legacyState(
          [record, ...(options.extra ?? [])],
          options.reservations ?? [legacyReservation(record)],
        );
      const withVariant = (
        build: (record: WorkRecordV1) => {
          extra?: WorkRecordV1[];
          reservations?: ReturnType<typeof reservation>[];
        },
      ) => {
        const record = valid();
        return withRecord(record, build(record));
      };
      const rows: {
        name: string;
        expect: "null" | "error";
        state: StateReadView;
      }[] = [
        { name: "no record", expect: "null", state: emptyState },
        {
          name: "new-format candidate state",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            target: {
              candidateState: { preserved: null, publishedHead: null },
            },
          })),
        },
        {
          name: "pre-receipt implementation intent",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: {
              kind: "implementation",
              key: `impl:${"b".repeat(64)}`,
              requestId: null,
            },
          })),
        },
        {
          name: "prepared base refresh",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: { resultId: SHA3 },
          })),
        },
        {
          name: "source id mismatch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            workOverrides: {
              source: { kind: "issue", id: "2", revision: SHA1 },
            },
          })),
        },
        {
          name: "incident-related record",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            workOverrides: {
              related: { incidentId: "inc-1", issueNumber: 1 },
            },
          })),
        },
        {
          name: "missing dependency",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            dependencies: ["other-1"],
          })),
        },
        {
          name: "unfinished dependency",
          expect: "error",
          state: withRecord(
            legacyRecord({
              lost,
              base,
              observedBase: observed,
              dependencies: ["other-1"],
            }),
            { extra: [workRecord("other-1", { nextStep: "work" })] },
          ),
        },
        {
          name: "non-deterministic branch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            target: { branch: "sentinel/repair/other" },
          })),
        },
        {
          name: "intent key mismatch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: { key: baseRefreshIntentKey(LEGACY_PR, lost, base) },
          })),
        },
        {
          name: "intent expected head mismatch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: { expectedHead: base },
          })),
        },
        {
          name: "intent branch mismatch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: { branch: "sentinel/repair/other" },
          })),
        },
        {
          name: "intent PR mismatch",
          expect: "error",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            intent: { pr: 13 },
          })),
        },
        {
          name: "no submitted reservation",
          expect: "error",
          state: withVariant(() => ({ reservations: [] })),
        },
        {
          name: "reservation attempt mismatch",
          expect: "error",
          state: withVariant((record) => ({
            reservations: [legacyReservation(record, { attempt: 2 })],
          })),
        },
        {
          name: "unsubmitted reservation",
          expect: "error",
          state: withVariant((record) => ({
            reservations: [legacyReservation(record, {
              outcome: "reserved",
              settledAt: null,
            })],
          })),
        },
        {
          name: "foreign reservation repository",
          expect: "error",
          state: withVariant((record) => ({
            reservations: [legacyReservation(record, { repository: REPO })],
          })),
        },
        {
          name: "reservation base mismatch",
          expect: "error",
          state: withVariant((record) => ({
            reservations: [legacyReservation(record, { head: SHA2 })],
          })),
        },
        {
          name: "continuation reservation",
          expect: "error",
          state: withVariant((record) => ({
            reservations: [
              legacyReservation(record, { purpose: "continuation" }),
            ],
          })),
        },
        {
          name: "lifecycle review",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            nextStep: "review",
          })),
        },
        {
          name: "lifecycle delivery",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            nextStep: "delivery",
          })),
        },
        {
          name: "blocked by another kind",
          expect: "null",
          state: withRecord(legacyRecord({
            lost,
            base,
            observedBase: observed,
            nextStep: "blocked",
            blocker: {
              kind: "dependency",
              message: "waiting for another work item",
              since: T0,
            },
          })),
        },
      ];
      for (const row of rows) {
        const loader = countingCandidateLoader();
        const runtime = new CountingRuntime();
        const port = new LegacyLossPort({
          issue: portOk(legacyIssue()),
          pull: portOk(legacyPull({ predecessor: ctx.head })),
          ref: portOk({
            ref: `refs/heads/${LEGACY_BRANCH}`,
            sha: ctx.head,
          }),
        });
        const result = await legacyProver({
          ctx,
          state: row.state,
          port,
          ensure: loader.load,
          runtime,
        })(LEGACY_TASK_ID);
        if (row.expect === "null") {
          assert.ok(result.ok, `${row.name}: expected an explicit null`);
          assert.equal(result.ok ? result.value : "error", null, row.name);
        } else {
          assert.equal(result.ok, false, `${row.name}: expected a refusal`);
        }
        assert.equal(port.calls.length, 0, `${row.name}: no remote read`);
        assert.equal(loader.calls.length, 0, `${row.name}: no local loader`);
        assert.equal(runtime.calls, 0, `${row.name}: no git run`);
        assert.deepEqual(
          legacyStoreLeftovers(`${ctx.tmp}/home`),
          [],
          row.name,
        );
      }
    } finally {
      await ctx.cleanup();
    }
  },
);
