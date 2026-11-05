/**
 * A review bot's check is not CI evidence (live 2026-11-01/02, ai.ubq.fi
 * #1348, #1353, #1354). The gateway's `Gateway CI` runs only when Sentinel
 * dispatches it or once a pull request is merged; every Sentinel pull request
 * head from 2026-10-27 carried one `CodeRabbit` check completed `skipped` and
 * nothing else. That lone skipped check read as green CI, so the CI-first
 * gate requested the review at once, no `ci_pending` wait ever existed for
 * the pre-merge dispatcher to pick, and the reviewed heads merged with no CI
 * run; the post-merge Gateway CI on `development` then failed.
 *
 * Real repair loop over real Git state with fake GitHub/model ports: such a
 * head now waits uncharged at `work`, the dispatcher selects that exact wait
 * and sends its one dispatch, a green dispatched run lets the review proceed,
 * and a reviewed head in delivery is never merged on the bot check alone.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import {
  dispatchPremergeCi,
  pendingPremergeRecords,
} from "../../src/host/actions-premerge-ci.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import { createTargetConfigV1 } from "../../src/host/targets.ts";
import { decideCiGate } from "../../src/repair/loop.ts";
import { FakeClock, MemoryState } from "./helpers.ts";
import { REPO, SHA1, SHA3, T0 } from "../state/helpers.ts";
import {
  FakeGate,
  response,
  ScriptedHttp,
} from "../host/actions-ci-fixture.ts";
import {
  BRANCH,
  check,
  ciFirstRig,
  reviewCharges,
  taskRecord,
} from "./ci-first-rig.ts";

const APP_LOGIN = "ubiquity-sentinel[bot]";
const INSTALLATION = 173_913_802;
const REPO_PATH = "/repos/ubiquity/ai.ubq.fi";
const RUNS_PATH = `${REPO_PATH}/actions/workflows/deno-deploy.yml/runs`;
const DISPATCH_PATH =
  `${REPO_PATH}/actions/workflows/deno-deploy.yml/dispatches`;

/** The live head: one skipped CodeRabbit check, no Gateway CI run. */
function botOnly(head: GitSha): GitHubCheckV1[] {
  return [check("CodeRabbit", head, "skipped")];
}

/** Gateway CI's jobs as one green dispatched run reports them. */
const GATEWAY_JOBS = [
  "scope",
  "portable",
  "validate",
  "mac-containment",
  "darwin-native",
  "verify-artifact",
];

Deno.test("CI gate: a lone review-bot check is no CI evidence; it is still judged", () => {
  assert.equal(decideCiGate(botOnly(SHA3)), "wait");
  assert.equal(
    decideCiGate([check("coderabbit", SHA3, "success")]),
    "wait",
    "a green review-bot check alone is no CI evidence either",
  );
  assert.equal(
    decideCiGate([...botOnly(SHA3), check("validate", SHA3, "success")]),
    "proceed",
    "next to a real CI check the bot check changes nothing",
  );
  const red = decideCiGate([check("CodeRabbit", SHA3, "failure")]);
  assert.ok(typeof red === "object", "a failed bot check still blocks");
});

function gatewayConfig(): RepositoryConfigV1 {
  const config = createTargetConfigV1(
    createLocalRepositoryConfig(),
    { owner: "ubiquity", name: "ai.ubq.fi", slug: "ubiquity/ai.ubq.fi" },
    "development",
  );
  return { ...config, repository: { ...REPO } };
}

function grant(): string {
  return JSON.stringify({
    version: 1,
    appId: 4682172,
    installationId: INSTALLATION,
    appSlug: "ubiquity-sentinel",
    expiresAt: new Date(T0 + 30 * 86_400_000).toISOString().replace(
      ".000Z",
      "Z",
    ),
    permissions: { contents: "write", actions: "write" },
    repositoryIds: [1116191389],
    repositoryNames: ["ai.ubq.fi"],
  });
}

Deno.test("CI first: a head with only a skipped CodeRabbit check waits unreviewed, the pre-merge dispatcher sends its one dispatch, and a green dispatched run lets the review proceed", async () => {
  const { rig, setChecks } = await ciFirstRig("cf-review-bot", {
    hosted: true,
    checks: { [SHA3]: botOnly(SHA3) },
  });
  try {
    await rig.run();
    const waiting = await rig.snapshot();
    let work = taskRecord(waiting);
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.equal(work.wait?.reason, "ci_pending");
    assert.equal(reviewCharges(waiting).length, 0, "nothing charged");

    // The trusted host's pre-merge dispatcher reads that exact state.
    const config = gatewayConfig();
    assert.deepEqual(
      pendingPremergeRecords(waiting.work, config).map((record) =>
        record.target.pr
      ),
      [7],
    );
    const state = new MemoryState();
    state.repair = waiting;
    const http = new ScriptedHttp();
    let dispatched = false;
    http.on("GET", `${REPO_PATH}/pulls/7`, () =>
      response(200, {
        number: 7,
        state: "open",
        merged: false,
        user: { login: APP_LOGIN },
        head: {
          sha: SHA3,
          ref: BRANCH,
          repo: { full_name: "ubiquity/ai.ubq.fi" },
        },
        base: { sha: SHA1, ref: "development" },
      }));
    http.on("GET", RUNS_PATH, (request: HttpRequestV1) => {
      assert.equal(new URL(request.url).searchParams.get("head_sha"), SHA3);
      return response(200, {
        total_count: dispatched ? 1 : 0,
        workflow_runs: dispatched
          ? [{ id: 1, head_sha: SHA3, status: "queued" }]
          : [],
      });
    });
    http.on("POST", DISPATCH_PATH, () => {
      dispatched = true;
      return response(204, "");
    });
    const clock = new FakeClock(rig.clock.now());
    const report = await dispatchPremergeCi({
      http: http.transport,
      clock,
      state,
      gate: new FakeGate(),
      token: "target-token",
      mintGrant: grant(),
      installationId: INSTALLATION,
      trustedAuthor: APP_LOGIN,
      deadline: clock.now() + 60 * 60_000,
      log: () => {},
    }, config);
    assert.equal(report.decision, "dispatched");
    assert.deepEqual(report.decisions, ["7:dispatched:confirmed"]);
    assert.deepEqual(JSON.parse(http.posts()[0].body ?? "null"), {
      ref: BRANCH,
      inputs: {
        base_ref: "development",
        sentinel_pr_author: APP_LOGIN,
        scope_base: SHA1,
      },
    });

    // The dispatched Gateway CI run lands green on the exact head.
    setChecks(SHA3, [
      ...botOnly(SHA3),
      ...GATEWAY_JOBS.map((name) => check(name, SHA3, "success")),
    ]);
    rig.clock.advance(5 * 60_000 + 1);
    await rig.run();
    const after = await rig.snapshot();
    work = taskRecord(after);
    assert.equal(work.nextStep, "review");
    assert.equal(reviewCharges(after).length, 1);
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("delivery: a reviewed head whose only check is a skipped CodeRabbit is never merged; it waits on CI", async () => {
  const { rig } = await ciFirstRig("cf-review-bot-merge", {
    checks: { [SHA3]: botOnly(SHA3) },
    reviewed: true,
    reviewRounds: 1,
    nextStep: "delivery",
  });
  try {
    await rig.run();
    const work = taskRecord(await rig.snapshot());
    assert.equal(rig.github.calls.includes("merge"), false);
    assert.equal(work.nextStep, "delivery");
    assert.equal(work.wait?.reason, "ci_pending");
    assert.equal(work.blocker, null);
  } finally {
    await rig.ctx.cleanup();
  }
});
