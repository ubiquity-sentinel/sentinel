/**
 * Idle-cycle cost (2026-11-15): every open issue a target lists cost one
 * awaited native relations GraphQL read, although the intake consults
 * relations only for an open issue that reaches its admission decision (not
 * a CI outage notice, not opted out, no record yet). These drive the REAL
 * intake (`prepareMatrixIntakeV1` through the shared target flow) over the
 * REAL production port composition (`composeLocalGitHub`, its issue scope
 * and client) on a scripted transport, and count the relations reads.
 */
import assert from "node:assert/strict";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import { runActionsTargetCycles } from "../../src/host/actions.ts";
import { prepareMatrixIntakeV1 } from "../../src/repair/loop.ts";
import {
  CI_OUTAGE_AUTHOR,
  ciOutageMarker,
} from "../../src/repair/ci-outage-notice.ts";
import { issueWire, pullWire } from "../github/helpers.ts";
import { SHA2 } from "../state/helpers.ts";
import { response } from "./actions-ci-fixture.ts";
import {
  makeTargetHostRig,
  targetCycleInput,
} from "./actions-target-fixture.ts";
import { captureConsoleLog } from "./local-test-helpers.ts";

const SELF = "ubiquity-sentinel/sentinel";

/** Native relations envelope: a parent, an open blocker, or neither. */
function relations(
  number: number,
  shape: "none" | "parent" | "blocked",
): Record<string, unknown> {
  return {
    data: {
      repository: {
        issue: {
          number,
          blockedBy: {
            nodes: shape === "blocked"
              ? [{
                number: 99,
                state: "OPEN",
                repository: { nameWithOwner: SELF },
              }]
              : [],
            pageInfo: { hasNextPage: false },
          },
          subIssues: { totalCount: shape === "parent" ? 1 : 0 },
        },
      },
    },
  };
}

interface IntakeScenarioV1 {
  /** The listing the target answers, in REST order. */
  listing: Record<string, unknown>[];
  /** One relations answer per issue number; absent answers fail the read. */
  answers: Map<number, () => ReturnType<typeof response>>;
}

/**
 * One self target: a first intake records issues 1 and 7, then the measured
 * intake lists the scenario. Returns the measured pass's relations reads (by
 * issue number, in order), the records it left and its intake line.
 */
async function measuredIntake(scenario: IntakeScenarioV1) {
  const rig = makeTargetHostRig(["sentinel"]);
  const seeded = await rig.state.writeRepair(
    parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: rig.clock.now(),
      incidents: [],
      evidence: [],
      work: [],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    }),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  let listing: Record<string, unknown>[] = [
    issueWire({ number: 1 }),
    issueWire({ number: 7 }),
  ];
  const reads: number[] = [];
  rig.http.on(
    "GET",
    `/repos/${SELF}/issues`,
    () => response(200, listing),
  );
  rig.http.on(
    "GET",
    `/repos/${SELF}/git/ref/heads/development`,
    () =>
      response(200, {
        ref: "refs/heads/development",
        object: { type: "commit", sha: SHA2 },
      }),
  );
  rig.http.on("POST", "/graphql", (request: HttpRequestV1) => {
    const number = JSON.parse(request.body ?? "{}").variables.number;
    reads.push(number);
    const answer = scenario.answers.get(number);
    return answer === undefined
      ? response(200, { errors: [{ message: "unavailable" }], data: null })
      : answer();
  });
  const intake = () =>
    runActionsTargetCycles(targetCycleInput(rig, {
      runCycle: (deps, options) =>
        prepareMatrixIntakeV1(deps, {
          ...options,
          runStartedAt: rig.clock.now(),
        }),
    }));
  scenario.answers.set(1, () => response(200, relations(1, "none")));
  scenario.answers.set(7, () => response(200, relations(7, "none")));
  const first = await intake();
  assert.deepEqual(first.addressed, [SELF]);
  assert.deepEqual(reads, [1, 7], "the first pass records issues 1 and 7");
  reads.length = 0;
  listing = scenario.listing;
  const captured = captureConsoleLog();
  try {
    await intake();
  } finally {
    captured.restore();
  }
  const line = captured.lines.flatMap((text) => {
    try {
      const value = JSON.parse(text);
      return value?.kind === "sentinel_issue_intake" ? [value] : [];
    } catch {
      return [];
    }
  });
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  return {
    reads,
    records: read.value.snapshot.work
      .filter((record) => record.source.kind === "issue")
      .map((record) => Number(record.source.id))
      .sort((a, b) => a - b),
    line: line.at(-1),
  };
}

function scenario(): IntakeScenarioV1 {
  return {
    listing: [
      issueWire({ number: 1 }),
      issueWire({ number: 2, labels: [{ name: "sentinel:skip" }] }),
      issueWire({
        number: 3,
        user: { login: CI_OUTAGE_AUTHOR },
        body: ciOutageMarker({ owner: "ubiquity", name: "pay.ubq.fi" }) +
          "\nRestore Actions billing.",
      }),
      issueWire({ number: 4 }),
      issueWire({ number: 5 }),
      issueWire({ number: 6 }),
      issueWire({ number: 7 }),
      issueWire({ number: 8 }),
      pullWire({ number: 9, pull_request: {} }),
    ],
    answers: new Map([
      [4, () => response(200, relations(4, "none"))],
      [5, () => response(200, relations(5, "parent"))],
      [6, () => response(200, relations(6, "blocked"))],
      // Issue 8's relations read fails: it is admitted without relations.
    ]),
  };
}

Deno.test("intake relations: only an issue that reaches its admission decision spends a relations read", async () => {
  const measured = await measuredIntake(scenario());
  // The decisions are exactly those of a read for every listed issue: the
  // new issue 4 and the issue 8 whose read failed are admitted, the parent 5
  // and the blocked 6 are not, nor the outage notice or the opted-out issue.
  assert.deepEqual(measured.records, [1, 4, 7, 8]);
  assert.deepEqual(measured.line?.skippedIssues, [
    { number: 3, code: "not_admitted", reason: "ci_outage_notice" },
    { number: 5, code: "not_admitted", reason: "native_parent" },
    { number: 6, code: "not_admitted", reason: "native_open_blockers" },
  ]);
  assert.equal(measured.line?.openIssues, 7);
  // Before: one awaited read per listed issue, [1, 2, 3, 4, 5, 6, 7, 8]:
  // the recorded 1 and 7, the opted-out 2 and the notice 3 included.
  assert.deepEqual(measured.reads, [4, 5, 6, 8]);
});

Deno.test("intake relations: a rate-limited read still stops every later read of the listing", async () => {
  const limited = scenario();
  limited.answers.set(
    4,
    () => response(429, { message: "rate limited" }, { "retry-after": "60" }),
  );
  const measured = await measuredIntake(limited);
  // The first decided issue's read is limited, so every later issue is
  // decided without relations, exactly as before.
  assert.deepEqual(measured.records, [1, 4, 5, 6, 7, 8]);
  assert.deepEqual(measured.line?.skippedIssues, [
    { number: 3, code: "not_admitted", reason: "ci_outage_notice" },
  ]);
  // No later relations read is spent (before: [1, 2, 3, 4]).
  assert.deepEqual(measured.reads, [4]);
});
