// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import {
  parseHostedExecutionSettlementV1,
  parseHostedNotStartedProofV1,
  parseHostedRuntimeRecordV1,
  validateHostedStateTransition,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  BOOT_EXECUTION,
  DIGEST,
  execution,
  hostedRelease,
  notStarted,
  proof,
  rejected,
  runtime,
  SHA_A,
  SHA_B,
  T,
} from "./hosted-supervisor-fixtures.ts";

Deno.test("hosted supervisor: pointer movement is atomic, intent-bound and never carries an execution", () => {
  const priorExec = execution({
    purpose: "prior",
    revision: SHA_A,
    generation: 1,
  });
  const priorHealthy = proof({ execution: priorExec });
  const moving = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: null,
    lastExecutionProof: priorHealthy,
    lastHealthyProof: priorHealthy,
  });
  const moved = runtime({
    activeRevision: SHA_B,
    generation: 2,
    execution: null,
    lastExecutionProof: priorHealthy,
    lastHealthyProof: priorHealthy,
    updatedAt: T + 2001,
  });
  const promoting = () =>
    hostedRelease({
      phase: "promoting",
      priorProof: priorHealthy,
      pointerIntent: {
        action: "promote",
        expectedRevision: SHA_A,
        nextRevision: SHA_B,
        expectedGeneration: 1,
        createdAt: T + 1000,
      },
    });
  const verifying = () => hostedRelease({ phase: "verifying" });
  // Intent-before-pointer: the healthy prior settlement attaches the proof and
  // the intent in the same write that clears the prior execution.
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: priorExec,
        }),
      ],
      [hostedRelease({ phase: "requested", priorProof: null })],
      [moving],
      [promoting()],
    ),
    null,
  );
  // A proof insertion without clearing its exact execution is refused.
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [hostedRelease({ phase: "requested", priorProof: null })],
      [moving],
      [promoting()],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [promoting()],
      [moved],
      [verifying()],
    ),
    null,
  );
  // No movement without the matching prior intent.
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [hostedRelease({ phase: "verifying" })],
      [moved],
      [verifying()],
    ),
    "hosted runtime pointer movement has no exact persisted pointer intent and phase advance",
  );
  // Movement must not set a new execution in the same write.
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [promoting()],
      [
        runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: execution({
            runId: 2,
            id: "2:1:repair",
            purpose: "candidate",
            revision: SHA_B,
          }),
          lastExecutionProof: priorHealthy,
          lastHealthyProof: priorHealthy,
          updatedAt: T + 2001,
        }),
      ],
      [verifying()],
    ),
    "hosted runtime pointer movement requires no active execution",
  );
  // Movement is refused while an execution is still active.
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: priorExec,
        }),
      ],
      [promoting()],
      [moved],
      [verifying()],
    ),
    "hosted runtime pointer movement requires no active execution",
  );
  // Generation jumps and same-revision generation changes stay refused.
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [promoting()],
      [
        runtime({
          activeRevision: SHA_B,
          generation: 3,
          execution: null,
          lastExecutionProof: priorHealthy,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [verifying()],
    ),
    "hosted runtime pointer movement requires exactly one generation increment",
  );
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [promoting()],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 2,
          execution: null,
          lastExecutionProof: priorHealthy,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [verifying()],
    ),
    "the same hosted runtime revision cannot change generation",
  );
  // Phase advance without the movement is refused.
  assert.equal(
    validateHostedStateTransition(
      [moving],
      [promoting()],
      [moving],
      [verifying()],
    ),
    "a hosted release phase advance requires the exact atomic pointer movement",
  );
});

Deno.test("hosted supervisor: no-execution settlement parses exactly and never fabricates run evidence", () => {
  const skipped = notStarted(BOOT_EXECUTION);
  assert.equal(skipped.outcome, "not_started");
  assert.equal(skipped.jobId, null);
  assert.equal(skipped.execution.id, "1:1:repair");
  const absent = notStarted(BOOT_EXECUTION, { jobId: 12 });
  assert.equal(absent.jobId, 12);
  // No start time, startup flag, base, terminal or log digest exists.
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, startedAt: T + 1 }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, logDigest: DIGEST }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, startupReady: false }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, terminalAt: null }),
  );
  // Fixed identity, exact intent binding and digest.
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, workflowId: 1 }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      workflowPath: ".github/workflows/other.yml",
    }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      repository: "ubiquity/x",
    }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, ref: "refs/heads/x" }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      evidenceDigest: "zz",
    }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, { ...skipped, outcome: "failed" }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      execution: { ...skipped.execution, id: "9:9:repair" },
    }),
  );
  // Listing observation bounds use the same 999 ms tolerance.
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      finishedAt: T - 5000,
    }),
  );
  assert.ok(
    rejected(parseHostedNotStartedProofV1, {
      ...skipped,
      finishedAt: T + 5000,
      observedAt: T + 500,
    }),
  );
  // Dispatcher: run proofs stay run proofs; unknown outcomes reject.
  assert.equal(parseHostedExecutionSettlementV1(proof()).outcome, "healthy");
  assert.equal(
    parseHostedExecutionSettlementV1(skipped).outcome,
    "not_started",
  );
  assert.ok(
    rejected(parseHostedExecutionSettlementV1, {
      ...skipped,
      outcome: "cancelled",
    }),
  );
  // Runtime accepts the settlement union; health remains run-proof only.
  const settled = runtime({ execution: null, lastExecutionProof: skipped });
  assert.equal(settled.lastExecutionProof?.outcome, "not_started");
  assert.ok(
    rejected(parseHostedRuntimeRecordV1, {
      ...runtime(),
      lastHealthyProof: skipped,
    }),
  );
});

Deno.test("hosted supervisor: not_started clears the intent only and retries at a later run", () => {
  const active = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: BOOT_EXECUTION,
  });
  const settlement = notStarted(BOOT_EXECUTION);
  const cleared = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: null,
    lastExecutionProof: settlement,
    updatedAt: T + 2001,
  });
  assert.equal(
    validateHostedStateTransition([active], [], [cleared], []),
    null,
  );
  // It can never claim health in the same write.
  const otherHealthy = proof({
    execution: execution({
      runId: 5,
      id: "5:1:repair",
      purpose: "ordinary",
      revision: SHA_A,
      generation: 1,
      releaseId: null,
    }),
  });
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: settlement,
          lastHealthyProof: otherHealthy,
          updatedAt: T + 2001,
        }),
      ],
      [],
    ),
    "a not_started settlement preserves lastHealthyProof",
  );
  // It can never move the pointer in the same write.
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastExecutionProof: settlement,
          updatedAt: T + 2001,
        }),
      ],
      [],
    ),
    "a not_started settlement cannot move the runtime pointer",
  );
  // It can never attach a release proof.
  assert.equal(
    validateHostedStateTransition(
      [active],
      [hostedRelease({ phase: "requested", priorProof: null })],
      [cleared],
      [
        {
          ...hostedRelease(),
          phase: "promoting",
          priorProof: proof({ execution: BOOT_EXECUTION }),
          pointerIntent: {
            action: "promote",
            expectedRevision: SHA_A,
            nextRevision: SHA_B,
            expectedGeneration: 1,
            createdAt: T + 1000,
          },
        },
      ],
    ),
    "a not_started settlement cannot attach a release proof",
  );
  // A retry is a NEW run/attempt in a later write; the old one never rebinds.
  const retry = execution({
    runId: 2,
    id: "2:1:repair",
    purpose: "ordinary",
    revision: SHA_A,
    generation: 1,
    releaseId: null,
  });
  assert.equal(
    validateHostedStateTransition(
      [cleared],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: retry,
          lastExecutionProof: settlement,
          updatedAt: T + 2002,
        }),
      ],
      [],
    ),
    null,
  );
  // Same no-execution settlement rebound: the parser refuses the equal active
  // execution, so the transition guard fixture is assembled from valid parts.
  const notStartedRebind = {
    ...runtime({
      activeRevision: SHA_A,
      generation: 1,
      execution: BOOT_EXECUTION,
      updatedAt: T + 2002,
    }),
    lastExecutionProof: settlement,
  };
  assert.equal(
    validateHostedStateTransition([cleared], [], [notStartedRebind], []),
    "a settled hosted runtime execution cannot be rebound",
  );
});
