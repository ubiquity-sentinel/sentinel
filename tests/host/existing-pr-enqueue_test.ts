import assert from "node:assert/strict";
import { nativeLifecycleRig } from "../repair/existing-pr-lifecycle-fixtures.ts";
import { routeExistingPr } from "../../src/repair/loop-existing-pr.ts";
import { persistTransition } from "../../src/repair/loop-state.ts";
import { submitQueueAdmission } from "../../ops/hosted-autonomy-queue-submit.ts";
import { QueueCustodyWriter } from "../../ops/hosted-autonomy-queue-writer.ts";
import { createHostedQueueAuthority } from "../../ops/hosted-autonomy-queue-authority.ts";
import { runRepairQueueCustody } from "../../src/host/repair-queue-custody.ts";
import type { HostedQueueCoordinatorDeps } from "../../ops/hosted-autonomy-queue-contracts.ts";
import { APP, queueAuthorizationFacts } from "./merge-queue-proof-fixtures.ts";
import { REPO, reviewReceipt } from "../state/helpers.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type {
  QueuePullIdentity,
  QueueSnapshot,
} from "../../src/github/merge-queue-types.ts";

Deno.test("existing PR final queue effect: real custody/principal after intent, no authority or deadline never enqueues", async (t) => {
  for (
    const variant of [
      "accepted",
      "missing",
      "revoked",
      "deadline",
      "queue_drift",
    ] as const
  ) {
    await t.step(variant, async () => {
      const r = await nativeLifecycleRig(REPO);
      try {
        let context = await r.reload();
        for (let n = 0; n < 3; n++) {
          const step = await routeExistingPr(
            r.deps,
            context,
            context.snapshot.work[0],
          );
          assert.ok(step.status === "step" && step.step.kind === "progress");
          context = await r.reload();
        }
        const text = {
          issueNumber: 1,
          title: "Repair source",
          body: r.nativeControls.body,
        };
        const digest = await reviewTaskStatementDigest(text);
        const receipt = reviewReceipt(`review-receipt:${"d".repeat(64)}`, {
          repository: REPO,
          expectedReviewer: APP.login,
          observedReviewer: APP.login,
          pullRequest: { number: 7, head: r.ctx.head, base: r.ctx.base },
          outcome: "completed",
          resultId: "review-result",
          submittedAt: r.clock.now(),
          completedAt: r.clock.now(),
          observedAt: r.clock.now(),
          taskAcceptance: {
            issueNumber: 1,
            taskDigest: digest,
            verdict: "fulfilled",
            evidence: ["Exact task verified"],
          },
        });
        assert.deepEqual(
          await persistTransition(r.deps, context, (draft) => {
            draft.reviews.push(receipt);
          }),
          { kind: "progress" },
        );
        context = await r.reload();
        const binding = {
          repository: REPO,
          pullRequest: 7,
          head: r.ctx.head,
          base: r.ctx.base,
          reviewRequestId: receipt.requestId,
          reviewReceiptId: receipt.id,
          taskDigest: digest,
        };
        const pull: QueuePullIdentity = {
          repository: REPO,
          number: 7,
          nodeId: "PR_7",
          head: r.ctx.head,
          headRef: "human/issue-1",
          baseRef: "development",
        };
        const scan: QueueSnapshot = {
          repository: REPO,
          baseRef: "development",
          baseTip: r.ctx.base,
          queueId: "MQ_1",
          entries: [],
          observedAt: r.clock.now(),
        };
        const membership = { pull, entry: null, mergedRevision: null };
        // External native observations only; factory, immutable Git custody, state and final effect consumer stay real.
        r.client.readQueue = () =>
          Promise.resolve({ status: "complete", value: structuredClone(scan) });
        r.client.readQueuePull = () =>
          Promise.resolve({
            status: "complete",
            value: {
              membership,
              base: r.ctx.base,
              author: "human-owner",
              mergedBy: null,
            },
          });
        r.client.readBranchRules = (branch) =>
          Promise.resolve(portOk(
            branch === "development"
              ? [{
                type: "merge_queue",
                id: 1,
                name: "queue",
                rulesetSourceType: "Repository",
                rulesetSource: "ubiquity/ai.ubq.fi",
                rulesetId: 2,
                parameters: {},
              }]
              : [],
          ));
        const deadline = r.clock.now() + 60_000;
        if (variant === "revoked") r.controls.principal = false;
        if (variant === "deadline") {
          r.controls.afterPrincipal = () => {
            r.clock.advance(60_001);
            return Promise.resolve();
          };
        }
        if (variant === "queue_drift") {
          r.controls.afterPrincipal = () => {
            scan.baseTip = r.ctx.head;
            return Promise.resolve();
          };
        }
        const authority = createHostedQueueAuthority({
          state: r.state,
          clock: r.clock,
          githubFor: () => null,
          clientFor: () => r.client,
          existingPrFor: () =>
            variant === "missing" ? undefined : r.host.port.existingPrTakeover,
        });
        const facts = {
          ...await queueAuthorizationFacts(),
          binding,
          membership: { status: "complete" as const, value: membership },
          latestReceiptId: receipt.id,
          taskDigest: digest,
        };
        let enqueues = 0;
        const queue: HostedQueueCoordinatorDeps = {
          repository: REPO,
          config: {
            mode: "on",
            proofActivated: true,
            appActor: APP,
            probation: true,
          },
          readEffectiveQueueRule: () =>
            Promise.resolve({ status: "complete", value: true }),
          surface: {
            readQueue: () =>
              Promise.resolve({
                status: "complete",
                value: structuredClone(scan),
              }),
            readPullMembership: () =>
              Promise.resolve({ status: "complete", value: membership }),
            readPullEvidence: () =>
              Promise.resolve({ status: "unavailable", reason: "unsupported" }),
            enqueue: () => {
              enqueues++;
              return Promise.resolve({
                status: "pending",
                requestId: "c8bde880-3b8a-4f84-8036-d30a43cf7c12",
              });
            },
            poll: () =>
              Promise.resolve({ status: "unavailable", reason: "unsupported" }),
            dequeue: () =>
              Promise.resolve({
                status: "not_submitted",
                reason: "unsupported",
              }),
          },
          authorization: {
            ...authority.authorization,
            readAuthorization: (request) =>
              Promise.resolve({
                status: "complete",
                value: {
                  binding,
                  pull,
                  facts: {
                    ...facts,
                    admissionStartedAt: request.record.intent?.startedAt ??
                      null,
                  },
                },
              }),
          },
        };
        const deps = {
          state: r.state,
          clock: r.clock,
          githubFor: () => null,
          queue,
        };
        const writer = new QueueCustodyWriter(deps, {
          head: context.head!,
          snapshot: context.snapshot,
        });
        const result = await submitQueueAdmission(
          {
            deps,
            queue,
            writer,
            record: context.snapshot.work[0],
            native: scan,
            deadline,
            allowSubmission: true,
          },
          binding,
          pull,
          null,
        );
        assert.equal(
          enqueues,
          variant === "accepted" ? 1 : 0,
          JSON.stringify({ result, actions: writer.actions }),
        );
        assert.equal(result.submitted, variant === "accepted");
        const after = await r.reload();
        assert.deepEqual(
          after.snapshot.reservations,
          context.snapshot.reservations,
        );
        assert.deepEqual(
          after.snapshot.work[0].counters,
          context.snapshot.work[0].counters,
        );
        assert.equal(after.snapshot.work[0].wait?.reason, "backoff");
        assert.equal(after.snapshot.work[0].wait?.until, null);
        assert.ok(
          after.snapshot.work[0].intent?.key.startsWith("merge-queue:v1:"),
        );
        assert.equal(after.snapshot.work[0].target.branch, "human/issue-1");
      } finally {
        await r.ctx.cleanup();
      }
    });
  }
});

Deno.test("repair queue helper composes only native custody and refuses an expired pass before reads", async () => {
  const r = await nativeLifecycleRig(REPO);
  try {
    const before = await r.reload();
    const input = {
      state: r.state,
      clock: r.clock,
      token: "fixture-token",
      githubFor: () => null,
      existingPrFor: () => r.host.port.existingPrTakeover,
      http: r.http,
      deadline: r.clock.now() + 60_000,
    };
    const result = await runRepairQueueCustody(input);
    assert.equal(result.ready, true);
    assert.deepEqual(result.actions, ["queue:inactive_no_rule"]);
    assert.deepEqual(await r.reload(), before);
    const reads = r.requests.length;
    const expired = await runRepairQueueCustody({
      ...input,
      deadline: r.clock.now(),
    });
    assert.equal(expired.ready, false);
    assert.deepEqual(expired.actions, ["queue:deadline"]);
    assert.equal(r.requests.length, reads);
  } finally {
    await r.ctx.cleanup();
  }
});
