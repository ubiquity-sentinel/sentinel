/**
 * The launcher delivery pass merges EVERY reviewed, green, exact-tip head it
 * can in one pass: there is no per-pass single-merge count (it used to allow
 * only one merge per repository per pass). The order is deterministic and
 * oldest first. A merge call, whatever it answers, is an external write, so
 * that repository's cached base tip and tip CI are dropped and the next
 * candidate re-reads and re-verifies its own base: a candidate off the moved
 * tip is refused `base_moved` by the existing gate instead of merging onto a
 * commit no CI ran on (never a count-based deferral).
 */
import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy.ts";
import {
  BASE,
  FOREIGN_RECEIPT_2,
  FOREIGN_REPO,
  FOREIGN_TASK,
  FOREIGN_TASK_2,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  foreignRecord2,
  HEAD,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";
import { T0 } from "../state/helpers.ts";

/** A second foreign repository with its own tip and merges. */
const OTHER_REPO: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "other-target-2",
  installationId: 7,
};
const OTHER_ID = "issue-ubiquity-other-target-2-120" as WorkItemId;
const OTHER_PR = 377;

/** The other repository's reviewed delivery of its own issue 120. */
function otherRecord(): WorkRecordV1 {
  const record = foreignRecord();
  return foreignRecord({
    repository: OTHER_REPO,
    id: OTHER_ID,
    target: {
      ...record.target,
      branch: `sentinel/repair/${OTHER_ID}`,
      pr: OTHER_PR,
    },
  });
}

const OTHER_RECEIPT = foreignReceipt({
  id: `review-receipt:${"c".repeat(64)}`,
  repository: OTHER_REPO,
  pullRequest: { number: OTHER_PR, head: HEAD, base: BASE },
});

/** A base the tip moved past before this pass: reviewed, now off the tip. */
const STALE = "0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d" as const;
const THIRD_ID = "issue-ubiquity-ai.ubq.fi-122" as WorkItemId;
const THIRD_PR = 378;
const THIRD_TASK: ReviewTaskStatementV1 = {
  issueNumber: 122,
  title: "Deliver the third reviewed foreign candidate",
  body: "The foreign repository must deliver its own issue 122.",
  digest: await reviewTaskStatementDigest({
    issueNumber: 122,
    title: "Deliver the third reviewed foreign candidate",
    body: "The foreign repository must deliver its own issue 122.",
  }),
};

/** The second reviewed head in the same repository: the oldest record. */
function olderRecord(): WorkRecordV1 {
  return foreignRecord({ ...foreignRecord2(), createdAt: T0 });
}

/** A third reviewed head in the same repository, off the current tip. */
function thirdRecord(): WorkRecordV1 {
  const record = foreignRecord();
  return foreignRecord({
    id: THIRD_ID,
    related: { incidentId: null, issueNumber: 122 },
    target: {
      ...record.target,
      base: STALE,
      branch: `sentinel/repair/${THIRD_ID}`,
      pr: THIRD_PR,
    },
  });
}

const THIRD_RECEIPT = foreignReceipt({
  id: `review-receipt:${"d".repeat(64)}`,
  pullRequest: { number: THIRD_PR, head: HEAD, base: STALE },
  taskAcceptance: {
    issueNumber: 122,
    taskDigest: THIRD_TASK.digest,
    verdict: "fulfilled",
    evidence: ["the third reviewed candidate satisfies the foreign issue"],
  },
});

/** The merge commit of one pull request. */
function mergeSha(pull: number): string {
  return pull.toString(16).padStart(40, "0");
}

interface WorldV1 {
  /** Every merge call, as `<repository key>#<pull>`. */
  merges: string[];
  /** Repository keys whose pull requests the world refuses to merge. */
  refuse: Set<string>;
  /** A landed merge moves its own repository's tip, like the real branch. */
  tipMoves: boolean;
  /** Every base tip read, as `<repository key>:<sha>`. */
  tips: string[];
}

/** The reviewed base of every fixture pull request. */
const PULL_BASES = new Map<number, string>([
  [375, BASE],
  [376, BASE],
  [THIRD_PR, STALE],
  [OTHER_PR, BASE],
]);

/**
 * One surface per repository over the rig's base surface: each pull request
 * reads open until its own merge lands, and a landed merge moves only its
 * own repository's tip.
 */
function perRepository(
  base: HostedAutonomyGitHubV1,
  world: WorldV1,
): (repository: RepositoryIdentityV1) => HostedAutonomyGitHubV1 {
  const surfaces = new Map<string, HostedAutonomyGitHubV1>();
  return (repository) => {
    const key = hostedRepositoryKey(repository);
    const cached = surfaces.get(key);
    if (cached !== undefined) return cached;
    let tip = BASE as string;
    const parents = new Map<number, string[]>();
    const pullBase = (number: number) => PULL_BASES.get(number) ?? BASE;
    const surface: HostedAutonomyGitHubV1 = {
      ...base,
      readBaseTip: () => {
        world.tips.push(`${key}:${tip}`);
        return Promise.resolve(tip);
      },
      readIssueTask: (number: number) =>
        Promise.resolve(
          number === FOREIGN_TASK.issueNumber
            ? FOREIGN_TASK
            : number === FOREIGN_TASK_2.issueNumber
            ? FOREIGN_TASK_2
            : number === THIRD_TASK.issueNumber
            ? THIRD_TASK
            : null,
        ),
      readPull: (number: number): Promise<HostedAutonomyPullV1> => {
        const mergedParents = parents.get(number);
        return Promise.resolve(
          mergedParents === undefined
            ? foreignPullFacts({
              number,
              state: "open",
              merged: false,
              mergeCommitSha: null,
              baseSha: pullBase(number),
            })
            : foreignPullFacts({
              number,
              mergeCommitSha: mergeSha(number),
              baseSha: pullBase(number),
              parents: mergedParents,
            }),
        );
      },
      merge: (number: number) => {
        world.merges.push(`${key}#${number}`);
        if (world.refuse.has(key)) {
          return Promise.resolve({ merged: false, sha: null });
        }
        parents.set(number, [tip, HEAD]);
        if (world.tipMoves) tip = mergeSha(number);
        return Promise.resolve({ merged: true, sha: mergeSha(number) });
      },
    };
    surfaces.set(key, surface);
    return surface;
  };
}

/** Two reviewed heads in one repository, a stale third and one elsewhere. */
async function onePass(
  name: string,
  options: { refuse?: RepositoryIdentityV1[]; tipMoves?: boolean } = {},
) {
  const first = foreignRecord();
  const second = olderRecord();
  const third = thirdRecord();
  const other = otherRecord();
  const { rig, github } = await makeRig(name, {
    repair: repairSnapshot(
      [first, second, other, third],
      [foreignReceipt(), FOREIGN_RECEIPT_2, OTHER_RECEIPT, THIRD_RECEIPT],
    ),
  });
  const world: WorldV1 = {
    merges: [],
    refuse: new Set((options.refuse ?? []).map(hostedRepositoryKey)),
    tipMoves: options.tipMoves ?? true,
    tips: [],
  };
  rig.githubFor = perRepository(github, world);
  try {
    const result = await run(rig);
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    return {
      result,
      merges: world.merges,
      tips: world.tips,
      work: read.value.snapshot.work,
      releaseRequests: read.value.snapshot.releaseRequests,
      closed: rig.closed,
      ids: {
        first: first.id,
        second: second.id,
        third: third.id,
        other: other.id,
      },
    };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

const A = hostedRepositoryKey(FOREIGN_REPO);
const B = hostedRepositoryKey(OTHER_REPO);

Deno.test("merge pass: two reviewed heads on the tip in one repository both merge, oldest first, and the off-tip third is deferred", async () => {
  // The second record is the oldest, so it merges before the first: order is
  // deterministic by record age, never by id or list position.
  const out = await onePass("merge-per-repository", { tipMoves: false });
  assert.deepEqual(
    out.merges,
    [`${A}#376`, `${A}#375`, `${B}#${OTHER_PR}`],
    JSON.stringify(out.result.actions),
  );
  const { actions } = out.result;
  for (
    const [id, pull] of [
      [out.ids.second, 376],
      [out.ids.first, 375],
      [out.ids.other, OTHER_PR],
    ] as const
  ) {
    assert.ok(
      actions.includes(`merge:${id}:pr=${pull}:sha=${mergeSha(pull)}`),
      JSON.stringify(actions),
    );
    assert.ok(
      actions.includes(`delivery:${id}:foreign_merged`),
      JSON.stringify(actions),
    );
  }
  // The third reviewed head is off the tip (its base moved before this pass):
  // the existing moved-base gate defers it and no merge is attempted.
  assert.ok(
    actions.includes(`delivery:${out.ids.third}:base_moved`),
    JSON.stringify(actions),
  );
  assert.ok(
    !out.merges.includes(`${A}#${THIRD_PR}`),
    "the off-tip candidate never merges",
  );
  assert.equal(out.result.status, "applied", JSON.stringify(out.result));
  const step = (id: string) => out.work.find((row) => row.id === id)?.nextStep;
  assert.equal(step(out.ids.first), "done");
  assert.equal(step(out.ids.second), "done");
  assert.equal(step(out.ids.other), "done");
  assert.equal(step(out.ids.third), "delivery");
  // Accounting per merge is unchanged: a foreign repository books nothing.
  assert.deepEqual(out.releaseRequests, []);
  // One closure per merged pull: both of the repository's issues close.
  assert.deepEqual(
    [...out.closed].sort((left, right) => left - right),
    [120, 120, 121],
    JSON.stringify(out.closed),
  );
});

Deno.test("merge pass: after one merge the next candidate's base is re-read; off the moved tip it is deferred, not merged", async () => {
  const out = await onePass("merge-per-repository-moved-tip");
  assert.deepEqual(out.merges, [`${A}#376`, `${B}#${OTHER_PR}`]);
  const { actions } = out.result;
  assert.ok(
    actions.includes(`merge:${out.ids.second}:pr=376:sha=${mergeSha(376)}`),
    JSON.stringify(actions),
  );
  // The tip is re-read after the merge and the sibling reviewed on the old
  // tip is refused by the existing off-tip rule, exactly once per pass.
  assert.ok(
    actions.includes(`delivery:${out.ids.first}:base_moved`),
    JSON.stringify(actions),
  );
  assert.ok(out.tips.includes(`${A}:${BASE}`));
  assert.ok(
    out.tips.includes(`${A}:${mergeSha(376)}`),
    `the moved tip is re-read: ${out.tips.join(" ")}`,
  );
  const step = (id: string) => out.work.find((row) => row.id === id)?.nextStep;
  assert.equal(step(out.ids.second), "done");
  assert.equal(step(out.ids.first), "delivery");
  assert.equal(step(out.ids.third), "delivery");
  assert.deepEqual(out.releaseRequests, []);
});

Deno.test("merge pass: a refused merge no longer stops its own repository; each candidate is decided by its own gates", async () => {
  const out = await onePass("merge-per-repository-refused", {
    refuse: [FOREIGN_REPO],
  });
  // Both of the refused repository's reviewed heads get their own attempt and
  // neither lands; the other repository still merges.
  assert.deepEqual(out.merges, [`${A}#376`, `${A}#375`, `${B}#${OTHER_PR}`]);
  const { actions } = out.result;
  assert.ok(
    actions.includes(`delivery:${out.ids.second}:merge_not_observed`),
    JSON.stringify(actions),
  );
  assert.ok(
    actions.includes(`delivery:${out.ids.first}:merge_not_observed`),
    JSON.stringify(actions),
  );
  assert.ok(actions.includes(`delivery:${out.ids.other}:foreign_merged`));
  const step = (id: string) => out.work.find((row) => row.id === id)?.nextStep;
  assert.equal(step(out.ids.other), "done");
  assert.equal(step(out.ids.first), "delivery");
  assert.equal(step(out.ids.second), "delivery");
});
