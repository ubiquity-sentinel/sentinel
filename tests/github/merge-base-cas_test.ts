// mergePullRequest base compare-and-swap: the runtime never merges, or books,
// a tree no CI ran on. GitHub's merge API guards only the head and branch
// rules no longer gate a merge (owner directive 2026-10-24), so the port
// re-reads the base branch as the last read before the merge call and books a
// merge only when its commit's parents are exactly [reviewed base, head]
// (live: Passport PRs 154 and 171 merged off their reviewed bases). All
// fixtures are synthetic and no real external service is contacted.
import assert from "node:assert/strict";
import {
  httpRespond,
  mergeResponseWire,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
} from "./helpers.ts";
import {
  BASE_REF_PATH,
  baseTipRead,
  blockedReason,
  commitPath,
  happyScript,
  mergeCall,
  mergedPort,
  mergeParentsRead,
  pullEntry,
  putCount,
} from "./merge-helpers.ts";

const MERGE_PATH = "/repos/ubiquity-sentinel/sentinel/pulls/1/merge";

function mergedPut() {
  return httpRespond("PUT", MERGE_PATH, 200, mergeResponseWire(SHA3));
}

Deno.test("merge base CAS: a base that moved after the review is refused base_mismatch with no merge call", async () => {
  // The pull request still reports the reviewed base (GitHub does not update
  // it when the base branch moves), every gate passes, and the base branch
  // tip is another commit: nothing may merge onto it.
  const { port, transport } = mergedPort(happyScript({
    baseTip: baseTipRead(SHA4),
    extra: [mergedPut()],
  }));
  const result = await mergeCall(port);
  assert.equal(blockedReason(result), "base_mismatch", JSON.stringify(result));
  assert.equal(putCount(transport), 0);
  const reads = transport.requests.map((request) => request.url);
  assert.ok(
    reads.some((url) => url.endsWith(BASE_REF_PATH)),
    "the base branch tip is re-read before the merge call",
  );
});

Deno.test("merge base CAS: an unreadable or missing base branch never merges", async () => {
  const missing = mergedPort(happyScript({
    baseTip: { ...httpRespond("GET", BASE_REF_PATH, 404, {}), repeat: true },
    extra: [mergedPut()],
  }));
  const gone = await mergeCall(missing.port);
  assert.equal(blockedReason(gone), "base_mismatch", JSON.stringify(gone));
  assert.equal(putCount(missing.transport), 0);

  const failing = mergedPort(happyScript({
    baseTip: { ...httpRespond("GET", BASE_REF_PATH, 500, {}), repeat: true },
    extra: [mergedPut()],
  }));
  const unreadable = await mergeCall(failing.port);
  assert.equal(unreadable.ok, false, JSON.stringify(unreadable));
  assert.equal(putCount(failing.transport), 0);
});

Deno.test("merge base CAS: a merge whose commit landed off the reviewed base is reported off-tip, never merged", async () => {
  // The tip moved in the instant between the re-read and the merge call:
  // GitHub merged onto SHA4, so the merged tree is not the one CI tested.
  for (
    const parents of [[SHA4, SHA1], [SHA2], [SHA1, SHA2], [SHA2, SHA1, SHA4]]
  ) {
    const { port, transport } = mergedPort(happyScript({
      parents: mergeParentsRead(SHA3, parents),
      extra: [mergedPut()],
    }));
    const result = await mergeCall(port);
    assert.ok(result.ok, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      outcome: "merged_off_tip",
      head: SHA1,
      mergeSha: SHA3,
      parents,
    });
    assert.equal(putCount(transport), 1);
  }
});

Deno.test("merge base CAS: an unreadable merge commit stays ambiguous, never a booked merge", async () => {
  const { port } = mergedPort(happyScript({
    parents: { ...httpRespond("GET", commitPath(SHA3), 500, {}), repeat: true },
    extra: [mergedPut()],
  }));
  const result = await mergeCall(port);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "ambiguous",
    head: SHA1,
    mergeSha: SHA3,
  });
});

Deno.test("merge base CAS: an already-merged or reconciled merge off the reviewed base is off-tip", async () => {
  const merged = {
    state: "closed",
    merged_at: "2026-09-07T02:00:00Z",
    merge_commit_sha: SHA3,
  };
  // Already merged before this call (an earlier run's lost write).
  const earlier = mergedPort([
    pullEntry(merged),
    mergeParentsRead(SHA3, [SHA4, SHA1]),
  ]);
  const before = await mergeCall(earlier.port);
  assert.ok(before.ok, JSON.stringify(before));
  if (!before.ok) return;
  assert.equal(before.value.outcome, "merged_off_tip");
  assert.equal(putCount(earlier.transport), 0);

  // A lost merge response reconciled against the merged pull request.
  const lost = mergedPort(happyScript({
    parents: mergeParentsRead(SHA3, [SHA4, SHA1]),
    extra: [
      { kind: "throw", method: "PUT", urlPart: MERGE_PATH },
      pullEntry(merged),
    ],
  }));
  const reconciled = await mergeCall(lost.port);
  assert.ok(reconciled.ok, JSON.stringify(reconciled));
  if (!reconciled.ok) return;
  assert.equal(reconciled.value.outcome, "merged_off_tip");

  // A rejected merge call whose re-read finds the pull request merged.
  const rejected = mergedPort(happyScript({
    parents: mergeParentsRead(SHA3, [SHA4, SHA1]),
    extra: [httpRespond("PUT", MERGE_PATH, 409, {}), pullEntry(merged)],
  }));
  const observed = await mergeCall(rejected.port);
  assert.ok(observed.ok, JSON.stringify(observed));
  if (!observed.ok) return;
  assert.equal(observed.value.outcome, "merged_off_tip");

  // Exactly [reviewed base, head] stays the booked merge.
  const exact = mergedPort([pullEntry(merged), mergeParentsRead()]);
  const booked = await mergeCall(exact.port);
  assert.ok(booked.ok, JSON.stringify(booked));
  if (!booked.ok) return;
  assert.deepEqual(booked.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
});
