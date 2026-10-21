import assert from "node:assert/strict";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import { CanaryGitHub } from "../../ops/queue-canary-github.ts";
import { CANARY_REPOSITORY } from "../../ops/queue-canary-pins.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
} from "../github/helpers.ts";
import { response } from "../github/merge-queue-fixtures.ts";
import { canaryExitCode } from "../../ops/queue-canary-main.ts";
import { runQueueCanary } from "../../ops/queue-canary.ts";
import { nativeObservationFixture } from "./queue-canary-fixtures.ts";
import { ACTOR, GRANT, rig, SHA3 } from "./queue-canary-fixtures.ts";

function client(handler: (request: HttpRequestV1) => HttpResponseV1) {
  const requests: HttpRequestV1[] = [];
  const native = new CanaryGitHub({
    repository: CANARY_REPOSITORY,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    clock: new FakeClock(),
    cooldownGate: new FakeCooldownGate(),
    http: (request) => {
      requests.push(request);
      return Promise.resolve(handler(request));
    },
  }, "synthetic-host-read-token");
  return { native, requests };
}
Deno.test("canary authenticated identity rejects PAT endpoint refusal and broader token scope", async (t) => {
  for (
    const mode of [
      "valid",
      "private_app",
      "pat",
      "broad",
      "wrong_actor",
    ] as const
  ) {
    await t.step(mode, async () => {
      const { native, requests } = client((request) => {
        const path = new URL(request.url).pathname;
        if (path === "/installation/repositories") {
          return mode === "pat" ? response({}, 403) : response({
            total_count: mode === "broad" ? 2 : 1,
            repositories: [{ id: 222, full_name: "ubiquity/ai.ubq.fi" }],
          });
        }
        if (path === "/apps/ubiquity-sentinel") {
          return mode === "private_app" ? response({}, 404) : response({
            id: 4682172,
            slug: "ubiquity-sentinel",
          });
        }
        if (path === "/users/ubiquity-sentinel%5Bbot%5D") {
          return response({
            node_id: ACTOR.nodeId,
            login: mode === "wrong_actor" ? "owner" : ACTOR.login,
            type: mode === "wrong_actor" ? "User" : "Bot",
          });
        }
        throw new Error("unexpected API");
      });
      const observed = await native.identity();
      assert.equal(
        observed !== null,
        mode === "valid" || mode === "private_app",
      );
      assert(
        !requests.some((request) =>
          new URL(request.url).pathname.startsWith("/apps/")
        ),
      );
      assert(requests.every((request) => request.method === "GET"));
    });
  }
});
Deno.test("complete Actions history binds stable PR/H claim across earlier source failures", async (t) => {
  for (
    const mode of [
      "first",
      "prior_failed",
      "prior_cancelled",
      "missing",
      "partial",
      "rerun",
    ] as const
  ) {
    await t.step(mode, async () => {
      const r = await rig();
      const current = {
        id: r.host.runId,
        workflow_id: 99,
        run_attempt: mode === "rerun" ? 2 : 1,
        head_sha: SHA3,
        head_branch: "sentinel-supervisor",
        path: ".github/workflows/queue-canary.yml",
        event: "workflow_dispatch",
        display_title: `sentinel-queue-canary:enqueue:${r.host.bindingDigest}`,
      };
      const older = {
        ...current,
        id: 100,
        head_sha: "a".repeat(40),
        conclusion: mode === "prior_cancelled" ? "cancelled" : "failure",
      };
      const runs = mode.startsWith("prior_")
        ? [current, older]
        : mode === "missing"
        ? []
        : [current];
      const { native, requests } = client((request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/workflows/queue-canary.yml")) {
          return response({ id: 99, path: current.path, state: "active" });
        }
        if (url.pathname.endsWith(`/runs/${r.host.runId}`)) {
          return response(current);
        }
        if (url.pathname.endsWith("/workflows/99/runs")) {
          return response({
            total_count: mode === "partial" ? 999 : runs.length,
            workflow_runs: runs,
          });
        }
        throw new Error("unexpected API");
      });
      assert.equal(await native.firstDispatch(r.host), mode === "first");
      assert(
        requests.every((request) =>
          request.method === "GET" &&
          request.url.includes("/repos/Ubiquity-Sentinel/sentinel/actions/")
        ),
      );
    });
  }
});
Deno.test("canary mutation surface never sends development or target-branch administration effects", async () => {
  const { native, requests } = client(() =>
    response({ status: "enqueued", details: { message: "queued" } })
  );
  const forbidden = structuredClone(GRANT);
  forbidden.pull.baseRef = "development";
  assert.deepEqual(await native.enqueueCanary(forbidden), {
    status: "not_submitted",
    reason: "unsupported",
  });
  assert.equal(requests.length, 0);
  assert.deepEqual(await native.enqueueCanary(GRANT), {
    status: "hint_enqueued",
    requestId: null,
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://api.github.com/repos/ubiquity/ai.ubq.fi/pulls/7/merge-async",
  );
  assert.deepEqual(JSON.parse(requests[0].body!), {
    sha: GRANT.pull.head,
    merge_action: "merge_queue",
    bypass_rules: false,
  });
});
Deno.test("canary never falls back after a lost enqueue response", async () => {
  const { native, requests } = client(() => {
    throw new Error("lost response");
  });
  assert.deepEqual(await native.enqueueCanary(GRANT), {
    status: "ambiguous",
    requestId: null,
  });
  assert.equal(requests.length, 1);
});

Deno.test("prior artifact acceptance binds enqueue request, PR/head, source and native artifact digest", async (t) => {
  const r = await rig();
  const requestDigest = await canonicalStringifySha256({
    domain: "sentinel.queue-canary-request.v1",
    ...r.host,
  });
  for (
    const mode of [
      "accepted",
      "wrong_digest",
      "wrong_binding",
      "expired",
      "wrong_source",
    ] as const
  ) {
    await t.step(mode, async () => {
      const grant = structuredClone(GRANT);
      grant.prior = {
        runId: r.host.runId,
        sourceSha: SHA3,
        requestDigest,
        artifactId: 555,
        artifactDigest: "e".repeat(64),
        entryId: "ENTRY_CANARY",
        requestId: null,
      };
      const { native } = client((request) => {
        if (request.url.endsWith(`/runs/${r.host.runId}`)) {
          return response({
            id: r.host.runId,
            head_sha: mode === "wrong_source" ? "a".repeat(40) : SHA3,
            path: ".github/workflows/queue-canary.yml",
            head_branch: "sentinel-supervisor",
            event: "workflow_dispatch",
            run_attempt: 1,
            display_title: `sentinel-queue-canary:enqueue:${
              mode === "wrong_binding" ? "f".repeat(64) : r.host.bindingDigest
            }`,
          });
        }
        if (request.url.endsWith("/artifacts/555")) {
          return response({
            expired: mode === "expired",
            digest: `sha256:${
              mode === "wrong_digest" ? "f".repeat(64) : "e".repeat(64)
            }`,
            workflow_run: { id: r.host.runId, head_sha: SHA3 },
            name: `queue-canary-${r.host.runId}-1-${requestDigest}`,
          });
        }
        throw new Error("unexpected API");
      });
      assert.equal(await native.priorAccepted(grant), mode === "accepted");
    });
  }
});

Deno.test("native read-only canary distinguishes complete observations from unavailable HTTP facts", async (t) => {
  for (const action of ["preflight", "observe"] as const) {
    for (
      const mode of [
        "complete",
        "partial_timeline",
        "queue_unavailable",
        "workflow_truncated",
        "rules_unavailable",
        "bypass_unavailable",
        "checks_unavailable",
        "metadata_unavailable",
        "patch_unavailable",
        "red_ci",
      ] as const
    ) {
      await t.step(`${action}:${mode}`, async () => {
        const r = await rig();
        const fixture = await nativeObservationFixture(mode);
        const { native, requests } = client(fixture.handler);
        const result = await runQueueCanary({
          ...r,
          host: { ...r.host, action },
          grants: [fixture.grant],
          port: native,
        });
        const complete = mode === "complete" || mode === "red_ci";
        assert.equal(result.status, complete ? "observed" : "refused");
        assert.equal(canaryExitCode(result), complete ? 0 : 1);
        assert.equal(
          result.reason,
          complete ? "native_observation" : "observation_unavailable",
        );
        assert.equal(result.productionDeliveryProof, false);
        assert.equal(r.retained.length, 1);
        assert.equal(r.retained[0].requestDigest, result.requestDigest);
        assert(
          !requests.some((request) =>
            request.method === "PUT" ||
            (request.body !== null &&
              JSON.parse(request.body).query?.startsWith("mutation"))
          ),
        );
        if (mode === "partial_timeline") {
          assert.equal(result.before?.events.status, "invalid");
        }
      });
    }
  }
});
