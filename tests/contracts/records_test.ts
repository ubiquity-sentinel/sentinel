// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import {
  isEncryptedArtifactDigest,
  isFixtureDigest,
  isGitSha,
  isIncidentFingerprint,
  isSourceSnapshotDigest,
} from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  parseBudgetReservationV1,
  parseIncidentEvidenceV1,
  parseIncidentSummaryV1,
  parseReleaseRecordV1,
  parseReleaseRequestV1,
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
  parseReplayResultV1,
  parseRepositoryConfigV1,
  parseReviewReceiptV1,
  parseWorkRecordV1,
} from "../../src/contracts/mod.ts";
import type { ParseIssue } from "../../src/contracts/validation.ts";
import { tryParse } from "../../src/contracts/validation.ts";
import { readFixture } from "./record-fixtures.ts";

type ParserOf<T> = (input: unknown) => T;

const VALID: { file: string; parser: ParserOf<unknown> }[] = [
  { file: "repository-config-v1.json", parser: parseRepositoryConfigV1 },
  { file: "work-record-v1.json", parser: parseWorkRecordV1 },
  { file: "incident-summary-v1.json", parser: parseIncidentSummaryV1 },
  { file: "incident-evidence-v1.json", parser: parseIncidentEvidenceV1 },
  { file: "review-receipt-v1.json", parser: parseReviewReceiptV1 },
  { file: "budget-reservation-v1.json", parser: parseBudgetReservationV1 },
  { file: "replay-result-v1.json", parser: parseReplayResultV1 },
  { file: "release-request-v1.json", parser: parseReleaseRequestV1 },
  { file: "release-record-v1.json", parser: parseReleaseRecordV1 },
  {
    file: "release-record-accepted-v1.json",
    parser: parseReleaseRecordV1,
  },
  { file: "repair-state-snapshot-v1.json", parser: parseRepairStateSnapshotV1 },
  {
    file: "release-state-snapshot-v1.json",
    parser: parseReleaseStateSnapshotV1,
  },
];

const INVALID: {
  file: string;
  parser: ParserOf<unknown>;
  code: string;
  path?: string;
}[] = [
  {
    file: "unknown-key.json",
    parser: parseReleaseRequestV1,
    code: "unknown_key",
    path: "$.surprise",
  },
  {
    file: "nested-unknown-key.json",
    parser: parseRepositoryConfigV1,
    code: "unknown_key",
    path: "$.adapter.webhooks",
  },
  // digest confusion: a 40-hex Git SHA must never be accepted as a digest
  {
    file: "digest-confusion-fixture.json",
    parser: parseReplayResultV1,
    code: "invalid_digest",
    path: "$.fixture.digest",
  },
  {
    file: "digest-confusion-source.json",
    parser: parseWorkRecordV1,
    code: "invalid_digest",
    path: "$.sourceSnapshotDigest",
  },
  {
    file: "wrong-version.json",
    parser: parseWorkRecordV1,
    code: "invalid_version",
    path: "$.version",
  },
  // a completed review must carry a machine-verifiable result id
  {
    file: "missing-review-completion.json",
    parser: parseReviewReceiptV1,
    code: "invalid_lifecycle",
    path: "$.resultId",
  },
  {
    file: "bad-time.json",
    parser: parseWorkRecordV1,
    code: "invalid_lifecycle",
    path: "$.createdAt",
  },
  {
    file: "bad-count.json",
    parser: parseWorkRecordV1,
    code: "invalid_lifecycle",
    path: "$.counters.retries",
  },
  {
    file: "invalid-lifecycle-done-with-intent.json",
    parser: parseWorkRecordV1,
    code: "invalid_lifecycle",
    path: "$.intent",
  },
  {
    file: "invalid-lifecycle-acceptance-uncontinuous.json",
    parser: parseReleaseRecordV1,
    code: "invalid_lifecycle",
    path: "$.monitoring",
  },
  {
    file: "invalid-coverage.json",
    parser: parseIncidentSummaryV1,
    code: "unknown_key",
    path: "$.coverage.nextCursor",
  },
  {
    file: "invalid-budget-settlement.json",
    parser: parseBudgetReservationV1,
    code: "invalid_lifecycle",
    path: "$.settledAt",
  },
  {
    file: "invalid-replay-no-limitation.json",
    parser: parseReplayResultV1,
    code: "invalid_lifecycle",
    path: "$.limitations",
  },
  {
    file: "invalid-config-limits.json",
    parser: parseRepositoryConfigV1,
    code: "invalid_lifecycle",
    path: "$.liveStartLimits",
  },
  {
    file: "invalid-coercion.json",
    parser: parseWorkRecordV1,
    code: "invalid_count",
    path: "$.counters.attempts",
  },
  {
    file: "invalid-enum.json",
    parser: parseWorkRecordV1,
    code: "invalid_enum",
    path: "$.nextStep",
  },
  {
    file: "duplicate-work-id.json",
    parser: parseRepairStateSnapshotV1,
    code: "invalid_lifecycle",
    path: "$.work[1].id",
  },
  {
    file: "review-reviewer-mismatch.json",
    parser: parseReviewReceiptV1,
    code: "invalid_lifecycle",
    path: "$.observedReviewer",
  },
  {
    file: "resolved-without-evidence.json",
    parser: parseReviewReceiptV1,
    code: "invalid_lifecycle",
    path: "$.findings[1].resolutionEvidence",
  },
  {
    file: "secret-ref-url.json",
    parser: parseRepositoryConfigV1,
    code: "invalid_pattern",
    path: "$.secretRef",
  },
  {
    file: "secret-ref-traversal.json",
    parser: parseRepositoryConfigV1,
    code: "invalid_pattern",
    path: "$.secretRef",
  },
  {
    file: "secret-ref-filesystem.json",
    parser: parseRepositoryConfigV1,
    code: "invalid_pattern",
    path: "$.secretRef",
  },
  {
    file: "artifact-ref-http.json",
    parser: parseIncidentEvidenceV1,
    code: "invalid_pattern",
    path: "$.artifacts[0].ref",
  },
  {
    file: "artifact-ref-dot-segment.json",
    parser: parseIncidentEvidenceV1,
    code: "invalid_pattern",
    path: "$.artifacts[0].ref",
  },
  {
    file: "duplicate-artifact-ref.json",
    parser: parseIncidentEvidenceV1,
    code: "invalid_lifecycle",
    path: "$.artifacts[1].ref",
  },
  {
    file: "release-window-inverted.json",
    parser: parseReleaseRecordV1,
    code: "invalid_lifecycle",
    path: "$.acceptance.samples[0].windowEnd",
  },
  {
    file: "release-incomplete-coverage.json",
    parser: parseReleaseRecordV1,
    code: "invalid_lifecycle",
    path: "$.acceptance.samples[0].coverage",
  },
  {
    file: "intent-freeform-detail.json",
    parser: parseWorkRecordV1,
    code: "unknown_key",
    path: "$.intent.detail",
  },
];

for (const { file, parser } of VALID) {
  Deno.test(`valid fixture parses: ${file}`, async () => {
    const raw = await readFixture("valid", file);
    const result = tryParse(parser, raw);
    assert.ok(
      result.ok,
      `expected parse to succeed: ${
        JSON.stringify(result.ok === false ? result.issues[0] : null)
      }`,
    );
    if (result.ok) {
      // Parsed records are JSON-safe and survive canonicalization unchanged.
      assert.equal(canonicalStringify(result.value), canonicalStringify(raw));
    }
  });
}

for (const { file, parser, code, path } of INVALID) {
  Deno.test(`invalid fixture fails closed: ${file}`, async () => {
    const raw = await readFixture("invalid", file);
    const result = tryParse(parser, raw);
    assert.equal(result.ok, false, `expected rejection for ${file}`);
    if (!result.ok) {
      const issue = result.issues[0] as ParseIssue;
      assert.equal(issue.code, code);
      if (path) assert.equal(issue.path, path);
    }
  });
}

Deno.test("review receipt: absent task acceptance is the exact legacy shape", async () => {
  // The durable store writes `${canonicalStringify(record)}\n` and re-reads a
  // blob by strict-parsing it and re-canonicalizing the result; a receipt that
  // predates the semantic acceptance boundary carries no key at all and must
  // survive that byte comparison unchanged.
  const raw = (await readFixture("valid", "review-receipt-v1.json")) as Record<
    string,
    unknown
  >;
  delete raw.taskAcceptance;
  const text = `${canonicalStringify(raw)}\n`;
  const parsed = parseReviewReceiptV1(JSON.parse(text));
  assert.equal(
    Object.prototype.hasOwnProperty.call(parsed, "taskAcceptance"),
    false,
    "the legacy absence must not be decoded as an explicit null",
  );
  assert.equal(parsed.taskAcceptance ?? null, null);
  assert.equal(
    `${canonicalStringify(parsed)}\n`,
    text,
    "the stored legacy bytes must still verify as canonical",
  );
});

Deno.test("review receipt: explicit null and acceptance stay explicit", async () => {
  const raw = (await readFixture("valid", "review-receipt-v1.json")) as Record<
    string,
    unknown
  >;
  // The committed fixture carries an explicit null; it stays an own key.
  const nullReceipt = parseReviewReceiptV1(raw);
  assert.equal(
    Object.prototype.hasOwnProperty.call(nullReceipt, "taskAcceptance"),
    true,
  );
  assert.equal(nullReceipt.taskAcceptance, null);
  assert.equal(
    `${canonicalStringify(nullReceipt)}\n`,
    `${canonicalStringify(raw)}\n`,
  );

  // A valid explicit acceptance keeps its strict parsed identity and bytes.
  const acceptance = {
    issueNumber: 82,
    taskDigest: "a".repeat(64),
    verdict: "fulfilled",
    evidence: ["the candidate satisfies the source issue"],
  };
  raw.taskAcceptance = acceptance;
  const accepted = parseReviewReceiptV1(raw);
  assert.deepEqual(accepted.taskAcceptance, acceptance);
  assert.equal(
    `${canonicalStringify(accepted)}\n`,
    `${canonicalStringify(raw)}\n`,
  );
});

Deno.test("brands are preserved for every digest kind in the work record", async () => {
  const raw = await readFixture("valid", "work-record-v1.json");
  const parsed = parseWorkRecordV1(raw);
  assert.ok(isGitSha(parsed.failingRevision as string));
  assert.ok(isGitSha(parsed.controller.sha));
  assert.ok(isSourceSnapshotDigest(parsed.sourceSnapshotDigest as string));
  assert.ok(isIncidentFingerprint(parsed.fingerprint as string));
  const artifact = parsed.evidence.find((e) => e.kind === "incident_evidence");
  assert.ok(
    artifact && artifact.kind === "incident_evidence" &&
      isEncryptedArtifactDigest(artifact.digest),
  );
  const fixture = parsed.evidence.find((e) => e.kind === "fixture");
  assert.ok(
    fixture && fixture.kind === "fixture" && isFixtureDigest(fixture.digest),
  );
  // Digest confusion inside the evidence union is impossible by shape.
  assert.equal(
    parsed.evidence.find((e) => e.kind === "fixture")?.kind,
    "fixture",
  );
});

Deno.test("nested records validate inside snapshots, not just DTO shells", async () => {
  const raw = await readFixture("valid", "repair-state-snapshot-v1.json");
  const snapshot = parseRepairStateSnapshotV1(raw);
  assert.equal(snapshot.work.length, 1);
  assert.equal(snapshot.reviews.length, 1);
  assert.equal(snapshot.releaseRequests[0]?.status, "open");
  // A corrupted nested record fails the whole snapshot parse.
  const corrupted = structuredClone(raw) as Record<string, unknown>;
  (corrupted.work as Record<string, unknown>[])[0] = {
    ...(corrupted.work as Record<string, unknown>[])[0],
    nextStep: "DONE",
  };
  const result = tryParse(parseRepairStateSnapshotV1, corrupted);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]?.code, "invalid_enum");
});

Deno.test("generated mutants are rejected without committed fixtures", async () => {
  const raw = (await readFixture("valid", "work-record-v1.json")) as Record<
    string,
    unknown
  >;
  // unknown nested key under classification
  const mutant = structuredClone(raw);
  (mutant.classification as Record<string, unknown>).severity = "P0";
  (mutant.classification as Record<string, unknown>).fancy = "x";
  const result = tryParse(parseWorkRecordV1, mutant);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.issues[0]?.code, "unknown_key");

  // too many evidence refs hits the array bound
  const many = structuredClone(raw);
  many.evidence = Array.from({ length: 65 }, () => ({
    kind: "review_receipt",
    ref: "r",
  }));
  const tooMany = tryParse(parseWorkRecordV1, many);
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.equal(tooMany.issues[0]?.code, "bound_exceeded");
});

Deno.test("semantics surface exactly as documented", async () => {
  const config = parseRepositoryConfigV1(
    await readFixture("valid", "repository-config-v1.json"),
  );
  assert.equal(config.adapter.kind, "gateway");
  assert.equal(config.liveStartLimits?.perHour, 4);
  assert.equal(config.stabilityPolicy?.thresholds.length, 3);
  assert.equal(config.stabilityPolicy?.minRequests, 10);
  assert.ok(
    config.stabilityPolicy?.thresholds.every((t) => t.maxIncrease === 0.01),
  );
  assert.equal(
    config.commandRegistry.commands[config.commands.replay].executable,
    "deno",
  );
  assert.equal(
    config.secretRef,
    "secret://host/injected/sentinel-github-app",
  );

  const work = parseWorkRecordV1(
    await readFixture("valid", "work-record-v1.json"),
  );
  assert.equal(work.nextStep, "review");
  assert.equal(work.wait?.reason, "review_pending");
  assert.equal(work.intent, null);
  assert.equal(
    work.source.revision,
    "aafb7ee0598699bb7fb8a72ea133693ed64462da",
  );
  assert.equal(work.urgency.reproducible5xx, true);
  assert.deepEqual(work.dependencies, []);

  const receipt = parseReviewReceiptV1(
    await readFixture("valid", "review-receipt-v1.json"),
  );
  assert.equal(receipt.outcome, "completed");
  assert.deepEqual(receipt.unresolvedSeverities, ["P1"]);
  assert.equal(receipt.expectedReviewer, "chatgpt-codex-connector[bot]");
  assert.equal(receipt.observedReviewer, "chatgpt-codex-connector[bot]");
  assert.equal(receipt.findingsUncounted, 0);
  assert.equal(
    receipt.findings[1]?.resolutionEvidence?.authorizingIdentity,
    "human-owner",
  );
  assert.equal(
    receipt.pullRequest.head,
    "6dc35d06e757107b91eb58232bd15e5f671d79b4",
  );

  const budget = parseBudgetReservationV1(
    await readFixture("valid", "budget-reservation-v1.json"),
  );
  assert.equal(budget.outcome, "ambiguous"); // ambiguous stays charged
  assert.equal(budget.attempt, 1); // one-based: the first attempt

  const replay = parseReplayResultV1(
    await readFixture("valid", "replay-result-v1.json"),
  );
  assert.equal(replay.original.outcome, "failed");
  assert.equal(replay.original.failure?.intended, true);
  assert.equal(replay.candidate.outcome, "passed");
  assert.equal(replay.limitations.length, 0);

  const request = parseReleaseRequestV1(
    await readFixture("valid", "release-request-v1.json"),
  );
  assert.equal(request.revision, "a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d");

  const record = parseReleaseRecordV1(
    await readFixture("valid", "release-record-v1.json"),
  );
  assert.equal(record.phase, "monitoring");
  assert.equal(record.environment, "production");
  assert.equal(record.candidate.identity.gitSha, record.requestRevision);
  assert.equal(record.candidate.identity.revisionId, "dep-0001");
  assert.equal(record.prior.identity.revisionId, "dep-0000");
  assert.equal(record.observed.identity?.revisionId, "dep-0001");
});
