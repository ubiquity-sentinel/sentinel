import {
  HOSTED_CONTROLLER_PROFILES,
  type HostedControllerProfileV1,
  verifyDeploymentTargetScopeV1,
} from "../../src/contracts/hosted-controller-deployment.ts";
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  PRIVATE_TARGET_REASON,
  PUBLIC_TARGET_REASON,
  type TargetVisibilityV1,
} from "../../src/repair/target-visibility.ts";
import { createPrivateTargetGateV1 } from "../../ops/hosted-autonomy-private-targets.ts";

const repo = (owner: string, name: string) => ({
  owner,
  name,
  installationId: owner === "ubiquity-sentinel" ? 0 : 7,
});
const PUBLIC = repo("ubiquity", "ai.ubq.fi");
const PRIVATE = repo("ubiquity", "prospector");
const UNSTATED = repo("ubiquity", "unstated");
const SELF = repo("ubiquity-sentinel", "sentinel");
const ANSWERS: Record<string, TargetVisibilityV1> = {
  "ai.ubq.fi": "public",
  prospector: "private",
};
const HEAD = "a".repeat(40) as GitSha;

function snapshot(): RepairStateSnapshotV1 {
  return {
    version: 1,
    kind: "repair",
    stateHead: null,
    sequence: 1,
    updatedAt: 0,
    incidents: [],
    evidence: [],
    work: [PUBLIC, PRIVATE, UNSTATED, SELF].map((repository) => ({
      id: `work-${repository.name}`,
      repository,
    })),
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  } as unknown as RepairStateSnapshotV1;
}

const store = {
  readRepair: () =>
    Promise.resolve(
      portOk({ status: "found" as const, snapshot: snapshot(), head: HEAD }),
    ),
  readRelease: () => Promise.reject(new Error("unused")),
  writeRepair: () => Promise.reject(new Error("unused")),
};

async function run(profile: HostedControllerProfileV1) {
  const reads: string[] = [];
  const gate = createPrivateTargetGateV1({
    validateView: () => {},
    readVisibility: (repository) => {
      reads.push(repository.name);
      return Promise.resolve(ANSWERS[repository.name] ?? "unknown");
    },
    profile,
  });
  const read = await gate.wrapState(
    store as unknown as Parameters<typeof gate.wrapState>[0],
  ).readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const surfaces = gate.githubFor((repository) => repository.name);
  return {
    visible: read.value.snapshot.work.map((row) => row.repository.name),
    surfaces: [PUBLIC, PRIVATE, UNSTATED, SELF].map(surfaces),
    reads: reads.sort(),
    line: gate.line(),
  };
}

const [publicProfile, privateProfile] = HOSTED_CONTROLLER_PROFILES;

Deno.test("private host gate: the confirmed private profile shows only private foreign rows and surfaces", async () => {
  const gated = await run(
    await verifyDeploymentTargetScopeV1(
      privateProfile,
      false,
      () => Promise.resolve("private"),
    ),
  );
  assert.deepEqual(gated.visible, ["prospector", "sentinel"]);
  assert.deepEqual(gated.surfaces, [null, "prospector", null, "sentinel"]);
  assert.deepEqual(gated.reads, ["ai.ubq.fi", "prospector", "unstated"]);
  assert.deepEqual(gated.line, {
    kind: "sentinel_private_targets_hidden",
    reason: PUBLIC_TARGET_REASON,
    repositories: 2,
    rows: 2,
    refusedWrites: 0,
    invalidViews: 0,
  });
});

Deno.test("public host gate: unavailable visibility cannot widen the public target class", async () => {
  const expected = await run(publicProfile);
  assert.deepEqual(expected.visible, ["ai.ubq.fi", "sentinel"]);
  assert.equal(expected.line?.reason, PRIVATE_TARGET_REASON);
  for (const listed of [true, false]) {
    const gated = await run(
      await verifyDeploymentTargetScopeV1(
        publicProfile,
        listed,
        () => Promise.reject(new Error("503")),
      ),
    );
    assert.deepEqual(gated, expected);
  }
});
