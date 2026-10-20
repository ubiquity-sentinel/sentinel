/** Shared credential-free hosted lifecycle fixtures; this module registers no tests. */
import assert from "node:assert/strict";
import type {
  HostedExecutionIntentV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  ReleaseStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import {
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import {
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import type {
  HostedSupervisorRunIdentityV1,
} from "../../src/host/actions-supervisor.ts";
import {
  CANDIDATE,
  DORMANT_HOSTED_POLICIES,
  ISSUE,
  LAUNCHER,
  releaseRequest,
  requireRun,
  reviewReceipt,
  run,
  runProof,
  skippedProof,
  TASK_TITLE,
} from "./actions-supervisor-fixture.ts";
import type { RigV1 } from "./actions-supervisor-fixture.ts";

/** Bootstrap the generation-1 pointer and settle one healthy bootstrap run. */
export async function bootstrapHealthy(
  rig: RigV1,
): Promise<HostedExecutionIntentV1> {
  rig.evidence.revisions.add(LAUNCHER);
  const identity = run(1);
  const boot = requireRun(await rig.prepare(identity));
  rig.evidence.settlements.set(
    boot.id,
    runProof(boot, "healthy"),
  );
  assert.equal((await rig.finalize(identity)).status, "idle");
  return boot;
}

/** Drive bootstrap -> requested receipt -> healthy prior -> candidate run. */
export async function advanceToCandidate(
  rig: RigV1,
): Promise<
  { candidate: HostedExecutionIntentV1; prior: HostedExecutionIntentV1 }
> {
  await bootstrapHealthy(rig);
  await ordinaryTurn(rig, 9001);
  const request = releaseRequest();
  await rig.seedRepair([request], [reviewReceipt(request)]);
  rig.evidence.requests.add(request.id);
  const prior = requireRun(await rig.prepare(run(2)));
  assert.equal(prior.purpose, "prior");
  rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
  await ordinaryTurn(rig, 9002);
  const candidate = requireRun(await rig.prepare(run(3)));
  assert.equal(candidate.purpose, "candidate");
  return { candidate, prior };
}

/** An explicit interleaved admission preserves the preceding healthy proof. */
export async function ordinaryTurn(rig: RigV1, runId: number): Promise<void> {
  const intent = requireRun(await rig.prepare(run(runId)));
  assert.equal(intent.purpose, "ordinary");
  rig.evidence.settlements.set(intent.id, skippedProof(intent));
  assert.equal((await rig.finalize(run(runId))).status, "idle");
}

/** A self-consistent statement whose text drifted from the reviewed task. */
export async function driftedTask(
  body: string,
): Promise<ReviewTaskStatementV1> {
  return {
    issueNumber: ISSUE,
    title: TASK_TITLE,
    body,
    digest: await reviewTaskStatementDigest({
      issueNumber: ISSUE,
      title: TASK_TITLE,
      body,
    }),
  };
}

/**
 * One distinct self-open request + completed receipt pair per refusal below.
 * Every variant owns its own immutable ids, so seeding never rewrites an
 * already-completed receipt or a frozen request identity: separate review
 * cycles look exactly like this to the real repair store.
 */
export function variantRequest(
  slug: string,
  receiptOverrides: Record<string, unknown> = {},
): { request: ReleaseRequestV1; receipt: ReviewReceiptV1 } {
  const request = releaseRequest({
    id: `release-${slug}`,
    source: {
      pullRequest: 5,
      reviewRequestId: `review-req-${slug}`,
      reviewReceiptId: `review-receipt-${slug}`,
      head: CANDIDATE,
      base: LAUNCHER,
    },
  });
  return { request, receipt: reviewReceipt(request, receiptOverrides) };
}

/**
 * Persist the exact RESUMED promote intent by running the real core once and
 * refusing only its second (pointer-movement) CAS write: the durable state
 * stays at the already-persisted `promoting` intent with the real healthy
 * prior proof that authorized it, exactly what a later prepare resumes.
 * Nothing is fabricated and no lifecycle transition is hand-written.
 */
export async function persistPromotingIntent(
  rig: RigV1,
  identity: HostedSupervisorRunIdentityV1,
): Promise<void> {
  let writes = 0;
  const state: StateReadView & ReleaseStateWriter = {
    readRelease: rig.release.readRelease.bind(rig.release),
    readRepair: rig.release.readRepair.bind(rig.release),
    writeRelease: async (next, expectedHead) => {
      writes++;
      if (writes === 2) {
        return portOk<StateWriteResultV1>({
          status: "conflict",
          currentHead: null,
        });
      }
      return await rig.release.writeRelease(next, expectedHead);
    },
  };
  const outcome = await runHostedSupervisorPrepare({
    ...DORMANT_HOSTED_POLICIES,
    clock: rig.clock,
    state,
    run: identity,
    evidence: rig.evidence,
  });
  assert.equal(outcome.status, "pending", JSON.stringify(outcome));
  const read = await rig.release.readRelease();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") {
    throw new Error("release state unreadable");
  }
  assert.equal(read.value.snapshot.hostedReleases[0]?.phase, "promoting");
  assert.notEqual(read.value.snapshot.hostedReleases[0]?.pointerIntent, null);
  assert.equal(read.value.snapshot.hostedRuntimes[0]?.activeRevision, LAUNCHER);
  assert.equal(read.value.snapshot.hostedRuntimes[0]?.generation, 1);
  assert.equal(read.value.snapshot.hostedRuntimes[0]?.execution, null);
  assert.equal(
    read.value.snapshot.hostedRuntimes[0]?.lastHealthyProof?.outcome,
    "healthy",
  );
}
