/** Hosted actions-candidates-legacy-boundaries_test responsibility. */
import assert from "node:assert/strict";
import type {
  GitHubIssueV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { createLocalCandidateLoader } from "../../src/host/local.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { REPO, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  FakeGate,
  gitRun,
  makeCandidateCtx,
  TRUSTED_PATH,
} from "./actions-candidates-fixture.ts";
import {
  countingCandidateLoader,
  CountingRuntime,
  DriftingLossState,
  LEGACY_BRANCH,
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
  RecordingRuntime,
} from "./actions-candidates-legacy-fixture.ts";
import { CANDIDATE_TASK_ID } from "./actions-candidates-preservation-fixture.ts";

Deno.test(
  "legacy loss: source, ref and PR boundaries stop before the fresh-store proof",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const record = legacyRecord({
        lost: SHA2,
        base: SHA1,
        observedBase: SHA3,
      });
      const reviews = [
        legacyReview({ id: "review-a", head: ctx.head, base: SHA1 }),
      ];
      const state = legacyState(
        [record],
        [legacyReservation(record)],
        reviews,
      );
      const refName = `refs/heads/${LEGACY_BRANCH}`;
      const cases: {
        name: string;
        expectKind: string;
        issue?: PortResultV1<GitHubIssueV1 | null>;
        pull?: PortResultV1<GitHubPullRequestV1 | null>;
        ref?: PortResultV1<GitHubRefV1 | null>;
      }[] = [
        {
          name: "closed source issue",
          expectKind: "conflict",
          issue: portOk(legacyIssue({ state: "closed", closedAt: T0 + 1 })),
        },
        {
          name: "unscoped source issue",
          expectKind: "unavailable",
          issue: portOk(null),
        },
        {
          name: "unknown issue relations",
          expectKind: "unavailable",
          issue: portOk(legacyIssue({ relations: undefined })),
        },
        {
          name: "subissues present",
          expectKind: "conflict",
          issue: portOk(legacyIssue({
            relations: { openBlockers: [], subIssueCount: 1 },
          })),
        },
        {
          name: "open blocker",
          expectKind: "conflict",
          issue: portOk(legacyIssue({
            relations: {
              openBlockers: [{
                owner: "ubiquity-sentinel",
                name: "sentinel",
                number: 9,
              }],
              subIssueCount: 0,
            },
          })),
        },
        {
          name: "wrong issue number",
          expectKind: "unavailable",
          issue: portOk(legacyIssue({ number: 2 })),
        },
        {
          name: "missing task branch",
          expectKind: "unavailable",
          ref: portOk(null),
        },
        {
          name: "branch and PR disagree",
          expectKind: "conflict",
          ref: portOk({ ref: refName, sha: ctx.head }),
          pull: portOk(legacyPull({ predecessor: SHA2 })),
        },
        {
          name: "missing PR",
          expectKind: "unavailable",
          pull: portOk(null),
        },
        {
          name: "wrong PR number",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: { number: 13 },
          })),
        },
        {
          name: "moved PR head",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: { head: SHA1 },
          })),
        },
        {
          name: "wrong PR head branch",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: { headRef: "sentinel/repair/other" },
          })),
        },
        {
          name: "wrong PR base branch",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: { baseRef: "main" },
          })),
        },
        {
          name: "untrusted PR author",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: { author: "stranger" },
          })),
        },
        {
          name: "merged PR",
          expectKind: "conflict",
          pull: portOk(legacyPull({
            predecessor: ctx.head,
            overrides: {
              state: "merged",
              mergeSha: ctx.head,
              mergedAt: T0,
            },
          })),
        },
      ];
      for (const entry of cases) {
        const loader = countingCandidateLoader();
        const runtime = new CountingRuntime();
        const port = new LegacyLossPort({
          issue: entry.issue ?? portOk(legacyIssue()),
          pull: entry.pull ??
            portOk(legacyPull({ predecessor: ctx.head, base: SHA3 })),
          ref: entry.ref ?? portOk({ ref: refName, sha: ctx.head }),
        });
        const result = await legacyProver({
          ctx,
          state,
          port,
          ensure: loader.load,
          runtime,
        })(LEGACY_TASK_ID);
        assert.equal(result.ok, false, entry.name);
        assert.equal(
          result.ok ? "" : result.error.kind,
          entry.expectKind,
          entry.name,
        );
        assert.equal(
          loader.calls.length,
          1,
          `${entry.name}: local absence checked once`,
        );
        assert.equal(runtime.calls, 0, `${entry.name}: no git run`);
        assert.deepEqual(
          legacyStoreLeftovers(`${ctx.tmp}/home`),
          [],
          entry.name,
        );
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: invalid historical review evidence is never loss",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const record = legacyRecord({
        lost: SHA2,
        base: SHA1,
        observedBase: SHA3,
      });
      const cases: { name: string; reviews: ReviewReceiptV1[] }[] = [
        { name: "no review receipt", reviews: [] },
        {
          name: "pending review",
          reviews: [legacyReview({
            id: "review-a",
            head: ctx.head,
            base: SHA1,
            overrides: {
              outcome: "pending",
              observedReviewer: null,
              resultId: null,
              completedAt: null,
              findings: [],
              unresolvedSeverities: [],
            },
          })],
        },
        {
          name: "untrusted reviewer",
          reviews: [legacyReview({
            id: "review-a",
            head: ctx.head,
            base: SHA1,
            overrides: {
              expectedReviewer: "stranger[bot]",
              observedReviewer: "stranger[bot]",
            },
          })],
        },
        {
          name: "foreign repository",
          reviews: [legacyReview({
            id: "review-a",
            head: ctx.head,
            base: SHA1,
            overrides: { repository: REPO },
          })],
        },
        {
          name: "wrong reviewed head",
          reviews: [legacyReview({ id: "review-a", head: SHA1, base: SHA1 })],
        },
        {
          name: "wrong reviewed base",
          reviews: [
            legacyReview({ id: "review-a", head: ctx.head, base: SHA3 }),
          ],
        },
        {
          name: "no unresolved severities",
          reviews: [legacyReview({
            id: "review-a",
            head: ctx.head,
            base: SHA1,
            overrides: { findings: [], unresolvedSeverities: [] },
          })],
        },
        {
          // A P2/P3-only review was deliverable and never required the
          // correction this proof would restore.
          name: "only non-blocking severities",
          reviews: [legacyReview({
            id: "review-a",
            head: ctx.head,
            base: SHA1,
            overrides: {
              findings: (["P2", "P3"] as const).map((severity, index) => ({
                id: `finding-${index}`,
                severity,
                path: null,
                message: "non-blocking finding",
                fingerprint: String(index).repeat(64),
                resolved: false,
                resolutionEvidence: null,
              })),
              unresolvedSeverities: ["P2", "P3"],
            },
          })],
        },
      ];
      for (const entry of cases) {
        const loader = countingCandidateLoader();
        const runtime = new CountingRuntime();
        const port = new LegacyLossPort({
          issue: portOk(legacyIssue()),
          pull: portOk(legacyPull({ predecessor: ctx.head, base: SHA3 })),
          ref: portOk({
            ref: `refs/heads/${LEGACY_BRANCH}`,
            sha: ctx.head,
          }),
        });
        const result = await legacyProver({
          ctx,
          state: legacyState(
            [record],
            [legacyReservation(record)],
            entry.reviews,
          ),
          port,
          ensure: loader.load,
          runtime,
        })(LEGACY_TASK_ID);
        assert.equal(result.ok, false, entry.name);
        assert.equal(
          result.ok ? "" : result.error.kind,
          "unavailable",
          entry.name,
        );
        assert.equal(
          loader.calls.length,
          1,
          `${entry.name}: local absence checked once`,
        );
        assert.equal(runtime.calls, 0, `${entry.name}: no git run`);
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: local candidate availability is never absence",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const record = legacyRecord({
        lost: SHA2,
        base: SHA1,
        observedBase: SHA3,
      });
      const state = legacyState([record], [legacyReservation(record)]);
      const portFor = () =>
        new LegacyLossPort({
          issue: portOk(legacyIssue()),
          pull: portOk(legacyPull({ predecessor: ctx.head })),
          ref: portOk({
            ref: `refs/heads/${LEGACY_BRANCH}`,
            sha: ctx.head,
          }),
        });
      // Present locally: an explicit null, no remote read and no git run.
      const presentLoader = countingCandidateLoader();
      presentLoader.load = (taskId, head) => {
        presentLoader.calls.push({ taskId, head });
        return Promise.resolve(portOk(undefined));
      };
      const presentRuntime = new CountingRuntime();
      const presentPort = portFor();
      const present = await legacyProver({
        ctx,
        state,
        port: presentPort,
        ensure: presentLoader.load,
        runtime: presentRuntime,
      })(LEGACY_TASK_ID);
      assert.ok(present.ok, JSON.stringify(present));
      assert.equal(present.ok ? present.value : "error", null);
      assert.equal(presentLoader.calls.length, 1);
      assert.equal(presentPort.calls.length, 0);
      assert.equal(presentRuntime.calls, 0);

      // Unknown local availability passes through unchanged.
      const unknownLoader = countingCandidateLoader();
      unknownLoader.load = (taskId, head) => {
        unknownLoader.calls.push({ taskId, head });
        return Promise.resolve(portError("unavailable", "loader unavailable"));
      };
      const unknownRuntime = new CountingRuntime();
      const unknownPort = portFor();
      const unknown = await legacyProver({
        ctx,
        state,
        port: unknownPort,
        ensure: unknownLoader.load,
        runtime: unknownRuntime,
      })(LEGACY_TASK_ID);
      assert.equal(unknown.ok, false);
      assert.equal(unknown.ok ? "" : unknown.error.kind, "unavailable");
      assert.equal(unknownPort.calls.length, 0);
      assert.equal(unknownRuntime.calls, 0);

      // Any other typed error is forwarded with its own identity.
      const conflictLoader = countingCandidateLoader();
      conflictLoader.load = (taskId, head) => {
        conflictLoader.calls.push({ taskId, head });
        return Promise.resolve(portError("conflict", "loader conflict"));
      };
      const conflict = await legacyProver({
        ctx,
        state,
        port: portFor(),
        ensure: conflictLoader.load,
        runtime: new CountingRuntime(),
      })(LEGACY_TASK_ID);
      assert.equal(conflict.ok, false);
      assert.equal(conflict.ok ? "" : conflict.error.kind, "conflict");
      assert.equal(conflict.ok ? "" : conflict.error.detail, "loader conflict");
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: a recorded head reachable from the fetched branch is never absence",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const work = `${ctx.tmp}/work`;
      assert.ok(
        (await gitRun(
          work,
          ["push", "-q", "origin", `${ctx.head}:refs/heads/${LEGACY_BRANCH}`],
          ctx.env,
        )).ok,
      );
      // A shallow trusted source really lacks H1 = B0 while the full history
      // the fresh fetch carries contains it.
      const shallow = `${ctx.tmp}/shallow`;
      const cloned = await gitRun(
        ctx.tmp,
        [
          "clone",
          "-q",
          "--depth=1",
          "--single-branch",
          "--branch",
          LEGACY_BRANCH,
          `file://${ctx.bare}`,
          shallow,
        ],
        ctx.env,
      );
      assert.ok(cloned.ok, cloned.stderr);
      const record = legacyRecord({
        lost: ctx.base,
        base: ctx.base,
        observedBase: SHA3,
      });
      const reviews = [
        legacyReview({ id: "review-a", head: ctx.head, base: ctx.base }),
      ];
      const state = legacyState(
        [record],
        [legacyReservation(record)],
        reviews,
      );
      // The exact loader root exists but has no mapping or checkout at all.
      await Deno.mkdir(`${ctx.tmp}/empty-state`, { recursive: true });
      const loader = createLocalCandidateLoader({
        stateRoot: `${ctx.tmp}/empty-state`,
        sourcePath: shallow,
        scratch: `${ctx.tmp}/home`,
        trustedPath: TRUSTED_PATH,
      });
      const runtime = new RecordingRuntime(new DenoReplayRuntime(TRUSTED_PATH));
      const port = new LegacyLossPort({
        issue: portOk(legacyIssue()),
        pull: portOk(legacyPull({ predecessor: ctx.head, base: ctx.base })),
        ref: portOk({ ref: `refs/heads/${LEGACY_BRANCH}`, sha: ctx.head }),
      });
      const result = await legacyProver({
        ctx,
        state,
        port,
        ensure: loader,
        runtime,
      })(LEGACY_TASK_ID);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.error.kind, "conflict");
      assert.ok(
        runtime.calls.some((args) => args.includes("fetch")),
        "the fresh fetch really ran",
      );
      assert.deepEqual(legacyStoreLeftovers(`${ctx.tmp}/home`), []);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: a refused cooldown never fetches and never claims loss",
  async () => {
    const fixture = await makeLegacyLossCtx();
    const { ctx } = fixture;
    try {
      const record = legacyRecord({
        lost: fixture.lost,
        base: ctx.base,
        observedBase: fixture.movedBase,
      });
      const reviews = [
        legacyReview({ id: "review-a", head: ctx.head, base: ctx.base }),
      ];
      const state = legacyState(
        [record],
        [legacyReservation(record)],
        reviews,
        { snapshotHead: SHA2, readHead: SHA1 },
      );
      const loader = createLocalCandidateLoader({
        stateRoot: fixture.stateRoot,
        sourcePath: fixture.sourcePath,
        scratch: `${ctx.tmp}/home`,
        trustedPath: TRUSTED_PATH,
      });
      const gate = new FakeGate();
      gate.deny = true;
      const runtime = new RecordingRuntime(new DenoReplayRuntime(TRUSTED_PATH));
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
        ensure: loader,
        runtime,
        gate,
      })(CANDIDATE_TASK_ID);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.error.kind, "rate_limited");
      assert.equal(
        runtime.calls.some((args) => args.includes("fetch")),
        false,
        "no fetch without admission",
      );
      assert.ok(runtime.calls.length > 0, "the owned store was initialized");
      assert.equal(gate.admissions.length, 1);
      assert.deepEqual(legacyStoreLeftovers(`${ctx.tmp}/home`), []);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "legacy loss: a moved durable state head refuses after the proof",
  async () => {
    const fixture = await makeLegacyLossCtx();
    const { ctx } = fixture;
    try {
      const record = legacyRecord({
        lost: fixture.lost,
        base: ctx.base,
        observedBase: fixture.movedBase,
      });
      const reviews = [
        legacyReview({ id: "review-a", head: ctx.head, base: ctx.base }),
      ];
      const inner = legacyState(
        [record],
        [legacyReservation(record)],
        reviews,
        { snapshotHead: SHA2, readHead: SHA1 },
      );
      const drifting = new DriftingLossState(inner, SHA2);
      const loader = createLocalCandidateLoader({
        stateRoot: fixture.stateRoot,
        sourcePath: fixture.sourcePath,
        scratch: `${ctx.tmp}/home`,
        trustedPath: TRUSTED_PATH,
      });
      const runtime = new RecordingRuntime(new DenoReplayRuntime(TRUSTED_PATH));
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
        state: drifting,
        port,
        ensure: loader,
        runtime,
      })(CANDIDATE_TASK_ID);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? "" : result.error.kind, "conflict");
      assert.equal(drifting.reads, 2, "both state reads really happened");
      assert.ok(
        runtime.calls.some((args) => args.includes("fetch")),
        "the proof ran before the drift refusal",
      );
      assert.deepEqual(legacyStoreLeftovers(`${ctx.tmp}/home`), []);
    } finally {
      await ctx.cleanup();
    }
  },
);
