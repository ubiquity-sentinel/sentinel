// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import {
  parseMetricsSample,
  parseReleaseRecordV1,
} from "../../src/contracts/mod.ts";
import { tryParse } from "../../src/contracts/validation.ts";
import { readFixture } from "./record-fixtures.ts";

Deno.test("accepted release record persists identity/window/coverage evidence", async () => {
  const record = parseReleaseRecordV1(
    await readFixture("valid", "release-record-accepted-v1.json"),
  );
  assert.equal(record.phase, "accepted");
  assert.ok(record.acceptance?.passed);
  const baseline = record.acceptance!.baseline[0];
  assert.equal(baseline.identity.revisionId, "dep-0000");
  assert.equal(baseline.coverage.status, "complete");
  assert.ok(
    record.acceptance!.samples.every(
      (s) =>
        s.windowStart < s.windowEnd && s.windowEnd <= s.sampledAt &&
        s.coverage.status === "complete" &&
        s.identity.revisionId === "dep-0001",
    ),
  );
});

Deno.test("metrics samples: exact identity/window/coverage plus bounded counts", () => {
  const identity = {
    gitSha: "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d",
    revisionId: "dep-0001",
  };
  const sample = parseMetricsSample(
    {
      identity,
      windowStart: 1786000070000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: 100,
      fiveXxCount: 1,
      timeoutCount: 0,
      streamFailureCount: 0,
      upstreamWideFault: false,
      coverage: { status: "complete" },
    },
    "$",
  );
  assert.equal(sample.requestCount, 100);
  assert.equal(sample.identity.gitSha, identity.gitSha);
  assert.equal(sample.windowEnd, 1786000100000);
  assert.equal(sample.coverage.status, "complete");
  // A window must satisfy windowStart < windowEnd <= sampledAt.
  const inverted = tryParse(
    (input) => parseMetricsSample(input, "$"),
    {
      identity,
      windowStart: 1786000100000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: 100,
      fiveXxCount: 0,
      timeoutCount: 0,
      streamFailureCount: 0,
      upstreamWideFault: false,
      coverage: { status: "complete" },
    },
  );
  assert.equal(inverted.ok, false);
  if (!inverted.ok) assert.equal(inverted.issues[0]?.path, "$.windowEnd");
  const afterEnd = tryParse(
    (input) => parseMetricsSample(input, "$"),
    {
      identity,
      windowStart: 1786000120000,
      windowEnd: 1786000150000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: 100,
      fiveXxCount: 0,
      timeoutCount: 0,
      streamFailureCount: 0,
      upstreamWideFault: false,
      coverage: { status: "complete" },
    },
  );
  assert.equal(afterEnd.ok, false);
  if (!afterEnd.ok) assert.equal(afterEnd.issues[0]?.path, "$.sampledAt");
  // A count above the denominator is a corrupted sample.
  const over = tryParse(
    (input) => parseMetricsSample(input, "$"),
    {
      identity,
      windowStart: 1786000070000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: 10,
      fiveXxCount: 11,
      timeoutCount: 0,
      streamFailureCount: 0,
      upstreamWideFault: false,
      coverage: { status: "complete" },
    },
  );
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.issues[0]?.path, "$.fiveXxCount");
  // Missing denominator must not masquerade as a 0-rate sample.
  const missing = tryParse(
    (input) => parseMetricsSample(input, "$"),
    {
      identity,
      windowStart: 1786000070000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: null,
      fiveXxCount: 0,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
      coverage: { status: "complete" },
    },
  );
  assert.equal(missing.ok, false);
  // Fully missing telemetry is explicit nulls; identity/window/coverage persist.
  const unavailable = parseMetricsSample(
    {
      identity,
      windowStart: 1786000070000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: null,
      fiveXxCount: null,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
      coverage: {
        status: "incomplete",
        reason: "source lag",
        nextCursor: "p-1",
      },
    },
    "$",
  );
  assert.equal(unavailable.requestCount, null);
  assert.equal(unavailable.upstreamWideFault, null);
  assert.equal(unavailable.identity.revisionId, "dep-0001");
  assert.equal(unavailable.coverage.status, "incomplete");
});

Deno.test("accepted release telemetry binds every sample and baseline to exact identities", async () => {
  const raw = (await readFixture(
    "valid",
    "release-record-accepted-v1.json",
  )) as Record<string, unknown>;
  const acceptance = raw.acceptance as {
    samples: Record<string, unknown>[];
    baseline: Record<string, unknown>[];
  };
  const baseline = acceptance.baseline[0].identity as Record<
    string,
    unknown
  >;
  const sample = acceptance.samples[0].identity as Record<string, unknown>;
  const wrongSample = structuredClone(raw);
  ((wrongSample.acceptance as { samples: Record<string, unknown>[] }).samples[0]
    .identity as Record<string, unknown>).gitSha = "0".repeat(40);
  const wrongSha = tryParse(parseReleaseRecordV1, wrongSample);
  assert.equal(wrongSha.ok, false);
  if (!wrongSha.ok) {
    assert.equal(wrongSha.issues[0]?.path, "$.acceptance.samples[0].identity");
  }
  const wrongRev = structuredClone(raw);
  ((wrongRev.acceptance as { samples: Record<string, unknown>[] }).samples[0]
    .identity as Record<string, unknown>).revisionId = "dep-other";
  const wrongRevision = tryParse(parseReleaseRecordV1, wrongRev);
  assert.equal(wrongRevision.ok, false);
  if (!wrongRevision.ok) {
    assert.equal(
      wrongRevision.issues[0]?.path,
      "$.acceptance.samples[0].identity",
    );
  }
  const wrongBaseline = structuredClone(raw);
  ((wrongBaseline.acceptance as { baseline: Record<string, unknown>[] })
    .baseline[0].identity as Record<string, unknown>).revisionId = "dep-other";
  const wrongBaselineRevision = tryParse(parseReleaseRecordV1, wrongBaseline);
  assert.equal(wrongBaselineRevision.ok, false);
  if (!wrongBaselineRevision.ok) {
    assert.equal(
      wrongBaselineRevision.issues[0]?.path,
      "$.acceptance.baseline[0].identity",
    );
  }
  // Sanity: the untouched fixture still parses.
  assert.equal(tryParse(parseReleaseRecordV1, raw).ok, true);
  assert.equal(baseline.gitSha, "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00");
  assert.equal(sample.gitSha, "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d");
});

Deno.test("incomplete coverage is persistable for passed:false diagnostics only", async () => {
  const raw = (await readFixture(
    "invalid",
    "release-incomplete-coverage.json",
  )) as Record<string, unknown>;
  // passed:true with incomplete coverage stays invalid.
  assert.equal(tryParse(parseReleaseRecordV1, raw).ok, false);
  // A diagnostic acceptance (passed:false) persists the incomplete evidence.
  const diagnostic = structuredClone(raw);
  diagnostic.phase = "monitoring";
  (diagnostic.acceptance as Record<string, unknown>).passed = false;
  const persisted = tryParse(parseReleaseRecordV1, diagnostic);
  assert.equal(persisted.ok, true);
});
