import assert from "node:assert/strict";
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../../src/contracts/canonical.ts";
import { parseBranchRuleWire } from "../../src/github/wire.ts";
import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import { createHostedQueueAuthority } from "../../ops/hosted-autonomy-queue-authority.ts";
import { decideQueuePolicy } from "../../ops/hosted-autonomy-queue-policy.ts";
import { compileQueueRulesProjection } from "../../ops/queue-rules-projection.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
} from "../github/helpers.ts";
import { authorityRig } from "./merge-queue-authority-fixtures.ts";
import {
  capture,
  type CaptureFixture,
  detail,
  http,
  inventoryRow,
  NOW,
  projectionFixture,
  repinSynthetic,
  ROOT,
  stagedDetail,
} from "./queue-rules-projection-fixtures.ts";

Deno.test("queue projection: synthetic accepted captures produce only a fully bound expectation", async () => {
  const fixture = await projectionFixture();
  const result = await compileQueueRulesProjection(
    fixture.input,
    fixture.profile,
  );
  assert.equal(result.status, "prepared");
  if (result.status !== "prepared") return;
  const expected = stagedDetail(fixture.input.staged[1]!).rules.map((rule) =>
    parseBranchRuleWire({
      ...rule,
      ruleset_id: 900_004,
      ruleset_source_type: "Repository",
      ruleset_source: "ubiquity/ai.ubq.fi",
    }, "$test")
  ).sort((a, b) => canonicalStringify(a).localeCompare(canonicalStringify(b)));
  assert.deepEqual(result.expectation.expectedActiveRules, expected);
  assert.equal(
    result.expectation.effectiveRulesSha256,
    await canonicalStringifySha256(expected),
  );
  assert.equal(result.expectation.canonicalRules, canonicalStringify(expected));
  assert.equal(result.expectation.status, "expectation_only");
  assert.equal(result.expectation.expectedActiveRules[0]!.id, null);
  assert.equal(result.expectation.expectedActiveRules[0]!.name, null);
  assert.deepEqual(
    result.expectation.conditions,
    stagedDetail(fixture.input.staged[1]!).conditions,
  );
  assert.deepEqual(result.expectation.bypassActors, []);
  assert.deepEqual(result.expectation.identity, fixture.profile.identity);
  assert.deepEqual(
    result.expectation.acceptedCanaryCaptureSha256,
    fixture.profile.canaryCaptureSha256,
  );
  assert.equal(result.expectation.observedInventory.length, 1);
  assert.equal(result.expectation.observedDetails.length, 1);
  assert.ok(
    Object.isFrozen(result.expectation.expectedActiveRules[0]!.parameters),
  );
  assert.equal(
    result.expectationSha256,
    await canonicalStringifySha256({
      domain: "sentinel.queue-rules-projection.v1",
      expectation: result.expectation,
    }),
  );
});

Deno.test("queue projection: no trusted profile means no expectation regardless of input", async () => {
  const fixture = await projectionFixture();
  assert.deepEqual(await compileQueueRulesProjection(fixture.input), {
    status: "unavailable",
    reason: "profile_unaccepted",
  });
  assert.equal(
    (await compileQueueRulesProjection({
      ...fixture.input,
      accepted: fixture.profile,
    })).status,
    "unavailable",
  );
});

type Fixture = Awaited<ReturnType<typeof projectionFixture>>;
type Mutation = (fixture: Fixture) => void;
Deno.test("queue projection: malformed policy and incomplete native observations refuse", async (t) => {
  const cases: [string, Mutation][] = [
    ["wrong branch", (f) => {
      stagedDetail(f.input.staged[0]!).conditions.ref_name.include = [
        "refs/heads/queue-canary",
      ];
    }],
    ["wildcard condition", (f) => {
      stagedDetail(f.input.staged[0]!).conditions.ref_name.include = [
        "refs/heads/*",
      ];
    }],
    ["special selector", (f) => {
      stagedDetail(f.input.staged[0]!).conditions.ref_name.include = [
        "~DEFAULT_BRANCH",
      ];
    }],
    ["exclude", (f) => {
      stagedDetail(f.input.staged[0]!).conditions.ref_name.exclude = [
        "refs/heads/development",
      ];
    }],
    ["unknown condition", (f) => {
      Object.assign(stagedDetail(f.input.staged[0]!).conditions, {
        repository_id: { repository_ids: [1] },
      });
    }],
    ["nested condition selector", (f) => {
      for (const capture of f.input.staged) {
        Reflect.set(stagedDetail(capture).conditions.ref_name, "include", [[
          "refs/heads/development",
        ]]);
      }
    }],
    ["array enforcement", (f) => {
      for (const capture of f.input.staged) {
        Reflect.set(stagedDetail(capture), "enforcement", ["disabled"]);
        Reflect.set((capture.inventory.body as object[])[0]!, "enforcement", [
          "disabled",
        ]);
      }
    }],
    ["missing conditions", (f) => {
      Reflect.deleteProperty(stagedDetail(f.input.staged[0]!), "conditions");
    }],
    ["mixed case Link", (f) => {
      f.input.staged[0]!.inventory.headers.lInK =
        '<https://api.github.com/next>; rel="next"';
    }],
    ["duplicate header case", (f) => {
      f.input.staged[0]!.inventory.headers.date =
        "Sun, 18 Oct 2026 00:00:00 GMT";
    }],
    ["page at bound", (f) => {
      f.input.staged[0]!.inventory.body = Array.from(
        { length: 100 },
        () => inventoryRow(detail("development", false)),
      );
    }],
    ["parent source", (f) => {
      stagedDetail(f.input.staged[0]!).source_type = "Organization";
    }],
    ["missing detail", (f) => {
      f.input.staged[0]!.details = [];
    }],
    ["duplicate inventory", (f) => {
      (f.input.staged[0]!.inventory.body as unknown[]).push(
        structuredClone((f.input.staged[0]!.inventory.body as unknown[])[0]),
      );
    }],
    ["wrong inventory name", (f) => {
      (f.input.staged[0]!.inventory.body as Record<string, unknown>[])[0]!
        .name = "other";
    }],
    ["wrong endpoint", (f) => {
      f.input.staged[0]!.details[0]!.path = `${ROOT}/rulesets/999`;
    }],
    ["non-200 response", (f) => {
      f.input.staged[0]!.inventory.status = 403;
    }],
    ["API version drift", (f) => {
      f.input.staged[0]!.effective.headers["X-GitHub-Api-Version-Selected"] =
        "unknown";
    }],
    ["relabelled old response", (f) => {
      f.input.staged[0]!.inventory.headers.Date =
        "Sat, 17 Oct 2026 00:00:00 GMT";
    }],
    ["future response", (f) => {
      f.input.staged[0]!.inventory.headers.Date =
        "Mon, 19 Oct 2026 00:00:00 GMT";
    }],
    ["malformed metadata", (f) => {
      Object.assign(stagedDetail(f.input.staged[0]!), { node_id: [] });
    }],
    ["foreign metadata link", (f) => {
      Object.assign(stagedDetail(f.input.staged[0]!), {
        _links: { self: { href: "https://example.com" } },
      });
    }],
    ["unknown rule field", (f) => {
      Object.assign(stagedDetail(f.input.staged[0]!).rules[0]!, {
        extra: true,
      });
    }],
    ["unknown queue default", (f) => {
      Object.assign(stagedDetail(f.input.staged[0]!).rules[0]!.parameters!, {
        invented: false,
      });
    }],
    ["omitted queue parameter", (f) => {
      Reflect.deleteProperty(
        stagedDetail(f.input.staged[0]!).rules[0]!.parameters!,
        "merge_method",
      );
    }],
    ["duplicate rule", (f) => {
      const r = stagedDetail(f.input.staged[0]!).rules;
      r[3] = structuredClone(r[2]!);
    }],
    ["App bypass", (f) => {
      stagedDetail(f.input.staged[0]!).current_user_can_bypass = "always";
    }],
    ["unknown bypass", (f) => {
      Reflect.deleteProperty(
        stagedDetail(f.input.staged[0]!),
        "current_user_can_bypass",
      );
    }],
    ["owner bypass unsupported", (f) => {
      stagedDetail(f.input.staged[0]!).bypass_actors = [{
        actor_type: "User",
        actor_id: 900_005,
        bypass_mode: "always",
      }];
    }],
    ["wrong credential identity", (f) => {
      f.input.staged[0]!.identity.app.login = "some-owner";
    }],
    ["wrong installation", (f) => {
      f.input.staged[0]!.identity.repository.installationId++;
    }],
    ["observed active staging", (f) => {
      f.input.staged = [
        capture("development", true, 6),
        capture("development", true, 7),
      ];
    }],
    ["stale staging", (f) => {
      f.input.staged[0]!.observedAt = f.profile.acceptedAt - 1;
    }],
    ["same repeated observation", (f) => {
      f.input.staged[1]!.observedAt = f.input.staged[0]!.observedAt;
    }],
    ["reused native request", (f) => {
      f.input.staged[1]!.inventory.headers["X-GitHub-Request-Id"] = f.input
        .staged[0]!.inventory.headers["X-GitHub-Request-Id"]!;
    }],
    ["different status App", (f) => {
      const checks = stagedDetail(f.input.staged[0]!).rules[1]!.parameters as {
        required_status_checks: { integration_id: number }[];
      };
      checks.required_status_checks[0]!.integration_id = 1;
    }],
    ["duplicate status check", (f) => {
      const checks = stagedDetail(f.input.staged[0]!).rules[1]!.parameters as {
        required_status_checks: { context: string }[];
      };
      checks.required_status_checks[0]!.context =
        checks.required_status_checks[1]!.context;
    }],
    ["staged drift", (f) => {
      stagedDetail(f.input.staged[1]!).name = "changed";
      (f.input.staged[1]!.inventory.body as Record<string, unknown>[])[0]!
        .name = "changed";
    }],
    ["canary hash mismatch", (f) => {
      f.input.canary[0]!.details[0]!.headers.Date = "changed";
    }],
    ["staged ID reused from canary", (f) => {
      f.input.staged[0]!.stagedRulesetId = 900_001;
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.step(name, async () => {
      const fixture = await projectionFixture();
      mutate(fixture);
      assert.equal(
        (await compileQueueRulesProjection(fixture.input, fixture.profile))
          .status,
        "unavailable",
        name,
      );
    });
  }
});

Deno.test("queue projection: matching hashes never waive native mapping validation", async (t) => {
  const cases: [string, Mutation][] = [
    ["swapped transitions", (f) => {
      [f.input.canary[0], f.input.canary[1]] = [
        f.input.canary[1]!,
        f.input.canary[0]!,
      ];
    }],
    ["active-only rule ID", (f) => {
      Object.assign((f.input.canary[1]!.effective.body as object[])[0]!, {
        id: 999,
      });
    }],
    ["present-null rule name", (f) => {
      Object.assign((f.input.canary[1]!.effective.body as object[])[0]!, {
        name: null,
      });
    }],
    ["native extra parameter", (f) => {
      Object.assign(
        (f.input.canary[1]!.effective.body as { parameters: object }[])[0]!
          .parameters,
        { active_default: false },
      );
    }],
    ["wrong source decoration", (f) => {
      (f.input.canary[1]!.effective.body as Record<string, unknown>[])[0]!
        .ruleset_id = 999;
    }],
    ["missing active rule", (f) => {
      (f.input.canary[1]!.effective.body as object[]).pop();
    }],
    ["disabled contributes active rule", (f) => {
      f.input.canary[0]!.effective.body = structuredClone(
        f.input.canary[1]!.effective.body,
      );
    }],
    ["reactivation changed ruleset name", (f) => {
      stagedDetail(f.input.canary[3]!).name = "new";
      (f.input.canary[3]!.inventory.body as Record<string, unknown>[])[0]!
        .name = "new";
    }],
  ];
  for (const [name, mutate] of cases) {
    await t.step(name, async () => {
      const fixture = await projectionFixture();
      mutate(fixture);
      await repinSynthetic(fixture);
      assert.equal(
        (await compileQueueRulesProjection(fixture.input, fixture.profile))
          .status,
        "unavailable",
        name,
      );
    });
  }
});

function addCanary(capture: CaptureFixture, other: ReturnType<typeof detail>) {
  (capture.inventory.body as unknown[]).push(inventoryRow(other));
  capture.details.push(
    http(
      `${ROOT}/rulesets/${other.id}?includes_parents=true`,
      structuredClone(other),
      capture.observedAt - NOW,
    ),
  );
}
Deno.test("queue projection: accepted disjoint canary is retained, overlap and inherited drift refuse", async () => {
  const fixture = await projectionFixture();
  for (const capture of fixture.input.staged) {
    addCanary(capture, stagedDetail(fixture.input.canary[3]!));
  }
  const good = await compileQueueRulesProjection(
    fixture.input,
    fixture.profile,
  );
  assert.equal(good.status, "prepared");
  if (good.status === "prepared") {
    assert.equal(good.expectation.observedDetails.length, 2);
  }
  const disjoint = fixture.input.staged[1]!.details[1]!.body as ReturnType<
    typeof detail
  >;
  disjoint.conditions.ref_name.include = ["refs/heads/development"];
  assert.equal(
    (await compileQueueRulesProjection(fixture.input, fixture.profile)).status,
    "unavailable",
  );
  disjoint.conditions.ref_name.include = ["refs/heads/queue-canary"];
  disjoint.source_type = "Organization";
  assert.equal(
    (await compileQueueRulesProjection(fixture.input, fixture.profile)).status,
    "unavailable",
  );
});

Deno.test("queue projection: caller mutation during hashing cannot change captured policy or pins", async () => {
  const fixture = await projectionFixture();
  const pending = compileQueueRulesProjection(fixture.input, fixture.profile);
  stagedDetail(fixture.input.staged[1]!).conditions.ref_name.include = [
    "refs/heads/*",
  ];
  fixture.profile.canaryCaptureSha256 = [
    "f".repeat(64),
    "e".repeat(64),
    "d".repeat(64),
    "c".repeat(64),
  ];
  const result = await pending;
  assert.equal(result.status, "prepared");
  if (result.status === "prepared") {
    assert.deepEqual(result.expectation.conditions, {
      ref_name: { include: ["refs/heads/development"], exclude: [] },
    });
  }
  assert.equal(
    (await compileQueueRulesProjection(fixture.input, fixture.profile)).status,
    "unavailable",
  );
});

Deno.test("queue projection: raw response metadata remains bound even when projected rules are unchanged", async () => {
  const fixture = await projectionFixture();
  const before = await compileQueueRulesProjection(
    fixture.input,
    fixture.profile,
  );
  fixture.input.staged[1]!.inventory.headers["X-Trace-Observation"] =
    "different-capture";
  const after = await compileQueueRulesProjection(
    fixture.input,
    fixture.profile,
  );
  assert.equal(before.status, "prepared");
  assert.equal(after.status, "prepared");
  if (before.status !== "prepared" || after.status !== "prepared") return;
  assert.equal(
    before.expectation.effectiveRulesSha256,
    after.expectation.effectiveRulesSha256,
  );
  assert.notEqual(
    before.expectation.stagedCaptureSha256[1],
    after.expectation.stagedCaptureSha256[1],
  );
  assert.notEqual(before.expectationSha256, after.expectationSha256);
});

Deno.test("queue projection: invalid JSON and bounded input refuse without evaluating getters", async () => {
  const fixture = await projectionFixture();
  let getterCalls = 0;
  const hostile = Object.defineProperty({}, "canary", {
    enumerable: true,
    get() {
      getterCalls++;
      return fixture.input.canary;
    },
  });
  assert.equal(
    (await compileQueueRulesProjection(hostile, fixture.profile)).status,
    "unavailable",
  );
  assert.equal(getterCalls, 0);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(
    (await compileQueueRulesProjection(cyclic, fixture.profile)).status,
    "unavailable",
  );
  assert.equal(
    (await compileQueueRulesProjection({
      canary: "x".repeat(2_000_001),
      staged: [],
    }, fixture.profile)).status,
    "unavailable",
  );
});

Deno.test("queue projection: current native parser and actual authority still require actual active rules", async () => {
  const fixture = await projectionFixture();
  const result = await compileQueueRulesProjection(
    fixture.input,
    fixture.profile,
  );
  assert.equal(result.status, "prepared");
  if (result.status !== "prepared") return;
  const rig = await authorityRig();
  rig.pins.effectiveRulesSha256 = result.expectation.effectiveRulesSha256;
  let active = false;
  const body = capture("development", true, 8).effective.body;
  const client = new GitHubQueueDeliveryClient({
    repository: rig.record.repository,
    apiBaseUrl: "https://api.github.com",
    auth: new FakeAuthProvider(),
    clock: new FakeClock(),
    cooldownGate: new FakeCooldownGate(),
    http: (request) => {
      assert.ok(request.url.includes("/rules/branches/development"));
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify(active ? body : []),
      });
    },
  }, 42);
  rig.client.readBranchRules = client.readBranchRules.bind(client);
  const authority = createHostedQueueAuthority({
    ...rig.options,
    configuration: {
      mode: "on",
      proofActivated: true,
      policy: rig.policy,
      pins: rig.pins,
    },
  });
  const disabled = await authority.authorization.readAuthorization(
    rig.request(),
  );
  assert.equal(disabled.status, "complete");
  if (disabled.status === "complete") {
    assert.equal(decideQueuePolicy(disabled.value.facts).action, "hold");
  }
  active = true;
  const observed = await authority.authorization.readAuthorization(
    rig.request(),
  );
  assert.equal(observed.status, "complete");
  if (observed.status === "complete") {
    assert.equal(decideQueuePolicy(observed.value.facts).action, "enqueue");
  }
  (body as Record<string, unknown>[])[0]!.ruleset_id = 900_099;
  const drift = await authority.authorization.readAuthorization(rig.request());
  assert.equal(drift.status, "complete");
  if (drift.status === "complete") {
    assert.equal(decideQueuePolicy(drift.value.facts).action, "hold");
  }
});
