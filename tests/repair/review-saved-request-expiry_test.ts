/**
 * JAM B5: a saved review request whose attempt key binds no review journal.
 *
 * Live shapes (`tests/fixtures/repair/review-saved-request-live.json`,
 * origin/sentinel-state/repair 3503d6ba7): ai.ubq.fi 630 (PR 999), 604
 * (PR 1053) and 647 (PR 1011) sat at `review` for 15-92 hours, each with an
 * ambiguous `review_request` intent for round `reviewRounds + 1` whose key no
 * journal on the pull request binds. Generation 80 took the saved-request
 * branch of `observeReview` and returned `review intent has no exact bound
 * journal` on every run, so the attempt never expired. These cases replay the
 * exact records and every charge of each task through the REAL repair cycle at
 * the snapshot's own instant (the next pass): the expired ambiguous round is
 * counted once and cleared, its charge kept, and each record moves.
 *
 * 604 and 647 also carry the PREVIOUS round's `review_pending` wait (its
 * `since` is that round's journal `requestedAt`), which predates the saved
 * intent's own start: the bound is never measured from that earlier round.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type BudgetReservationV1,
  parseBudgetReservationV1,
} from "../../src/contracts/budget-reservation.ts";
import type {
  GitHubCheckV1,
  PortResultV1,
  ReviewObservationV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { preReviewCiFixRouteOpen } from "../../src/repair/ci-first-policy.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { reviewOperationKey } from "../../src/repair/keys.ts";
import { REVIEW_BOUND_MS } from "../../src/repair/loop-bounds.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { LEGACY_REVIEW_CUTOFF } from "../../src/repair/review-round-cap.ts";
import { SHA1 } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";
import { seededState } from "./review-round-cap-rig.ts";

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../fixtures/repair/review-saved-request-live.json",
      import.meta.url,
    ),
  ),
);

/** The next pass after the live snapshot. */
const NEXT_PASS: number = LIVE.updatedAt;
const MINUTE = 60_000;
const LIVE_REPO = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
/** The pre-review CI park prefix, pinned literally (R80 matches the text). */
const CI_RED_PARK = "CI red before review; awaiting a CI fix: ";

interface LiveShapeV1 {
  record: WorkRecordV1;
  reservations: BudgetReservationV1[];
}

function liveShape(issue: number): LiveShapeV1 {
  const raw = (LIVE.records as { related: { issueNumber: number } }[])
    .find((row) => row.related.issueNumber === issue);
  assert.ok(raw !== undefined, `live record ${issue}`);
  const record = parseWorkRecordV1(structuredClone(raw));
  const reservations = (LIVE.reservations as unknown[])
    .map((row) => parseBudgetReservationV1(structuredClone(row)))
    .filter((row) => row.taskId === record.id);
  return { record, reservations };
}

function savedIntent(record: WorkRecordV1) {
  const intent = record.intent;
  assert.ok(intent !== null && intent.kind === "review_request");
  return intent;
}

function check(
  name: string,
  conclusion: GitHubCheckV1["conclusion"],
  head: GitSha,
  startedAt: string,
  completedAt: string,
): GitHubCheckV1 {
  return {
    name,
    status: "completed",
    conclusion,
    head,
    startedAt: Date.parse(startedAt),
    completedAt: Date.parse(completedAt),
  };
}

/** The live check runs of each head; the base ran the same jobs green. */
function liveChecks(issue: number, head: GitSha): GitHubCheckV1[] {
  switch (issue) {
    case 630: // PR 999: validate failed on the head.
      return [
        check(
          "verify-artifact",
          "skipped",
          head,
          "2026-10-17T05:36:33Z",
          "2026-10-17T05:36:33Z",
        ),
        check(
          "darwin-native",
          "success",
          head,
          "2026-10-17T05:15:37Z",
          "2026-10-17T05:19:07Z",
        ),
        check(
          "mac-containment",
          "success",
          head,
          "2026-10-17T05:15:37Z",
          "2026-10-17T05:15:48Z",
        ),
        check(
          "validate",
          "failure",
          head,
          "2026-10-17T05:15:32Z",
          "2026-10-17T05:36:33Z",
        ),
      ];
    case 604: // PR 1053: green.
      return [
        check(
          "verify-artifact",
          "success",
          head,
          "2026-10-16T00:12:19Z",
          "2026-10-16T00:12:41Z",
        ),
        check(
          "darwin-native",
          "success",
          head,
          "2026-10-15T23:52:09Z",
          "2026-10-15T23:54:49Z",
        ),
        check(
          "validate",
          "success",
          head,
          "2026-10-15T23:52:06Z",
          "2026-10-16T00:12:14Z",
        ),
        check(
          "mac-containment",
          "success",
          head,
          "2026-10-15T23:52:09Z",
          "2026-10-15T23:52:18Z",
        ),
      ];
    default: // PR 1011: green.
      return [
        check(
          "verify-artifact",
          "success",
          head,
          "2026-10-13T23:55:30Z",
          "2026-10-13T23:55:38Z",
        ),
        check(
          "validate",
          "success",
          head,
          "2026-10-13T23:50:51Z",
          "2026-10-13T23:55:27Z",
        ),
      ];
  }
}

/** The previous round's terminal no-verdict journal still on the PR. */
function noVerdictJournal(
  head: GitSha,
  base: GitSha,
  completedAt: number,
): ReviewObservationV1 {
  return {
    status: "unavailable",
    requestId: "review-previous-round",
    reviewer: null,
    resultId: "result-previous-round",
    completedAt,
    observedHead: head,
    observedBase: base,
    findings: [],
    summary:
      "structured review unavailable: the task acceptance is not bound to the supplied task statement",
    receivedAt: completedAt + 1,
    taskAcceptance: null,
  };
}

/**
 * The live pull request, branch, base and checks. The saved attempt key binds
 * no journal at all (the transport's exact unbound receipt); the previous
 * round's no-verdict journal stays bound under its own key.
 */
class LiveGithub extends FakeGithub {
  failSavedObservation = false;

  constructor(
    private readonly shape: LiveShapeV1,
    requestedAt: number,
    previousRoundKey: string | null,
  ) {
    const { record } = shape;
    const head = record.target.head!;
    const base = record.target.base!;
    const branch = record.target.branch!;
    super({
      baseSha: base,
      reviewRequestedAt: requestedAt,
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { [`refs/heads/${branch}`]: head },
        pullRequests: [exactOpenPr(record.target.pr!, head, branch, base)],
      },
    });
    this.unboundReviewKeys.add(savedIntent(record).key);
    if (previousRoundKey !== null) {
      this.reviewObservationsByKey.set(
        previousRoundKey,
        noVerdictJournal(head, base, savedIntent(record).startedAt - 1),
      );
    }
  }

  override observeReview(
    request: unknown,
  ): Promise<PortResultV1<ReviewObservationV1>> {
    const key = (request as { operationKey: string }).operationKey;
    if (
      this.failSavedObservation && key === savedIntent(this.shape.record).key
    ) {
      this.calls.push("observeReview");
      this.observedReviewKeys.push(key);
      return Promise.resolve(portError("unavailable", "review unavailable"));
    }
    return super.observeReview(request);
  }

  override readChecks(sha: GitSha) {
    const issue = this.shape.record.related.issueNumber!;
    const head = this.shape.record.target.head!;
    const checks = liveChecks(issue, head).map((row) =>
      sha === head ? row : { ...row, conclusion: "success" as const, head: sha }
    );
    return Promise.resolve(portOk({ head: sha, checks }));
  }
}

function previousRoundKey(record: WorkRecordV1): string | null {
  const pr = record.target.pr!;
  const head = record.target.head!;
  switch (record.related.issueNumber) {
    case 604: // Round one under the first-attempt key, on the same head.
      return reviewOperationKey(pr, head);
    case 647: // Round three on the same head.
      return reviewOperationKey(pr, head, 3);
    default: // 630: no journal on PR 999 at all.
      return null;
  }
}

/** The exact live record and ledger through the real hosted repair cycle. */
async function liveRig(issue: number, at: number = NEXT_PASS) {
  const shape = liveShape(issue);
  const clock = new FakeClock(at);
  const state = new MemoryState();
  const configs = repairConfigs({
    repository: LIVE_REPO,
    adapter: { kind: "github" },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    liveStartLimits: { perHour: 1_000, perSevenDays: 10_000 },
  });
  const github = new LiveGithub(shape, at, previousRoundKey(shape.record));
  const deps = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: new FakeModel({
      head: shape.record.target.head!,
      changedPaths: ["src/app.ts"],
    }),
    budget: new RollingStartBudget({ clock, state, configs }),
    // Hosted runs: implementations are matrix-owned, and the launcher hands
    // the runtime the one pinned legacy cutoff.
    externalImplementations: true,
    legacyReviewCutoff: LEGACY_REVIEW_CUTOFF.activatedNotBefore!,
  };
  // The fake store starts its own sequence at 1; the snapshot is as of `at`.
  const written = await state.writeRepair({
    ...seededState([shape.record], shape.reservations),
    updatedAt: at,
  }, null);
  assert.ok(written.ok && written.value.status === "applied");
  const snapshot = async () => {
    const read = await state.readRepair();
    if (!read.ok || read.value.status !== "found") throw new Error("state");
    return read.value.snapshot;
  };
  return {
    shape,
    clock,
    github,
    run: () =>
      runRepairCycle(deps, {
        deadline: clock.now() + 60 * MINUTE,
        stepLimit: 16,
      }),
    snapshot,
    work: async () => (await snapshot()).work[0]!,
  };
}

type LiveRigV1 = Awaited<ReturnType<typeof liveRig>>;

/**
 * What every recovered record keeps: the saved identity alone was read, the
 * ambiguous round is counted once with its intent cleared, every live charge
 * stays byte-for-byte (the ambiguous admission stays charged, nothing is
 * refunded) and nothing merges or closes.
 */
async function assertRecovered(rig: LiveRigV1, rounds: number) {
  const { record, reservations } = rig.shape;
  assert.equal(
    rig.github.observedReviewKeys[0],
    savedIntent(record).key,
    "the saved attempt identity is observed first",
  );
  const state = await rig.snapshot();
  const work = state.work[0]!;
  assert.equal(work.intent, null, "the expired ambiguous intent is cleared");
  assert.equal(work.counters.reviewRounds, rounds);
  for (const charge of reservations) {
    assert.deepEqual(
      state.reservations.find((row) => row.id === charge.id),
      charge,
      `charge ${charge.purpose}/${charge.attempt} is kept exactly`,
    );
  }
  assert.equal(
    state.reservations.some((row) =>
      row.taskId === record.id && row.outcome === "confirmed_not_submitted"
    ),
    false,
    "no admission is refunded",
  );
  assert.equal(work.target.head, record.target.head);
  assert.equal(work.target.pr, record.target.pr);
  assert.deepEqual(work.target.candidateState, record.target.candidateState);
  assert.equal(rig.github.calls.includes("merge"), false);
  assert.equal(
    rig.github.calls.some((call) => call.startsWith("closeIssue:")),
    false,
  );
  return { state, work };
}

function reviewCharges(
  state: { reservations: BudgetReservationV1[] },
  taskId: string,
) {
  return state.reservations.filter((row) =>
    row.taskId === taskId && row.purpose === "review_request"
  );
}

Deno.test("JAM B5 live replay: every saved request with no bound journal moves on the next pass", async (t) => {
  await t.step(
    "604 / PR 1053: green head, one round left -> round three is requested",
    async () => {
      const rig = await liveRig(604);
      const { record } = rig.shape;
      const outcome = await rig.run();
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const { state, work } = await assertRecovered(rig, 3);
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(work.wait?.since, NEXT_PASS);
      assert.equal(work.blocker, null);
      assert.deepEqual(
        rig.github.reviewRequestIdentities.map((row) => row.operationKey),
        [reviewOperationKey(1053, record.target.head!, 3)],
        "exactly one fresh, uniquely admitted round",
      );
      const fresh = reviewCharges(state, record.id).filter((row) =>
        row.attempt === 3
      );
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0]!.outcome, "submitted");
      assert.equal(reviewCharges(state, record.id).length, 3);
      // The next pass changes nothing: the fresh round is simply awaited.
      await rig.run();
      assert.deepEqual(await rig.work(), work, "no per-pass rewrite");
      assert.equal(rig.github.reviewRequestIdentities.length, 1);
    },
  );

  await t.step(
    "630 / PR 999: red head, one round left -> the CI-first gate owns it",
    async () => {
      const rig = await liveRig(630);
      const { record } = rig.shape;
      const outcome = await rig.run();
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const { state, work } = await assertRecovered(rig, 2);
      assert.equal(
        rig.github.reviewRequestIdentities.length,
        0,
        "a red head is never reviewed",
      );
      assert.equal(
        reviewCharges(state, record.id).length,
        2,
        "no review admission is added",
      );
      // The red, never-reviewed head is the CI-first gate's: where the hosted
      // pre-review fix route is closed (generation 80) it parks precisely,
      // where it is open it returns to `work` with the CI fix marker.
      if (preReviewCiFixRouteOpen({ externalImplementations: true })) {
        assert.equal(work.nextStep, "work");
        assert.deepEqual(work.wait, {
          reason: "backoff",
          since: NEXT_PASS,
          until: NEXT_PASS,
        });
        assert.equal(work.blocker, null);
      } else {
        assert.equal(work.nextStep, "blocked");
        assert.equal(work.blocker?.kind, "other");
        const message = work.blocker?.message ?? "";
        assert.ok(message.startsWith(CI_RED_PARK), message);
        assert.ok(message.includes("validate(failure)"), message);
        assert.equal(work.wait, null);
      }
      await rig.run();
      const next = await rig.work();
      assert.equal(next.intent, null);
      assert.equal(next.counters.reviewRounds, 2);
      assert.equal(rig.github.reviewRequestIdentities.length, 0);
    },
  );

  await t.step(
    "647 / PR 1011: rounds spent (legacy pin 4, green, unarmed) -> round five is requested",
    async () => {
      const rig = await liveRig(647);
      const { record } = rig.shape;
      const outcome = await rig.run();
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      // Rounds are accounting (owner directive 2026-10-30): the green head
      // gets its next review, never an UNREVIEWED park for the spent count.
      const { state, work } = await assertRecovered(rig, 5);
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(work.blocker, null);
      assert.deepEqual(
        rig.github.reviewRequestIdentities.map((row) => row.operationKey),
        [reviewOperationKey(1011, record.target.head!, 5)],
        "the fifth round is admitted",
      );
      assert.equal(
        reviewCharges(state, record.id).length,
        5,
        "the ambiguous round-4 admission stays charged; round five is added",
      );
      await rig.run();
      assert.deepEqual(await rig.work(), work, "the fresh round is awaited");
      assert.equal(rig.github.reviewRequestIdentities.length, 1);
    },
  );
});

Deno.test("JAM B5 bound: a saved request expires only once its own start is a full bound old", async () => {
  // The 604 shape: its wait is round one's (since = round one's journal
  // requestedAt), 15 minutes OLDER than the saved attempt-2 intent.
  const { record } = liveShape(604);
  const intent = savedIntent(record);
  assert.ok(record.wait !== null && record.wait.since < intent.startedAt);
  const atBound = intent.startedAt + REVIEW_BOUND_MS;
  assert.ok(atBound - 1 > record.wait.since + REVIEW_BOUND_MS);

  const early = await liveRig(604, atBound - 1);
  const before = await early.work();
  const deferred = await early.run();
  assert.notEqual(deferred.status, "state_error", JSON.stringify(deferred));
  assert.deepEqual(
    await early.work(),
    before,
    "before the bound nothing is written",
  );
  assert.equal(early.github.reviewRequestIdentities.length, 0);
  assert.equal(
    reviewCharges(await early.snapshot(), record.id).length,
    2,
  );

  const due = await liveRig(604, atBound);
  await due.run();
  await assertRecovered(due, 3);
  assert.equal(due.github.reviewRequestIdentities.length, 1);
  assert.equal(
    due.github.reviewRequestIdentities[0]!.operationKey,
    reviewOperationKey(1053, record.target.head!, 3),
  );
});

Deno.test("JAM B5 bound: an unavailable saved-request read uses the same anchor", async () => {
  const { record } = liveShape(604);
  const atBound = savedIntent(record).startedAt + REVIEW_BOUND_MS;

  // Past the earlier round's bound, inside the saved attempt's own: the
  // transient read only re-arms the quota wait (its start kept).
  const early = await liveRig(604, atBound - 1);
  early.github.failSavedObservation = true;
  await early.run();
  const waiting = await early.work();
  assert.equal(early.github.reviewRequestIdentities.length, 0);
  assert.deepEqual(waiting.intent, record.intent, "the intent is kept");
  assert.equal(waiting.counters.reviewRounds, 1);
  assert.equal(waiting.wait?.reason, "review_quota");
  assert.equal(waiting.wait?.since, record.wait!.since);
  assert.equal(
    reviewCharges(await early.snapshot(), record.id).length,
    2,
  );

  const due = await liveRig(604, atBound);
  due.github.failSavedObservation = true;
  await due.run();
  await assertRecovered(due, 3);
  assert.equal(due.github.reviewRequestIdentities.length, 1);
});
