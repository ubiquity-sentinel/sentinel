import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import {
  BASE_FETCH,
  BASE_FETCH_GENERATION,
  NOW,
  REVIEW_MODEL,
  REVIEW_MODEL_GENERATION,
  SUCCESSOR_GENERATION,
  SUCCESSOR_REVISION,
} from "./owner-install-fixture-constants.ts";
import {
  cooldown,
  executionIntent,
  healthyProof,
  releaseSnapshot,
  requestedRelease,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";

export function assertReviewModelStart() {
  const baseFetchHealthy = healthyProof(BASE_FETCH, 36, 141);
  // The fixed owner-approved pin: only the recorded generation 36 healthy
  // proof authorizes exactly one move to the review model revision.
  const install = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: BASE_FETCH,
        generation: BASE_FETCH_GENERATION,
        healthyProof: baseFetchHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(install.status, "install");
  if (install.status !== "install") throw new Error("expected install");
  assert.equal(install.move.action, "install");
  assert.equal(install.move.priorRevision, BASE_FETCH);
  assert.equal(install.move.priorGeneration, BASE_FETCH_GENERATION);
  assert.equal(install.move.nextRevision, REVIEW_MODEL);
  assert.equal(install.move.nextGeneration, REVIEW_MODEL_GENERATION);
  assert.equal(install.move.nextGeneration, install.move.priorGeneration + 1);
  assert.equal(
    canonicalStringify(install.move.priorHealthyProof),
    canonicalStringify(baseFetchHealthy),
  );

  // A healthy proof bound to another revision or generation, and no
  // recorded proof at all, never authorize the fixed pin.
  for (
    const healthy of [
      healthyProof(REVIEW_MODEL, 36, 142),
      healthyProof(BASE_FETCH, 37, 143),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: BASE_FETCH,
            generation: BASE_FETCH_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }

  // An in-flight execution, a non-terminal release and an active cooldown
  // each keep the pin a zero-write wait.
  assert.equal(
    planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: baseFetchHealthy,
          execution: executionIntent(BASE_FETCH, BASE_FETCH_GENERATION),
        }),
      }),
      NOW,
    ).status,
    "waiting",
  );
  assert.equal(
    planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: baseFetchHealthy,
        }),
        hostedReleases: [requestedRelease()],
      }),
      NOW,
    ).status,
    "waiting",
  );
  assert.equal(
    planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: baseFetchHealthy,
        }),
        cooldowns: [cooldown(NOW + 1)],
      }),
      NOW,
    ).status,
    "waiting",
  );

  // The review model generation 37 healthy proof authorizes exactly one
  // move to the fixed owner-approved successor runtime revision.
  const reviewModelHealthy = healthyProof(REVIEW_MODEL, 37, 144);
  const successorInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_MODEL,
        generation: REVIEW_MODEL_GENERATION,
        healthyProof: reviewModelHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(successorInstall.status, "install");
  if (successorInstall.status !== "install") {
    throw new Error("expected successor install");
  }
  assert.equal(successorInstall.move.action, "install");
  assert.equal(successorInstall.move.priorRevision, REVIEW_MODEL);
  assert.equal(
    successorInstall.move.priorGeneration,
    REVIEW_MODEL_GENERATION,
  );
  assert.equal(successorInstall.move.nextRevision, SUCCESSOR_REVISION);
  assert.equal(successorInstall.move.nextGeneration, SUCCESSOR_GENERATION);
  assert.equal(
    successorInstall.move.nextGeneration,
    successorInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(successorInstall.move.priorHealthyProof),
    canonicalStringify(reviewModelHealthy),
  );

  // A healthy proof bound to another revision or generation, and no
  // recorded proof at all, never authorize the successor pin.
  for (
    const healthy of [
      baseFetchHealthy,
      healthyProof(SUCCESSOR_REVISION, 37, 149),
      healthyProof(REVIEW_MODEL, 38, 150),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REVIEW_MODEL,
            generation: REVIEW_MODEL_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }

  // An in-flight execution of the authorized successor install stays a
  // zero-write wait.
  assert.equal(
    planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_MODEL,
          generation: REVIEW_MODEL_GENERATION,
          healthyProof: reviewModelHealthy,
          execution: executionIntent(REVIEW_MODEL, REVIEW_MODEL_GENERATION),
        }),
      }),
      NOW,
    ).status,
    "waiting",
  );

  // The installed successor generation 38 pointer is stable only with its
  // own bound healthy proof, and that exact proof authorizes exactly one
  // move to the fixed owner-approved successor runtime revision.
  return { baseFetchHealthy, install, reviewModelHealthy, successorInstall };
}
