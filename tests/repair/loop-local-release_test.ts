/** Exact local-release receipt authorization and scope refusals. */
import assert from "node:assert/strict";
import type { GitHubIssueV1, PortResultV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { LocalReleaseReceiptV1 } from "../../src/contracts/local-release.ts";
import {
  releaseRequest,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { FakeGithub } from "./helpers.ts";
import { makeRig, seededSnapshot } from "./loop-rig.ts";
import {
  gatewayDeliveryRecord,
  LOCAL_DELIVERY_ISSUE,
  LOCAL_DELIVERY_TASK_DIGEST,
  localAcceptedReceipt,
  localDeliveryRecord,
  localDeliveryRequest,
  malformedAcceptedReceipts,
  OTHER_SCOPE_ZERO_REPO,
  referencedDeliveryReceipt,
  wrongBaseLocalRequest,
} from "./loop-delivery-fixtures.ts";

Deno.test(
  "local release: accepted local receipt closes the delivery record",
  async () => {
    const rig = await makeRig("localaccept", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      const record = localDeliveryRecord();
      // The release request references one EXACT receipt: the full
      // authorization predicate and its task acceptance must still bind the
      // trusted live issue text, so the genuine proof is seeded.
      const proof = referencedDeliveryReceipt(
        request,
        record,
        LOCAL_DELIVERY_TASK_DIGEST,
      );
      const seeded = await rig.store.writeRepair(
        seededSnapshot([record], {
          releaseRequests: [request],
          reviews: [proof],
        }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      let reads = 0;
      Object.assign(rig.store, {
        readLocalRelease: () => {
          reads++;
          return Promise.resolve(portOk(localAcceptedReceipt(request)));
        },
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "done");
      assert.equal(reads, 1, "the local capability was consulted exactly once");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: an accepted receipt without the exact referenced proof never closes",
  async () => {
    // The release controller accepted the deployment, but no receipt carries
    // delivery proof: the exact referenced id resolves to nothing, so no
    // closure intent, no external close and no done transition may happen.
    const rig = await makeRig("localnoproof", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      await rig.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      Object.assign(rig.store, {
        readLocalRelease: () =>
          Promise.resolve(portOk(localAcceptedReceipt(request))),
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "blocked");
      assert.equal(
        state.work[0].intent,
        null,
        "no durable closure intent without proof",
      );
      assert.equal(state.work[0].blocker?.kind, "missing_evidence");
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        0,
        "no closure without proof",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: a referenced receipt that fails one full-identity check never closes",
  async () => {
    // Every case keeps the EXACT referenced id/request id of the accepted
    // request, so only the changed dimension can refuse it: another repository
    // scope, another reviewed base, an untrusted observed reviewer, an
    // unresolved P0 (the only blocking severity, owner directive 2026-10-24),
    // a change-only receipt without any acceptance, and the explicit
    // `already_satisfied_at_base` verdict. None may persist a closure intent,
    // close the issue or finish the record.
    const variants: Array<{
      name: string;
      overrides: Record<string, unknown>;
      blockerKind: "missing_evidence" | "other";
    }> = [
      {
        name: "wrong-repository",
        overrides: { repository: REPO },
        blockerKind: "missing_evidence",
      },
      {
        name: "wrong-base",
        overrides: { pullRequest: { number: 12, head: SHA1, base: SHA3 } },
        blockerKind: "missing_evidence",
      },
      {
        name: "untrusted-reviewer",
        overrides: {
          expectedReviewer: "someone-else[bot]",
          observedReviewer: "someone-else[bot]",
        },
        blockerKind: "missing_evidence",
      },
      {
        name: "unresolved-P0",
        overrides: {
          findings: [{
            id: "finding-1",
            severity: "P0",
            path: "src/app.ts",
            message: "required fix",
            fingerprint: "a".repeat(64),
            resolved: false,
            resolutionEvidence: null,
          }],
          unresolvedSeverities: ["P0"],
        },
        blockerKind: "missing_evidence",
      },
      {
        name: "no-acceptance",
        overrides: { taskAcceptance: null },
        blockerKind: "missing_evidence",
      },
      {
        name: "already-satisfied",
        overrides: {
          taskAcceptance: {
            issueNumber: LOCAL_DELIVERY_ISSUE,
            taskDigest: LOCAL_DELIVERY_TASK_DIGEST,
            verdict: "already_satisfied_at_base",
            evidence: ["the base already satisfies the issue"],
          },
        },
        blockerKind: "other",
      },
    ];
    for (const variant of variants) {
      const rig = await makeRig(`localwrongproof-${variant.name}`, {
        summaries: false,
        localScope: true,
      });
      try {
        const request = localDeliveryRequest("release-local-1", SHA3);
        const record = localDeliveryRecord();
        const receipt = referencedDeliveryReceipt(
          request,
          record,
          LOCAL_DELIVERY_TASK_DIGEST,
          variant.overrides,
        );
        await rig.store.writeRepair(
          seededSnapshot([record], {
            releaseRequests: [request],
            reviews: [receipt],
          }),
          null,
        );
        Object.assign(rig.store, {
          readLocalRelease: () =>
            Promise.resolve(portOk(localAcceptedReceipt(request))),
        });
        const run = await rig.run();
        assert.equal(run.status, "idle", JSON.stringify(run));
        const state = await rig.snapshot();
        assert.equal(state.work[0].nextStep, "blocked", variant.name);
        assert.equal(state.work[0].intent, null, variant.name);
        assert.equal(
          state.work[0].blocker?.kind,
          variant.blockerKind,
          variant.name,
        );
        assert.equal(
          rig.github.calls.filter((call) => call.startsWith("closeIssue"))
            .length,
          0,
          variant.name,
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "local release: an unresolved P1 on the referenced receipt still closes",
  async () => {
    // Owner directive 2026-10-24: only an unresolved P0 blocks delivery. The
    // same exact referenced receipt with one unresolved P1 finding keeps its
    // full identity and positive acceptance, so the accepted local release
    // closes the record exactly as the finding-free receipt does.
    const rig = await makeRig("localp1closes", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      const record = localDeliveryRecord();
      const proof = referencedDeliveryReceipt(
        request,
        record,
        LOCAL_DELIVERY_TASK_DIGEST,
        {
          findings: [{
            id: "finding-1",
            severity: "P1",
            path: "src/app.ts",
            message: "non-blocking required fix",
            fingerprint: "a".repeat(64),
            resolved: false,
            resolutionEvidence: null,
          }],
          unresolvedSeverities: ["P1"],
        },
      );
      const seeded = await rig.store.writeRepair(
        seededSnapshot([record], {
          releaseRequests: [request],
          reviews: [proof],
        }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      Object.assign(rig.store, {
        readLocalRelease: () =>
          Promise.resolve(portOk(localAcceptedReceipt(request))),
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "done");
      assert.equal(state.work[0].blocker, null);
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        1,
        "the unresolved P1 does not withhold the closure",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

/**
 * Live issue reader whose task text changes between runs: reproduces an edited
 * source issue AFTER the durable closure intent already exists.
 */
class MutableIssueGithub extends FakeGithub {
  body = "";
  override readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    return Promise.resolve(portOk({
      number: issueNumber,
      title: `issue ${issueNumber}`,
      body: this.body,
      state: "open",
      author: null,
      labels: [],
      createdAt: T0,
      updatedAt: T0,
      closedAt: null,
    }));
  }
}

Deno.test(
  "closure retry: a task-text change after the durable intent blocks instead of closing",
  async () => {
    // The durable closure intent was written from an earlier read of the
    // trusted task text. Once the live text changes, the recorded acceptance no
    // longer binds it: the retry must revalidate and block instead of closing
    // the issue and marking the record done.
    const github = new MutableIssueGithub({
      baseSha: SHA1,
      closeFailNext: true,
    });
    const rig = await makeRig("closuretextchange", {
      summaries: false,
      localScope: true,
      githubPort: github,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      const record = localDeliveryRecord();
      await rig.store.writeRepair(
        seededSnapshot([record], {
          releaseRequests: [request],
          reviews: [
            referencedDeliveryReceipt(
              request,
              record,
              LOCAL_DELIVERY_TASK_DIGEST,
            ),
          ],
        }),
        null,
      );
      Object.assign(rig.store, {
        readLocalRelease: () =>
          Promise.resolve(portOk(localAcceptedReceipt(request))),
      });
      await rig.run();
      let state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(state.work[0].intent?.kind, "issue_closure");
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue:"))
          .length,
        1,
        "the first closure attempt failed and stayed retryable",
      );

      github.body = "edited after the accepted delivery";
      rig.clock.advance(5 * 60_000 + 1);
      const retried = await rig.run();
      assert.equal(retried.status, "idle", JSON.stringify(retried));
      state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "blocked");
      assert.equal(state.work[0].intent, null, "no closure intent survives");
      assert.equal(state.work[0].blocker?.kind, "missing_evidence");
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue:"))
          .length,
        1,
        "the changed task text never closes the issue",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: malformed matching-request receipts never close the delivery record",
  async () => {
    const request = localDeliveryRequest("release-local-1", SHA3);
    const variants = malformedAcceptedReceipts(request);
    for (let index = 0; index < variants.length; index++) {
      const rig = await makeRig(`localmalformed${index}`, {
        summaries: false,
        localScope: true,
      });
      try {
        const seeded = await rig.store.writeRepair(
          seededSnapshot([localDeliveryRecord(42)], {
            releaseRequests: [request],
          }),
          null,
        );
        assert.ok(seeded.ok && seeded.value.status === "applied");
        Object.assign(rig.store, {
          readLocalRelease: () =>
            Promise.resolve(portOk(variants[index] as LocalReleaseReceiptV1)),
        });
        const run = await rig.run();
        assert.equal(run.status, "idle", JSON.stringify(run));
        const state = await rig.snapshot();
        assert.equal(
          state.work[0].nextStep,
          "delivery",
          `variant ${index}: no closure transition`,
        );
        assert.equal(state.work[0].wait?.reason, "unavailable");
        assert.equal(
          rig.github.calls.filter((call) => call.startsWith("closeIssue"))
            .length,
          0,
          `variant ${index}: zero closure calls`,
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "local release: mismatched local receipt waits and never accepts",
  async () => {
    const rig = await makeRig("localmismatch", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      const seeded = await rig.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      // A valid receipt for a DIFFERENT request: the consumer-side binding
      // check must reject it even though the port returned success.
      const other = localDeliveryRequest("release-local-other", SHA3);
      Object.assign(rig.store, {
        readLocalRelease: () =>
          Promise.resolve(portOk(localAcceptedReceipt(other))),
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(state.work[0].wait?.reason, "unavailable");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: unavailable local receipt waits",
  async () => {
    const rig = await makeRig("localunavailable", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      const seeded = await rig.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      Object.assign(rig.store, {
        readLocalRelease: () =>
          Promise.resolve(
            portError("unavailable", "local release receipt is unavailable"),
          ),
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(state.work[0].wait?.reason, "unavailable");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: wrong-scope or wrong-base request cannot close the delivery record",
  async () => {
    // Case 1: the request matches PR/head but targets the ai.ubq.fi gateway
    // scope (installation 7) while the record is local scope 0. A hosted
    // acceptance for that request must never close the local record.
    const wrongScope = await makeRig("localwrongscope", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = releaseRequest("release-wrong-scope", {
        revision: SHA3,
        source: {
          pullRequest: 12,
          reviewRequestId: "review-req-wrong-scope",
          reviewReceiptId: "review-receipt-wrong-scope",
          head: SHA1,
          base: SHA2,
        },
        createdAt: T0,
      });
      const seeded = await wrongScope.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      await wrongScope.acceptRelease(request.id);
      const run = await wrongScope.run();
      const state = await wrongScope.snapshot();
      assert.equal(
        state.work[0].nextStep,
        "delivery",
        `wrong scope: no closure transition (${JSON.stringify(run)})`,
      );
      assert.equal(
        wrongScope.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        0,
        "wrong scope: zero closure calls",
      );
    } finally {
      await wrongScope.ctx.cleanup();
    }

    // Case 2: same local scope and PR/head, but the request's reviewed base
    // differs from the record base. A valid accepted local receipt for that
    // other request must never close this record either.
    const wrongBase = await makeRig("localwrongbase", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = wrongBaseLocalRequest("release-wrong-base");
      const seeded = await wrongBase.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      let reads = 0;
      Object.assign(wrongBase.store, {
        readLocalRelease: () => {
          reads++;
          return Promise.resolve(portOk(localAcceptedReceipt(request)));
        },
      });
      const run = await wrongBase.run();
      const state = await wrongBase.snapshot();
      assert.equal(
        state.work[0].nextStep,
        "delivery",
        `wrong base: no closure transition (${JSON.stringify(run)})`,
      );
      assert.equal(
        reads,
        0,
        "wrong base: the wrong request is never observed by the local consumer",
      );
      assert.equal(
        wrongBase.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        0,
        "wrong base: zero closure calls",
      );
    } finally {
      await wrongBase.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: local scope cannot consume a fake hosted acceptance",
  async () => {
    const rig = await makeRig("localnofallback", {
      summaries: false,
      localScope: true,
    });
    try {
      const request = localDeliveryRequest("release-local-1", SHA3);
      const seeded = await rig.store.writeRepair(
        seededSnapshot([localDeliveryRecord()], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      // A hosted Deno release record reports acceptance for the same request
      // id, but local scope has no local receipt: it must wait, never accept.
      await rig.acceptRelease(request.id);
      Object.assign(rig.store, {
        readLocalRelease: () => Promise.resolve(portOk(null)),
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "delivery");
      assert.equal(state.work[0].wait?.reason, "unavailable");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: gateway Deno acceptance cannot replace VPS delivery",
  async () => {
    const rig = await makeRig("localgateway", { summaries: false });
    try {
      const request = releaseRequest("release-gateway-1", {
        revision: SHA3,
        source: {
          pullRequest: 12,
          reviewRequestId: "review-req-gateway",
          reviewReceiptId: "review-receipt-gateway",
          head: SHA1,
          base: SHA2,
        },
        createdAt: T0,
      });
      const seeded = await rig.store.writeRepair(
        seededSnapshot([gatewayDeliveryRecord()], {
          releaseRequests: [request],
          // The exact referenced receipt, bound to the nonlocal record's own
          // repository and live issue task.
          reviews: [
            referencedDeliveryReceipt(
              request,
              gatewayDeliveryRecord(),
              LOCAL_DELIVERY_TASK_DIGEST,
            ),
          ],
        }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      await rig.acceptRelease(request.id);
      let reads = 0;
      Object.assign(rig.store, {
        readLocalRelease: () => {
          reads++;
          return Promise.resolve(
            portOk(
              localAcceptedReceipt(
                localDeliveryRequest("release-local-1", SHA3),
              ),
            ),
          );
        },
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(
        state.work[0].nextStep,
        "delivery",
        "a Deno receipt cannot accept gateway VPS delivery",
      );
      assert.equal(reads, 0, "the local capability is never consulted");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "local release: another scope-0 repository cannot consume the Sentinel local receipt",
  async () => {
    // The explicit local Sentinel scope is exactly ubiquity-sentinel/sentinel at
    // installation 0. A different repository that also uses scope 0 is not
    // local: its delivery record must take the hosted path and never even
    // consult the Sentinel local receipt capability, let alone consume an
    // accepted Sentinel receipt returned by it.
    const rig = await makeRig("localotherscope", {
      summaries: false,
      configOverrides: {
        repository: OTHER_SCOPE_ZERO_REPO,
        adapter: { kind: "github" },
      },
    });
    try {
      const request = releaseRequest("release-other-scope-1", {
        target: {
          repository: OTHER_SCOPE_ZERO_REPO,
          environment: "production",
        },
        revision: SHA3,
        source: {
          pullRequest: 12,
          reviewRequestId: "review-req-other-scope-1",
          reviewReceiptId: "review-receipt-other-scope-1",
          head: SHA1,
          base: SHA2,
        },
        createdAt: T0,
      });
      const record = workRecord("other-scope-delivery-1", {
        repository: OTHER_SCOPE_ZERO_REPO,
        source: {
          kind: "issue",
          id: String(LOCAL_DELIVERY_ISSUE),
          revision: SHA1,
        },
        related: { incidentId: null, issueNumber: LOCAL_DELIVERY_ISSUE },
        target: {
          base: SHA2,
          branch: null,
          checkpoint: null,
          head: SHA1,
          pr: 12,
        },
        nextStep: "delivery",
        updatedAt: T0 + 1000,
      });
      const seeded = await rig.store.writeRepair(
        seededSnapshot([record], { releaseRequests: [request] }),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      // The capability offers the accepted SENTINEL local receipt for a
      // Sentinel request; the other scope-0 repository must not be its
      // consumer.
      let reads = 0;
      Object.assign(rig.store, {
        readLocalRelease: () => {
          reads++;
          return Promise.resolve(
            portOk(
              localAcceptedReceipt(
                localDeliveryRequest("release-local-1", SHA3),
              ),
            ),
          );
        },
      });
      const run = await rig.run();
      assert.equal(run.status, "idle", JSON.stringify(run));
      const state = await rig.snapshot();
      assert.equal(
        state.work[0].nextStep,
        "delivery",
        "another scope-0 repository never closes through the local receipt",
      );
      assert.equal(
        reads,
        0,
        "the Sentinel local receipt capability is never consulted",
      );
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue"))
          .length,
        0,
        "zero closure calls",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
