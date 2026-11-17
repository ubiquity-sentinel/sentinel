/**
 * A base-repair task whose implementation made no change (live: ai.ubq.fi
 * 1370, 2026-11-17: one charged start settled ambiguous, then the no-change
 * hold) through the real repair loop with fake GitHub and native-review
 * ports and the rig's injected clock. The hold's only exit is a base review,
 * and a base review starts only on green CI at the exact base; a base-repair
 * task's base is red by construction. Before the fix every cycle deferred
 * for 24 hours and the record then parked under the generic hold-bound
 * blocker. Now the first cycle that meets the red base parks it, uncharged,
 * with its own blocker. An ordinary task's hold is byte-identical, and an
 * unreadable issue defers without a write.
 */
import assert from "node:assert/strict";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portError } from "../../src/contracts/ports.ts";
import {
  BASE_REVIEW_CI_NOT_GREEN,
  type BaseTaskReviewPortV1,
} from "../../src/github/base-review-evidence.ts";
import { BASE_REPAIR_NO_CHANGE_DETAIL } from "../../src/repair/base-repair.ts";
import { holdNoChange } from "../../src/repair/base-satisfaction-marker.ts";
import type { BaseTaskReviewGitHubV1 } from "../../src/repair/loop-base-satisfaction.ts";
import { implementationIntent } from "../../src/repair/loop-implementation.ts";
import { SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";

/** The fixed park, as an older runtime and the launcher read it. */
const NO_CHANGE_PARK =
  "base-repair implementation made no change while its base CI is not green; owner action required";
/** The real base review service's refusal on a base that is not green. */
const CI_NOT_GREEN = "base review CI is not green";
const HOLD_EXPIRED = "base review did not complete within its hold bound";
const ORIGIN = "a".repeat(64);
const HOUR = 60 * 60_000;
const MARKER = `<!-- sentinel:base-repair:development@${SHA2} -->`;

type Author = "app" | "person";

/** Issue 1370's record in the no-change hold, as the live state holds it. */
async function held(author: Author, readable = true) {
  const github = new RelationsFakeGithub({ baseSha: SHA2 });
  const rig = makeMemoryRig(github);
  // The marker alone never makes a base-repair task: only the App's issue.
  github.latest.set(
    1370,
    issueRecord(1370, {
      title: "CI is failing on development",
      body: `${MARKER}\n\nCI is failing on \`development\` at ${SHA2}.`,
      author: author === "app" ? "ubiquity-sentinel[bot]" : "someone",
      relations: { openBlockers: [], subIssueCount: 0 },
    }),
  );
  if (!readable) {
    github.readIssue = () =>
      Promise.resolve(portError("unavailable", "issue read unavailable"));
  }
  let record = workRecord("issue-ubiquity-ai.ubq.fi-1370", {
    source: { kind: "issue", id: "1370", revision: SHA2 },
    related: { issueNumber: 1370, incidentId: null },
    target: {
      base: SHA2,
      head: null,
      pr: null,
      branch: null,
      checkpoint: null,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    nextStep: "work",
    intent: null,
  });
  record = holdNoChange({
    ...record,
    intent: implementationIntent(ORIGIN, record, T0),
  }, T0);
  const origin: BudgetReservationV1 = {
    version: "v1",
    kind: "budget_reservation",
    id: ORIGIN,
    taskId: record.id,
    repository: record.repository,
    head: SHA2,
    attempt: 1,
    purpose: "implementation",
    outcome: "ambiguous",
    createdAt: T0,
    settledAt: T0,
    proofRef: null,
  };
  await rig.state.writeRepair(
    seededSnapshot([record], { reservations: [origin] }),
    null,
  );
  let inspects = 0;
  let runs = 0;
  const port: BaseTaskReviewPortV1 = {
    inspect: () => {
      inspects++;
      return Promise.resolve(portError("unavailable", CI_NOT_GREEN));
    },
    run: () => {
      runs++;
      return Promise.resolve(portError("unavailable", "never started"));
    },
    close: () => Promise.resolve(portError("unavailable", "never closed")),
  };
  (github as BaseTaskReviewGitHubV1).baseTaskReview = port;
  return { rig, counts: () => ({ inspects, runs }) };
}

/** One cycle an hour until just past the hold's 24-hour bound. */
async function cycles(rig: Awaited<ReturnType<typeof held>>["rig"]) {
  const seen: string[] = [];
  for (let hour = 0; hour <= 25; hour++) {
    await rig.run();
    const row = (await rig.snapshot()).work[0];
    seen.push(
      row.nextStep === "blocked"
        ? `blocked:${row.blocker?.kind}:${row.blocker?.message}`
        : `${row.nextStep}:${row.wait?.reason}`,
    );
    rig.clock.advance(HOUR);
  }
  return seen;
}

Deno.test("base-repair no change: a red base parks the held task at once, uncharged", async () => {
  assert.equal(BASE_REPAIR_NO_CHANGE_DETAIL, NO_CHANGE_PARK);
  assert.equal(BASE_REVIEW_CI_NOT_GREEN, CI_NOT_GREEN);
  const f = await held("app");
  const before = await f.rig.snapshot();
  const seen = await cycles(f.rig);
  const after = await f.rig.snapshot();
  // The first cycle parks it; no later cycle writes or charges anything.
  assert.deepEqual(new Set(seen), new Set([`blocked:other:${NO_CHANGE_PARK}`]));
  assert.deepEqual(f.counts(), { inspects: 1, runs: 0 });
  assert.deepEqual(after.reservations, before.reservations);
  assert.equal(after.reservations[0].outcome, "ambiguous", "charge kept");
  assert.deepEqual(after.work[0].counters, before.work[0].counters);
  assert.equal(after.work[0].wait, null);
  assert.equal(f.rig.model.requests.length, 0);
});

Deno.test("base-repair no change: an ordinary task's hold is unchanged, the marker alone recognises nothing", async () => {
  const f = await held("person");
  const before = await f.rig.snapshot();
  await f.rig.run();
  assert.equal(
    canonicalStringify(await f.rig.snapshot()),
    canonicalStringify(before),
    "a deferred hold writes nothing",
  );
  const seen = await cycles(f.rig);
  // Deferred every hour until its bound, then the generic park, as before.
  assert.equal(seen.filter((row) => row === "work:backoff").length, 24);
  assert.deepEqual(
    seen.slice(24),
    Array(2).fill(`blocked:missing_evidence:${HOLD_EXPIRED}`),
  );
  assert.equal(f.counts().runs, 0);
  assert.deepEqual(
    (await f.rig.snapshot()).reservations,
    before.reservations,
  );
});

Deno.test("base-repair no change: an unreadable issue defers without a write, charge or park", async () => {
  const f = await held("app", false);
  const before = await f.rig.snapshot();
  for (let pass = 0; pass < 3; pass++) {
    await f.rig.run();
    f.rig.clock.advance(HOUR);
  }
  assert.equal(
    canonicalStringify(await f.rig.snapshot()),
    canonicalStringify(before),
  );
  assert.equal(f.counts().runs, 0);
});
