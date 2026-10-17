/**
 * Launcher side of carried delivery (owner decision 2026-10-16 (2), the
 * coordinator's option (b)) and of the legacy cutoff hand-over (generation 80
 * round-1 recheck P2 [0] and [1]):
 *
 * - a record the runtime merged under a carried review is named in the
 *   delivery pass's action line with the reviewed identity, its receipt and
 *   the merged refreshed identity; the follow-up filing uses that receipt;
 * - the legacy class's cutoff reaches the runtime child only for the exact
 *   revision the launcher pinned it for, never from the launcher's own
 *   environment, and a malformed value is no cutoff.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  carriedDeliveryAction,
  carriedRequestReceipt,
} from "../../ops/hosted-autonomy-spent-delivery.ts";
import { buildChildEnvironment } from "../../src/host/hosted-runtime-child.ts";
import {
  LEGACY_REVIEW_CUTOFF_ENV,
  legacyReviewCutoffForExecution,
  legacyReviewCutoffForRuntime,
  parseLegacyReviewCutoffEnv,
} from "../../src/host/legacy-review-cutoff-env.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { LEGACY_REVIEW_CUTOFF_RUNTIMES } from "../../src/repair/review-round-cap.ts";
import { releaseRequest, SHA1, SHA2, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  deliveryRecord,
  HEAD,
  MERGE,
  SELF_REPO,
} from "./hosted-autonomy-fixtures.ts";
import { healthyProof, repairSnapshot } from "./hosted-autonomy-rig.ts";

/** The refreshed head H1 on the moved tip T that the runtime merged. */
const H1 = "5001500150015001500150015001500150015001" as GitSha;
const TIP = SHA2;

function carriedSnapshot(receiptOverrides: Record<string, unknown> = {}) {
  const record = deliveryRecord({
    target: { ...deliveryRecord().target, head: H1, base: TIP },
    counters: { attempts: 1, retries: 0, reviewRounds: 3 },
  });
  // The receipt of the REVIEWED head H0 (HEAD) on its base B0 (BASE).
  const receipt = authorizingReceipt({
    requestId: "review-req-3",
    ...receiptOverrides,
  });
  const request = releaseRequest("release-carried", {
    target: { repository: SELF_REPO, environment: "production" },
    revision: MERGE,
    source: {
      pullRequest: 51,
      reviewRequestId: "review-req-3",
      reviewReceiptId: receipt.id,
      head: H1,
      base: TIP,
    },
  });
  return {
    record,
    receipt,
    request,
    snapshot: repairSnapshot([record], [receipt], [request], []),
  };
}

Deno.test("carried delivery (launcher): the action line names the reviewed identity, its receipt and the merged refreshed identity", () => {
  const { record, receipt, request, snapshot } = carriedSnapshot();
  assert.deepEqual(carriedRequestReceipt(snapshot.reviews, request), receipt);
  assert.equal(
    carriedDeliveryAction(snapshot, record),
    `delivery:${record.id}:carried:pr=51:reviewed=${HEAD}@${BASE}:receipt=${receipt.id}:merged=${H1}@${TIP}:sha=${MERGE}`,
  );
  // Not in delivery: nothing to report.
  assert.equal(
    carriedDeliveryAction(snapshot, { ...record, nextStep: "work" }),
    null,
  );
});

Deno.test("carried delivery (launcher): only a completed receipt of the App reviewer on an EARLIER head of the same pull request is carried", () => {
  // The ordinary request (receipt of the merged head itself) is not carried.
  const ordinary = carriedSnapshot({
    pullRequest: { number: 51, head: H1, base: TIP },
  });
  assert.equal(carriedDeliveryAction(ordinary.snapshot, ordinary.record), null);
  for (
    const [name, overrides] of [
      ["another pull request", {
        pullRequest: { number: 52, head: HEAD, base: BASE },
      }],
      ["another reviewer", { observedReviewer: "someone-else[bot]" }],
      ["not completed", {
        outcome: "unavailable",
        resultId: null,
        completedAt: null,
      }],
      ["another review request", { requestId: "review-req-9" }],
    ] as const
  ) {
    let built: ReturnType<typeof carriedSnapshot> | null = null;
    try {
      built = carriedSnapshot(overrides as Record<string, unknown>);
    } catch {
      continue; // the frozen parser already refuses this receipt shape
    }
    assert.equal(
      carriedRequestReceipt(built.snapshot.reviews, built.request),
      null,
      name,
    );
    assert.equal(carriedDeliveryAction(built.snapshot, built.record), null);
  }
});

Deno.test("legacy cutoff hand-over: only the exact pinned revision receives its activation bound", () => {
  const R80 = "8080808080808080808080808080808080808080" as GitSha;
  const pinned = [{ revision: R80, activatedNotBefore: T0 }];
  // Generation 80 ships with no row: the commit that pins its install adds it.
  assert.deepEqual(LEGACY_REVIEW_CUTOFF_RUNTIMES, []);
  assert.equal(
    legacyReviewCutoffForExecution({ revision: R80, createdAt: T0 + 5 }),
    null,
    "nothing pinned, nothing legacy",
  );
  assert.equal(
    legacyReviewCutoffForExecution(
      { revision: R80, createdAt: T0 + 5 },
      pinned,
    ),
    T0,
  );
  assert.equal(
    legacyReviewCutoffForExecution(
      { revision: SHA1, createdAt: T0 + 5 },
      pinned,
    ),
    null,
    "another revision (R79 included) receives none",
  );
  assert.equal(
    legacyReviewCutoffForExecution(
      { revision: R80, createdAt: T0 - 1 },
      pinned,
    ),
    null,
    "a bound later than an execution of that revision is no activation bound",
  );
  const runtime = {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: R80,
    generation: 80,
    lastHealthyProof: healthyProof(R80, 80, "cutoff"),
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
  } as HostedRuntimeRecordV1;
  const proofAt = runtime.lastHealthyProof!.execution.createdAt;
  assert.equal(
    legacyReviewCutoffForRuntime(runtime, [
      { revision: R80, activatedNotBefore: proofAt },
    ]),
    proofAt,
  );
  assert.equal(
    legacyReviewCutoffForRuntime(runtime, [
      { revision: R80, activatedNotBefore: proofAt + 1 },
    ]),
    null,
  );
  assert.equal(legacyReviewCutoffForRuntime(null, pinned), null);
});

Deno.test("legacy cutoff hand-over: the child key carries the launcher's value only, and the runtime parses it strictly", () => {
  const host = {
    PATH: "/usr/bin",
    GITHUB_TOKEN: "native-token",
    UOS_AI_TOKEN: "model-token",
    // A value in the launcher's own environment never crosses.
    [LEGACY_REVIEW_CUTOFF_ENV]: "1",
  };
  const identity = {
    runId: 1,
    runAttempt: 1,
    launcherSha: "a".repeat(40) as GitSha,
    job: "repair" as const,
  };
  const dirs = { home: "/h", tmp: "/t", denoDir: "/d" };
  const none = buildChildEnvironment(host, identity, dirs, T0);
  assert.equal(Object.hasOwn(none, LEGACY_REVIEW_CUTOFF_ENV), false);
  const handed = buildChildEnvironment(host, identity, dirs, T0, T0);
  assert.equal(handed[LEGACY_REVIEW_CUTOFF_ENV], String(T0));
  assert.equal(
    parseLegacyReviewCutoffEnv(handed[LEGACY_REVIEW_CUTOFF_ENV]),
    T0,
  );
  for (
    const value of [
      undefined,
      "",
      "0",
      "-1",
      "01",
      " 1",
      "1e12",
      "1.5",
      "0x10",
      "99999999999999999",
    ]
  ) {
    assert.equal(parseLegacyReviewCutoffEnv(value), null, String(value));
  }
});
