import assert from "node:assert/strict";
import {
  HOSTED_CUSTODY_CAPABILITY,
  parseHostedCustodyCapability,
} from "../../src/host/hosted-custody-capability.ts";
import { EXISTING_PR_RUNTIME_CAPABILITY } from "../../src/host/existing-pr-runtime-capability.ts";
import { EXISTING_PR_TAKEOVER_POLICY } from "../../src/github/existing-pr-takeover-policy.ts";
import { QUEUE_RUNTIME_CAPABILITY } from "../../src/host/queue-runtime-capability.ts";
import {
  QUEUE_PROOF_ACTIVATED,
  resolveQueueRuntimeConfiguration,
} from "../../src/github/queue-runtime-policy.ts";
import {
  allowsHostedOwnerInstallMove,
  allowsHostedRuntime,
  allowsHostedRuntimeMove,
} from "../../src/host/hosted-runtime-compatibility.ts";
import { runHostedSupervisorPrepare } from "../../src/host/actions-supervisor.ts";
import {
  CANDIDATE,
  LAUNCHER,
  makeRig,
  run,
} from "./actions-supervisor-fixture.ts";
import { healthyProof } from "./owner-install-fixture-proofs.ts";
import { HOSTED_RUNTIME_ROLLOUT } from "../../src/host/hosted-runtime-rollout.ts";
import type { GitSha } from "../../src/contracts/brands.ts";

const dormant = {
  version: 1,
  takeover: { activated: false },
  queue: { proofActivated: false, revisions: [], ownerInstallMigrations: [] },
  existingPr: {
    custodyActivated: false,
    revisions: [],
    ownerInstallMigrations: [],
  },
};

const migration = {
  fromRevision: LAUNCHER,
  fromGeneration: 1,
  toRevision: CANDIDATE,
  toGeneration: 2,
};

function data() {
  return {
    version: 1,
    takeover: { activated: false },
    queue: {
      proofActivated: true,
      revisions: [CANDIDATE],
      ownerInstallMigrations: [{ ...migration }],
    },
    existingPr: {
      custodyActivated: true,
      revisions: [CANDIDATE],
      ownerInstallMigrations: [{ ...migration }],
    },
  };
}

function rejected(value: unknown) {
  assert.throws(() => parseHostedCustodyCapability(value), {
    name: "Error",
    message: "invalid hosted custody capability",
  });
}

Deno.test("hosted custody data: explicit dormant fixture permits the legacy runtime", () => {
  const parsed = parseHostedCustodyCapability(dormant);
  assert.deepEqual(parsed, dormant);
  assert.equal(
    allowsHostedRuntime(LAUNCHER, parsed.queue, parsed.existingPr),
    true,
  );
});

Deno.test("hosted custody data: all production consumers share exact frozen source and owner floors", () => {
  assert.equal(EXISTING_PR_TAKEOVER_POLICY, HOSTED_CUSTODY_CAPABILITY.takeover);
  assert.ok(Object.isFrozen(HOSTED_CUSTODY_CAPABILITY.takeover));
  assert.equal(QUEUE_RUNTIME_CAPABILITY, HOSTED_CUSTODY_CAPABILITY.queue);
  assert.equal(
    EXISTING_PR_RUNTIME_CAPABILITY,
    HOSTED_CUSTODY_CAPABILITY.existingPr,
  );
  assert.equal(QUEUE_PROOF_ACTIVATED, QUEUE_RUNTIME_CAPABILITY.proofActivated);
  assert.equal(
    resolveQueueRuntimeConfiguration("required").proofActivated,
    QUEUE_RUNTIME_CAPABILITY.proofActivated,
  );
  if (
    !QUEUE_RUNTIME_CAPABILITY.proofActivated &&
    !EXISTING_PR_RUNTIME_CAPABILITY.custodyActivated
  ) {
    assert.deepEqual(HOSTED_CUSTODY_CAPABILITY, dormant);
    assert.equal(HOSTED_RUNTIME_ROLLOUT.ownerSupersessions.length, 0);
    assert.equal(allowsHostedRuntime(LAUNCHER), true);
  } else {
    assert.equal(QUEUE_RUNTIME_CAPABILITY.proofActivated, true);
    assert.equal(EXISTING_PR_RUNTIME_CAPABILITY.custodyActivated, true);
    assert.ok(HOSTED_RUNTIME_ROLLOUT.ownerSupersessions.length > 0);
    for (
      const legacy of [
        "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481",
        "da98f5f49c45b57cfa97a45fe647c36b1021f302",
      ] as GitSha[]
    ) {
      assert.equal(allowsHostedRuntime(legacy), false);
    }
    for (const row of HOSTED_RUNTIME_ROLLOUT.ownerSupersessions) {
      assert.equal(allowsHostedRuntime(row.toRevision), true);
      const migration = {
        fromRevision: row.fromRevision,
        fromGeneration: row.fromGeneration,
        toRevision: row.toRevision,
        toGeneration: row.toGeneration,
      };
      for (
        const floor of [
          QUEUE_RUNTIME_CAPABILITY,
          EXISTING_PR_RUNTIME_CAPABILITY,
        ]
      ) {
        assert.ok(floor.revisions.includes(row.toRevision));
        assert.deepEqual(
          floor.ownerInstallMigrations?.filter((m) =>
            m.fromRevision === row.fromRevision &&
            m.fromGeneration === row.fromGeneration
          ),
          [migration],
        );
      }
      const move = {
        action: "install" as const,
        priorRevision: row.fromRevision,
        priorGeneration: row.fromGeneration,
        nextRevision: row.toRevision,
        nextGeneration: row.toGeneration,
        priorHealthyProof: healthyProof(row.fromRevision, row.fromGeneration),
      };
      assert.equal(allowsHostedOwnerInstallMove(move), true);
      assert.equal(
        allowsHostedRuntimeMove(row.fromRevision, row.toRevision),
        false,
      );
      assert.equal(
        allowsHostedOwnerInstallMove({
          ...move,
          nextGeneration: row.toGeneration + 1,
        }),
        false,
      );
      assert.equal(
        allowsHostedOwnerInstallMove({
          ...move,
          action: "rollback",
          priorRevision: row.toRevision,
          priorGeneration: row.toGeneration,
          nextRevision: row.fromRevision,
          nextGeneration: row.toGeneration + 1,
        }),
        false,
      );
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
  assert.ok(Object.isFrozen(HOSTED_CUSTODY_CAPABILITY));
  for (
    const policy of [
      HOSTED_CUSTODY_CAPABILITY.queue,
      HOSTED_CUSTODY_CAPABILITY.existingPr,
    ]
  ) {
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.revisions));
    assert.ok(Object.isFrozen(policy.ownerInstallMigrations));
  }
});

Deno.test("hosted custody data: malformed shape never reaches runtime policy", () => {
  for (const value of [null, false, 1, "secret input", [], {}, data().queue]) {
    rejected(value);
  }
  for (const version of [undefined, null, "1", 0, 2]) {
    rejected({ ...data(), version });
  }
  rejected({ ...data(), unexpected: true });
  rejected(Object.assign(Object.create({ inherited: true }), data()));
  rejected({ ...data(), [Symbol("extra")]: true });
  const { takeover: _, ...missingTakeover } = data();
  rejected(missingTakeover);
  for (const takeover of [null, [], {}, { activated: true, extra: true }]) {
    rejected({ ...data(), takeover });
  }
  for (const activated of [undefined, null, 0, "true"]) {
    rejected({ ...data(), takeover: { activated } });
  }
  for (const key of ["queue", "existingPr"] as const) {
    const base = data();
    const flag = key === "queue" ? "proofActivated" : "custodyActivated";
    for (const value of [null, [], {}, { ...base[key], extra: true }]) {
      rejected({ ...base, [key]: value });
    }
    for (const value of [undefined, null, 0, "false"]) {
      rejected({ ...base, [key]: { ...base[key], [flag]: value } });
    }
    for (const field of [flag, "revisions", "ownerInstallMigrations"]) {
      const missing: Record<string, unknown> = { ...base[key] };
      delete missing[field];
      rejected({ ...base, [key]: missing });
    }
    for (
      const revisions of [
        null,
        CANDIDATE,
        [null],
        ["*"],
        [CANDIDATE.slice(0, 39)],
        ["A".repeat(40)],
        [CANDIDATE, CANDIDATE],
        Array(1),
        Object.assign([CANDIDATE], { extra: true }),
        Array.from(
          { length: 1025 },
          (_, i) => i.toString(16).padStart(40, "0"),
        ),
      ]
    ) rejected({ ...base, [key]: { ...base[key], revisions } });
  }
  let getterCalls = 0;
  const accessor = data();
  Object.defineProperty(accessor.queue, "proofActivated", {
    get() {
      getterCalls++;
      throw new Error("secret input");
    },
  });
  rejected(accessor);
  assert.equal(getterCalls, 0);
});

Deno.test("hosted custody data: disabling adoption never relaxes the retained custody floor", () => {
  const source = data();
  source.queue.proofActivated = false;
  const parsed = parseHostedCustodyCapability(source);
  assert.equal(parsed.takeover.activated, false);
  assert.equal(parsed.existingPr.custodyActivated, true);
  assert.equal(
    allowsHostedRuntime(CANDIDATE, parsed.queue, parsed.existingPr),
    true,
  );
  assert.equal(
    allowsHostedRuntime(LAUNCHER, parsed.queue, parsed.existingPr),
    false,
  );
  source.takeover.activated = true;
  assert.equal(
    parsed.takeover.activated,
    false,
    "parsed admission is copied and frozen",
  );
  assert.ok(Object.isFrozen(parsed.takeover));
  const activated = parseHostedCustodyCapability(source);
  assert.deepEqual(activated.existingPr, parsed.existingPr);
  assert.deepEqual(activated.queue, parsed.queue);
});

Deno.test("hosted custody data: migration pins require distinct exact revisions and safe increment", () => {
  const invalidRows = [
    null,
    [],
    {},
    { ...migration, unexpected: true },
    { ...migration, fromRevision: "*" },
    { ...migration, toRevision: LAUNCHER },
    { ...migration, toRevision: `${CANDIDATE}0` },
    { ...migration, fromGeneration: 0 },
    { ...migration, fromGeneration: -1 },
    { ...migration, fromGeneration: 1.5 },
    { ...migration, fromGeneration: "1" },
    { ...migration, fromGeneration: NaN },
    { ...migration, fromGeneration: Infinity },
    { ...migration, toGeneration: 1 },
    { ...migration, toGeneration: 3 },
    { ...migration, toGeneration: "2" },
    {
      ...migration,
      fromGeneration: Number.MAX_SAFE_INTEGER,
      toGeneration: Number.MAX_SAFE_INTEGER + 1,
    },
  ];
  for (const key of ["queue", "existingPr"] as const) {
    const base = data();
    for (
      const ownerInstallMigrations of [
        null,
        {},
        [migration, migration],
        Array(1),
        Array.from({ length: 1025 }, (_, i) => ({
          ...migration,
          fromGeneration: i + 1,
          toGeneration: i + 2,
        })),
        ...invalidRows.map((row) => [row]),
      ]
    ) {
      rejected({ ...base, [key]: { ...base[key], ownerInstallMigrations } });
    }
  }
  const boundary = data();
  boundary.queue.revisions = Array.from(
    { length: 1024 },
    (_, i) => i.toString(16).padStart(40, "0") as typeof CANDIDATE,
  );
  boundary.queue.ownerInstallMigrations = [{
    ...migration,
    fromGeneration: Number.MAX_SAFE_INTEGER - 1,
    toGeneration: Number.MAX_SAFE_INTEGER,
  }];
  assert.equal(
    parseHostedCustodyCapability(boundary).queue.revisions.length,
    1024,
  );
});

Deno.test("hosted custody data: parsed migrations cannot authorize old execution or rollback", () => {
  const source = data();
  const parsed = parseHostedCustodyCapability(source);
  source.queue.proofActivated = false;
  source.existingPr.revisions.push(LAUNCHER);
  source.existingPr.ownerInstallMigrations[0].toGeneration = 3;
  assert.equal(parsed.queue.proofActivated, true);
  assert.deepEqual(parsed.existingPr.revisions, [CANDIDATE]);
  assert.deepEqual(parsed.existingPr.ownerInstallMigrations, [migration]);
  assert.ok(Object.isFrozen(parsed.existingPr.ownerInstallMigrations?.[0]));
  const { queue, existingPr } = parsed;
  assert.equal(allowsHostedRuntime(CANDIDATE, queue, existingPr), true);
  assert.equal(allowsHostedRuntime(LAUNCHER, queue, existingPr), false);
  assert.equal(
    allowsHostedRuntimeMove(LAUNCHER, CANDIDATE, queue, existingPr),
    false,
  );
  const move = {
    action: "install" as const,
    priorRevision: LAUNCHER,
    priorGeneration: 1,
    nextRevision: CANDIDATE,
    nextGeneration: 2,
    priorHealthyProof: healthyProof(LAUNCHER, 1, 501),
  };
  assert.equal(allowsHostedOwnerInstallMove(move, queue, existingPr), true);
  assert.equal(
    allowsHostedOwnerInstallMove(
      { ...move, action: "rollback" },
      queue,
      existingPr,
    ),
    false,
  );
});

Deno.test("hosted custody data: parsed independent floors reach real supervisor before writes", async (t) => {
  for (const floor of ["queue", "existingPr"] as const) {
    await t.step(floor, async () => {
      const source = data();
      source.queue.proofActivated = floor === "queue";
      source.existingPr.custodyActivated = floor === "existingPr";
      const parsed = parseHostedCustodyCapability(source);
      const rig = await makeRig();
      try {
        rig.evidence.revisions.add(LAUNCHER);
        const before = await rig.release.readRelease();
        const outcome = await runHostedSupervisorPrepare({
          clock: rig.clock,
          state: rig.release,
          run: run(1),
          evidence: rig.evidence,
          queueRuntimeCapability: parsed.queue,
          existingPrRuntimeCapability: parsed.existingPr,
        });
        assert.equal(outcome.status, "pending");
        assert.deepEqual(await rig.release.readRelease(), before);
      } finally {
        await rig.cleanup();
      }
    });
  }
});
