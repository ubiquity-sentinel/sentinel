/**
 * Action resolution of the v1 shape (docs/backup-ci-spec.md §5): remote
 * `action.yml`/`action.yaml` through a fake raw fetch, local actions from
 * the target tree; node20, node24 and composite are accepted, Docker is
 * `docker_action`, an unreadable or other runtime is `action_unresolved`;
 * composite recursion is bounded to depth 3 and 20 actions; remote verdicts
 * are cached per pass. All synthetic.
 */
import assert from "node:assert/strict";
import {
  type BackupCiActionCacheV1,
  type BackupCiActionSourceV1,
  rawGithubActionSource,
  resolveBackupCiActions,
} from "../../ops/backup-ci-actions.ts";

const enc = (text: string) => new TextEncoder().encode(text);

function source(
  remote: Record<string, string>,
  local: Record<string, string> = {},
): BackupCiActionSourceV1 & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    remote(owner, repo, ref, file) {
      const key = `${owner}/${repo}@${ref}:${file}`;
      reads.push(key);
      return Promise.resolve(key in remote ? enc(remote[key]) : null);
    },
    local(path) {
      reads.push(`local:${path}`);
      return Promise.resolve(path in local ? enc(local[path]) : null);
    },
  };
}

const node = (version: string) =>
  `runs:\n  using: ${version}\n  main: index.js\n`;
const composite = (...uses: string[]) =>
  `runs:\n  using: composite\n  steps:\n${
    uses.map((u) => `    - uses: ${u}\n`).join("")
  }    - run: echo done\n      shell: bash\n`;

Deno.test("node20, node24 and composite actions are accepted", async () => {
  const s = source({
    "actions/checkout@v6:action.yml": node("node24"),
    "denoland/setup-deno@v2:action.yaml": node("node20"),
    "acme/tools@v1:setup/action.yml": composite("actions/checkout@v6"),
  });
  const verdict = await resolveBackupCiActions({
    remote: [
      "actions/checkout@v6",
      "denoland/setup-deno@v2",
      "acme/tools/setup@v1",
    ],
    local: [],
  }, s);
  assert.equal(verdict, null);
  assert(s.reads.includes("denoland/setup-deno@v2:action.yml"));
  assert(s.reads.includes("denoland/setup-deno@v2:action.yaml"));
});

Deno.test("Docker actions are refused, directly or nested", async () => {
  assert.equal(
    await resolveBackupCiActions(
      { remote: ["acme/docker@v1"], local: [] },
      source({
        "acme/docker@v1:action.yml":
          "runs:\n  using: docker\n  image: Dockerfile\n",
      }),
    ),
    "docker_action",
  );
  assert.equal(
    await resolveBackupCiActions(
      { remote: ["acme/wrap@v1"], local: [] },
      source({ "acme/wrap@v1:action.yml": composite("docker://alpine:3") }),
    ),
    "docker_action",
  );
});

Deno.test("an unresolvable or unsupported action is refused", async () => {
  const none = source({});
  assert.equal(
    await resolveBackupCiActions({ remote: ["acme/gone@v1"], local: [] }, none),
    "action_unresolved",
  );
  for (
    const body of [
      node("node16"),
      "runs: nope\n",
      "name: [broken\n",
      composite("${{ matrix.action }}"),
    ]
  ) {
    assert.equal(
      await resolveBackupCiActions(
        { remote: ["acme/x@v1"], local: [] },
        source({ "acme/x@v1:action.yml": body }),
      ),
      "action_unresolved",
      body,
    );
  }
});

Deno.test("local actions read the target tree, recursively", async () => {
  const s = source(
    { "actions/setup-node@v6:action.yml": node("node24") },
    {
      ".github/actions/setup/action.yml": composite(
        "./.github/actions/inner",
        "actions/setup-node@v6",
      ),
      ".github/actions/inner/action.yaml": node("node20"),
    },
  );
  assert.equal(
    await resolveBackupCiActions({
      remote: [],
      local: ["./.github/actions/setup"],
    }, s),
    null,
  );
  assert(s.reads.includes("local:.github/actions/inner/action.yaml"));
  assert.equal(
    await resolveBackupCiActions(
      { remote: [], local: ["./../escape"] },
      source({}),
    ),
    "action_unresolved",
  );
});

Deno.test("composite recursion is bounded to depth 3 and 20 actions", async () => {
  const chain = source({
    "a/one@v1:action.yml": composite("a/two@v1"),
    "a/two@v1:action.yml": composite("a/three@v1"),
    "a/three@v1:action.yml": composite("a/four@v1"),
    "a/four@v1:action.yml": node("node24"),
  });
  assert.equal(
    await resolveBackupCiActions({ remote: ["a/one@v1"], local: [] }, chain),
    "action_unresolved",
  );
  const depth3 = source({
    "a/one@v1:action.yml": composite("a/two@v1"),
    "a/two@v1:action.yml": composite("a/three@v1"),
    "a/three@v1:action.yml": node("node24"),
  });
  assert.equal(
    await resolveBackupCiActions({ remote: ["a/one@v1"], local: [] }, depth3),
    null,
  );
  const fan: Record<string, string> = {
    "a/root@v1:action.yml": composite(
      ...Array.from({ length: 20 }, (_, i) => `a/leaf${i}@v1`),
    ),
  };
  for (let i = 0; i < 20; i++) fan[`a/leaf${i}@v1:action.yml`] = node("node24");
  assert.equal(
    await resolveBackupCiActions(
      { remote: ["a/root@v1"], local: [] },
      source(fan),
    ),
    "action_unresolved",
  );
});

Deno.test("remote verdicts are cached per pass", async () => {
  const s = source({ "actions/checkout@v6:action.yml": node("node24") });
  const cache: BackupCiActionCacheV1 = new Map();
  await resolveBackupCiActions(
    { remote: ["actions/checkout@v6"], local: [] },
    s,
    cache,
  );
  await resolveBackupCiActions(
    { remote: ["actions/checkout@v6"], local: [] },
    s,
    cache,
  );
  assert.equal(s.reads.length, 1);
});

Deno.test("the raw source fetches anonymously, bounded, without redirects", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const fetcher = ((url: string, init?: RequestInit) => {
    seen.push({ url, init });
    if (url.endsWith("/big/action.yml")) {
      return Promise.resolve(new Response("x".repeat(300 * 1024)));
    }
    return Promise.resolve(
      url.includes("missing")
        ? new Response("no", { status: 404 })
        : new Response(node("node24")),
    );
  }) as typeof fetch;
  const raw = rawGithubActionSource(() => Promise.resolve(null), fetcher);
  assert.notEqual(
    await raw.remote("actions", "checkout", "v6", "action.yml"),
    null,
  );
  assert.equal(await raw.remote("acme", "missing", "v1", "action.yml"), null);
  assert.equal(await raw.remote("acme", "x", "v1", "big/action.yml"), null);
  assert.equal(
    seen[0].url,
    "https://raw.githubusercontent.com/actions/checkout/v6/action.yml",
  );
  assert.equal(seen[0].init?.redirect, "error");
  const headers = new Headers(seen[0].init?.headers);
  assert.equal(headers.get("authorization"), null);
});
