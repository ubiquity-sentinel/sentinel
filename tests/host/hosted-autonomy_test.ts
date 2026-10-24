import assert from "node:assert/strict";
import {
  candidatePreservationRef,
  releaseRequestId,
} from "../../src/repair/keys.ts";
import {
  buildHostedReleaseRequest,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
} from "../../ops/hosted-autonomy.ts";
import type { HostedAutonomyPullV1 } from "../../ops/hosted-autonomy.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  deliveryRecord,
  finding,
  FOREIGN_PR,
  FOREIGN_REPO,
  FOREIGN_TASK,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
  MERGE,
  pullFacts,
  RECEIPT_ID,
  SELF_REPO,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  readRequests,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

/**
 * Focused suite for the bounded hosted autonomy pass (transient-failure retry
 * and autonomous delivery) that the protected maintenance job runs before
 * `prepare`.
 *
 * The runner core is exercised credential-free against the ACTUAL production
 * repair/release GitStateStores over disposable local bare repositories, with a
 * fake GitHub surface. Fixtures are minimal sanitized records built through the
 * frozen parsers; no production snapshot, token, path or private payload is
 * committed or read.
 */
Deno.test("hosted autonomy: a damaged foreign merged PR is recovered only for verified closure", async () => {
  const original = foreignRecord();
  const receipt = foreignReceipt();
  const record = foreignRecord({
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "pull request was merged outside the trusted review path",
      since: T0 + 4000,
    },
    target: {
      ...original.target,
      pr: null,
      candidateState: {
        preserved: {
          ref: await candidatePreservationRef(
            original.repository,
            original.id,
            `base_refresh:${FOREIGN_PR}:${HEAD}:${BASE}`,
          ),
          head: HEAD,
          base: BASE,
          operationKey: `base_refresh:${FOREIGN_PR}:${HEAD}:${BASE}`,
        },
        publishedHead: HEAD,
      },
    },
    evidence: [{
      kind: "review_receipt",
      ref: `artifact:review-receipt/${receipt.id}`,
    }],
  });
  const charge = reservation("retained-foreign-charge", {
    taskId: record.id,
    outcome: "submitted",
    settledAt: T0 + 3000,
  });
  const { rig, github } = await makeRig("foreign-damaged-pr", {
    repair: repairSnapshot([record], [receipt], [], [charge]),
    pull: {
      ...foreignPullFacts({ author: "ubiquity-sentinel[bot]" }),
      mergedBy: "ubiquity-sentinel[bot]",
    } as HostedAutonomyPullV1,
  });
  try {
    const result = await run(rig, github);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.deepEqual(rig.closed, [FOREIGN_TASK.issueNumber]);
    assert.equal(rig.merges, 0);
    assert.equal(rig.writes, 1, "recovery and closure share the existing CAS");
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    const state = read.value.snapshot;
    assert.equal(state.work[0].nextStep, "done");
    assert.deepEqual(state.work[0].target, {
      ...record.target,
      pr: FOREIGN_PR,
    });
    assert.deepEqual(state.work[0].source, record.source);
    assert.deepEqual(state.work[0].counters, record.counters);
    assert.deepEqual(state.work[0].evidence, record.evidence);
    assert.deepEqual(state.reviews, [receipt]);
    assert.deepEqual(state.reservations, [charge]);
    assert.deepEqual(state.releaseRequests, []);
    const again = await run(rig, github);
    assert.equal(again.status, "skipped");
    assert.equal(rig.closed.length, 1);
    assert.equal(rig.writes, 1);
    for (
      const control of [
        "missing-receipt",
        "ambiguous-pr",
        "wrong-scope",
        "wrong-review-head",
        "wrong-review-base",
        "wrong-task",
        "wrong-reviewer",
        "quality-only",
        "p0",
        "missing-merger",
        "alternate-merger",
        "alternate-author",
        "wrong-pr",
        "wrong-pull-head",
        "wrong-parents",
        "not-integrated",
        "unmerged",
        "wrong-branch",
        "red-checks",
        "unavailable-checks",
        "task-drift",
        "unavailable-task",
        "unsettled-intent",
        "missing-preservation",
        "unpublished-head",
        "wrong-preserved-ref",
        "unrelated-blocker",
        "self-scope",
      ]
    ) {
      let damaged = record;
      let reviews = [receipt];
      const pull: HostedAutonomyPullV1 = {
        ...foreignPullFacts({ author: "ubiquity-sentinel[bot]" }),
        mergedBy: "ubiquity-sentinel[bot]",
      };
      const reviewOverrides: Record<string, unknown> = {};
      if (control === "missing-receipt") reviews = [];
      if (control === "ambiguous-pr") {
        const other = foreignReceipt({
          id: `review-receipt:${"c".repeat(64)}`,
          pullRequest: { ...receipt.pullRequest, number: FOREIGN_PR + 1 },
        });
        reviews.push(other);
        damaged = foreignRecord({
          ...record,
          evidence: [...record.evidence, {
            kind: "review_receipt",
            ref: `artifact:review-receipt/${other.id}`,
          }],
        });
      }
      if (control === "wrong-scope") {
        reviewOverrides.repository = { ...FOREIGN_REPO, installationId: 8 };
      }
      if (control === "wrong-review-head") {
        reviewOverrides.pullRequest = { ...receipt.pullRequest, head: SHA1 };
      }
      if (control === "wrong-review-base") {
        reviewOverrides.pullRequest = { ...receipt.pullRequest, base: SHA1 };
      }
      if (control === "wrong-task") {
        reviewOverrides.taskAcceptance = {
          ...receipt.taskAcceptance!,
          issueNumber: 121,
        };
      }
      if (control === "wrong-reviewer") {
        reviewOverrides.expectedReviewer = "github-actions[bot]";
        reviewOverrides.observedReviewer = "github-actions[bot]";
      }
      if (control === "quality-only") reviewOverrides.taskAcceptance = null;
      if (control === "p0") {
        reviewOverrides.findings = [finding("P0")];
        reviewOverrides.unresolvedSeverities = ["P0"];
      }
      if (Object.keys(reviewOverrides).length > 0) {
        reviews = [foreignReceipt(reviewOverrides)];
      }
      if (control === "missing-merger") delete pull.mergedBy;
      if (control === "alternate-merger") pull.mergedBy = "0x4007";
      if (control === "alternate-author") pull.author = "github-actions[bot]";
      if (control === "wrong-pr") pull.number++;
      if (control === "wrong-pull-head") pull.headSha = SHA1;
      if (control === "wrong-parents") pull.parents = [BASE, SHA1];
      if (control === "not-integrated") pull.revisionOnBaseBranch = false;
      if (control === "unmerged") {
        pull.merged = false;
        pull.mergeCommitSha = null;
      }
      if (control === "wrong-branch") pull.baseRef = "other";
      if (control === "unsettled-intent") {
        damaged = foreignRecord({
          ...record,
          intent: {
            kind: "implementation",
            key: "implementation:unsettled",
            startedAt: T0,
            branch: record.target.branch,
            expectedHead: HEAD,
            observedBase: BASE,
            pr: null,
            requestId: "unknown-reservation",
            resultId: null,
          },
        });
      }
      if (control === "missing-preservation") {
        damaged = foreignRecord({
          ...record,
          target: {
            ...record.target,
            candidateState: { preserved: null, publishedHead: HEAD },
          },
        });
      }
      if (control === "unpublished-head") {
        damaged = foreignRecord({
          ...record,
          target: {
            ...record.target,
            candidateState: {
              ...record.target.candidateState!,
              publishedHead: null,
            },
          },
        });
      }
      if (control === "wrong-preserved-ref") {
        damaged = foreignRecord({
          ...record,
          target: {
            ...record.target,
            candidateState: {
              ...record.target.candidateState!,
              preserved: {
                ...record.target.candidateState!.preserved!,
                ref: `refs/heads/sentinel-candidates/${"f".repeat(64)}`,
              },
            },
          },
        });
      }
      if (control === "unrelated-blocker") {
        damaged = foreignRecord({
          ...record,
          blocker: {
            kind: "other",
            message: "unrelated terminal blocker",
            since: T0,
          },
        });
      }
      if (control === "self-scope") {
        damaged = foreignRecord({
          ...record,
          repository: SELF_REPO,
          target: {
            ...record.target,
            candidateState: {
              ...record.target.candidateState!,
              preserved: {
                ...record.target.candidateState!.preserved!,
                ref: await candidatePreservationRef(
                  SELF_REPO,
                  record.id,
                  record.target.candidateState!.preserved!.operationKey,
                ),
              },
            },
          },
        });
        reviews = [foreignReceipt({ repository: SELF_REPO })];
      }
      const negative = await makeRig(`foreign-damaged-${control}`, {
        repair: repairSnapshot([damaged], reviews, [], [charge]),
        pull,
        foreignCheckGreen: control !== "red-checks",
        issueTask: control === "unavailable-task"
          ? () => Promise.resolve(null)
          : control === "task-drift"
          ? () =>
            Promise.resolve({
              ...FOREIGN_TASK,
              digest: "d".repeat(64) as never,
            })
          : undefined,
      });
      const reads: number[] = [];
      const readPull = negative.github.readPull;
      negative.github.readPull = (number, branch) => {
        reads.push(number);
        return number === FOREIGN_PR
          ? readPull(number, branch)
          : Promise.resolve(null);
      };
      if (control === "unavailable-checks") {
        negative.github.hasAllChecksGreen = () =>
          Promise.reject(new Error("unavailable checks"));
      }
      try {
        const before = await negative.rig.state.readRepair();
        await run(negative.rig, negative.github);
        assert.deepEqual(negative.rig.closed, [], control);
        assert.equal(negative.rig.merges, 0, control);
        assert.equal(negative.rig.writes, 0, control);
        assert.deepEqual(
          await negative.rig.state.readRepair(),
          before,
          control,
        );
        assert.ok(reads.every((number) => number === FOREIGN_PR), control);
      } finally {
        await Deno.remove(negative.rig.tmp, { recursive: true });
      }
    }
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test(
  "hosted autonomy: a merged reviewed head records the deterministic release request",
  async () => {
    const { rig, github } = await makeRig("autonomy-request");
    const result = await run(rig, github);
    assert.equal(result.status, "applied");
    assert.equal(result.reason, "applied");
    assert.deepEqual([...result.revisions], [MERGE]);
    assert.equal(rig.writes, 1);
    const requests = await readRequests(rig);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].id, await releaseRequestId(SELF_REPO, MERGE, 51));
    assert.equal(requests[0].revision, MERGE);
    assert.equal(requests[0].source.head, HEAD);
    assert.equal(requests[0].source.base, BASE);
    assert.equal(requests[0].source.reviewReceiptId, RECEIPT_ID);
    assert.equal(requests[0].target.environment, "production");
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a new request sorting before recorded ones verifies its readback",
  async () => {
    // The store reads release requests back ordered by id, so the written
    // snapshot must already hold them in that order: an appended request whose
    // id is not the highest was applied but reported readback_unverified.
    const added = await releaseRequestId(SELF_REPO, MERGE, 51);
    let before: ReleaseRequestV1 | null = null;
    let after: ReleaseRequestV1 | null = null;
    for (let pr = 100; pr < 400 && (before === null || after === null); pr++) {
      const other = await buildHostedReleaseRequest(
        SELF_REPO,
        SHA1,
        SHA1,
        BASE,
        pr,
        authorizingReceipt(),
        T0 + 2000,
      );
      if (other === null) throw new Error("fixture request invalid");
      if (other.id < added) before ??= other;
      else after ??= other;
    }
    if (before === null || after === null) throw new Error("no fixture ids");
    const { rig, github } = await makeRig("autonomy-request-order", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()], [
        before,
        after,
      ]),
    });
    try {
      const result = await run(rig, github);
      assert.equal(result.status, "applied", JSON.stringify(result));
      assert.equal(result.reason, "applied");
      assert.ok(result.actions.some((action) => action.endsWith(`:${added}`)));
      assert.equal(rig.writes, 1);
      const requests = await readRequests(rig);
      assert.deepEqual(
        requests.map((request) => request.id),
        [before.id, added, after.id],
      );
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

Deno.test(
  "hosted autonomy: an open reviewed head is merged and then recorded once",
  async () => {
    const { rig, github } = await makeRig("autonomy-merge", {
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      afterMerge: pullFacts(),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 1);
    assert.equal(result.status, "applied");
    assert.ok(result.actions.some((action) => action.startsWith("merge:")));
    assert.equal((await readRequests(rig)).length, 1);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an already recorded delivery is never duplicated",
  async () => {
    const existing = await buildHostedReleaseRequest(
      SELF_REPO,
      MERGE,
      HEAD,
      BASE,
      51,
      authorizingReceipt(),
      T0 + 2000,
    );
    if (existing === null) throw new Error("fixture request invalid");
    const { rig, github } = await makeRig("autonomy-idempotent", {
      repair: repairSnapshot([deliveryRecord()], [authorizingReceipt()], [
        existing,
      ]),
    });
    const result = await run(rig, github);
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "already_recorded");
    assert.equal(rig.writes, 0);
    assert.equal(rig.merges, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: only a receipt with no unresolved P0 authorizes delivery",
  async () => {
    // Owner directive 2026-10-24: an unresolved P0 is the only blocking
    // severity; a P1 (like a P2) leaves the receipt authorizing.
    const blocked = await makeRig("autonomy-p0", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          findings: [finding("P0")],
          unresolvedSeverities: ["P0"],
        }),
      ]),
    });
    assert.equal((await run(blocked.rig, blocked.github)).status, "skipped");
    assert.equal(blocked.rig.writes, 0);
    assert.equal(blocked.rig.merges, 0);

    const allowedP1 = await makeRig("autonomy-p1", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          findings: [finding("P1")],
          unresolvedSeverities: ["P1"],
        }),
      ]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      afterMerge: pullFacts(),
    });
    assert.equal(
      (await run(allowedP1.rig, allowedP1.github)).status,
      "applied",
    );
    assert.equal(allowedP1.rig.merges, 1);

    const allowed = await makeRig("autonomy-p2", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          findings: [finding("P2")],
          unresolvedSeverities: ["P2"],
        }),
      ]),
    });
    assert.equal((await run(allowed.rig, allowed.github)).status, "applied");

    const otherHead = await makeRig("autonomy-other-head", {
      repair: repairSnapshot([deliveryRecord()], [
        authorizingReceipt({
          pullRequest: { number: 51, head: SHA1, base: BASE },
        }),
      ]),
    });
    assert.equal(
      (await run(otherHead.rig, otherHead.github)).status,
      "skipped",
    );
    assert.equal(otherHead.rig.writes, 0);

    await Promise.all(
      [blocked, allowedP1, allowed, otherHead].map((entry) =>
        Deno.remove(entry.rig.tmp, { recursive: true })
      ),
    );
  },
);

Deno.test(
  "hosted autonomy: a moved base, a pending check, a foreign author or an unproven merge never delivers",
  async () => {
    const openPull = pullFacts({
      state: "open",
      merged: false,
      mergeCommitSha: null,
    });
    const movedBase = await makeRig("autonomy-base", {
      pull: openPull,
      baseTip: SHA1,
    });
    const movedResult = await run(movedBase.rig, movedBase.github);
    assert.equal(movedBase.rig.merges, 0);
    assert.ok(
      movedResult.actions.some((action) => action.endsWith("base_moved")),
    );

    const pending = await makeRig("autonomy-checks", {
      pull: openPull,
      checkGreen: false,
    });
    const pendingResult = await run(pending.rig, pending.github);
    assert.equal(pending.rig.merges, 0);
    assert.ok(
      pendingResult.actions.some((action) => action.endsWith("checks_pending")),
    );

    const foreign = await makeRig("autonomy-author", {
      pull: pullFacts({ author: "someone-else" }),
    });
    // The sentinel App bot is now a trusted delivery author; a pull request
    // authored by it must deliver exactly like the native Actions identity.
    const appAuthored = await makeRig("autonomy-app-author", {
      pull: pullFacts({
        state: "open",
        merged: false,
        mergeCommitSha: null,
        author: "ubiquity-sentinel[bot]",
      }),
      afterMerge: pullFacts({ author: "ubiquity-sentinel[bot]" }),
    });
    const foreignResult = await run(foreign.rig, foreign.github);
    assert.equal(foreignResult.status, "skipped");
    assert.equal(foreignResult.reason, "foreign_author");
    assert.equal(foreign.rig.merges, 0);
    assert.equal(foreign.rig.writes, 0);

    // The App-authored pull request is trusted and delivers end to end.
    const appResult = await run(appAuthored.rig, appAuthored.github);
    assert.equal(appResult.status, "applied", JSON.stringify(appResult));
    assert.equal(appAuthored.rig.merges, 1);

    const wrongParents = await makeRig("autonomy-parents", {
      pull: pullFacts({ parents: [BASE] }),
    });
    assert.equal(
      (await run(wrongParents.rig, wrongParents.github)).status,
      "skipped",
    );
    assert.equal(wrongParents.rig.writes, 0);

    await Promise.all(
      [movedBase, pending, foreign, appAuthored, wrongParents].map((entry) =>
        Deno.remove(entry.rig.tmp, { recursive: true })
      ),
    );
  },
);

Deno.test(
  "hosted autonomy: a delivered head authored by the sentinel App login is accepted during the transition",
  async () => {
    assert.deepEqual(
      [...HOSTED_AUTONOMY_TRUSTED_AUTHORS].sort(),
      ["github-actions[bot]", "ubiquity-sentinel[bot]"],
      "the transition set accepts exactly the native and App logins",
    );
    for (const [index, author] of HOSTED_AUTONOMY_TRUSTED_AUTHORS.entries()) {
      const { rig, github } = await makeRig(`autonomy-author-${index}`, {
        pull: pullFacts({ author }),
      });
      try {
        const result = await run(rig, github);
        assert.equal(
          result.status,
          "applied",
          `${author}: ${JSON.stringify(result)}`,
        );
        assert.equal(result.reason, "applied", author);
        assert.equal(rig.writes, 1, author);
        const requests = await readRequests(rig);
        assert.equal(requests.length, 1, author);
        assert.equal(requests[0].revision, MERGE, author);
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    }
  },
);
