/**
 * Owner decision 2026-11-18 ("no private repos"), the launcher half: a full
 * `runHostedAutonomy` run through the private-target gate, over the real
 * temp-Git repair state and fake per-repository GitHub surfaces.
 *
 * - A private target's records (one at delivery with a clean review and a
 *   green head, one waiting on its head's CI, one blocked) stay
 *   byte-identical and in place: no merge, no comment, no issue, no charge,
 *   and no GitHub call at all on that repository beyond its one visibility
 *   read.
 * - The public target in the same run is processed exactly as on base: the
 *   same merges and the same resulting public state as a run whose state
 *   holds only the public records, with no gate.
 * - An unknown or unreadable visibility behaves like private.
 * - One text-free line names the closed reason and counts.
 */
import { PUBLIC_CONTROLLER_PROFILE } from "../../src/contracts/hosted-controller-deployment.ts";
import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { TargetVisibilityV1 } from "../../src/repair/target-visibility.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy.ts";
import { createPrivateTargetGateV1 } from "../../ops/hosted-autonomy-private-targets.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  deliveryRecord,
  FOREIGN_REPO,
  FOREIGN_TASK,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
  pullFacts,
} from "./hosted-autonomy-fixtures.ts";
import { reservation, T0 } from "../state/helpers.ts";
import {
  makeRig,
  ownerIssueFacts,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

const PRIVATE_REPO: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "prospector",
  installationId: 7,
};

function privateRecord(
  issue: number,
  pr: number,
  extra: Record<string, unknown> = {},
): WorkRecordV1 {
  const id = `issue-ubiquity-prospector-${issue}` as WorkItemId;
  const record = foreignRecord();
  return foreignRecord({
    repository: PRIVATE_REPO,
    id,
    source: {
      kind: "issue",
      id: String(issue),
      revision: record.source.revision,
    },
    related: { incidentId: null, issueNumber: issue },
    target: { ...record.target, branch: `sentinel/repair/${id}`, pr },
    ...extra,
  });
}

/** Delivery with a clean review and a green head: must NOT be merged. */
const DELIVERY = privateRecord(120, 401);
/** Delivery whose head's CI is still pending. */
const WAITING = privateRecord(121, 402);
/** Blocked. */
const BLOCKED = (() => {
  const blocked = blockedRecord();
  return privateRecord(122, 403, {
    nextStep: "blocked",
    blocker: blocked.blocker,
  });
})();
const PRIVATE_RECEIPTS = [401, 402].map((number, index) =>
  foreignReceipt({
    id: `review-receipt:${String(index + 5).repeat(64)}`,
    repository: PRIVATE_REPO,
    pullRequest: { number, head: HEAD, base: BASE },
  })
);

interface WorldV1 {
  merges: string[];
  /** Every call on the private repository's surface (visibility excluded). */
  privateCalls: string[];
  visibilityReads: string[];
}

/** One fake surface per repository: green, mergeable, open pull requests. */
function surfaces(
  base: HostedAutonomyGitHubV1,
  world: WorldV1,
  visibility: (repository: RepositoryIdentityV1) => Promise<TargetVisibilityV1>,
): (repository: RepositoryIdentityV1) => HostedAutonomyGitHubV1 {
  const cache = new Map<string, HostedAutonomyGitHubV1>();
  return (repository) => {
    const key = hostedRepositoryKey(repository);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const merged = new Set<number>();
    const surface: HostedAutonomyGitHubV1 = {
      ...base,
      readBaseTip: () => Promise.resolve(BASE),
      readIssueFacts: (number: number) =>
        Promise.resolve(ownerIssueFacts(number)),
      readIssueTask: (number: number) =>
        Promise.resolve(
          number === FOREIGN_TASK.issueNumber ? FOREIGN_TASK : null,
        ),
      readPull: (number: number): Promise<HostedAutonomyPullV1> =>
        Promise.resolve(
          merged.has(number)
            ? foreignPullFacts({
              number,
              mergeCommitSha: number.toString(16).padStart(40, "0"),
              baseSha: BASE,
              parents: [BASE, HEAD],
            })
            : foreignPullFacts({
              number,
              state: "open",
              merged: false,
              mergeCommitSha: null,
              baseSha: BASE,
            }),
        ),
      merge: (number: number) => {
        world.merges.push(`${key}#${number}`);
        merged.add(number);
        return Promise.resolve({
          merged: true,
          sha: number.toString(16).padStart(40, "0"),
        });
      },
      readVisibility: () => {
        world.visibilityReads.push(repository.name);
        return visibility(repository);
      },
    };
    const observed = repository.name !== PRIVATE_REPO.name
      ? surface
      : new Proxy(surface, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function" || property === "readVisibility") {
            return value;
          }
          return (...args: unknown[]) => {
            world.privateCalls.push(String(property));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    cache.set(key, observed);
    return observed;
  };
}

function rowsOf(snapshot: RepairStateSnapshotV1, repository: string) {
  return {
    work: snapshot.work.filter((row) => row.repository.name === repository)
      .map((row) => canonicalStringify(row)),
    reviews: snapshot.reviews.filter((row) =>
      row.repository.name === repository
    ).map((row) => canonicalStringify(row)),
    releaseRequests: snapshot.releaseRequests.filter((row) =>
      row.target.repository.name === repository
    ).map((row) => canonicalStringify(row)),
    reservations: snapshot.reservations.filter((row) =>
      row.repository.name === repository
    ).map((row) => canonicalStringify(row)),
  };
}

async function launcherRun(
  name: string,
  options: {
    withPrivate: boolean;
    gate: boolean;
    privateVisibility?: () => Promise<TargetVisibilityV1>;
  },
) {
  const records = [
    foreignRecord(),
    ...(options.withPrivate ? [DELIVERY, WAITING, BLOCKED] : []),
  ];
  const { rig, github } = await makeRig(name, {
    repair: repairSnapshot(records, [
      foreignReceipt(),
      ...(options.withPrivate ? PRIVATE_RECEIPTS : []),
    ]),
  });
  const world: WorldV1 = { merges: [], privateCalls: [], visibilityReads: [] };
  const githubFor = surfaces(
    github,
    world,
    (repository) =>
      repository.name === PRIVATE_REPO.name
        ? (options.privateVisibility?.() ?? Promise.resolve("private"))
        : Promise.resolve("public"),
  );
  rig.githubFor = githubFor;
  const before = await rig.state.readRepair();
  assert.ok(before.ok && before.value.status === "found");
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    const gate = options.gate
      ? createPrivateTargetGateV1({
        profile: PUBLIC_CONTROLLER_PROFILE,
        readVisibility: async (repository) =>
          await githubFor(repository).readVisibility?.() ?? "unknown",
      })
      : undefined;
    // The production composition hands the queue coordinator the gated
    // state and surfaces too (hosted-autonomy-main.ts).
    const gated = gate === undefined ? rig : {
      ...rig,
      state: gate.wrapState(rig.state),
      githubFor: gate.githubFor(githubFor),
    };
    const result = await run(
      gated,
      undefined,
      gate === undefined ? {} : { privateTargets: gate },
    );
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    return {
      result,
      world,
      lines,
      before: before.value.snapshot,
      after: after.value.snapshot,
    };
  } finally {
    console.log = original;
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

function assertPrivateUntouched(
  out: Awaited<ReturnType<typeof launcherRun>>,
) {
  assert.deepEqual(
    rowsOf(out.after, PRIVATE_REPO.name),
    rowsOf(out.before, PRIVATE_REPO.name),
    "private rows byte-identical",
  );
  assert.deepEqual(
    out.after.work.map((row) => row.id),
    out.before.work.map((row) => row.id),
    "every row in place",
  );
  assert.deepEqual(out.world.privateCalls, [], "no call on the private repo");
  assert.equal(
    out.world.merges.some((merge) => merge.includes("prospector")),
    false,
  );
  const hidden = out.lines.filter((line) =>
    line.includes("sentinel_private_targets_hidden")
  );
  assert.equal(hidden.length, 1);
  assert.deepEqual(
    JSON.parse(hidden[0]),
    {
      kind: "sentinel_private_targets_hidden",
      reason: "private_repository",
      repositories: 1,
      rows: 5,
      refusedWrites: 0,
      invalidViews: 0,
    },
    JSON.stringify(out.result.actions),
  );
  assert.equal(hidden[0].includes("prospector"), false);
}

Deno.test("private targets (launcher): a full run leaves a private target's records untouched and works the public target exactly as on base", async () => {
  const base = await launcherRun("private-launcher-base", {
    withPrivate: false,
    gate: false,
  });
  const gated = await launcherRun("private-launcher-gated", {
    withPrivate: true,
    gate: true,
  });
  assertPrivateUntouched(gated);
  // The public target: the same merges and the same resulting state.
  assert.deepEqual(gated.world.merges, base.world.merges);
  assert.ok(base.world.merges.length > 0, "the public delivery merged");
  assert.deepEqual(
    rowsOf(gated.after, "other-target"),
    rowsOf(base.after, "other-target"),
  );
  assert.equal(gated.result.status, base.result.status);
  assert.deepEqual(
    gated.world.visibilityReads.sort(),
    ["other-target", "prospector"],
    "one visibility read per repository per run",
  );
});

Deno.test("private targets (launcher): an unknown or unreadable visibility behaves like private", async () => {
  for (
    const [label, answer] of [
      ["unknown", () => Promise.resolve("unknown" as const)],
      ["unreadable", () => Promise.reject(new Error("read failed"))],
    ] as const
  ) {
    const out = await launcherRun(`private-launcher-${label}`, {
      withPrivate: true,
      gate: true,
      privateVisibility: answer,
    });
    assertPrivateUntouched(out);
  }
});

Deno.test("private targets (launcher): without the gate the same state would merge the private delivery (the failing-before case)", async () => {
  const ungated = await launcherRun("private-launcher-ungated", {
    withPrivate: true,
    gate: false,
  });
  assert.ok(
    ungated.world.merges.some((merge) => merge.endsWith("#401")),
    JSON.stringify(ungated.world.merges),
  );
  assert.notDeepEqual(ungated.world.privateCalls, []);
});

/** Sentinel's own delivery beside a foreign target filling every optional collection. */
async function selfRig(name: string) {
  const raw = parseRepairStateSnapshotV1({
    ...repairSnapshot(
      [deliveryRecord(), foreignRecord()],
      [authorizingReceipt(), foreignReceipt()],
    ),
    // Every row of these optional collections is the foreign target's, so
    // its hidden view carries neither (the contract refuses an empty one).
    reservationArchive: [
      reservation("r:foreign-archived", {
        repository: FOREIGN_REPO,
        createdAt: T0 - 10_000,
        outcome: "submitted",
        settledAt: T0 - 5_000,
      }),
    ],
    targetCapabilities: [
      { id: "target_capability:7/ubiquity/other-target", version: 2, a: [1] },
    ],
  });
  return await makeRig(name, {
    repair: raw,
    pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    afterMerge: pullFacts(),
    issueFacts: () => ({ author: "0x4007", authorId: 4975670 }),
  });
}

function foreignRows(snapshot: RepairStateSnapshotV1) {
  return canonicalStringify({
    ...rowsOf(snapshot, FOREIGN_REPO.name),
    reservationArchive: snapshot.reservationArchive ?? null,
    targetCapabilities: snapshot.targetCapabilities ?? null,
  });
}

Deno.test("private targets (launcher): with every foreign visibility read failing, Sentinel's own delivery still merges and its state write applies", async () => {
  const { rig, github } = await selfRig("private-launcher-self");
  const lines: string[] = [];
  const original = console.log;
  try {
    const before = await rig.state.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const visibilityReads: string[] = [];
    const gate = createPrivateTargetGateV1({
      profile: PUBLIC_CONTROLLER_PROFILE,
      readVisibility: (repository) => {
        visibilityReads.push(repository.name);
        return Promise.reject(new Error("read failed"));
      },
    });
    console.log = (...args: unknown[]) =>
      lines.push(args.map(String).join(" "));
    const result = await run(
      { ...rig, state: gate.wrapState(rig.state) },
      github,
      { privateTargets: gate },
    );
    console.log = original;
    assert.equal(rig.merges, 1, JSON.stringify(result.actions));
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.notEqual(after.value.head, before.value.head, "the write applied");
    assert.equal(result.status, "applied", JSON.stringify(result.actions));
    assert.ok(
      after.value.snapshot.sequence > before.value.snapshot.sequence,
      "the delivery's own state write applied through the gate",
    );
    assert.equal(
      foreignRows(after.value.snapshot),
      foreignRows(before.value.snapshot),
      "the foreign rows, optional collections included, byte-identical",
    );
    assert.deepEqual(visibilityReads, ["other-target"], "self is never read");
    const hidden = lines.filter((line) =>
      line.includes("sentinel_private_targets_hidden")
    );
    assert.deepEqual(JSON.parse(hidden[0]), {
      kind: "sentinel_private_targets_hidden",
      reason: "private_repository",
      repositories: 1,
      rows: 4,
      refusedWrites: 0,
      invalidViews: 0,
    });
  } finally {
    console.log = original;
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("private targets (launcher): a hidden view the contract refuses stops the run before any pass, with no GitHub call", async () => {
  const { rig, github } = await selfRig("private-launcher-view-invalid");
  const lines: string[] = [];
  const original = console.log;
  try {
    const before = await rig.state.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const gate = createPrivateTargetGateV1({
      profile: PUBLIC_CONTROLLER_PROFILE,
      readVisibility: () => Promise.resolve("private"),
      validateView: () => {
        throw new Error("refused");
      },
    });
    const surfaces: string[] = [];
    const custody: boolean[] = [];
    console.log = (...args: unknown[]) =>
      lines.push(args.map(String).join(" "));
    const result = await run(
      { ...rig, state: gate.wrapState(rig.state) },
      github,
      {
        privateTargets: gate,
        githubFor: (repository) => {
          surfaces.push(repository.name);
          return github;
        },
        onQueueCustodyReady: (ready) => {
          custody.push(ready);
        },
      },
    );
    console.log = original;
    assert.deepEqual(
      { status: result.status, reason: result.reason },
      { status: "skipped", reason: "snapshot_invalid" },
    );
    assert.deepEqual(result.actions, ["private_targets:view_invalid"]);
    assert.deepEqual(surfaces, [], "no repository surface was resolved");
    assert.equal(rig.merges, 0);
    assert.deepEqual(custody, [false]);
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(after.value.head, before.value.head, "nothing written");
    const hidden = lines.filter((line) =>
      line.includes("sentinel_private_targets_hidden")
    );
    // The run's own pre-pass read, plus the test's queue fixture, which reads
    // the same gated state while it is built (before the run starts).
    assert.ok(JSON.parse(hidden[0]).invalidViews >= 1, hidden[0]);
  } finally {
    console.log = original;
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
