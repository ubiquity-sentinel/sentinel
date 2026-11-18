/**
 * The CI rule's reference listing (2026-11-18, third review): the five most
 * recently merged pull requests are proven from the update-sorted listing (a
 * pull request's update time is never before its merge), so comments that
 * push recent merges off the first page can only delay the proof (and past
 * the page bound make the rule wait), never make an older pull request the
 * reference.
 */
import assert from "node:assert/strict";
import {
  collectMergedPullHeads,
  MERGED_PULLS_PAGE,
  MERGED_PULLS_PAGES,
  mergedPullsQuery,
} from "../../src/github/merged-pull-heads.ts";

const sha = (n: number) => n.toString(16).padStart(40, "0");
const day = (d: number) => new Date(Date.UTC(2026, 10, d)).toISOString();

function pull(
  head: number,
  updated: string,
  merged: string | null,
  base = "main",
) {
  return {
    number: head,
    updated_at: updated,
    merged_at: merged,
    base: { ref: base },
    head: { sha: sha(head) },
  };
}

/** `count` closed, unmerged pull requests commented on at `updated`. */
function flood(count: number, updated: string, from = 1000) {
  return Array.from({ length: count }, (_, i) => pull(from + i, updated, null));
}

function pages(...listing: unknown[][]) {
  const read: number[] = [];
  return {
    read,
    fetch: (page: number) => {
      read.push(page);
      return Promise.resolve(listing[page - 1] ?? []);
    },
  };
}

Deno.test("merged heads: a short listing is complete, newest merge first", async () => {
  const listing = pages([
    pull(1, day(9), day(8)),
    pull(2, day(10), day(10)),
    pull(3, day(7), null),
  ]);
  assert.deepEqual(await collectMergedPullHeads(listing.fetch, "main"), {
    heads: [sha(2), sha(1)],
    complete: true,
  });
  assert.deepEqual(mergedPullsQuery("main", 2), {
    state: "closed",
    base: "main",
    sort: "updated",
    direction: "desc",
    per_page: String(MERGED_PULLS_PAGE),
    page: "2",
  });
});

Deno.test("merged heads (third review E): a comment flood cannot make an older merge the reference", async () => {
  // Page 1: an OLD merged pull request someone commented on today, and 29
  // closed unmerged ones flooded the same way. Page 2: the five real recent
  // merges, untouched since.
  const recent = [10, 11, 12, 13, 14].map((d) => pull(d, day(d), day(d)));
  const listing = pages(
    [pull(1, day(17), "2026-01-01T00:00:00Z"), ...flood(29, day(17))],
    [...recent.reverse(), ...flood(MERGED_PULLS_PAGE - 5, day(1), 2000)],
  );
  const proven = await collectMergedPullHeads(listing.fetch, "main");
  assert.deepEqual(proven, {
    heads: [sha(14), sha(13), sha(12), sha(11), sha(10)],
    complete: false,
  });
  assert.deepEqual(listing.read, [1, 2]);
});

Deno.test("merged heads: an unbounded flood or a malformed page proves nothing", async () => {
  const flooded = pages(
    ...Array.from(
      { length: MERGED_PULLS_PAGES + 1 },
      (_, i) => flood(MERGED_PULLS_PAGE, day(17), 1000 + 100 * i),
    ),
  );
  assert.equal(await collectMergedPullHeads(flooded.fetch, "main"), null);
  assert.equal(flooded.read.length, MERGED_PULLS_PAGES);
  for (
    const page of [
      [pull(1, day(9), day(8), "release")],
      [{ ...pull(1, day(9), day(8)), updated_at: "never" }],
      [{ ...pull(1, day(9), day(8)), head: { sha: "short" } }],
      null,
    ]
  ) {
    assert.equal(
      await collectMergedPullHeads(() => Promise.resolve(page), "main"),
      null,
      JSON.stringify(page),
    );
  }
});
