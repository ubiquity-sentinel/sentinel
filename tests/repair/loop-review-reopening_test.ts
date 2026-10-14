/** Closed-unmerged review intents are released and republished. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { reservation, SHA1, SHA3, T0, workRecord } from "../state/helpers.ts";
import { repairConfigs } from "./helpers.ts";
import { issueRecord, makeRig, seededSnapshot } from "./loop-rig.ts";
import { exactClosedPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

Deno.test(
  "issue-140: a closed-unmerged review-intent PR is cleared and republished, never re-adopted",
  async () => {
    const taskId = asWorkItemId("issue-140");
    const branch = candidateBranch(taskId);
    const rig = await makeRig("closed-review-intent", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: SHA3 },
          pullRequests: [exactClosedPr(7, SHA3, branch)],
        },
      },
    });
    try {
      const seeded = await rig.store.writeRepair(
        seededSnapshot([
          workRecord("issue-140", {
            source: { kind: "issue", id: "140", revision: SHA1 },
            related: { incidentId: null, issueNumber: 140 },
            target: {
              base: SHA1,
              branch,
              checkpoint: null,
              head: SHA3,
              pr: null,
            },
            nextStep: "work",
            intent: {
              kind: "review_request",
              key: `review:7:${SHA3}`,
              startedAt: T0,
              branch,
              expectedHead: SHA3,
              observedBase: SHA1,
              pr: 7,
              requestId: null,
              resultId: null,
            },
          }),
        ]),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const record = state.work[0];
      // The dead PR was cleared and never re-adopted: the record's identity is
      // the fresh replacement PR, not the closed number 7.
      assert.equal(record.intent, null, "the dead review intent is cleared");
      assert.notEqual(record.target.pr, 7, "the closed PR is not re-adopted");
      assert.notEqual(record.target.pr, null, "a replacement was published");
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        1,
        "exactly one replacement publication",
      );
      assert.equal(
        rig.github.reviewRequestIdentities.length,
        1,
        "exactly one review request for the replacement",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "issue-140: a review_pending wait parked on a closed-unmerged PR is released with the dead intent",
  async () => {
    const taskId = asWorkItemId("issue-140-wait");
    const branch = candidateBranch(taskId);
    const requestId = "review-req-140-wait";
    // The closed PR is NOT the sentinel-owned candidate branch (a foreign or
    // older PR): the #85 retirement requires headRef === candidateBranch, so
    // it never fires and the parked wait pins the record forever.
    const foreignRef = "someone-else/stale-feature";
    const rig = await makeRig("closed-review-wait", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: SHA3 },
          pullRequests: [exactClosedPr(7, SHA3, foreignRef)],
        },
      },
    });
    rig.github.readIssue = (number) =>
      Promise.resolve(portOk(issueRecord(number, {
        relations: { openBlockers: [], subIssueCount: 0 },
      })));
    try {
      // The live stall shape: an EXPIRED review_pending wait paired with a
      // review_request intent that names a closed-unmerged PR, with a settled
      // (submitted) admission charge for the dead request.
      const seeded = await rig.store.writeRepair(
        seededSnapshot(
          [
            workRecord("issue-140-wait", {
              source: { kind: "issue", id: "140", revision: SHA1 },
              related: { incidentId: null, issueNumber: 140 },
              counters: { attempts: 1, retries: 0, reviewRounds: 1 },
              target: {
                base: SHA1,
                branch,
                checkpoint: null,
                head: SHA3,
                pr: null,
              },
              nextStep: "work",
              wait: {
                reason: "review_pending",
                since: T0 - 100_000,
                until: T0 - 50_000,
              },
              intent: {
                kind: "review_request",
                key: `review:7:${SHA3}`,
                startedAt: T0 - 100_000,
                branch,
                expectedHead: SHA3,
                observedBase: SHA1,
                pr: 7,
                requestId,
                resultId: null,
              },
            }),
          ],
          {
            reservations: [
              reservation(requestId, {
                taskId,
                attempt: 1,
                head: SHA3,
                purpose: "review_request",
                outcome: "submitted",
                createdAt: T0 - 95_000,
                settledAt: T0 - 90_000,
              }),
            ],
          },
        ),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");

      const configs = repairConfigs({
        sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
      });
      const outcome = await runRepairCycle({
        clock: rig.clock,
        state: rig.store,
        configs,
        controllerSha: SHA1,
        github: rig.github,
        githubCooldown: new DurableGitHubCooldownGate({
          state: rig.store,
          clock: rig.clock,
        }),
        incidents: rig.incidents,
        replay: rig.replay,
        model: rig.model,
        budget: new RollingStartBudget({
          clock: rig.clock,
          state: rig.store,
          configs,
        }),
      }, { deadline: rig.clock.now() + 60 * 60_000, stepLimit: 3 });
      const state = await rig.snapshot();
      const record = state.work[0];
      assert.equal(
        rig.github.reviewRequestIdentities.length,
        1,
        `eligible native issue relations reach replacement review admission: ${
          JSON.stringify({
            outcome,
            nextStep: record.nextStep,
            intent: record.intent?.kind,
            wait: record.wait,
            pr: record.target.pr,
            blocker: record.blocker,
            calls: rig.github.calls.filter((call) =>
              /listOpenIssues|readPr|readRef|push|createPr|requestReview/.test(
                call,
              )
            ),
          })
        }`,
      );
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      assert.equal(record.nextStep, "review");
      // Recovery replaces the expired wait with the new PR's bounded review
      // observation; the old operation never owns that replacement.
      assert.equal(record.wait?.reason, "review_pending");
      assert.equal(record.wait?.since, T0);
      assert.equal(record.wait?.until, T0 + 15 * 60_000);
      assert.equal(record.target.head, SHA3);
      assert.equal(
        rig.github.reviewRequestIdentities[0]?.prNumber,
        record.target.pr,
      );
      assert.equal(rig.github.reviewRequestIdentities[0]?.expectedHead, SHA3);
      assert.ok(
        record.intent === null || record.intent.key !== `review:7:${SHA3}`,
        "the dead review intent is cleared",
      );
      assert.notEqual(record.target.pr, 7, "the closed PR is not re-adopted");
      // The settled charge for the dead request is preserved, never
      // resubmitted or dropped.
      const charge = state.reservations.find((r) => r.id === requestId);
      assert.ok(charge !== undefined, "the dead request charge is retained");
      assert.equal(charge.outcome, "submitted");
      assert.equal(
        state.reservations.filter((r) => r.id === requestId).length,
        1,
      );
      assert.equal(charge.head, SHA3);
      assert.equal(charge.attempt, 1);
      assert.equal(charge.createdAt, T0 - 95_000);
      assert.equal(charge.settledAt, T0 - 90_000);
      assert.equal(rig.model.requests.length, 0);
      assert.equal(rig.github.calls.includes("mergePr"), false);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
