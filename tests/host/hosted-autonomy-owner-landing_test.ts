/**
 * Owner-landing publication on the launcher side: a published protected-path
 * change is never merged by any delivery path. The delivery pass (here a
 * spent record whose review authorizes delivery) refuses it
 * `owner_merge_required` before any merge gate read, a train never admits it
 * as a member, and the target cycle's progress reporter posts the one owner
 * comment per ready head.
 */
import assert from "node:assert/strict";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import {
  postProgressComments,
  progressChanges,
  progressMarker,
  progressStage,
} from "../../src/host/progress-comments.ts";
import { trainMemberGate } from "../../ops/hosted-autonomy-train-members.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  finding,
  HEAD,
  pullFacts,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot, run } from "./hosted-autonomy-rig.ts";
import { FakeGate } from "./actions-ci-fixture.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const SELF = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
} as const;
const LANDING = { paths: ["src/auth/"], since: 1 };

async function deliverable(ownerLanding: boolean) {
  const record = blockedRecord({
    repository: SELF,
    blocker: {
      kind: "review_quota",
      message: "review rounds exhausted without an accepted verdict (P2)",
      since: 1,
    },
    counters: { attempts: 4, retries: 1, reviewRounds: 3 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      checkpoint: null,
      head: HEAD,
      pr: 51,
    },
  });
  const receipt = authorizingReceipt({
    repository: SELF,
    findings: [finding("P2")],
    unresolvedSeverities: ["P2"],
  });
  return await makeRig("autonomy-owner-landing", {
    repair: repairSnapshot(
      [ownerLanding ? { ...record, ownerLanding: LANDING } : record],
      [receipt],
    ),
    defaultBranch: "development",
    pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
    afterMerge: pullFacts(),
  });
}

Deno.test("owner landing: the delivery pass never merges it and says owner_merge_required", async () => {
  const { rig, github } = await deliverable(true);
  try {
    let listed = 0;
    github.listPullFiles = () => {
      listed++;
      return Promise.resolve(["README.md"]);
    };
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(listed, 0, "refused before any merge gate read");
    assert.ok(
      result.actions.some((action) => action.endsWith(":owner_merge_required")),
      JSON.stringify(result.actions),
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("owner landing: the same record without the flag still merges", async () => {
  const { rig, github } = await deliverable(false);
  try {
    github.listPullFiles = () => Promise.resolve(["README.md"]);
    const result = await run(rig, github);
    assert.equal(rig.merges, 1);
    assert.equal(result.status, "applied");
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});

Deno.test("owner landing: a train never admits it as a member", async () => {
  const record = {
    ...blockedRecord({ repository: SELF }),
    ownerLanding: LANDING,
  };
  const gate = await trainMemberGate(
    {} as never,
    { surface: null } as never,
    record,
    null,
  );
  assert.deepEqual(gate, { refusal: "owner_merge_required" });
});

const BRANCH = "sentinel/repair/issue-1";
function ownerRecord(wait: WorkRecordV1["wait"], head = SHA2): WorkRecordV1 {
  return {
    ...workRecord("issue-1", {
      related: { incidentId: null, issueNumber: 1 },
      nextStep: "delivery",
      target: { base: SHA1, branch: BRANCH, checkpoint: null, head, pr: 1258 },
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
      wait,
    }),
    ownerLanding: { paths: ["ops/", "src/auth/"], since: T0 },
  };
}

const OWNER_WORDS = "Ready for the repository owner to merge: this change " +
  "touches protected path(s) `ops/`, `src/auth/`; Sentinel never merges " +
  "protected paths.";

Deno.test("owner landing: one owner comment per ready head, never a merging claim", async () => {
  const pending = ownerRecord({ reason: "ci_pending", since: T0, until: T0 });
  const ready = ownerRecord({ reason: "manual", since: T0, until: T0 + 10 });
  assert.equal(progressStage(pending), null, "no merging claim before ready");
  assert.equal(progressStage(ready)?.words, OWNER_WORDS);
  const changes = progressChanges([pending], [ready], REPO);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].commentOn, 1258);
  // A later poll of the same head is the same stage: nothing to report.
  const repolled = ownerRecord({ reason: "manual", since: T0, until: T0 + 99 });
  assert.deepEqual(progressChanges([ready], [repolled], REPO), []);
  // An owner push makes a new head: one more comment for that head.
  const pushed = ownerRecord(
    { reason: "manual", since: T0, until: T0 + 9 },
    SHA1,
  );
  assert.equal(progressChanges([ready], [pushed], REPO).length, 1);

  const posts: string[] = [];
  let comments: unknown[] = [];
  const http = (request: HttpRequestV1) => {
    if (request.method === "POST") posts.push(request.body!);
    return Promise.resolve({
      status: request.method === "POST" ? 201 : 200,
      headers: new Headers(),
      bodyText: request.method === "POST" ? "{}" : JSON.stringify(comments),
    });
  };
  const deps = {
    http,
    clock: { now: () => T0 },
    gate: new FakeGate(),
    token: "target-token",
    deadline: T0 + 3_600_000,
    log: () => {},
  };
  const config = { repository: REPO } as unknown as RepositoryConfigV1;
  const first = await postProgressComments(deps, config, changes);
  assert.equal(first.posted, 1);
  const body = JSON.parse(posts[0]!).body as string;
  assert.ok(body.startsWith(OWNER_WORDS));
  assert.ok(
    body.endsWith(progressMarker("issue-1", `owner_merge:1258:${SHA2}`)),
  );
  // A re-run of the same cycle finds its own marker and posts nothing.
  comments = [{ body }];
  const again = await postProgressComments(deps, config, changes);
  assert.equal(again.skipped, 1);
  assert.equal(posts.length, 1);
});
