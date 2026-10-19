import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import { persistTransition } from "../../src/repair/loop-state.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { issueWire } from "../github/helpers.ts";
import { APP, POLICY } from "./merge-queue-proof-fixtures.ts";
import assert from "node:assert/strict";
import { nativeLifecycleRig } from "../repair/existing-pr-lifecycle-fixtures.ts";
import { routeExistingPr } from "../../src/repair/loop-existing-pr.ts";
import { REPO, reviewReceipt } from "../state/helpers.ts";
import { gitRun } from "./actions-candidates-fixture.ts";

Deno.test("existing PR read-only publication: native anchor survives merged source and restart without mutation principal", async (t) => {
  // Historical direct publication keeps all opaque proof owners in one dormant graph.
  await withHostedProductionPolicy(
    DORMANT_HOSTED_SUPERVISOR_POLICY,
    async (graph) => {
      const [takeover, matcher, queueReader, legacy, delivery] = await Promise
        .all([
          graph.existingPrTakeover(),
          graph.publicationProof(),
          graph.queueDeliveryReader(),
          graph.queueLegacyDirect(),
          graph.deliveryFacts(),
        ]);
      const { takeoverPublicationMatches } = matcher;
      const { createQueueDeliveryReader } = queueReader;
      const { resolveQueueLegacyDirect } = legacy;
      const { verifiedMergedDelivery } = delivery;
      const r = await nativeLifecycleRig(
        REPO,
        takeover.createExistingPrTakeover,
      );
      try {
        let context = await r.reload();
        for (let n = 0; n < 3; n++) {
          const result = await routeExistingPr(
            r.deps,
            context,
            context.snapshot.work[0],
          );
          assert.ok(
            result.status === "step" && result.step.kind === "progress",
            JSON.stringify(result),
          );
          context = await r.reload();
        }
        const task = {
          issueNumber: 1,
          title: "Repair source",
          body: r.nativeControls.body,
        };
        const receipt = reviewReceipt(`review-receipt:${"d".repeat(64)}`, {
          repository: REPO,
          expectedReviewer: APP.login,
          observedReviewer: APP.login,
          pullRequest: { number: 7, head: r.ctx.head, base: r.ctx.base },
          outcome: "completed",
          resultId: "completed-review",
          submittedAt: r.clock.now(),
          completedAt: r.clock.now(),
          observedAt: r.clock.now(),
          taskAcceptance: {
            issueNumber: 1,
            taskDigest: await reviewTaskStatementDigest(task),
            verdict: "fulfilled",
            evidence: ["Exact native candidate verified"],
          },
        });
        assert.deepEqual(
          await persistTransition(r.deps, context, (draft) => {
            draft.reviews.push(receipt);
          }),
          { kind: "progress" },
        );
        context = await r.reload();
        const record = context.snapshot.work[0];
        const tree = await gitRun(`${r.ctx.tmp}/work`, [
          "rev-parse",
          `${r.ctx.head}^{tree}`,
        ], r.ctx.env);
        assert.ok(tree.ok);
        const merged = await gitRun(`${r.ctx.tmp}/work`, [
          "commit-tree",
          tree.stdout.trim(),
          "-p",
          r.ctx.base,
          "-p",
          r.ctx.head,
          "-m",
          "native merge",
        ], r.ctx.env);
        assert.ok(merged.ok);
        const revision = merged.stdout.trim() as typeof r.ctx.head;
        r.nativeControls.merged = true;
        r.nativeControls.issueClosed = true;
        r.nativeControls.mergeSha = revision;
        r.nativeControls.policy.activated = false;
        r.nativeControls.fence = false;
        r.nativeControls.write = false;
        r.controls.principal = false;
        const principalBefore = r.controls.principalCalls;
        const pushesBefore = r.pushes.length;
        const port = r.restartTakeover();
        const request = {
          record,
          snapshot: context.snapshot,
          expectedStateHead: context.head!,
          revision,
          deadline: r.clock.now() + 30_000,
        };
        const proof = await port.resolvePublication(request);
        assert.ok(proof.ok, JSON.stringify(proof));
        r.nativeControls.replies.set(
          "GET /repos/ubiquity/ai.ubq.fi/issues/1",
          issueWire({
            number: 1,
            title: task.title,
            body: task.body,
            state: "closed",
            created_at: new Date(r.clock.now() - 1000).toISOString(),
            updated_at: new Date(r.clock.now()).toISOString(),
            closed_at: new Date(r.clock.now()).toISOString(),
          }),
        );
        const reader = createQueueDeliveryReader({
          repository: REPO,
          clock: r.clock,
          client: r.client,
          policy: POLICY,
          publication: async (input) => {
            const resolved = await port.resolvePublication({
              ...input,
              expectedStateHead: context.head!,
            });
            return resolved.ok
              ? { status: "complete", value: resolved.value }
              : { status: "unavailable", reason: "incomplete" };
          },
        });
        const observedBinding = await reader.readBinding({
          record,
          snapshot: context.snapshot,
          deadline: request.deadline,
        });
        assert.equal(observedBinding.status, "complete");
        const grant = await resolveQueueLegacyDirect({
          state: r.state,
          clock: r.clock,
          client: r.client,
          reader,
          mode: "off",
          proofActivated: false,
        }, { record, receipt, revision, deadline: request.deadline });
        assert.ok(
          grant.status === "complete" && grant.value !== null,
          JSON.stringify(grant),
        );
        assert.ok(
          takeoverPublicationMatches(
            grant.value.publicationProof,
            record,
            revision,
            "human-owner",
          ),
        );

        const pull = {
          number: 7,
          state: "closed",
          merged: true,
          mergeCommitSha: revision,
          headSha: r.ctx.head,
          baseSha: r.ctx.base,
          baseRef: "development",
          author: "human-owner",
          parents: [r.ctx.base, r.ctx.head],
          revisionOnBaseBranch: true,
          baseAncestorOfRevision: true,
        };
        assert.deepEqual(
          verifiedMergedDelivery(
            record,
            pull,
            "development",
            undefined,
            proof.value,
          ),
          { revision },
        );
        assert.equal(verifiedMergedDelivery(record, pull, "development"), null);
        assert.equal(
          verifiedMergedDelivery(
            record,
            pull,
            "development",
            undefined,
            structuredClone(proof.value),
          ),
          null,
        );
        assert.equal(
          verifiedMergedDelivery(
            record,
            { ...pull, parents: [r.ctx.base] },
            "development",
            undefined,
            proof.value,
          ),
          null,
        );
        assert.equal(
          verifiedMergedDelivery(record, pull, "development", {
            ready: true,
            proofActivated: true,
            protectedRecordIds: new Set(),
          }, proof.value),
          null,
          "old direct verifier never books queue merges",
        );
        assert.equal(r.controls.principalCalls, principalBefore);
        assert.equal(r.pushes.length, pushesBefore);
        assert.deepEqual(await r.reload(), context);
        for (const field of ["author", "body", "head", "mergeSha"] as const) {
          await t.step(field, async () => {
            const saved = r.nativeControls[field];
            if (field === "author") r.nativeControls.author = "another-user";
            else if (field === "body") r.nativeControls.body = "changed task";
            else if (field === "head") r.nativeControls.head = r.ctx.base;
            else r.nativeControls.mergeSha = r.ctx.head;
            assert.equal((await port.resolvePublication(request)).ok, false);
            Object.assign(r.nativeControls, { [field]: saved });
          });
        }
        r.clock.advance(30_001);
        assert.equal(
          takeoverPublicationMatches(
            proof.value,
            record,
            revision,
            "human-owner",
          ),
          false,
        );
      } finally {
        await r.ctx.cleanup();
      }
    },
  );
});
