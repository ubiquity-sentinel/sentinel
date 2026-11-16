/**
 * Live 2026-11-16: PR #417, merged by the self-merge executor in supervisor
 * run 43933165392, waits at the delivery step (the release path is disabled
 * by owner policy), and its last progress comment still said "Sentinel is
 * merging pull request #417". A record whose executor receipt records the
 * pull request as merged now says it was merged, once, through the existing
 * done wording and key; records merged earlier get no retroactive comment.
 */
import assert from "node:assert/strict";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import {
  postProgressComments,
  progressChanges,
  progressMarker,
  progressStage,
} from "../../src/host/progress-comments.ts";
import { T0 } from "../state/helpers.ts";
import { FakeGate } from "./actions-ci-fixture.ts";
import {
  SELF_REPOSITORY,
  selfDeliveryRecord,
  selfMergeReceipt,
} from "./self-merge-receipt-fixture.ts";

const CONFIG = { repository: SELF_REPOSITORY } as unknown as RepositoryConfigV1;
const MERGED_WORDS = "Merged in #417; this repair is done.";
const MERGING_WORDS =
  "The review passed; Sentinel is merging pull request #417.";

/** The review passed; the merge has not landed yet. */
const merging = selfDeliveryRecord(417, null);
/** The executor merged #417; the record waits at delivery for its release. */
const merged = selfDeliveryRecord(417, selfMergeReceipt(417));

function fakeHttp(comments: unknown[]) {
  const sent: Array<{ method: string; path: string; body: string | null }> = [];
  const http = (request: HttpRequestV1) => {
    sent.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: request.body,
    });
    return Promise.resolve({
      status: request.method === "GET" ? 200 : 201,
      headers: new Headers(),
      bodyText: request.method === "GET" ? JSON.stringify(comments) : "{}",
    });
  };
  return { http, sent };
}

function deps(http: ReturnType<typeof fakeHttp>["http"]) {
  return {
    http,
    clock: { now: () => T0 },
    gate: new FakeGate(),
    token: "self-token",
    deadline: T0 + 3_600_000,
    log: () => {},
  };
}

Deno.test("progress: a self-merged record waiting at delivery says it was merged", () => {
  assert.equal(progressStage(merging)?.words, MERGING_WORDS);
  assert.deepEqual(progressStage(merged), {
    key: "done:417",
    words: MERGED_WORDS,
  });
  // The same stage as the done step it would later reach.
  const done = selfDeliveryRecord(417, selfMergeReceipt(417), {
    nextStep: "done",
  });
  assert.deepEqual(progressStage(done), progressStage(merged));
});

Deno.test("progress: the executor's merge posts exactly one merged comment on the pull request", async () => {
  const changes = progressChanges([merging], [merged], SELF_REPOSITORY);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].commentOn, 417);
  // The pull request's latest marker is the earlier "merging" comment.
  const { http, sent } = fakeHttp([{
    body: `${MERGING_WORDS}\n\n${progressMarker(merged.id, "delivery:417")}`,
  }]);
  const report = await postProgressComments(deps(http), CONFIG, changes);
  assert.equal(report.posted, 1);
  const posts = sent.filter((row) => row.method === "POST");
  assert.deepEqual(posts.map((row) => row.path), [
    "/repos/ubiquity-sentinel/sentinel/issues/417/comments",
  ]);
  assert.equal(
    JSON.parse(posts[0].body!).body,
    `${MERGED_WORDS}\n\n${progressMarker(merged.id, "done:417")}`,
  );
  // A rerun of the same cycle finds its own marker and posts nothing.
  const again = fakeHttp([{
    body: `${MERGED_WORDS}\n\n${progressMarker(merged.id, "done:417")}`,
  }]);
  const rerun = await postProgressComments(deps(again.http), CONFIG, changes);
  assert.equal(rerun.skipped, 1);
  assert.equal(again.sent.filter((row) => row.method === "POST").length, 0);
});

Deno.test("progress: records merged before this rule get no retroactive comment", async () => {
  // 28 records already merged and waiting at delivery, read before and after
  // the first cycle on this runtime (rewritten meanwhile: a newer updatedAt).
  const waiting = Array.from(
    { length: 28 },
    (_, i) => selfDeliveryRecord(380 + i, selfMergeReceipt(380 + i)),
  );
  const rewritten = waiting.map((record) => ({
    ...record,
    updatedAt: record.updatedAt + 300_000,
  }));
  const changes = progressChanges(waiting, rewritten, SELF_REPOSITORY);
  assert.deepEqual(changes, []);
  const { http, sent } = fakeHttp([]);
  const report = await postProgressComments(deps(http), CONFIG, changes);
  assert.equal(report.posted, 0);
  assert.equal(sent.length, 0, "no comment is read or posted");
  // Reaching the done step later repeats nothing either.
  const done = waiting.map((record) => ({
    ...record,
    nextStep: "done" as const,
  }));
  assert.deepEqual(progressChanges(waiting, done, SELF_REPOSITORY), []);
});

Deno.test("progress: a receipt that saw the pull request closed keeps the delivery words", () => {
  // Only a receipt recording the pull request as merged changes the words.
  const closed = selfDeliveryRecord(417, selfMergeReceipt(417, "closed"));
  assert.equal(progressStage(closed)?.words, MERGING_WORDS);
  assert.deepEqual(progressChanges([merging], [closed], SELF_REPOSITORY), []);
});
