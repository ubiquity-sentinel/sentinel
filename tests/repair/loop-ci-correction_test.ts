/**
 * Candidate-caused CI failures on a reviewed head: correction round, red-base
 * deferral and the terminal block once review rounds are spent. Every case runs
 * the real repair loop over real Git state with fake GitHub/model ports, and
 * every state write keeps the exact generation-76 shapes (no CI evidence is
 * persisted: the attribution is re-derived from live check runs).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { SHA4 } from "./loop-rig.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import {
  assertGeneration76Shapes,
  check,
  ciRig,
  TASK,
} from "./ci-correction-rig.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy-retries.ts";
import { ciGreenHeadKey } from "../../ops/hosted-autonomy-ci-retries.ts";
import { HOSTED_CI_CORRECTIONS } from "../../src/repair/ci-rejection.ts";
import { healthyProof } from "../host/hosted-autonomy-rig.ts";

/** A generation-78+ runtime carrying the CI correction route (test allowlist). */
const RUNTIME = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a" as GitSha;
const PROVEN_RUNTIME: HostedRuntimeRecordV1 = {
  version: "v1",
  kind: "hosted_runtime",
  id: HOSTED_RUNTIME_ID,
  activeRevision: RUNTIME,
  generation: 78,
  lastHealthyProof: healthyProof(RUNTIME, 78, "ci-correction-release"),
  lastExecutionProof: null,
  nextOrdinaryAt: T0,
  execution: null,
  createdAt: T0,
  updatedAt: T0,
} as HostedRuntimeRecordV1;

Deno.test("a reviewed head that breaks checks green on its base opens a charged correction round", async () => {
  const { rig, charges, atModelStart, writes } = await ciRig("ci-correct", {
    checks: {
      [SHA3]: [
        check("validate", SHA3, "failure"),
        check("verify-artifact", SHA3, "skipped"),
      ],
      [SHA1]: [
        check("validate", SHA1, "success"),
        check("verify-artifact", SHA1, "success"),
      ],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(
      rig.model.requests.length,
      1,
      "the CI failure opens exactly one correction session",
    );
    const request = rig.model.requests[0];
    assert.equal(request.base, SHA1, "the reviewed base is kept");
    assert.equal(request.checkoutBase, SHA3, "correction starts from the head");
    assert.equal(request.reviewFindings?.length, 1);
    const finding = request.reviewFindings![0];
    assert.equal(finding.severity, "P1");
    assert.equal(finding.path, null);
    assert.match(finding.message, /validate \(failure\)/);
    // A skipped dependent job is never the candidate's own failure.
    assert.doesNotMatch(finding.message, /verify-artifact/);
    assert.match(finding.message, new RegExp(SHA1.slice(0, 12)));

    // Nothing new is persisted before the charged session starts: the record
    // holds only its ordinary implementation intent on the legacy target.
    const durable = atModelStart[0].work[0];
    assert.equal(durable.intent?.kind, "implementation");
    assert.deepEqual(Object.keys(durable.target).sort(), [
      "base",
      "branch",
      "checkpoint",
      "head",
      "pr",
    ]);

    const after = await rig.snapshot();
    const work = after.work[0];
    assert.equal(work.blocker, null, "no terminal CI block");
    assert.equal(work.nextStep, "review");
    assert.equal(work.target.head, SHA4, "corrected candidate head");
    assert.equal(work.target.pr, 7, "correction lands on the same PR");
    assert.equal(work.counters.reviewRounds, 2, "one more review round");
    assert.equal(work.counters.attempts, 2);
    assert.equal(
      work.counters.retries,
      1,
      "the CI fix is charged in retries, never as a review round",
    );
    assert.deepEqual(
      rig.github.pushes.map((push) => [push.sha, push.expected]),
      [[SHA4, SHA3]],
      "the corrected head replaces the rejected head on the same branch",
    );
    assert.equal(rig.github.calls.includes("merge"), false, "never merged");
    // Charges stay charged: the original implementation and review keep their
    // settlement, and the correction plus its review are new admissions.
    for (const charge of charges) {
      assert.deepEqual(
        after.reservations.find((row) => row.id === charge.id),
        charge,
      );
    }
    const retry = after.reservations.filter((row) =>
      row.taskId === TASK && row.purpose === "retry"
    );
    assert.equal(retry.length, 1);
    assert.equal(retry[0].attempt, 2);
    assert.equal(retry[0].outcome, "submitted");
    assert.ok(
      after.reservations.some((row) =>
        row.purpose === "review_request" && row.head === SHA4 &&
        row.attempt === 2
      ),
      "the corrected head is reviewed in its own round",
    );
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("a CI correction of an accepted head carries no superseded rejection of an earlier head", async () => {
  // Head SHA2 of the same PR was rejected earlier; SHA3 resolved it and was
  // accepted. Only SHA3's live CI failure is the correction's to resolve.
  const superseded = completedReceipt(7, SHA2, SHA1, {
    id: `review-receipt:7:${SHA2}`,
    resultId: "superseded-result",
    findings: [{
      id: "github-review-1-finding-0",
      fingerprint: "e".repeat(64),
      severity: "P1",
      path: "src/superseded.ts",
      message: "superseded P1 finding resolved by the accepted head",
      resolutionEvidence: null,
      resolved: false,
    }],
    unresolvedSeverities: ["P1"],
    submittedAt: T0 - 5000,
    completedAt: T0 - 4000,
    observedAt: T0 - 3999,
  });
  const { rig, writes } = await ciRig("ci-superseded", {
    priorReviews: [superseded],
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 1, "one correction session");
    const findings = rig.model.requests[0].reviewFindings ?? [];
    assert.equal(findings.length, 1, JSON.stringify(findings));
    assert.match(findings[0].message, /validate \(failure\)/);
    assert.equal(
      findings.some((finding) => finding.path === "src/superseded.ts"),
      false,
      "the accepted head superseded the earlier rejection",
    );
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("a timed-out head check green on its base is the candidate's to correct", async () => {
  const { rig, writes } = await ciRig("ci-timedout", {
    checks: {
      [SHA3]: [check("test-local", SHA3, "timed_out")],
      [SHA1]: [check("test-local", SHA1, "success")],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 1);
    assert.match(
      rig.model.requests[0].reviewFindings?.[0]?.message ?? "",
      /test-local \(timed_out\)/,
    );
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

for (
  const conclusion of ["failure", "timed_out", "action_required"] as const
) {
  Deno.test(`a check that is also ${conclusion} on the base defers without spending a correction round`, async () => {
    const { rig, charges, writes } = await ciRig(`ci-redbase-${conclusion}`, {
      checks: {
        [SHA3]: [
          check("test-local", SHA3, "failure"),
          check("verify-artifact", SHA3, "skipped"),
        ],
        [SHA1]: [check("test-local", SHA1, conclusion)],
      },
    });
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      assert.equal(rig.model.requests.length, 0, "no correction session");
      const after = await rig.snapshot();
      const work = after.work[0];
      assert.equal(work.nextStep, "delivery", "kept at delivery");
      assert.equal(work.blocker, null, "a red base is never a terminal block");
      assert.equal(work.wait?.reason, "backoff");
      assert.ok(work.wait!.until! > rig.clock.now(), "bounded re-observation");
      assert.equal(work.target.head, SHA3);
      assert.equal(work.counters.reviewRounds, 1, "no review round spent");
      assert.deepEqual(after.reservations, charges, "nothing charged");
      assert.equal(rig.github.calls.includes("merge"), false);
      assertGeneration76Shapes(writes);
    } finally {
      await rig.ctx.cleanup();
    }
  });
}

for (const conclusion of ["skipped", "neutral", "cancelled", null] as const) {
  Deno.test(`a base check that concluded ${conclusion} proves nothing: blocked uncharged, never backed off`, async () => {
    const { rig, charges, writes } = await ciRig(
      `ci-basenoise-${conclusion}`,
      {
        checks: {
          [SHA3]: [check("validate", SHA3, "failure")],
          [SHA1]: [check("validate", SHA1, conclusion)],
        },
      },
    );
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      assert.equal(rig.model.requests.length, 0, "no correction is spent");
      const after = await rig.snapshot();
      const work = after.work[0];
      assert.equal(work.nextStep, "blocked", "never an endless red-base wait");
      assert.equal(work.wait, null);
      assert.equal(
        work.blocker?.message,
        "CI checks failed without base evidence: validate(failure)",
      );
      assert.deepEqual(after.reservations, charges);
      assertGeneration76Shapes(writes);
    } finally {
      await rig.ctx.cleanup();
    }
  });
}

Deno.test("a head check that only concluded cancelled never spends a charged round", async () => {
  const { rig, charges, writes } = await ciRig("ci-headnoise-cancelled", {
    checks: {
      [SHA3]: [check("validate", SHA3, "cancelled")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0, "no correction session");
    const after = await rig.snapshot();
    const work = after.work[0];
    assert.equal(work.nextStep, "blocked");
    assert.equal(
      work.blocker?.message,
      "CI checks failed without base evidence: validate(cancelled)",
    );
    assert.equal(work.counters.reviewRounds, 1);
    assert.deepEqual(after.reservations, charges, "nothing charged");
    assert.equal(rig.github.calls.includes("merge"), false, "never merged");
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

// Owner directive 2026-10-24: a job the target's own CI skipped or marked
// neutral is a green check, never a failure. Such a head is neither corrected
// (no charged round) nor blocked: it is delivered.
for (const conclusion of ["skipped", "neutral"] as const) {
  Deno.test(`a head check that only concluded ${conclusion} is green: delivered without a correction, a block or a charge`, async () => {
    const { rig, charges, writes } = await ciRig(
      `ci-headgreen-${conclusion}`,
      {
        checks: {
          [SHA3]: [check("validate", SHA3, conclusion)],
          [SHA1]: [check("validate", SHA1, "success")],
        },
      },
    );
    try {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      assert.equal(rig.model.requests.length, 0, "no correction session");
      const after = await rig.snapshot();
      const work = after.work[0];
      assert.equal(work.nextStep, "delivery");
      assert.equal(work.blocker, null, `${conclusion} is never a block`);
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        1,
        "the green reviewed head merges",
      );
      assert.equal(work.target.head, SHA3);
      assert.equal(work.counters.reviewRounds, 1, "no review round spent");
      assert.deepEqual(after.reservations, charges, "nothing charged");
      assertGeneration76Shapes(writes);
    } finally {
      await rig.ctx.cleanup();
    }
  });
}

Deno.test("a base check still running is awaited before any attribution", async () => {
  const { rig, charges, writes } = await ciRig("ci-basepending", {
    checks: {
      [SHA3]: [check("test-local", SHA3, "failure")],
      [SHA1]: [check("test-local", SHA1, null, "in_progress")],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0);
    const work = (await rig.snapshot()).work[0];
    assert.equal(work.nextStep, "delivery");
    assert.equal(work.blocker, null);
    assert.equal(work.wait?.reason, "ci_pending");
    assert.equal(work.counters.reviewRounds, 1);
    assert.deepEqual((await rig.snapshot()).reservations, charges);
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("a failed check the base never ran proves nothing and stays blocked uncharged", async () => {
  const { rig, charges, writes } = await ciRig("ci-unattributed", {
    checks: {
      [SHA3]: [check("preview-deploy", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0, "no correction is spent");
    const after = await rig.snapshot();
    const work = after.work[0];
    assert.equal(work.nextStep, "blocked");
    assert.equal(
      work.blocker?.message,
      "CI checks failed without base evidence: preview-deploy(failure)",
    );
    assert.deepEqual(after.reservations, charges);
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("once review rounds are spent a candidate CI failure stays terminally blocked", async () => {
  const { rig, charges, writes } = await ciRig("ci-exhausted", {
    reviewRounds: 3,
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0);
    const after = await rig.snapshot();
    const work = after.work[0];
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.blocker?.message, "CI checks failed: validate(failure)");
    assert.equal(work.target.pr, 7, "the publication identity is kept");
    assert.deepEqual(after.reservations, charges);
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

for (
  const [label, uncorrectable] of [
    ["spent review rounds", { reviewRounds: 3 }],
    ["an undescribed candidate", {
      candidateState: { preserved: null, publishedHead: SHA3 },
    }],
  ] as const
) {
  for (
    const [baseLabel, baseCheck] of [
      ["red", check("validate", SHA1, "failure")],
      ["pending", check("validate", SHA1, null, "in_progress")],
    ] as const
  ) {
    Deno.test(`a ${baseLabel} base never parks an uncorrectable head (${label}): legacy terminal block`, async () => {
      const { rig, moveBase, charges, refreshes, writes } = await ciRig(
        `ci-uncorrectable-${baseLabel}-${label.replaceAll(" ", "-")}`,
        {
          ...uncorrectable,
          checks: {
            [SHA3]: [check("validate", SHA3, "failure")],
            [SHA1]: [baseCheck],
          },
        },
      );
      try {
        const outcome = await rig.run();
        assert.equal(outcome.status, "idle", JSON.stringify(outcome));
        assert.equal(rig.model.requests.length, 0, "no correction session");
        const after = await rig.snapshot();
        const work = after.work[0];
        assert.equal(work.nextStep, "blocked", "never an open-ended wait");
        assert.equal(work.wait, null);
        assert.equal(
          work.blocker?.message,
          "CI checks failed: validate(failure)",
          "the exact generation-76 terminal block",
        );
        assert.deepEqual(after.reservations, charges, "nothing charged");
        // While development stays red and moves on, the blocked head is never
        // refreshed into another charged review round.
        moveBase(SHA2);
        rig.clock.advance(60 * 60_000);
        const again = await rig.run();
        assert.equal(again.status, "idle", JSON.stringify(again));
        assert.equal(refreshes.length, 0, "never refreshed onto a moved base");
        const later = await rig.snapshot();
        assert.equal(later.work[0].nextStep, "blocked");
        assert.equal(
          later.work[0].counters.reviewRounds,
          work.counters.reviewRounds,
          "no further review round",
        );
        assert.deepEqual(later.reservations, charges, "nothing charged");
        assertGeneration76Shapes(writes);
      } finally {
        await rig.ctx.cleanup();
      }
    });
  }
}

Deno.test("a broken head on a moved base is corrected instead of refreshed and re-reviewed", async () => {
  const { rig, refreshes, writes } = await ciRig("ci-movedbase", {
    baseTip: SHA2,
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(
      refreshes.filter((request) => request.expectedHead === SHA3).length,
      0,
      "the CI-rejected head is never refreshed onto the new base",
    );
    assert.equal(rig.model.requests.length, 1, "one correction session");
    assert.equal(rig.model.requests[0].checkoutBase, SHA3);
    assert.equal(rig.model.requests[0].base, SHA1);
    assert.match(
      rig.model.requests[0].reviewFindings?.[0]?.message ?? "",
      /validate \(failure\)/,
    );
    const work = (await rig.snapshot()).work[0];
    assert.equal(work.target.head, SHA4, "the corrected head is current");
    assert.equal(work.blocker, null);
    // Only the corrected head is refreshed onto the moved base before its
    // review, so the correction spends no round on the old base.
    assert.deepEqual(
      [...new Set(refreshes.map((request) => request.expectedHead))],
      [SHA4],
    );
    assert.equal(work.counters.reviewRounds, 1);
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("a hosted run routes a candidate-caused failure to its matrix correction, uncharged until the planner grants it", async () => {
  // Generation 78 opens the hosted route: its rollback target R77 isolates
  // the correction cell (matrix-ci-correction-gen77) and bounds the awaiting
  // record's rollback cost (ci-correction-rollback-gen77).
  assert.equal(HOSTED_CI_CORRECTIONS, true);
  const { rig, charges, checkReads, writes } = await ciRig("ci-hosted", {
    hosted: true,
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  });
  try {
    await rig.run();
    const after = await rig.snapshot();
    const work = after.work[0];
    assert.equal(work.nextStep, "work", JSON.stringify(work));
    assert.equal(work.blocker, null);
    assert.equal(work.wait, null);
    assert.equal(work.intent, null, "the trusted planner owns the grant");
    assert.equal(work.target.head, SHA3);
    assert.equal(work.counters.reviewRounds, 1, "no review round is spent");
    assert.equal(rig.model.requests.length, 0, "no in-process session");
    assert.ok(checkReads.includes(SHA1), "attributed against its base");
    assert.deepEqual(after.reservations, charges, "nothing charged yet");
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("a hosted run corrects a broken head on a moved base before any refresh", async () => {
  const { rig, refreshes, charges } = await ciRig("ci-hosted-moved", {
    hosted: true,
    baseTip: SHA2,
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  });
  try {
    await rig.run();
    const after = await rig.snapshot();
    const work = after.work[0];
    assert.equal(rig.model.requests.length, 0, "no in-process session");
    assert.equal(work.nextStep, "work", JSON.stringify(work));
    assert.equal(work.target.head, SHA3);
    assert.equal(
      refreshes.some((request) => request.expectedHead === SHA3),
      false,
      "the broken head is never refreshed and re-reviewed",
    );
    assert.deepEqual(after.reservations, charges, "nothing charged yet");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("a correction is re-derived from live checks: a base that turned red returns the head to delivery uncharged", async () => {
  // The record was routed to its correction earlier; by the time the session
  // would start, the same check is red on the reviewed base too.
  const { rig, charges, writes } = await ciRig("ci-rederive", {
    nextStep: "work",
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "failure")],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0, "no correction session");
    const after = await rig.snapshot();
    const work = after.work[0];
    assert.equal(work.nextStep, "delivery", "the gate owns the head again");
    assert.equal(work.wait?.reason, "backoff", "red base deferral");
    assert.equal(work.blocker, null);
    assert.equal(work.target.head, SHA3);
    assert.equal(work.counters.attempts, 1, "no attempt is started");
    assert.equal(work.counters.reviewRounds, 1, "no review round is spent");
    assert.deepEqual(after.reservations, charges, "nothing charged");
    assert.equal(rig.github.pushes.length, 0, "the head is never re-published");
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("the launcher re-admits a legacy CI block into the runtime's own attribution and correction", async () => {
  const { rig, refreshes, writes } = await ciRig("ci-legacy", {
    baseTip: SHA2,
    blocker: "CI checks failed: verify-artifact(skipped), validate(failure)",
    checks: {
      [SHA3]: [
        check("validate", SHA3, "failure"),
        check("verify-artifact", SHA3, "skipped"),
      ],
      [SHA1]: [
        check("validate", SHA1, "success"),
        check("verify-artifact", SHA1, "success"),
      ],
    },
  });
  try {
    const read = await rig.store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") return;
    const now = rig.clock.now();
    assert.equal(
      planHostedRetries(read.value.snapshot, now, RUNTIME).length,
      0,
      "inert without the installed runtime's healthy proof",
    );
    const proven = {
      ciRuntime: PROVEN_RUNTIME,
      ciAllowlist: new Set([RUNTIME]),
    };
    assert.equal(
      planHostedRetries(
        read.value.snapshot,
        now,
        RUNTIME,
        new Map(),
        new Set(),
        undefined,
        proven,
      ).length,
      0,
      "a flake re-run that may still act goes first",
    );
    const plans = planHostedRetries(
      read.value.snapshot,
      now,
      RUNTIME,
      new Map(),
      new Set(),
      undefined,
      {
        ...proven,
        ciRerunSettled: new Set([
          ciGreenHeadKey(read.value.snapshot.work[0].repository, SHA3),
        ]),
      },
    );
    assert.equal(plans.length, 1, "the legacy CI block is retryable");
    assert.equal(plans[0].nextStep, "delivery");
    assert.equal(plans[0].advanceBase, false, "the runtime decides refresh");
    const next = applyHostedRetries(
      read.value.snapshot,
      read.value.head,
      plans,
      now,
    );
    const readmitted = next.work[0];
    assert.equal(readmitted.nextStep, "delivery");
    assert.equal(readmitted.blocker, null);
    assert.equal(readmitted.intent, null);
    assert.deepEqual(readmitted.counters, read.value.snapshot.work[0].counters);
    const written = await rig.store.writeRepair(next, read.value.head);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 1, "a correction, not a re-review");
    assert.equal(rig.model.requests[0].checkoutBase, SHA3);
    const work = (await rig.snapshot()).work[0];
    assert.equal(work.target.head, SHA4);
    assert.equal(work.blocker, null);
    assert.equal(
      refreshes.some((request) => request.expectedHead === SHA3),
      false,
      "the broken head is never refreshed and re-reviewed",
    );
    assert.equal(work.counters.reviewRounds, 1, "no round spent on SHA3");
    assertGeneration76Shapes(writes);
  } finally {
    await rig.ctx.cleanup();
  }
});
