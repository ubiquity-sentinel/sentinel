/**
 * The CI-first gate and the missing task acceptance recovery. A head reviewed
 * clean on its exact base only by a change-only (legacy) verdict can never be
 * delivered: the merge gate refuses `TASK_ACCEPTANCE_MISSING_DETAIL` with a
 * run-level state_error. Its recovery re-requests one task-bound review from
 * `review` through `requestReviewFor`, so the CI-first gate judges that head
 * too. While its CI is not green the head must wait AT `review` (never at
 * `work`, where it reads as awaiting a CI correction whose non-failing exit
 * delivers it to the refusing merge gate, and never parked), uncharged, and
 * get its one task-bound review once green. R79, the rollback target, reads
 * every such wait as the review it always requested: one charged round, never
 * a state_error or a merge. The R79 case is ignored in a checkout without R79.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type GitHubCheckV1,
  portOk,
  type ReviewObservationV1,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { reviewReceiptId } from "../../src/repair/keys.ts";
import { headTaskAcceptanceMissing } from "../../src/repair/loop-review-records.ts";
import { TASK_ACCEPTANCE_MISSING_DETAIL } from "../../src/repair/review-gate.ts";
import {
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { assertGen79Parses } from "../state/gen77-contracts.ts";
import {
  gen79Available,
  loadGen79Modules,
} from "../host/gen77-runtime-source.ts";
import type * as LoopRig from "./loop-rig.ts";
import { makeRig, seededSnapshot } from "./loop-rig.ts";
import {
  acceptedObservation,
  completedReceipt,
  reviewWaitIssueRecord,
} from "./loop-review-fixtures.ts";
import type * as CandidateFixtures from "./loop-candidate-fixtures.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

const available = await gen79Available();

const HEAD = SHA2;
const BRANCH = "sentinel/repair/issue-1";
const LEGACY_KEY = `review:7:${HEAD}:attempt-2`;
const NEXT_KEY = `review:7:${HEAD}:attempt-3`;
const HOUR = 60 * 60_000;

/** The not-green CI shapes a reviewed head may show at its re-request. */
const MODES = ["pending", "base_red", "unattributed"] as const;
type Mode = typeof MODES[number];

function run(
  name: string,
  head: GitSha,
  conclusion: GitHubCheckV1["conclusion"],
  status: GitHubCheckV1["status"] = "completed",
): GitHubCheckV1 {
  return {
    name,
    status,
    conclusion,
    head,
    startedAt: T0,
    completedAt: status === "completed" ? T0 + 1 : null,
  };
}

/** Head and base check runs of one mode (the base is SHA1). */
function modeChecks(mode: Mode): Record<string, GitHubCheckV1[]> {
  switch (mode) {
    case "pending":
      return {
        [HEAD]: [run("validate", HEAD, null, "in_progress")],
        [SHA1]: [run("validate", SHA1, "success")],
      };
    case "base_red":
      return {
        [HEAD]: [run("validate", HEAD, "failure")],
        [SHA1]: [run("validate", SHA1, "failure")],
      };
    case "unattributed":
      return {
        [HEAD]: [run("validate", HEAD, "failure")],
        [SHA1]: [run("validate", SHA1, "cancelled")],
      };
  }
}

const GREEN = [run("validate", HEAD, "success")];

/** The change-only verdict and the blocked record the recovery re-requests. */
async function legacyState() {
  const observation: ReviewObservationV1 = {
    ...acceptedObservation(HEAD, null, T0 + 2000),
    requestId: "legacy-review-request",
    resultId: "legacy-review-result",
  };
  const legacy = reviewReceipt(await reviewReceiptId(LEGACY_KEY, HEAD), {
    requestId: observation.requestId,
    observedReviewer: observation.reviewer,
    pullRequest: { number: 7, head: HEAD, base: SHA1 },
    outcome: "completed",
    resultId: observation.resultId,
    submittedAt: T0 + 1000,
    completedAt: observation.completedAt,
    observedAt: observation.receivedAt,
  });
  const record = workRecord("issue-1", {
    ...reviewWaitIssueRecord(HEAD),
    nextStep: "blocked",
    wait: null,
    blocker: {
      kind: "other",
      message: TASK_ACCEPTANCE_MISSING_DETAIL,
      since: T0 + 3000,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 2 },
    updatedAt: T0 + 3000,
  });
  const charges = [1, 2].map((attempt) =>
    reservation(`legacy-review-${attempt}`, {
      taskId: record.id,
      head: HEAD,
      attempt,
      purpose: "review_request",
      outcome: "submitted",
      settledAt: T0 + 1000,
    })
  );
  return { observation, legacy, record, charges };
}

/**
 * A rig (this tree's, or R79's own) whose fake GitHub serves the legacy
 * verdict under its attempt key, an unbound next attempt and `checks`.
 */
function wire(
  rig: Pick<LoopRig.RigV1, "github">,
  observation: ReviewObservationV1,
  checks: Record<string, GitHubCheckV1[]>,
  reads: GitSha[] = [],
) {
  rig.github.reviewObservationsByKey.set(LEGACY_KEY, observation);
  rig.github.unboundReviewKeys.add(NEXT_KEY);
  rig.github.releasedHead = HEAD;
  rig.github.readChecks = (sha: GitSha) => {
    reads.push(sha);
    return Promise.resolve(
      portOk({ head: sha, checks: checks[sha] ?? GREEN }),
    );
  };
}

async function missingAcceptanceRig(
  prefix: string,
  mode: Mode,
  hosted: boolean,
) {
  const rig = await makeRig(prefix, {
    summaries: false,
    ...(hosted ? { externalImplementations: true } : {}),
    github: {
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { [`refs/heads/${BRANCH}`]: HEAD },
        pullRequests: [exactOpenPr(7, HEAD, BRANCH)],
      },
    },
  });
  const { observation, legacy, record, charges } = await legacyState();
  const written = await rig.store.writeRepair(
    seededSnapshot([record], {
      updatedAt: T0 + 3000,
      reviews: [legacy],
      reservations: charges,
    }),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  const checks = modeChecks(mode);
  wire(rig, observation, checks);
  const writes: RepairStateSnapshotV1[] = [];
  const write = rig.store.writeRepair.bind(rig.store);
  rig.store.writeRepair = (snapshot, expectedHead) => {
    writes.push(structuredClone(snapshot));
    return write(snapshot, expectedHead);
  };
  rig.clock.advance(HOUR + 1);
  const setHead = (runs: GitHubCheckV1[]) => {
    checks[HEAD] = runs;
  };
  return { rig, charges, writes, setHead };
}

/** The wait the gate holds a reviewed head in for each mode. */
const EXPECTED_WAIT: Record<Mode, string> = {
  pending: "ci_pending",
  base_red: "backoff",
  unattributed: "ci_pending",
};

for (const hosted of [false, true]) {
  for (const mode of MODES) {
    const where = hosted ? "hosted" : "in process";
    Deno.test(`CI first, missing task acceptance: ${mode} CI keeps the reviewed head at review, then a green head gets its one task-bound review (${where})`, async () => {
      const { rig, charges, setHead } = await missingAcceptanceRig(
        `cf-ma-${mode}-${hosted ? "hosted" : "local"}`,
        mode,
        hosted,
      );
      try {
        // Fourteen polls span more than the six-hour pre-review bound: the
        // reviewed head is never parked, delivered or returned to `work`.
        for (let poll = 0; poll < 14; poll++) {
          const outcome = await rig.run();
          assert.notEqual(
            outcome.status,
            "state_error",
            `poll ${poll}: ${JSON.stringify(outcome)}`,
          );
          const state = await rig.snapshot();
          const work = state.work[0]!;
          assert.equal(work.nextStep, "review", `poll ${poll}`);
          assert.equal(work.blocker, null, `poll ${poll}`);
          assert.equal(work.wait?.reason, EXPECTED_WAIT[mode], `poll ${poll}`);
          assert.equal(work.target.head, HEAD);
          assert.equal(work.counters.reviewRounds, 2, "no round counted");
          assert.equal(work.counters.retries, 0, "no CI fix charged");
          assert.deepEqual(state.reservations, charges, "nothing charged");
          assert.equal(rig.github.reviewRequestIdentities.length, 0);
          assert.equal(rig.model.requests.length, 0);
          assert.equal(rig.github.calls.includes("merge"), false);
          rig.clock.advance(31 * 60_000);
        }
        // Green: the next poll requests the one task-bound review.
        setHead(GREEN);
        const outcome = await rig.run();
        assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
        const state = await rig.snapshot();
        const work = state.work[0]!;
        assert.deepEqual(
          rig.github.reviewRequestIdentities.map((request) =>
            request.operationKey
          ),
          [NEXT_KEY],
        );
        assert.equal(work.nextStep, "review");
        assert.equal(work.counters.reviewRounds, 3);
        assert.equal(rig.model.requests.length, 0);
        assert.equal(rig.github.calls.includes("merge"), false);
        assert.equal(
          state.reservations.filter((charge) => charge.attempt === 3).length,
          1,
          "exactly one charged task-bound review",
        );
      } finally {
        await rig.ctx.cleanup();
      }
    });
  }
}

Deno.test("CI first, missing task acceptance: a red head whose failure is gone before its correction returns to review, never to delivery", async () => {
  const { rig, charges } = await missingAcceptanceRig(
    "cf-ma-gone",
    "pending",
    false,
  );
  // The head is red through its own change when the gate reads it, and green
  // again when the correction re-derives the failure (a flake re-run).
  let headReads = 0;
  rig.github.readChecks = (sha: GitSha) => {
    const checks = sha !== HEAD
      ? [run("validate", sha, "success")]
      : headReads++ === 0
      ? [run("validate", HEAD, "failure")]
      : GREEN;
    return Promise.resolve(portOk({ head: sha, checks }));
  };
  try {
    const outcome = await rig.run();
    assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0]!;
    assert.ok(headReads >= 2, "the failure was re-derived before any charge");
    assert.equal(rig.model.requests.length, 0, "no correction ran");
    assert.equal(rig.github.calls.includes("merge"), false);
    assert.deepEqual(
      rig.github.reviewRequestIdentities.map((request) => request.operationKey),
      [NEXT_KEY],
      "the green head gets its one task-bound review",
    );
    assert.equal(work.nextStep, "review");
    assert.equal(work.counters.reviewRounds, 3);
    assert.equal(work.counters.retries, 0);
    assert.deepEqual(
      state.reservations.filter((charge) => charge.attempt < 3),
      charges,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first, missing task acceptance: any change-only clean verdict on the exact head and base keeps the head away from delivery", () => {
  const record = reviewWaitIssueRecord(HEAD);
  const bound = completedReceipt(7, HEAD, SHA1, { id: "bound" });
  const changeOnly = completedReceipt(7, HEAD, SHA1, {
    id: "change-only",
    taskAcceptance: null,
  });
  const missing = (reviews: RepairStateSnapshotV1["reviews"]) =>
    headTaskAcceptanceMissing(seededSnapshot([record], { reviews }), record);
  assert.equal(missing([]), false, "no review");
  assert.equal(missing([bound]), false, "a task-bound verdict delivers");
  assert.equal(missing([changeOnly]), true);
  // The merge gate selects one receipt by round, so a change-only verdict
  // next to a task-bound one may still be the one it refuses: `review`
  // re-observes the standing verdict instead of risking the state_error.
  assert.equal(missing([bound, changeOnly]), true);
  // Only a clean verdict on this exact PR, head and base counts.
  assert.equal(
    missing([{ ...changeOnly, unresolvedSeverities: ["P0"] }]),
    false,
    "a rejection is a correction, not a missing acceptance",
  );
  // Owner directive 2026-10-24: only an unresolved P0 blocks, so a P1-only
  // change-only verdict is a clean one whose task acceptance is still missing.
  assert.equal(
    missing([{ ...changeOnly, unresolvedSeverities: ["P1"] }]),
    true,
    "an unresolved P1 is no rejection: the clean verdict lacks acceptance",
  );
  assert.equal(
    missing([{
      ...changeOnly,
      pullRequest: { ...changeOnly.pullRequest, base: SHA2 },
    }]),
    false,
    "another base",
  );
  assert.equal(
    headTaskAcceptanceMissing(
      seededSnapshot([record], { reviews: [changeOnly] }),
      { ...record, related: { ...record.related, issueNumber: null } },
    ),
    false,
    "only an issue task needs task acceptance",
  );
});

/** R79's own loop rig and fixtures, extracted from the pinned commit. */
async function loadR79() {
  const loaded = await loadGen79Modules([
    "tests/repair/loop-rig.ts",
    "tests/repair/loop-candidate-fixtures.ts",
  ]);
  const [loopRig, fixtures] = loaded.modules as unknown as [
    typeof LoopRig,
    typeof CandidateFixtures,
  ];
  return { loopRig, fixtures, dispose: loaded.dispose };
}

Deno.test({
  name:
    "rollback to generation 79: R79 consumes every missing-acceptance CI wait generation 80 wrote with one charged review, never a state_error or a merge",
  ignore: !available,
  async fn(t) {
    const r79 = await loadR79();
    try {
      for (const hosted of [false, true]) {
        for (const mode of MODES) {
          const label = `${mode} (${hosted ? "hosted" : "in process"})`;
          await t.step(label, async () => {
            const { rig, writes } = await missingAcceptanceRig(
              `cf-ma-r79-${mode}-${hosted ? "hosted" : "local"}`,
              mode,
              hosted,
            );
            const old = await r79.loopRig.makeRig(
              `cf-ma-r79-old-${mode}-${hosted ? "hosted" : "local"}`,
              {
                summaries: false,
                ...(hosted ? { externalImplementations: true } : {}),
                github: {
                  candidateLifecycle: {
                    ...r79.fixtures.positiveLifecycle(),
                    refs: { [`refs/heads/${BRANCH}`]: HEAD },
                    pullRequests: [r79.fixtures.exactOpenPr(7, HEAD, BRANCH)],
                  },
                },
              },
            );
            try {
              // Generation 80 holds the reviewed head at `review`.
              const outcome = await rig.run();
              assert.notEqual(outcome.status, "state_error");
              const left = await rig.snapshot();
              assert.equal(left.work[0]!.nextStep, "review");
              assert.equal(left.work[0]!.wait?.reason, EXPECTED_WAIT[mode]);
              assert.equal(rig.github.reviewRequestIdentities.length, 0);
              assert.ok(writes.length > 0);
              for (const written of writes) await assertGen79Parses(written);

              // A failed generation 80 restores R79 over exactly that state.
              const seeded = await old.store.writeRepair(
                r79.loopRig.seededSnapshot(left.work, {
                  updatedAt: left.updatedAt,
                  reviews: left.reviews,
                  reservations: left.reservations,
                }),
                null,
              );
              assert.ok(seeded.ok && seeded.value.status === "applied");
              const { observation } = await legacyState();
              wire(old, observation, modeChecks(mode));
              old.clock.advance(rig.clock.now() - old.clock.now());
              old.clock.advance(31 * 60_000);
              const consumed = await old.run();
              assert.notEqual(
                consumed.status,
                "state_error",
                JSON.stringify(consumed),
              );
              const after = await old.snapshot();
              const work = after.work[0]!;
              assert.deepEqual(
                old.github.reviewRequestIdentities.map((request) =>
                  request.operationKey
                ),
                [NEXT_KEY],
                "R79 requests the one review it always did",
              );
              assert.equal(work.counters.reviewRounds, 3);
              assert.equal(old.model.requests.length, 0);
              assert.equal(old.github.calls.includes("merge"), false);
              for (const charge of left.reservations) {
                assert.deepEqual(
                  after.reservations.find((row) => row.id === charge.id),
                  charge,
                  "every charge kept, never refunded",
                );
              }
              assert.equal(
                after.reservations.length,
                left.reservations.length + 1,
              );
            } finally {
              await rig.ctx.cleanup();
              await old.ctx.cleanup();
            }
          });
        }
      }
    } finally {
      await r79.dispose();
    }
  },
});
