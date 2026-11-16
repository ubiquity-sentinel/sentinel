/**
 * The base-repair pass's installed-runtime gate
 * (`ops/hosted-autonomy-base-repair-runtime.ts`), through the real
 * maintenance pass (`runHostedAutonomy`) with fake GitHub targets, a fake
 * Sentinel repository answering the gate's source reads, and the release
 * state naming the installed runtime. Filing (in the launcher) and the CI-fix
 * cap (in the installed runtime) can run on different revisions, so the
 * launcher files only while no installation is in flight and the INSTALLED
 * revision's own source carries the cap. The third review filed on a runtime
 * that descended from the cap's commit with the cap reverted, since the gate
 * then proved only that ancestry; the source read is pinned here, with the
 * read itself over a stubbed fetch.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { BASE_REPAIR_CI_FIX_CAP } from "../../src/repair/base-repair.ts";
import {
  BASE_REPAIR_CAP_SOURCES,
  type BaseRepairCapSourcesV1,
  runtimeSourceCarriesCap,
} from "../../ops/hosted-autonomy-base-repair-runtime.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { READ_FILE_AT_MAX_BYTES } from "../../ops/hosted-autonomy-github-pull.ts";
import { HOSTED_AUTONOMY_SELF_SCOPE } from "../../ops/hosted-autonomy-policy.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import { releaseSnapshot } from "./hosted-autonomy-rig.ts";
import {
  AI,
  checkoutSource,
  LIVE,
  maintain,
  NOW,
  redTargets,
  RUNTIME,
  TAG,
} from "./hosted-autonomy-base-repair-fixtures.ts";

const MINUTE = 60_000;
const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);

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

/** This checkout's cap sources. */
async function checkout(): Promise<BaseRepairCapSourcesV1> {
  return {
    cap: (await checkoutSource(BASE_REPAIR_CAP_SOURCES.cap))!,
    admission: (await checkoutSource(BASE_REPAIR_CAP_SOURCES.admission))!,
  };
}

/** The cap sources as a revert of the cap's commit leaves them. */
async function reverted(): Promise<BaseRepairCapSourcesV1> {
  const { cap, admission } = await checkout();
  return {
    cap: cap.replace(/^export const BASE_REPAIR_CI_FIX_CAP = \d+;$/m, ""),
    admission: admission.replaceAll(
      "await baseRepairCiFixCapped(",
      "await Promise.resolve(false) && (",
    ),
  };
}

/** A Sentinel repository answering `sources` at every revision. */
function answering(
  sources: BaseRepairCapSourcesV1 | null,
  reads: string[] = [],
): Partial<HostedAutonomyGitHubV1> {
  return {
    readFileAt: (path: string, revision: string) => {
      reads.push(`${path}@${revision}`);
      if (sources === null) return Promise.resolve(null);
      return Promise.resolve(
        path === BASE_REPAIR_CAP_SOURCES.cap
          ? sources.cap
          : path === BASE_REPAIR_CAP_SOURCES.admission
          ? sources.admission
          : null,
      );
    },
  };
}

/**
 * Three passes five minutes apart (the dispatch cadence, inside the held
 * records' red-base hold): their base-repair actions and what they filed.
 */
async function passes(
  release: ReleaseStateSnapshotV1,
  self: Partial<HostedAutonomyGitHubV1>,
) {
  const targets = redTargets();
  const actions: string[] = [];
  for (let index = 0; index < 3; index++) {
    const now = NOW + index * 5 * MINUTE;
    const pass = await maintain(LIVE(), targets, now, { release, self });
    actions.push(...pass.baseRepair);
  }
  return { actions, created: targets[AI].created };
}

Deno.test("base repair runtime: a runtime that descends from the cap's commit but no longer carries the cap files nothing", async () => {
  const reads: string[] = [];
  const { actions, created } = await passes(installedAt(RUNTIME), {
    ...answering(await reverted(), reads),
    // The earlier gate's only question, which a revert still passes: the
    // installed revision descends from the commit that landed the cap.
    isAncestor: () => Promise.resolve(true),
  } as Partial<HostedAutonomyGitHubV1>);
  assert.deepEqual(actions, Array(3).fill(`${TAG}:runtime_uncapped`));
  assert.equal(created.length, 0, "nothing filed on an uncapped runtime");
  // Both sources, read at exactly the installed revision, on every pass.
  assert.deepEqual(
    reads,
    Array(3).fill([
      `${BASE_REPAIR_CAP_SOURCES.cap}@${RUNTIME}`,
      `${BASE_REPAIR_CAP_SOURCES.admission}@${RUNTIME}`,
    ]).flat(),
  );
});

Deno.test("base repair runtime: an installed runtime whose source carries the cap files exactly one issue", async () => {
  const reads: string[] = [];
  const { actions, created } = await passes(
    installedAt(RUNTIME),
    answering(await checkout(), reads),
  );
  assert.deepEqual(actions, [
    `${TAG}:filed=#9000`,
    `${TAG}:filed_before=#9000`,
    `${TAG}:filed_before=#9000`,
  ]);
  assert.equal(created.length, 1);
  // Only the pass that would file reads the source.
  assert.equal(reads.length, 2);
});

Deno.test("base repair runtime: an installation in flight files nothing until it settles", async () => {
  for (const phase of ["requested", "bootstrapping", "rollback_pending"]) {
    const installation = {
      version: "v1",
      kind: "hosted_installation",
      id: `installation:${RUNTIME}`,
      phase,
    };
    const reads: string[] = [];
    const { actions, created } = await passes(
      installedAt(RUNTIME, [installation]),
      answering(await checkout(), reads),
    );
    assert.deepEqual(
      actions,
      Array(3).fill(`${TAG}:runtime_installing`),
      phase,
    );
    assert.equal(created.length, 0, phase);
    assert.deepEqual(reads, [], phase);
  }
  // A settled one (accepted, rolled back or failed) holds nothing.
  const settled = await passes(
    installedAt(RUNTIME, [{ phase: "accepted" }, { phase: "rolled_back" }]),
    answering(await checkout()),
  );
  assert.equal(settled.actions[0], `${TAG}:filed=#9000`);
});

Deno.test("base repair runtime: an unreadable runtime pointer or source files nothing", async () => {
  const sources = await checkout();
  const cases: [
    string,
    ReleaseStateSnapshotV1,
    Partial<HostedAutonomyGitHubV1>,
  ][] = [
    ["no runtime pointer", releaseSnapshot([], null), answering(sources)],
    ["no source", installedAt(RUNTIME), answering(null)],
    ["no admission source", installedAt(RUNTIME), {
      readFileAt: (path) =>
        Promise.resolve(
          path === BASE_REPAIR_CAP_SOURCES.cap ? sources.cap : null,
        ),
    }],
    ["a throwing read", installedAt(RUNTIME), {
      readFileAt: () => Promise.reject(new Error("connection reset")),
    }],
    ["no source reader", installedAt(RUNTIME), {}],
  ];
  for (const [label, release, self] of cases) {
    const { actions, created } = await passes(release, self);
    assert.deepEqual(
      actions,
      Array(3).fill(`${TAG}:runtime_unreadable`),
      label,
    );
    assert.equal(created.length, 0, label);
  }
});

Deno.test("base repair runtime: the cap facts hold on this checkout and fail for every way the cap can be lost", async () => {
  const sources = await checkout();
  assert.equal(runtimeSourceCarriesCap(sources), true, "this checkout");
  assert.equal(runtimeSourceCarriesCap(await reverted()), false, "reverted");
  const declaration =
    `export const BASE_REPAIR_CI_FIX_CAP = ${BASE_REPAIR_CI_FIX_CAP};`;
  assert.ok(sources.cap.includes(`\n${declaration}\n`));
  const capped = (line: string) => ({
    ...sources,
    cap: sources.cap.replace(declaration, line),
  });
  const cases: [string, BaseRepairCapSourcesV1, boolean][] = [
    // A smaller cap is stricter than the bound this launcher states.
    ["a smaller cap", capped("export const BASE_REPAIR_CI_FIX_CAP = 1;"), true],
    [
      "a larger cap",
      capped(
        `export const BASE_REPAIR_CI_FIX_CAP = ${BASE_REPAIR_CI_FIX_CAP + 1};`,
      ),
      false,
    ],
    ["no cap", capped("export const BASE_REPAIR_CI_FIX_CAP = 0;"), false],
    [
      "an expression",
      capped("export const BASE_REPAIR_CI_FIX_CAP = 3 * 4;"),
      false,
    ],
    ["only in a comment", capped(` * ${declaration}`), false],
    ["declared twice", capped(`${declaration}\n${declaration}`), false],
    [
      "no admission",
      { ...sources, admission: (await reverted()).admission },
      false,
    ],
    // The first cap: each part of a split task had its own.
    [
      "no count across parts",
      {
        ...sources,
        cap: sources.cap.replace(
          "export function baseRepairCiFixesSpent(",
          "function ownCount(",
        ),
      },
      false,
    ],
    [
      "an admission over the record alone",
      {
        ...sources,
        admission: sources.admission.replace(
          /baseRepairCiFixCapped\(\s*deps,\s*record,\s*context\.snapshot\.work,?\s*\)/,
          "baseRepairCiFixCapped(deps, record, [])",
        ),
      },
      false,
    ],
  ];
  for (const [label, variant, carries] of cases) {
    assert.equal(runtimeSourceCarriesCap(variant), carries, label);
  }
  // The real history, where this checkout holds it (a shallow CI clone may
  // not): the runtime installed before the cap (generation 253, 9c91a87f77)
  // does not carry it, and neither does the first cap (33789b2a90), under
  // which each part of a split task took its own three fixes.
  const git = (args: string[]) =>
    new Deno.Command("git", {
      args: ["-C", ROOT, ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
  for (
    const [revision, label] of [
      ["9c91a87f774f66b9c54c4ce73c032dab9bb958d2", "before the cap"],
      ["33789b2a90c821058de155c4860f2cf9f6eb8e2b", "the first cap"],
    ]
  ) {
    if (!(await git(["cat-file", "-e", `${revision}^{commit}`])).success) {
      continue;
    }
    const show = async (path: string) =>
      new TextDecoder().decode(
        (await git(["show", `${revision}:${path}`])).stdout,
      );
    assert.equal(
      runtimeSourceCarriesCap({
        cap: await show(BASE_REPAIR_CAP_SOURCES.cap),
        admission: await show(BASE_REPAIR_CAP_SOURCES.admission),
      }),
      false,
      label,
    );
  }
});

/** One contents answer, as GitHub's `contents/{path}?ref={sha}` gives it. */
async function contents(
  path: string,
  text: string,
  overrides: Record<string, unknown> = {},
) {
  const bytes = new TextEncoder().encode(text);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array([...header, ...bytes]);
  const sha = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-1", object)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  // GitHub wraps the base64 content every 60 characters.
  const base64 = btoa(String.fromCharCode(...bytes)).replace(
    /(.{60})/g,
    "$1\n",
  );
  return {
    type: "file",
    encoding: "base64",
    size: bytes.length,
    name: path.split("/").pop(),
    path,
    content: base64,
    sha,
    ...overrides,
  };
}

Deno.test("base repair runtime: the source read is the contents API at the exact commit, proven by its blob id", async () => {
  const self = createHostedAutonomyGitHub("token", HOSTED_AUTONOMY_SELF_SCOPE);
  const path = BASE_REPAIR_CAP_SOURCES.cap;
  const ask = async (
    answer: unknown,
    status = 200,
    at: { path?: string; revision?: string } = {},
  ) => {
    const requested: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response(JSON.stringify(answer), { status }));
    }) as typeof fetch;
    try {
      const text = await self.readFileAt!(
        at.path ?? path,
        at.revision ?? RUNTIME,
      );
      return { text, requested };
    } finally {
      globalThis.fetch = original;
    }
  };
  const text = "export const BASE_REPAIR_CI_FIX_CAP = 3;\n// é\n";
  const good = await ask(await contents(path, text));
  assert.equal(good.text, text);
  assert.deepEqual(good.requested, [
    `https://api.github.com/repos/ubiquity-sentinel/sentinel/contents/${path}?ref=${RUNTIME}`,
  ]);
  const refused: [string, unknown, number?][] = [
    ["a directory", await contents(path, text, { type: "dir" })],
    ["another path", await contents(path, text, { path: "src/x.ts" })],
    ["another blob id", await contents(path, text, { sha: "0".repeat(40) })],
    ["a short size", await contents(path, text, { size: 3 })],
    ["no content", await contents(path, text, { content: undefined })],
    ["not base64", await contents(path, text, { content: "%%%" })],
    [
      "too large",
      await contents(path, text, { size: READ_FILE_AT_MAX_BYTES + 1 }),
    ],
    ["a listing", [await contents(path, text)]],
    ["not found", { message: "Not Found" }, 404],
    ["a server fault", { message: "x" }, 500],
  ];
  for (const [label, answer, status] of refused) {
    assert.equal((await ask(answer, status)).text, null, label);
  }
  // Not UTF-8, even with its own true blob id.
  const object = new Uint8Array([
    ...new TextEncoder().encode("blob 1\0"),
    0xff,
  ]);
  const invalidSha = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-1", object)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const invalid = await contents(path, "x", {
    content: btoa("\xff"),
    size: 1,
    sha: invalidSha,
  });
  assert.equal((await ask(invalid)).text, null, "invalid UTF-8");
  // A revision that is not a commit SHA, or a path that is not plain, never
  // goes out.
  const answer = await contents(path, text);
  for (
    const at of [
      { revision: "main" },
      { revision: RUNTIME.slice(1) },
      { path: "../secrets" },
      { path: "src/../x.ts" },
      { path: ".github/workflows/ci.yml" },
      { path: "src/x.ts?ref=main" },
    ]
  ) {
    const refusal = await ask(answer, 200, at);
    assert.equal(refusal.text, null, JSON.stringify(at));
    assert.deepEqual(refusal.requested, [], JSON.stringify(at));
  }
});
