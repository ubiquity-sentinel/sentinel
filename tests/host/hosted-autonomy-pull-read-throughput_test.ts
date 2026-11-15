import assert from "node:assert/strict";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";

const repository = {
  owner: "fixture",
  name: "target",
  installationId: 1,
};
const BASE = "1".repeat(40);
const HEAD = "2".repeat(40);
const MERGE = "3".repeat(40);
const TREE = "4".repeat(40);
const ROOT = "/repos/fixture/target";
const PULL = `${ROOT}/pulls/42`;
const COMMIT = `${ROOT}/commits/${MERGE}`;
const INTEGRATION = `${ROOT}/compare/${MERGE}...main`;
const ANCESTRY = `${ROOT}/compare/${BASE}...${MERGE}`;

/** Each response wave costs one simulated network round trip, not wall time. */
async function readFixture(options: {
  branch?: string | null;
  merged?: boolean;
  squash?: boolean;
  base?: string | null;
  unavailable?: string;
  malformedCommit?: boolean;
} = {}) {
  const answers: Record<string, unknown> = {
    [PULL]: {
      number: 42,
      state: options.merged === false ? "open" : "closed",
      merged: options.merged ?? true,
      merge_commit_sha: MERGE,
      head: { sha: HEAD },
      base: {
        sha: options.base === undefined ? BASE : options.base,
        ref: "main",
      },
      user: { login: "sentinel[bot]" },
    },
    [COMMIT]: options.malformedCommit ? {} : {
      parents: (options.squash ? [BASE] : [BASE, HEAD]).map((sha) => ({ sha })),
      commit: { tree: { sha: TREE } },
    },
    [`${ROOT}/commits/${HEAD}`]: { commit: { tree: { sha: TREE } } },
    [INTEGRATION]: {
      status: "ahead",
      base_commit: { sha: MERGE },
      merge_base_commit: { sha: MERGE },
    },
    [ANCESTRY]: {
      status: "ahead",
      base_commit: { sha: BASE },
      merge_base_commit: { sha: BASE },
    },
  };
  const waves: string[][] = [];
  let pending: { path: string; resolve: (value: Response) => void }[] = [];
  const unexpected: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    assert.equal(init?.method, "GET", "only read-only work may overlap");
    if (!(path in answers)) unexpected.push(path);
    return new Promise<Response>((resolve) => {
      pending.push({ path, resolve });
      if (pending.length !== 1) return;
      // Hold responses until all requests started in this wave are queued.
      setTimeout(() => {
        const batch = pending;
        pending = [];
        waves.push(batch.map((row) => row.path).sort());
        for (const row of batch) {
          row.resolve(
            row.path === options.unavailable
              ? new Response(null, { status: 503 })
              : new Response(JSON.stringify(answers[row.path])),
          );
        }
      }, 0);
    });
  }) as typeof fetch;
  try {
    const surface = createHostedAutonomyGitHub("fixture-token", repository);
    const pull = await surface.readPull(
      42,
      options.branch === undefined ? "main" : options.branch,
    );
    assert.deepEqual(unexpected, []);
    return { pull, waves };
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("maintenance pull read: merged proof takes two network waves instead of four", async () => {
  const { pull, waves } = await readFixture();
  assert.deepEqual(waves, [[PULL], [COMMIT, INTEGRATION, ANCESTRY].sort()]);
  assert.equal(pull?.revisionOnBaseBranch, true);
  assert.equal(pull?.baseAncestorOfRevision, true);
  assert.deepEqual(pull?.parents, [BASE, HEAD]);
});

Deno.test("maintenance pull read: squash proof takes three network waves instead of five", async () => {
  const { pull, waves } = await readFixture({ squash: true });
  assert.deepEqual(waves, [
    [PULL],
    [COMMIT, INTEGRATION, ANCESTRY].sort(),
    [`${ROOT}/commits/${HEAD}`],
  ]);
  assert.equal(pull?.revisionOnBaseBranch, true);
  assert.equal(pull?.baseAncestorOfRevision, true);
  assert.deepEqual(pull?.parents, [BASE]);
  assert.equal(pull?.mergeTree, TREE);
  assert.equal(pull?.headTree, TREE);
});

for (const unavailable of [INTEGRATION, ANCESTRY]) {
  Deno.test(`maintenance pull read: unavailable ${unavailable} remains unproven`, async () => {
    const { pull } = await readFixture({ unavailable });
    assert.equal(pull?.revisionOnBaseBranch, unavailable !== INTEGRATION);
    assert.equal(pull?.baseAncestorOfRevision, unavailable !== ANCESTRY);
  });
}

Deno.test("maintenance pull read: unavailable or malformed commit still refuses proof", async () => {
  assert.equal((await readFixture({ unavailable: COMMIT })).pull, null);
  assert.equal((await readFixture({ malformedCommit: true })).pull, null);
});

Deno.test("maintenance pull read: missing base never invents its ancestry", async () => {
  const { pull, waves } = await readFixture({ base: null });
  assert.equal(pull?.baseAncestorOfRevision, false);
  assert.deepEqual(waves, [[PULL], [COMMIT, INTEGRATION].sort()]);
});

Deno.test("maintenance pull read: unmerged or unscoped pulls need no merge proof reads", async () => {
  const unmerged = await readFixture({ merged: false });
  assert.equal(unmerged.pull?.merged, false);
  assert.deepEqual(unmerged.waves, [[PULL]]);
  const unscoped = await readFixture({ branch: null });
  assert.equal(unscoped.pull, null);
  assert.deepEqual(unscoped.waves, [[PULL]]);
});
