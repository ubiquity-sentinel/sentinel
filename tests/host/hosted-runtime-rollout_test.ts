import assert from "node:assert/strict";
import { cp } from "node:fs/promises";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_RUNTIME_ROLLOUT,
  parseHostedRuntimeRollout,
} from "../../src/host/hosted-runtime-rollout.ts";
import {
  ciCorrectionRuntimeProven,
  HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES,
} from "../../ops/hosted-autonomy-ci-retries.ts";
import {
  ciFirstFixRuntimeProven,
  ciFirstRuntimeProven,
  HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES,
  HOSTED_AUTONOMY_CI_FIRST_RUNTIMES,
} from "../../ops/hosted-autonomy-ci-first.ts";
import {
  HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES,
  refreshFixActivation,
} from "../../ops/hosted-autonomy-refresh-rearm.ts";
import {
  conflictResolutionRuntimeProven,
  HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES,
} from "../../ops/hosted-autonomy-conflict-retries.ts";
import {
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { principalHostFixture } from "./hosted-app-principal-fixtures.ts";
import { readHostedAppSourceEvidence } from "../../src/host/hosted-app-principal-source.ts";
import { verifyHostedAppPrincipalHandoff } from "../../src/host/hosted-app-principal.ts";

const PRIOR = "da98f5f49c45b57cfa97a45fe647c36b1021f302" as GitSha;
const NEXT = "f".repeat(40) as GitSha;
const THIRD = "e".repeat(40) as GitSha;
const rung = {
  fromRevision: PRIOR,
  fromGeneration: 81,
  toRevision: NEXT,
  toGeneration: 82,
  rollbackToPrior: false,
};

function data() {
  return {
    version: 1,
    installs: [{ ...rung }],
    ciCorrection: [NEXT],
    refreshRearm: [{ revision: NEXT, activatedNotBefore: 1 }],
    conflictResolution: [{ revision: NEXT, activatedNotBefore: 1 }],
    ciFirst: [NEXT],
    ciFirstFix: [NEXT],
    acceptanceCorrection: [NEXT],
    legacyReview: [NEXT],
    recoveries: [],
  };
}

function rejected(value: unknown) {
  assert.throws(() => parseHostedRuntimeRollout(value), {
    name: "Error",
    message: "invalid hosted runtime rollout",
  });
}

/** Load the actual defaults in a fresh module graph; only rollout JSON differs. */
async function defaultSourcePins(acceptance: boolean, legacy: boolean) {
  await Deno.mkdir(".sentinel-artifacts", { recursive: true });
  const root = await Deno.makeTempDir({
    dir: ".sentinel-artifacts",
    prefix: "rollout-source-",
  });
  try {
    for (const name of ["src", "ops"]) {
      await cp(new URL(`../../${name}`, import.meta.url), `${root}/${name}`, {
        recursive: true,
      });
    }
    for (const name of ["deno.json", "deno.lock"]) {
      await Deno.copyFile(
        new URL(`../../${name}`, import.meta.url),
        `${root}/${name}`,
      );
    }
    const source = structuredClone(HOSTED_RUNTIME_ROLLOUT);
    await Deno.writeTextFile(
      `${root}/src/host/hosted-runtime-rollout.json`,
      JSON.stringify({
        ...source,
        ciCorrection: [NEXT],
        ciFirst: [NEXT],
        ciFirstFix: [NEXT],
        acceptanceCorrection: acceptance ? [NEXT] : [],
        legacyReview: legacy ? [NEXT] : [],
      }),
    );
    await Deno.writeTextFile(
      `${root}/probe.ts`,
      `import { acceptanceCorrectionRuntimeProven } from "./ops/hosted-autonomy-acceptance.ts";
import type { HostedRuntimeRecordV1 } from "./src/contracts/hosted-supervisor.ts";
import { legacyReviewCutoffForExecution } from "./src/host/legacy-review-cutoff-env.ts";
import { LEGACY_REVIEW_CUTOFF, legacyReviewCutoffFor } from "./src/repair/review-round-cap.ts";
const revision = ${JSON.stringify(NEXT)};
const cutoff = LEGACY_REVIEW_CUTOFF.activatedNotBefore!;
const runtime = { activeRevision: revision, generation: 82, lastHealthyProof: {
  outcome: "healthy", settled: true, startupReady: true,
  execution: { revision, generation: 82, createdAt: cutoff + 1 },
} } as HostedRuntimeRecordV1;
const health = runtime.lastHealthyProof!;
console.log(JSON.stringify({
  acceptance: acceptanceCorrectionRuntimeProven(runtime),
  missingHealth: acceptanceCorrectionRuntimeProven({ ...runtime, lastHealthyProof: null }),
  wrongGeneration: acceptanceCorrectionRuntimeProven({ ...runtime, generation: 81 }),
  foreignHealth: acceptanceCorrectionRuntimeProven({ ...runtime, lastHealthyProof: {
    ...health, execution: { ...health.execution, revision: ${
        JSON.stringify(PRIOR)
      } },
  } }),
  cutoff: legacyReviewCutoffForExecution({ revision, createdAt: cutoff + 1 }),
  early: legacyReviewCutoffForExecution({ revision, createdAt: cutoff - 1 }),
  contradiction: legacyReviewCutoffFor(revision, [{
    revision: "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481", createdAt: cutoff - 1,
  }]),
}));
`,
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--cached-only", "--frozen", "--allow-read=.", "probe.ts"],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(30_000),
    }).output();
    assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
    return JSON.parse(new TextDecoder().decode(result.stdout));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("runtime rollout: default acceptance correction follows only its source JSON list", async (t) => {
  for (
    const [acceptance, legacy] of [
      [true, false],
      [false, true],
      [false, false],
      [true, true],
    ]
  ) {
    await t.step(`${acceptance}/${legacy}`, async () => {
      const actual = await defaultSourcePins(acceptance, legacy);
      assert.equal(actual.acceptance, acceptance);
      assert.equal(actual.missingHealth, false);
      assert.equal(actual.wrongGeneration, false);
      assert.equal(actual.foreignHealth, false);
    });
  }
});

Deno.test("runtime rollout: default legacy cutoff follows only its source JSON list", async (t) => {
  for (
    const [acceptance, legacy] of [
      [false, true],
      [true, false],
      [false, false],
      [true, true],
    ]
  ) {
    await t.step(`${acceptance}/${legacy}`, async () => {
      const actual = await defaultSourcePins(acceptance, legacy);
      assert.equal(actual.cutoff, legacy ? 1792256700000 : null);
      assert.equal(actual.early, null);
      assert.equal(actual.contradiction, null);
    });
  }
});

Deno.test("runtime rollout: authenticated future pin data preserves the frozen principal code profile", async () => {
  const rig = await principalHostFixture();
  try {
    const path = "src/host/hosted-runtime-rollout.json";
    const original = JSON.parse(
      await Deno.readTextFile(`${rig.launcher}/${path}`),
    );
    const handoff = {
      ...rig.hostInput,
      state: { readRelease: rig.state.readRelease.bind(rig.state) },
    };
    assert.equal(
      await verifyHostedAppPrincipalHandoff(handoff, rig.profiles),
      true,
    );
    for (const field of ["acceptanceCorrection", "legacyReview"] as const) {
      await rig.write(
        rig.launcher,
        path,
        JSON.stringify({ ...original, [field]: [NEXT] }),
      );
      await rig.commitLauncher();
      const source = await readHostedAppSourceEvidence(
        rig.source,
        rig.profiles,
      );
      assert.ok(source, "the new data retains native source proof");
      assert.equal(source.codeSha256, rig.profiles[0].codeSha256);
      assert.equal(
        await verifyHostedAppPrincipalHandoff(handoff, rig.profiles),
        true,
      );
    }
    assert.equal(rig.state.repairWrites, 0);
  } finally {
    await rig.close();
  }
});

const dormant = {
  version: 1,
  installs: [],
  ciCorrection: [],
  refreshRearm: [],
  conflictResolution: [],
  ciFirst: [],
  ciFirstFix: [],
  acceptanceCorrection: [],
  legacyReview: [],
  recoveries: [],
  ownerSupersessions: [],
  ownerSuccessorTaskBindings: [],
};

Deno.test("runtime rollout: explicit dormant source has no maintenance or install grants", () => {
  assert.deepEqual(parseHostedRuntimeRollout(dormant), dormant);
});

Deno.test("runtime rollout: committed source preserves historical lists and exact owner installs", () => {
  if (HOSTED_RUNTIME_ROLLOUT.ownerSupersessions.length === 0) {
    assert.deepEqual(HOSTED_RUNTIME_ROLLOUT, dormant);
  } else {
    for (const row of HOSTED_RUNTIME_ROLLOUT.ownerSupersessions) {
      assert.ok(
        HOSTED_RUNTIME_ROLLOUT.installs.some((install) =>
          install.fromRevision === row.fromRevision &&
          install.fromGeneration === row.fromGeneration &&
          install.toRevision === row.toRevision &&
          install.toGeneration === row.toGeneration &&
          install.rollbackToPrior === false
        ),
      );
    }
  }
  for (
    const rows of [
      HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES,
      HOSTED_AUTONOMY_CI_FIRST_RUNTIMES,
      HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES,
      new Set(HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES.map((r) => r.revision)),
      new Set(
        HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES.map((r) => r.revision),
      ),
    ]
  ) {
    assert.equal(rows.has(PRIOR), true);
    assert.equal(rows.has(NEXT), false);
  }
  assert.ok(Object.isFrozen(HOSTED_RUNTIME_ROLLOUT));
  for (const value of Object.values(HOSTED_RUNTIME_ROLLOUT)) {
    if (Array.isArray(value)) assert.ok(Object.isFrozen(value));
  }
});

Deno.test("runtime rollout: malformed source cannot add a pin or an install", () => {
  for (const value of [null, [], {}, 1, "source", { ...data(), extra: true }]) {
    rejected(value);
  }
  for (const field of Object.keys(data())) {
    const missing: Record<string, unknown> = data();
    delete missing[field];
    rejected(missing);
  }
  for (const version of [0, "1", 2, undefined]) {
    rejected({ ...data(), version });
  }
  for (
    const key of [
      "ciCorrection",
      "ciFirst",
      "ciFirstFix",
      "acceptanceCorrection",
      "legacyReview",
    ] as const
  ) {
    for (
      const pins of [
        null,
        NEXT,
        ["*"],
        [NEXT.slice(1)],
        [NEXT.toUpperCase()],
        [NEXT, NEXT],
        Array(1),
        Object.assign([NEXT], { extra: true }),
        Array.from(
          { length: 1025 },
          (_, i) => i.toString(16).padStart(40, "0"),
        ),
      ]
    ) rejected({ ...data(), [key]: pins });
  }
  for (const key of ["refreshRearm", "conflictResolution"] as const) {
    for (
      const row of [
        null,
        {},
        { revision: "*", activatedNotBefore: 1 },
        { revision: NEXT, activatedNotBefore: 0 },
        { revision: NEXT, activatedNotBefore: 1.5 },
        { revision: NEXT, activatedNotBefore: "1" },
        { revision: NEXT, activatedNotBefore: Number.MAX_SAFE_INTEGER + 1 },
        { revision: NEXT, activatedNotBefore: 1, extra: true },
      ]
    ) rejected({ ...data(), [key]: [row] });
    rejected({ ...data(), [key]: [data()[key][0], data()[key][0]] });
  }
  rejected({
    ...data(),
    conflictResolution: [{ revision: NEXT, activatedNotBefore: 2 }],
  });
  for (
    const row of [
      null,
      {},
      { ...rung, extra: true },
      { ...rung, fromRevision: "*" },
      { ...rung, toRevision: PRIOR },
      { ...rung, fromGeneration: 0 },
      { ...rung, fromGeneration: 81.5 },
      { ...rung, toGeneration: "82" },
      { ...rung, toGeneration: 83 },
      { ...rung, rollbackToPrior: "false" },
      {
        ...rung,
        fromGeneration: Number.MAX_SAFE_INTEGER - 1,
        toGeneration: Number.MAX_SAFE_INTEGER,
      },
    ]
  ) rejected({ ...data(), installs: [row] });
  for (
    const second of [
      rung,
      { ...rung, toRevision: THIRD },
      { ...rung, fromRevision: THIRD },
      { ...rung, fromGeneration: 83, toGeneration: 84 },
      {
        ...rung,
        fromRevision: THIRD,
        fromGeneration: 82,
        toRevision: PRIOR,
        toGeneration: 83,
      },
    ]
  ) rejected({ ...data(), installs: [rung, second] });
});

Deno.test("runtime rollout: copied future data reaches maintenance gates only with exact own health", () => {
  const input = data();
  const parsed = parseHostedRuntimeRollout(input);
  input.installs[0].rollbackToPrior = true;
  input.refreshRearm[0].activatedNotBefore = 2;
  input.ciFirst.push(PRIOR);
  input.acceptanceCorrection.push(PRIOR);
  input.legacyReview.push(PRIOR);
  assert.equal(parsed.installs[0].rollbackToPrior, false);
  assert.equal(parsed.refreshRearm[0].activatedNotBefore, 1);
  assert.deepEqual(parsed.ciFirst, [NEXT]);
  assert.deepEqual(parsed.acceptanceCorrection, [NEXT]);
  assert.deepEqual(parsed.legacyReview, [NEXT]);
  assert.ok(Object.isFrozen(parsed.acceptanceCorrection));
  assert.ok(Object.isFrozen(parsed.legacyReview));
  assert.ok(Object.isFrozen(parsed.installs[0]));
  assert.ok(Object.isFrozen(parsed.refreshRearm[0]));
  const proof = healthyProof(NEXT, 82, 501);
  const runtime = runtimeRecord({
    revision: NEXT,
    generation: 82,
    healthyProof: proof,
    executionProof: proof,
  });
  const ci = new Set(parsed.ciCorrection);
  const first = new Set(parsed.ciFirst);
  const fix = new Set(parsed.ciFirstFix);
  assert.equal(ciCorrectionRuntimeProven(runtime), false);
  assert.equal(ciCorrectionRuntimeProven(runtime, ci), true);
  assert.equal(ciFirstRuntimeProven(runtime, first), true);
  assert.equal(ciFirstFixRuntimeProven(runtime, fix, first), true);
  assert.equal(
    conflictResolutionRuntimeProven(runtime, parsed.conflictResolution),
    true,
  );
  assert.equal(
    refreshFixActivation(releaseSnapshot({ runtime }), parsed.refreshRearm),
    1,
  );
  const wrong = { ...runtime, lastHealthyProof: healthyProof(PRIOR, 81, 501) };
  assert.equal(ciCorrectionRuntimeProven(wrong, ci), false);
  assert.equal(ciFirstRuntimeProven(wrong, first), false);
  assert.equal(ciFirstFixRuntimeProven(wrong, fix, first), false);
  assert.equal(
    conflictResolutionRuntimeProven(wrong, parsed.conflictResolution),
    false,
  );
  assert.equal(
    refreshFixActivation(releaseSnapshot({ runtime }), [{
      revision: NEXT,
      activatedNotBefore: proof.execution.createdAt + 1,
    }]),
    null,
  );
});

Deno.test("runtime rollout recoveries: exact required rows are bounded unique copied and frozen", () => {
  const row = {
    fromRevision: NEXT,
    fromGeneration: 82,
    toRevision: THIRD,
    toGeneration: 83,
    failedProofSha256: "a".repeat(64),
    retainedHealthyProofSha256: "b".repeat(64),
    healthyWitnessHead: PRIOR,
  };
  const source = { ...data(), recoveries: [{ ...row }] };
  const parsed = parseHostedRuntimeRollout(source);
  source.recoveries[0].toGeneration = 85;
  assert.deepEqual(parsed.recoveries, [row]);
  assert.equal(Object.isFrozen(parsed.recoveries), true);
  assert.equal(Object.isFrozen(parsed.recoveries[0]), true);
  for (const field of Object.keys(row)) {
    const missing: Record<string, unknown> = { ...row };
    delete missing[field];
    rejected({ ...data(), recoveries: [missing] });
  }
  for (
    const bad of [
      null,
      {},
      { ...row, extra: true },
      { ...row, fromRevision: "*" },
      { ...row, toRevision: NEXT },
      { ...row, fromGeneration: 0 },
      { ...row, fromGeneration: 82.5 },
      { ...row, toGeneration: 84 },
      { ...row, toGeneration: "83" },
      { ...row, healthyWitnessHead: "*" },
      { ...row, failedProofSha256: "a".repeat(63) },
      { ...row, failedProofSha256: "A".repeat(64) },
      { ...row, retainedHealthyProofSha256: "*" },
      Object.defineProperty({ ...row }, "toRevision", { get: () => THIRD }),
    ]
  ) {
    rejected({ ...data(), recoveries: [bad] });
  }
  for (
    const rows of [
      null,
      row,
      Array(1),
      [row, row],
      [row, { ...row, toRevision: PRIOR, failedProofSha256: "c".repeat(64) }],
      [row, { ...row, fromRevision: PRIOR }],
      Object.assign([row], { extra: true }),
      Array.from({ length: 1025 }, () => row),
    ]
  ) {
    rejected({ ...data(), recoveries: rows });
  }
});
