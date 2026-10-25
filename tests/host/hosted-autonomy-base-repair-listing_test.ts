/**
 * The base-repair issue capability over the REAL launcher surface and a
 * stubbed `fetch` (review finding of 2026-10-25: one unfiltered page of 100
 * open issues with no author check). The dedupe reads every issue the
 * sentinel App created, open or closed, page by page to a short last page;
 * another creator, a repeated item, a malformed item or a full page at the
 * bound refuses the whole listing. The create sends no label.
 */
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { BASE_REPAIR_LISTING_MAX_PAGES } from "../../ops/hosted-autonomy-github-issues.ts";
import { GATEWAY } from "./hosted-autonomy-spent-fixtures.ts";

const APP = "ubiquity-sentinel[bot]";
const REPO_URL =
  `https://api.github.com/repos/${GATEWAY.owner}/${GATEWAY.name}`;

function item(
  number: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number,
    state: "open",
    user: { login: APP },
    repository_url: REPO_URL,
    created_at: "2026-10-25T10:00:00Z",
    body: `first line of #${number}\nmore`,
    ...overrides,
  };
}

/** Runs `body` with `fetch` answering listing page N with `pages[N-1]`. */
async function withPages<T>(
  pages: unknown[],
  body: () => Promise<T>,
  requested: { url: string; method: string; body: unknown }[] = [],
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const page = /[?&]page=(\d+)/.exec(url);
    const answer = init?.method === "POST"
      ? item(77, { title: "t", body: "b" })
      : page === null
      ? 404
      : pages[Number(page[1]) - 1] ?? [];
    return Promise.resolve(
      typeof answer === "number"
        ? new Response("{}", { status: answer })
        : new Response(JSON.stringify(answer), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const issues = () =>
  createHostedAutonomyGitHub("token", GATEWAY).baseRepairIssues!;
const full = (from: number) =>
  Array.from({ length: 100 }, (_, index) => item(from + index));

Deno.test("base repair listing: every App-created issue, open or closed, to a short last page", async () => {
  const requested: { url: string; method: string; body: unknown }[] = [];
  const listed = await withPages(
    [full(1), [
      item(101, { state: "closed" }),
      item(102, { pull_request: {} }),
    ]],
    () => issues().listAppAuthored(),
    requested,
  );
  assert.ok(listed !== null);
  assert.equal(listed.length, 102);
  assert.deepEqual(listed[100], {
    number: 101,
    state: "closed",
    pullRequest: false,
    firstLine: "first line of #101",
  });
  assert.equal(listed[101].pullRequest, true);
  assert.deepEqual(
    requested.map((request) => request.url),
    [1, 2].map((page) =>
      `${REPO_URL}/issues?creator=ubiquity-sentinel%5Bbot%5D&state=all&sort=created&direction=asc&per_page=100&page=${page}`
    ),
  );
});

Deno.test("base repair listing: another creator, a repeat, a malformed item or no proven end refuses it", async () => {
  const cases: [string, unknown[]][] = [
    ["another creator", [[item(1, { user: { login: "someone" } })]]],
    ["a repeat across pages", [full(1), [item(100)]]],
    ["an unknown state", [[item(1, { state: "merged" })]]],
    ["another repository", [[item(1, { repository_url: `${REPO_URL}x` })]]],
    ["not a list", [{ message: "Not Found" }]],
    [
      "a full page at the bound",
      Array.from(
        { length: BASE_REPAIR_LISTING_MAX_PAGES },
        (_, page) => full(page * 100 + 1),
      ),
    ],
  ];
  for (const [label, pages] of cases) {
    assert.equal(
      await withPages(pages, () => issues().listAppAuthored()),
      null,
      label,
    );
  }
});

Deno.test("base repair listing: the create sends no label", async () => {
  const requested: { url: string; method: string; body: unknown }[] = [];
  const number = await withPages(
    [],
    () => issues().create({ title: "t", body: "b" }),
    requested,
  );
  assert.equal(number, 77);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].method, "POST");
  assert.deepEqual(requested[0].body, { title: "t", body: "b" });
});
