// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import { validateHostedStateTransition } from "../../src/contracts/hosted-supervisor.ts";
import {
  execution,
  failedProof,
  hostedRelease,
  proof,
  runtime,
  SHA_A,
  SHA_B,
  T,
} from "./hosted-supervisor-fixtures.ts";

Deno.test("hosted supervisor: failed prior and failed rollback settle in the runtime and retry deterministically", () => {
  const priorExec = execution({
    purpose: "prior",
    revision: SHA_A,
    generation: 1,
  });
  const requested = hostedRelease({ phase: "requested", priorProof: null });
  // Failed prior execution: clears the runtime, keeps the release requested.
  const failedPriorRuntime = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: null,
    lastExecutionProof: failedProof(priorExec),
  });
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: priorExec,
        }),
      ],
      [requested],
      [failedPriorRuntime],
      [requested],
    ),
    null,
  );
  // A later NEW prior run then settles healthy and attaches the proof.
  const retryPrior = execution({
    runId: 2,
    id: "2:1:repair",
    purpose: "prior",
    revision: SHA_A,
    generation: 1,
  });
  const retryActive = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: retryPrior,
    lastExecutionProof: failedProof(priorExec),
    updatedAt: T + 2001,
  });
  assert.equal(
    validateHostedStateTransition(
      [failedPriorRuntime],
      [requested],
      [retryActive],
      [requested],
    ),
    null,
  );
  const healthyPrior = proof({ execution: retryPrior });
  assert.equal(
    validateHostedStateTransition(
      [retryActive],
      [requested],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: healthyPrior,
          lastHealthyProof: healthyPrior,
          updatedAt: T + 2002,
        }),
      ],
      [
        hostedRelease({
          phase: "promoting",
          priorProof: healthyPrior,
          pointerIntent: {
            action: "promote",
            expectedRevision: SHA_A,
            nextRevision: SHA_B,
            expectedGeneration: 1,
            createdAt: T + 1000,
          },
        }),
      ],
    ),
    null,
  );

  // Failed rollback execution: clears the runtime, keeps rollback_verifying.
  const failedCandidateExec = execution({
    purpose: "candidate",
    revision: SHA_B,
    generation: 2,
  });
  const healthyPriorProof = proof({ execution: priorExec });
  const failedCandidate = failedProof(failedCandidateExec);
  const rollbackBase = runtime({
    activeRevision: SHA_A,
    generation: 3,
    execution: null,
    lastExecutionProof: failedCandidate,
    lastHealthyProof: healthyPriorProof,
  });
  const rollbackVerifying = hostedRelease({
    phase: "rollback_verifying",
    priorProof: healthyPriorProof,
    candidateProof: failedCandidate,
  });
  const rollbackExec = execution({
    runId: 3,
    id: "3:1:repair",
    purpose: "rollback",
    revision: SHA_A,
    generation: 3,
  });
  const rollbackActive = runtime({
    activeRevision: SHA_A,
    generation: 3,
    execution: rollbackExec,
    lastExecutionProof: failedCandidate,
    lastHealthyProof: healthyPriorProof,
    updatedAt: T + 2001,
  });
  assert.equal(
    validateHostedStateTransition(
      [rollbackBase],
      [rollbackVerifying],
      [rollbackActive],
      [rollbackVerifying],
    ),
    null,
  );
  const failedRollback = failedProof(rollbackExec);
  const rollbackFailed = runtime({
    activeRevision: SHA_A,
    generation: 3,
    execution: null,
    lastExecutionProof: failedRollback,
    lastHealthyProof: healthyPriorProof,
    updatedAt: T + 2002,
  });
  assert.equal(
    validateHostedStateTransition(
      [rollbackActive],
      [rollbackVerifying],
      [rollbackFailed],
      [rollbackVerifying],
    ),
    null,
  );
  // A later healthy rollback run attaches the rollback proof and closes.
  const retryRollback = execution({
    runId: 4,
    id: "4:1:repair",
    purpose: "rollback",
    revision: SHA_A,
    generation: 3,
  });
  const retryRollbackActive = runtime({
    activeRevision: SHA_A,
    generation: 3,
    execution: retryRollback,
    lastExecutionProof: failedRollback,
    lastHealthyProof: healthyPriorProof,
    updatedAt: T + 2003,
  });
  assert.equal(
    validateHostedStateTransition(
      [rollbackFailed],
      [rollbackVerifying],
      [retryRollbackActive],
      [rollbackVerifying],
    ),
    null,
  );
  const healthyRollback = proof({ execution: retryRollback });
  assert.equal(
    validateHostedStateTransition(
      [retryRollbackActive],
      [rollbackVerifying],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 3,
          execution: null,
          lastExecutionProof: healthyRollback,
          lastHealthyProof: healthyRollback,
          updatedAt: T + 2004,
        }),
      ],
      [
        hostedRelease({
          phase: "rolled_back",
          priorProof: healthyPriorProof,
          candidateProof: failedCandidate,
          rollbackProof: healthyRollback,
        }),
      ],
    ),
    null,
  );
});
