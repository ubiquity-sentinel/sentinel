/**
 * A Sentinel-repository pull request that changes a protected path waits for
 * its owner's merge (owner-landing), and the trusted host's progress reporter
 * says so on the pull request: the real repair loop moves the reviewed,
 * CI-green record to its `owner_merge` wait inside the target cycle, and the
 * real stage diff and poster turn that change into exactly one "Ready for
 * the repository owner to merge" comment.
 */
import assert from "node:assert/strict";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import {
  postProgressComments,
  progressChanges,
  progressMarker,
} from "../../src/host/progress-comments.ts";
import { FakeGate } from "./actions-ci-fixture.ts";
import { REPO_2 } from "../budget/helpers.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";
import { makeRig, seededSnapshot } from "../repair/loop-rig.ts";
import { positiveLifecycle } from "../repair/loop-candidate-fixtures.ts";

const ISSUE = 41;
const TASK = asWorkItemId(`issue-${ISSUE}`);

Deno.test("owner landing progress: a reviewed Sentinel protected PR posts one ready-for-owner comment", async () => {
  const rig = await makeRig("ownerlandingprogress", {
    summaries: false,
    configOverrides: {
      repository: REPO_2,
      protectedPaths: ["src/auth/"],
    },
    model: { changedPaths: ["src/app.ts", "src/auth/session.ts"] },
    github: { candidateLifecycle: positiveLifecycle() },
  });
  try {
    const seeded = await rig.store.writeRepair(
      seededSnapshot([workRecord(TASK, {
        repository: REPO_2,
        source: { kind: "issue", id: String(ISSUE), revision: SHA1 },
        related: { incidentId: null, issueNumber: ISSUE },
        target: {
          base: SHA1,
          branch: candidateBranch(TASK),
          checkpoint: null,
          head: null,
          pr: null,
        },
        nextStep: "work",
      })]),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    await rig.run();
    const before = (await rig.snapshot()).work;
    assert.equal(before[0].nextStep, "review", JSON.stringify(before[0]));
    assert.deepEqual(before[0].ownerLanding?.paths, ["src/auth/"]);
    rig.clock.advance(100_000_000 + 1);
    rig.github.completeReview([], rig.clock.now());
    await rig.run();
    const after = (await rig.snapshot()).work;
    assert.equal(after[0].nextStep, "delivery");
    assert.equal(after[0].wait?.reason, "manual", "waits for the owner");
    assert.equal(rig.github.calls.filter((c) => c === "merge").length, 0);

    const changes = progressChanges(before, after, REPO_2);
    assert.equal(changes.length, 1, JSON.stringify(changes));
    const pr = after[0].target.pr!;
    assert.equal(changes[0].commentOn, pr);
    assert.equal(
      changes[0].stage.key,
      `owner_merge:${pr}:${after[0].target.head}`,
    );
    const sent: { method: string; path: string; body: string | null }[] = [];
    const http = (request: HttpRequestV1) => {
      sent.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.body,
      });
      return Promise.resolve({
        status: request.method === "GET" ? 200 : 201,
        headers: new Headers(),
        bodyText: request.method === "GET" ? "[]" : "{}",
      });
    };
    const report = await postProgressComments(
      {
        http,
        clock: { now: () => T0 },
        gate: new FakeGate(),
        token: "target-token",
        deadline: T0 + 3_600_000,
        log: () => {},
      },
      { repository: REPO_2 } as unknown as RepositoryConfigV1,
      changes,
    );
    assert.equal(report.posted, 1);
    const posts = sent.filter((row) => row.method === "POST");
    assert.equal(posts.length, 1);
    assert.equal(
      posts[0].path,
      `/repos/${REPO_2.owner}/${REPO_2.name}/issues/${pr}/comments`,
    );
    const body = JSON.parse(posts[0].body!).body as string;
    assert.ok(
      body.startsWith(
        "Ready for the repository owner to merge: this change touches " +
          "protected path(s) `src/auth/`; Sentinel never merges protected paths.",
      ),
      body,
    );
    assert.ok(body.endsWith(progressMarker(TASK, changes[0].stage.key)));
    // The next poll re-reads the still-open PR and reports nothing new.
    rig.clock.advance(60 * 60_000);
    await rig.run();
    assert.deepEqual(
      progressChanges(after, (await rig.snapshot()).work, REPO_2),
      [],
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
