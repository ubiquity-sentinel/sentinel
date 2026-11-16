/**
 * The base-repair pass's installed-runtime gate
 * (`ops/hosted-autonomy-base-repair-runtime.ts`), through the real
 * maintenance pass (`runHostedAutonomy`) with fake GitHub targets, a fake
 * Sentinel repository answering the ancestry compare, and the release state
 * naming the installed runtime. The second review of the 2026-11-15
 * enablement found that filing (in the launcher) and the CI-fix cap (in the
 * installed runtime) could run on different revisions after an install's
 * rollback; the launcher now files only while the INSTALLED runtime is the
 * cap's commit or a descendant of it and no installation is in flight. The
 * compare itself is read through the corrected ancestry check, pinned here
 * over a stubbed fetch.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { BASE_REPAIR_CAP_REVISION } from "../../ops/hosted-autonomy-base-repair-runtime.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { HOSTED_AUTONOMY_SELF_SCOPE } from "../../ops/hosted-autonomy-policy.ts";
import { releaseSnapshot } from "./hosted-autonomy-rig.ts";
import {
  AI,
  LIVE,
  maintain,
  NOW,
  redTargets,
  RUNTIME,
  TAG,
} from "./hosted-autonomy-base-repair-fixtures.ts";

/** The runtime installed before the cap (generation 253, 2026-11-16). */
const UNCAPPED = "9c91a87f774f66b9c54c4ce73c032dab9bb958d2";
const MINUTE = 60_000;

/** The release state with the runtime pointer at `revision`. */
function installedAt(
  revision: string,
  installations: unknown[] = [],
): ReleaseStateSnapshotV1 {
  return {
    ...releaseSnapshot([], revision as GitSha),
    hostedInstallations: installations,
  } as ReleaseStateSnapshotV1;
}

/**
 * Three passes five minutes apart (the dispatch cadence, inside the held
 * records' red-base hold): their base-repair actions and compares.
 */
async function passes(
  release: ReleaseStateSnapshotV1,
  ancestry: (ancestor: string, descendant: string) => boolean | null,
) {
  const targets = redTargets();
  const compares: string[] = [];
  const actions: string[] = [];
  for (let index = 0; index < 3; index++) {
    const now = NOW + index * 5 * MINUTE;
    const pass = await maintain(LIVE(), targets, now, {
      release,
      isAncestor: (ancestor, descendant) => {
        compares.push(`${ancestor}...${descendant}`);
        return Promise.resolve(ancestry(ancestor, descendant));
      },
    });
    actions.push(...pass.baseRepair);
  }
  return { actions, compares, created: targets[AI].created };
}

Deno.test("base repair runtime: an installed runtime without the cap files nothing, with a fixed reason", async () => {
  const { actions, compares, created } = await passes(
    installedAt(UNCAPPED),
    () => false,
  );
  assert.deepEqual(actions, Array(3).fill(`${TAG}:runtime_uncapped`));
  assert.deepEqual(
    compares,
    Array(3).fill(`${BASE_REPAIR_CAP_REVISION}...${UNCAPPED}`),
  );
  assert.equal(created.length, 0);
});

Deno.test("base repair runtime: an installed runtime that carries the cap files exactly one issue", async () => {
  // A descendant of the cap's commit, proven by the compare.
  const descendant = await passes(
    installedAt(RUNTIME),
    (ancestor, revision) =>
      ancestor === BASE_REPAIR_CAP_REVISION && revision === RUNTIME,
  );
  assert.deepEqual(descendant.actions, [
    `${TAG}:filed=#9000`,
    `${TAG}:filed_before=#9000`,
    `${TAG}:filed_before=#9000`,
  ]);
  assert.equal(descendant.created.length, 1);
  // Only the pass that would file asks for the compare.
  assert.equal(descendant.compares.length, 1);
  // The cap's own commit: no compare at all.
  const exact = await passes(installedAt(BASE_REPAIR_CAP_REVISION), () => {
    throw new Error("no compare for the exact commit");
  });
  assert.equal(exact.actions[0], `${TAG}:filed=#9000`);
  assert.equal(exact.created.length, 1);
  assert.deepEqual(exact.compares, []);
});

Deno.test("base repair runtime: an installation in flight files nothing until it settles", async () => {
  for (const phase of ["requested", "bootstrapping", "rollback_pending"]) {
    const installation = {
      version: "v1",
      kind: "hosted_installation",
      id: `installation:${RUNTIME}`,
      phase,
    };
    const { actions, created, compares } = await passes(
      installedAt(BASE_REPAIR_CAP_REVISION, [installation]),
      () => true,
    );
    assert.deepEqual(
      actions,
      Array(3).fill(`${TAG}:runtime_installing`),
      phase,
    );
    assert.equal(created.length, 0, phase);
    assert.deepEqual(compares, [], phase);
  }
  // A settled one (accepted, rolled back or failed) holds nothing.
  const settled = await passes(
    installedAt(RUNTIME, [{ phase: "accepted" }, { phase: "rolled_back" }]),
    () => true,
  );
  assert.equal(settled.actions[0], `${TAG}:filed=#9000`);
});

Deno.test("base repair runtime: an unreadable runtime pointer or compare files nothing", async () => {
  const cases: [
    string,
    ReleaseStateSnapshotV1,
    (ancestor: string, revision: string) => boolean | null,
  ][] = [
    ["no runtime pointer", releaseSnapshot([], null), () => true],
    ["compare unreadable", installedAt(RUNTIME), () => null],
  ];
  for (const [label, release, ancestry] of cases) {
    const { actions, created } = await passes(release, ancestry);
    assert.deepEqual(
      actions,
      Array(3).fill(`${TAG}:runtime_unreadable`),
      label,
    );
    assert.equal(created.length, 0, label);
  }
});

/** One compare answer, as GitHub's `compare/{a}...{b}` would give it. */
function compare(overrides: Record<string, unknown> = {}) {
  return {
    status: "ahead",
    ahead_by: 323,
    behind_by: 0,
    // A date-skewed listing counts more commits than are ahead (2026-11-14).
    total_commits: 329,
    base_commit: { sha: BASE_REPAIR_CAP_REVISION },
    merge_base_commit: { sha: BASE_REPAIR_CAP_REVISION },
    commits: [],
    files: [],
    ...overrides,
  };
}

Deno.test("base repair runtime: the ancestry compare is the corrected check over one small page", async () => {
  const self = createHostedAutonomyGitHub("token", HOSTED_AUTONOMY_SELF_SCOPE);
  const ask = async (answer: unknown, status = 200) => {
    const requested: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response(JSON.stringify(answer), { status }));
    }) as typeof fetch;
    try {
      const proven = await self.isAncestor!(BASE_REPAIR_CAP_REVISION, RUNTIME);
      return { proven, requested };
    } finally {
      globalThis.fetch = original;
    }
  };
  const ahead = await ask(compare());
  assert.equal(ahead.proven, true, "a skewed listing still proves ancestry");
  assert.deepEqual(ahead.requested, [
    `https://api.github.com/repos/ubiquity-sentinel/sentinel/compare/${BASE_REPAIR_CAP_REVISION}...${RUNTIME}?per_page=1&page=2`,
  ]);
  const refused: [string, Record<string, unknown>][] = [
    ["behind", compare({ status: "behind", ahead_by: 0, behind_by: 4 })],
    ["diverged", compare({ status: "diverged", behind_by: 2 })],
    ["another merge base", compare({ merge_base_commit: { sha: UNCAPPED } })],
    ["an empty listing", compare({ total_commits: 0 })],
  ];
  for (const [label, answer] of refused) {
    assert.equal((await ask(answer)).proven, false, label);
  }
  for (const status of [404, 500]) {
    assert.equal((await ask({ message: "x" }, status)).proven, null);
  }
  // The same commit needs no read; an id that is not a commit SHA never goes.
  assert.equal(
    await self.isAncestor!(BASE_REPAIR_CAP_REVISION, BASE_REPAIR_CAP_REVISION),
    true,
  );
  assert.equal(await self.isAncestor!("main", RUNTIME), null);
});

Deno.test("base repair runtime: the pinned commit, where present, carries the cap and precedes HEAD", async () => {
  assert.match(BASE_REPAIR_CAP_REVISION, /^[0-9a-f]{40}$/);
  const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
  const git = (args: string[]) =>
    new Deno.Command("git", {
      args: ["-C", root, ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
  const present = await git([
    "cat-file",
    "-e",
    `${BASE_REPAIR_CAP_REVISION}^{commit}`,
  ]);
  // A shallow checkout (CI) may not hold it; the gate itself asks GitHub.
  if (!present.success) return;
  const shown = await git([
    "show",
    `${BASE_REPAIR_CAP_REVISION}:src/repair/base-repair.ts`,
  ]);
  assert.ok(shown.success);
  assert.match(
    new TextDecoder().decode(shown.stdout),
    /^export const BASE_REPAIR_CI_FIX_CAP = [1-9][0-9]*;$/m,
  );
  const ancestor = await git([
    "merge-base",
    "--is-ancestor",
    BASE_REPAIR_CAP_REVISION,
    "HEAD",
  ]);
  assert.ok(ancestor.success, "the cap's commit is an ancestor of HEAD");
});
