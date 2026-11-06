/**
 * Repair delta contract pieces (issue #328): artifact bytes, the repository
 * projection and the fan-out summary line.
 */
import assert from "node:assert/strict";
import {
  decodeRepairDeltaArtifactV1,
  encodeRepairDeltaArtifactV1,
  MAX_REPAIR_DELTA_BYTES,
  openRepairDeltaV1,
  repairProjectionDigestV1,
  sealRepairDeltaV1,
} from "../../src/contracts/repair-delta.ts";
import {
  FANOUT_SUMMARY_LINE_KIND,
  fanoutSummaryLine,
  parseFanoutSummaryLine,
} from "../../src/repair/fanout-summary-line.ts";
import { SHA1, T0 } from "../state/helpers.ts";
import { pendingArtifact, REPOS, seeded } from "./repository-pass-rig.ts";

const [ALPHA, BETA] = REPOS;
const BINDING = { runId: 41, runAttempt: 1, planDigest: "a".repeat(64) };

Deno.test("repair delta: sealed artifact bytes round trip and oversized bytes are refused unread", async () => {
  const record = pendingArtifact(ALPHA, 1);
  const envelope = await sealRepairDeltaV1({
    version: "v1",
    kind: "repair_delta",
    repository: ALPHA,
    binding: BINDING,
    baseHead: SHA1,
    baseDigest: "b".repeat(64),
    transitions: [{ before: "c".repeat(64), after: record }],
    deferredToTrusted: ["issue-alpha-9"],
    startedAt: T0,
    finishedAt: T0 + 5,
  });
  const decoded = decodeRepairDeltaArtifactV1(
    encodeRepairDeltaArtifactV1(envelope),
  );
  const opened = await openRepairDeltaV1(decoded, {
    binding: BINDING,
    repository: ALPHA,
  });
  assert.ok(opened.ok);
  assert.deepEqual(opened.delta, envelope.delta);
  assert.equal(
    decodeRepairDeltaArtifactV1(new Uint8Array(MAX_REPAIR_DELTA_BYTES + 1)),
    null,
  );
  assert.equal(
    decodeRepairDeltaArtifactV1(new TextEncoder().encode("{")),
    null,
  );
  // The advisory step summary is optional, sealed and strictly parsed.
  const stepped = await sealRepairDeltaV1({
    ...envelope.delta,
    steps: [{
      record: "issue-alpha-1",
      kind: "work:unavailable",
      disposition: "kept",
      elapsedMs: 12,
    }],
  });
  const reopened = await openRepairDeltaV1(
    decodeRepairDeltaArtifactV1(encodeRepairDeltaArtifactV1(stepped)),
    { binding: BINDING, repository: ALPHA },
  );
  assert.ok(reopened.ok);
  assert.deepEqual(reopened.delta.steps, stepped.delta.steps);
  for (
    const step of [
      { record: "issue-alpha-1", kind: "work:x", disposition: "kept" },
      { record: "a/b", kind: "work:none", disposition: "kept" },
      { record: "issue-alpha-1", kind: "work:none", disposition: "lost" },
    ]
  ) {
    await assert.rejects(() =>
      sealRepairDeltaV1({
        ...envelope.delta,
        steps: [{ ...step, elapsedMs: 1 }] as never,
      })
    );
  }
  // A foreign record in the delta never seals.
  await assert.rejects(() =>
    sealRepairDeltaV1({
      ...envelope.delta,
      transitions: [{
        before: "c".repeat(64),
        after: pendingArtifact(BETA, 2),
      }],
    })
  );
});

Deno.test("repair delta: the projection ignores other repositories and bookkeeping only", async () => {
  const alpha = pendingArtifact(ALPHA, 1);
  const beta = pendingArtifact(BETA, 2);
  const base = seeded([alpha, beta]);
  const digest = await repairProjectionDigestV1(base, ALPHA);
  const otherRepository = {
    ...base,
    sequence: 9,
    updatedAt: T0 + 9,
    work: [alpha, { ...beta, updatedAt: beta.updatedAt + 1 }],
  };
  assert.equal(await repairProjectionDigestV1(otherRepository, ALPHA), digest);
  const ownMoved = {
    ...base,
    work: [{ ...alpha, updatedAt: alpha.updatedAt + 1 }, beta],
  };
  assert.notEqual(await repairProjectionDigestV1(ownMoved, ALPHA), digest);
});

Deno.test("fan-out summary line: strict, bounded and count-only", () => {
  const line = fanoutSummaryLine({
    status: "applied",
    head: SHA1,
    applied: [{ repository: ALPHA, transitions: 3 }],
    rejected: [{ repository: BETA, reason: "base_moved" }],
    repositoryWallMs: [900, 400],
    applyMs: 120,
    handedBack: 2,
    stepKinds: {
      "review:review_pending": { steps: 2, kept: 2, deferred: 0, elapsedMs: 9 },
      "work:unavailable": { steps: 1, kept: 0, deferred: 1, elapsedMs: 4 },
    },
    recordsDelegated: 5,
    recordsSerialOwned: 7,
  });
  assert.ok(line !== null);
  const parsed = parseFanoutSummaryLine(JSON.parse(line));
  assert.deepEqual(parsed, {
    kind: FANOUT_SUMMARY_LINE_KIND,
    deltasApplied: 1,
    transitionsApplied: 3,
    deltasRejected: {
      missing: 0,
      refused: 0,
      unauthenticated: 0,
      invalid: 0,
      duplicate: 0,
      base_moved: 1,
      transition_refused: 0,
    },
    repositoryWallMs: [900, 400],
    applyMs: 120,
    recordsHandedBack: 2,
    recordsDelegated: 5,
    recordsSerialOwned: 7,
    stepKinds: {
      "review:review_pending": { steps: 2, kept: 2, deferred: 0, elapsedMs: 9 },
      "work:unavailable": { steps: 1, kept: 0, deferred: 1, elapsedMs: 4 },
    },
  });
  assert.equal(line.includes("alpha"), false, "no repository name");
  const value = JSON.parse(line);
  assert.ok(parseFanoutSummaryLine({ ...value, recordsSerialOwned: null }));
  for (
    const stepKinds of [
      { "work:bogus": { steps: 1, kept: 1, deferred: 0, elapsedMs: 0 } },
      { "work:none": { steps: 2, kept: 1, deferred: 0, elapsedMs: 0 } },
      { "work:none": { steps: 1, kept: 1, deferred: 0 } },
      {
        "work:none": { steps: 1, kept: 1, deferred: 0, elapsedMs: 0 },
        "review:none": { steps: 1, kept: 1, deferred: 0, elapsedMs: 0 },
      },
    ]
  ) {
    assert.equal(
      parseFanoutSummaryLine({ ...value, stepKinds }),
      null,
      JSON.stringify(stepKinds),
    );
  }
  assert.equal(
    parseFanoutSummaryLine({ ...value, repositoryWallMs: [1, 2] }),
    null,
    "walls are descending",
  );
  assert.equal(parseFanoutSummaryLine({ ...value, extra: 1 }), null);
  assert.equal(parseFanoutSummaryLine({ ...value, applyMs: -1 }), null);
});
