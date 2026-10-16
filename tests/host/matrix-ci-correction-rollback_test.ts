/**
 * Rollback safety of the CI correction cell shape. A cell planned in one run
 * is consumed by a later run, and after a failed generation 77 is rolled back
 * that consumer is generation 76's own code (41bb853a1). Its per-cell
 * correction check accepts only a head that a completed review rejected, and
 * it runs before the runtime-mismatch disposition: a CI correction of a head
 * reviewed clean is refused as a generic provenance refusal, which its
 * historical isolation rethrows, failing every later repair run while the
 * charge stays unconsumed. Every other correction shape is isolated as an
 * authenticated runtime mismatch. Hosted runs of this tree therefore never
 * plan the CI shape (`HOSTED_CI_CORRECTIONS`); this tree's consumer accepts
 * it, so the runtime installed after generation 77 may.
 */
import assert from "node:assert/strict";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import { MatrixHistoricalRuntimeMismatch } from "../../src/host/matrix-artifact-port.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { ciCorrectionFinding } from "../../src/repair/ci-rejection.ts";
import { reviewReceipt, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { bytes, fixture, ISO, RUN, zip } from "./matrix-artifact-fixtures.ts";
import { gen76Available, loadGen76Modules } from "./gen76-runtime-source.ts";

type Finding = { severity: string; path: string | null; message: string };
type Rig = Awaited<ReturnType<typeof fixture>>;
type RecoverInput = Parameters<
  ReturnType<typeof createActionsMatrixArtifactTransport>["recover"]
>[0];
type Transport = { recover(input: RecoverInput): Promise<unknown> };

const available = await gen76Available();

/** Re-bind the planner's correction request and every digest over it. */
async function bindCorrection(rig: Rig, findings: Finding[]) {
  rig.repair.work[0].target.head = SHA2;
  rig.repair.work[0].target.pr = 12;
  rig.repair.work[0].createdAt = T0 - 10_000;
  rig.cell.request.checkoutBase = SHA2;
  rig.cell.request.reviewFindings = findings;
  rig.cell.requestDigest = await matrixDigestV1(rig.cell.request);
  rig.result.requestDigest = rig.cell.requestDigest;
  rig.result.bundle!.head = SHA3;
  rig.result.receipt!.candidate!.head = SHA3;
  rig.plannerMarker.planDigest = await matrixDigestV1(rig.plan);
  rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
  rig.cellMarker.resultDigest = await matrixDigestV1(rig.result);
  rig.logs.set(402, ISO + " " + JSON.stringify(rig.cellMarker) + "\n");
  await rig.setArchive(
    501,
    rig.planName,
    await zip([{ name: "plan.json", content: bytes(rig.plan) }]),
  );
  await rig.setArchive(
    502,
    rig.cellName,
    await zip([
      { name: "result.json", content: bytes(rig.result) },
      { name: rig.result.bundle!.file, content: rig.bundle },
    ]),
  );
}

/** The completed review of SHA2: clean (CI shape) or rejecting (review). */
function review(rejecting: boolean) {
  return reviewReceipt(rejecting ? "rejecting-review" : "accepted-review", {
    pullRequest: { number: 12, head: SHA2, base: SHA1 },
    outcome: "completed",
    observedReviewer: "chatgpt-codex-connector[bot]",
    resultId: rejecting ? "rejecting-result" : "accepted-result",
    findings: rejecting
      ? [{
        id: "rejecting-finding",
        fingerprint: "e".repeat(64),
        severity: "P1",
        path: "fix.ts",
        message: "preserve requested behavior",
        resolved: false,
        resolutionEvidence: null,
      }]
      : [],
    unresolvedSeverities: rejecting ? ["P1"] : [],
    submittedAt: T0 - 2_000,
    completedAt: T0 - 1_000,
    observedAt: T0 - 500,
  });
}

/** A later consumer run of another runtime over the producer's wave. */
function historical(rig: Rig): RecoverInput {
  return {
    ...rig.input,
    currentRun: undefined,
    runtimeSha: SHA3,
    consumerRun: { ...RUN, runId: 99, runAttempt: 1 },
  };
}

async function recoverWith(rig: Rig, transport: Transport) {
  const cwd = Deno.cwd();
  Deno.chdir(`${rig.tmp}/checkout`);
  try {
    return await transport.recover(historical(rig));
  } catch (error) {
    return error;
  } finally {
    Deno.chdir(cwd);
  }
}

function transportFrom(
  factory: typeof createActionsMatrixArtifactTransport,
  rig: Rig,
): Transport {
  return factory({
    state: rig.state,
    token: "fake-local-token",
    http: rig.http,
    clock: { now: () => T0 + 10_000 },
    artifactRoot: `${rig.tmp}/recovered`,
  }) as Transport;
}

Deno.test({
  name:
    "rollback: generation 76 refuses a CI correction cell generically but isolates a review correction",
  ignore: !available,
  async fn(t) {
    const gen76 = await loadGen76Modules([
      "src/host/matrix-artifacts.ts",
      "src/host/matrix-artifact-port.ts",
    ]);
    const factory76 = gen76.modules[0]
      .createActionsMatrixArtifactTransport as typeof createActionsMatrixArtifactTransport;
    const Mismatch76 = gen76.modules[1]
      .MatrixHistoricalRuntimeMismatch as typeof MatrixHistoricalRuntimeMismatch;
    try {
      const ci = ciCorrectionFinding(SHA1, [{
        name: "validate",
        status: "completed",
        conclusion: "failure",
        head: SHA2,
        startedAt: T0,
        completedAt: T0 + 1,
      }]);
      await t.step(
        "a CI correction is a generic generation-76 refusal",
        async () => {
          const rig = await fixture();
          try {
            rig.repair.reviews.push(review(false));
            await bindCorrection(rig, [ci]);
            const refused = await recoverWith(
              rig,
              transportFrom(factory76, rig),
            );
            assert.ok(refused instanceof Error, String(refused));
            assert.ok(
              !(refused instanceof Mismatch76),
              "never the isolatable runtime mismatch",
            );
            assert.match(
              String(refused),
              /provenance unavailable or conflicting/,
            );
            // This tree's consumer isolates the same cell as a runtime mismatch.
            const isolated = await recoverWith(
              rig,
              transportFrom(createActionsMatrixArtifactTransport, rig),
            );
            assert.ok(
              isolated instanceof MatrixHistoricalRuntimeMismatch,
              String(isolated),
            );
          } finally {
            await Deno.remove(rig.tmp, { recursive: true });
          }
        },
      );
      await t.step("a review correction is an isolated mismatch", async () => {
        const rig = await fixture();
        try {
          rig.repair.reviews.push(review(true));
          await bindCorrection(rig, [{
            severity: "P1",
            path: "fix.ts",
            message: "preserve requested behavior",
          }]);
          const isolated = await recoverWith(
            rig,
            transportFrom(factory76, rig),
          );
          assert.ok(isolated instanceof Mismatch76, String(isolated));
        } finally {
          await Deno.remove(rig.tmp, { recursive: true });
        }
      });
    } finally {
      await gen76.dispose();
    }
  },
});
