/**
 * A base-repair task whose implementation made no change (live: ai.ubq.fi
 * 1370, 2026-11-17: one charged start on runtime 77931d13 settled ambiguous,
 * then the no-change hold) through the real repair loop with fake GitHub,
 * native-review and model ports and the rig's injected clock. The hold's only
 * exit is a base review, which starts only on green CI at the exact base; a
 * base-repair task's base is red by construction. Before the fix every cycle
 * deferred for 24 hours and the record then parked under the generic
 * hold-bound blocker. Now the hold takes the ordinary no-change retry, whose
 * start carries the red base's checks (and, in a matrix cell, its CI
 * evidence), under the existing bounds: the no-change bound of 3 (per issue)
 * and the identical-attempt refusal. Then it parks, uncharged, with its own
 * blocker, and nothing more is ever charged. An ordinary task's hold is
 * byte-identical, and an unreadable issue defers without a write.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  type GitHubCheckV1,
  type ModelRunRequestV1,
  portError,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  BASE_REVIEW_CI_NOT_GREEN,
  type BaseTaskReviewPortV1,
} from "../../src/github/base-review-evidence.ts";
import {
  ATTEMPT_DETAIL_NO_CHANGE,
  attemptMemorySettlementMutationV1,
} from "../../src/repair/attempt-policy.ts";
import { BASE_REPAIR_NO_CHANGE_DETAIL } from "../../src/repair/base-repair.ts";
import {
  holdNoChange,
  issueNoChangeOutcomes,
  MAX_NO_CHANGE_BASE_REVIEWS,
} from "../../src/repair/base-satisfaction-marker.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import type { BaseTaskReviewGitHubV1 } from "../../src/repair/loop-base-satisfaction.ts";
import { implementationIntent } from "../../src/repair/loop-implementation.ts";
import { CANDIDATE_COMMIT_REFUSAL_DETAILS } from "../../src/repair/model-port-checkout.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
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
/** The base-repair CI finding's opening (the start's evidence key). */
const RED_BASE =
  "Required CI checks failed on this candidate and on its red base ";
/** 1370's first start ran on an older runtime than the one installed now. */
const OLDER_RUNTIME = "77931d130e055644b3d8c26c174ab40fdbc6dbdd" as GitSha;
const ORIGIN = "a".repeat(64);
const HOUR = 60 * 60_000;
const MARKER = `<!-- sentinel:base-repair:development@${SHA2} -->`;

type Author = "app" | "person";

const RED: GitHubCheckV1 = {
  name: "deno",
  status: "completed",
  conclusion: "failure",
  head: SHA2,
  startedAt: 1,
  completedAt: 2,
};

function fresh(): WorkRecordV1 {
  const record = workRecord("issue-ubiquity-ai.ubq.fi-1370", {
    source: { kind: "issue", id: "1370", revision: SHA2 },
    related: { issueNumber: 1370, incidentId: null },
    counters: { attempts: 0, retries: 0, reviewRounds: 0 },
    nextStep: "work",
    intent: null,
  });
  return {
    ...record,
    target: {
      base: SHA2,
      head: null,
      pr: null,
      branch: candidateBranch(record.id),
      checkpoint: null,
    },
  };
}

/** 1370 as live state holds it: one no-change start, then the hold. */
async function held1370(): Promise<RepairStateSnapshotV1> {
  const started = {
    ...fresh(),
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
  };
  const admitted = {
    ...started,
    intent: implementationIntent(ORIGIN, started, T0),
  };
  const origin: BudgetReservationV1 = {
    version: "v1",
    kind: "budget_reservation",
    id: ORIGIN,
    taskId: admitted.id,
    repository: admitted.repository,
    head: SHA2,
    attempt: 1,
    purpose: "implementation",
    outcome: "ambiguous",
    createdAt: T0,
    settledAt: T0,
    proofRef: null,
  };
  const snapshot = seededSnapshot([holdNoChange(admitted, T0)], {
    reservations: [origin],
  });
  // Its memory: one no-change outcome and its inputs, on the older runtime.
  (await attemptMemorySettlementMutationV1({
    record: admitted,
    detail: ATTEMPT_DETAIL_NO_CHANGE,
    now: T0,
    runtimeSha: OLDER_RUNTIME,
  }))(snapshot);
  return snapshot;
}

/**
 * The loop over issue 1370 in `state`: its base is red, its base review can
 * never start, and the model never changes anything.
 */
async function loop(
  state: RepairStateSnapshotV1,
  author: Author = "app",
  readable = true,
) {
  const github = new RelationsFakeGithub({ baseSha: SHA2, checks: [RED] });
  const rig = makeMemoryRig(github);
  github.latest.set(
    1370,
    issueRecord(1370, {
      title: "CI is failing on development",
      body: `${MARKER}\n\nCI is failing on \`development\` at ${SHA2}.`,
      // The marker alone never makes a base-repair task: only the App's.
      author: author === "app" ? "ubiquity-sentinel[bot]" : "someone",
      relations: { openBlockers: [], subIssueCount: 0 },
    }),
  );
  if (!readable) {
    github.readIssue = () =>
      Promise.resolve(portError("unavailable", "issue read unavailable"));
  }
  rig.model.runModel = (request: ModelRunRequestV1) => {
    rig.model.requests.push(request);
    return Promise.resolve(
      portError("unavailable", CANDIDATE_COMMIT_REFUSAL_DETAILS.unchanged_base),
    );
  };
  let reviews = 0;
  const port: BaseTaskReviewPortV1 = {
    inspect: () => Promise.resolve(portError("unavailable", CI_NOT_GREEN)),
    run: () => {
      reviews++;
      return Promise.resolve(portError("unavailable", "never started"));
    },
    close: () => Promise.resolve(portError("unavailable", "never closed")),
  };
  (github as BaseTaskReviewGitHubV1).baseTaskReview = port;
  await rig.state.writeRepair(state, null);
  return { rig, reviews: () => reviews };
}

type Rig = Awaited<ReturnType<typeof loop>>["rig"];

/**
 * `passes` hourly cycles, each on the runtime `runtime(pass)` names and
 * ending after `steps` steps.
 */
async function cycles(
  rig: Rig,
  passes: number,
  runtime: (pass: number) => GitSha = () => SHA1,
  steps = 16,
) {
  const seen: string[] = [];
  for (let pass = 0; pass < passes; pass++) {
    await rig.run(steps, runtime(pass));
    const row = (await rig.snapshot()).work[0];
    seen.push(
      row.nextStep === "blocked"
        ? `blocked:${row.blocker?.kind}:${row.blocker?.message}`
        : `${row.nextStep}:${row.wait?.reason ?? "none"}`,
    );
    rig.clock.advance(HOUR);
  }
  return seen;
}

/** Every start's request carries the red base's checks as its finding. */
function assertEvidenceKeyed(requests: readonly ModelRunRequestV1[]) {
  for (const request of requests) {
    assert.equal(request.checkoutBase, undefined);
    assert.equal(request.reviewFindings?.length, 1);
    assert.ok(
      request.reviewFindings![0].message.startsWith(
        `${RED_BASE}${SHA2.slice(0, 12)}: deno (failure).`,
      ),
    );
  }
}

Deno.test("base-repair no change: 1370's live hold retries with its red base's evidence, then parks; two charges in all", async () => {
  assert.equal(BASE_REPAIR_NO_CHANGE_DETAIL, NO_CHANGE_PARK);
  assert.equal(BASE_REVIEW_CI_NOT_GREEN, CI_NOT_GREEN);
  const { rig, reviews } = await loop(await held1370());
  const seen = await cycles(rig, 26);
  const after = await rig.snapshot();
  // The next pass of the new runtime starts its second attempt instead of
  // parking: a new runtime revision is a new input.
  assert.equal(rig.model.requests.length, 1);
  assertEvidenceKeyed(rig.model.requests);
  assert.deepEqual(
    after.reservations.map((row) => [row.purpose, row.attempt, row.outcome]),
    [["implementation", 1, "ambiguous"], ["retry", 2, "ambiguous"]],
  );
  // Its second no-change outcome would be replayed with identical inputs on
  // this runtime: the honest park, uncharged, and nothing after it.
  const park = `blocked:other:${NO_CHANGE_PARK}`;
  assert.equal(seen.at(-1), park);
  assert.equal(seen.indexOf(park), 1, "parked on the second pass");
  assert.equal(after.work[0].counters.attempts, 2);
  assert.equal(after.work[0].counters.retries, 0, "never a CI fix");
  assert.equal(issueNoChangeOutcomes(after, after.work[0]), 2);
  assert.equal(reviews(), 0, "no base review is ever admitted");
});

Deno.test("base-repair no change: the no-change bound stops a new runtime on every pass at three charged starts", async () => {
  const { rig, reviews } = await loop(seededSnapshot([fresh()]));
  // The worst case: hosted, a start and its next base review step run in
  // different jobs, here one step a pass, and a distinct runtime is
  // installed on every pass. Each is a new input, so only the no-change
  // bound stops the retries.
  const runtime = (pass: number) =>
    "0123456789abcdef"[pass % 16].repeat(40) as GitSha;
  const seen = await cycles(rig, 20, runtime, 1);
  const after = await rig.snapshot();
  assert.deepEqual(seen.slice(0, 6), [
    "work:backoff",
    "work:none",
    "work:backoff",
    "work:none",
    "work:backoff",
    `blocked:other:${NO_CHANGE_PARK}`,
  ]);
  assert.equal(MAX_NO_CHANGE_BASE_REVIEWS, 3);
  assert.equal(rig.model.requests.length, 3);
  assertEvidenceKeyed(rig.model.requests);
  assert.equal(after.reservations.length, 3);
  assert.ok(after.reservations.every((row) => row.outcome === "ambiguous"));
  const park = `blocked:other:${NO_CHANGE_PARK}`;
  assert.equal(seen.at(-1), park);
  // Parked, it never moves again on any later runtime.
  const at = seen.indexOf(park);
  assert.ok(at > 0 && seen.slice(at).every((row) => row === park));
  assert.equal(issueNoChangeOutcomes(after, after.work[0]), 3);
  assert.equal(reviews(), 0);
});

Deno.test("base-repair no change: 1370 reaches at most three charges, its first included, under any runtime churn", async () => {
  const { rig } = await loop(await held1370());
  const runtime = (pass: number) =>
    "0123456789abcdef"[pass % 16].repeat(40) as GitSha;
  const seen = await cycles(rig, 20, runtime, 1);
  const after = await rig.snapshot();
  assert.equal(rig.model.requests.length, 2);
  assertEvidenceKeyed(rig.model.requests);
  assert.deepEqual(
    after.reservations.map((row) => [row.purpose, row.attempt]),
    [["implementation", 1], ["retry", 2], ["retry", 3]],
  );
  assert.equal(seen.at(-1), `blocked:other:${NO_CHANGE_PARK}`);
  assert.equal(issueNoChangeOutcomes(after, after.work[0]), 3);
});

Deno.test("base-repair no change: on one runtime the identical retry is never started; one charge, then the park", async () => {
  const { rig } = await loop(seededSnapshot([fresh()]));
  const seen = await cycles(rig, 10);
  const after = await rig.snapshot();
  assert.equal(rig.model.requests.length, 1);
  assertEvidenceKeyed(rig.model.requests);
  assert.equal(after.reservations.length, 1);
  assert.equal(seen.at(-1), `blocked:other:${NO_CHANGE_PARK}`);
});

Deno.test("base-repair no change: an ordinary task's hold is unchanged, the marker alone recognises nothing", async () => {
  const { rig, reviews } = await loop(await held1370(), "person");
  const before = await rig.snapshot();
  await rig.run();
  assert.equal(
    canonicalStringify(await rig.snapshot()),
    canonicalStringify(before),
    "a deferred hold writes nothing",
  );
  const seen = await cycles(rig, 26);
  // Deferred every hour until its bound, then the generic park, as before.
  assert.equal(seen.filter((row) => row === "work:backoff").length, 24);
  assert.deepEqual(
    seen.slice(24),
    Array(2).fill(`blocked:missing_evidence:${HOLD_EXPIRED}`),
  );
  assert.equal(rig.model.requests.length, 0);
  assert.equal(reviews(), 0);
  assert.deepEqual((await rig.snapshot()).reservations, before.reservations);
});

Deno.test("base-repair no change: an unreadable issue defers without a write, charge or park", async () => {
  const { rig } = await loop(await held1370(), "app", false);
  const before = await rig.snapshot();
  await cycles(rig, 3);
  assert.equal(
    canonicalStringify(await rig.snapshot()),
    canonicalStringify(before),
  );
  assert.equal(rig.model.requests.length, 0);
});
