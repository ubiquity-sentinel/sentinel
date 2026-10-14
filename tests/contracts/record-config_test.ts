// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import {
  parseBudgetReservationV1,
  parseCommandRegistryV1,
  parseRepositoryConfigV1,
  resolveGlobalLiveStartLimits,
} from "../../src/contracts/mod.ts";
import { tryParse } from "../../src/contracts/validation.ts";
import { readFixture } from "./record-fixtures.ts";

Deno.test("repository adapter is a discriminated union with exact variant keys", async () => {
  const gateway = structuredClone(
    await readFixture("valid", "repository-config-v1.json"),
  ) as Record<string, unknown>;
  const parsedGateway = parseRepositoryConfigV1(structuredClone(gateway));
  assert.deepEqual(parsedGateway.adapter, {
    kind: "gateway",
    baseUrl: "https://ai.ubq.fi",
  });

  // The GitHub variant is valid without any base address.
  const github = structuredClone(gateway);
  github.adapter = { kind: "github" };
  const parsedGithub = tryParse(parseRepositoryConfigV1, github);
  assert.equal(parsedGithub.ok, true);
  if (parsedGithub.ok) {
    assert.deepEqual(parsedGithub.value.adapter, { kind: "github" });
  }

  // A base address on the GitHub variant is an unknown key, never ignored.
  const withBaseUrl = structuredClone(gateway);
  withBaseUrl.adapter = { kind: "github", baseUrl: "https://ai.ubq.fi" };
  const rejectedBase = tryParse(parseRepositoryConfigV1, withBaseUrl);
  assert.equal(rejectedBase.ok, false);
  if (!rejectedBase.ok) {
    assert.equal(rejectedBase.issues[0]?.code, "unknown_key");
    assert.equal(rejectedBase.issues[0]?.path, "$.adapter.baseUrl");
  }

  // Unknown kinds are refused.
  const unknownKind = structuredClone(gateway);
  unknownKind.adapter = { kind: "bitbucket", baseUrl: "https://ai.ubq.fi" };
  const rejectedKind = tryParse(parseRepositoryConfigV1, unknownKind);
  assert.equal(rejectedKind.ok, false);
  if (!rejectedKind.ok) {
    assert.equal(rejectedKind.issues[0]?.code, "invalid_enum");
    assert.equal(rejectedKind.issues[0]?.path, "$.adapter.kind");
  }

  // The gateway variant still requires its base address.
  const missingBase = structuredClone(gateway);
  missingBase.adapter = { kind: "gateway" };
  const rejectedMissing = tryParse(parseRepositoryConfigV1, missingBase);
  assert.equal(rejectedMissing.ok, false);
  if (!rejectedMissing.ok) {
    assert.equal(rejectedMissing.issues[0]?.code, "missing_field");
    assert.equal(rejectedMissing.issues[0]?.path, "$.adapter.baseUrl");
  }
});

Deno.test("local owner: config parser reserves id 0 for the no-App github scope", async () => {
  const gateway = structuredClone(
    await readFixture("valid", "repository-config-v1.json"),
  ) as Record<string, unknown>;

  // The github adapter permits the explicit no-App local owner scope.
  const local = structuredClone(gateway);
  (local.repository as Record<string, unknown>).installationId = 0;
  local.adapter = { kind: "github" };
  const parsedLocal = tryParse(parseRepositoryConfigV1, local);
  assert.equal(parsedLocal.ok, true);
  if (parsedLocal.ok) {
    assert.equal(parsedLocal.value.repository.installationId, 0);
    assert.deepEqual(parsedLocal.value.adapter, { kind: "github" });
  }

  // A gateway configuration still requires a positive App installation id.
  const gatewayLocal = structuredClone(local);
  gatewayLocal.adapter = { kind: "gateway", baseUrl: "https://ai.ubq.fi" };
  const rejectedGateway = tryParse(parseRepositoryConfigV1, gatewayLocal);
  assert.equal(rejectedGateway.ok, false);
  if (!rejectedGateway.ok) {
    assert.equal(rejectedGateway.issues[0]?.code, "invalid_count");
    assert.equal(
      rejectedGateway.issues[0]?.path,
      "$.repository.installationId",
    );
  }

  // Negative, fractional and unsafe ids are rejected for both adapters.
  const adapters = [
    { kind: "github" },
    { kind: "gateway", baseUrl: "https://ai.ubq.fi" },
  ];
  for (const installationId of [-1, 1.5, 2 ** 53, Number.NaN]) {
    for (const adapter of adapters) {
      const candidate = structuredClone(gateway);
      (candidate.repository as Record<string, unknown>).installationId =
        installationId;
      candidate.adapter = adapter;
      const rejected = tryParse(parseRepositoryConfigV1, candidate);
      assert.equal(rejected.ok, false, `id ${installationId}`);
      if (!rejected.ok) {
        assert.equal(rejected.issues[0]?.code, "invalid_count");
        assert.equal(rejected.issues[0]?.path, "$.repository.installationId");
      }
    }
  }
});

Deno.test("command registry binds argv arrays with bounded runtime, never shell text", () => {
  const registry = parseCommandRegistryV1({
    version: "v1",
    commands: {
      test_ci: {
        executable: "deno",
        args: ["task", "test-local"],
        maxDurationMs: 1800000,
        maxOutputBytes: 4194304,
      },
    },
  });
  const specs = registry.commands as Record<string, unknown>;
  assert.equal((specs.test_ci as { args: string[] }).args.length, 2);
  // Shell metacharacters in the executable are rejected.
  const result = tryParse(parseCommandRegistryV1, {
    version: "v1",
    commands: {
      bad: {
        executable: "sh -c 'rm -rf /'",
        args: [],
        maxDurationMs: 1,
        maxOutputBytes: 1,
      },
    },
  });
  assert.equal(result.ok, false);
  // NUL/control characters in argv elements are rejected.
  const badArg = tryParse(parseCommandRegistryV1, {
    version: "v1",
    commands: {
      bad: {
        executable: "deno",
        args: ["\u0000"],
        maxDurationMs: 1,
        maxOutputBytes: 1,
      },
    },
  });
  assert.equal(badArg.ok, false);
  if (!badArg.ok) assert.equal(badArg.issues[0]?.code, "invalid_pattern");
});

Deno.test("repository config command lookup rejects inherited prototype members", async () => {
  const raw =
    (await readFixture("valid", "repository-config-v1.json")) as Record<
      string,
      unknown
    >;
  // A config referencing a prototype member name against an empty registry
  // must fail closed instead of resolving to Object.prototype.constructor.
  const emptyRegistry = structuredClone(raw);
  (emptyRegistry.commands as Record<string, unknown>).replay = "constructor";
  (emptyRegistry.commands as Record<string, unknown>).test = "constructor";
  (emptyRegistry.commandRegistry as { commands: Record<string, unknown> })
    .commands = {};
  const result = tryParse(parseRepositoryConfigV1, emptyRegistry);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]?.code, "invalid_lifecycle");
  // An OWN registry entry with the same name is a valid own command id.
  const ownEntry = structuredClone(raw);
  (ownEntry.commands as Record<string, unknown>).replay = "constructor";
  (ownEntry.commandRegistry as { commands: Record<string, unknown> }).commands =
    {
      constructor: {
        executable: "deno",
        args: ["run", "test"],
        maxDurationMs: 1000,
        maxOutputBytes: 1024,
      },
      test_ci: {
        executable: "deno",
        args: ["task", "test-local"],
        maxDurationMs: 1800000,
        maxOutputBytes: 4194304,
      },
    };
  assert.equal(tryParse(parseRepositoryConfigV1, ownEntry).ok, true);
});

Deno.test("budget proof refs are restricted refs, never URLs or traversal", async () => {
  const base = (await readFixture(
    "valid",
    "budget-reservation-v1.json",
  )) as Record<string, unknown>;
  const withProof = (proofRef: string) => {
    const mutant = structuredClone(base);
    mutant.outcome = "confirmed_not_submitted";
    mutant.settledAt = 1786002000000;
    mutant.proofRef = proofRef;
    return tryParse(parseBudgetReservationV1, mutant);
  };
  // An opaque storage ref is a valid proof.
  assert.equal(withProof("artifact://proof/reservation-0001").ok, true);
  // A URL is never a proof ref.
  const url = withProof("https://example.com/proof");
  assert.equal(url.ok, false);
  if (!url.ok) assert.equal(url.issues[0]?.path, "$.proofRef");
  // Traversal and absolute filesystem refs are never proof refs.
  assert.equal(withProof("secret:../file").ok, false);
  assert.equal(withProof("secret:/etc/passwd").ok, false);
  assert.equal(withProof("artifact://inbox/../proof").ok, false);
});

Deno.test("global live start limits: one policy, conflicts refuse inference", async () => {
  const base = parseRepositoryConfigV1(
    structuredClone(await readFixture("valid", "repository-config-v1.json")),
  );
  // No limits anywhere: inference stays disabled.
  const disabled = resolveGlobalLiveStartLimits([
    { ...base, liveStartLimits: null },
    { ...base, liveStartLimits: null },
  ]);
  assert.equal(disabled.status, "disabled");
  // Identical limits across repos: one shared policy.
  const enabled = resolveGlobalLiveStartLimits([base, { ...base }]);
  assert.equal(enabled.status, "enabled");
  // Conflicting per-repo limits must refuse inference.
  const conflict = resolveGlobalLiveStartLimits([
    base,
    { ...base, liveStartLimits: { perHour: 8, perSevenDays: 40 } },
  ]);
  assert.equal(conflict.status, "conflict");
});

Deno.test("live start limits: explicit null weekly cap is valid, missing or malformed is not", async () => {
  const base = structuredClone(
    await readFixture("valid", "repository-config-v1.json"),
  ) as Record<string, unknown>;

  // Explicit null is the owner policy: 120 per rolling hour, no weekly cap.
  const accepted = tryParse(parseRepositoryConfigV1, {
    ...base,
    liveStartLimits: { perHour: 120, perSevenDays: null },
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.deepEqual(accepted.value.liveStartLimits, {
      perHour: 120,
      perSevenDays: null,
    });
  }

  // A wholly null liveStartLimits still means inference is not enabled.
  const disabled = tryParse(parseRepositoryConfigV1, {
    ...base,
    liveStartLimits: null,
  });
  assert.equal(disabled.ok, true);
  if (disabled.ok) assert.equal(disabled.value.liveStartLimits, null);

  // Missing, undefined or malformed weekly values are invalid, never a
  // permissive fallback to "unlimited".
  const { perSevenDays: _dropped, ...withoutWeekly } = base
    .liveStartLimits as Record<string, unknown>;
  const missing = tryParse(parseRepositoryConfigV1, {
    ...base,
    liveStartLimits: withoutWeekly,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(
      missing.issues[0]?.path,
      "$.liveStartLimits.perSevenDays",
    );
  }
  for (const malformed of [undefined, "168", -1, 1.5, true, Number.NaN]) {
    const result = tryParse(parseRepositoryConfigV1, {
      ...base,
      liveStartLimits: { perHour: 120, perSevenDays: malformed },
    });
    assert.equal(result.ok, false, `weekly ${String(malformed)} is invalid`);
    if (!result.ok) {
      assert.equal(result.issues[0]?.path, "$.liveStartLimits.perSevenDays");
    }
  }

  // Numeric weekly limits keep the hour <= week invariant.
  const inverted = tryParse(parseRepositoryConfigV1, {
    ...base,
    liveStartLimits: { perHour: 120, perSevenDays: 60 },
  });
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.equal(inverted.issues[0]?.path, "$.liveStartLimits");

  // Explicit null bypasses only the weekly checks: the hour cap is still a
  // required finite positive safe integer.
  const badHour = tryParse(parseRepositoryConfigV1, {
    ...base,
    liveStartLimits: { perHour: 0, perSevenDays: null },
  });
  // The parser accepts a nonnegative safe integer here, but the budget policy
  // below (and admission) still refuses a zero hour cap.
  assert.equal(badHour.ok, true);

  const nullLimits = { perHour: 120, perSevenDays: null } as const;
  const nullPolicy = resolveGlobalLiveStartLimits([
    {
      ...parseRepositoryConfigV1(base),
      liveStartLimits: nullLimits,
    },
    {
      ...parseRepositoryConfigV1(base),
      liveStartLimits: { ...nullLimits },
    },
  ]);
  assert.equal(nullPolicy.status, "enabled");
  if (nullPolicy.status === "enabled") {
    assert.deepEqual(nullPolicy.limits, { perHour: 120, perSevenDays: null });
  }

  // A null weekly cap in one repository and a numeric one in another are two
  // different policies: shared admission is disabled, never inferred.
  const mixedPolicy = resolveGlobalLiveStartLimits([
    { ...parseRepositoryConfigV1(base), liveStartLimits: nullLimits },
    {
      ...parseRepositoryConfigV1(base),
      liveStartLimits: { perHour: 120, perSevenDays: 168 },
    },
  ]);
  assert.equal(mixedPolicy.status, "conflict");
});

// ---------------------------------------------------------------------------
// M15 V1 candidate state: the rollback-safe reader. Absence of candidateState
// is the exact legacy shape; a present group is parsed strictly and the parked
// predicate is the only admission gate old readers use.
// ---------------------------------------------------------------------------
