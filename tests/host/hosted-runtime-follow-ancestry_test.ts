/**
 * Compare-based ancestry through the real follow consumer. Live 2026-11-14,
 * eight dispatcher passes deferred as `launcher_diverged` although launcher
 * 6e74557 was an ancestor of development: GitHub's `ahead_by`/`behind_by` are
 * exact reachability counts, but `total_commits` counts the compare's commit
 * listing, a date-ordered walk that also lists commits the base already
 * reaches when commit dates are skewed. The epoch-dated base-refresh merges
 * above 2026-11-01/02 commits made 6e74557...39f60ee list 13 commits for 7
 * ahead (6e74557...ab84c0d: 18 for 12). A true descendant must advance; a
 * diverged or malformed compare must still refuse without a ref write.
 */
import assert from "node:assert/strict";
import type { HostedRuntimeFollowResult } from "../../src/host/hosted-runtime-follow.ts";
import {
  ciRun,
  D,
  FollowFake,
  L,
  OLDER,
  P,
  response,
} from "./hosted-runtime-follow-fixtures.ts";

type Compare = Record<string, unknown>;

const COMPARE = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/;

/** Answer compares with `answer`, or the fake's default when it returns undefined. */
function answerCompares(
  api: FollowFake,
  answer: (base: string, head: string) => Compare | undefined,
): string[] {
  const asked: string[] = [];
  api.intercept = (_request, url) => {
    const match = COMPARE.exec(url.pathname);
    if (match === null) return undefined;
    asked.push(`${match[1]}...${match[2]}`);
    const body = answer(match[1], match[2]);
    return body === undefined ? undefined : response(body);
  };
  return asked;
}

/** GitHub's compare of a true descendant whose listing counts `listed`. */
function descendant(base: string, ahead: number, listed: number): Compare {
  return {
    status: "ahead",
    base_commit: { sha: base },
    merge_base_commit: { sha: base },
    ahead_by: ahead,
    behind_by: 0,
    total_commits: listed,
  };
}

function assertRefused(
  api: FollowFake,
  result: HostedRuntimeFollowResult,
  reason: string,
): void {
  assert.equal(result.journal.decision, "deferred", reason);
  assert.equal(result.journal.reason, reason);
  assert.equal(result.journal.candidateSha, null);
  assert.equal(api.mutations, 0);
  assert.equal(api.launcher, L);
  assert.equal(result.launcherSha, L);
  assert.equal(result.safeToDispatch, true, "the current launcher still runs");
  assert.equal(result.exitCode, 0);
}

const LIVE_LAUNCHER = "6e745579368a4086d1ed304ac1595efe05071833";
/**
 * The live first-parent chain, development first, with each merge's second
 * parent and its compare from the launcher [ahead_by, total_commits]. The
 * 39f60ee and ab84c0d counters were read from GitHub; all four equal the exact
 * set difference and `git rev-list --count 6e74557..<sha>` respectively.
 */
const LIVE_CHAIN: ReadonlyArray<[string, string | null, number, number]> = [
  [
    "ab84c0d888fbdefed43f0be1e63e0d2dc8151f16",
    "c5e2d445c71aa66977471f7b2c3b7ad85818e67d",
    12,
    18,
  ],
  ["8270029d4eb2ae53184d47961b2b8e9d0f3ddf0a", null, 9, 15],
  ["6ed1cf712b33848099a5d778edee0883a2376151", null, 8, 14],
  [
    "39f60ee7ee000ad5b84e24a0834fe39f3c3f7e70",
    "7874f689b9113b88a3608dbc2a2151e2c57f9e04",
    7,
    13,
  ],
];

Deno.test("follow advances the live launcher whose compares list more commits than are ahead (2026-11-14)", async () => {
  const api = new FollowFake();
  const tip = LIVE_CHAIN[0][0];
  api.development = tip;
  api.launcher = LIVE_LAUNCHER;
  api.installed = LIVE_LAUNCHER;
  api.parents = new Map(
    LIVE_CHAIN.map(([sha, merged], index): [string, string[]] => {
      const first = LIVE_CHAIN[index + 1]?.[0] ?? LIVE_LAUNCHER;
      return [sha, merged === null ? [first] : [first, merged]];
    }),
  );
  api.ci = new Map([[tip, [ciRun(tip, 30)]]]);
  const asked = answerCompares(api, (base, head) => {
    const row = LIVE_CHAIN.find(([sha]) => sha === head);
    assert.ok(row !== undefined && base === LIVE_LAUNCHER, head);
    return descendant(base, row[2], row[3]);
  });
  const result = await api.follow();
  assert.equal(result.journal.decision, "advanced", result.journal.reason);
  assert.equal(result.journal.reason, "ci_green_descendant");
  assert.equal(result.journal.previousLauncherSha, LIVE_LAUNCHER);
  assert.equal(result.journal.candidateSha, tip);
  assert.equal(result.launcherSha, tip);
  assert.equal(api.launcher, tip);
  assert.equal(api.mutations, 1);
  assert.equal(result.safeToDispatch, true);
  // Launcher → tip, each first-parent step, then installed revision → tip.
  assert.deepEqual(asked, [
    ...LIVE_CHAIN.map(([sha]) => `${LIVE_LAUNCHER}...${sha}`),
    `${LIVE_LAUNCHER}...${tip}`,
  ]);
});

Deno.test("follow accepts a skewed listing count at each ancestry proof", async (t) => {
  // D → OLDER → L → P; D's CI failed, OLDER is green, P is installed.
  const sites: Array<[string, string, string, number]> = [
    ["launcher to development", L, D, 2],
    ["first-parent step", L, OLDER, 1],
    ["installed revision to candidate", P, OLDER, 2],
  ];
  for (const [name, skewedBase, skewedHead, ahead] of sites) {
    await t.step(name, async () => {
      const api = new FollowFake();
      const asked = answerCompares(
        api,
        (base, head) =>
          base === skewedBase && head === skewedHead
            ? descendant(base, ahead, ahead + 6)
            : undefined,
      );
      const result = await api.follow();
      assert.equal(result.journal.decision, "advanced", result.journal.reason);
      assert.equal(result.journal.candidateSha, OLDER);
      assert.equal(api.launcher, OLDER);
      assert.equal(api.mutations, 1);
      assert.ok(asked.includes(`${skewedBase}...${skewedHead}`));
    });
  }
});

Deno.test("follow still refuses a launcher the compare does not prove an ancestor", async (t) => {
  const cases: Array<[string, Compare]> = [
    ["behind_by above zero", { ...descendant(L, 2, 9), behind_by: 1 }],
    ["diverged", {
      ...descendant(L, 2, 9),
      status: "diverged",
      merge_base_commit: { sha: P },
      behind_by: 1,
    }],
    ["behind", {
      ...descendant(L, 0, 7),
      status: "behind",
      merge_base_commit: { sha: D },
      behind_by: 1,
    }],
    ["merge base is not the base", {
      ...descendant(L, 2, 8),
      merge_base_commit: { sha: P },
    }],
    ["compare base is not the base", {
      ...descendant(L, 2, 8),
      base_commit: { sha: P },
    }],
    ["ahead with nothing ahead", { ...descendant(L, 0, 6) }],
    ["ahead with an empty listing", { ...descendant(L, 2, 0) }],
    ["identical with commits", {
      ...descendant(L, 0, 6),
      status: "identical",
    }],
    ["unknown status", { ...descendant(L, 2, 8), status: "x" }],
    ["missing status", { ...descendant(L, 2, 8), status: undefined }],
  ];
  for (const [name, body] of cases) {
    await t.step(name, async () => {
      const api = new FollowFake();
      answerCompares(
        api,
        (base, head) => base === L && head === D ? body : undefined,
      );
      assertRefused(api, await api.follow(), "launcher_diverged");
    });
  }
});

Deno.test("follow refuses malformed compare counters before judging ancestry", async (t) => {
  const cases: Array<[string, Compare]> = [
    ["negative ahead_by", { ahead_by: -1 }],
    ["negative behind_by", { behind_by: -1 }],
    ["negative total_commits", { total_commits: -1 }],
    ["fractional ahead_by", { ahead_by: 2.5 }],
    ["string total_commits", { total_commits: "8" }],
    ["null behind_by", { behind_by: null }],
    ["missing total_commits", { total_commits: undefined }],
    ["unsafe ahead_by", { ahead_by: 2 ** 53 }],
  ];
  for (const [name, change] of cases) {
    await t.step(name, async () => {
      const api = new FollowFake();
      answerCompares(
        api,
        (base, head) =>
          base === L && head === D
            ? { ...descendant(L, 2, 8), ...change }
            : undefined,
      );
      assertRefused(api, await api.follow(), "malformed_ancestry");
    });
  }
});

Deno.test("follow still refuses an installed revision the skewed compare does not prove", async (t) => {
  const cases: Array<[string, Compare, string]> = [
    [
      "behind",
      { ...descendant(P, 2, 9), behind_by: 1 },
      "no_eligible_candidate",
    ],
    ["merge base", {
      ...descendant(P, 2, 8),
      merge_base_commit: { sha: L },
    }, "no_eligible_candidate"],
    [
      "malformed",
      { ...descendant(P, 2, 8), ahead_by: -2 },
      "malformed_ancestry",
    ],
  ];
  for (const [name, body, reason] of cases) {
    await t.step(name, async () => {
      const api = new FollowFake();
      answerCompares(
        api,
        (base, head) => base === P && head === OLDER ? body : undefined,
      );
      assertRefused(api, await api.follow(), reason);
    });
  }
});
