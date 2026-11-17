/**
 * The owner's one-time release of the eleven 2026-11-17 protected-path parks
 * (`ops/hosted-autonomy-protected-release.ts`) over the verbatim live rows of
 * sentinel-state/repair at b53e355a4571 (sequence 97103), through the real
 * protected maintenance pass (`runHostedAutonomy`, expected-head CAS and
 * readback) with a fake GitHub surface answering the installed runtime's
 * source reads and the parked pull requests.
 */
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import { existingHeadContinuationShape } from "../../src/repair/loop-eligibility.ts";
import { UNTRUSTED_WORKFLOW_PARK } from "../../src/repair/workflow-trust.ts";
import { runHostedAutonomy } from "../../ops/hosted-autonomy.ts";
import { OWNER_PROTECTED_RELEASES_2026_11_17 } from "../../ops/hosted-autonomy-owner-releases.ts";
import { producerRequests } from "../../ops/hosted-autonomy-producer-requests.ts";
import {
  planProtectedReleases,
  PROTECTED_RELEASE_DETAIL,
  PUBLICATION_POLICY_SOURCES,
  publicationPolicyRuntimeHold,
  type PublicationPolicySourcesV1,
  runtimeSourceCarriesPublicationPolicy,
} from "../../ops/hosted-autonomy-protected-release.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import { makeRig, releaseSnapshot } from "./hosted-autonomy-rig.ts";

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/protected-release-live-v1.json", import.meta.url),
  ),
) as { work: WorkRecordV1[] };

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);
const RUNTIME = "7".repeat(40) as GitSha;
/** A maintenance pass after the owner's decision. */
const NOW = Date.UTC(2026, 10, 18, 0);
const HOUR = 60 * 60_000;
const PULLS: Record<string, number> = {
  "issue-ubiquity-arbitrage-bot-7": 20,
  "issue-ubiquity-demo.ubq.fi-23": 51,
  "issue-ubiquity-notifications.ubq.fi-13": 33,
};

function live(id: string): WorkRecordV1 {
  const row = LIVE.work.find((record) => record.id === id);
  if (row === undefined) throw new Error(`no live row ${id}`);
  return parseWorkRecordV1(row);
}

/** The same park on a record the owner did not name. */
function unnamed(): WorkRecordV1 {
  const row = live("issue-ubiquity-sentinel-240");
  const id = "issue-ubiquity-sentinel-999";
  return parseWorkRecordV1({
    ...row,
    id,
    source: { ...row.source, id: "999" },
    related: { ...row.related, issueNumber: 999 },
    target: { ...row.target, branch: `sentinel/repair/${id}` },
  });
}

function snapshotOf(work: WorkRecordV1[]): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: NOW - HOUR,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

async function checkout(): Promise<PublicationPolicySourcesV1> {
  const read = (path: string) => Deno.readTextFile(`${ROOT}${path}`);
  return {
    policy: await read(PUBLICATION_POLICY_SOURCES.policy),
    park: await read(PUBLICATION_POLICY_SOURCES.park),
    trust: await read(PUBLICATION_POLICY_SOURCES.trust),
    push: await read(PUBLICATION_POLICY_SOURCES.push),
  };
}

/** The sources as the runtime before 2026-11-17 has them (the old rule). */
async function oldRule(): Promise<PublicationPolicySourcesV1> {
  const sources = await checkout();
  return {
    ...sources,
    policy: sources.policy.replace(
      "  return credentialPath(path);\n}",
      "  return ciExecutablePath(path) || authorityPath(path);\n}",
    ),
    park: sources.park.replace(
      ' || trust !== "trusted";',
      ";",
    ),
  };
}

/** Each parked pull request, open at its record's published head. */
function pullOf(number: number, headSha?: string): HostedAutonomyPullV1 {
  const id = Object.keys(PULLS).find((key) => PULLS[key] === number)!;
  return {
    number,
    state: "open",
    merged: false,
    mergeCommitSha: null,
    headSha: headSha ?? live(id).target.candidateState!.publishedHead,
    baseRef: "development",
    baseSha: live(id).target.base,
    author: "ubiquity-sentinel[bot]",
    parents: [],
    revisionOnBaseBranch: false,
    baseAncestorOfRevision: false,
  };
}

async function rigWith(
  work: WorkRecordV1[],
  sources: PublicationPolicySourcesV1 | null,
  options: { moved?: number } = {},
) {
  const { rig, github } = await makeRig("protected-release", {
    repair: snapshotOf(work),
    release: releaseSnapshot([], RUNTIME),
    fixtureDir: ROOT,
    defaultBranch: "development",
  });
  const reads: string[] = [];
  const surface: HostedAutonomyGitHubV1 = {
    ...github,
    readPull: (number: number) =>
      Promise.resolve(
        pullOf(number, number === options.moved ? "a".repeat(40) : undefined),
      ),
    ...(sources === null ? {} : {
      readFileAt: (path: string, revision: string) => {
        reads.push(`${path}@${revision}`);
        const key = (Object.keys(PUBLICATION_POLICY_SOURCES) as (
          keyof PublicationPolicySourcesV1
        )[]).find((name) => PUBLICATION_POLICY_SOURCES[name] === path);
        return Promise.resolve(key === undefined ? null : sources[key]);
      },
    }),
  };
  rig.githubFor = () => surface;
  return { rig, reads };
}

async function maintenance(
  rig: Awaited<ReturnType<typeof makeRig>>["rig"],
  at: number,
) {
  return await runHostedAutonomy(
    await withDarkQueueAuthority({
      ciMinutes: INACTIVE_CI_MINUTES,
      state: rig.state,
      githubFor: rig.githubFor,
      clock: { now: () => at },
    }),
  );
}

async function readState(
  rig: Awaited<ReturnType<typeof makeRig>>["rig"],
): Promise<{ head: GitSha; snapshot: RepairStateSnapshotV1 }> {
  const read = await rig.state.readRepair();
  if (!read.ok || read.value.status !== "found") throw new Error("unreadable");
  return { head: read.value.head, snapshot: read.value.snapshot };
}

const IDS = OWNER_PROTECTED_RELEASES_2026_11_17.map((entry) => entry.id);

Deno.test("protected release: this checkout's own source carries the 2026-11-17 policy, the old rule does not", async () => {
  const sources = await checkout();
  assert.equal(runtimeSourceCarriesPublicationPolicy(sources), true);
  assert.equal(runtimeSourceCarriesPublicationPolicy(await oldRule()), false);
  // Any one fact reverted fails closed.
  const drops: [keyof PublicationPolicySourcesV1, string, string][] = [
    ["policy", "return credentialPath(path);", "return false;"],
    ["policy", "export function sentinelNeverMerges(", "function never("],
    ["park", ' || trust !== "trusted";', ";"],
    ["park", "await workflowChangeTrust(", "await Promise.resolve("],
    ["trust", "BASE_REPAIR_AUTHOR) return", "null) return"],
    ["push", "if (push.error.detail === PUSH_", "if (false && PUSH_"],
  ];
  for (const [key, from, to] of drops) {
    assert.ok(sources[key].includes(from), `${key}: ${from}`);
    assert.equal(
      runtimeSourceCarriesPublicationPolicy({
        ...sources,
        [key]: sources[key].replace(from, to),
      }),
      false,
      `${key}: ${from}`,
    );
  }
  // An installation in flight holds the release before any source read.
  const reads: string[] = [];
  const installing = {
    ...releaseSnapshot([], RUNTIME),
    hostedInstallations: [{
      version: "v1",
      kind: "hosted_installation",
      id: `installation:${RUNTIME}`,
      phase: "bootstrapping",
    }],
  } as unknown as ReleaseStateSnapshotV1;
  const self = {
    readFileAt: (path: string) => {
      reads.push(path);
      return Promise.resolve(null);
    },
  } as unknown as HostedAutonomyGitHubV1;
  assert.equal(
    await publicationPolicyRuntimeHold(installing, () => self),
    "runtime_installing",
  );
  assert.equal(
    await publicationPolicyRuntimeHold(null, () => self),
    "runtime_unreadable",
  );
  assert.deepEqual(reads, []);
});

Deno.test("protected release: the planner names exactly the eleven live parks and nothing else", () => {
  const relabelled = live("issue-ubiquity-ai.ubq.fi-1370");
  const untrusted = parseWorkRecordV1({
    ...relabelled,
    blocker: { ...relabelled.blocker!, message: UNTRUSTED_WORKFLOW_PARK },
  });
  const later = live("issue-ubiquity-sentinel-240");
  const reparked = parseWorkRecordV1({
    ...later,
    blocker: { ...later.blocker!, since: later.blocker!.since + 1 },
  });
  const snapshot = snapshotOf([...LIVE.work, unnamed()]);
  const planned = planProtectedReleases(snapshot, new Set(), () => false, NOW);
  assert.deepEqual(planned.map((entry) => entry.id).sort(), [...IDS].sort());
  assert.deepEqual(
    planned.filter((entry) => entry.shape === "published_pull").map((entry) =>
      entry.id
    ).sort(),
    Object.keys(PULLS).sort(),
  );
  // The untrusted-author park, a later park and an unnamed record: none.
  assert.deepEqual(
    planProtectedReleases(
      snapshotOf([untrusted, reparked, unnamed()]),
      new Set(),
      () => false,
      NOW,
    ),
    [],
  );
  // A closed issue, a record another rule owns and an unusable clock: none.
  assert.equal(
    planProtectedReleases(
      snapshot,
      new Set(["155687488:ubiquity/ai.ubq.fi#1370"]),
      (id) => id === "issue-ubiquity-sentinel-177",
      NOW,
    ).length,
    planned.length - 2,
  );
  assert.deepEqual(
    planProtectedReleases(snapshot, new Set(), () => false, 0),
    [],
  );
});

Deno.test("protected release: nothing is released while the installed runtime lacks the policy or is unreadable", async () => {
  for (
    const [sources, reason] of [
      [await oldRule(), "runtime_without_policy"],
      [null, "runtime_unreadable"],
    ] as const
  ) {
    const { rig } = await rigWith(LIVE.work, sources);
    try {
      const before = await readState(rig);
      const result = await maintenance(rig, NOW);
      assert.ok(
        result.actions.includes(`retry:owner_release:held:${reason}`),
        JSON.stringify(result.actions),
      );
      assert.equal(
        result.actions.some((action) =>
          action.includes(PROTECTED_RELEASE_DETAIL)
        ),
        false,
      );
      assert.deepEqual(
        (await readState(rig)).snapshot.work,
        before.snapshot.work,
      );
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  }
});

Deno.test("protected release: the maintenance pass releases each exact park once, uncharged", async () => {
  const { rig, reads } = await rigWith(
    [...LIVE.work, unnamed()],
    await checkout(),
  );
  try {
    const before = await readState(rig);
    const first = await maintenance(rig, NOW);
    assert.equal(first.status, "applied", JSON.stringify(first));
    for (const id of IDS) {
      assert.ok(
        first.actions.includes(
          `retry:${id}:grant=0:${PROTECTED_RELEASE_DETAIL}`,
        ),
        `${id}: ${JSON.stringify(first.actions)}`,
      );
    }
    assert.equal(reads.length, 4, "one read of each installed source");
    assert.ok(reads.every((read) => read.endsWith(`@${RUNTIME}`)));
    const after = await readState(rig);
    for (const id of IDS) {
      const was = live(id);
      const row = after.snapshot.work.find((record) => record.id === id)!;
      assert.equal(row.nextStep, "work", id);
      assert.equal(row.blocker, null, id);
      assert.equal(row.wait, null, id);
      assert.equal(row.intent, null, id);
      assert.equal(row.target.base, was.target.base, `${id}: base kept`);
      assert.equal(row.counters.attempts, was.counters.attempts, id);
      assert.equal(row.counters.retries, was.counters.retries, id);
      assert.equal(row.counters.reviewRounds, was.counters.reviewRounds, id);
      assert.deepEqual(row.evidence, was.evidence, id);
      if (id in PULLS) {
        // Back to its own published pull request head: the continuation.
        assert.deepEqual(row.target, {
          ...was.target,
          head: was.target.candidateState!.publishedHead,
          checkpoint: null,
        });
        assert.equal(existingHeadContinuationShape(row), true, id);
      } else {
        assert.deepEqual(row.target, {
          base: was.target.base,
          branch: was.target.branch,
          checkpoint: null,
          head: null,
          pr: null,
        });
      }
    }
    // The unnamed record holding the same park is untouched.
    assert.deepEqual(
      after.snapshot.work.find((row) => row.id === unnamed().id),
      unnamed(),
    );
    // Nothing charged, refunded or remembered.
    assert.deepEqual(after.snapshot.reservations, before.snapshot.reservations);
    assert.deepEqual(
      after.snapshot.attemptMemory,
      before.snapshot.attemptMemory,
    );
    // No released record binds a producer: the current-matrix walk and the
    // duplicate-replay guard read nothing new.
    assert.deepEqual(
      await producerRequests(
        {
          work: after.snapshot.work.filter((row) => IDS.includes(row.id)),
          reservations: after.snapshot.reservations,
        },
        {} as HostedExecutionIntentV1,
        new Set(),
        (message) => new Error(message),
      ),
      [],
    );

    // Fires once: the next pass reads nothing and writes nothing.
    const writes = rig.writes;
    const second = await maintenance(rig, NOW + HOUR);
    assert.equal(
      second.actions.some((action) => action.includes("owner_release")),
      false,
      JSON.stringify(second.actions),
    );
    assert.equal(reads.length, 4);
    assert.equal(rig.writes, writes);

    // A later park of a released record (its own later `since`) stays.
    const state = await readState(rig);
    const reparked = state.snapshot.work.map((row) =>
      row.id === "issue-ubiquity-sentinel-240"
        ? parseWorkRecordV1({
          ...live(row.id),
          blocker: {
            ...live(row.id).blocker!,
            since: NOW + HOUR,
          },
          updatedAt: NOW + HOUR,
        })
        : row
    );
    const written = await rig.state.writeRepair(
      parseRepairStateSnapshotV1({
        ...state.snapshot,
        work: reparked,
        stateHead: state.head,
        sequence: state.snapshot.sequence + 1,
        updatedAt: NOW + HOUR,
      }),
      state.head,
    );
    assert.ok(written.ok && written.value.status === "applied");
    const third = await maintenance(rig, NOW + 2 * HOUR);
    assert.equal(
      third.actions.some((action) => action.includes("owner_release")),
      false,
      JSON.stringify(third.actions),
    );
    const row = (await readState(rig)).snapshot.work.find((record) =>
      record.id === "issue-ubiquity-sentinel-240"
    )!;
    assert.equal(row.nextStep, "blocked");
    assert.equal(row.blocker?.since, NOW + HOUR);
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("protected release: a pull request that no longer binds its published head stays parked", async () => {
  const { rig } = await rigWith(LIVE.work, await checkout(), { moved: 20 });
  try {
    const first = await maintenance(rig, NOW);
    assert.ok(
      first.actions.includes(
        "retry:issue-ubiquity-arbitrage-bot-7:skipped:owner_release_pull_unverified",
      ),
      JSON.stringify(first.actions),
    );
    const after = (await readState(rig)).snapshot.work;
    const kept = after.find((row) =>
      row.id === "issue-ubiquity-arbitrage-bot-7"
    );
    assert.deepEqual(kept, live("issue-ubiquity-arbitrage-bot-7"));
    assert.equal(
      after.filter((row) => IDS.includes(row.id) && row.nextStep === "work")
        .length,
      IDS.length - 1,
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
