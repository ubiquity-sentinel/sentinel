import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  parseHostedReleaseRecordV1,
  parseHostedRuntimeRecordV1,
  validateHostedStateTransition,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  emptyHostedVerification,
  hostedOrdinaryAdmitted,
} from "../../src/contracts/hosted-supervisor-verification.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { recordFiles } from "../../src/state/state-codec.ts";
import {
  execution,
  failedProof,
  hostedRelease,
  releaseSnapshot,
  runtime,
  SHA_A,
  T,
} from "./hosted-supervisor-fixtures.ts";

function requested() {
  return hostedRelease({ phase: "requested", priorProof: null });
}
function installed() {
  return runtime({ activeRevision: SHA_A, generation: 1, execution: null });
}
function admission() {
  const before = installed(), release = requested();
  const intent = execution({
    purpose: "prior",
    revision: SHA_A,
    generation: 1,
  });
  const journal = {
    ...emptyHostedVerification(),
    attempts: 1,
    lastExecutionId: intent.id,
    executionIds: [intent.id],
  };
  const nextRuntime = parseHostedRuntimeRecordV1({
    ...before,
    execution: intent,
    lastTurn: "verification",
  });
  const nextRelease = parseHostedReleaseRecordV1({
    ...release,
    verification: { prior: journal, candidate: emptyHostedVerification() },
  });
  return { before, release, intent, nextRuntime, nextRelease };
}
Deno.test("hosted starvation contracts: legacy records retain exact serialized bytes and missing journals mean zero", () => {
  const r = requested(),
    p = installed(),
    snapshot = releaseSnapshot({ hostedRuntimes: [p], hostedReleases: [r] });
  assert.equal(
    canonicalStringify(parseHostedReleaseRecordV1(r)),
    canonicalStringify(r),
  );
  assert.equal(
    canonicalStringify(parseHostedRuntimeRecordV1(p)),
    canonicalStringify(p),
  );
  assert.equal(
    canonicalStringify(parseReleaseStateSnapshotV1(snapshot)),
    canonicalStringify(snapshot),
  );
  assert.equal(r.verification, undefined);
  assert.equal(p.verificationFailures, undefined);
  assert.equal(snapshot.hostedInstallations, undefined);
});
Deno.test("hosted starvation contracts: attempts and settlement are atomic, bounded and cannot double count", () => {
  const a = admission();
  assert.equal(
    validateHostedStateTransition([a.before], [a.release], [a.nextRuntime], [
      a.nextRelease,
    ]),
    null,
  );
  assert.match(
    validateHostedStateTransition([a.before], [a.release], [a.before], [
      a.nextRelease,
    ]) ?? "",
    /admission/,
  );
  const proof = failedProof(a.intent);
  const next = parseHostedRuntimeRecordV1({
    ...a.nextRuntime,
    execution: null,
    lastExecutionProof: proof,
    verificationFailures: 1,
    failedVerificationIds: [a.intent.id],
    lastVerificationId: a.intent.id,
  });
  const journal = {
    ...a.nextRelease.verification!.prior,
    failures: 1,
    lastFailure: { proof, reason: "execution_failed" as const },
    settledExecutionIds: [a.intent.id],
  };
  const release = parseHostedReleaseRecordV1({
    ...a.nextRelease,
    verification: { prior: journal, candidate: emptyHostedVerification() },
  });
  assert.equal(
    validateHostedStateTransition([a.nextRuntime], [a.nextRelease], [next], [
      release,
    ]),
    null,
  );
  assert.equal(
    validateHostedStateTransition([next], [release], [next], [release]),
    null,
  );
  assert.match(
    validateHostedStateTransition([next], [release], [next], [{
      ...release,
      verification: {
        ...release.verification!,
        prior: { ...journal, failures: 2 },
      },
    }]) ?? "",
    /journal/,
  );
  assert.throws(() =>
    parseHostedReleaseRecordV1({
      ...release,
      verification: {
        ...release.verification,
        prior: {
          ...journal,
          attempts: 3,
          executionIds: [a.intent.id, "2:1:repair", "3:1:repair"],
          lastExecutionId: "3:1:repair",
        },
      },
    })
  );
});
Deno.test("hosted starvation contracts: degraded mode requires durable exact generation failures and execution admission", () => {
  const before = installed(),
    intent = execution({
      purpose: "ordinary",
      releaseId: null,
      revision: SHA_A,
      generation: 1,
    });
  const forged = parseHostedRuntimeRecordV1({
    ...before,
    execution: intent,
    lastTurn: "ordinary",
    verificationFailures: 2,
    failedVerificationIds: ["2:1:repair", "3:1:repair"],
    ordinaryAdmission: {
      mode: "degraded",
      executionId: intent.id,
      revision: SHA_A,
      generation: 1,
      failedVerificationIds: ["2:1:repair", "3:1:repair"],
    },
  });
  assert.match(
    validateHostedStateTransition([before], [], [forged], []) ?? "",
    /exact settlement/,
  );
  assert.equal(
    hostedOrdinaryAdmitted({
      ...forged,
      ordinaryAdmission: {
        ...forged.ordinaryAdmission!,
        executionId: "9:1:repair",
      },
    }),
    false,
  );
  assert.equal(
    hostedOrdinaryAdmitted({ ...forged, verificationBlocked: true }),
    false,
  );
});
Deno.test("hosted starvation contracts: successor abandonment needs the installation CAS and cannot discard an intent", () => {
  const before = installed(), release = requested();
  const abandoned = parseHostedReleaseRecordV1({
    ...release,
    phase: "abandoned",
    abandonment: {
      reason: "included_in_successor",
      fromPhase: "requested",
      executionIds: [],
      successorRevision: before.activeRevision,
      recordedAt: T,
    },
  });
  assert.match(
    validateHostedStateTransition([before], [release], [before], [abandoned]) ??
      "",
    /atomic installation/,
  );
  assert.match(
    validateHostedStateTransition([before], [abandoned], [before], [{
      ...abandoned,
      updatedAt: T + 9999,
    }]) ?? "",
    /terminal/,
  );
  assert.throws(() =>
    parseHostedReleaseRecordV1({
      ...abandoned,
      pointerIntent: {
        action: "promote",
        expectedRevision: SHA_A,
        nextRevision: release.request.revision,
        expectedGeneration: 1,
        createdAt: T,
      },
    })
  );
});
Deno.test("hosted starvation contracts: hostedInstallations is a separate optional release collection", async () => {
  const snapshot = releaseSnapshot();
  assert.equal((await recordFiles(snapshot, "release")).length, 0);
  assert.throws(() =>
    parseReleaseStateSnapshotV1({
      ...snapshot,
      hostedInstallations: [{ version: "v1", kind: "hosted_installation" }],
    })
  );
});
