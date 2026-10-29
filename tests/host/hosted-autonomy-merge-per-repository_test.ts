/**
 * The launcher delivery pass calls merge at most once per REPOSITORY per
 * pass (it used to be once per pass across every repository). A merge moves
 * only its own repository's tip, so a reviewed, green head in another
 * repository still merges in the same pass under every per-merge gate (the
 * uncached tip re-read right before the call, exact-head CI, the current-head
 * receipt and its P0 rule); a second open pull request in the repository that
 * already had a merge called stays `merge_deferred`.
 */
import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
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

/** The merge commit of one pull request: parents exactly [BASE, HEAD]. */
function mergeSha(pull: number): string {
  return pull.toString(16).padStart(40, "0");
}

interface WorldV1 {
  /** Every merge call, as `<repository key>#<pull>`. */
  merges: string[];
  /** Repository keys whose pull requests the world refuses to merge. */
  refuse: Set<string>;
}

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
    const merged = new Set<number>();
    const surface: HostedAutonomyGitHubV1 = {
      ...base,
      readBaseTip: () => Promise.resolve(tip),
      readIssueTask: (number: number) =>
        Promise.resolve(
          number === FOREIGN_TASK.issueNumber
            ? FOREIGN_TASK
            : number === FOREIGN_TASK_2.issueNumber
            ? FOREIGN_TASK_2
            : null,
        ),
      readPull: (number: number): Promise<HostedAutonomyPullV1> =>
        Promise.resolve(
          merged.has(number)
            ? foreignPullFacts({
              number,
              mergeCommitSha: mergeSha(number),
              parents: [BASE, HEAD],
            })
            : foreignPullFacts({
              number,
              state: "open",
              merged: false,
              mergeCommitSha: null,
            }),
        ),
      merge: (number: number) => {
        world.merges.push(`${key}#${number}`);
        if (world.refuse.has(key)) {
          return Promise.resolve({ merged: false, sha: null });
        }
        merged.add(number);
        tip = mergeSha(number);
        return Promise.resolve({ merged: true, sha: mergeSha(number) });
      },
    };
    surfaces.set(key, surface);
    return surface;
  };
}

/** Two open reviewed heads in one repository and one in another. */
async function onePass(name: string, refuse: RepositoryIdentityV1[] = []) {
  const first = foreignRecord();
  const second = foreignRecord2();
  const other = otherRecord();
  const { rig, github } = await makeRig(name, {
    repair: repairSnapshot(
      [first, second, other],
      [foreignReceipt(), FOREIGN_RECEIPT_2, OTHER_RECEIPT],
    ),
  });
  const world: WorldV1 = {
    merges: [],
    refuse: new Set(refuse.map(hostedRepositoryKey)),
  };
  rig.githubFor = perRepository(github, world);
  try {
    const result = await run(rig);
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    return {
      result,
      merges: world.merges,
      work: read.value.snapshot.work,
      closed: rig.closed,
      ids: { first: first.id, second: second.id, other: other.id },
    };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

const A = hostedRepositoryKey(FOREIGN_REPO);
const B = hostedRepositoryKey(OTHER_REPO);

Deno.test("merge bound: one pass merges one reviewed head per repository", async () => {
  const out = await onePass("merge-per-repository");
  assert.deepEqual(out.merges, [`${A}#375`, `${B}#${OTHER_PR}`]);
  const { actions } = out.result;
  assert.ok(
    actions.includes(`merge:${out.ids.first}:pr=375:sha=${mergeSha(375)}`),
    JSON.stringify(actions),
  );
  assert.ok(
    actions.includes(
      `merge:${out.ids.other}:pr=${OTHER_PR}:sha=${mergeSha(OTHER_PR)}`,
    ),
    JSON.stringify(actions),
  );
  // The repository that already merged keeps its serial bound.
  assert.ok(
    actions.includes(`delivery:${out.ids.second}:merge_deferred`),
    JSON.stringify(actions),
  );
  assert.ok(actions.includes(`delivery:${out.ids.first}:foreign_merged`));
  assert.ok(actions.includes(`delivery:${out.ids.other}:foreign_merged`));
  // Both merged records close through their own repository's closure.
  assert.equal(out.result.status, "applied", JSON.stringify(out.result));
  const step = (id: string) => out.work.find((row) => row.id === id)?.nextStep;
  assert.equal(step(out.ids.first), "done");
  assert.equal(step(out.ids.other), "done");
  assert.equal(step(out.ids.second), "delivery");
});

Deno.test("merge bound: a refused merge still holds only its own repository", async () => {
  const out = await onePass("merge-per-repository-refused", [FOREIGN_REPO]);
  // Whatever the call answered, that repository's tip may have moved, so its
  // later open pull request is deferred; the other repository still merges.
  assert.deepEqual(out.merges, [`${A}#375`, `${B}#${OTHER_PR}`]);
  const { actions } = out.result;
  assert.ok(
    actions.includes(`delivery:${out.ids.first}:merge_not_observed`),
    JSON.stringify(actions),
  );
  assert.ok(
    actions.includes(`delivery:${out.ids.second}:merge_deferred`),
    JSON.stringify(actions),
  );
  assert.ok(actions.includes(`delivery:${out.ids.other}:foreign_merged`));
  const step = (id: string) => out.work.find((row) => row.id === id)?.nextStep;
  assert.equal(step(out.ids.other), "done");
  assert.equal(step(out.ids.first), "delivery");
  assert.equal(step(out.ids.second), "delivery");
});
