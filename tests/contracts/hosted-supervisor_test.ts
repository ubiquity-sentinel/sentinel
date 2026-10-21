// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import {
  HOSTED_RUNTIME_ID,
  HOSTED_SUPERVISOR_REPOSITORY,
  hostedReceiptBindsRequest,
  parseHostedExecutionIntentV1,
  parseHostedReleaseRecordV1,
  parseHostedRunProofV1,
  parseHostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseRepositoryIdentity } from "../../src/contracts/shared.ts";
import {
  BOOT_EXECUTION,
  execution,
  failedProof,
  hostedRelease,
  proof,
  rejected,
  releaseRequest,
  releaseSnapshot,
  runtime,
  SELF,
  SHA_A,
  SHA_B,
  T,
} from "./hosted-supervisor-fixtures.ts";

Deno.test("hosted supervisor: exact valid records parse and the request binds canonically", () => {
  const intent = execution();
  assert.equal(intent.id, "1:1:repair");
  assert.equal(intent.purpose, "candidate");
  assert.equal(intent.releaseId, "release-1");
  const runProof = proof();
  assert.equal(runProof.settled, true);
  assert.equal(runProof.outcome, "healthy");
  const settled = runtime({
    execution: null,
    lastExecutionProof: failedProof(BOOT_EXECUTION),
  });
  assert.equal(settled.lastExecutionProof?.outcome, "failed");
  assert.equal(settled.lastHealthyProof, null);
  const release = hostedRelease();
  assert.equal(release.phase, "verifying");
  assert.equal(release.priorProof?.execution.purpose, "prior");
  const snapshot = releaseSnapshot({
    hostedRuntimes: [runtime()],
    hostedReleases: [release],
  });
  assert.equal(snapshot.hostedRuntimes.length, 1);
  assert.equal(snapshot.hostedReleases.length, 1);
  // The reviewed request binds canonically; a changed request does not.
  assert.equal(hostedReceiptBindsRequest(release, releaseRequest()), true);
  assert.equal(
    hostedReceiptBindsRequest(
      release,
      releaseRequest({
        source: {
          pullRequest: 1,
          reviewRequestId: "review-req-1",
          reviewReceiptId: "other-receipt",
          head: SHA_B,
          base: SHA_A,
        },
      }),
    ),
    false,
  );
});

Deno.test("hosted supervisor: retired self identity normalizes from pre-migration state", () => {
  assert.deepEqual(
    parseRepositoryIdentity({
      owner: "ubiquity",
      name: "sentinel",
      installationId: 0,
    }, "$.repository"),
    SELF,
  );
  const legacyProof = parseHostedRunProofV1({
    ...proof(),
    repository: "ubiquity/sentinel",
  });
  assert.equal(legacyProof.repository, HOSTED_SUPERVISOR_REPOSITORY);
  const legacyRuntime = runtime({
    id: "ubiquity/sentinel:0:production",
    execution: null,
    lastExecutionProof: {
      ...failedProof(BOOT_EXECUTION),
      repository: "ubiquity/sentinel",
    },
  });
  assert.equal(legacyRuntime.id, HOSTED_RUNTIME_ID);
  assert.equal(
    legacyRuntime.lastExecutionProof?.repository,
    HOSTED_SUPERVISOR_REPOSITORY,
  );
});

Deno.test("hosted supervisor: execution and proof reject foreign or unsettled metadata", () => {
  assert.ok(
    rejected(parseHostedExecutionIntentV1, { ...execution(), id: "1:1:other" }),
  );
  assert.ok(
    rejected(parseHostedExecutionIntentV1, {
      ...execution(),
      purpose: "ordinary",
      releaseId: "release-1",
    }),
  );
  assert.ok(
    rejected(parseHostedExecutionIntentV1, {
      ...execution(),
      purpose: "candidate",
      releaseId: null,
    }),
  );
  assert.ok(rejected(parseHostedRunProofV1, { ...proof(), workflowId: 1 }));
  assert.ok(
    rejected(parseHostedRunProofV1, {
      ...proof(),
      workflowPath: ".github/workflows/other.yml",
    }),
  );
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), repository: "ubiquity/x" }),
  );
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), ref: "refs/heads/x" }),
  );
  assert.ok(rejected(parseHostedRunProofV1, { ...proof(), settled: false }));
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), startupReady: false }),
  );
  assert.ok(rejected(parseHostedRunProofV1, { ...proof(), baseSha: null }));
  assert.ok(rejected(parseHostedRunProofV1, { ...proof(), terminalAt: null }));
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), terminalAt: T + 4000 }),
  );
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), observedAt: T + 500 }),
  );
  assert.ok(
    rejected(parseHostedRunProofV1, { ...proof(), startedAt: T - 5000 }),
  );
  // A failed proof may precede any terminal output but must be a settled job.
  const failed = failedProof(execution());
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.terminalAt, null);
  assert.equal(failed.settled, true);
});

Deno.test("hosted supervisor: runtime requires the settlement proof and never an already-settled execution", () => {
  const settled = failedProof(BOOT_EXECUTION);
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: SHA_A,
      generation: 1,
      lastHealthyProof: null,
      nextOrdinaryAt: T,
      execution: null,
      createdAt: T,
      updatedAt: T,
    }),
  );
  // The active execution cannot already be its own settlement.
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime({
        activeRevision: SHA_A,
        generation: 1,
        execution: BOOT_EXECUTION,
      }),
      lastExecutionProof: settled,
    }),
  );
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime({
        activeRevision: SHA_A,
        generation: 1,
        execution: BOOT_EXECUTION,
      }),
      lastHealthyProof: proof({ execution: BOOT_EXECUTION }),
    }),
  );
  // The deterministic execution id is the identity: altered metadata on the
  // settled intent does not make it a different, still-active execution.
  const alteredBoot = execution({
    purpose: "bootstrap",
    revision: SHA_A,
    generation: 1,
    releaseId: null,
    createdAt: T + 1000,
  });
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime({
        activeRevision: SHA_A,
        generation: 1,
        execution: BOOT_EXECUTION,
      }),
      lastExecutionProof: failedProof(alteredBoot),
    }),
  );
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime({
        activeRevision: SHA_A,
        generation: 1,
        execution: BOOT_EXECUTION,
      }),
      lastHealthyProof: proof({ execution: alteredBoot }),
    }),
  );
  // lastHealthyProof is healthy-only; lastExecutionProof may be failed.
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime(),
      lastHealthyProof: settled,
    }),
  );
  const valid = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: null,
    lastExecutionProof: settled,
  });
  assert.equal(valid.lastExecutionProof?.outcome, "failed");
});

Deno.test("hosted supervisor: release record rejects foreign requests, wrong or failed proofs and illegal phases", () => {
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      request: releaseRequest({
        target: {
          repository: {
            owner: "Ubiquity-Sentinel",
            name: "sentinel",
            installationId: 7,
          },
          environment: "production",
        },
      }),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      request: releaseRequest({
        target: { repository: { ...SELF }, environment: "isolated" },
      }),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      request: releaseRequest({ status: "fulfilled" }),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      request: releaseRequest({
        source: {
          pullRequest: 1,
          reviewRequestId: "review-req-1",
          reviewReceiptId: null,
          head: SHA_B,
          base: SHA_A,
        },
      }),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, { ...hostedRelease(), id: "other" }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      priorRevision: SHA_B,
    }),
  );
  // Wrong purpose / wrong head binding in proofs.
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      priorProof: proof(),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      phase: "accepted",
      candidateProof: proof({
        execution: execution({ purpose: "candidate", revision: SHA_A }),
      }),
    }),
  );
  // priorProof and rollbackProof are healthy-only.
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      priorProof: failedProof(
        execution({ purpose: "prior", revision: SHA_A, generation: 1 }),
      ),
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      phase: "rollback_verifying",
      candidateProof: failedProof(execution()),
      rollbackProof: failedProof(
        execution({ purpose: "rollback", revision: SHA_A, generation: 1 }),
      ),
    }),
  );
  // A failed candidate is the first exact candidate result and is allowed.
  const rollbackPending = hostedRelease({
    phase: "rollback_pending",
    candidateProof: failedProof(execution()),
  });
  assert.equal(rollbackPending.phase, "rollback_pending");
  // Pointer intents exist only with their exact phase movement.
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      pointerIntent: {
        action: "promote",
        expectedRevision: SHA_A,
        nextRevision: SHA_B,
        expectedGeneration: 1,
        createdAt: T,
      },
    }),
  );
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      phase: "promoting",
      pointerIntent: null,
    }),
  );
  // A proof execution cannot precede the hosted receipt.
  assert.ok(
    rejected(parseHostedReleaseRecordV1, {
      ...hostedRelease(),
      createdAt: T + 5000,
      updatedAt: T + 6000,
    }),
  );
});

Deno.test("hosted supervisor: snapshot requires the hosted collections and bounds the runtime pointer", () => {
  assert.ok(
    rejected(parseReleaseStateSnapshotV1, {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T,
      releases: [],
      githubCooldowns: [],
    }),
  );
  assert.ok(
    rejected(parseReleaseStateSnapshotV1, {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T,
      releases: [],
      hostedRuntimes: [runtime(), runtime()],
      hostedReleases: [],
      githubCooldowns: [],
    }),
  );
  assert.ok(
    rejected(parseReleaseStateSnapshotV1, {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T,
      releases: [],
      hostedRuntimes: [],
      hostedReleases: [hostedRelease(), hostedRelease()],
      githubCooldowns: [],
    }),
  );
});
