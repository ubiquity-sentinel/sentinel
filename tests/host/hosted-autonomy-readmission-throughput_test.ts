/** Count-only throttles must not hide eligible recovery or discard charges. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  planAcceptanceReadmissions,
} from "../../ops/hosted-autonomy-acceptance.ts";
import { applyHostedRetries } from "../../ops/hosted-autonomy-retries.ts";
import { runHostedRetryPass } from "../../ops/hosted-autonomy-retry-pass.ts";
import { hostedIssueKey } from "../../ops/hosted-autonomy-policy.ts";
import { createHostedAutonomyScopes } from "../../ops/hosted-autonomy-scopes.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";
import {
  releaseAt,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";
import { liveSurface } from "./hosted-autonomy-spent-fixtures.ts";
import { SHA1, T0 } from "../state/helpers.ts";
import { parseWithR80, r80Available } from "./r80-contracts.ts";

const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
const R80_RELEASE = releaseAt({
  revision: R80,
  generation: 80,
  healthy: {
    revision: R80,
    generation: 80,
    createdAt: T0 + 100,
    observedAt: T0 + 110,
  },
});
const AI = { owner: "ubiquity", name: "ai.ubq.fi", installationId: 155687488 };

Deno.test("readmission throughput: every eligible spent CI head is read in one pass", async () => {
  const records = Array.from({ length: 34 }, (_, index) => {
    const issue = 2000 + index;
    const id = `issue-ubiquity-ai.ubq.fi-${issue}`;
    return blockedRecord({
      repository: AI,
      id,
      source: { kind: "issue", id: String(issue), revision: SHA1 },
      related: { incidentId: null, issueNumber: issue },
      target: {
        base: BASE,
        branch: `sentinel/repair/${id}`,
        checkpoint: null,
        head: issue.toString(16).padStart(40, "0"),
        pr: 4000 + index,
      },
      blocker: {
        kind: "other",
        message: "CI checks failed: validate(failure)",
        since: T0,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 3 },
      evidence: [],
    });
  });
  // 32 eligible heads, one closed issue and one head without a bound review.
  const reviews = records.slice(0, -1).map((record, index) =>
    authorizingReceipt({
      id: `review-receipt:${index.toString(16).padStart(64, "0")}`,
      repository: AI,
      pullRequest: {
        number: record.target.pr,
        base: BASE,
        head: record.target.head,
      },
    })
  );
  const snapshot = repairSnapshot(records, reviews, [], []);
  const state = new TransitionState(snapshot, R80_RELEASE);
  const calls: { head: string; base: string | null | undefined }[] = [];
  const { surface } = liveSurface({
    tip: BASE,
    extra: {
      hasAllChecksGreen: (head, base) => {
        calls.push({ head, base });
        // Unreadable must stay unknown; red or green cannot buy a fourth round.
        const index = records.findIndex((record) =>
          record.target.head === head
        );
        return Promise.resolve(index % 3 === 0 ? null : index % 3 === 1);
      },
    },
  });
  const deps: HostedAutonomyDepsV1 = {
    state,
    githubFor: () => surface,
    clock: { now: () => T0 + 5_000_000 },
    legacyReviewCutoff: null,
  };
  const before = structuredClone(snapshot);
  const result = await runHostedRetryPass({
    deps,
    actions: [],
    revisions: [],
    snapshot,
    observedHead: state.head,
    initialHead: state.head,
    releaseSnapshot: R80_RELEASE,
    closedIssues: new Set([
      hostedIssueKey(AI, records[32].related.issueNumber!),
    ]),
    foreignMerged: new Map(),
    dedicatedReservations: new Set(),
    ...createHostedAutonomyScopes(deps),
  }, SHA1);
  assert.deepEqual(
    calls.map((call) => call.head).sort(),
    records.slice(0, 32).map((record) => record.target.head!).sort(),
    "one complete read per eligible head; no rotating count window",
  );
  assert.ok(
    calls.every((call) => call.base === BASE),
    "each read covers its own base",
  );
  assert.equal(result, null);
  assert.equal(state.writes, 0);
  assert.deepEqual(
    state.snapshot,
    before,
    "reads do not reopen spent review rounds",
  );
});

Deno.test("readmission throughput: acceptance recovery survives 250 prior charges and keeps owner ceilings", async () => {
  const live = JSON.parse(
    await Deno.readTextFile(
      new URL("../fixtures/host/acceptance-b6-live.json", import.meta.url),
    ),
  );
  const snapshot = parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: live.updatedAt,
    incidents: [],
    evidence: [],
    work: live.records,
    reservations: live.reservations,
    reviews: live.reviews,
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
  const target = "issue-ubiquity-ai.ubq.fi-576";
  const baselinePlans = planAcceptanceReadmissions(snapshot, new Set(), true);
  assert.ok(baselinePlans.some((plan) => plan.id === target));
  const existing = snapshot.reservations.filter((charge) =>
    charge.taskId === target
  );
  assert.ok(existing.length > 0);
  const seed = existing[0];
  const added = Array.from({ length: 250 - existing.length }, (_, index) => ({
    ...seed,
    id: (1000 + index).toString(16).padStart(64, "0"),
    head: (1000 + index).toString(16).padStart(40, "0"),
    purpose: "retry",
    attempt: 1000 + index,
    outcome: index % 3 === 0
      ? "reserved"
      : index % 3 === 1
      ? "submitted"
      : "ambiguous",
    settledAt: index % 3 === 0 ? null : seed.settledAt,
  }));
  const charged = parseRepairStateSnapshotV1({
    ...snapshot,
    reservations: [...snapshot.reservations, ...added],
  });
  const before = structuredClone(charged);
  const plans = planAcceptanceReadmissions(charged, new Set(), true);
  assert.deepEqual(
    plans,
    baselinePlans,
    "history alone must not change eligibility",
  );
  const now = charged.updatedAt + 60_000;
  const applied = applyHostedRetries(charged, SHA1, plans, now);
  assert.equal(
    applied.work.find((row) => row.id === target)?.nextStep,
    "review",
  );
  assert.deepEqual(
    applied.reservations,
    before.reservations,
    "no refund or new charge",
  );
  for (const original of before.work) {
    assert.deepEqual(
      applied.work.find((row) => row.id === original.id)?.counters,
      original.counters,
    );
  }
  assert.deepEqual(charged, before);
  assert.deepEqual(
    planAcceptanceReadmissions(charged, new Set(), false),
    [],
    "runtime gate remains",
  );
  const work = charged.work.find((row) => row.id === target)!;
  assert.equal(
    planAcceptanceReadmissions(
      charged,
      new Set([hostedIssueKey(work.repository, work.related.issueNumber!)]),
      true,
    ).some((plan) => plan.id === target),
    false,
    "closed source stays excluded",
  );
  const spent = parseRepairStateSnapshotV1({
    ...charged,
    work: charged.work.map((row) =>
      row.id === target
        ? {
          ...row,
          counters: { ...row.counters, reviewRounds: 3 },
        }
        : row
    ),
  });
  assert.equal(
    planAcceptanceReadmissions(spent, new Set(), true).some((plan) =>
      plan.id === target
    ),
    false,
    "three reviews remain a hard ceiling",
  );
  if (await r80Available()) await parseWithR80(applied);
});
