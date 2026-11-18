/**
 * The launcher gate under the deployment rule (`target-visibility.ts`): a
 * host proven private shows its private repositories' rows and surfaces and
 * hides public and unknown ones; a host that lists itself, a host that is
 * public, unknown or unreadable, and no host at all are the public-only gate,
 * read for read and row for row.
 */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  PRIVATE_TARGET_REASON,
  PUBLIC_TARGET_REASON,
  resolveSentinelHostV1,
  type SentinelHostV1,
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

async function run(host?: () => Promise<SentinelHostV1>) {
  const reads: string[] = [];
  const gate = createPrivateTargetGateV1({
    validateView: () => {},
    readVisibility: (repository) => {
      reads.push(repository.name);
      return Promise.resolve(ANSWERS[repository.name] ?? "unknown");
    },
    ...(host === undefined ? {} : { host }),
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

const hostOf = (
  listed: readonly string[],
  answer: TargetVisibilityV1 | Error,
  hostReads: string[],
) =>
() =>
  resolveSentinelHostV1({
    repository: "ubiquity-sentinel/sentinel",
    listed,
    readVisibility: () => {
      hostReads.push("host");
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  });

Deno.test("private host gate: a host proven private shows private rows and surfaces, hides public and unknown ones", async () => {
  const hostReads: string[] = [];
  const gated = await run(
    hostOf(["ubiquity/prospector"], "private", hostReads),
  );
  assert.deepEqual(hostReads, ["host"], "one host read per run");
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

Deno.test("private host gate: a self-listed, public, unknown or unreadable host is the public-only gate", async () => {
  const baseline = await run();
  assert.deepEqual(baseline.visible, ["ai.ubq.fi", "sentinel"]);
  assert.equal(baseline.line?.reason, PRIVATE_TARGET_REASON);
  for (
    const [name, listed, answer, expectedHostReads] of [
      [
        "self-listed, answered private",
        ["ubiquity-sentinel/sentinel"],
        "private",
        0,
      ],
      ["public", [], "public", 1],
      ["unknown", [], "unknown", 1],
      ["unreadable", [], new Error("503"), 1],
    ] as const
  ) {
    const hostReads: string[] = [];
    const gated = await run(hostOf(listed, answer, hostReads));
    assert.equal(hostReads.length, expectedHostReads, name);
    assert.deepEqual(gated, baseline, name);
  }
  // A host decision that throws is no host at all.
  assert.deepEqual(
    await run(() => Promise.reject(new Error("no setting"))),
    baseline,
  );
});
