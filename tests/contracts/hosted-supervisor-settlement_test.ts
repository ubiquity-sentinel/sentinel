// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import { validateHostedStateTransition } from "../../src/contracts/hosted-supervisor.ts";
import type { HostedReleaseRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  BOOT_EXECUTION,
  execution,
  failedProof,
  hostedRelease,
  priorProof,
  proof,
  runtime,
  SHA_A,
  SHA_B,
  T,
} from "./hosted-supervisor-fixtures.ts";

Deno.test("hosted supervisor: ordinary/bootstrap settlement clears only with the exact proof and a new run comes later", () => {
  const active = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: BOOT_EXECUTION,
    updatedAt: T + 2000,
  });
  const settled = runtime({
    activeRevision: SHA_A,
    generation: 1,
    execution: null,
    lastExecutionProof: failedProof(BOOT_EXECUTION),
    updatedAt: T + 2001,
  });
  // A failed ordinary/bootstrap run settles; missing settlement stays pending.
  assert.equal(
    validateHostedStateTransition([active], [], [settled], []),
    null,
  );
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: null,
          updatedAt: T + 2001,
        }),
      ],
      [],
    ),
    "hosted runtime execution cannot be cleared without its exact settlement proof",
  );
  // An unrelated syntactically valid proof never settles it.
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: failedProof(
            execution({
              runId: 2,
              id: "2:1:repair",
              purpose: "ordinary",
              revision: SHA_A,
              generation: 1,
              releaseId: null,
            }),
          ),
          updatedAt: T + 2001,
        }),
      ],
      [],
    ),
    "hosted runtime execution cannot be cleared without its exact settlement proof",
  );
  // A failure preserves lastHealthyProof unchanged.
  const olderHealthy = proof({
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
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: BOOT_EXECUTION,
          lastHealthyProof: olderHealthy,
        }),
      ],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: failedProof(BOOT_EXECUTION),
          lastHealthyProof: olderHealthy,
        }),
      ],
      [],
    ),
    null,
  );
  // A healthy settlement may update both proofs to the same exact proof.
  const healthyBoot = proof({ execution: BOOT_EXECUTION });
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: healthyBoot,
          lastHealthyProof: healthyBoot,
        }),
      ],
      [],
    ),
    null,
  );
  // A changed healthy proof must be the same exact settlement proof.
  const unrelatedHealthy = proof({
    execution: execution({
      runId: 6,
      id: "6:1:repair",
      purpose: "ordinary",
      revision: SHA_A,
      generation: 1,
      releaseId: null,
    }),
  });
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: BOOT_EXECUTION,
          lastHealthyProof: olderHealthy,
        }),
      ],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: healthyBoot,
          lastHealthyProof: unrelatedHealthy,
        }),
      ],
      [],
    ),
    "a healthy settlement must update both runtime proofs to the same exact proof",
  );
  // A retry is a NEW intent in a later write, never a rebind.
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
      [settled],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: retry,
          lastExecutionProof: failedProof(BOOT_EXECUTION),
          updatedAt: T + 2002,
        }),
      ],
      [],
    ),
    null,
  );
  // The strict parser refuses an active execution equal to its own settlement,
  // so the transition guard fixture is assembled from valid parsed parts.
  const settledRebind = {
    ...runtime({
      activeRevision: SHA_A,
      generation: 1,
      execution: BOOT_EXECUTION,
      updatedAt: T + 2002,
    }),
    lastExecutionProof: failedProof(BOOT_EXECUTION),
  };
  assert.equal(
    validateHostedStateTransition([settled], [], [settledRebind], []),
    "a settled hosted runtime execution cannot be rebound",
  );
  // The same settled execution id with altered metadata is still refused.
  const alteredRebindExecution = execution({
    purpose: "bootstrap",
    revision: SHA_A,
    generation: 1,
    releaseId: null,
    createdAt: T + 1000,
  });
  const alteredRebind = {
    ...runtime({
      activeRevision: SHA_A,
      generation: 1,
      execution: alteredRebindExecution,
      updatedAt: T + 2002,
    }),
    lastExecutionProof: failedProof(BOOT_EXECUTION),
  };
  assert.equal(
    validateHostedStateTransition([settled], [], [alteredRebind], []),
    "a settled hosted runtime execution cannot be rebound",
  );
  assert.equal(
    validateHostedStateTransition(
      [active],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: execution({
            runId: 2,
            id: "2:1:repair",
            purpose: "ordinary",
            revision: SHA_A,
            generation: 1,
            releaseId: null,
          }),
          updatedAt: T + 2002,
        }),
      ],
      [],
    ),
    "an existing hosted runtime execution cannot be replaced",
  );
  assert.equal(
    validateHostedStateTransition(
      [settled],
      [],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: failedProof(retry),
          updatedAt: T + 2002,
        }),
      ],
      [],
    ),
    "hosted runtime lastExecutionProof can only change on its exact execution settlement",
  );
});

Deno.test("hosted supervisor: newly attached release proofs bind the exact settled execution", () => {
  // Distinct deterministic execution identity from the default run 1 prior job.
  const candidateExec = execution({ runId: 2, id: "2:1:repair" });
  const priorHealthy = priorProof();
  const verifying = hostedRelease();
  const active = runtime({
    activeRevision: SHA_B,
    generation: 2,
    execution: candidateExec,
    lastHealthyProof: priorHealthy,
  });
  const healthyCandidate = proof({ execution: candidateExec });
  const settled = runtime({
    activeRevision: SHA_B,
    generation: 2,
    execution: null,
    lastExecutionProof: healthyCandidate,
    lastHealthyProof: healthyCandidate,
    updatedAt: T + 2001,
  });
  assert.equal(
    validateHostedStateTransition(
      [active],
      [verifying],
      [settled],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: healthyCandidate,
        }),
      ],
    ),
    null,
  );
  // An unrelated proof is never attached, even though it is valid in shape.
  const unrelated = proof({
    execution: execution({ runId: 9, id: "9:1:repair" }),
  });
  assert.equal(
    validateHostedStateTransition(
      [active],
      [verifying],
      [settled],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: unrelated,
        }),
      ],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  // A failed settlement cannot be laundered into a healthy candidate proof,
  // even for the same execution intent and phase.
  assert.equal(
    validateHostedStateTransition(
      [active],
      [verifying],
      [
        runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastExecutionProof: failedProof(candidateExec),
          lastHealthyProof: priorHealthy,
          updatedAt: T + 2001,
        }),
      ],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: healthyCandidate,
        }),
      ],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  // Changed digest or time on the same execution is a different proof.
  assert.equal(
    validateHostedStateTransition(
      [active],
      [verifying],
      [settled],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: proof({
            execution: candidateExec,
            logDigest: "e".repeat(64),
          }),
        }),
      ],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  assert.equal(
    validateHostedStateTransition(
      [active],
      [verifying],
      [settled],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: proof({
            execution: candidateExec,
            finishedAt: T + 2500,
          }),
        }),
      ],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  // A proof insertion without clearing an execution is refused.
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [verifying],
      [
        runtime({
          activeRevision: SHA_B,
          generation: 2,
          execution: null,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [
        hostedRelease({
          phase: "accepted",
          priorProof: priorHealthy,
          candidateProof: unrelated,
        }),
      ],
    ),
    "a newly attached hosted release proof must bind the exact settled execution",
  );
  // Once attached, a release proof is immutable and terminal receipts freeze.
  const accepted = hostedRelease({
    phase: "accepted",
    priorProof: priorHealthy,
    candidateProof: healthyCandidate,
    updatedAt: T + 3000,
  });
  assert.equal(
    validateHostedStateTransition(
      [settled],
      [accepted],
      [settled],
      [
        {
          ...accepted,
          candidateProof: proof({
            execution: candidateExec,
            outcome: "failed",
            startupReady: false,
            baseSha: null,
            terminalAt: null,
          }),
        },
      ],
    ),
    "an existing hosted release proof is immutable",
  );
  assert.equal(
    validateHostedStateTransition(
      [settled],
      [accepted],
      [settled],
      [{ ...accepted, updatedAt: T + 4000 } as HostedReleaseRecordV1],
    ),
    "a terminal hosted release receipt is immutable",
  );
  // A set pointer intent cannot change, and clears only on the exact movement.
  const promoting = hostedRelease({
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
  assert.equal(
    validateHostedStateTransition(
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: priorHealthy,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [promoting],
      [
        runtime({
          activeRevision: SHA_A,
          generation: 1,
          execution: null,
          lastExecutionProof: priorHealthy,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [
        hostedRelease({
          phase: "promoting",
          priorProof: priorHealthy,
          pointerIntent: {
            action: "promote",
            expectedRevision: SHA_A,
            nextRevision: SHA_B,
            expectedGeneration: 1,
            createdAt: T + 1500,
          },
        }),
      ],
    ),
    "a set hosted release pointer intent cannot change",
  );
  // New records start clean and runtimes never disappear or mutate identity.
  assert.equal(
    validateHostedStateTransition(
      [],
      [],
      [],
      [hostedRelease({ phase: "verifying" })],
    ),
    "a new hosted release must start at requested with no proofs or pointer intent",
  );
  assert.equal(
    validateHostedStateTransition(
      [],
      [],
      [],
      [hostedRelease({ phase: "requested", priorProof: null })],
    ),
    null,
  );
  assert.equal(
    validateHostedStateTransition(
      [],
      [],
      [runtime({ generation: 2, execution: null })],
      [],
    ),
    "the first hosted runtime must start at generation 1",
  );
  assert.equal(
    validateHostedStateTransition(
      [],
      [],
      [
        runtime({
          generation: 1,
          execution: null,
          lastHealthyProof: priorHealthy,
        }),
      ],
      [],
    ),
    "the first hosted runtime cannot claim a healthy proof",
  );
  assert.equal(
    validateHostedStateTransition(
      [],
      [],
      [
        runtime({
          generation: 1,
          execution: null,
          lastExecutionProof: priorHealthy,
        }),
      ],
      [],
    ),
    "the first hosted runtime cannot claim historical proof",
  );
  const runtimeRecord = runtime();
  assert.equal(
    validateHostedStateTransition([runtimeRecord], [], [], []),
    "existing hosted runtime cannot disappear",
  );
  assert.equal(
    validateHostedStateTransition(
      [runtimeRecord],
      [],
      [{ ...runtimeRecord, createdAt: runtimeRecord.createdAt + 1 }],
      [],
    ),
    "hosted runtime createdAt is immutable",
  );
  assert.equal(
    validateHostedStateTransition(
      [runtimeRecord],
      [],
      [{ ...runtimeRecord, updatedAt: runtimeRecord.updatedAt - 1 }],
      [],
    ),
    "hosted runtime updatedAt cannot move backward",
  );
  assert.equal(
    validateHostedStateTransition(
      [],
      [hostedRelease({ phase: "requested", priorProof: null })],
      [],
      [],
    ),
    "existing hosted release cannot disappear",
  );
});
