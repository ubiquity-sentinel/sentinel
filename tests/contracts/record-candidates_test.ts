// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  hasCandidateState,
  parseWorkRecordV1,
} from "../../src/contracts/mod.ts";
import {
  CANDIDATE_BASE,
  CANDIDATE_BASE_REFRESH_KEY,
  CANDIDATE_HEAD,
  candidateWorkRaw,
  expectRejected,
  OTHER_CANDIDATE_SHA,
  preservedDescriptor,
  PRODUCING_RESERVATION,
  rawLegacyWork,
} from "./record-candidate-fixtures.ts";

Deno.test("candidate state: absence is the exact legacy shape", async () => {
  const raw = await rawLegacyWork();
  const parsed = parseWorkRecordV1(raw);
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.target, "candidateState"),
    false,
    "the parsed legacy target must not gain a candidateState key",
  );
  assert.equal(hasCandidateState(parsed), false);
  // The stored legacy bytes still round-trip exactly: no default was injected.
  assert.equal(canonicalStringify(parsed), canonicalStringify(raw));
});

Deno.test("candidate state: exact new shape round-trips canonical bytes", async () => {
  const raw = await candidateWorkRaw();
  const parsed = parseWorkRecordV1(raw);
  assert.deepEqual(parsed.target.candidateState, {
    preserved: preservedDescriptor(),
    publishedHead: CANDIDATE_HEAD,
  });
  assert.equal(hasCandidateState(parsed), true);
  assert.equal(canonicalStringify(parsed), canonicalStringify(raw));

  // The other admitted producing-operation key form, the exact base-refresh
  // identity, parses and round-trips byte-preserving as well.
  const baseRefreshRaw = await candidateWorkRaw((_target, candidateState) => {
    (candidateState.preserved as Record<string, unknown>).operationKey =
      CANDIDATE_BASE_REFRESH_KEY;
  });
  const baseRefresh = parseWorkRecordV1(baseRefreshRaw);
  assert.deepEqual(baseRefresh.target.candidateState, {
    preserved: {
      ...preservedDescriptor(),
      operationKey: CANDIDATE_BASE_REFRESH_KEY,
    },
    publishedHead: CANDIDATE_HEAD,
  });
  assert.equal(hasCandidateState(baseRefresh), true);
  assert.equal(
    canonicalStringify(baseRefresh),
    canonicalStringify(baseRefreshRaw),
  );

  // Null-preserved parked work is valid, round-trips, and is still parked:
  // preserved === null is never treated as "no candidate state".
  const nullPreservedRaw = await candidateWorkRaw((_target, candidateState) => {
    candidateState.preserved = null;
    candidateState.publishedHead = null;
  });
  const nullPreserved = parseWorkRecordV1(nullPreservedRaw);
  assert.deepEqual(nullPreserved.target.candidateState, {
    preserved: null,
    publishedHead: null,
  });
  assert.equal(hasCandidateState(nullPreserved), true);
  assert.equal(
    canonicalStringify(nullPreserved),
    canonicalStringify(nullPreservedRaw),
  );
});

Deno.test("candidate state: malformed groups, keys and bindings reject", async () => {
  const cases: {
    name: string;
    raw: Record<string, unknown>;
    code: string;
    path?: string;
  }[] = [
    {
      name: "null group",
      raw: await candidateWorkRaw((target) => {
        target.candidateState = null;
      }),
      code: "wrong_type",
      path: "$.target.candidateState",
    },
    {
      name: "present undefined group",
      raw: await candidateWorkRaw((target) => {
        target.candidateState = undefined;
      }),
      code: "missing_field",
      path: "$.target.candidateState",
    },
    {
      name: "partial group",
      raw: await candidateWorkRaw((_target, group) => {
        delete group.publishedHead;
      }),
      code: "missing_field",
      path: "$.target.candidateState.publishedHead",
    },
    {
      name: "unknown group key",
      raw: await candidateWorkRaw((_target, group) => {
        group.preservation = {};
      }),
      code: "unknown_key",
      path: "$.target.candidateState.preservation",
    },
    {
      name: "partial descriptor",
      raw: await candidateWorkRaw((_target, group) => {
        delete (group.preserved as Record<string, unknown>).ref;
      }),
      code: "missing_field",
      path: "$.target.candidateState.preserved.ref",
    },
    {
      name: "unknown descriptor key",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).detail = "free text";
      }),
      code: "unknown_key",
      path: "$.target.candidateState.preserved.detail",
    },
    {
      name: "empty operation key",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey = "";
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "unbounded operation key",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey = "x".repeat(
          257,
        );
      }),
      code: "bound_exceeded",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "unknown nonempty operation key",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `review:7:${CANDIDATE_HEAD}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "impl reservation id too short",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey = `impl:${
          "cd".repeat(31)
        }`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "impl reservation id uppercase",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey = `impl:${
          "CD".repeat(32)
        }`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "impl key suffix",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `impl:${PRODUCING_RESERVATION}:extra`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "impl key newline suffix",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `impl:${PRODUCING_RESERVATION}\n`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh zero pr",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:0:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh negative pr",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:-1:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh leading-zero pr",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:07:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh noninteger pr",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:1.5:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh unsafe pr",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:9007199254740993:${CANDIDATE_HEAD}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh short old head",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:7:${CANDIDATE_HEAD.slice(1)}:${CANDIDATE_BASE}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh uppercase new base",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:7:${CANDIDATE_HEAD}:${CANDIDATE_BASE.toUpperCase()}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh missing new base",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:7:${CANDIDATE_HEAD}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh extra component",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:7:${CANDIDATE_HEAD}:${CANDIDATE_BASE}:extra`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh newline suffix",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).operationKey =
          `base_refresh:7:${CANDIDATE_HEAD}:${CANDIDATE_BASE}\n`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.operationKey",
    },
    {
      name: "base refresh descriptor head binding still enforced",
      raw: await candidateWorkRaw((_target, group) => {
        const preserved = group.preserved as Record<string, unknown>;
        preserved.operationKey = CANDIDATE_BASE_REFRESH_KEY;
        preserved.head = OTHER_CANDIDATE_SHA;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState.preserved",
    },
    {
      name: "wrong ref namespace",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).ref =
          `refs/heads/sentinel/${"ab".repeat(32)}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.ref",
    },
    {
      name: "uppercase ref digest",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).ref =
          `refs/heads/sentinel-candidates/${"AB".repeat(32)}`;
      }),
      code: "invalid_pattern",
      path: "$.target.candidateState.preserved.ref",
    },
    {
      name: "publishedHead not a sha",
      raw: await candidateWorkRaw((_target, group) => {
        group.publishedHead = "deadbeef";
      }),
      code: "invalid_sha",
      path: "$.target.candidateState.publishedHead",
    },
    {
      name: "preserved base mismatch",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).base = OTHER_CANDIDATE_SHA;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState.preserved",
    },
    {
      name: "preserved head mismatch",
      raw: await candidateWorkRaw((_target, group) => {
        (group.preserved as Record<string, unknown>).head = OTHER_CANDIDATE_SHA;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState.preserved",
    },
    {
      name: "null target branch",
      raw: await candidateWorkRaw((target) => {
        target.branch = null;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState",
    },
    {
      name: "null target head with publishedHead",
      raw: await candidateWorkRaw((target, group) => {
        target.head = null;
        group.preserved = null;
        group.publishedHead = CANDIDATE_HEAD;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState",
    },
    {
      name: "null target head with preserved descriptor",
      raw: await candidateWorkRaw((target) => {
        target.head = null;
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState.preserved",
    },
    {
      name: "unknown target key",
      raw: await candidateWorkRaw((target) => {
        target.candidate_state = { preserved: null, publishedHead: null };
      }),
      code: "unknown_key",
      path: "$.target.candidate_state",
    },
  ];
  for (const testCase of cases) {
    expectRejected(testCase.raw, testCase.code, testCase.path, testCase.name);
  }
});

Deno.test("candidate state: the parking predicate ignores unrelated intents", async () => {
  const raw = await rawLegacyWork();
  raw.intent = {
    kind: "implementation",
    key: `impl:${PRODUCING_RESERVATION}`,
    startedAt: 1786000000000,
    branch: null,
    expectedHead: null,
    observedBase: null,
    pr: null,
    requestId: PRODUCING_RESERVATION,
    resultId: null,
  };
  const parsed = parseWorkRecordV1(raw);
  assert.equal(parsed.target.candidateState, undefined);
  assert.equal(hasCandidateState(parsed), false);
});

// --- additive intent failure record ------------------------------------------
// `failure` is the only additive intent key: a row written before it existed
// reads back without it (never as an injected default), a complete record
// round-trips exactly, and every malformed shape is rejected.
