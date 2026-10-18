import assert from "node:assert/strict";
import { runQueueCanary } from "../../ops/queue-canary.ts";
import { rig } from "./queue-canary-fixtures.ts";
import { collectorRig } from "./queue-projection-collector-fixtures.ts";
import { sanitizedCanaryArtifact } from "../../ops/queue-canary-main.ts";
import {
  CANARY_GRANTS,
  CANARY_REPOSITORY,
} from "../../ops/queue-canary-pins.ts";
import { createQueueProjectionGet } from "../../ops/queue-rules-projection-read.ts";
import { createDeadline } from "../../src/github/http.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
} from "../github/helpers.ts";
import {
  type AcceptedQueueRulesProjectionProfile,
  compileQueueRulesProjection,
  queueRulesCaptureSha256,
} from "../../ops/queue-rules-projection.ts";
import type { HttpRequestV1, HttpResponseV1 } from "../../src/github/http.ts";
import type { JsonObject } from "../../ops/queue-rules-projection-input.ts";

Deno.test("projection source grant cannot fall through to ordinary canary observation", async () => {
  const r = await rig();
  r.host.action = "preflight";
  Object.assign(r.grants[0], {
    projectionTargets: [{ branch: "queue-canary", stagedRulesetId: 900_001 }],
  });
  const result = await runQueueCanary(r);
  assert.equal(result.status, "refused");
  assert.equal(result.reason, "projection_reader_unavailable");
  assert.equal(r.events.includes("observe"), false);
});

Deno.test("real App collector retains disabled explicit IDs, conditions, safe headers and exact body bytes", async () => {
  const r = await collectorRig();
  const evidence = await r.run();
  assert.equal(
    evidence.status,
    "observed",
    JSON.stringify(evidence.projection),
  );
  assert.equal(evidence.reason, "projection_observation");
  const projection = evidence.projection;
  assert.equal(projection?.status, "collected");
  if (projection?.status !== "collected") return;
  assert.equal(evidence.before, null);
  assert.equal(evidence.outcome, null);
  assert.equal(projection.expectationOnly, true);
  assert.equal(projection.source.sha, r.host.sha);
  assert.equal(projection.sourceDigest, evidence.requestDigest);
  assert.equal(projection.identityReads.length, 4);
  assert.equal(projection.targets.length, 1);
  const pair = projection.targets[0].captures;
  assert.equal(pair.length, 2);
  for (const capture of pair) {
    const detailed = (capture.details as JsonObject[])[0].body as JsonObject;
    assert.equal(detailed.enforcement, "disabled");
    assert.deepEqual(detailed.conditions, r.rulesets[0].conditions);
    assert.deepEqual((capture.effective as JsonObject).body, []);
  }
  assert.notEqual(pair[0].observedAt, pair[1].observedAt);
  assert.notEqual(
    projection.targets[0].captureSha256[0],
    projection.targets[0].captureSha256[1],
  );
  assert.equal(
    r.requests.filter((r) => r.url.includes("/rulesets/900001?")).length,
    2,
  );
  assert(
    r.requests.filter((r) => r.url.includes("/rulesets")).every((r) =>
      r.url.includes("includes_parents=true")
    ),
  );
  for (const raw of projection.rawResponses) {
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(raw.bodyBase64.join("")), (c) => c.charCodeAt(0)),
    );
    assert(r.bodies.includes(decoded));
    const hash = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(decoded),
        ),
      ),
    ].map((v) => v.toString(16).padStart(2, "0")).join("");
    assert.equal(raw.bodySha256, hash);
    assert.equal(raw.headers.etag, '"synthetic-etag"');
    assert(
      raw.headers.date && raw.headers["x-github-request-id"] &&
        raw.headers["x-github-api-version-selected"],
    );
    assert(!Object.hasOwn(raw.headers, "authorization"));
    assert(!Object.hasOwn(raw.headers, "set-cookie"));
  }
  assert.deepEqual(sanitizedCanaryArtifact(evidence), evidence);
  assert(!JSON.stringify(evidence).includes("synthetic-private"));
  assert.equal(CANARY_GRANTS.length, 0);
});

Deno.test("native HTTP capture construction feeds the unchanged pure D-A-D-A compiler", async () => {
  const canary: JsonObject[] = [];
  let finalNow = 0;
  for (let phase = 0; phase < 4; phase++) {
    const r = await collectorRig({ phase, active: phase % 2 === 1 });
    const result = (await r.run()).projection;
    assert.equal(result?.status, "collected", JSON.stringify(result));
    if (result?.status !== "collected") return;
    canary.push(result.targets[0].captures[0]);
    finalNow = r.now();
  }
  const r = await collectorRig({ branch: "development", phase: 6, both: true });
  const result = (await r.run()).projection;
  assert.equal(result?.status, "collected");
  if (result?.status !== "collected") return;
  const profile = {
    domain: "sentinel.queue-rules-profile.v1" as const,
    compilerRevision: r.host.sha,
    captureSourceRevision: r.host.sha,
    identity: result
      .identity as unknown as AcceptedQueueRulesProjectionProfile["identity"],
    acceptedAt: finalNow + 1,
    canaryCaptureSha256: await Promise.all(
      canary.map(queueRulesCaptureSha256),
    ) as [string, string, string, string],
  };
  const compiled = await compileQueueRulesProjection({
    canary,
    staged: result.targets[0].captures,
  }, profile);
  assert.equal(compiled.status, "prepared");
  if (compiled.status === "prepared") {
    assert.equal(compiled.expectation.status, "expectation_only");
    assert.equal(compiled.expectation.stagedRulesetId, 900_004);
  }
  assert.equal(
    (await compileQueueRulesProjection({
      canary,
      staged: result.targets[0].captures,
    })).status,
    "unavailable",
  );
});

Deno.test("two source targets retain every inventory object and bounded large raw bytes", async () => {
  const r = await collectorRig({
    both: true,
    mutate: (res, req) => {
      if (req.url.includes("/users/")) {
        change(res, (b) => {
          b.metadata = Array.from(
            { length: 150 },
            () => "public-synthetic-metadata".repeat(3),
          );
        });
      }
    },
  });
  r.grants[0].projectionTargets = [
    { branch: "queue-canary", stagedRulesetId: 900_001 },
    { branch: "development", stagedRulesetId: 900_004 },
  ];
  const result = (await r.run()).projection;
  assert.equal(result?.status, "collected", JSON.stringify(result));
  if (result?.status !== "collected") return;
  assert.equal(result.targets.length, 2);
  assert.equal(result.rawResponses.length, 20);
  assert(
    result.targets.every((g) =>
      g.captures.every((c) => (c.details as unknown[]).length === 2)
    ),
  );
  assert(result.rawResponses.some((raw) => raw.bodyBase64.length > 3));
  assert.deepEqual(sanitizedCanaryArtifact(result), result);
});

Deno.test("collector refuses a nonadvancing observation clock instead of inventing fresh time", async () => {
  const r = await collectorRig({ frozenClock: true });
  assert.deepEqual((await r.run()).projection, {
    status: "unavailable",
    reason: "clock_not_advanced",
  });
});

Deno.test("inventory cannot change between two individually stable target pairs", async () => {
  const r = await collectorRig({
    both: true,
    mutate: (res, req, count) => {
      if (count > 12 && req.url.includes("/rulesets")) {
        const body = JSON.parse(res.bodyText);
        for (const row of Array.isArray(body) ? body : [body]) {
          row.name += " changed";
        }
        res.bodyText = JSON.stringify(body);
      }
    },
  });
  r.grants[0].projectionTargets = [
    { branch: "queue-canary", stagedRulesetId: 900_001 },
    { branch: "development", stagedRulesetId: 900_004 },
  ];
  assert.deepEqual((await r.run()).projection, {
    status: "unavailable",
    reason: "inventory_drift",
  });
});

Deno.test("projection transport exposes no write method or arbitrary endpoint", async () => {
  let calls = 0;
  const get = createQueueProjectionGet({
    repository: CANARY_REPOSITORY,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    clock: new FakeClock(),
    cooldownGate: new FakeCooldownGate(),
    http: () => {
      calls++;
      return Promise.reject(new Error("unexpected HTTP"));
    },
  });
  const deadline = createDeadline(1000);
  try {
    for (
      const path of [
        "https://foreign.example",
        "/repos/foreign/repo/rulesets",
        "/repos/ubiquity/ai.ubq.fi/pulls/7/queue",
        "/repos/ubiquity/ai.ubq.fi/rulesets/900001?includes_parents=false",
        "/repos/ubiquity/ai.ubq.fi/rulesets?includes_parents=true&per_page=100&page=2",
      ]
    ) {
      await assert.rejects(get(path, deadline));
    }
    assert.equal(typeof get, "function");
    assert.equal(calls, 0);
  } finally {
    deadline.dispose();
  }
});

type Mutation = (
  response: HttpResponseV1,
  request: HttpRequestV1,
  count: number,
) => void;
function change(
  response: HttpResponseV1,
  fn: (body: Record<string, unknown>) => void,
) {
  const body = JSON.parse(response.bodyText);
  fn(body);
  response.bodyText = JSON.stringify(body);
}
Deno.test("collector refuses partial, unsafe, replayed, drifting and foreign native observations", async (t) => {
  const cases: [string, Mutation][] = [
    ["credential-shaped raw identity field", (res, req) => {
      if (req.responseType && req.url.includes("/users/")) {
        change(res, (b) => {
          b.private_key = "synthetic-private";
        });
      }
    }],
    ["HTTP forbidden", (res, req) => {
      if (req.responseType) res.status = 403;
    }],
    ["pagination", (res, req) => {
      if (req.responseType) {
        res.headers.set("LiNk", "<https://api.github.com/next>; rel=next");
      }
    }],
    ["missing version", (res, req) => {
      if (req.responseType) res.headers.delete("x-github-api-version-selected");
    }],
    ["missing date", (res, req) => {
      if (req.responseType) res.headers.delete("date");
    }],
    ["replayed request ID", (res, req) => {
      if (req.responseType) res.headers.set("x-github-request-id", "replayed");
    }],
    ["stale response", (res, req) => {
      if (req.responseType) {
        res.headers.set("date", "Thu, 01 Jan 1970 00:00:00 GMT");
      }
    }],
    ["unsafe retained header", (res, req) => {
      if (req.responseType) res.headers.set("etag", "token=synthetic-private");
    }],
    ["malformed JSON", (res, req) => {
      if (req.responseType) res.bodyText = "{";
    }],
    ["duplicate JSON key", (res, req) => {
      if (req.responseType) res.bodyText = '{"total_count":1,"total_count":2}';
    }],
    ["invalid UTF8", (res, req) => {
      if (req.responseType) res.bodyBytes = new Uint8Array([0xff]);
    }],
    ["response bound", (res, req) => {
      if (req.responseType) res.bodyText = " ".repeat(256_001);
    }],
    ["broader installation", (res, req) => {
      if (req.responseType && req.url.includes("/installation/")) {
        change(res, (b) => {
          b.total_count = 2;
        });
      }
    }],
    ["foreign repository ID", (res, req) => {
      if (req.responseType && req.url.includes("/installation/")) {
        change(res, (b) => {
          (b.repositories as JsonObject[])[0].id = 999;
        });
      }
    }],
    ["foreign actor", (res, req) => {
      if (req.responseType && req.url.includes("/users/")) {
        change(res, (b) => {
          b.node_id = "FOREIGN";
        });
      }
    }],
    ["missing staged ID", (res, req) => {
      if (req.url.includes("/rulesets?")) res.bodyText = "[]";
    }],
    ["inherited inventory", (res, req) => {
      if (req.url.includes("/rulesets?")) {
        const b = JSON.parse(res.bodyText);
        b[0].source_type = "Organization";
        res.bodyText = JSON.stringify(b);
      }
    }],
    ["missing conditions", (res, req) => {
      if (req.url.includes("/rulesets/900001?")) {
        change(res, (b) => {
          delete b.conditions;
        });
      }
    }],
    ["unknown policy field", (res, req) => {
      if (req.url.includes("/rulesets/900001?")) {
        change(res, (b) => {
          b.unexplained_policy = true;
        });
      }
    }],
    ["App bypass", (res, req) => {
      if (req.url.includes("/rulesets/900001?")) {
        change(res, (b) => {
          b.current_user_can_bypass = "always";
        });
      }
    }],
    ["secret-bearing raw policy", (res, req) => {
      if (req.url.includes("/rulesets/900001?")) {
        change(res, (b) => {
          b.name = "token=synthetic-private";
        });
      }
    }],
    ["repeat policy drift", (res, req, count) => {
      if (count > 7 && req.url.includes("/rulesets")) {
        const b = JSON.parse(res.bodyText);
        if (Array.isArray(b)) b[0].name = "drift";
        else b.name = "drift";
        res.bodyText = JSON.stringify(b);
      }
    }],
    ["identity changed after captures", (res, req, count) => {
      if (count > 10 && req.url.includes("/users/")) {
        change(res, (b) => {
          b.node_id = "FOREIGN";
        });
      }
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.step(name, async () => {
      const r = await collectorRig({ mutate });
      const result = await r.run();
      assert.equal(result.status, "refused");
      assert.equal(result.projection?.status, "unavailable");
      assert(!JSON.stringify(result).includes("synthetic-private"));
      assert(r.requests.every((request) => request.method === "GET"));
    });
  }
});

Deno.test("source capture scope remains GET-only and cannot be expanded by host inputs", async (t) => {
  for (const action of ["enqueue", "dequeue"] as const) {
    await t.step(action, async () => {
      const r = await collectorRig();
      r.host.action = action;
      const result = await r.run();
      assert.equal(result.reason, "projection_read_only");
      assert.equal(r.requests.length, 2);
    });
  }
  for (
    const mode of [
      "no grant",
      "wrong source",
      "wrong actor",
      "too many targets",
      "foreign branch",
    ] as const
  ) {
    await t.step(mode, async () => {
      const r = await collectorRig();
      if (mode === "no grant") r.grants.length = 0;
      if (mode === "wrong source") r.host.expectedSha = "0".repeat(40);
      if (mode === "wrong actor") r.grants[0].appActor.nodeId = "FOREIGN";
      if (mode === "too many targets") {
        Object.assign(r.grants[0], { projectionTargets: [1, 2, 3] });
      }
      if (mode === "foreign branch") {
        Object.assign(r.grants[0], {
          projectionTargets: [{ branch: "main", stagedRulesetId: 900_001 }],
        });
      }
      const result = await r.run();
      assert.equal(result.status, "refused");
      assert(r.requests.length <= 2);
    });
  }
});
