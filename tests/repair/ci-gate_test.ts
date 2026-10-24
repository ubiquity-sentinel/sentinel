/**
 * CI gate decision tests: pure logic for the delivery-phase merge gate.
 * Verifies that pending checks wait, failed/timed_out/cancelled/action_required
 * checks block, and all-green checks proceed — without blocking a turn. Owner
 * directive 2026-10-24: `skipped` and `neutral` are green conclusions (a job the
 * target's own CI did not run is not a red check), matching
 * requiredChecksState semantics (`isGreenConclusion`).
 */
import assert from "node:assert/strict";

import { decideCiGate } from "../../src/repair/loop.ts";
import type { GitHubCheckV1 } from "../../src/contracts/ports.ts";

function check(
  name: string,
  status: GitHubCheckV1["status"],
  conclusion: GitHubCheckV1["conclusion"],
  completedAt: number | null = 1,
): GitHubCheckV1 {
  return {
    name,
    status,
    conclusion,
    head: "abc123" as never,
    startedAt: 0,
    completedAt,
  };
}

Deno.test("decideCiGate: empty checks wait (no evidence CI ran)", () => {
  assert.equal(decideCiGate([]), "wait");
});

Deno.test("decideCiGate: all success checks proceed", () => {
  const checks = [
    check("ci", "completed", "success"),
    check("lint", "completed", "success"),
  ];
  assert.equal(decideCiGate(checks), "proceed");
});

Deno.test("decideCiGate: skipped check is green (proceeds)", () => {
  assert.equal(decideCiGate([check("ci", "completed", "skipped")]), "proceed");
  assert.equal(
    decideCiGate([
      check("ci", "completed", "success"),
      check("verify-artifact", "completed", "skipped"),
    ]),
    "proceed",
    "a skipped job next to a passing one never blocks",
  );
});

Deno.test("decideCiGate: neutral check is green (proceeds)", () => {
  assert.equal(decideCiGate([check("ci", "completed", "neutral")]), "proceed");
  assert.equal(
    decideCiGate([
      check("ci", "completed", "success"),
      check("advisory", "completed", "neutral"),
    ]),
    "proceed",
    "a neutral job next to a passing one never blocks",
  );
});

Deno.test("decideCiGate: a failure next to skipped/neutral checks still blocks, naming only the failure", () => {
  const result = decideCiGate([
    check("ci", "completed", "failure"),
    check("verify-artifact", "completed", "skipped"),
    check("advisory", "completed", "neutral"),
  ]);
  assert.ok(typeof result === "object" && "blocked" in result);
  assert.equal(result.blocked, "CI checks failed: ci(failure)");
});

Deno.test("decideCiGate: a skipped check never masks a pending one", () => {
  const checks = [
    check("ci", "completed", "skipped"),
    check("slow", "in_progress", null, null),
  ];
  assert.equal(decideCiGate(checks), "wait");
});

Deno.test("decideCiGate: in-progress check waits (non-blocking)", () => {
  const checks = [
    check("ci", "completed", "success"),
    check("slow", "in_progress", null, null),
  ];
  assert.equal(decideCiGate(checks), "wait");
});

Deno.test("decideCiGate: queued check waits", () => {
  const checks = [check("ci", "queued", null, null)];
  assert.equal(decideCiGate(checks), "wait");
});

Deno.test("decideCiGate: failed check blocks with names", () => {
  const checks = [
    check("ci", "completed", "success"),
    check("broken", "completed", "failure"),
  ];
  const result = decideCiGate(checks);
  assert.ok(typeof result === "object" && "blocked" in result);
  assert.ok(result.blocked.includes("broken"));
});

Deno.test("decideCiGate: timed_out/cancelled/action_required block", () => {
  for (
    const conclusion of ["timed_out", "cancelled", "action_required"] as const
  ) {
    const result = decideCiGate([check("ci", "completed", conclusion)]);
    assert.ok(typeof result === "object" && "blocked" in result);
  }
});

Deno.test("decideCiGate: dedupes by name, latest wins", () => {
  // Old failed run must not override a newer pass.
  const checks = [
    { ...check("ci", "completed", "failure", 1), startedAt: 0 },
    { ...check("ci", "completed", "success", 2), startedAt: 1 },
  ];
  assert.equal(decideCiGate(checks), "proceed");
});

Deno.test("decideCiGate: newer in-progress rerun overrides older success", () => {
  // Old run completed successfully, but a newer rerun is still in progress.
  // Recency by startedAt: the pending rerun wins → wait.
  const checks = [
    { ...check("ci", "completed", "success", 3000), startedAt: 1000 },
    { ...check("ci", "in_progress", null, null), startedAt: 2000 },
  ];
  assert.equal(decideCiGate(checks), "wait");
});

Deno.test("ci_pending wait reason is a valid WorkWaitReasonV1", async () => {
  const { parseWorkRecordV1 } = await import(
    "../../src/contracts/work-record.ts"
  );
  // Use a minimal record and only override the wait; parseWorkRecordV1
  // validates the full structure, so we build from a known-good base.
  const base = {
    version: "v1",
    kind: "work",
    id: "i:1",
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
    source: {
      kind: "issue",
      id: "1",
      revision: "abc123abc123abc123abc123abc123abc123abcd",
    },
    related: { incidentId: null, issueNumber: 1 },
    fingerprint: null,
    failingRevision: null,
    sourceSnapshotDigest: null,
    classification: { severity: "P3", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    dependencies: [],
    controller: { sha: "abc123abc123abc123abc123abc123abc123abcd" },
    target: {
      base: "abc123abc123abc123abc123abc123abc123abcd",
      branch: null,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work",
    wait: { reason: "ci_pending", since: 1786000000000, until: 1786000300000 },
    blocker: null,
    counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    evidence: [],
    intent: null,
    firstSeenAt: null,
    createdAt: 1786000000000,
    updatedAt: 1786000000000,
  };
  const parsed = parseWorkRecordV1(base);
  assert.equal(parsed.wait?.reason, "ci_pending");
});

Deno.test("decideCiGate: failed check blocks even when another is pending", () => {
  const checks = [
    check("ci", "completed", "failure"),
    check("lint", "queued", null, null),
  ];
  const result = decideCiGate(checks);
  assert.ok(typeof result === "object" && "blocked" in result);
});
