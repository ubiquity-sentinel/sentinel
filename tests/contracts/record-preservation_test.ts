// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  hasCandidateState,
  parseWorkRecordV1,
} from "../../src/contracts/mod.ts";
import {
  CANDIDATE_BASE_REFRESH_KEY,
  CANDIDATE_BRANCH,
  CANDIDATE_HEAD,
  expectRejected,
  OTHER_CANDIDATE_SHA,
  preservationIntentRaw,
  preservedDescriptor,
  rawLegacyWork,
  validPreservationIntent,
} from "./record-candidate-fixtures.ts";

Deno.test("candidate preservation intent: valid shape parses and parks", async () => {
  const raw = await preservationIntentRaw();
  const parsed = parseWorkRecordV1(raw);
  assert.equal(parsed.intent?.kind, "candidate_preservation");
  assert.equal(parsed.target.candidateState?.preserved, null);
  assert.equal(hasCandidateState(parsed), true);
  assert.equal(canonicalStringify(parsed), canonicalStringify(raw));
});

Deno.test("candidate preservation intent: mismatches and bad identities reject", async () => {
  const otherReservation = "ef".repeat(32);
  const intentWith = (
    overrides: Record<string, unknown>,
  ): Record<string, unknown> => ({
    ...validPreservationIntent(),
    ...overrides,
  });
  const cases: {
    name: string;
    raw: Record<string, unknown>;
    code: string;
    path?: string;
  }[] = [
    {
      name: "not a producing key",
      raw: await preservationIntentRaw({
        intent: intentWith({ key: `push:${CANDIDATE_HEAD}` }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.key",
    },
    {
      name: "base_refresh descriptor key is not an implementation intent key",
      raw: await preservationIntentRaw({
        intent: intentWith({ key: CANDIDATE_BASE_REFRESH_KEY }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.key",
    },
    {
      name: "nonhex reservation id in key",
      raw: await preservationIntentRaw({
        intent: intentWith({ key: "impl:not-a-reservation" }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.key",
    },
    {
      name: "missing requestId",
      raw: await preservationIntentRaw({
        intent: intentWith({ requestId: null }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.requestId",
    },
    {
      name: "requestId does not match the key",
      raw: await preservationIntentRaw({
        intent: intentWith({ requestId: otherReservation }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.requestId",
    },
    {
      name: "branch is the candidate branch, not the preservation ref",
      raw: await preservationIntentRaw({
        intent: intentWith({ branch: CANDIDATE_BRANCH }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.branch",
    },
    {
      name: "uppercase preservation ref",
      raw: await preservationIntentRaw({
        intent: intentWith({
          branch: `refs/heads/sentinel-candidates/${"AB".repeat(32)}`,
        }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.branch",
    },
    {
      name: "null expectedHead",
      raw: await preservationIntentRaw({
        intent: intentWith({ expectedHead: null }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.expectedHead",
    },
    {
      name: "null observedBase",
      raw: await preservationIntentRaw({
        intent: intentWith({ observedBase: null }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.observedBase",
    },
    {
      name: "pr must be null",
      raw: await preservationIntentRaw({ intent: intentWith({ pr: 7 }) }),
      code: "invalid_lifecycle",
      path: "$.intent.pr",
    },
    {
      name: "resultId must be null",
      raw: await preservationIntentRaw({
        intent: intentWith({ resultId: CANDIDATE_HEAD }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.resultId",
    },
    {
      name: "unknown intent key",
      raw: await preservationIntentRaw({
        intent: intentWith({ detail: "free text" }),
      }),
      code: "unknown_key",
      path: "$.intent.detail",
    },
    {
      name: "candidateState absent",
      raw: await preservationIntentRaw({ omitCandidateState: true }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState",
    },
    {
      name: "preserved descriptor already present",
      raw: await preservationIntentRaw({
        candidateState: {
          preserved: preservedDescriptor(),
          publishedHead: CANDIDATE_HEAD,
        },
      }),
      code: "invalid_lifecycle",
      path: "$.target.candidateState.preserved",
    },
    {
      name: "expectedHead differs from target.head",
      raw: await preservationIntentRaw({
        intent: intentWith({ expectedHead: OTHER_CANDIDATE_SHA }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.expectedHead",
    },
    {
      name: "observedBase differs from target.base",
      raw: await preservationIntentRaw({
        intent: intentWith({ observedBase: OTHER_CANDIDATE_SHA }),
      }),
      code: "invalid_lifecycle",
      path: "$.intent.observedBase",
    },
  ];
  for (const testCase of cases) {
    expectRejected(testCase.raw, testCase.code, testCase.path, testCase.name);
  }
});

const INTENT_FAILURE_RECORD = {
  kind: "unavailable",
  detail: "base refresh port unavailable",
  atMs: 1786000000000,
  attempts: 3,
};

Deno.test("intent failure record: absent key is the exact legacy shape", async () => {
  const raw = await preservationIntentRaw();
  const parsed = parseWorkRecordV1(raw);
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.intent, "failure"),
    false,
    "a legacy intent must not gain a failure key",
  );
  assert.equal(canonicalStringify(parsed), canonicalStringify(raw));
  assert.equal(parsed.intent?.failure, undefined);
});

Deno.test("intent failure record: a complete record parses and round-trips", async () => {
  const raw = await preservationIntentRaw({
    intent: {
      ...validPreservationIntent(),
      failure: INTENT_FAILURE_RECORD,
    },
  });
  const parsed = parseWorkRecordV1(raw);
  assert.deepEqual(parsed.intent?.failure, INTENT_FAILURE_RECORD);
  assert.equal(parsed.intent?.failure?.attempts, 3);
  assert.equal(canonicalStringify(parsed), canonicalStringify(raw));
});

Deno.test("intent failure record: malformed records reject", async () => {
  const intentWith = (
    failure: unknown,
  ): Record<string, unknown> => ({
    ...validPreservationIntent(),
    failure,
  });
  const cases: {
    name: string;
    raw: Record<string, unknown>;
    code: string;
    path?: string;
  }[] = [
    {
      name: "unknown nested key",
      raw: await preservationIntentRaw({
        intent: intentWith({ ...INTENT_FAILURE_RECORD, reason: "raw text" }),
      }),
      code: "unknown_key",
      path: "$.intent.failure.reason",
    },
    {
      name: "missing attempts",
      raw: await preservationIntentRaw({
        intent: intentWith({
          kind: INTENT_FAILURE_RECORD.kind,
          detail: INTENT_FAILURE_RECORD.detail,
          atMs: INTENT_FAILURE_RECORD.atMs,
        }),
      }),
      code: "missing_field",
      path: "$.intent.failure.attempts",
    },
    {
      name: "zero attempts",
      raw: await preservationIntentRaw({
        intent: intentWith({ ...INTENT_FAILURE_RECORD, attempts: 0 }),
      }),
      code: "invalid_count",
      path: "$.intent.failure.attempts",
    },
    {
      name: "empty kind",
      raw: await preservationIntentRaw({
        intent: intentWith({ ...INTENT_FAILURE_RECORD, kind: "" }),
      }),
      code: "invalid_pattern",
      path: "$.intent.failure.kind",
    },
    {
      name: "free-text detail over the bound",
      raw: await preservationIntentRaw({
        intent: intentWith({
          ...INTENT_FAILURE_RECORD,
          detail: "x".repeat(4097),
        }),
      }),
      code: "bound_exceeded",
      path: "$.intent.failure.detail",
    },
    {
      name: "negative timestamp",
      raw: await preservationIntentRaw({
        intent: intentWith({ ...INTENT_FAILURE_RECORD, atMs: -1 }),
      }),
      code: "invalid_timestamp",
      path: "$.intent.failure.atMs",
    },
    {
      name: "explicit null failure",
      raw: await preservationIntentRaw({
        intent: intentWith(null),
      }),
      code: "wrong_type",
      path: "$.intent.failure",
    },
  ];
  for (const testCase of cases) {
    expectRejected(testCase.raw, testCase.code, testCase.path, testCase.name);
  }
});

// --- additive no-progress counter --------------------------------------------
// `counters.stalled` is the per-record no-progress budget the selector reads.
// It follows the same additive rule as the intent failure record: absent means
// zero and stays absent, present must be an exact count, and no default is
// injected.

function countersOf(raw: Record<string, unknown>): Record<string, unknown> {
  const counters = raw.counters;
  if (counters === null || typeof counters !== "object") {
    throw new Error("fixture has no counters group");
  }
  return counters as Record<string, unknown>;
}

Deno.test("no-progress counter: absent is the exact legacy shape", async () => {
  const raw = await rawLegacyWork();
  const parsed = parseWorkRecordV1(raw);
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed.counters, "stalled"),
    false,
    "a legacy counter group must not gain the additive key",
  );
  assert.equal(parsed.counters.stalled, undefined);
  assert.equal(canonicalStringify(parsed), canonicalStringify(raw));
});

Deno.test("no-progress counter: a present count parses and round-trips", async () => {
  const raw = await rawLegacyWork();
  countersOf(raw).stalled = 3;
  const parsed = parseWorkRecordV1(raw);
  assert.equal(parsed.counters.stalled, 3);
  assert.equal(canonicalStringify(parsed), canonicalStringify(raw));
});

Deno.test("no-progress counter: malformed values reject", async () => {
  const cases: {
    name: string;
    value: (counters: Record<string, unknown>) => void;
    code: string;
    path: string;
  }[] = [
    {
      name: "negative",
      value: (counters) => counters.stalled = -1,
      code: "invalid_count",
      path: "$.counters.stalled",
    },
    {
      name: "fractional",
      value: (counters) => counters.stalled = 1.5,
      code: "invalid_count",
      path: "$.counters.stalled",
    },
    {
      name: "string",
      value: (counters) => counters.stalled = "3",
      code: "invalid_count",
      path: "$.counters.stalled",
    },
    {
      name: "misspelled key",
      value: (counters) => counters.stall = 1,
      code: "unknown_key",
      path: "$.counters.stall",
    },
  ];
  for (const testCase of cases) {
    const raw = await rawLegacyWork();
    testCase.value(countersOf(raw));
    expectRejected(raw, testCase.code, testCase.path, testCase.name);
  }
});
