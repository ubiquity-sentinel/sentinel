/**
 * The launcher's follow-up issue capability over the real GitHub port with a
 * fake fetch (exact paths, the completeness proof of the created-since
 * listing and the exact identity checks of every answer), the moved-base
 * reads of the spent rule (`mergeable`, `baseAdvanced`), and the follow-up
 * rendering bounds and inertness.
 */
import assert from "node:assert/strict";
import {
  checkReviewTaskStatement,
  parseReviewReceiptV1,
  type ReviewFindingV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { parseHostedAutonomyPull } from "../../ops/hosted-autonomy-github-pull.ts";
import {
  FOLLOW_UP_MAX_BODY_CHARS,
  FOLLOW_UP_MAX_FINDINGS,
  followUpMarker,
  parseFollowUpMarker,
  planFollowUpCandidates,
  renderFollowUpIssue,
} from "../../ops/hosted-autonomy-follow-ups.ts";
import {
  allLiveReceipts,
  APP,
  GATEWAY,
  HOSTILE,
  liveRecord,
  liveRequest,
  liveSnapshot,
  NOW,
} from "./hosted-autonomy-spent-fixtures.ts";

const REPO_URL = "https://api.github.com/repos/ubiquity/ai.ubq.fi";
const LISTING =
  "/repos/ubiquity/ai.ubq.fi/issues?state=all&sort=created&direction=desc&per_page=100&page=";

interface CallV1 {
  method: string;
  path: string;
  body: unknown;
}

async function withFetch<T>(
  handler: (call: CallV1) => unknown,
  body: (calls: CallV1[]) => Promise<T>,
): Promise<T> {
  const calls: CallV1[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: init?.body === undefined
        ? undefined
        : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const payload = handler(call);
    return Promise.resolve(
      payload === undefined
        ? new Response("{}", { status: 404 })
        : new Response(JSON.stringify(payload), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    return await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const port = () => createHostedAutonomyGitHub("fixture-token", GATEWAY);
const created = (offsetMinutes: number) =>
  new Date(NOW - offsetMinutes * 60_000).toISOString().replace(".000", "");

function item(
  number: number,
  minutesAgo: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    number,
    repository_url: REPO_URL,
    user: { login: APP },
    created_at: created(minutesAgo),
    body: `<!-- line ${number} -->\r\nrest`,
    ...overrides,
  };
}

/** `count` items, newest first, starting `start` minutes ago. */
function page(first: number, count: number, start: number) {
  return Array.from(
    { length: count },
    (_, index) => item(first - index, start + index),
  );
}

Deno.test("follow-up port: created-since listing returns an ordered bounded prefix", async (t) => {
  const pageNo = (call: CallV1) =>
    Number(new URL(`https://x${call.path}`).searchParams.get("page"));
  await t.step("a short page completes the listing", async () => {
    await withFetch(
      (call) => call.path === `${LISTING}1` ? page(500, 3, 1) : undefined,
      async (calls) => {
        const listing = await port().followUpIssues!.listCreatedSince({
          sinceMs: NOW - 3_600_000,
          maxPages: 5,
        });
        assert.equal(listing?.length, 3);
        assert.deepEqual(listing?.[0], {
          number: 500,
          author: APP,
          createdAt: Date.parse(created(1)),
          pullRequest: false,
          firstLine: "<!-- line 500 -->",
        });
        assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
          `GET ${LISTING}1`,
        ]);
      },
    );
  });
  await t.step(
    "full pages continue until an item older than since",
    async () => {
      await withFetch(
        (call) =>
          page(1000 - (pageNo(call) - 1) * 100, 100, (pageNo(call) - 1) * 100),
        async (calls) => {
          const listing = await port().followUpIssues!.listCreatedSince({
            sinceMs: NOW - 150 * 60_000,
            maxPages: 5,
          });
          assert.equal(listing?.length, 200);
          assert.equal(calls.length, 2);
        },
      );
    },
  );
  await t.step("the page cap returns its verified prefix", async () => {
    await withFetch(
      (call) =>
        page(1000 - (pageNo(call) - 1) * 100, 100, (pageNo(call) - 1) * 100),
      async (calls) => {
        const listing = await port().followUpIssues!.listCreatedSince({
          sinceMs: NOW - 300 * 60_000,
          maxPages: 2,
        });
        assert.equal(listing?.length, 200);
        assert.equal(listing?.at(-1)?.createdAt, Date.parse(created(199)));
        assert.equal(calls.length, 2);
      },
    );
  });
  const refusals: [string, (call: CallV1) => unknown][] = [
    ["out of order", () => [item(3, 5), item(2, 1)]],
    ["duplicate", () => [item(3, 1), item(3, 2)]],
    [
      "foreign repository",
      () => [
        item(3, 1, {
          repository_url: "https://api.github.com/repos/ubiquity/other",
        }),
      ],
    ],
    ["malformed creation instant", () => [item(3, 1, { created_at: "1" })]],
    ["no creator", () => [item(3, 1, { user: null })]],
    ["not a list", () => ({ items: [] })],
    ["unreadable", () => undefined],
  ];
  for (const [name, handler] of refusals) {
    await t.step(name, async () => {
      await withFetch(handler, async () => {
        assert.equal(
          await port().followUpIssues!.listCreatedSince({
            sinceMs: NOW - 3 * 3_600_000,
            maxPages: 2,
          }),
          null,
        );
      });
    });
  }
  await t.step("a pull request is listed as one", async () => {
    await withFetch(
      () => [item(9, 1, { pull_request: { url: "x" } })],
      async () => {
        const listing = await port().followUpIssues!.listCreatedSince({
          sinceMs: NOW - 3_600_000,
          maxPages: 1,
        });
        assert.equal(listing?.[0].pullRequest, true);
      },
    );
  });
});

Deno.test("follow-up port: one issue's origin and the create answer are bound to exact identities", async (t) => {
  await t.step("origin", async () => {
    await withFetch(
      (call) => call.path.endsWith("/issues/600") ? item(600, 9) : item(7, 9),
      async () => {
        assert.deepEqual(await port().followUpIssues!.readIssueOrigin(600), {
          number: 600,
          author: APP,
          firstLine: "<!-- line 600 -->",
        });
        assert.equal(await port().followUpIssues!.readIssueOrigin(601), null);
      },
    );
    await withFetch(
      () => item(600, 9, { pull_request: {} }),
      async () => {
        assert.equal(await port().followUpIssues!.readIssueOrigin(600), null);
      },
    );
  });
  const input = {
    title: "Review follow-ups from #1: 1 P2/P3 finding",
    body: "<!-- m -->\nbody",
  };
  const answer = (overrides: Record<string, unknown> = {}) =>
    item(77, 0, { title: input.title, body: input.body, ...overrides });
  await t.step("an exact echo by the App is the new number", async () => {
    await withFetch(() => answer(), async (calls) => {
      assert.equal(await port().followUpIssues!.create(input), 77);
      assert.deepEqual(calls, [{
        method: "POST",
        path: "/repos/ubiquity/ai.ubq.fi/issues",
        body: { title: input.title, body: input.body },
      }]);
    });
  });
  for (
    const [name, labels, expected] of [
      ["matching opt-out echo", [{ name: "sentinel:skip" }], 77],
      ["missing opt-out echo", undefined, null],
      ["wrong opt-out echo", [{ name: "other" }], null],
      ["malformed opt-out echo", ["sentinel:skip"], null],
    ] as const
  ) {
    await t.step(name, async () => {
      await withFetch(() => answer({ labels }), async (calls) => {
        assert.equal(
          await port().followUpIssues!.create({
            ...input,
            labels: ["sentinel:skip"],
          }),
          expected,
        );
        assert.deepEqual(calls[0].body, {
          ...input,
          labels: ["sentinel:skip"],
        });
      });
    });
  }
  const refusals: [string, Record<string, unknown>][] = [
    ["another creator", { user: { login: "github-actions[bot]" } }],
    ["another repository", {
      repository_url: "https://api.github.com/repos/ubiquity-sentinel/sentinel",
    }],
    ["a pull request", { pull_request: {} }],
    ["a changed title", { title: "other" }],
    ["a changed body", { body: "<!-- m -->\r\nbody" }],
    ["no number", { number: 0 }],
  ];
  for (const [name, overrides] of refusals) {
    await t.step(name, async () => {
      await withFetch(() => answer(overrides), async () => {
        assert.equal(await port().followUpIssues!.create(input), null);
      });
    });
  }
});

Deno.test("follow-up port: only the listing, one issue read and the issue create are ever called", async () => {
  await withFetch(
    (call) =>
      call.method === "POST"
        ? item(77, 0, { title: "t", body: "b" })
        : call.path.startsWith(LISTING)
        ? []
        : item(600, 1),
    async (calls) => {
      const issues = port().followUpIssues!;
      await issues.listCreatedSince({ sinceMs: NOW, maxPages: 5 });
      await issues.readIssueOrigin(600);
      await issues.create({ title: "t", body: "b" });
      assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), [
        `GET ${LISTING}1`,
        "GET /repos/ubiquity/ai.ubq.fi/issues/600",
        "POST /repos/ubiquity/ai.ubq.fi/issues",
      ]);
    },
  );
});

Deno.test("spent delivery port: mergeability and the moved base are read, never guessed", async (t) => {
  const raw = (mergeable: unknown) => ({
    number: 1071,
    state: "open",
    merged: false,
    merge_commit_sha: null,
    head: { sha: "a".repeat(40) },
    base: { ref: "development", sha: "b".repeat(40) },
    user: { login: APP },
    ...(mergeable === "absent" ? {} : { mergeable }),
  });
  await t.step("mergeable", () => {
    assert.equal(parseHostedAutonomyPull(raw(true))?.mergeable, true);
    assert.equal(parseHostedAutonomyPull(raw(false))?.mergeable, false);
    assert.equal(parseHostedAutonomyPull(raw(null))?.mergeable, null);
    assert.equal(
      parseHostedAutonomyPull(raw("absent"))?.mergeable,
      undefined,
      "absent proves nothing (and is never merged onto a moved base)",
    );
    assert.equal(parseHostedAutonomyPull(raw("yes"))?.mergeable, null);
  });
  const base = "b".repeat(40);
  const tip = "c".repeat(40);
  const compare = (status: string, at = base) => ({
    status,
    base_commit: { sha: at },
    merge_base_commit: { sha: at },
  });
  const cases: [string, unknown, boolean][] = [
    ["ahead", compare("ahead"), true],
    ["identical", compare("identical"), false],
    ["behind", compare("behind"), false],
    ["diverged", compare("diverged"), false],
    ["another merge base", compare("ahead", "d".repeat(40)), false],
    ["unreadable", undefined, false],
  ];
  for (const [name, answer, expected] of cases) {
    await t.step(name, async () => {
      await withFetch(() => answer, async (calls) => {
        assert.equal(await port().baseAdvanced!(base, tip), expected);
        assert.deepEqual(calls.map((call) => call.path), [
          `/repos/ubiquity/ai.ubq.fi/compare/${base}...${tip}`,
        ]);
      });
    });
  }
  await t.step("the same commit is never advanced", async () => {
    await withFetch(() => compare("ahead"), async (calls) => {
      assert.equal(await port().baseAdvanced!(base, base), false);
      assert.equal(calls.length, 0);
    });
  });
});

/** The live PR 1052 candidate with its findings replaced. */
function candidateWith(findings: ReviewFindingV1[]) {
  const request = liveRequest(1052);
  const reviews = allLiveReceipts().map((review) =>
    review.id === request.source.reviewReceiptId
      ? parseReviewReceiptV1({
        ...review,
        findings,
        unresolvedSeverities: [
          ...new Set(
            findings.filter((f) => !f.resolved).map((f) => f.severity),
          ),
        ],
      })
      : review
  );
  const [candidate] = planFollowUpCandidates(
    liveSnapshot([liveRecord(600)], reviews, [request]),
    NOW,
  );
  return candidate;
}

function finding(
  index: number,
  severity: "P0" | "P1" | "P2" | "P3",
  message: string,
  path: string | null = `src/f${index}.ts`,
  resolved = false,
): ReviewFindingV1 {
  return {
    id: `finding-${index}`,
    fingerprint: index.toString(16).padStart(
      64,
      "0",
    ) as ReviewFindingV1["fingerprint"],
    severity,
    path,
    message,
    resolved,
    resolutionEvidence: resolved
      ? { authorizingIdentity: APP, reference: `thread-${index}` }
      : null,
  };
}

Deno.test("follow-up render: bounded body, deterministic overflow, only open P1/P2/P3", () => {
  const many = Array.from({ length: 25 }, (_, index) =>
    finding(
      index,
      index % 2 === 0 ? "P3" : "P2",
      `[P2] t${index}\n\n${"z".repeat(3000)}\n\nsrc/f${index}.ts:${index + 1}-${
        index + 3
      }`,
    ));
  const issue = renderFollowUpIssue({
    candidate: candidateWith(many),
    mergeRevision: "8a99ecbeaf8fd5f845fd6be034e284dd370f332c",
    depth: 1,
  })!;
  assert.ok(
    issue.body.length <= FOLLOW_UP_MAX_BODY_CHARS,
    `${issue.body.length}`,
  );
  assert.ok(issue.listed > 0 && issue.listed < FOLLOW_UP_MAX_FINDINGS);
  assert.equal(issue.listed + issue.omitted, 25);
  assert.ok(
    issue.body.includes(
      `\n${issue.omitted} more findings are recorded only in review receipt`,
    ),
  );
  assert.equal(
    issue.title,
    "Review follow-ups from #1052: 25 P1/P2/P3 findings",
  );
  // Every P2 is listed before any P3, in a stable order.
  const severities = [...issue.body.matchAll(/^### \d+\. (P[23]) at /gm)].map((
    m,
  ) => m[1]);
  assert.deepEqual(severities, [...severities].sort());
  assert.ok(issue.body.includes("[truncated]"));

  const mixed = candidateWith([
    finding(1, "P2", "[P2] open\n\nsrc/f1.ts:3"),
    finding(2, "P3", "[P3] resolved", "src/f2.ts", true),
  ]);
  const rendered = renderFollowUpIssue({
    candidate: mixed,
    mergeRevision: "8a99ecbeaf8fd5f845fd6be034e284dd370f332c",
    depth: 2,
  })!;
  assert.equal(rendered.listed, 1);
  assert.ok(
    !rendered.body.includes("[P3] resolved"),
    "a resolved finding is never listed",
  );
  assert.ok(rendered.body.includes("[`src/f1.ts:3`]("));
  assert.ok(rendered.body.includes("#L3-L3)"));
  assert.ok(rendered.body.startsWith(
    followUpMarker({
      owner: "ubiquity",
      name: "ai.ubq.fi",
      pullRequest: 1052,
      receiptId: mixed.receipt.id,
      depth: 2,
    })!,
  ));
  assert.equal(
    candidateWith([finding(1, "P0", "[P0] blocks")]),
    undefined,
    "a P0 review is never a candidate",
  );
  // Owner directive 2026-10-24: a P1 no longer blocks the merge, so a merged
  // PR's unresolved P1 is follow-up work like a P2/P3.
  assert.notEqual(
    candidateWith([finding(1, "P1", "[P1] follow-up")]),
    undefined,
    "an unresolved P1 is filed as follow-up work",
  );
  assert.equal(
    renderFollowUpIssue({ candidate: mixed, mergeRevision: "x", depth: 1 }),
    null,
  );
  assert.equal(
    renderFollowUpIssue({
      candidate: mixed,
      mergeRevision: "8a99ecbeaf8fd5f845fd6be034e284dd370f332c",
      depth: 4,
    }),
    null,
  );
});

Deno.test("follow-up render: the reviewer's text is inert and the issue stays admissible", async () => {
  const issue = renderFollowUpIssue({
    candidate: candidateWith([finding(1, "P3", HOSTILE, "src/a b.ts")]),
    mergeRevision: "8a99ecbeaf8fd5f845fd6be034e284dd370f332c",
    depth: 1,
  })!;
  const body = issue.body;
  assert.ok(!/@(?!\u200b)/.test(body), "no live mention");
  assert.ok(!/^[ \t]*\//m.test(body), "no line-leading slash command");
  assert.ok(
    !/#(?=[0-9])/.test(
      body.split("\n").slice(1).join("\n").replace(/#1052|#600/g, ""),
    ),
    "no live issue reference",
  );
  assert.ok(
    // deno-lint-ignore no-control-regex
    !/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/.test(body),
    "no control character",
  );
  assert.ok(!body.includes("\r"));
  assert.ok(
    body.includes("(unlinked location)"),
    "an unsafe path is never linked",
  );
  assert.ok(
    body.includes("\n~~~~text\n"),
    "the fence outlasts every tilde run",
  );
  assert.ok(
    body.split("\n", 1)[0].startsWith("<!-- sentinel:review-followup:v1 "),
  );
  assert.equal(parseFollowUpMarker(body.split("\n", 1)[0])?.pullRequest, 1052);
  const statement = { issueNumber: 9999, title: issue.title, body };
  const checked = await checkReviewTaskStatement({
    ...statement,
    digest: await reviewTaskStatementDigest(statement),
  });
  assert.ok(checked.ok);
});
