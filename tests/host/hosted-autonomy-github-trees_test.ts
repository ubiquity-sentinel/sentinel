/**
 * The carried merge's exact patch proof over GitHub's Git data (round-2
 * recheck P3): the change set of a head against its merge base is read from
 * the recursive Git trees (full blob ids, modes, no rename folding), so two
 * binary payloads whose abbreviated ids collide, a mode change or a base
 * change under a changed path all differ, and a tree GitHub truncates or any
 * unreadable answer is no proof. Driven through the real launcher surface
 * (`createHostedAutonomyGitHub`) over a stubbed `fetch`.
 */
import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy.ts";
import {
  parseRecursiveTree,
  sameTreeChanges,
  treeChanges,
} from "../../ops/hosted-autonomy-github-trees.ts";
import { jsonResponse } from "./hosted-autonomy-fixtures.ts";

const GATEWAY = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
const id = (digit: string) => digit.repeat(40);
const BASE = id("1");
const HEAD = id("2");
const MERGE_BASE = id("3");
const BASE_TREE = id("4");
const HEAD_TREE = id("5");

type Row = { path: string; mode: string; type: string; sha: string };

function tree(sha: string, rows: Row[], truncated = false) {
  return { sha, url: "x", tree: rows, truncated };
}

const README = {
  path: "README.md",
  mode: "100644",
  type: "blob",
  sha: id("a"),
};
const DIR = { path: "static", mode: "040000", type: "tree", sha: id("b") };
const ICON = {
  path: "static/favicon.png",
  mode: "100644",
  type: "blob",
  sha: "f1c05210ef4eef2c3e8027822dc3d690879d7702",
};
const SUBMODULE = {
  path: "vendor/lib",
  mode: "160000",
  type: "commit",
  sha: id("c"),
};

/** Answers for one `base...head` proof; `trees` maps tree id -> body. */
async function withGitHub<T>(
  trees: Record<string, unknown>,
  body: (
    surface: ReturnType<typeof createHostedAutonomyGitHub>,
    urls: string[],
  ) => Promise<T>,
  compare: unknown = {
    status: "ahead",
    merge_base_commit: {
      sha: MERGE_BASE,
      commit: { tree: { sha: BASE_TREE } },
    },
  },
): Promise<T> {
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    const path = new URL(url).pathname;
    if (path.endsWith(`/compare/${BASE}...${HEAD}`)) {
      return Promise.resolve(jsonResponse(compare));
    }
    if (path.endsWith(`/git/commits/${HEAD}`)) {
      return Promise.resolve(
        jsonResponse({ sha: HEAD, tree: { sha: HEAD_TREE } }),
      );
    }
    const match = /\/git\/trees\/([0-9a-f]{40})$/.exec(path);
    if (match !== null && match[1] in trees) {
      return Promise.resolve(jsonResponse(trees[match[1]]));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;
  try {
    return await body(
      createHostedAutonomyGitHub("fixture-token", GATEWAY),
      urls,
    );
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("carried tree proof: the change set of a head against its merge base, by path, mode and full blob id", async () => {
  const changed = await withGitHub(
    {
      [BASE_TREE]: tree(BASE_TREE, [README, DIR, SUBMODULE]),
      [HEAD_TREE]: tree(HEAD_TREE, [
        { ...README, mode: "100755" },
        DIR,
        ICON,
      ]),
    },
    async (surface, urls) => {
      const result = await surface.mergeBaseTreeChanges!(BASE, HEAD);
      // Only the ai.ubq.fi repository's own paths are read, recursively.
      for (const url of urls) {
        assert.ok(
          url.startsWith("https://api.github.com/repos/ubiquity/ai.ubq.fi/"),
        );
      }
      assert.ok(
        urls.some((url) => url.endsWith(`/git/trees/${HEAD_TREE}?recursive=1`)),
      );
      return result;
    },
  );
  assert.deepEqual(changed, {
    mergeBase: MERGE_BASE,
    changes: [
      {
        path: "README.md",
        oldMode: "100644",
        oldSha: id("a"),
        newMode: "100755",
        newSha: id("a"),
      },
      {
        path: "static/favicon.png",
        oldMode: null,
        oldSha: null,
        newMode: "100644",
        newSha: ICON.sha,
      },
      {
        path: "vendor/lib",
        oldMode: "160000",
        oldSha: id("c"),
        newMode: null,
        newSha: null,
      },
    ],
  });
});

Deno.test("carried tree proof: a truncated, foreign, malformed or unreadable answer is no proof", async (t) => {
  const good = {
    [BASE_TREE]: tree(BASE_TREE, [README]),
    [HEAD_TREE]: tree(HEAD_TREE, [README, ICON]),
  };
  const cases: [string, Record<string, unknown>, unknown?][] = [
    ["a truncated tree", {
      ...good,
      [HEAD_TREE]: tree(HEAD_TREE, [README, ICON], true),
    }],
    ["a tree without the truncation flag", {
      ...good,
      [HEAD_TREE]: { sha: HEAD_TREE, tree: [README, ICON] },
    }],
    ["another tree's answer", {
      ...good,
      [HEAD_TREE]: tree(id("9"), [README]),
    }],
    ["an abbreviated blob id", {
      ...good,
      [HEAD_TREE]: tree(HEAD_TREE, [README, { ...ICON, sha: "f1c05210e" }]),
    }],
    ["a mode that does not match its type", {
      ...good,
      [HEAD_TREE]: tree(HEAD_TREE, [README, { ...ICON, mode: "160000" }]),
    }],
    ["a duplicated path", {
      ...good,
      [HEAD_TREE]: tree(HEAD_TREE, [README, README]),
    }],
    ["an unreadable tree", { [BASE_TREE]: good[BASE_TREE] }],
    ["a compare without its merge base", good, { status: "ahead" }],
  ];
  for (const [name, trees, compare] of cases) {
    await t.step(name, async () => {
      const result = await withGitHub(
        trees,
        (surface) => surface.mergeBaseTreeChanges!(BASE, HEAD),
        compare,
      );
      assert.equal(result, null);
    });
  }
  await t.step("an abbreviated revision is never asked for", async () => {
    await withGitHub(good, async (surface, urls) => {
      assert.equal(await surface.mergeBaseTreeChanges!("1111111", HEAD), null);
      assert.deepEqual(urls, []);
    });
  });
});

Deno.test("carried tree proof: payloads that render alike, a mode change and a base change under a changed path all differ", () => {
  const before = parseRecursiveTree(tree(BASE_TREE, [README]), BASE_TREE)!;
  const reviewed = treeChanges(
    before,
    parseRecursiveTree(tree(HEAD_TREE, [README, ICON]), HEAD_TREE)!,
  );
  // Same first nine hex digits: GitHub renders both "Binary files ... differ"
  // under the same abbreviated index line.
  const collided = treeChanges(
    before,
    parseRecursiveTree(
      tree(HEAD_TREE, [README, { ...ICON, sha: "f1c05210e" + "0".repeat(31) }]),
      HEAD_TREE,
    )!,
  );
  assert.equal(sameTreeChanges(reviewed, collided), false);
  const executable = treeChanges(
    before,
    parseRecursiveTree(
      tree(HEAD_TREE, [README, { ...ICON, mode: "100755" }]),
      HEAD_TREE,
    )!,
  );
  assert.equal(sameTreeChanges(reviewed, executable), false);
  // The same new content applied onto another base version of a path.
  const edited = { ...README, sha: id("d") };
  const fromA = treeChanges(
    before,
    parseRecursiveTree(tree(HEAD_TREE, [edited]), HEAD_TREE)!,
  );
  const fromE = treeChanges(
    parseRecursiveTree(
      tree(BASE_TREE, [{ ...README, sha: id("e") }]),
      BASE_TREE,
    )!,
    parseRecursiveTree(tree(HEAD_TREE, [edited]), HEAD_TREE)!,
  );
  assert.equal(sameTreeChanges(fromA, fromE), false);
  // The identical patch on another base whose other paths moved is equal.
  const moved = parseRecursiveTree(
    tree(BASE_TREE, [README, {
      ...README,
      path: "CHANGELOG.md",
      sha: id("f"),
    }]),
    BASE_TREE,
  )!;
  const carried = treeChanges(
    moved,
    parseRecursiveTree(
      tree(HEAD_TREE, [README, {
        ...README,
        path: "CHANGELOG.md",
        sha: id("f"),
      }, ICON]),
      HEAD_TREE,
    )!,
  );
  assert.equal(sameTreeChanges(reviewed, carried), true);
});
