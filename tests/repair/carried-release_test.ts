/**
 * Sentinel #152, runtime half: a carried merge is booked with a production
 * release request that names the clean review of an EARLIER head H0 (on B0)
 * and gives the merged refreshed head H1 on tip T as its source. Release
 * acceptance and closure accept it only after re-deriving the git patch proof
 * between H0/B0 and H1/T (`proveCarriedPatch`, `carriedPatchHolds`), and
 * authorize the task as of the reviewed identity; a request whose patch no
 * longer proves is refused, and every non-carried request keeps the exact
 * binders (and never reads a proof).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type CarriedPatchRequestV1,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  type CarriedReleaseProverV1,
  carriedReleaseReceipt,
} from "../../src/repair/carried-release.ts";
import { MERGE_WITHOUT_REVIEW_DETAIL } from "../../src/repair/review-gate.ts";
import {
  carriedGatewayRequestBindsDelivery,
  gatewayRequestBindsDelivery,
} from "../../src/repair/vps-delivery.ts";
import { buildHostedReleaseRequest } from "../../ops/hosted-autonomy-delivery.ts";
import {
  releaseRequest,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
} from "../state/helpers.ts";
import type { FakeGithub } from "./helpers.ts";
import {
  LOCAL_SENTINEL_REPO,
  makeRig,
  type RigV1,
  seededSnapshot,
} from "./loop-rig.ts";
import {
  gatewayDeliveryRecord,
  LOCAL_DELIVERY_TASK_DIGEST,
  localAcceptedReceipt,
  localDeliveryRecord,
  localDeliveryRequest,
  referencedDeliveryReceipt,
} from "./loop-delivery-fixtures.ts";
import {
  gatewayLoopDelivery,
  persistVpsDelivery,
} from "./vps-delivery-fixtures.ts";

/** The reviewed head H0 on B0, and its mechanical refresh H1 on tip T. */
const H0 = SHA1;
const B0 = SHA2;
const H1 = "5001500150015001500150015001500150015001" as GitSha;
const TIP = "7001700170017001700170017001700170017001" as GitSha;
const PATCH = "a".repeat(64);
const POLL = 300_001;

type ProofMode = "holds" | "changed" | "unavailable";

/** The git proof: equal digests and T the refreshed merge base, or not. */
function fakeProof(github: FakeGithub, mode: ProofMode) {
  const requests: CarriedPatchRequestV1[] = [];
  github.proveCarriedPatch = (request) => {
    requests.push(structuredClone(request));
    if (mode === "unavailable") {
      return Promise.resolve(portError("unavailable", "objects missing"));
    }
    return Promise.resolve(portOk({
      reviewedMergeBase: request.reviewedBase,
      reviewedPatch: PATCH,
      refreshedMergeBase: request.base,
      refreshedPatch: mode === "holds" ? PATCH : "b".repeat(64),
      refreshedFrom: request.reviewedHead,
      refreshes: 1,
    }));
  };
  return requests;
}

const EXPECTED_PROOF: CarriedPatchRequestV1 = {
  reviewedBase: B0,
  reviewedHead: H0,
  base: TIP,
  head: H1,
};

/** The carried Gateway delivery: H1 on T merged under H0's receipt. */
async function carriedGateway(): Promise<{
  record: WorkRecordV1;
  receipt: ReviewReceiptV1;
  request: ReleaseRequestV1;
}> {
  const base = gatewayDeliveryRecord();
  const record = {
    ...base,
    target: { ...base.target, head: H1, base: TIP },
  };
  const provisional = {
    ...localDeliveryRequest("vps-carried", SHA3),
    target: { repository: REPO, environment: "production" as const },
  };
  const receipt = referencedDeliveryReceipt(
    provisional,
    record,
    LOCAL_DELIVERY_TASK_DIGEST,
    { pullRequest: { number: 12, head: H0, base: B0 } },
  );
  const request = await buildHostedReleaseRequest(
    REPO,
    SHA3,
    H1,
    TIP,
    12,
    receipt,
    provisional.createdAt,
  );
  assert.ok(request);
  return { record, receipt, request };
}

/** The carried local self delivery: the same shape on the self scope. */
function carriedSelf() {
  const base = localDeliveryRecord();
  const record = {
    ...base,
    target: { ...base.target, head: H1, base: TIP },
  };
  const request = releaseRequest("release-local-carried", {
    target: { repository: LOCAL_SENTINEL_REPO, environment: "production" },
    revision: SHA3,
    source: {
      pullRequest: 12,
      reviewRequestId: "review-req-release-local-carried",
      reviewReceiptId: "review-receipt-release-local-carried",
      head: H1,
      base: TIP,
    },
    createdAt: T0,
  });
  const receipt = referencedDeliveryReceipt(
    request,
    record,
    LOCAL_DELIVERY_TASK_DIGEST,
    { pullRequest: { number: 12, head: H0, base: B0 } },
  );
  return { record, receipt, request };
}

async function seed(
  rig: RigV1,
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
  request: ReleaseRequestV1,
) {
  const write = await rig.store.writeRepair(
    seededSnapshot([record], {
      releaseRequests: [request],
      reviews: [receipt],
    }),
    null,
  );
  assert.ok(write.ok && write.value.status === "applied");
}

function closes(rig: RigV1): number {
  return rig.github.calls.filter((call) => call.startsWith("closeIssue"))
    .length;
}

Deno.test("carried release (runtime): a carried Gateway delivery is refused while its patch does not prove, then accepted and closed once it does", async () => {
  const rig = await makeRig("carried-release-gateway", { summaries: false });
  try {
    const { record, receipt, request } = await carriedGateway();
    await seed(rig, record, receipt, request);
    // The release path is enabled: the real VPS controller accepts the exact
    // carried request on the release ref.
    await persistVpsDelivery(rig.store, rig.releaseStore, rig.clock, request);
    for (const mode of ["changed", "unavailable", "absent"] as const) {
      const proofs = mode === "absent" ? [] : fakeProof(rig.github, mode);
      if (mode === "absent") rig.github.proveCarriedPatch = undefined;
      rig.clock.advance(POLL);
      await rig.entry();
      const after = (await rig.snapshot()).work[0];
      assert.equal(after.nextStep, "delivery", mode);
      assert.equal(after.intent, null, mode);
      assert.equal(after.blocker, null, mode);
      assert.equal(after.wait?.reason, "unavailable", mode);
      assert.deepEqual(after.target, record.target, mode);
      assert.equal(closes(rig), 0, mode);
      for (const proof of proofs) assert.deepEqual(proof, EXPECTED_PROOF);
      assert.equal(proofs.length > 0, mode !== "absent", mode);
    }
    const proofs = fakeProof(rig.github, "holds");
    for (let cycle = 0; cycle < 3; cycle++) {
      rig.clock.advance(POLL);
      await rig.entry();
      if ((await rig.snapshot()).work[0].nextStep !== "delivery") break;
    }
    const after = await rig.snapshot();
    assert.equal(after.work[0].nextStep, "done", JSON.stringify(after.work));
    assert.deepEqual(after.work[0].target, record.target);
    assert.deepEqual(after.releaseRequests, [request]);
    assert.equal(closes(rig), 1);
    assert.equal(
      rig.github.calls.some((call) => call.startsWith("merge")),
      false,
    );
    // Every proof re-derived is exactly H0/B0 against the request's H1/T.
    assert.ok(proofs.length > 0);
    for (const proof of proofs) assert.deepEqual(proof, EXPECTED_PROOF);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("carried release (runtime): a carried self delivery is accepted once its git patch proof holds", async () => {
  const rig = await makeRig("carried-release-self", {
    summaries: false,
    localScope: true,
  });
  try {
    const proofs = fakeProof(rig.github, "holds");
    const { record, receipt, request } = carriedSelf();
    await seed(rig, record, receipt, request);
    Object.assign(rig.store, {
      readLocalRelease: () =>
        Promise.resolve(portOk(localAcceptedReceipt(request))),
    });
    const run = await rig.run();
    assert.equal(run.status, "idle", JSON.stringify(run));
    const after = (await rig.snapshot()).work[0];
    assert.equal(after.nextStep, "done", JSON.stringify(after));
    assert.equal(closes(rig), 1);
    assert.ok(proofs.length > 0);
    for (const proof of proofs) assert.deepEqual(proof, EXPECTED_PROOF);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("carried release (runtime): a carried self request whose patch no longer proves is refused, an unreadable proof waits", async () => {
  for (const mode of ["changed", "unavailable"] as const) {
    const rig = await makeRig(`carried-release-self-${mode}`, {
      summaries: false,
      localScope: true,
    });
    try {
      fakeProof(rig.github, mode);
      const { record, receipt, request } = carriedSelf();
      await seed(rig, record, receipt, request);
      Object.assign(rig.store, {
        readLocalRelease: () =>
          Promise.resolve(portOk(localAcceptedReceipt(request))),
      });
      await rig.run();
      const after = (await rig.snapshot()).work[0];
      assert.equal(after.intent, null, mode);
      assert.equal(closes(rig), 0, mode);
      if (mode === "changed") {
        assert.equal(after.nextStep, "blocked");
        assert.equal(after.blocker?.kind, "missing_evidence");
        assert.equal(after.blocker?.message, MERGE_WITHOUT_REVIEW_DETAIL);
      } else {
        assert.equal(after.nextStep, "delivery");
        assert.equal(after.blocker, null);
        assert.equal(after.wait?.reason, "unavailable");
      }
    } finally {
      await rig.ctx.cleanup();
    }
  }
});

Deno.test("carried release (runtime): a non-carried request keeps the exact binders and never reads a proof", async () => {
  const rig = await makeRig("carried-release-exact", { summaries: false });
  try {
    const proofs = fakeProof(rig.github, "holds");
    const { record, request, review } = await gatewayLoopDelivery();
    await seed(rig, record, review, request);
    await persistVpsDelivery(rig.store, rig.releaseStore, rig.clock, request);
    rig.clock.advance(POLL);
    await rig.entry();
    assert.equal((await rig.snapshot()).work[0].nextStep, "done");
    assert.equal(closes(rig), 1);
    assert.deepEqual(proofs, [], "an exact request reads no carried proof");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("carried release (binders): the exact binder still refuses a carried request, the carried binder only a proven one", async () => {
  const { record, receipt, request } = await carriedGateway();
  const asked: CarriedPatchRequestV1[] = [];
  const prover = (verdict: "holds" | "changed"): CarriedReleaseProverV1 => ({
    reviewer: "chatgpt-codex-connector[bot]",
    prove: (proof) => {
      asked.push(proof);
      return Promise.resolve(verdict);
    },
  });
  assert.equal(
    await gatewayRequestBindsDelivery(request, record, receipt),
    false,
    "the exact binder is unchanged",
  );
  assert.equal(
    await carriedGatewayRequestBindsDelivery(
      request,
      record,
      receipt,
      prover("holds"),
    ),
    true,
  );
  assert.equal(
    await carriedGatewayRequestBindsDelivery(
      request,
      record,
      receipt,
      prover("changed"),
    ),
    false,
  );
  assert.deepEqual(asked, [EXPECTED_PROOF, EXPECTED_PROOF]);
  // Not the carried receipt: another reviewer, a blocking finding, the
  // record's own head, another request revision. No proof is read.
  asked.length = 0;
  const cases: [string, ReviewReceiptV1 | null, ReleaseRequestV1][] = [
    ["no receipt", null, request],
    ["another reviewer", {
      ...receipt,
      expectedReviewer: "someone[bot]",
      observedReviewer: "someone[bot]",
    }, request],
    ["uncounted findings", {
      ...receipt,
      findingsUncounted: 1,
      unresolvedSeverities: ["P0"],
    }, request],
    ["the record's own head", {
      ...receipt,
      pullRequest: { number: 12, head: H1, base: TIP },
    }, request],
    ["another pull request", {
      ...receipt,
      pullRequest: { number: 13, head: H0, base: B0 },
    }, request],
  ];
  for (const [name, review, named] of cases) {
    assert.equal(
      await carriedGatewayRequestBindsDelivery(
        named,
        record,
        review,
        prover("holds"),
      ),
      false,
      name,
    );
  }
  assert.equal(
    await carriedGatewayRequestBindsDelivery(
      request,
      record,
      receipt,
      prover("holds"),
      SHA1,
    ),
    false,
    "another revision",
  );
  assert.deepEqual(asked, []);
  // The exact (non-carried) Gateway delivery is never carried.
  const exact = await gatewayLoopDelivery();
  assert.equal(
    carriedReleaseReceipt(
      exact.request,
      exact.record,
      exact.review,
      "chatgpt-codex-connector[bot]",
    ),
    false,
  );
  assert.equal(
    await gatewayRequestBindsDelivery(
      exact.request,
      exact.record,
      exact.review,
    ),
    true,
  );
});
