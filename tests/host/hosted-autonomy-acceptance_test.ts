/**
 * Launcher half of JAM B6 ("task acceptance not fulfilled") over the live
 * ai.ubq.fi records at repair sequence 41474: B6a 576, 653 and 660 (a review
 * round left) are re-admitted to `review` only under a proven
 * acceptance-correction runtime, and B6b 611, 1127 and 118 (every round
 * spent) are owner-gated, named once in the run summary instead of reporting
 * `spent_not_admissible` on every pass.
 */
import assert from "node:assert/strict";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { HOSTED_RUNTIME_ROLLOUT } from "../../src/host/hosted-runtime-rollout.ts";
import { TASK_ACCEPTANCE_OWNER_GATE_DETAIL } from "../../src/repair/acceptance-correction.ts";
import { TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL } from "../../src/repair/review-gate.ts";
import {
  ACCEPTANCE_CORRECTION_REQUIRES_RUNTIME,
  ACCEPTANCE_OWNER_GATE_REPORTS_PER_PASS,
  ACCEPTANCE_READMISSION_DETAIL,
  acceptanceCorrectionRuntimeProven,
  acceptanceOwnerGateActions,
  acceptanceOwnerGated,
  HOSTED_AUTONOMY_ACCEPTANCE_CORRECTION_RUNTIMES,
  planAcceptanceReadmissions,
} from "../../ops/hosted-autonomy-acceptance.ts";
import { applyHostedRetries } from "../../ops/hosted-autonomy-retries.ts";
import { hostedIssueKey } from "../../ops/hosted-autonomy-policy.ts";
import {
  readHostedClosedIssues,
  runHostedRetryPass,
} from "../../ops/hosted-autonomy-retry-pass.ts";
import { createHostedAutonomyScopes } from "../../ops/hosted-autonomy-scopes.ts";
import type { HostedAutonomyPassContextV1 } from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import { releaseAt } from "./hosted-autonomy-preservation-fixtures.ts";
import { makeRig, type RigV1 } from "./hosted-autonomy-rig.ts";
import {
  deliveryOnly,
  liveSurface,
  openPull,
  readSnapshot,
} from "./hosted-autonomy-spent-fixtures.ts";

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/acceptance-b6-live.json", import.meta.url),
  ),
);
const id = (issue: number) => `issue-ubiquity-ai.ubq.fi-${issue}`;
const B6A = [576, 653, 660].map(id);
const B6B = [1127, 118, 611].map(id).sort();
/** The pass clock: after the live snapshot instant. */
const NOW = (LIVE.updatedAt as number) + 600_000;
/** A generation-81 acceptance-correction runtime (test pin only). */
const R81 = "8181818181818181818181818181818181818181" as GitSha;
const R81_RUNTIMES: ReadonlySet<string> = new Set([R81]);
const R81_RELEASE = releaseAt({
  revision: R81,
  generation: 81,
  healthy: {
    revision: R81,
    generation: 81,
    createdAt: NOW - 3_600_000,
    observedAt: NOW - 3_500_000,
  },
});

function liveSnapshot(
  work: WorkRecordV1[] = LIVE.records,
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    // A fresh store starts at sequence 1 (the live one was LIVE.sequence).
    sequence: 1,
    updatedAt: LIVE.updatedAt,
    incidents: [],
    evidence: [],
    work,
    reservations: LIVE.reservations,
    reviews: LIVE.reviews,
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

function record(snapshot: RepairStateSnapshotV1, recordId: string) {
  const found = snapshot.work.find((row) => row.id === recordId);
  assert.ok(found, recordId);
  return found;
}

/** Every live pull request open at its record's head (20:39Z). */
function livePulls(): Record<number, HostedAutonomyPullV1> {
  return Object.fromEntries(
    (LIVE.records as WorkRecordV1[]).map((row) => [
      row.target.pr!,
      openPull(row),
    ]),
  );
}

async function liveRig(name: string): Promise<RigV1> {
  const { rig } = await makeRig(`acceptance-${name}`, {
    repair: liveSnapshot(),
  });
  rig.githubFor = () => liveSurface({ pulls: livePulls() }).surface;
  return rig;
}

/**
 * One real retry pass, as the runner drives it; with `runtimes` the custody
 * names the proven R81 runtime (the rig's own custody holds generation 1).
 */
async function retryPass(rig: RigV1, runtimes?: ReadonlySet<string>) {
  const deps: HostedAutonomyDepsV1 = {
    state: rig.state,
    githubFor: rig.githubFor,
    clock: { now: () => NOW },
    ...(runtimes === undefined
      ? {}
      : { acceptanceCorrectionRuntimes: runtimes }),
  };
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const release = await rig.state.readRelease();
  assert.ok(release.ok && release.value.status === "found");
  const context: HostedAutonomyPassContextV1 = {
    deps,
    actions: [],
    revisions: [],
    snapshot: read.value.snapshot,
    observedHead: read.value.head,
    initialHead: read.value.head,
    releaseSnapshot: runtimes === undefined
      ? release.value.snapshot
      : R81_RELEASE,
    closedIssues: new Set(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set<string>(),
    ...createHostedAutonomyScopes(deps),
  };
  await readHostedClosedIssues(context);
  const result = await runHostedRetryPass(context, read.value.head!);
  return { result, actions: context.actions };
}

Deno.test("B6 live: the six records split into re-admissible B6a and owner-gated B6b by the ordinary round count", () => {
  const snapshot = liveSnapshot();
  for (const recordId of [...B6A, ...B6B]) {
    assert.equal(
      record(snapshot, recordId).blocker?.message,
      TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
    );
  }
  assert.deepEqual(
    snapshot.work.filter((row) => acceptanceOwnerGated(row, snapshot))
      .map((row) => row.id).sort(),
    B6B,
  );
  const denied: string[] = [];
  assert.deepEqual(
    planAcceptanceReadmissions(snapshot, new Set(), false, (denial) => {
      assert.equal(denial.reason, ACCEPTANCE_CORRECTION_REQUIRES_RUNTIME);
      denied.push(denial.id);
    }),
    [],
    "R80 would block the same verdict again: no plan",
  );
  assert.deepEqual(denied.sort(), [...B6A].sort());
  const plans = planAcceptanceReadmissions(snapshot, new Set(), true);
  assert.deepEqual(plans.map((plan) => plan.id).sort(), [...B6A].sort());
  for (const plan of plans) {
    assert.equal(plan.nextStep, "review");
    assert.equal(plan.grant, 0);
    assert.equal(plan.reviewRounds, null);
    assert.equal(plan.advanceBase, false);
    assert.equal(plan.detail, ACCEPTANCE_READMISSION_DETAIL);
  }
  // A closed source issue is never re-admitted.
  const closed = new Set([
    hostedIssueKey(record(snapshot, id(653)).repository, 653),
  ]);
  assert.deepEqual(
    planAcceptanceReadmissions(snapshot, closed, true).map((plan) => plan.id)
      .sort(),
    [id(576), id(660)],
  );
  // The re-admission keeps every counter, charge, receipt and identity.
  const applied = applyHostedRetries(
    snapshot,
    "a".repeat(40) as GitSha,
    plans,
    NOW,
  );
  assert.deepEqual(applied.reservations, snapshot.reservations);
  assert.deepEqual(applied.reviews, snapshot.reviews);
  for (const recordId of B6A) {
    const before = record(snapshot, recordId);
    const after = record(applied, recordId);
    assert.equal(after.nextStep, "review");
    assert.equal(after.blocker, null);
    assert.equal(after.wait, null);
    assert.equal(after.intent, null);
    assert.deepEqual(after.counters, before.counters);
    assert.deepEqual(after.target, before.target);
    assert.deepEqual(after.evidence, before.evidence);
  }
  for (const recordId of B6B) {
    assert.deepEqual(record(applied, recordId), record(snapshot, recordId));
  }
});

Deno.test("B6 live: the owner gate is one bounded summary line, never re-admitted, and covers the runtime's own park", () => {
  const snapshot = liveSnapshot();
  assert.deepEqual(acceptanceOwnerGateActions(snapshot), [
    `owner_gate:task_acceptance_not_fulfilled:n=3:${B6B.join(",")}`,
  ]);
  // A source issue the owner already closed (live 112 and 596, their pull
  // requests merged by hand) awaits no decision: it is not named.
  const closed611 = new Set([
    hostedIssueKey(record(snapshot, id(611)).repository, 611),
  ]);
  assert.equal(
    acceptanceOwnerGated(record(snapshot, id(611)), snapshot, closed611),
    false,
  );
  assert.deepEqual(acceptanceOwnerGateActions(snapshot, closed611), [
    `owner_gate:task_acceptance_not_fulfilled:n=2:${id(1127)},${id(118)}`,
  ]);
  // The runtime's owner-gated park (here on 653's shape, a round left)
  // is owner-gated whatever its round count and never re-admitted.
  const parked = liveSnapshot(
    (LIVE.records as WorkRecordV1[]).map((row) =>
      row.id === id(653)
        ? {
          ...row,
          blocker: {
            kind: "other",
            message: TASK_ACCEPTANCE_OWNER_GATE_DETAIL,
            since: row.updatedAt,
          },
        }
        : row
    ),
  );
  assert.equal(acceptanceOwnerGated(record(parked, id(653)), parked), true);
  assert.deepEqual(
    planAcceptanceReadmissions(parked, new Set(), true).map((plan) => plan.id)
      .sort(),
    [id(576), id(660)],
  );
  // Beyond the bound the rest is counted, never dropped (611's shape, with
  // its own round charges, under fresh identities).
  const shape = record(snapshot, id(611));
  const charges = snapshot.reservations.filter((charge) =>
    charge.taskId === shape.id
  );
  const many = Array.from(
    { length: ACCEPTANCE_OWNER_GATE_REPORTS_PER_PASS + 2 },
    (_, index): WorkRecordV1 => ({
      ...shape,
      id: asWorkItemId(id(9000 + index)),
      source: { ...shape.source, id: String(9000 + index) },
      related: { incidentId: null, issueNumber: 9000 + index },
    }),
  );
  const [line] = acceptanceOwnerGateActions({
    ...snapshot,
    work: many,
    reservations: many.flatMap((row) =>
      charges.map((charge) => ({ ...charge, taskId: row.id }))
    ),
  });
  assert.ok(
    line.startsWith(
      `owner_gate:task_acceptance_not_fulfilled:n=${many.length}:${id(9000)},`,
    ),
    line,
  );
  assert.ok(line.endsWith(",+2"), line);
});

Deno.test("B6 live: the delivery pass names B6b once and reads, merges and writes nothing for it", async () => {
  const rig = await liveRig("delivery");
  try {
    const { actions } = await deliveryOnly(rig, NOW);
    assert.ok(
      actions.includes(
        `owner_gate:task_acceptance_not_fulfilled:n=3:${B6B.join(",")}`,
      ),
      actions.join(" "),
    );
    assert.equal(
      actions.filter((action) => action.includes("spent_not_admissible"))
        .length,
      0,
      actions.join(" "),
    );
    assert.equal(
      actions.filter((action) =>
        [...B6A, ...B6B].some((recordId) => action.includes(recordId)) &&
        !action.startsWith("owner_gate:")
      ).length,
      0,
      actions.join(" "),
    );
    assert.equal(rig.writes, 0);
    assert.equal(rig.merges, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("B6 live: under R80 the retry pass names B6a as awaiting the correction runtime and writes nothing", async () => {
  const rig = await liveRig("r80");
  try {
    const { result, actions } = await retryPass(rig);
    assert.equal(result, null, JSON.stringify(actions));
    for (const recordId of B6A) {
      assert.ok(
        actions.includes(
          `retry:${recordId}:denied:${ACCEPTANCE_CORRECTION_REQUIRES_RUNTIME}`,
        ),
        actions.join(" "),
      );
    }
    assert.equal(rig.writes, 0);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("B6 live: under a proven acceptance-correction runtime B6a returns to review once, uncharged", async () => {
  const rig = await liveRig("r81");
  try {
    assert.equal(
      acceptanceCorrectionRuntimeProven(
        R81_RELEASE.hostedRuntimes[0],
        R81_RUNTIMES,
      ),
      true,
    );
    assert.equal(
      acceptanceCorrectionRuntimeProven(R81_RELEASE.hostedRuntimes[0]),
      false,
      "the production allowlist refuses this synthetic runtime",
    );
    const before = await readSnapshot(rig);
    const { result, actions } = await retryPass(rig, R81_RUNTIMES);
    assert.equal(result?.status, "applied", JSON.stringify(actions));
    assert.deepEqual(
      actions.filter((action) => action.startsWith("retry:")).sort(),
      B6A.map((recordId) =>
        `retry:${recordId}:grant=0:${ACCEPTANCE_READMISSION_DETAIL}`
      ).sort(),
    );
    const after = await readSnapshot(rig);
    assert.deepEqual(after.reservations, before.reservations);
    assert.deepEqual(after.reviews, before.reviews);
    for (const recordId of B6A) {
      const row = record(after, recordId);
      assert.equal(row.nextStep, "review");
      assert.equal(row.blocker, null);
      assert.deepEqual(row.counters, record(before, recordId).counters);
    }
    for (const recordId of B6B) {
      assert.deepEqual(record(after, recordId), record(before, recordId));
    }
    // The next pass finds nothing left to re-admit.
    const again = await retryPass(rig, R81_RUNTIMES);
    assert.equal(again.result, null, JSON.stringify(again.actions));
    assert.equal(
      again.actions.filter((action) => action.startsWith("retry:")).length,
      0,
      again.actions.join(" "),
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("B6: every allowlisted acceptance-correction runtime carries the runtime half", async () => {
  assert.deepEqual([...HOSTED_AUTONOMY_ACCEPTANCE_CORRECTION_RUNTIMES], [
    ...HOSTED_RUNTIME_ROLLOUT.acceptanceCorrection,
    "da98f5f49c45b57cfa97a45fe647c36b1021f302",
  ]);
  const pinned = releaseAt({
    revision: "da98f5f49c45b57cfa97a45fe647c36b1021f302" as GitSha,
    generation: 81,
    healthy: {
      revision: "da98f5f49c45b57cfa97a45fe647c36b1021f302" as GitSha,
      generation: 81,
      createdAt: NOW - 3_600_000,
      observedAt: NOW - 3_500_000,
    },
  });
  assert.equal(
    acceptanceCorrectionRuntimeProven(pinned.hostedRuntimes[0]),
    true,
  );
  assert.equal(
    acceptanceCorrectionRuntimeProven(R81_RELEASE.hostedRuntimes[0]),
    false,
  );

  // The pin commit that lists a revision makes this bind: its tree must hold
  // the correction route and the owner-gated park the launcher relies on.
  const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
  for (const revision of HOSTED_AUTONOMY_ACCEPTANCE_CORRECTION_RUNTIMES) {
    const available = await new Deno.Command("git", {
      args: ["-C", root, "cat-file", "-e", `${revision}^{commit}`],
      clearEnv: true,
      env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
      stdout: "null",
      stderr: "null",
    }).output();
    // A depth-1 launcher checkout need not contain its pinned runtime parent.
    if (!available.success) continue;
    const shown = await new Deno.Command("git", {
      args: [
        "-C",
        root,
        "show",
        `${revision}:src/repair/acceptance-correction.ts`,
      ],
      clearEnv: true,
      env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin" },
      stdout: "piped",
      stderr: "null",
    }).output();
    assert.ok(
      shown.success,
      `${revision} is present but lacks its runtime half`,
    );
    const text = new TextDecoder().decode(shown.stdout);
    assert.ok(text.includes(TASK_ACCEPTANCE_OWNER_GATE_DETAIL), revision);
    assert.ok(text.includes("export async function withAcceptanceFinding"));
  }
});
