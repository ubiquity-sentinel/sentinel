/** Charged task-bound review recovery and refusal controls. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { TASK_ACCEPTANCE_MISSING_DETAIL } from "../../src/repair/review-gate.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { reviewReceiptId } from "../../src/repair/keys.ts";
import { scopeLocalRepairIssues } from "../../src/host/local.ts";
import {
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  sha256Hex,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import {
  acceptedObservation,
  FAKE_ISSUE_TASK_DIGEST,
  missingTaskMemoryRig,
  reviewWaitIssueRecord,
} from "./loop-review-fixtures.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

Deno.test(
  "missing task review recovery: legacy clean review gets one charged task-bound round",
  async () => {
    // Unresolved P2/P3 findings never block delivery, so a legacy verdict
    // carrying only those is recovered exactly like a clean one.
    for (
      const [phase, nonBlocking] of [
        ["blocked", false],
        ["review", false],
        ["blocked", true],
      ] as const
    ) {
      const head = SHA2;
      const operationKey = `review:7:${head}:attempt-2`;
      const nextKey = `review:7:${head}:attempt-3`;
      const rig = await makeRig(`missing-task-${phase}-${nonBlocking}`, {
        summaries: false,
        github: {
          candidateLifecycle: {
            ...positiveLifecycle(),
            refs: { "refs/heads/sentinel/repair/issue-1": head },
            pullRequests: [exactOpenPr(7, head, "sentinel/repair/issue-1")],
          },
        },
      });
      try {
        const observation = {
          ...acceptedObservation(head, null, T0 + 2000),
          requestId: "legacy-review-request",
          resultId: "legacy-review-result",
        };
        const legacy = reviewReceipt(
          await reviewReceiptId(operationKey, head),
          {
            requestId: observation.requestId,
            observedReviewer: observation.reviewer,
            pullRequest: { number: 7, head, base: SHA1 },
            outcome: "completed",
            resultId: observation.resultId,
            submittedAt: T0 + 1000,
            completedAt: observation.completedAt,
            observedAt: observation.receivedAt,
            ...(nonBlocking
              ? {
                findings: [{
                  id: "finding-p2",
                  severity: "P2",
                  path: "src/app.ts",
                  message: "optional improvement",
                  fingerprint: "e".repeat(64),
                  resolved: false,
                  resolutionEvidence: null,
                }],
                unresolvedSeverities: ["P2"],
              }
              : {}),
          },
        );
        assert.equal(Object.hasOwn(legacy, "taskAcceptance"), false);
        const originalHash = await sha256Hex(canonicalStringify(legacy));
        const record = workRecord("issue-1", {
          ...reviewWaitIssueRecord(head),
          nextStep: phase,
          wait: null,
          blocker: phase === "blocked"
            ? {
              kind: "other",
              message: TASK_ACCEPTANCE_MISSING_DETAIL,
              since: T0 + 3000,
            }
            : null,
          counters: { attempts: 1, retries: 0, reviewRounds: 2 },
          updatedAt: T0 + 3000,
        });
        const priorCharges = [1, 2].map((attempt) =>
          reservation(`legacy-review-${attempt}`, {
            taskId: record.id,
            head,
            attempt,
            purpose: "review_request",
            outcome: "submitted",
            settledAt: T0 + 1000,
          })
        );
        const written = await rig.store.writeRepair(
          seededSnapshot([record], {
            updatedAt: T0 + 3000,
            reviews: [legacy],
            reservations: priorCharges,
          }),
          null,
        );
        assert.ok(written.ok && written.value.status === "applied");
        const storedLegacy = (await rig.snapshot()).reviews.find((receipt) =>
          receipt.id === legacy.id
        )!;
        assert.equal(Object.hasOwn(storedLegacy, "taskAcceptance"), false);
        assert.equal(
          await sha256Hex(canonicalStringify(storedLegacy)),
          originalHash,
        );
        rig.github.reviewObservationsByKey.set(operationKey, observation);
        rig.github.unboundReviewKeys.add(nextKey);
        rig.github.releasedHead = head;
        rig.clock.advance(3600_000 + 1);
        await rig.run();
        let state = await rig.snapshot();
        assert.equal(rig.github.reviewRequestIdentities.length, 1, phase);
        assert.equal(
          rig.github.reviewRequestIdentities[0]!.operationKey,
          nextKey,
        );
        assert.equal(state.work[0]!.counters.reviewRounds, 3);
        assert.equal(state.work[0]!.nextStep, "review");
        assert.equal(state.work[0]!.blocker, null);
        assert.equal(state.work[0]!.target.head, head);
        assert.equal(rig.model.requests.length, 0);
        assert.equal(rig.github.calls.includes("merge"), false);
        assert.equal(state.releaseRequests.length, 0);
        assert.equal(rig.github.lastReviewTask?.digest, FAKE_ISSUE_TASK_DIGEST);
        assert.deepEqual(
          state.reservations.filter((charge) => charge.attempt < 3),
          priorCharges,
        );
        assert.equal(
          state.reservations.filter((charge) => charge.attempt === 3).length,
          1,
        );
        assert.equal(
          await sha256Hex(
            canonicalStringify(
              state.reviews.find((receipt) => receipt.id === legacy.id),
            ),
          ),
          originalHash,
        );
        assert.equal(
          Object.hasOwn(
            state.reviews.find((receipt) => receipt.id === legacy.id)!,
            "taskAcceptance",
          ),
          false,
        );

        rig.github.unboundReviewKeys.delete(nextKey);
        rig.github.reviewObservationsByKey.set(nextKey, {
          ...acceptedObservation(head, {
            issueNumber: 1,
            taskDigest: FAKE_ISSUE_TASK_DIGEST,
            verdict: "fulfilled",
            evidence: ["the exact candidate fulfills the live task"],
          }, rig.clock.now() + 1000),
          requestId: "task-review-request",
          resultId: "task-review-result",
        });
        rig.clock.advance(15 * 60_000 + 1);
        await rig.run();
        state = await rig.snapshot();
        assert.equal(rig.github.reviewRequestIdentities.length, 1);
        assert.equal(
          rig.github.calls.filter((call) => call === "merge").length,
          1,
        );
        assert.equal(state.releaseRequests.length, 1);
        assert.equal(state.work[0]!.target.head, head);
        assert.equal(
          await sha256Hex(
            canonicalStringify(
              state.reviews.find((receipt) => receipt.id === legacy.id),
            ),
          ),
          originalHash,
        );
        assert.equal(
          Object.hasOwn(
            state.reviews.find((receipt) => receipt.id === legacy.id)!,
            "taskAcceptance",
          ),
          false,
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test("missing task review recovery: refusal controls preserve failed gates and charges", async () => {
  for (
    const control of [
      "unfulfilled",
      "uncertain",
      "wrong-task",
      "wrong-digest",
      "wrong-reviewer",
      "wrong-head",
      "wrong-base",
      "invalid-findings",
      "p1",
      "pending",
      "charged",
      "closed",
      "skip",
      "head-drift",
      "base-drift",
      "budget-cap",
      "disabled",
      "source-drift",
      "margin",
    ]
  ) {
    const rig = await missingTaskMemoryRig();
    let state = structuredClone(await rig.snapshot());
    if (
      ["unfulfilled", "uncertain", "wrong-task", "wrong-digest"].includes(
        control,
      )
    ) {
      rig.github.reviewObservationsByKey.set(rig.operationKey, {
        ...rig.observation,
        taskAcceptance: {
          issueNumber: control === "wrong-task" ? 2 : 1,
          taskDigest: control === "wrong-digest"
            ? "a".repeat(64)
            : FAKE_ISSUE_TASK_DIGEST,
          verdict: control === "unfulfilled"
            ? "not_fulfilled"
            : control === "uncertain"
            ? "uncertain"
            : "fulfilled",
          evidence: ["a non-missing acceptance remains its own refusal"],
        },
      });
    }
    if (control === "wrong-reviewer") {
      rig.github.reviewObservationsByKey.set(rig.operationKey, {
        ...rig.observation,
        reviewer: "untrusted[bot]",
      });
    }
    if (control === "wrong-head") {
      rig.github.reviewObservationsByKey.set(rig.operationKey, {
        ...rig.observation,
        observedHead: SHA3,
      });
    }
    if (control === "wrong-base") {
      rig.github.reviewObservationsByKey.set(rig.operationKey, {
        ...rig.observation,
        observedBase: SHA3,
      });
    }
    if (control === "invalid-findings") {
      rig.github.reviewObservationsByKey.set(rig.operationKey, {
        ...rig.observation,
        findings: [{} as never],
      });
    }
    if (control === "p1") {
      rig.github.reviewObservationsByKey.set(rig.operationKey, {
        ...rig.observation,
        findings: reviewReceipt("valid-p1-control", {
          findings: [{
            id: "legacy-p1",
            severity: "P1",
            path: "src/app.ts",
            message: "required fix",
            fingerprint: "b".repeat(64),
            resolved: false,
            resolutionEvidence: null,
          }],
          unresolvedSeverities: ["P1"],
        }).findings,
      });
    }
    if (control === "pending") {
      rig.github.unboundReviewKeys.delete(rig.nextKey);
      rig.github.reviewObservationsByKey.set(rig.nextKey, {
        ...rig.observation,
        status: "pending",
        completedAt: null,
        reviewer: null,
        resultId: null,
      });
    }
    if (control === "charged") {
      state.reservations.push(reservation("existing-third-review", {
        taskId: rig.record.id,
        head: rig.head,
        attempt: 3,
        purpose: "review_request",
      }));
    }
    if (control === "closed" || control === "skip") {
      const read = rig.github.readIssue.bind(rig.github);
      rig.github.readIssue = (number) =>
        read(number).then((result) =>
          result.ok && result.value !== null
            ? portOk({
              ...result.value,
              state: control === "closed" ? "closed" : "open",
              labels: control === "skip" ? ["sentinel:skip"] : [],
            })
            : result
        );
      scopeLocalRepairIssues(rig.github);
    }
    if (control === "head-drift") {
      rig.github.candidateRefs.set("refs/heads/sentinel/repair/issue-1", SHA3);
    }
    if (control === "base-drift") {
      const read = rig.github.readRef.bind(rig.github);
      rig.github.readRef = (ref) =>
        ref === "refs/heads/development"
          ? Promise.resolve(portOk({ ref, sha: SHA3 }))
          : read(ref);
      rig.github.prepareBaseRefresh = () =>
        Promise.resolve(
          portError("unavailable", "controlled refresh unavailable"),
        );
    }
    if (control === "budget-cap") {
      state.reservations.push(
        ...[1, 2, 3, 4, 5].map((attempt) =>
          reservation(`recent-cap-${attempt}`, {
            createdAt: rig.clock.now(),
            taskId: asWorkItemId(`other-${attempt}`),
            outcome: "submitted",
            settledAt: rig.clock.now(),
          })
        ),
      );
    }
    if (control === "disabled") {
      rig.configs[0] = parseRepositoryConfigV1({
        ...rig.configs[0],
        liveStartLimits: null,
      });
    }
    if (control === "source-drift") {
      const read = rig.github.readIssue.bind(rig.github);
      rig.github.readIssue = (number) =>
        read(number).then((result) =>
          result.ok && result.value !== null
            ? portOk({ ...result.value, number: 2 })
            : result
        );
    }
    if (control === "margin") {
      const read = rig.github.readRef.bind(rig.github);
      rig.github.readRef = (ref) => {
        if (ref === "refs/heads/development") rig.clock.advance(60 * 60_000);
        return read(ref);
      };
    }
    const written = await rig.state.writeRepair({
      ...state,
      stateHead: rig.state.repairHead,
      sequence: state.sequence + 1,
      updatedAt: rig.clock.now(),
    }, rig.state.repairHead);
    assert.ok(written.ok && written.value.status === "applied", control);
    const oldHash = await sha256Hex(canonicalStringify(state.reviews));
    const chargeCount = state.reservations.length;
    await rig.run();
    state = await rig.snapshot();
    assert.equal(rig.github.reviewRequestIdentities.length, 0, control);
    assert.equal(rig.model.requests.length, 0, control);
    assert.equal(rig.github.calls.includes("merge"), false, control);
    assert.equal(state.reservations.length, chargeCount, control);
    assert.equal(state.work[0]!.target.head, rig.head, control);
    assert.equal(
      await sha256Hex(canonicalStringify(state.reviews)),
      oldHash,
      control,
    );
  }
});

Deno.test("missing task review recovery: ambiguous submission observes its saved round without another charge", async () => {
  const rig = await missingTaskMemoryRig({ reviewRequestOutcome: "ambiguous" });
  const oldHash = await sha256Hex(canonicalStringify(rig.legacy));
  const outcome = await rig.run();
  let state = await rig.snapshot();
  assert.equal(
    rig.github.reviewRequestIdentities.length,
    1,
    JSON.stringify({ outcome, work: state.work[0], calls: rig.github.calls }),
  );
  assert.equal(state.work[0]!.intent?.key, rig.nextKey);
  assert.equal(
    state.reservations.filter((charge) => charge.attempt === 3).length,
    1,
  );
  rig.github.unboundReviewKeys.delete(rig.nextKey);
  rig.github.reviewObservationsByKey.set(rig.nextKey, {
    ...rig.observation,
    status: "pending",
    completedAt: null,
    reviewer: null,
    resultId: null,
  });
  rig.clock.advance(15 * 60_000 + 1);
  await rig.run();
  state = await rig.snapshot();
  assert.equal(state.work[0]!.counters.reviewRounds, 3);
  assert.equal(rig.github.reviewRequestIdentities.length, 1);
  assert.equal(
    state.reservations.filter((charge) => charge.attempt === 3).length,
    1,
  );
  assert.equal(
    state.reservations.find((charge) => charge.attempt === 3)!.outcome,
    "ambiguous",
  );
  rig.github.reviewObservationsByKey.set(rig.nextKey, {
    ...acceptedObservation(rig.head, {
      issueNumber: 1,
      taskDigest: FAKE_ISSUE_TASK_DIGEST,
      verdict: "fulfilled",
      evidence: ["the exact candidate fulfills the live task"],
    }, rig.clock.now() + 1000),
    requestId: "ambiguous-task-review",
    resultId: "ambiguous-task-result",
  });
  rig.clock.advance(15 * 60_000 + 1);
  await rig.run();
  state = await rig.snapshot();
  assert.equal(rig.github.reviewRequestIdentities.length, 1);
  assert.equal(
    state.reservations.filter((charge) => charge.attempt === 3).length,
    1,
  );
  assert.equal(
    rig.github.calls.filter((call) => call === "merge").length,
    1,
    JSON.stringify({
      work: state.work[0],
      reviews: state.reviews,
      calls: rig.github.calls.slice(-12),
    }),
  );
  assert.equal(
    await sha256Hex(
      canonicalStringify(
        state.reviews.find((receipt) => receipt.id === rig.legacy.id),
      ),
    ),
    oldHash,
  );
});

Deno.test("missing task review recovery: current attempt never falls back to an older pass", async () => {
  for (
    const phase of [
      "legacy",
      "pending",
      "unavailable",
      "negative",
      "reserved",
      "later-reserved",
      "newer-negative",
      "newer-pending",
      "newer-unavailable",
    ] as const
  ) {
    const head = SHA2;
    const github = new RelationsFakeGithub({
      baseSha: SHA1,
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { "refs/heads/sentinel/repair/issue-1": head },
        pullRequests: [exactOpenPr(7, head, "sentinel/repair/issue-1")],
      },
    });
    github.latest.set(1, issueRecord(1));
    const rig = makeMemoryRig(github);
    const oldPass = reviewReceipt(
      await reviewReceiptId(`review:7:${head}`, head),
      {
        observedReviewer: github.reviewerIdentity,
        pullRequest: { number: 7, head, base: SHA1 },
        outcome: "completed",
        resultId: "legacy-pass-result",
        completedAt: T0 + 2000,
        taskAcceptance: {
          issueNumber: 1,
          taskDigest: FAKE_ISSUE_TASK_DIGEST,
          verdict: "fulfilled",
          evidence: ["the legacy candidate fulfills the task"],
        },
      },
    );
    const newer = phase.startsWith("newer-");
    const rounds = phase === "later-reserved" || newer ? 2 : 3;
    const record = workRecord("issue-1", {
      ...reviewWaitIssueRecord(head),
      nextStep: "delivery",
      wait: null,
      counters: { attempts: 1, retries: 0, reviewRounds: rounds },
    });
    const reviews = [oldPass];
    if (
      ["pending", "unavailable", "negative", "later-reserved"].includes(
        phase,
      ) || newer
    ) {
      const completed = phase === "negative" || phase === "later-reserved" ||
        phase === "newer-negative";
      const negative = phase === "negative" || phase === "newer-negative";
      reviews.push(
        reviewReceipt(
          await reviewReceiptId(
            `review:7:${head}:attempt-${newer ? 3 : rounds}`,
            head,
          ),
          {
            observedReviewer: completed ? github.reviewerIdentity : null,
            pullRequest: { number: 7, head, base: SHA1 },
            outcome: completed
              ? "completed"
              : phase === "newer-pending"
              ? "pending"
              : phase === "newer-unavailable"
              ? "unavailable"
              : phase,
            resultId: completed ? "current-pass-or-refusal" : null,
            completedAt: completed ? T0 + 2000 : null,
            taskAcceptance: completed
              ? {
                issueNumber: 1,
                taskDigest: FAKE_ISSUE_TASK_DIGEST,
                verdict: negative ? "not_fulfilled" : "fulfilled",
                evidence: ["the exact current attempt carries its own verdict"],
              }
              : null,
          },
        ),
      );
    }
    const reservations = phase === "reserved" || phase === "later-reserved"
      ? [reservation("outstanding-current-review", {
        taskId: record.id,
        head,
        attempt: 3,
        purpose: "review_request",
      })]
      : [];
    const written = await rig.state.writeRepair(
      seededSnapshot([record], { reviews, reservations }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied", phase);
    rig.clock.advance(3000);
    await rig.run();
    assert.equal(
      github.calls.filter((call) => call === "merge").length,
      phase === "legacy" ? 1 : 0,
      phase,
    );
    assert.equal(github.reviewRequestIdentities.length, 0, phase);
    assert.equal(rig.model.requests.length, 0, phase);
  }
});

Deno.test("missing task review recovery: three prior rounds allow a fourth task-bound review without accepting the legacy verdict", async () => {
  const rig = await missingTaskMemoryRig({}, 3);
  const original = canonicalStringify(rig.legacy);
  await rig.run(1);
  const state = await rig.snapshot();
  assert.equal(state.work[0]!.counters.reviewRounds, 4);
  assert.equal(rig.github.reviewRequestIdentities.length, 1);
  assert.equal(
    rig.github.reviewRequestIdentities[0]!.operationKey,
    rig.nextKey,
  );
  assert.equal(state.reservations.length, 4);
  assert.deepEqual(state.reservations.slice(0, 3), rig.charges);
  assert.equal(
    canonicalStringify(state.reviews.find((row) => row.id === rig.legacy.id)),
    original,
  );
  assert.equal(rig.github.calls.includes("merge"), false);
  assert.equal(rig.model.requests.length, 0);
});
